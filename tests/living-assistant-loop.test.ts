import { describe, expect, it } from "vitest";
import { defaultContactPolicyConfig } from "../src/skills/alphaos/living-assistant/contact-policy";
import type { UserContext } from "../src/skills/alphaos/living-assistant/contact-policy";
import { runLivingAssistantLoop } from "../src/skills/alphaos/living-assistant/loop";
import { loadSignalCapsuleFixture, normalizeSignal } from "../src/skills/alphaos/living-assistant/signal-radar";

function buildUserContext(overrides?: Partial<UserContext>): UserContext {
  return {
    localHour: 14,
    recentContactCount: 0,
    activeStrategies: ["spread-threshold"],
    watchlist: ["ETH/USDC", "0x1111111111111111111111111111111111111111"],
    riskTolerance: "moderate",
    quietHoursStart: 23,
    quietHoursEnd: 8,
    maxDailyContacts: 12,
    ...overrides,
  };
}

describe("living assistant loop", () => {
  it("chains signal normalization to policy evaluation and brief generation", () => {
    const signal = normalizeSignal({
      kind: "binance_announcement",
      title: "ETH listing path update",
      body: "Listing details refreshed for ETH/USDC.",
      type: "new_listing",
      pair: "ETH/USDC",
      urgency: "high",
      relevanceHint: "likely_relevant",
      detectedAt: "2026-03-17T08:00:00.000Z",
    });

    const output = runLivingAssistantLoop({
      signal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
    });

    expect(output.signal.signalId).toBe(signal.signalId);
    expect(output.decision.attentionLevel).toBe("voice_brief");
    expect(output.brief?.signalId).toBe(signal.signalId);
    expect(output.delivered).toBe(true);
    expect(output.deliveryChannel).toBe("telegram");
  });

  it("returns the full decision chain but never marks delivered in demo mode", () => {
    const signal = normalizeSignal({
      kind: "token_risk_alert",
      tokenAddress: "0x1111111111111111111111111111111111111111",
      severity: "critical",
      pair: "ETH/USDC",
      detectedAt: "2026-03-17T08:30:00.000Z",
    });

    const output = runLivingAssistantLoop({
      signal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
      demoMode: true,
    });

    expect(output.demoMode).toBe(true);
    expect(output.decision.attentionLevel).toBe("call_escalation");
    expect(output.brief).toBeDefined();
    expect(output.delivered).toBe(false);
  });

  it("runs end-to-end from a sample signal capsule", () => {
    const [signal] = loadSignalCapsuleFixture("arbitrage-opportunity-eth-usdc.json");
    expect(signal).toBeDefined();

    const output = runLivingAssistantLoop({
      signal: signal!,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
    });

    expect(output.signal.source).toBe("market_opportunity");
    expect(output.decision.attentionLevel).toBe("voice_brief");
    expect(output.brief?.protocolCompliant).toBe(true);
    expect(output.delivered).toBe(true);
  });
});
