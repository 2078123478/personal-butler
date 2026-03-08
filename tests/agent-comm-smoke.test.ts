import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlphaOsConfig } from "../src/skills/alphaos/runtime/config";
import { loadConfig } from "../src/skills/alphaos/runtime/config";
import {
  exportIdentityArtifactBundle,
  importIdentityArtifactBundle,
  initCommWallet,
  registerTrustedPeerEntry,
  sendCommConnectionAccept,
  sendCommConnectionInvite,
  sendCommPing,
} from "../src/skills/alphaos/runtime/agent-comm/entrypoints";
import { resolveLocalIdentityState } from "../src/skills/alphaos/runtime/agent-comm/local-identity";
import { processInbox } from "../src/skills/alphaos/runtime/agent-comm/inbox-processor";
import { restoreShadowWallet } from "../src/skills/alphaos/runtime/agent-comm/shadow-wallet";
import type { TransactionEvent } from "../src/skills/alphaos/runtime/agent-comm/tx-listener";
import { StateStore } from "../src/skills/alphaos/runtime/state-store";
import { VaultService } from "../src/skills/alphaos/runtime/vault";

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

const originalEnv = { ...process.env };
const stores: Array<{ dir: string; store: StateStore }> = [];

const MASTER_PASSWORD = "pass123";
const A_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const B_PRIVATE_KEY =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

interface TestDeps {
  config: AlphaOsConfig;
  store: StateStore;
  vault: VaultService;
}

interface SentTransaction {
  txHash: string;
  from: `0x${string}`;
  to: `0x${string}`;
  calldata: `0x${string}`;
}

function createConfig(overrides: Partial<AlphaOsConfig>): AlphaOsConfig {
  delete process.env.COMM_ENABLED;
  delete process.env.COMM_RPC_URL;
  delete process.env.COMM_LISTENER_MODE;

  return {
    ...loadConfig(),
    ...overrides,
  };
}

function createDeps(prefix: string): TestDeps {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new StateStore(dir);
  const vault = new VaultService(store);
  stores.push({ dir, store });

  return {
    config: createConfig({
      dataDir: dir,
      commChainId: 196,
      commRpcUrl: "http://localhost:8545",
      commWalletAlias: "agent-comm",
    }),
    store,
    vault,
  };
}

function createTransport(sentTransactions: SentTransaction[]) {
  let txIndex = 0;
  createPublicClientMock.mockReturnValue({
    getChainId: vi.fn(async () => 196),
    getTransactionCount: vi.fn(async () => txIndex),
  });
  createWalletClientMock.mockImplementation((options: { account: { address: `0x${string}` } }) => ({
    sendTransaction: vi.fn(async (request: { to: `0x${string}`; data: `0x${string}` }) => {
      txIndex += 1;
      const txHash = `0x${txIndex.toString(16).padStart(64, "0")}` as `0x${string}`;
      sentTransactions.push({
        txHash,
        from: options.account.address,
        to: request.to,
        calldata: request.data,
      });
      return txHash;
    }),
  }));
}

function getInboxOptions(deps: TestDeps) {
  const state = resolveLocalIdentityState(deps, MASTER_PASSWORD);
  return {
    wallet: state.acwWallet,
    store: deps.store,
    expectedChainId: deps.config.commChainId,
    receiveKeys: state.receiveKeys,
  };
}

