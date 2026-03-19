import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/skills/alphaos/api/server";
import { loadConfig } from "../src/skills/alphaos/runtime/config";
import { OnchainOsClient } from "../src/skills/alphaos/runtime/onchainos-client";
import { StateStore } from "../src/skills/alphaos/runtime/state-store";
import type { EngineModeResponse, SkillManifest } from "../src/skills/alphaos/types";

const stores: StateStore[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) {
    store.close();
  }
  process.env = { ...originalEnv };
});

type ApiResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  body: unknown;
};

const TEST_API_SECRET = "unit-test-api-secret";

function makeApiTestConfig(profile: "xlayer-recommended" | "evm-custom" = "evm-custom") {
  process.env = {
    ...originalEnv,
    NETWORK_PROFILE: profile,
  };
  delete process.env.ONCHAINOS_API_BASE;
  delete process.env.COMM_ENABLED;
  delete process.env.COMM_RPC_URL;
  delete process.env.COMM_CHAIN_ID;
  delete process.env.ONCHAINOS_CHAIN_INDEX;
  return loadConfig();
}

function authHeaders(secret = TEST_API_SECRET): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

async function invokeApi(
  app: ReturnType<typeof createServer>,
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
  options?: {
    headers?: Record<string, string>;
    closeAfterFirstChunk?: boolean;
  },
): Promise<ApiResponse> {
  const socket = new PassThrough();
  (socket as { remoteAddress?: string }).remoteAddress = "127.0.0.1";
  const socketDestroy = socket.destroy.bind(socket);
  (socket as { destroy: () => PassThrough }).destroy = () => socket;

  let raw = "";
  let closeRequested = false;
  let req: http.IncomingMessage;
  const write = socket.write.bind(socket);
  (socket as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
    const chunk = args[0];
    if (Buffer.isBuffer(chunk)) {
      raw += chunk.toString("utf8");
    } else if (typeof chunk === "string") {
      raw += chunk;
    }
    if (options?.closeAfterFirstChunk && !closeRequested && raw.includes("\r\n\r\n")) {
      closeRequested = true;
      setImmediate(() => req.emit("close"));
    }
    return write(...(args as Parameters<typeof write>));
  };

  req = new http.IncomingMessage(socket as never);
  req.method = method;
  req.url = url;
  req.headers = {};
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    req.headers[key.toLowerCase()] = value;
  }
  const payloadText = payload ? JSON.stringify(payload) : undefined;
  if (payloadText) {
    req.push(payloadText);
  }
  if (payload) {
    req.headers["content-type"] = req.headers["content-type"] ?? "application/json";
    req.headers["content-length"] = String(Buffer.byteLength(payloadText ?? ""));
  }
  req.push(null);

  const res = new http.ServerResponse(req);
  res.assignSocket(socket as never);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`request timeout ${method} ${url}`)), 1500);
    const clear = () => clearTimeout(timeout);

    req.on("error", (error) => {
      clear();
      reject(error);
    });
    res.on("error", (error) => {
      clear();
      reject(error);
    });
    res.on("finish", () => {
      clear();
      resolve();
    });

    (
      app as unknown as {
        handle: (r: http.IncomingMessage, s: http.ServerResponse, n: (e?: unknown) => void) => void;
      }
    ).handle(req, res, (error?: unknown) => {
      if (error) {
        clear();
        reject(error);
      }
    });
  });

  const splitAt = raw.indexOf("\r\n\r\n");
  const headerBlock = splitAt >= 0 ? raw.slice(0, splitAt) : "";
  const text = splitAt >= 0 ? raw.slice(splitAt + 4) : "";
  const headers: Record<string, string> = {};
  const headerLines = headerBlock.split("\r\n").slice(1);
  for (const line of headerLines) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[key] = value;
  }

  let body: unknown = text;
  const contentType = headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    body = JSON.parse(text);
  }

  socketDestroy();
  return {
    status: res.statusCode,
    headers,
    text,
    body,
  };
}

