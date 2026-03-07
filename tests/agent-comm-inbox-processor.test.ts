import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeEnvelope } from "../src/skills/alphaos/runtime/agent-comm/calldata-codec";
import { decrypt, deriveSharedKey, encrypt } from "../src/skills/alphaos/runtime/agent-comm/ecdh-crypto";
import { processInbox } from "../src/skills/alphaos/runtime/agent-comm/inbox-processor";
import { restoreShadowWallet } from "../src/skills/alphaos/runtime/agent-comm/shadow-wallet";
import { agentCommandSchema } from "../src/skills/alphaos/runtime/agent-comm/types";
import type { TransactionEvent } from "../src/skills/alphaos/runtime/agent-comm/tx-listener";
import { StateStore } from "../src/skills/alphaos/runtime/state-store";

const LOCAL_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const SENDER_PRIVATE_KEY =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

const localWallet = restoreShadowWallet(LOCAL_PRIVATE_KEY);
const senderWallet = restoreShadowWallet(SENDER_PRIVATE_KEY);

const stores: Array<{ dir: string; store: StateStore }> = [];

function createStore(prefix: string): StateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new StateStore(dir);
  stores.push({ dir, store });
  return store;
}

function toInboxEvent(input: {
  senderPeerId?: string;
  nonce?: string;
  txHash?: string;
  timestamp?: string;
  command: unknown;
}): TransactionEvent {
  const parsedCommand = agentCommandSchema.parse(input.command);
  const sharedKey = deriveSharedKey(senderWallet.privateKey, localWallet.getPublicKey());
  const plaintext = JSON.stringify(parsedCommand);
  const ciphertext = encrypt(plaintext, sharedKey);

  const envelope = encodeEnvelope({
    version: 1,
    senderPeerId: input.senderPeerId ?? "peer-b",
    senderPubkey: senderWallet.getPublicKey(),
    recipient: localWallet.getAddress(),
    nonce: input.nonce ?? "nonce-1",
    timestamp: input.timestamp ?? "2026-03-07T00:00:00.000Z",
    command: {
      type: parsedCommand.type,
      schemaVersion: 1,
    },
    ciphertext,
    signature: senderWallet.getPublicKey(),
  });

  const decryptProbe = decrypt(ciphertext, sharedKey);
  expect(JSON.parse(decryptProbe)).toEqual(parsedCommand);

  return {
    txHash: input.txHash ?? "0xtx-1",
    from: senderWallet.getAddress(),
    to: localWallet.getAddress(),
    calldata: envelope,
    blockNumber: 7n,
    timestamp: input.timestamp ?? "2026-03-07T00:00:00.000Z",
  };
}

