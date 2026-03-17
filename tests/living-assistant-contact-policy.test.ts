import { describe, expect, it } from "vitest";
import { defaultContactPolicyConfig, evaluateContactPolicy } from "../src/skills/alphaos/living-assistant/contact-policy";
import type { UserContext } from "../src/skills/alphaos/living-assistant/contact-policy";
import type { NormalizedSignal } from "../src/skills/alphaos/living-assistant/signal-radar";

function buildSignal(overrides?: Partial<NormalizedSignal>): NormalizedSignal {
  return {
    signalId: "signal-1",
    source: "market_opportunity",
    type: "spread_detected",
    title: "Arbitrage candidate detected",
    urgency: "medium",
    relevanceHint: "likely_relevant",
    pair: "ETH/USDC",
    detectedAt: "2026-03-17T08:00:00.000Z",
    ...overrides,
  };
}

function buildUserContext(overrides?: Partial<UserContext>): UserContext {
  return {
    localHour: 14,
    recentContactCount: 0,
    activeStrategies: ["spread-threshold"],
    watchlist: ["ETH/USDC"],
    riskTolerance: "moderate",
    ...overrides,
  };
}

describe("living assistant contact policy", () => {
  it("returns silent for low urgency not on watchlist", () => {
    const decision = evaluateContactPolicy(
      buildSignal({ urgency: "low", relevanceHint: "unknown", pair: "SOL/USDC" }),
      buildUserContext({ watchlist: ["ETH/USDC"] }),
      defaultContactPolicyConfig,
    );

    expect(decision.attentionLevel).toBe("silent");
    expect(decision.shouldContact).toBe(false);
    expect(decision.channels).toEqual([]);
  });

  it("returns digest for low urgency but watchlist relevant", () => {
    const decision = evaluateContactPolicy(
      buildSignal({ urgency: "low", relevanceHint: "unknown" }),
      buildUserContext(),
      defaultContactPolicyConfig,
    );

    expect(decision.attentionLevel).toBe("digest");
    expect(decision.shouldContact).toBe(false);
  });

  it("returns text_nudge for medium urgency relevant signals", () => {
    const decision = evaluateContactPolicy(buildSignal({ urgency: "medium" }), buildUserContext(), defaultContactPolicyConfig);

    expect(decision.attentionLevel).toBe("text_nudge");
    expect(decision.shouldContact).toBe(true);
    expect(decision.channels).toEqual(["telegram"]);
  });

  it("returns voice_brief for high urgency relevant signals", () => {
    const decision = evaluateContactPolicy(buildSignal({ urgency: "high" }), buildUserContext(), defaultContactPolicyConfig);

    expect(decision.attentionLevel).toBe("voice_brief");
    expect(decision.channels).toEqual(["telegram", "voice"]);
  });

  it("returns strong_interrupt when critical and call escalation disabled", () => {
    const decision = evaluateContactPolicy(
      buildSignal({ urgency: "critical" }),
      buildUserContext(),
      {
        ...defaultContactPolicyConfig,
        allowCallEscalation: false,
      },
    );

    expect(decision.attentionLevel).toBe("strong_interrupt");
    expect(decision.degradedFrom).toBe("call_escalation");
    expect(decision.degradeReason).toContain("disabled");
  });

  it("returns call_escalation for critical relevant signals", () => {
    const decision = evaluateContactPolicy(buildSignal({ urgency: "critical" }), buildUserContext(), defaultContactPolicyConfig);

    expect(decision.attentionLevel).toBe("call_escalation");
    expect(decision.shouldContact).toBe(true);
  });

  it("downgrades contact during quiet hours", () => {
    const decision = evaluateContactPolicy(
      buildSignal({ urgency: "high" }),
      buildUserContext({ localHour: 2 }),
      {
        ...defaultContactPolicyConfig,
        quietHoursStart: 23,
        quietHoursEnd: 8,
      },
    );

    expect(decision.attentionLevel).toBe("digest");
    expect(decision.degradedFrom).toBe("voice_brief");
    expect(decision.degradeReason).toContain("Quiet hours");
  });

  it("downgrades contact when rate limit exceeded", () => {
    const decision = evaluateContactPolicy(
      buildSignal({ urgency: "medium" }),
      buildUserContext({ recentContactCount: 5 }),
      {
        ...defaultContactPolicyConfig,
        maxContactsPerHour: 3,
        maxContactsPerDay: 8,
      },
    );

    expect(decision.attentionLevel).toBe("digest");
    expect(decision.degradedFrom).toBe("text_nudge");
    expect(decision.degradeReason).toContain("rate limits");
  });

  it("boosts relevance when signal matches watchlist", () => {
    const decision = evaluateContactPolicy(
      buildSignal({ urgency: "medium", relevanceHint: "unknown" }),
      buildUserContext({ watchlist: ["eth/usdc"] }),
      defaultContactPolicyConfig,
    );

    expect(decision.attentionLevel).toBe("text_nudge");
    expect(decision.reason).toContain("Watchlist match");
  });
});
