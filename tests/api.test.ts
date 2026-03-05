import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/skills/alphaos/api/server";
import { OnchainOsClient } from "../src/skills/alphaos/runtime/onchainos-client";
import { StateStore } from "../src/skills/alphaos/runtime/state-store";
import type { EngineModeResponse, SkillManifest } from "../src/skills/alphaos/types";

const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

type ApiResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  body: unknown;
};

async function invokeApi(
  app: ReturnType<typeof createServer>,
  method: "GET" | "POST",
  url: string,
  payload?: Record<string, unknown>,
): Promise<ApiResponse> {
  const socket = new PassThrough();
  (socket as { remoteAddress?: string }).remoteAddress = "127.0.0.1";
  const socketDestroy = socket.destroy.bind(socket);
  (socket as { destroy: () => PassThrough }).destroy = () => socket;

  let raw = "";
  const write = socket.write.bind(socket);
  (socket as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
    const chunk = args[0];
    if (Buffer.isBuffer(chunk)) {
      raw += chunk.toString("utf8");
    } else if (typeof chunk === "string") {
      raw += chunk;
    }
    return write(...(args as Parameters<typeof write>));
  };

  const req = new http.IncomingMessage(socket as never);
  req.method = method;
  req.url = url;
  req.headers = {};
  const payloadText = payload ? JSON.stringify(payload) : undefined;
  if (payloadText) {
    req.push(payloadText);
  }
  if (payload) {
    req.headers["content-type"] = "application/json";
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
  it("accepts whale signals and exposes them", async () => {
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
      strategyIds: ["dex-arbitrage", "smart-money-mirror"],
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

    const app = createServer(engine as never, store, manifest, { onchainClient });

    const createResp = await invokeApi(app, "POST", "/api/v1/signals/whale", {
      wallet: "0xabc",
      token: "ETH",
      side: "buy",
      sizeUsd: 100000,
      confidence: 0.91,
    });

    expect(createResp.status).toBe(202);

    const listResp = await invokeApi(app, "GET", "/api/v1/signals/whale?status=pending");
    expect(listResp.status).toBe(200);
    expect((listResp.body as { items: unknown[] }).items.length).toBe(1);

    const shareResp = await invokeApi(app, "GET", "/api/v1/growth/share/latest");
    expect(shareResp.status).toBe(404);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("updates strategy profiles and exports backtest snapshot", async () => {
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
      strategyIds: ["dex-arbitrage", "smart-money-mirror"],
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

    const app = createServer(engine as never, store, manifest, { onchainClient });

    const demoPage = await invokeApi(app, "GET", "/demo");
    expect(demoPage.status).toBe(200);
    expect(demoPage.headers["content-type"]).toContain("text/html");
    expect(demoPage.text).toContain("official-status");
    expect(demoPage.text).toContain("OnchainOS v6 Probe");
    expect(demoPage.text).toContain("/api/v1/integration/onchainos/probe");
    expect(demoPage.text).toContain("可用");
    expect(demoPage.text).toContain("受限");
    expect(demoPage.text).toContain("降级");

    const profileUpdate = await invokeApi(app, "POST", "/api/v1/strategies/profile", {
      strategyId: "dex-arbitrage",
      variant: "B",
      params: { notionalMultiplier: 1.4 },
    });
    expect(profileUpdate.status).toBe(200);

    const profileList = await invokeApi(app, "GET", "/api/v1/strategies/profiles");
    expect(profileList.status).toBe(200);
    expect((profileList.body as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const snapshotJson = await invokeApi(app, "GET", "/api/v1/backtest/snapshot?hours=24");
    expect(snapshotJson.status).toBe(200);
    expect((snapshotJson.body as { rows: unknown[] }).rows.length).toBeGreaterThan(0);

    const snapshotCsv = await invokeApi(app, "GET", "/api/v1/backtest/snapshot?hours=24&format=csv");
    expect(snapshotCsv.status).toBe(200);
    expect(snapshotCsv.headers["content-type"]).toContain("text/csv");
    expect(snapshotCsv.text).toContain("strategyId");

    const replay = await invokeApi(app, "POST", "/api/v1/replay/sandbox", {
      seed: "demo-seed",
      hours: 24,
      mode: "paper",
    });
    expect(replay.status).toBe(200);
    expect((replay.body as { seed: string }).seed).toBe("demo-seed");
    expect((replay.body as { total: number }).total).toBeGreaterThan(0);

    const integrationStatus = await invokeApi(app, "GET", "/api/v1/integration/onchainos/status");
    expect(integrationStatus.status).toBe(200);
    expect((integrationStatus.body as { authMode: string }).authMode).toBe("bearer");

    const probe = await invokeApi(app, "POST", "/api/v1/integration/onchainos/probe", {
      pair: "ETH/USDC",
      chainIndex: "196",
      notionalUsd: 25,
    });
    expect(probe.status).toBe(503);
    expect((probe.body as { ok: boolean }).ok).toBe(false);
    expect((probe.body as { configured: boolean }).configured).toBe(false);

    const tokenCache = await invokeApi(app, "GET", "/api/v1/integration/onchainos/token-cache?symbol=ETH&chainIndex=196");
    expect(tokenCache.status).toBe(200);
    expect((tokenCache.body as { items: unknown[] }).items.length).toBe(1);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
