import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeEnvelope } from "../src/skills/alphaos/runtime/agent-comm/calldata-codec";
import { restoreShadowWallet } from "../src/skills/alphaos/runtime/agent-comm/shadow-wallet";
import {
  AGENT_COMM_LEGACY_ENVELOPE_VERSION,
  type EncryptedEnvelopeV1,
} from "../src/skills/alphaos/runtime/agent-comm/types";
import { sendCalldata } from "../src/skills/alphaos/runtime/agent-comm/tx-sender";
import { StateStore } from "../src/skills/alphaos/runtime/state-store";

const createPublicClientMock = vi.hoisted(() => vi.fn());
const createWalletClientMock = vi.hoisted(() => vi.fn());

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: createPublicClientMock,
    createWalletClient: createWalletClientMock,
  };
});

const stores: Array<{ dir: string; store: StateStore }> = [];

function createStore(prefix: string): StateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new StateStore(dir);
  stores.push({ dir, store });
  return store;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const entry of stores.splice(0)) {
    entry.store.close();
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

function buildEnvelope(
  senderPubkey: string,
  recipient: string,
  nonce: string,
): EncryptedEnvelopeV1 {
  return {
    version: AGENT_COMM_LEGACY_ENVELOPE_VERSION,
    senderPeerId: "peer-a",
    senderPubkey,
    recipient,
    nonce,
    timestamp: new Date().toISOString(),
    command: {
      type: "ping",
      schemaVersion: 1,
    },
    ciphertext: "0xdeadbeef",
    signature: "0xsig",
  };
}

describe("tx-sender outbound status persistence", () => {
  it("persists outbound message as sent with tx hash", async () => {
    const store = createStore("alphaos-comm-sender-");
    const wallet = restoreShadowWallet(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );
    const recipient = "0x2222222222222222222222222222222222222222";
    const calldata = encodeEnvelope(buildEnvelope(wallet.getPublicKey(), recipient, "nonce-sent"));

    createPublicClientMock.mockReturnValue({
      getChainId: vi.fn(async () => 196),
      getTransactionCount: vi.fn(async () => 9),
    });
    createWalletClientMock.mockReturnValue({
      sendTransaction: vi.fn(async () => "0xtx-sent"),
    });

    const result = await sendCalldata(
      {
        rpcUrl: "http://localhost:8545",
        chainId: 196,
        walletAlias: "agent-comm",
        store,
        outboundMessage: {
          peerId: "peer-a",
          nonce: "nonce-sent",
          commandType: "ping",
        },
      },
      wallet,
      recipient,
      calldata,
    );

    expect(result.txHash).toBe("0xtx-sent");
    const stored = store.findAgentMessage("peer-a", "outbound", "nonce-sent");
    expect(stored?.status).toBe("sent");
    expect(stored?.txHash).toBe("0xtx-sent");
  });

  it("does not call relay when direct transaction succeeds", async () => {
    const store = createStore("alphaos-comm-sender-");
    const wallet = restoreShadowWallet(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );
    const recipient = "0x4444444444444444444444444444444444444444";
    const calldata = encodeEnvelope(buildEnvelope(wallet.getPublicKey(), recipient, "nonce-direct-first"));

    const relayFetch = vi.fn(async () => new Response(JSON.stringify({ txHash: "0xtx-relay-unused" })));
    vi.stubGlobal("fetch", relayFetch);

    createPublicClientMock.mockReturnValue({
      getChainId: vi.fn(async () => 196),
      getTransactionCount: vi.fn(async () => 11),
    });
    const sendTransaction = vi.fn(async () => "0xtx-direct-success");
    const signTransaction = vi.fn(async () => "0xsigned-unused");
    createWalletClientMock.mockReturnValue({
      sendTransaction,
      signTransaction,
    });

    const result = await sendCalldata(
      {
        rpcUrl: "http://localhost:8545",
        chainId: 196,
        walletAlias: "agent-comm",
        relayUrl: "https://relay.example/submit",
        store,
        outboundMessage: {
          peerId: "peer-a",
          nonce: "nonce-direct-first",
          commandType: "ping",
        },
      },
      wallet,
      recipient,
      calldata,
    );

    expect(result.txHash).toBe("0xtx-direct-success");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it("falls back to relay when direct transaction fails", async () => {
    const store = createStore("alphaos-comm-sender-");
    const wallet = restoreShadowWallet(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );
    const recipient = "0x5555555555555555555555555555555555555555";
    const calldata = encodeEnvelope(buildEnvelope(wallet.getPublicKey(), recipient, "nonce-fallback-relay"));

    const relayFetch = vi.fn(async () => new Response(JSON.stringify({ txHash: "0xtx-relay-success" })));
    vi.stubGlobal("fetch", relayFetch);

    createPublicClientMock.mockReturnValue({
      getChainId: vi.fn(async () => 196),
      getTransactionCount: vi.fn(async () => 12),
    });
    const sendTransaction = vi.fn(async () => {
      throw new Error("rpc send failed");
    });
    const signTransaction = vi.fn(async () => "0xsigned-relay-raw");
    createWalletClientMock.mockReturnValue({
      sendTransaction,
      signTransaction,
    });

    const result = await sendCalldata(
      {
        rpcUrl: "http://localhost:8545",
        chainId: 196,
        walletAlias: "agent-comm",
        relayUrl: "https://relay.example/submit",
        relayTimeoutMs: 12000,
        store,
        outboundMessage: {
          peerId: "peer-a",
          nonce: "nonce-fallback-relay",
          commandType: "ping",
        },
      },
      wallet,
      recipient,
      calldata,
    );

    expect(result.txHash).toBe("0xtx-relay-success");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(relayFetch).toHaveBeenCalledTimes(1);

    const stored = store.findAgentMessage("peer-a", "outbound", "nonce-fallback-relay");
    expect(stored?.status).toBe("sent");
    expect(stored?.txHash).toBe("0xtx-relay-success");
  });

  it("persists outbound message as failed with error when send throws", async () => {
    const store = createStore("alphaos-comm-sender-");
    const wallet = restoreShadowWallet(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );
    const recipient = "0x3333333333333333333333333333333333333333";
    const calldata = encodeEnvelope(buildEnvelope(wallet.getPublicKey(), recipient, "nonce-failed"));

    createPublicClientMock.mockReturnValue({
      getChainId: vi.fn(async () => 196),
      getTransactionCount: vi.fn(async () => 10),
    });
    createWalletClientMock.mockReturnValue({
      sendTransaction: vi.fn(async () => {
        throw new Error("rpc send failed");
      }),
    });

    await expect(
      sendCalldata(
        {
          rpcUrl: "http://localhost:8545",
          chainId: 196,
          walletAlias: "agent-comm",
          store,
          outboundMessage: {
            peerId: "peer-a",
            nonce: "nonce-failed",
            commandType: "ping",
          },
        },
        wallet,
        recipient,
        calldata,
      ),
    ).rejects.toThrow(
      "Failed to send calldata transaction on chain 196: Failed to submit transaction: direct: rpc send failed",
    );

    const stored = store.findAgentMessage("peer-a", "outbound", "nonce-failed");
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("rpc send failed");
  });
});
