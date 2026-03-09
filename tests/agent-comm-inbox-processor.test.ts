import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildLocalIdentityArtifacts,
  signIdentityArtifactBundle,
  verifySignedIdentityArtifactBundle,
} from "../src/skills/alphaos/runtime/agent-comm/artifact-workflow";
import { encodeEnvelope } from "../src/skills/alphaos/runtime/agent-comm/calldata-codec";
import { decrypt, deriveSharedKey, encrypt } from "../src/skills/alphaos/runtime/agent-comm/ecdh-crypto";
import { processInbox } from "../src/skills/alphaos/runtime/agent-comm/inbox-processor";
import { restoreShadowWallet } from "../src/skills/alphaos/runtime/agent-comm/shadow-wallet";
import {
  AGENT_COMM_DEFAULT_MAX_MESSAGE_BYTES,
  AGENT_COMM_ENVELOPE_VERSION,
  AGENT_COMM_KEX_SUITE_V2,
  agentCommandSchema,
  type X402Proof,
} from "../src/skills/alphaos/runtime/agent-comm/types";
import type { TransactionEvent } from "../src/skills/alphaos/runtime/agent-comm/tx-listener";
import { buildX402SigningPayload } from "../src/skills/alphaos/runtime/agent-comm/x402-adapter";
import { StateStore } from "../src/skills/alphaos/runtime/state-store";

const LOCAL_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const SENDER_PRIVATE_KEY =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

const localWallet = restoreShadowWallet(LOCAL_PRIVATE_KEY);
const senderWallet = restoreShadowWallet(SENDER_PRIVATE_KEY);
const ephemeralWallet = restoreShadowWallet(
  "0x3333333333333333333333333333333333333333333333333333333333333333",
);

const stores: Array<{ dir: string; store: StateStore }> = [];

function createStore(prefix: string): StateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new StateStore(dir);
  stores.push({ dir, store });
  return store;
}

async function buildInlineCardBundle(input: {
  identityPrivateKey: string;
  transportAddress: string;
  transportPubkey: string;
  nowUnixSeconds: number;
}): Promise<unknown> {
  const identityWallet = restoreShadowWallet(input.identityPrivateKey);
  const artifacts = buildLocalIdentityArtifacts({
    identityWallet: identityWallet.getAddress(),
    transportAddress: input.transportAddress,
    transportPubkey: input.transportPubkey,
    chainId: 196,
    displayName: "Inline Card Sender",
    keyId: "rk_inline_card",
    capabilityProfile: "research-collab",
    capabilities: ["ping", "start_discovery"],
    issuedAt: input.nowUnixSeconds,
    expiresAt: input.nowUnixSeconds + 60 * 60,
    protocols: ["agent-comm/2", "agent-comm/1"],
    legacyPeerId: "peer-b",
  });

  return signIdentityArtifactBundle({
    ...artifacts,
    signerPrivateKey: identityWallet.privateKey,
    exportedAt: input.nowUnixSeconds,
  });
}

