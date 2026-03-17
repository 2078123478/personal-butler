import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultContactPolicyConfig } from "../src/skills/alphaos/living-assistant/contact-policy";
import type { UserContext } from "../src/skills/alphaos/living-assistant/contact-policy";
import { DigestBatchScheduler } from "../src/skills/alphaos/living-assistant/digest-batching";
import * as deliveryExecutorModule from "../src/skills/alphaos/living-assistant/delivery/delivery-executor";
import { TelegramVoiceSender } from "../src/skills/alphaos/living-assistant/delivery/telegram-voice-sender";
import { runLivingAssistantLoop } from "../src/skills/alphaos/living-assistant/loop";
import { loadSignalCapsuleFixture, normalizeSignal } from "../src/skills/alphaos/living-assistant/signal-radar";
import type { TTSProvider, TTSResult } from "../src/skills/alphaos/living-assistant/tts";

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

function createClock(startIso: string): {
  now: () => Date;
  set: (iso: string) => void;
} {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    set: (iso: string) => {
      current = Date.parse(iso);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("living assistant loop", () => {
  it("chains signal normalization to policy evaluation and brief generation", async () => {
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

    const output = await runLivingAssistantLoop({
      signal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
    });

    expect(output.signal.signalId).toBe(signal.signalId);
    expect(output.decision.attentionLevel).toBe("voice_brief");
    expect(output.brief?.signalId).toBe(signal.signalId);
    expect(output.delivered).toBe(false);
    expect(output.deliveryChannel).toBe("telegram");
  });

  it("returns the full decision chain but never marks delivered in demo mode", async () => {
    const signal = normalizeSignal({
      kind: "token_risk_alert",
      tokenAddress: "0x1111111111111111111111111111111111111111",
      severity: "critical",
      pair: "ETH/USDC",
      detectedAt: "2026-03-17T08:30:00.000Z",
    });

    const output = await runLivingAssistantLoop({
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

  it("runs end-to-end from a sample signal capsule", async () => {
    const [signal] = loadSignalCapsuleFixture("arbitrage-opportunity-eth-usdc.json");
    expect(signal).toBeDefined();

    const output = await runLivingAssistantLoop({
      signal: signal!,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
    });

    expect(output.signal.source).toBe("market_opportunity");
    expect(output.decision.attentionLevel).toBe("voice_brief");
    expect(output.brief?.protocolCompliant).toBe(true);
    expect(output.delivered).toBe(false);
  });

  it("loop with mock TTSProvider produces audio in output", async () => {
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

    const mockAudio: TTSResult = {
      audio: Buffer.from("audio-binary"),
      format: "mp3",
      durationSeconds: 1.2,
      provider: "mock-tts",
      generatedAt: "2026-03-17T09:00:00.000Z",
    };
    const synthesize = vi.fn(async () => mockAudio);
    const ttsProvider: TTSProvider = {
      name: "mock-tts",
      synthesize,
    };

    const output = await runLivingAssistantLoop({
      signal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
      ttsProvider,
      ttsOptions: { voice: "alloy", format: "mp3" },
    });

    expect(output.brief).toBeDefined();
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(output.audio).toEqual(mockAudio);
  });

  it("loop without TTSProvider still works and has no audio", async () => {
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

    const output = await runLivingAssistantLoop({
      signal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
    });

    expect(output.decision.attentionLevel).toBe("voice_brief");
    expect(output.brief).toBeDefined();
    expect(output.audio).toBeUndefined();
  });

  it("loop with failing TTSProvider still completes and leaves audio undefined", async () => {
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

    const ttsProvider: TTSProvider = {
      name: "mock-tts",
      synthesize: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    };

    const output = await runLivingAssistantLoop({
      signal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
      ttsProvider,
    });

    expect(output.decision.attentionLevel).toBe("voice_brief");
    expect(output.brief).toBeDefined();
    expect(output.audio).toBeUndefined();
    expect(output.delivered).toBe(false);
  });

  it("runs delivery executor when configured outside demo mode", async () => {
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

    const deliverySpy = vi.spyOn(deliveryExecutorModule, "executeDelivery").mockResolvedValue({
      channel: "telegram",
      sent: true,
      dryRun: false,
    });

    const output = await runLivingAssistantLoop({
      signal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
      deliveryExecutor: {
        telegramSender: new TelegramVoiceSender({
          botToken: "token",
          chatId: "chat-id",
        }),
      },
    });

    expect(deliverySpy).toHaveBeenCalledTimes(1);
    expect(output.delivery).toEqual({
      channel: "telegram",
      sent: true,
      dryRun: false,
    });
    expect(output.delivered).toBe(true);
  });

  it("skips delivery executor in demo mode even when configured", async () => {
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

    const deliverySpy = vi.spyOn(deliveryExecutorModule, "executeDelivery");

    const output = await runLivingAssistantLoop({
      signal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
      demoMode: true,
      deliveryExecutor: {
        telegramSender: new TelegramVoiceSender({
          botToken: "token",
          chatId: "chat-id",
        }),
      },
    });

    expect(deliverySpy).not.toHaveBeenCalled();
    expect(output.delivery).toBeUndefined();
    expect(output.delivered).toBe(false);
  });

  it("queues digest decisions into the digest scheduler", async () => {
    const scheduler = new DigestBatchScheduler({
      now: () => new Date("2026-03-17T10:00:00.000Z"),
    });
    const signal = normalizeSignal({
      kind: "binance_announcement",
      title: "Low urgency watchlist note",
      body: "Quiet update for ETH/USDC.",
      type: "exchange_news",
      pair: "ETH/USDC",
      urgency: "low",
      relevanceHint: "unknown",
      detectedAt: "2026-03-17T09:59:00.000Z",
    });

    const output = await runLivingAssistantLoop({
      signal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
      digestScheduler: scheduler,
    });

    expect(output.decision.attentionLevel).toBe("digest");
    expect(output.digestEnqueued?.signalId).toBe(signal.signalId);
    expect(output.digestQueue?.size).toBe(1);
    expect(output.digestFlushed).toBeUndefined();
  });

  it("flushes due digest batches before evaluating a new signal", async () => {
    const clock = createClock("2026-03-17T10:00:00.000Z");
    const scheduler = new DigestBatchScheduler({
      now: clock.now,
    });

    const digestSignal = normalizeSignal({
      kind: "binance_announcement",
      title: "Low urgency watchlist note",
      body: "Quiet update for ETH/USDC.",
      type: "exchange_news",
      pair: "ETH/USDC",
      urgency: "low",
      relevanceHint: "unknown",
      detectedAt: "2026-03-17T09:59:00.000Z",
    });
    await runLivingAssistantLoop({
      signal: digestSignal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
      digestScheduler: scheduler,
    });

    clock.set("2026-03-17T11:05:00.000Z");

    const highSignal = normalizeSignal({
      kind: "binance_announcement",
      title: "High urgency listing path update",
      body: "Listing details refreshed for ETH/USDC.",
      type: "new_listing",
      pair: "ETH/USDC",
      urgency: "high",
      relevanceHint: "likely_relevant",
      detectedAt: "2026-03-17T11:04:00.000Z",
    });
    const output = await runLivingAssistantLoop({
      signal: highSignal,
      userContext: buildUserContext(),
      policyConfig: defaultContactPolicyConfig,
      digestScheduler: scheduler,
    });

    expect(output.decision.attentionLevel).toBe("voice_brief");
    expect(output.digestFlushed?.signalCount).toBe(1);
    expect(output.digestFlushed?.items[0]?.signalId).toBe(digestSignal.signalId);
    expect(output.digestQueue?.size).toBe(0);
    expect(output.digestEnqueued).toBeUndefined();
  });
});
