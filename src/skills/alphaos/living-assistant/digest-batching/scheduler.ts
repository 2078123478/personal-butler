import { buildDigestBatch } from "./builder";
import type {
  DigestBatch,
  DigestBatchSchedulerOptions,
  DigestEnqueueInput,
  DigestEnqueueResult,
  DigestQueueItem,
  DigestQueueSnapshot,
} from "./types";

const DEFAULT_WINDOW_MINUTES = 60;

function toPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function parseOptionalDate(input: Date | string | undefined): Date | undefined {
  if (input === undefined) {
    return undefined;
  }
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}

export class DigestBatchScheduler {
  private readonly now: () => Date;
  private readonly defaultWindowMinutes: number;
  private queue: DigestQueueItem[] = [];
  private queueSequence = 0;
  private digestSequence = 0;
  private windowStartedAt?: string;
  private nextFlushAt?: string;
  private windowMinutes?: number;

  constructor(options: DigestBatchSchedulerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.defaultWindowMinutes = toPositiveInt(options.defaultWindowMinutes ?? DEFAULT_WINDOW_MINUTES, DEFAULT_WINDOW_MINUTES);
  }

  enqueue(input: DigestEnqueueInput): DigestEnqueueResult {
    if (input.decision.attentionLevel !== "digest") {
      throw new Error(`Digest batcher only accepts digest decisions, received: ${input.decision.attentionLevel}`);
    }

    const queuedAt = this.toNow(input.queuedAt).toISOString();
    const windowMinutes = toPositiveInt(input.digestWindowMinutes, this.defaultWindowMinutes);
    if (this.queue.length === 0) {
      this.windowStartedAt = queuedAt;
      this.windowMinutes = windowMinutes;
      const flushAtMs = Date.parse(queuedAt) + windowMinutes * 60_000;
      this.nextFlushAt = Number.isFinite(flushAtMs)
        ? new Date(flushAtMs).toISOString()
        : new Date(this.now().getTime() + windowMinutes * 60_000).toISOString();
    }

    const item: DigestQueueItem = {
      itemId: `digest-item-${++this.queueSequence}`,
      signalId: input.signal.signalId,
      signal: input.signal,
      decisionReason: input.decision.reason,
      degradeReason: input.decision.degradeReason,
      queuedAt,
    };
    this.queue.push(item);

    return {
      item,
      queue: this.getSnapshot(),
    };
  }

  peekQueue(): DigestQueueItem[] {
    return [...this.queue];
  }

  getSnapshot(now?: Date | string): DigestQueueSnapshot {
    const current = this.toNow(now);
    const nextFlushAtMs = this.nextFlushAt ? Date.parse(this.nextFlushAt) : Number.NaN;
    const readyToFlush =
      this.queue.length > 0 &&
      Number.isFinite(nextFlushAtMs) &&
      current.getTime() >= nextFlushAtMs;

    let oldestDetectedAtMs: number | undefined;
    let newestDetectedAtMs: number | undefined;
    for (const item of this.queue) {
      const detectedAtMs = Date.parse(item.signal.detectedAt);
      if (!Number.isFinite(detectedAtMs)) {
        continue;
      }
      if (oldestDetectedAtMs === undefined || detectedAtMs < oldestDetectedAtMs) {
        oldestDetectedAtMs = detectedAtMs;
      }
      if (newestDetectedAtMs === undefined || detectedAtMs > newestDetectedAtMs) {
        newestDetectedAtMs = detectedAtMs;
      }
    }

    return {
      size: this.queue.length,
      windowStartedAt: this.windowStartedAt,
      nextFlushAt: this.nextFlushAt,
      ...(oldestDetectedAtMs !== undefined ? { oldestDetectedAt: new Date(oldestDetectedAtMs).toISOString() } : {}),
      ...(newestDetectedAtMs !== undefined ? { newestDetectedAt: new Date(newestDetectedAtMs).toISOString() } : {}),
      readyToFlush,
    };
  }

  flushDue(now?: Date | string): DigestBatch | undefined {
    if (this.queue.length === 0) {
      return undefined;
    }
    const snapshot = this.getSnapshot(now);
    if (!snapshot.readyToFlush) {
      return undefined;
    }
    return this.flushInternal(this.toNow(now).toISOString());
  }

  flushNow(now?: Date | string): DigestBatch | undefined {
    if (this.queue.length === 0) {
      return undefined;
    }
    return this.flushInternal(this.toNow(now).toISOString());
  }

  private flushInternal(createdAt: string): DigestBatch {
    const items = [...this.queue];
    const windowStartedAt = this.windowStartedAt ?? items[0]?.queuedAt ?? createdAt;
    const windowMinutes = this.windowMinutes ?? this.defaultWindowMinutes;

    this.queue = [];
    this.windowStartedAt = undefined;
    this.nextFlushAt = undefined;
    this.windowMinutes = undefined;
    this.digestSequence += 1;

    return buildDigestBatch({
      digestId: `digest-batch-${this.digestSequence}`,
      createdAt,
      windowStartedAt,
      windowEndedAt: createdAt,
      windowMinutes,
      items,
    });
  }

  private toNow(now?: Date | string): Date {
    const parsed = parseOptionalDate(now);
    if (parsed) {
      return parsed;
    }
    const current = this.now();
    return Number.isNaN(current.getTime()) ? new Date() : current;
  }
}
