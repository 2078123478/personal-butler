import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/skills/alphaos/runtime/config";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("loadConfig security defaults", () => {
  it("defaults live toggles to false", () => {
    delete process.env.LIVE_ENABLED;
    delete process.env.AUTO_PROMOTE_TO_LIVE;

    const config = loadConfig();
    expect(config.liveEnabled).toBe(false);
    expect(config.autoPromoteToLive).toBe(false);
  });

  it("reads API secret and demo visibility from env", () => {
    process.env.API_SECRET = "example-secret";
    process.env.DEMO_PUBLIC = "true";

    const config = loadConfig();
    expect(config.apiSecret).toBe("example-secret");
    expect(config.demoPublic).toBe(true);
  });

  it("reads private submit configuration from env", () => {
    process.env.ONCHAINOS_PRIVATE_RPC_URL = "https://private-rpc.example";
    process.env.ONCHAINOS_RELAY_URL = "https://relay.example";
    process.env.ONCHAINOS_USE_PRIVATE_SUBMIT = "true";

    const config = loadConfig();
    expect(config.onchainPrivateRpcUrl).toBe("https://private-rpc.example");
    expect(config.onchainRelayUrl).toBe("https://relay.example");
    expect(config.onchainUsePrivateSubmit).toBe(true);
  });
});
