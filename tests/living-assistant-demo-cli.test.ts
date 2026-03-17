import { describe, expect, it } from "vitest";
import { buildCallRuntime, parseCliOptions } from "../scripts/living-assistant-demo";

describe("living assistant demo CLI", () => {
  it("parses call demo-delivery mode", () => {
    const cli = parseCliOptions(["--call", "--demo-delivery"]);
    expect(cli).toEqual({
      live: false,
      dryRun: false,
      send: false,
      call: true,
      demoDelivery: true,
    });
  });

  it("rejects demo-delivery when call mode is missing", () => {
    expect(() => parseCliOptions(["--demo-delivery"])).toThrow("--demo-delivery requires --call");
  });

  it("builds simulated call route in demo-delivery mode without credentials", () => {
    const runtime = buildCallRuntime({
      demoDelivery: true,
      env: {},
    });

    expect(runtime.callDemoDelivery).toBe(true);
    expect(runtime.callPreflight?.twilio.readiness).toBe("not_configured");
    expect(runtime.callPreflight?.aliyun.readiness).toBe("not_configured");
    expect(runtime.callPreflight?.telegram.readiness).toBe("not_configured");
    expect(runtime.callRoute).toEqual([
      { channel: "twilio", simulated: true },
      { channel: "telegram", simulated: true },
    ]);
    expect(runtime.deliveryExecutor?.voiceOrchestratorOptions).toEqual({
      demoMode: true,
    });
  });

  it("requires at least one live call provider when demo-delivery is disabled", () => {
    expect(() =>
      buildCallRuntime({
        demoDelivery: false,
        env: {},
      }),
    ).toThrow("--call requires at least one ready call provider (Twilio or Aliyun).");
  });

  it("keeps Twilio-first route for live credentials and enables Telegram fallback when present", () => {
    const runtime = buildCallRuntime({
      env: {
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "token",
        TWILIO_FROM_NUMBER: "+12025550100",
        TWILIO_TO_NUMBER: "+12025550200",
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_CHAT_ID: "chat-id",
      },
    });

    expect(runtime.callDemoDelivery).toBe(false);
    expect(runtime.callProviders).toEqual(["twilio"]);
    expect(runtime.callRoute).toEqual([
      { channel: "twilio", simulated: false },
      { channel: "telegram", simulated: false },
    ]);
    expect(runtime.callPreflight?.twilio.readiness).toBe("ready");
    expect(runtime.callPreflight?.telegram.readiness).toBe("ready");
    expect(runtime.deliveryExecutor?.voiceOrchestratorOptions).toBeUndefined();
  });
});