afterEach(() => {
  for (const entry of stores.splice(0)) {
    entry.store.close();
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe("agent-comm inbox processor v2 groundwork", () => {
  it("parses all connection control-plane command schemas", () => {
    expect(
      agentCommandSchema.parse({
        type: "connection_invite",
        payload: {
          requestedProfile: "research-collab",
          requestedCapabilities: ["ping", "start_discovery"],
          note: "open channel",
        },
      }).type,
    ).toBe("connection_invite");

    expect(
      agentCommandSchema.parse({
        type: "connection_accept",
        payload: {
          capabilityProfile: "research-collab",
          capabilities: ["ping"],
          note: "approved",
        },
      }).type,
    ).toBe("connection_accept");

    expect(
      agentCommandSchema.parse({
        type: "connection_reject",
        payload: {
          reason: "policy",
          note: "not now",
        },
      }).type,
    ).toBe("connection_reject");

    expect(
      agentCommandSchema.parse({
        type: "connection_confirm",
        payload: {
          note: "ready",
        },
      }).type,
    ).toBe("connection_confirm");
  });

  it("keeps trusted business-command handling intact", async () => {
    const store = createStore("alphaos-inbox-");
    store.upsertAgentPeer({
      peerId: "peer-b",
      walletAddress: senderWallet.getAddress(),
      pubkey: senderWallet.getPublicKey(),
      status: "trusted",
      capabilities: ["ping"],
    });

    const result = await processInbox(
      {
        wallet: localWallet,
        store,
      },
      toInboxEvent({
        command: {
          type: "ping",
          payload: {
            echo: "hello",
          },
        },
      }),
    );

    expect(result.command.type).toBe("ping");
    expect(result.message.status).toBe("decrypted");
    expect(result.message.peerId).toBe("peer-b");
  });

  it("rejects unknown untrusted business commands by default", async () => {
    const store = createStore("alphaos-inbox-");

    const result = await processInbox(
      {
        wallet: localWallet,
        store,
      },
      toInboxEvent({
        command: {
          type: "ping",
          payload: {},
        },
      }),
    );

    expect(result.message.status).toBe("rejected");
    expect(result.message.error).toContain("unknown business command rejected");
    expect(store.listAgentContacts(10)).toHaveLength(0);
    expect(store.listAgentConnectionEvents(10)).toHaveLength(0);
  });

  it("accepts unknown inbound connection_invite into pending contact state", async () => {
    const store = createStore("alphaos-inbox-");

    const result = await processInbox(
      {
        wallet: localWallet,
        store,
      },
      toInboxEvent({
        command: {
          type: "connection_invite",
          payload: {
            requestedProfile: "research-collab",
            requestedCapabilities: ["ping", "start_discovery"],
            note: "invite",
          },
        },
      }),
    );

    expect(result.message.status).toBe("received");

    const contact = store.getAgentContactByIdentityWallet(senderWallet.getAddress());
    expect(contact).not.toBeNull();
    expect(contact?.status).toBe("pending_inbound");

    const events = store.listAgentConnectionEvents(10, {
      contactId: contact?.contactId,
      direction: "inbound",
      eventType: "connection_invite",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventStatus).toBe("pending");
  });

  it("rejects connection_accept without matching pending outbound state", async () => {
    const store = createStore("alphaos-inbox-");
    const contact = store.upsertAgentContact({
      identityWallet: senderWallet.getAddress(),
      legacyPeerId: "peer-b",
      status: "imported",
      supportedProtocols: ["agent-comm/1"],
      capabilities: ["ping"],
    });

    const result = await processInbox(
      {
        wallet: localWallet,
        store,
      },
      toInboxEvent({
        command: {
          type: "connection_accept",
          payload: {
            capabilityProfile: "research-collab",
            capabilities: ["ping"],
          },
        },
      }),
    );

    expect(result.message.status).toBe("rejected");
    expect(result.message.error).toContain("no matching pending outbound invite");
    expect(store.getAgentContact(contact.contactId)?.status).toBe("imported");
    expect(
      store.listAgentConnectionEvents(10, {
        contactId: contact.contactId,
        direction: "inbound",
        eventType: "connection_accept",
      })[0]?.eventStatus,
    ).toBe("rejected");
  });

  it("applies connection_accept when a matching pending outbound invite exists", async () => {
    const store = createStore("alphaos-inbox-");
    const contact = store.upsertAgentContact({
      identityWallet: senderWallet.getAddress(),
      legacyPeerId: "peer-b",
      status: "pending_outbound",
      supportedProtocols: ["agent-comm/1"],
      capabilities: ["ping"],
    });
    store.upsertAgentConnectionEvent({
      contactId: contact.contactId,
      identityWallet: contact.identityWallet,
      direction: "outbound",
      eventType: "connection_invite",
      eventStatus: "pending",
      messageId: "outbound-invite-msg-1",
      txHash: "0xoutbound-invite",
      occurredAt: "2026-03-07T00:00:00.000Z",
    });

    const result = await processInbox(
      {
        wallet: localWallet,
        store,
      },
      toInboxEvent({
        command: {
          type: "connection_accept",
          payload: {
            capabilityProfile: "research-collab",
            capabilities: ["ping", "start_discovery"],
            note: "accepted",
          },
        },
      }),
    );

    expect(result.message.status).toBe("received");

    const updatedContact = store.getAgentContact(contact.contactId);
    expect(updatedContact?.status).toBe("trusted");
    expect(updatedContact?.capabilityProfile).toBe("research-collab");
    expect(updatedContact?.capabilities).toEqual(["ping", "start_discovery"]);

    const inboundAcceptEvents = store.listAgentConnectionEvents(10, {
      contactId: contact.contactId,
      direction: "inbound",
      eventType: "connection_accept",
    });
    expect(inboundAcceptEvents).toHaveLength(1);
    expect(inboundAcceptEvents[0]?.eventStatus).toBe("applied");
  });
});
