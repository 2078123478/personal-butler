import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/skills/alphaos/api/server";
import { StateStore } from "../src/skills/alphaos/runtime/state-store";
import type { EngineModeResponse, SkillManifest } from "../src/skills/alphaos/types";

const stores: Array<{ dir: string; store: StateStore }> = [];
const API_SECRET = "living-assistant-api-secret";

afterEach(() => {
  for (const entry of stores.splice(0)) {
    entry.store.close();
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
});

function setupApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaos-living-assistant-api-"));
  const store = new StateStore(dir);
  stores.push({ dir, store });

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
    description: "living assistant api test",
    strategyIds: ["dex-arbitrage"],
  };

  return createServer(engine as never, store, manifest, {
    apiSecret: API_SECRET,
    demoPublic: false,
  });
}

describe("living assistant API routes", () => {
  it("/evaluate accepts a signal and returns loop output", async () => {
    const app = setupApp();
    const response = await request(app)
      .post("/api/v1/living-assistant/evaluate")
      .set("Authorization", `Bearer ${API_SECRET}`)
      .send({
        signal: {
          kind: "binance_announcement",
          title: "ETH listing update",
          body: "Listing window now open.",
          type: "new_listing",
          pair: "ETH/USDC",
          urgency: "high",
          relevanceHint: "likely_relevant",
          detectedAt: "2026-03-17T10:10:00.000Z",
        },
        userContext: {
          localHour: 10,
          recentContactCount: 0,
          activeStrategies: ["spread-threshold"],
          watchlist: ["ETH/USDC"],
          riskTolerance: "moderate",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.signal.source).toBe("binance_announcement");
    expect(response.body.decision.attentionLevel).toBe("voice_brief");
    expect(response.body.brief).toBeDefined();
    expect(typeof response.body.loopCompletedAt).toBe("string");
  });

  it("/demo/:scenarioName loads fixture and returns loop result", async () => {
    const app = setupApp();
    const response = await request(app)
      .get("/api/v1/living-assistant/demo/quiet-hours-downgrade")
      .set("Authorization", `Bearer ${API_SECRET}`);

    expect(response.status).toBe(200);
    expect(response.body.signal.signalId).toBe("scenario-quiet-hours-1");
    expect(response.body.decision.attentionLevel).toBe("digest");
    expect(response.body.demoMode).toBe(true);
  });

  it("/capsules lists available signal capsules", async () => {
    const app = setupApp();
    const response = await request(app)
      .get("/api/v1/living-assistant/capsules")
      .set("Authorization", `Bearer ${API_SECRET}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
    expect(response.body.items).toContain("arbitrage-opportunity-eth-usdc.json");
    expect(response.body.items).toContain("binance-announcement-eth-listing.json");
  });
});
