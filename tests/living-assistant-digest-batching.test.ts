import { describe, expect, it } from "vitest";
import { DigestBatchScheduler } from "../src/skills/alphaos/living-assistant/digest-batching";
import type { ContactDecision } from "../src/skills/alphaos/living-assistant/contact-policy";
import type { NormalizedSignal } from "../src/skills/alphaos/living-assistant/signal-radar";

function buildSignal(overrides?: Partial<NormalizedSignal>): NormalizedSignal {
  return {
    signalId: "signal-1",
    source: "binance_announcement",
    type: "exchange_news",
    title: "Signal title",
    urgency: "low",
    relevanceHint: "unknown",
    detectedAt: "2026-03-17T10:00:00.000Z",
    ...overrides,
  };
}

function buildDecision(overrides?: Partial<ContactDecision>): ContactDecision {
  return {
    shouldContact: false,
    attentionLevel: "digest",
    channels: [],
    reason: "Queued for digest.",
    ...overrides,
  };
}

function createClock(startIso: string): {
  now: () => Date;
  advanceMinutes: (minutes: number) => void;
} {
  let current = Date.parse(startIso);
  return {
    now: () => new Date(current),
    advanceMinutes: (minutes: number) => {
      current += minutes * 60_000;
    },
  };
}

describe("living assistant digest batching", () => {
  it("queues digest items and flushes when the window is due", () => {
    const clock = createClock("2026-03-17T10:00:00.000Z");
    const scheduler = new DigestBatchScheduler({
      now: clock.now,
      defaultWindowMinutes: 30,
    });

    const enqueueResult = scheduler.enqueue({
      signal: buildSignal({
        signalId: "signal-digest-1",
        title: "Low-priority watchlist update",
      }),
      decision: buildDecision(),
      digestWindowMinutes: 30,
    });
    expect(enqueueResult.queue.size).toBe(1);
    expect(enqueueResult.queue.nextFlushAt).toBe("2026-03-17T10:30:00.000Z");

    expect(scheduler.flushDue()).toBeUndefined();

    clock.advanceMinutes(31);
    const flushed = scheduler.flushDue();
    expect(flushed).toBeDefined();
    expect(flushed?.signalCount).toBe(1);
    expect(flushed?.windowStartedAt).toBe("2026-03-17T10:00:00.000Z");
    expect(flushed?.windowEndedAt).toBe("2026-03-17T10:31:00.000Z");
    expect(flushed?.items[0]?.signalId).toBe("signal-digest-1");
    expect(scheduler.getSnapshot().size).toBe(0);
  });

  it("builds a ranked digest summary on force flush", () => {
    const scheduler = new DigestBatchScheduler({
      now: () => new Date("2026-03-17T11:00:00.000Z"),
    });

    scheduler.enqueue({
      signal: buildSignal({
        signalId: "signal-medium",
        title: "Medium urgency signal",
        urgency: "medium",
        detectedAt: "2026-03-17T10:59:00.000Z",
      }),
      decision: buildDecision({
        reason: "Medium urgency was downgraded for quiet hours.",
      }),
      digestWindowMinutes: 60,
    });
    scheduler.enqueue({
      signal: buildSignal({
        signalId: "signal-high",
        source: "binance_square",
        title: "High urgency narrative pulse",
        urgency: "high",
        detectedAt: "2026-03-17T11:00:00.000Z",
      }),
      decision: buildDecision({
        reason: "High urgency was downgraded for quiet hours.",
      }),
      digestWindowMinutes: 60,
    });

    const flushed = scheduler.flushNow(new Date("2026-03-17T11:05:00.000Z"));
    expect(flushed).toBeDefined();
    expect(flushed?.signalCount).toBe(2);
    expect(flushed?.items[0]?.signalId).toBe("signal-high");
    expect(flushed?.urgencyCounts.high).toBe(1);
    expect(flushed?.urgencyCounts.medium).toBe(1);
    expect(flushed?.sourceCounts.binance_square).toBe(1);
    expect(flushed?.sourceCounts.binance_announcement).toBe(1);
    expect(flushed?.text).toContain("Action: review_in_digest.");
  });

  it("rejects non-digest decisions", () => {
    const scheduler = new DigestBatchScheduler();
    expect(() =>
      scheduler.enqueue({
        signal: buildSignal(),
        decision: buildDecision({
          shouldContact: true,
          attentionLevel: "text_nudge",
          channels: ["telegram"],
        }),
        digestWindowMinutes: 60,
      }),
    ).toThrow("only accepts digest decisions");
  });
});