async function buildSignedX402Proof(input: {
  signerPrivateKey: `0x${string}`;
  payer: string;
  payee?: string;
  asset: string;
  amount: string;
  nonce: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}): Promise<X402Proof> {
  const signer = privateKeyToAccount(input.signerPrivateKey);
  const proof: X402Proof = {
    scheme: "x402",
    payer: input.payer,
    payee: input.payee,
    asset: input.asset,
    amount: input.amount,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
    metadata: input.metadata,
  };
  const signature = await signer.signMessage({
    message: buildX402SigningPayload(proof),
  });
  return {
    ...proof,
    signature,
  };
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

function toInboxEventV2(input: {
  msgId?: string;
  txHash?: string;
  timestamp?: string;
  command: unknown;
  payment?: {
    asset: string;
    amount: string;
    proof?: X402Proof;
    metadata?: Record<string, unknown>;
  };
  inlineCard?: unknown;
  senderIdentityWallet?: string;
  senderTransportAddress?: string;
  senderCardDigest?: string;
  from?: `0x${string}`;
  recipientWallet?: typeof localWallet;
  recipientKeyId?: string;
}): TransactionEvent {
  const recipientWallet = input.recipientWallet ?? localWallet;
  const parsedCommand = agentCommandSchema.parse(input.command);
  const sentAt = input.timestamp ?? "2026-03-07T00:00:00.000Z";
  const sharedKey = deriveSharedKey(ephemeralWallet.privateKey, recipientWallet.getPublicKey());
  const body = {
    msgId: input.msgId ?? "11111111-1111-4111-8111-111111111111",
    sentAt,
    sender: {
      identityWallet: input.senderIdentityWallet ?? senderWallet.getAddress(),
      transportAddress: input.senderTransportAddress ?? (input.from ?? senderWallet.getAddress()),
      ...(input.senderCardDigest ? { cardDigest: input.senderCardDigest } : {}),
    },
    command: {
      type: parsedCommand.type,
      schemaVersion: 2,
      payload: parsedCommand.payload,
    },
    ...(input.payment ? { payment: input.payment } : {}),
    ...(input.inlineCard ? { attachments: { inlineCard: input.inlineCard } } : {}),
  };
  const ciphertext = encrypt(JSON.stringify(body), sharedKey);
  const envelope = encodeEnvelope({
    version: AGENT_COMM_ENVELOPE_VERSION,
    kex: {
      suite: AGENT_COMM_KEX_SUITE_V2,
      recipientKeyId: input.recipientKeyId ?? "rk_local",
      ephemeralPubkey: ephemeralWallet.getPublicKey(),
    },
    ciphertext,
  });

  return {
    txHash: input.txHash ?? "0xtx-v2-1",
    from: input.from ?? senderWallet.getAddress(),
    to: recipientWallet.getAddress(),
    calldata: envelope,
    blockNumber: 8n,
    timestamp: sentAt,
  };
}

function getLocalReceiveOptions(store: StateStore) {
  return {
    wallet: localWallet,
    store,
    expectedChainId: 196,
    receiveKeys: [
      {
        walletAlias: "agent-comm",
        wallet: localWallet,
        walletAddress: localWallet.getAddress(),
        pubkey: localWallet.getPublicKey(),
        transportKeyId: "rk_local",
        status: "active" as const,
      },
    ],
  };
}

async function seedTrustedV2Contact(store: StateStore) {
  const bundle = await buildInlineCardBundle({
    identityPrivateKey: SENDER_PRIVATE_KEY,
    transportAddress: senderWallet.getAddress(),
    transportPubkey: senderWallet.getPublicKey(),
    nowUnixSeconds: 1772841600,
  });
  const verification = await verifySignedIdentityArtifactBundle(bundle, {
    expectedChainId: 196,
    nowUnixSeconds: 1772841600,
  });
  expect(verification.ok).toBe(true);

  const contactCard = verification.contactCard!;
  const transportBinding = verification.transportBinding!;
  store.upsertAgentSignedArtifact({
    artifactType: "ContactCard",
    digest: contactCard.digest,
    signer: contactCard.signer,
    identityWallet: contactCard.artifact.identityWallet,
    chainId: contactCard.artifact.transport.chainId,
    issuedAt: contactCard.artifact.issuedAt,
    expiresAt: contactCard.artifact.expiresAt,
    payload: {
      cardVersion: contactCard.artifact.cardVersion,
      protocols: contactCard.artifact.protocols,
      displayName: contactCard.artifact.displayName,
      handle: contactCard.artifact.handle,
      identityWallet: contactCard.artifact.identityWallet,
      transport: contactCard.artifact.transport,
      defaults: contactCard.artifact.defaults,
      issuedAt: contactCard.artifact.issuedAt,
      expiresAt: contactCard.artifact.expiresAt,
      legacyPeerId: contactCard.artifact.legacyPeerId,
    },
    proof: contactCard.artifact.proof as unknown as Record<string, unknown>,
    verificationStatus: "verified",
    source: "unit-test",
  });
  store.upsertAgentSignedArtifact({
    artifactType: "TransportBinding",
    digest: transportBinding.digest,
    signer: transportBinding.signer,
    identityWallet: transportBinding.artifact.identityWallet,
    chainId: transportBinding.artifact.chainId,
    issuedAt: transportBinding.artifact.issuedAt,
    expiresAt: transportBinding.artifact.expiresAt,
    payload: {
      bindingVersion: transportBinding.artifact.bindingVersion,
      identityWallet: transportBinding.artifact.identityWallet,
      chainId: transportBinding.artifact.chainId,
      receiveAddress: transportBinding.artifact.receiveAddress,
      pubkey: transportBinding.artifact.pubkey,
      keyId: transportBinding.artifact.keyId,
      issuedAt: transportBinding.artifact.issuedAt,
      expiresAt: transportBinding.artifact.expiresAt,
    },
    proof: transportBinding.artifact.proof as unknown as Record<string, unknown>,
    verificationStatus: "verified",
    source: "unit-test",
  });

  const contact = store.upsertAgentContact({
    identityWallet: contactCard.artifact.identityWallet,
    legacyPeerId: contactCard.artifact.legacyPeerId,
    status: "trusted",
    supportedProtocols: contactCard.artifact.protocols,
    capabilityProfile: contactCard.artifact.defaults.capabilityProfile,
    capabilities: contactCard.artifact.defaults.capabilities,
  });
  store.upsertAgentTransportEndpoint({
    contactId: contact.contactId,
    identityWallet: contact.identityWallet,
    chainId: transportBinding.artifact.chainId,
    receiveAddress: transportBinding.artifact.receiveAddress,
    pubkey: transportBinding.artifact.pubkey,
    keyId: transportBinding.artifact.keyId,
    bindingDigest: transportBinding.digest,
    endpointStatus: "active",
    source: "unit-test",
  });

  return {
    contact,
    contactCardDigest: contactCard.digest,
    transportBindingDigest: transportBinding.digest,
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
    expect(result.message.transportAddress).toBe(senderWallet.getAddress());
    expect(result.message.trustOutcome).toBe("unknown_business_rejected");
    expect(store.listAgentContacts(10)).toHaveLength(0);
    expect(store.listAgentConnectionEvents(10)).toHaveLength(0);
  });

  it("rejects oversized inbound envelopes before decrypt", async () => {
    const store = createStore("alphaos-inbox-");
    const baseEvent = toInboxEvent({
      command: {
        type: "connection_invite",
        payload: {
          note: "invite",
        },
      },
    });
    const envelopeJson = JSON.parse(
      Buffer.from(baseEvent.calldata.slice(2), "hex").toString("utf8"),
    ) as Record<string, unknown>;
    const oversizedEvent = {
      ...baseEvent,
      calldata: `0x${Buffer.from(
        JSON.stringify({
          ...envelopeJson,
          signature: `0x${"ab".repeat(AGENT_COMM_DEFAULT_MAX_MESSAGE_BYTES)}`,
        }),
        "utf8",
      ).toString("hex")}` as `0x${string}`,
    } satisfies TransactionEvent;

    await expect(
      processInbox(
        {
          wallet: localWallet,
          store,
        },
        oversizedEvent,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
    });
  });

  it("rate limits repeated unknown inbound decrypt attempts", async () => {
    const store = createStore("alphaos-inbox-");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await processInbox(
        {
          wallet: localWallet,
          store,
        },
        toInboxEvent({
          nonce: `nonce-rate-${attempt}`,
          txHash: `0xtx-rate-${attempt}`,
          command: {
            type: "ping",
            payload: {},
          },
        }),
      );

      expect(result.message.status).toBe("rejected");
    }

    await expect(
      processInbox(
        {
          wallet: localWallet,
          store,
        },
        toInboxEvent({
          nonce: "nonce-rate-limit-final",
          txHash: "0xtx-rate-limit-final",
          command: {
            type: "ping",
            payload: {},
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "UNKNOWN_INBOUND_RATE_LIMITED",
    });
    expect(store.listAgentMessages(10, { direction: "inbound" })).toHaveLength(5);
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
    expect(events[0]?.metadata).toEqual({
      requestedProfile: "research-collab",
      requestedCapabilities: ["ping", "start_discovery"],
      note: "invite",
      senderPeerId: "peer-b",
      trustedSender: false,
      envelopeVersion: 1,
    });
  });

  it("auto-accepts unknown inbound connection_invite when configured", async () => {
    const store = createStore("alphaos-inbox-");

    const result = await processInbox(
      {
        wallet: localWallet,
        store,
        config: {
          commAutoAcceptInvites: true,
        },
      },
      toInboxEvent({
        nonce: "nonce-auto-accept",
        txHash: "0xtx-auto-accept",
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
    expect(result.message.trustOutcome).toBe("trusted");

    const contact = store.getAgentContactByIdentityWallet(senderWallet.getAddress());
    expect(contact).not.toBeNull();
    expect(contact?.status).toBe("trusted");

    const events = store.listAgentConnectionEvents(10, {
      contactId: contact?.contactId,
      direction: "inbound",
      eventType: "connection_invite",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.eventStatus).toBe("applied");
    expect(events[0]?.metadata).toEqual({
      requestedProfile: "research-collab",
      requestedCapabilities: ["ping", "start_discovery"],
      note: "invite",
      senderPeerId: "peer-b",
      trustedSender: false,
      envelopeVersion: 1,
    });
  });

  it("imports and applies inline card attachment on inbound connection_invite", async () => {
    const store = createStore("alphaos-inbox-");
    const identityPrivateKey =
      "0x3333333333333333333333333333333333333333333333333333333333333333";
    const identityWallet = restoreShadowWallet(identityPrivateKey);
    const inlineCard = await buildInlineCardBundle({
      identityPrivateKey,
      transportAddress: senderWallet.getAddress(),
      transportPubkey: senderWallet.getPublicKey(),
      nowUnixSeconds: 1772841600,
    });

    const result = await processInbox(
      {
        wallet: localWallet,
        store,
        expectedChainId: 196,
      },
      toInboxEvent({
        nonce: "nonce-inline-invite",
        txHash: "0xtx-inline-invite",
        command: {
          type: "connection_invite",
          payload: {
            requestedProfile: "research-collab",
            requestedCapabilities: ["ping"],
            note: "invite with inline card",
            inlineCard,
          },
        },
      }),
    );

    expect(result.message.status).toBe("received");
    expect(result.message.identityWallet).toBe(identityWallet.getAddress());
    expect(result.message.transportAddress).toBe(senderWallet.getAddress());

    const importedContact = store.getAgentContactByIdentityWallet(identityWallet.getAddress());
    expect(importedContact).not.toBeNull();
    expect(importedContact?.status).toBe("pending_inbound");
    expect(importedContact?.legacyPeerId).toBe("peer-b");
    expect(importedContact?.supportedProtocols).toEqual(["agent-comm/2", "agent-comm/1"]);

    const activeEndpoint = store.listAgentTransportEndpoints(10, {
      contactId: importedContact?.contactId,
      endpointStatus: "active",
    })[0];
    expect(activeEndpoint?.receiveAddress).toBe(senderWallet.getAddress());
    expect(activeEndpoint?.keyId).toBe("rk_inline_card");

    const inviteEvents = store.listAgentConnectionEvents(10, {
      contactId: importedContact?.contactId,
      direction: "inbound",
      eventType: "connection_invite",
    });
    expect(inviteEvents).toHaveLength(1);
    expect(inviteEvents[0]?.metadata).toEqual(
      expect.objectContaining({
        inlineCardAttached: true,
        inlineCardStatus: "verified",
        inlineCardIdentityWallet: identityWallet.getAddress(),
        inlineCardTransportAddress: senderWallet.getAddress(),
      }),
    );
    expect(inviteEvents[0]?.metadata?.inlineCardContactCardDigest).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
    expect(inviteEvents[0]?.metadata?.inlineCardTransportBindingDigest).toMatch(
      /^0x[0-9a-f]{64}$/,
    );
    expect(store.listAgentSignedArtifacts(10)).toHaveLength(2);
  });

  it("rejects inline card attachment when transport binding does not match tx sender", async () => {
    const store = createStore("alphaos-inbox-");
    const identityPrivateKey =
      "0x4444444444444444444444444444444444444444444444444444444444444444";
    const wrongTransportWallet = restoreShadowWallet(
      "0x5555555555555555555555555555555555555555555555555555555555555555",
    );
    const inlineCard = await buildInlineCardBundle({
      identityPrivateKey,
      transportAddress: wrongTransportWallet.getAddress(),
      transportPubkey: wrongTransportWallet.getPublicKey(),
      nowUnixSeconds: 1772841600,
    });

    const result = await processInbox(
      {
        wallet: localWallet,
        store,
        expectedChainId: 196,
      },
      toInboxEvent({
        nonce: "nonce-inline-mismatch",
        txHash: "0xtx-inline-mismatch",
        command: {
          type: "connection_invite",
          payload: {
            note: "invite with mismatched inline card",
            inlineCard,
          },
        },
      }),
    );

    expect(result.message.status).toBe("rejected");
    expect(result.message.error).toContain("inline card transport address does not match transaction sender");
    expect(result.message.trustOutcome).toBe("inline_card_sender_mismatch");
    expect(store.listAgentConnectionEvents(10)).toHaveLength(0);
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
    expect(inboundAcceptEvents[0]?.metadata).toEqual({
      capabilityProfile: "research-collab",
      capabilities: ["ping", "start_discovery"],
      note: "accepted",
      senderPeerId: "peer-b",
      trustedSender: false,
      envelopeVersion: 1,
    });
  });

  it("derives granted capability snapshot from the pending outbound invite when connection_accept omits it", async () => {
    const store = createStore("alphaos-inbox-");
    const contact = store.upsertAgentContact({
      identityWallet: senderWallet.getAddress(),
      legacyPeerId: "peer-b",
      status: "pending_outbound",
      supportedProtocols: ["agent-comm/1"],
      capabilities: [],
    });
    store.upsertAgentConnectionEvent({
      contactId: contact.contactId,
      identityWallet: contact.identityWallet,
      direction: "outbound",
      eventType: "connection_invite",
      eventStatus: "pending",
      messageId: "outbound-invite-msg-derive-1",
      txHash: "0xoutbound-invite-derive",
      occurredAt: "2026-03-07T00:00:00.000Z",
      metadata: {
        requestedProfile: "research-collab",
        requestedCapabilities: ["ping", "start_discovery"],
      },
    });

    const result = await processInbox(
      {
        wallet: localWallet,
        store,
      },
      toInboxEvent({
        nonce: "nonce-derive-accept",
        txHash: "0xtx-derive-accept",
        command: {
          type: "connection_accept",
          payload: {
            note: "accepted",
          },
        },
      }),
    );

    expect(result.message.status).toBe("received");
    expect(result.message.contactId).toBe(contact.contactId);
    expect(result.message.identityWallet).toBe(contact.identityWallet);
    expect(result.message.transportAddress).toBe(senderWallet.getAddress());
    expect(result.message.trustOutcome).toBe("trusted");

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
    expect(inboundAcceptEvents[0]?.metadata).toEqual({
      capabilityProfile: "research-collab",
      capabilities: ["ping", "start_discovery"],
      note: "accepted",
      senderPeerId: "peer-b",
      trustedSender: false,
      envelopeVersion: 1,
    });
  });

  it("applies connection_confirm once the contact is already trusted", async () => {
    const store = createStore("alphaos-inbox-");
    const contact = store.upsertAgentContact({
      identityWallet: senderWallet.getAddress(),
      legacyPeerId: "peer-b",
      status: "trusted",
      supportedProtocols: ["agent-comm/1", "agent-comm/2"],
      capabilityProfile: "research-collab",
      capabilities: ["ping", "start_discovery"],
    });
    store.upsertAgentConnectionEvent({
      contactId: contact.contactId,
      identityWallet: contact.identityWallet,
      direction: "outbound",
      eventType: "connection_accept",
      eventStatus: "applied",
      messageId: "outbound-accept-msg-1",
      txHash: "0xoutbound-accept",
      occurredAt: "2026-03-07T00:00:00.000Z",
    });

    const result = await processInbox(
      {
        wallet: localWallet,
        store,
      },
      toInboxEvent({
        command: {
          type: "connection_confirm",
          payload: {
            note: "ready",
          },
        },
      }),
    );

    expect(result.message.status).toBe("received");
    expect(store.getAgentContact(contact.contactId)?.status).toBe("trusted");

    const inboundConfirmEvents = store.listAgentConnectionEvents(10, {
      contactId: contact.contactId,
      direction: "inbound",
      eventType: "connection_confirm",
    });
    expect(inboundConfirmEvents).toHaveLength(1);
    expect(inboundConfirmEvents[0]?.eventStatus).toBe("applied");
    expect(inboundConfirmEvents[0]?.metadata).toEqual({
      note: "ready",
      senderPeerId: "peer-b",
      trustedSender: false,
      envelopeVersion: 1,
    });
  });

  it("accepts unknown inbound v2 invites when a valid inline card is attached", async () => {
    const store = createStore("alphaos-inbox-");
    const inlineCard = await buildInlineCardBundle({
      identityPrivateKey: SENDER_PRIVATE_KEY,
      transportAddress: senderWallet.getAddress(),
      transportPubkey: senderWallet.getPublicKey(),
      nowUnixSeconds: 1772841600,
    });

    const result = await processInbox(
      getLocalReceiveOptions(store),
      toInboxEventV2({
        msgId: "11111111-1111-4111-8111-111111111111",
        txHash: "0xtx-v2-inline-invite",
        command: {
          type: "connection_invite",
          payload: {
            requestedProfile: "research-collab",
            requestedCapabilities: ["ping"],
            note: "v2 invite",
          },
        },
        inlineCard,
      }),
    );

    expect(result.message.status).toBe("received");
    expect(result.message.envelopeVersion).toBe(2);
    expect(result.message.msgId).toBe("11111111-1111-4111-8111-111111111111");

    const importedContact = store.getAgentContactByIdentityWallet(senderWallet.getAddress());
    expect(importedContact?.status).toBe("pending_inbound");
    expect(
      store.listAgentConnectionEvents(10, {
        contactId: importedContact?.contactId,
        direction: "inbound",
        eventType: "connection_invite",
      })[0]?.metadata,
    ).toEqual(
      expect.objectContaining({
        inlineCardAttached: true,
        envelopeVersion: 2,
        recipientKeyId: "rk_local",
      }),
    );
  });

  it("auto-accepts unknown inbound v2 invites when configured", async () => {
    const store = createStore("alphaos-inbox-");
    const inlineCard = await buildInlineCardBundle({
      identityPrivateKey: SENDER_PRIVATE_KEY,
      transportAddress: senderWallet.getAddress(),
      transportPubkey: senderWallet.getPublicKey(),
      nowUnixSeconds: 1772841600,
    });

    const result = await processInbox(
      {
        ...getLocalReceiveOptions(store),
        config: {
          commAutoAcceptInvites: true,
        },
      },
      toInboxEventV2({
        msgId: "12121212-1212-4121-8121-121212121212",
        txHash: "0xtx-v2-auto-accept",
        command: {
          type: "connection_invite",
          payload: {
            requestedProfile: "research-collab",
            requestedCapabilities: ["ping"],
            note: "v2 invite",
          },
        },
        inlineCard,
      }),
    );

    expect(result.message.status).toBe("received");
    expect(result.message.trustOutcome).toBe("trusted");

    const importedContact = store.getAgentContactByIdentityWallet(senderWallet.getAddress());
    expect(importedContact?.status).toBe("trusted");

    const inviteEvents = store.listAgentConnectionEvents(10, {
      contactId: importedContact?.contactId,
      direction: "inbound",
      eventType: "connection_invite",
    });
    expect(inviteEvents).toHaveLength(1);
    expect(inviteEvents[0]?.eventStatus).toBe("applied");
    expect(inviteEvents[0]?.metadata).toEqual(
      expect.objectContaining({
        inlineCardAttached: true,
        envelopeVersion: 2,
        recipientKeyId: "rk_local",
      }),
    );
  });

  it("rejects unknown inbound v2 business commands by default", async () => {
    const store = createStore("alphaos-inbox-");

    const result = await processInbox(
      getLocalReceiveOptions(store),
      toInboxEventV2({
        msgId: "22222222-2222-4222-8222-222222222222",
        txHash: "0xtx-v2-business-reject",
        command: {
          type: "ping",
          payload: {
            echo: "hello",
          },
        },
      }),
    );

    expect(result.message.status).toBe("rejected");
    expect(result.message.envelopeVersion).toBe(2);
    expect(result.message.trustOutcome).toBe("unknown_business_rejected");
    expect(result.message.decryptedCommandType).toBe("ping");
  });

  it("marks paid unknown inbound v2 business commands as paid_pending", async () => {
    const store = createStore("alphaos-inbox-");

    const result = await processInbox(
      getLocalReceiveOptions(store),
      toInboxEventV2({
        msgId: "23232323-2323-4232-8232-232323232323",
        txHash: "0xtx-v2-business-paid-pending",
        command: {
          type: "ping",
          payload: {
            echo: "hello",
          },
        },
        payment: {
          asset: "USDC",
          amount: "1000000",
          metadata: {
            invoiceId: "inv-1",
          },
        },
      }),
    );

    expect(result.message.status).toBe("paid_pending");
    expect(result.message.envelopeVersion).toBe(2);
    expect(result.message.trustOutcome).toBe("paid_pending");
    expect(result.message.payment).toEqual({
      asset: "USDC",
      amount: "1000000",
      metadata: {
        invoiceId: "inv-1",
      },
    });
    expect(result.message.error).toBeUndefined();
    expect(store.getAgentMessage(result.message.id)?.payment).toEqual(result.message.payment);
  });

  it("keeps observe mode as paid_pending when x402 proof verification fails", async () => {
    const store = createStore("alphaos-inbox-");
    const invalidProof = await buildSignedX402Proof({
      signerPrivateKey: LOCAL_PRIVATE_KEY,
      payer: senderWallet.getAddress(),
      payee: localWallet.getAddress(),
      asset: "USDC",
      amount: "1000000",
      nonce: "proof-nonce-observe",
      expiresAt: "2026-04-07T00:00:00.000Z",
    });

    const result = await processInbox(
      {
        ...getLocalReceiveOptions(store),
        config: {
          x402Mode: "observe",
        },
      },
      toInboxEventV2({
        msgId: "24242424-2424-4242-8242-242424242424",
        txHash: "0xtx-v2-x402-observe-invalid",
        command: {
          type: "ping",
          payload: {
            echo: "observe",
          },
        },
        payment: {
          asset: "USDC",
          amount: "1000000",
          proof: invalidProof,
        },
      }),
    );

    expect(result.message.status).toBe("paid_pending");
    expect(result.message.trustOutcome).toBe("paid_pending");
    expect(result.message.error).toContain("x402 validation failed (observe)");
  });

  it("rejects untrusted paid v2 business commands in enforce mode when proof is missing", async () => {
    const store = createStore("alphaos-inbox-");

    const result = await processInbox(
      {
        ...getLocalReceiveOptions(store),
        config: {
          x402Mode: "enforce",
        },
      },
      toInboxEventV2({
        msgId: "25252525-2525-4252-8252-252525252525",
        txHash: "0xtx-v2-x402-enforce-missing",
        command: {
          type: "ping",
          payload: {
            echo: "enforce-missing",
          },
        },
        payment: {
          asset: "USDC",
          amount: "1000000",
        },
      }),
    );

    expect(result.message.status).toBe("rejected");
    expect(result.message.trustOutcome).toBe("x402_enforce_rejected");
    expect(result.message.error).toContain("missing x402 proof");
  });

  it("allows paid_pending in enforce mode when x402 proof is valid", async () => {
    const store = createStore("alphaos-inbox-");
    const validProof = await buildSignedX402Proof({
      signerPrivateKey: SENDER_PRIVATE_KEY,
      payer: senderWallet.getAddress(),
      payee: localWallet.getAddress(),
      asset: "USDC",
      amount: "1000000",
      nonce: "proof-nonce-enforce-valid",
      expiresAt: "2026-04-07T00:00:00.000Z",
      metadata: {
        invoiceId: "inv-x402-valid-1",
      },
    });

    const result = await processInbox(
      {
        ...getLocalReceiveOptions(store),
        config: {
          x402Mode: "enforce",
        },
      },
      toInboxEventV2({
        msgId: "26262626-2626-4262-8262-262626262626",
        txHash: "0xtx-v2-x402-enforce-valid",
        command: {
          type: "ping",
          payload: {
            echo: "enforce-valid",
          },
        },
        payment: {
          asset: "USDC",
          amount: "1000000",
          proof: validProof,
          metadata: {
            invoiceId: "inv-x402-valid-1",
          },
        },
      }),
    );

    expect(result.message.status).toBe("paid_pending");
    expect(result.message.trustOutcome).toBe("paid_pending");
    expect(result.message.error).toBeUndefined();
  });

  it("rejects v2 envelopes when decrypted sender transport does not match tx.from", async () => {
    const store = createStore("alphaos-inbox-");

    await expect(
      processInbox(
        getLocalReceiveOptions(store),
        toInboxEventV2({
          msgId: "33333333-3333-4333-8333-333333333333",
          txHash: "0xtx-v2-transport-mismatch",
          senderTransportAddress: "0x4444444444444444444444444444444444444444",
          command: {
            type: "ping",
            payload: {},
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "SENDER_TRANSPORT_MISMATCH",
    });
  });

  it("verifies v2 sender transport against the stored authorized endpoint", async () => {
    const store = createStore("alphaos-inbox-");
    const contact = store.upsertAgentContact({
      identityWallet: senderWallet.getAddress(),
      legacyPeerId: "peer-b",
      status: "trusted",
      supportedProtocols: ["agent-comm/2"],
      capabilities: ["ping"],
    });
    store.upsertAgentTransportEndpoint({
      contactId: contact.contactId,
      identityWallet: contact.identityWallet,
      chainId: 196,
      receiveAddress: "0x5555555555555555555555555555555555555555",
      pubkey: senderWallet.getPublicKey(),
      keyId: "rk_other",
      endpointStatus: "active",
      source: "unit-test",
    });

    await expect(
      processInbox(
        getLocalReceiveOptions(store),
        toInboxEventV2({
          msgId: "44444444-4444-4444-8444-444444444444",
          txHash: "0xtx-v2-unauthorized-transport",
          senderIdentityWallet: senderWallet.getAddress(),
          senderTransportAddress: senderWallet.getAddress(),
          command: {
            type: "ping",
            payload: {},
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED_TRANSPORT",
    });
  });

  it("rejects v2 messages when senderCardDigest is revoked", async () => {
    const store = createStore("alphaos-inbox-");
    const seeded = await seedTrustedV2Contact(store);
    store.upsertAgentArtifactStatus({
      artifactDigest: seeded.contactCardDigest,
      artifactType: "ContactCard",
      identityWallet: seeded.contact.identityWallet,
      status: "revoked",
      revokedByDigest: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      revokedAt: 1772841700,
      reason: "compromised identity card",
    });

    await expect(
      processInbox(
        getLocalReceiveOptions(store),
        toInboxEventV2({
          msgId: "77777777-7777-4777-8777-777777777777",
          txHash: "0xtx-v2-revoked-card",
          senderIdentityWallet: seeded.contact.identityWallet,
          senderCardDigest: seeded.contactCardDigest,
          command: {
            type: "ping",
            payload: {},
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "REVOKED_CONTACT_CARD",
    });
  });

  it("dedupes inbound v2 messages by msgId and keeps v1/v2 inbox paths side by side", async () => {
    const store = createStore("alphaos-inbox-");
    const seeded = await seedTrustedV2Contact(store);
    store.upsertAgentPeer({
      peerId: "peer-b",
      walletAddress: senderWallet.getAddress(),
      pubkey: senderWallet.getPublicKey(),
      status: "trusted",
      capabilities: ["ping"],
    });

    const legacyResult = await processInbox(
      {
        wallet: localWallet,
        store,
      },
      toInboxEvent({
        nonce: "nonce-mixed-v1",
        txHash: "0xtx-mixed-v1",
        command: {
          type: "ping",
          payload: {
            echo: "legacy",
          },
        },
      }),
    );
    expect(legacyResult.message.envelopeVersion).toBe(1);

    const modernEvent = toInboxEventV2({
      msgId: "55555555-5555-4555-8555-555555555555",
      txHash: "0xtx-mixed-v2",
      senderCardDigest: seeded.contactCardDigest,
      command: {
        type: "ping",
        payload: {
          echo: "modern",
        },
      },
    });
    const modernFirst = await processInbox(getLocalReceiveOptions(store), modernEvent);
    const modernSecond = await processInbox(getLocalReceiveOptions(store), modernEvent);

    expect(modernFirst.message.status).toBe("decrypted");
    expect(modernFirst.message.id).toBe(modernSecond.message.id);
    expect(store.listAgentMessages(10, { direction: "inbound" })).toHaveLength(2);
    expect(
      store.listAgentMessages(10, { direction: "inbound" }).map((message) => message.envelopeVersion),
    ).toEqual(expect.arrayContaining([1, 2]));
  });

});
