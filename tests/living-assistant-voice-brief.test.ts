import { describe, expect, it } from "vitest";
import { generateVoiceBrief, validateVoiceBrief } from "../src/skills/alphaos/living-assistant/voice-brief";
import type { ContactDecision } from "../src/skills/alphaos/living-assistant/contact-policy";
import type { NormalizedSignal } from "../src/skills/alphaos/living-assistant/signal-radar";

function buildSignal(overrides?: Partial<NormalizedSignal>): NormalizedSignal {
  return {
    signalId: "signal-voice-1",
    source: "market_opportunity",
    type: "spread_detected",
    title: "Arbitrage candidate detected",
    urgency: "high",
    relevanceHint: "likely_relevant",
    pair: "ETH/USDC",
    detectedAt: "2026-03-17T08:00:00.000Z",
    ...overrides,
  };
}

function buildDecision(overrides?: Partial<ContactDecision>): ContactDecision {
  return {
    shouldContact: true,
    attentionLevel: "voice_brief",
    channels: ["telegram", "voice"],
    reason: "Relevant high urgency signal triggered voice brief.",
    ...overrides,
  };
}

describe("living assistant voice brief", () => {
  it("generates a protocol-compliant brief", () => {
    const brief = generateVoiceBrief(buildSignal(), buildDecision(), { language: "en" });

    expect(brief.briefId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(brief.protocolCompliant).toBe(true);
    expect(brief.sentenceCount).toBeLessThanOrEqual(3);
    expect(brief.estimatedDurationSeconds).toBeLessThanOrEqual(15);
    expect(brief.parts.whatHappened.length).toBeGreaterThan(0);
    expect(brief.parts.whyItMatters.length).toBeGreaterThan(0);
    expect(brief.parts.suggestedNext.length).toBeGreaterThan(0);
  });

  it("supports zh brief generation", () => {
    const brief = generateVoiceBrief(buildSignal(), buildDecision(), { language: "zh" });

    expect(brief.language).toBe("zh");
    expect(brief.protocolCompliant).toBe(true);
    expect(brief.text).toContain("要我");
  });

  it("flags a brief that is too long", () => {
    const text =
      "This is a very long voice brief designed to exceed the duration limit by adding many extra words that keep speaking for well beyond fifteen seconds in total length, while continuing to explain additional context, strategy implications, risk controls, expected upside, fallback options, and response timing details.";
    const result = validateVoiceBrief({
      text,
      language: "en",
      parts: {
        whatHappened: "This happened.",
        whyItMatters: "This matters.",
        suggestedNext: "Next step?",
      },
    });

    expect(result.protocolCompliant).toBe(false);
    expect(result.violations.some((item) => item.startsWith("duration_exceeded"))).toBe(true);
  });

  it("flags a brief with too many sentences", () => {
    const result = validateVoiceBrief({
      text: "One. Two. Three. Four.",
      language: "en",
      parts: {
        whatHappened: "One.",
        whyItMatters: "Two.",
        suggestedNext: "Three.",
      },
    });

    expect(result.protocolCompliant).toBe(false);
    expect(result.violations.some((item) => item.startsWith("sentence_count_exceeded"))).toBe(true);
  });

  it("flags missing required parts", () => {
    const result = validateVoiceBrief({
      text: "One. Two. Three.",
      language: "en",
      parts: {
        whatHappened: "One.",
        whyItMatters: "",
        suggestedNext: "Three.",
      },
    });

    expect(result.protocolCompliant).toBe(false);
    expect(result.violations).toContain("missing_part:why_it_matters");
  });

  it("flags dense numeric dumps", () => {
    const result = validateVoiceBrief({
      text: "Edge 12.5 bps, fee 2.1, slippage 3.2, gas 1.9, latency 220.",
      language: "en",
      parts: {
        whatHappened: "Edge 12.5 bps.",
        whyItMatters: "Fee 2.1 and slippage 3.2.",
        suggestedNext: "Gas 1.9 and latency 220.",
      },
    });

    expect(result.protocolCompliant).toBe(false);
    expect(result.violations.some((item) => item.startsWith("numeric_dump_detected"))).toBe(true);
  });
});