async function deliverNext(
  deps: TestDeps,
  sentTransactions: SentTransaction[],
  timestamp: string,
): Promise<Awaited<ReturnType<typeof processInbox>>> {
  const tx = sentTransactions.shift();
  if (!tx) {
    throw new Error("expected a queued transaction");
  }

  const event: TransactionEvent = {
    txHash: tx.txHash,
    from: tx.from,
    to: tx.to,
    calldata: tx.calldata,
    blockNumber: 1n,
    timestamp,
  };
  return processInbox(getInboxOptions(deps), event);
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.clearAllMocks();
  for (const entry of stores.splice(0)) {
    entry.store.close();
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe("agent-comm smoke coverage", () => {
  it("covers v2 -> v2 contact-first invite/accept plus trusted business send", async () => {
    const sentTransactions: SentTransaction[] = [];
    createTransport(sentTransactions);
    const depsA = createDeps("alphaos-comm-smoke-a-");
    const depsB = createDeps("alphaos-comm-smoke-b-");

    initCommWallet(depsA, { masterPassword: MASTER_PASSWORD, privateKey: A_PRIVATE_KEY });
    initCommWallet(depsB, { masterPassword: MASTER_PASSWORD, privateKey: B_PRIVATE_KEY });

    const exportedA = await exportIdentityArtifactBundle(depsA, {
      masterPassword: MASTER_PASSWORD,
      displayName: "Agent A",
      nowUnixSeconds: 1772841600,
    });
    const exportedB = await exportIdentityArtifactBundle(depsB, {
      masterPassword: MASTER_PASSWORD,
      displayName: "Agent B",
      nowUnixSeconds: 1772841600,
    });

    const importedBOnA = await importIdentityArtifactBundle(
      { config: depsA.config, store: depsA.store },
      { bundle: exportedB.bundle, source: "smoke-b-on-a", nowUnixSeconds: 1772841600 },
    );
    const importedAOnB = await importIdentityArtifactBundle(
      { config: depsB.config, store: depsB.store },
      { bundle: exportedA.bundle, source: "smoke-a-on-b", nowUnixSeconds: 1772841600 },
    );

    expect(importedBOnA.ok).toBe(true);
    expect(importedAOnB.ok).toBe(true);

    const inviteResult = await sendCommConnectionInvite(depsA, {
      masterPassword: MASTER_PASSWORD,
      contactId: importedBOnA.contactId!,
      note: "smoke invite",
    });
    const deliveredInvite = await deliverNext(depsB, sentTransactions, "2026-03-08T00:00:00.000Z");

    expect(inviteResult.contactId).toBe(importedBOnA.contactId);
    expect(inviteResult.envelopeVersion).toBe(2);
    expect(deliveredInvite.command.type).toBe("connection_invite");
    expect(depsB.store.getAgentContact(importedAOnB.contactId!)?.status).toBe("pending_inbound");

    const acceptResult = await sendCommConnectionAccept(depsB, {
      masterPassword: MASTER_PASSWORD,
      contactId: importedAOnB.contactId!,
      note: "approved",
    });
    const deliveredAccept = await deliverNext(depsA, sentTransactions, "2026-03-08T00:00:01.000Z");

    expect(acceptResult.contactId).toBe(importedAOnB.contactId);
    expect(acceptResult.envelopeVersion).toBe(2);
    expect(deliveredAccept.command.type).toBe("connection_accept");
    expect(depsA.store.getAgentContact(importedBOnA.contactId!)?.status).toBe("trusted");
    expect(depsB.store.getAgentContact(importedAOnB.contactId!)?.status).toBe("trusted");

    const pingResult = await sendCommPing(depsA, {
      masterPassword: MASTER_PASSWORD,
      peerId: `contact:${importedBOnA.contactId}`,
      echo: "hello v2",
    });
    const deliveredPing = await deliverNext(depsB, sentTransactions, "2026-03-08T00:00:02.000Z");

    expect(pingResult.envelopeVersion).toBe(2);
    expect(pingResult.legacyFallbackUsed).toBe(false);
    expect(deliveredPing.message.envelopeVersion).toBe(2);
    expect(deliveredPing.message.status).toBe("decrypted");
    expect(deliveredPing.command).toEqual({
      type: "ping",
      payload: {
        echo: "hello v2",
      },
    });
  });

  it("covers v2 -> v1 fallback when the trusted contact only advertises agent-comm/1", async () => {
    const sentTransactions: SentTransaction[] = [];
    createTransport(sentTransactions);
    const depsA = createDeps("alphaos-comm-smoke-v2-v1-a-");
    const depsB = createDeps("alphaos-comm-smoke-v2-v1-b-");

    initCommWallet(depsA, { masterPassword: MASTER_PASSWORD, privateKey: A_PRIVATE_KEY });
    initCommWallet(depsB, { masterPassword: MASTER_PASSWORD, privateKey: B_PRIVATE_KEY });

    const walletA = restoreShadowWallet(A_PRIVATE_KEY);
    const walletB = restoreShadowWallet(B_PRIVATE_KEY);
    registerTrustedPeerEntry(
      { store: depsB.store },
      {
        peerId: "peer-a",
        walletAddress: walletA.getAddress(),
        pubkey: walletA.getPublicKey(),
      },
    );

    const contact = depsA.store.upsertAgentContact({
      identityWallet: walletB.getAddress(),
      status: "trusted",
      supportedProtocols: ["agent-comm/1"],
      capabilities: ["ping"],
    });
    depsA.store.upsertAgentTransportEndpoint({
      contactId: contact.contactId,
      identityWallet: contact.identityWallet,
      chainId: 196,
      receiveAddress: walletB.getAddress(),
      pubkey: walletB.getPublicKey(),
      keyId: "rk_legacy_only",
      endpointStatus: "active",
      source: "smoke-test",
    });

    const result = await sendCommPing(depsA, {
      masterPassword: MASTER_PASSWORD,
      peerId: `contact:${contact.contactId}`,
      senderPeerId: "peer-a",
      echo: "hello legacy",
    });
    const delivered = await deliverNext(depsB, sentTransactions, "2026-03-08T00:10:00.000Z");

    expect(result.envelopeVersion).toBe(1);
    expect(result.legacyFallbackUsed).toBe(true);
    expect(delivered.message.envelopeVersion).toBe(1);
    expect(delivered.message.status).toBe("decrypted");
    expect(delivered.command).toEqual({
      type: "ping",
      payload: {
        echo: "hello legacy",
      },
    });
  });

  it("covers v1 -> v2 legacy receive for a v2 runtime with backfilled trust", async () => {
    const sentTransactions: SentTransaction[] = [];
    createTransport(sentTransactions);
    const depsA = createDeps("alphaos-comm-smoke-v1-v2-a-");
    const depsB = createDeps("alphaos-comm-smoke-v1-v2-b-");

    initCommWallet(depsA, { masterPassword: MASTER_PASSWORD, privateKey: A_PRIVATE_KEY });
    initCommWallet(depsB, { masterPassword: MASTER_PASSWORD, privateKey: B_PRIVATE_KEY });

    const walletA = restoreShadowWallet(A_PRIVATE_KEY);
    const walletB = restoreShadowWallet(B_PRIVATE_KEY);
    registerTrustedPeerEntry(
      { store: depsA.store },
      {
        peerId: "peer-b",
        walletAddress: walletB.getAddress(),
        pubkey: walletB.getPublicKey(),
      },
    );
    registerTrustedPeerEntry(
      { store: depsB.store },
      {
        peerId: "peer-a",
        walletAddress: walletA.getAddress(),
        pubkey: walletA.getPublicKey(),
      },
    );

    const result = await sendCommPing(depsA, {
      masterPassword: MASTER_PASSWORD,
      peerId: "peer-b",
      senderPeerId: "peer-a",
      echo: "hello legacy receive",
    });
    const delivered = await deliverNext(depsB, sentTransactions, "2026-03-08T00:20:00.000Z");

    expect(result.envelopeVersion).toBe(1);
    expect(result.contactId).toBe(depsA.store.getAgentContactByLegacyPeerId("peer-b")?.contactId);
    expect(delivered.message.envelopeVersion).toBe(1);
    expect(delivered.message.status).toBe("decrypted");
    expect(delivered.message.peerId).toBe("peer-a");
    expect(delivered.command).toEqual({
      type: "ping",
      payload: {
        echo: "hello legacy receive",
      },
    });
    expect(depsB.store.getAgentContactByLegacyPeerId("peer-a")?.status).toBe("trusted");
  });
});