describe("API server", () => {
  it("requires bearer auth for protected APIs", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-api-"));
    const store = new StateStore(tempDir);
    stores.push(store);

    const engine = {
      getCurrentMode: () => "paper",
      requestMode: (mode: "paper" | "live"): EngineModeResponse => ({
        ok: true,
        requestedMode: mode,
        currentMode: mode,
        reasons: [],
      }),
    };

    const manifest: SkillManifest = {
      id: "alphaos",
      version: "0.2.0",
      description: "test",
      strategyIds: ["dex-arbitrage"],
    };

    const onchainClient = new OnchainOsClient({
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: true,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
    });

    const app = createServer(engine as never, store, manifest, {
      onchainClient,
      apiSecret: TEST_API_SECRET,
      demoPublic: false,
    });

    const metricsUnauthorized = await invokeApi(app, "GET", "/api/v1/metrics/today");
    expect(metricsUnauthorized.status).toBe(401);

    const metricsAuthorized = await invokeApi(
      app,
      "GET",
      "/api/v1/metrics/today",
      undefined,
      { headers: authHeaders() },
    );
    expect(metricsAuthorized.status).toBe(200);

    const shareResp = await invokeApi(
      app,
      "GET",
      "/api/v1/growth/share/latest",
      undefined,
      { headers: authHeaders() },
    );
    expect(shareResp.status).toBe(404);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps demo + stream public only when DEMO_PUBLIC is true", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-api-"));
    const store = new StateStore(tempDir);
    stores.push(store);

    const engine = {
      getCurrentMode: () => "paper",
      requestMode: (mode: "paper" | "live"): EngineModeResponse => ({
        ok: true,
        requestedMode: mode,
        currentMode: mode,
        reasons: [],
      }),
    };

    const manifest: SkillManifest = {
      id: "alphaos",
      version: "0.2.0",
      description: "test",
      strategyIds: ["dex-arbitrage"],
    };

    const onchainClient = new OnchainOsClient({
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: true,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
    });

    const privateDemoApp = createServer(engine as never, store, manifest, {
      onchainClient,
      apiSecret: TEST_API_SECRET,
      demoPublic: false,
    });

    const privateDemoBlocked = await invokeApi(privateDemoApp, "GET", "/demo");
    expect(privateDemoBlocked.status).toBe(401);

    const privateStreamBlocked = await invokeApi(privateDemoApp, "GET", "/api/v1/stream/metrics");
    expect(privateStreamBlocked.status).toBe(401);

    const privateDemoAuthorized = await invokeApi(
      privateDemoApp,
      "GET",
      "/demo",
      undefined,
      { headers: authHeaders() },
    );
    expect(privateDemoAuthorized.status).toBe(200);

    const publicDemoApp = createServer(engine as never, store, manifest, {
      onchainClient,
      apiSecret: TEST_API_SECRET,
      demoPublic: true,
    });

    const publicDemo = await invokeApi(publicDemoApp, "GET", "/demo");
    expect(publicDemo.status).toBe(200);

    const publicStream = await invokeApi(
      publicDemoApp,
      "GET",
      "/api/v1/stream/metrics",
      undefined,
      { closeAfterFirstChunk: true },
    );
    expect(publicStream.status).toBe(200);
    expect(publicStream.headers["content-type"]).toContain("text/event-stream");

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("updates strategy profiles, exports snapshot, and renders demo without innerHTML", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-api-"));
    const store = new StateStore(tempDir);
    stores.push(store);

    const engine = {
      getCurrentMode: () => "paper",
      requestMode: (mode: "paper" | "live"): EngineModeResponse => ({
        ok: true,
        requestedMode: mode,
        currentMode: mode,
        reasons: [],
      }),
    };

    const manifest: SkillManifest = {
      id: "alphaos",
      version: "0.2.0",
      description: "test",
      strategyIds: ["dex-arbitrage"],
    };

    store.insertOpportunity(
      {
        id: "opp-1",
        strategyId: "dex-arbitrage",
        pair: "ETH/USDC",
        buyDex: "a",
        sellDex: "b",
        buyPrice: 100,
        sellPrice: 101,
        grossEdgeBps: 100,
        detectedAt: new Date().toISOString(),
      },
      1,
      2,
      "executed",
    );
    store.insertTrade(
      "opp-1",
      "paper",
      {
        success: true,
        txHash: "paper-1",
        status: "confirmed",
        grossUsd: 5,
        feeUsd: 1,
        netUsd: 4,
      },
      new Date().toISOString(),
    );

    store.upsertTokenCache({
      symbol: "ETH",
      chainIndex: "196",
      address: "0xeth",
      decimals: 18,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const onchainClient = new OnchainOsClient({
      authMode: "bearer",
      apiKeyHeader: "X-API-Key",
      gasUsdDefault: 1,
      chainIndex: "196",
      requireSimulate: true,
      enableCompatFallback: true,
      tokenCacheTtlSeconds: 600,
      tokenProfilePath: "/api/v6/market/token/profile/current",
      store,
    });

    const app = createServer(engine as never, store, manifest, {
      config: makeApiTestConfig(),
      onchainClient,
      apiSecret: TEST_API_SECRET,
      demoPublic: true,
    });

    const health = await invokeApi(app, "GET", "/health");
    expect(health.status).toBe(200);
    expect(
      (health.body as { networkProfile?: { id?: string; readiness?: string } }).networkProfile?.id,
    ).toBe("evm-custom");
    expect(
      (health.body as { networkProfile?: { readiness?: string } }).networkProfile?.readiness,
    ).toBe("unavailable");

    const demoPage = await invokeApi(app, "GET", "/demo");
    expect(demoPage.status).toBe(200);
    expect(demoPage.headers["content-type"]).toContain("text/html");
    expect(demoPage.text).toContain("official-status");
    expect(demoPage.text).toContain("Execution Backend Probe");
    expect(demoPage.text).toContain("Growth Moments");
    expect(demoPage.text).toContain("/api/v1/integration/execution/probe");
    expect(demoPage.text).toContain("可用");
    expect(demoPage.text).toContain("受限");
    expect(demoPage.text).toContain("降级");
    expect(demoPage.text).not.toContain("innerHTML");

    const metricsUnauthorized = await invokeApi(app, "GET", "/api/v1/metrics/today");
    expect(metricsUnauthorized.status).toBe(401);

    const profileUpdate = await invokeApi(
      app,
      "POST",
      "/api/v1/strategies/profile",
      {
        strategyId: "dex-arbitrage",
        variant: "B",
        params: { notionalMultiplier: 1.4 },
      },
      { headers: authHeaders() },
    );
    expect(profileUpdate.status).toBe(200);

    const profileList = await invokeApi(
      app,
      "GET",
      "/api/v1/strategies/profiles",
      undefined,
      { headers: authHeaders() },
    );
    expect(profileList.status).toBe(200);
    expect((profileList.body as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const snapshotJson = await invokeApi(
      app,
      "GET",
      "/api/v1/backtest/snapshot?hours=24",
      undefined,
      { headers: authHeaders() },
    );
    expect(snapshotJson.status).toBe(200);
    expect((snapshotJson.body as { rows: unknown[] }).rows.length).toBeGreaterThan(0);

    const snapshotCsv = await invokeApi(
      app,
      "GET",
      "/api/v1/backtest/snapshot?hours=24&format=csv",
      undefined,
      { headers: authHeaders() },
    );
    expect(snapshotCsv.status).toBe(200);
    expect(snapshotCsv.headers["content-type"]).toContain("text/csv");
    expect(snapshotCsv.text).toContain("strategyId");

    const replay = await invokeApi(
      app,
      "POST",
      "/api/v1/replay/sandbox",
      {
        seed: "demo-seed",
        hours: 24,
        mode: "paper",
      },
      { headers: authHeaders() },
    );
    expect(replay.status).toBe(200);
    expect((replay.body as { seed: string }).seed).toBe("demo-seed");
    expect((replay.body as { total: number }).total).toBeGreaterThan(0);

    const integrationStatus = await invokeApi(
      app,
      "GET",
      "/api/v1/integration/execution/status",
      undefined,
      { headers: authHeaders() },
    );
    expect(integrationStatus.status).toBe(200);
    expect((integrationStatus.body as { authMode: string }).authMode).toBe("bearer");
    expect(
      (
        integrationStatus.body as {
          networkProfile?: { profile?: { id?: string }; readiness?: string; reasons?: string[] };
        }
      ).networkProfile?.profile?.id,
    ).toBe("evm-custom");
    expect(
      (
        integrationStatus.body as {
          networkProfile?: { readiness?: string; reasons?: string[] };
        }
      ).networkProfile?.readiness,
    ).toBe("unavailable");
    expect(
      (
        integrationStatus.body as {
          networkProfile?: { reasons?: string[] };
        }
      ).networkProfile?.reasons?.some((reason) => reason.includes("COMM_RPC_URL")),
    ).toBe(true);

    const runtimeStatus = await invokeApi(app, "GET", "/api/v1/status", undefined, {
      headers: authHeaders(),
    });
    expect(runtimeStatus.status).toBe(200);
    expect(
      (
        runtimeStatus.body as {
          networkProfile?: { profile?: { id?: string }; readiness?: string; activeProbe?: boolean };
        }
      ).networkProfile?.profile?.id,
    ).toBe("evm-custom");
    expect(
      (
        runtimeStatus.body as {
          networkProfile?: { readiness?: string; activeProbe?: boolean };
        }
      ).networkProfile?.readiness,
    ).toBe("unavailable");
    expect(
      (
        runtimeStatus.body as {
          networkProfile?: { activeProbe?: boolean };
        }
      ).networkProfile?.activeProbe,
    ).toBe(true);

    const probe = await invokeApi(
      app,
      "POST",
      "/api/v1/integration/execution/probe",
      {
        pair: "ETH/USDC",
        chainIndex: "196",
        notionalUsd: 25,
      },
      { headers: authHeaders() },
    );
    expect(probe.status).toBe(503);
    expect((probe.body as { ok: boolean }).ok).toBe(false);
    expect((probe.body as { configured: boolean }).configured).toBe(false);

    const tokenCache = await invokeApi(
      app,
      "GET",
      "/api/v1/integration/execution/token-cache?symbol=ETH&chainIndex=196",
      undefined,
      { headers: authHeaders() },
    );
    expect(tokenCache.status).toBe(200);
    expect((tokenCache.body as { items: unknown[] }).items.length).toBe(1);

    const moments = await invokeApi(
      app,
      "GET",
      "/api/v1/growth/moments?limit=5",
      undefined,
      { headers: authHeaders() },
    );
    expect(moments.status).toBe(200);
    expect((moments.body as { items: Array<{ category?: string; text?: string }> }).items.length).toBeGreaterThan(0);
    expect(
      (moments.body as { items: Array<{ category?: string }> }).items.some(
        (item) => item.category === "summary" || item.category === "trade",
      ),
    ).toBe(true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves agent-comm status, message query, and trusted peer upsert endpoints", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-api-"));
    const store = new StateStore(tempDir);
    stores.push(store);
    const config = {
      ...makeApiTestConfig(),
      commAutoAcceptInvites: true,
    };

    const engine = {
      getCurrentMode: () => "paper",
      requestMode: (mode: "paper" | "live"): EngineModeResponse => ({
        ok: true,
        requestedMode: mode,
        currentMode: mode,
        reasons: [],
      }),
    };

    const manifest: SkillManifest = {
      id: "alphaos",
      version: "0.2.0",
      description: "test",
      strategyIds: ["dex-arbitrage"],
    };

    const contact = store.upsertAgentContact({
      identityWallet: "0x8888888888888888888888888888888888888888",
      legacyPeerId: "peer-contact",
      status: "pending_inbound",
      supportedProtocols: ["agent-comm/2"],
      capabilities: ["ping"],
    });
    store.upsertAgentConnectionEvent({
      contactId: contact.contactId,
      identityWallet: contact.identityWallet,
      direction: "inbound",
      eventType: "connection_invite",
      eventStatus: "pending",
      occurredAt: "2026-03-07T00:00:00.000Z",
    });

    const app = createServer(engine as never, store, manifest, {
      config,
      apiSecret: TEST_API_SECRET,
      demoPublic: false,
      agentCommRuntime: {
        stop: () => undefined,
        getSnapshot: () => ({
          enabled: true,
          chainId: 196,
          listenerMode: "poll",
          walletAlias: "agent-comm",
          localAddress: "0x1111111111111111111111111111111111111111",
          localPubkey: "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      },
    });

    store.upsertAgentPeer({
      peerId: "peer-existing",
      walletAddress: "0x9999999999999999999999999999999999999999",
      pubkey: "03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "trusted",
      capabilities: ["ping"],
    });
    store.insertAgentMessage({
      id: "msg-existing",
      direction: "inbound",
      peerId: "peer-existing",
      nonce: "nonce-existing",
      commandType: "ping",
      ciphertext: "0xdeadbeef",
      status: "executed",
      receivedAt: new Date().toISOString(),
      executedAt: new Date().toISOString(),
    });
    store.insertAgentMessage({
      id: "msg-paid-pending",
      direction: "inbound",
      peerId: "unknown:0x6666666666666666666666666666666666666666",
      nonce: "nonce-paid-pending",
      commandType: "ping",
      envelopeVersion: 2,
      identityWallet: "0x6666666666666666666666666666666666666666",
      transportAddress: "0x6666666666666666666666666666666666666666",
      trustOutcome: "paid_pending",
      payment: {
        asset: "USDC",
        amount: "1000000",
        metadata: {
          invoiceId: "inv-api-1",
        },
      },
      ciphertext: "0xfeedbeef",
      status: "paid_pending",
      receivedAt: new Date().toISOString(),
    });

    const statusResp = await invokeApi(
      app,
      "GET",
      "/api/v1/agent-comm/status",
      undefined,
      { headers: authHeaders() },
    );
    expect(statusResp.status).toBe(200);
    expect((statusResp.body as { snapshot: { enabled: boolean } }).snapshot.enabled).toBe(true);
    expect((statusResp.body as { autoAcceptInvites: boolean }).autoAcceptInvites).toBe(true);
    expect((statusResp.body as { trustedPeerCount: number }).trustedPeerCount).toBe(1);
    expect((statusResp.body as { paidPendingMessageCount: number }).paidPendingMessageCount).toBe(1);
    expect((statusResp.body as { contactCount: number }).contactCount).toBe(1);
    expect(
      (statusResp.body as { contactStatusCounts: { pending_inbound: number } }).contactStatusCounts
        .pending_inbound,
    ).toBe(1);
    expect(
      (statusResp.body as { pendingInviteCounts: { total: number } }).pendingInviteCounts.total,
    ).toBe(1);
    expect(
      (statusResp.body as { legacyUsage: { manualPeerRecordCount: number } }).legacyUsage
        .manualPeerRecordCount,
    ).toBe(0);
    expect(
      (statusResp.body as { legacyUsage: { shouldDiscourageNewLegacyOnboarding: boolean } }).legacyUsage
        .shouldDiscourageNewLegacyOnboarding,
    ).toBe(false);

    const messagesResp = await invokeApi(
      app,
      "GET",
      "/api/v1/agent-comm/messages?direction=inbound&status=executed",
      undefined,
      { headers: authHeaders() },
    );
    expect(messagesResp.status).toBe(200);
    expect((messagesResp.body as { items: unknown[] }).items).toHaveLength(1);

    const peersUpsert = await invokeApi(
      app,
      "POST",
      "/api/v1/agent-comm/peers/trusted",
      {
        peerId: "peer-new",
        walletAddress: "0x7777777777777777777777777777777777777777",
        pubkey: "03cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        capabilities: ["ping", "start_discovery"],
      },
      { headers: authHeaders() },
    );
    expect(peersUpsert.status).toBe(200);
    expect((peersUpsert.body as { peerId: string }).peerId).toBe("peer-new");
    expect((peersUpsert.body as { status: string }).status).toBe("trusted");
    expect((peersUpsert.body as { warnings: string[] }).warnings).toEqual([
      "legacy/manual v1 fallback record created; prefer card import plus invite/accept for new contacts",
    ]);

    const peersResp = await invokeApi(
      app,
      "GET",
      "/api/v1/agent-comm/peers?status=trusted",
      undefined,
      { headers: authHeaders() },
    );
    expect(peersResp.status).toBe(200);
    expect((peersResp.body as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(2);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns expiry warnings for expiring local LIW/ACW artifacts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-api-"));
    const store = new StateStore(tempDir);
    stores.push(store);
    const config = {
      ...makeApiTestConfig(),
      commArtifactExpiryWarningDays: 7,
    };

    const engine = {
      getCurrentMode: () => "paper",
      requestMode: (mode: "paper" | "live"): EngineModeResponse => ({
        ok: true,
        requestedMode: mode,
        currentMode: mode,
        reasons: [],
      }),
    };

    const manifest: SkillManifest = {
      id: "alphaos",
      version: "0.2.0",
      description: "test",
      strategyIds: ["dex-arbitrage"],
    };

    const liwAddress = "0x1111111111111111111111111111111111111111";
    const acwAddress = "0x2222222222222222222222222222222222222222";
    const activeBindingDigest = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const nowUnixSeconds = Math.floor(Date.now() / 1000);

    store.upsertAgentLocalIdentity({
      role: "liw",
      walletAlias: "agent-comm-liw",
      walletAddress: liwAddress,
      identityWallet: liwAddress,
      chainId: 196,
      mode: "standard",
    });
    store.upsertAgentLocalIdentity({
      role: "acw",
      walletAlias: "agent-comm",
      walletAddress: acwAddress,
      identityWallet: liwAddress,
      chainId: 196,
      mode: "standard",
      activeBindingDigest,
      transportKeyId: "acw-key-1",
    });

    store.upsertAgentSignedArtifact({
      artifactType: "ContactCard",
      digest: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      signer: liwAddress,
      identityWallet: liwAddress,
      chainId: 196,
      issuedAt: nowUnixSeconds - 60,
      expiresAt: nowUnixSeconds + 5 * 24 * 60 * 60,
      payload: {
        identityWallet: liwAddress,
        transport: {
          receiveAddress: acwAddress,
          keyId: "acw-key-1",
        },
      },
      proof: {},
      verificationStatus: "verified",
      source: "local_export",
    });
    store.upsertAgentSignedArtifact({
      artifactType: "TransportBinding",
      digest: activeBindingDigest,
      signer: liwAddress,
      identityWallet: liwAddress,
      chainId: 196,
      issuedAt: nowUnixSeconds - 60,
      expiresAt: nowUnixSeconds + 2 * 24 * 60 * 60,
      payload: {
        identityWallet: liwAddress,
        receiveAddress: acwAddress,
        keyId: "acw-key-1",
      },
      proof: {},
      verificationStatus: "verified",
      source: "local_export",
    });
    store.upsertAgentSignedArtifact({
      artifactType: "ContactCard",
      digest: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      signer: liwAddress,
      identityWallet: liwAddress,
      chainId: 196,
      issuedAt: nowUnixSeconds - 60,
      expiresAt: nowUnixSeconds + 24 * 60 * 60,
      payload: {
        identityWallet: liwAddress,
        transport: {
          receiveAddress: "0x3333333333333333333333333333333333333333",
          keyId: "old-key",
        },
      },
      proof: {},
      verificationStatus: "verified",
      source: "local_import",
    });

    const app = createServer(engine as never, store, manifest, {
      config,
      apiSecret: TEST_API_SECRET,
      demoPublic: false,
      agentCommRuntime: {
        stop: () => undefined,
        getSnapshot: () => ({
          enabled: true,
          chainId: 196,
          listenerMode: "poll",
          walletAlias: "agent-comm",
          localAddress: acwAddress,
          localPubkey: "03bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      },
    });

    const statusResp = await invokeApi(
      app,
      "GET",
      "/api/v1/agent-comm/status",
      undefined,
      { headers: authHeaders() },
    );

    expect(statusResp.status).toBe(200);
    expect(
      (statusResp.body as {
        expiryWarnings: Array<{ type: string; expiresAt: string; daysRemaining: number }>;
      }).expiryWarnings,
    ).toEqual([
      {
        type: "transport_binding",
        expiresAt: "2026-03-12T00:00:00.000Z",
        daysRemaining: 2,
      },
      {
        type: "contact_card",
        expiresAt: "2026-03-15T00:00:00.000Z",
        daysRemaining: 5,
      },
    ]);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
