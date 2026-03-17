import type { ContactDecision } from "../contact-policy";
import type { NormalizedSignal, SignalUrgency } from "../signal-radar";

export interface DigestQueueItem {
  itemId: string;
  signalId: string;
  signal: NormalizedSignal;
  decisionReason: string;
  degradeReason?: string;
  queuedAt: string;
}

export interface DigestSummaryItem {
  signalId: string;
  source: string;
  type: string;
  urgency: SignalUrgency;
  title: string;
  detectedAt: string;
  reason: string;
  pair?: string;
  tokenAddress?: string;
}

export interface DigestBatch {
  digestId: string;
  createdAt: string;
  windowStartedAt: string;
  windowEndedAt: string;
  windowMinutes: number;
  signalCount: number;
  urgencyCounts: Record<SignalUrgency, number>;
  sourceCounts: Record<string, number>;
  highlights: string[];
  text: string;
  items: DigestSummaryItem[];
}

export interface DigestQueueSnapshot {
  size: number;
  windowStartedAt?: string;
  nextFlushAt?: string;
  oldestDetectedAt?: string;
  newestDetectedAt?: string;
  readyToFlush: boolean;
}

export interface DigestEnqueueInput {
  signal: NormalizedSignal;
  decision: ContactDecision;
  digestWindowMinutes: number;
  queuedAt?: string;
}

export interface DigestEnqueueResult {
  item: DigestQueueItem;
  queue: DigestQueueSnapshot;
}

export interface DigestBatchSchedulerOptions {
  now?: () => Date;
  defaultWindowMinutes?: number;
}

export interface BuildDigestBatchInput {
  digestId: string;
  createdAt: string;
  windowStartedAt: string;
  windowEndedAt: string;
  windowMinutes: number;
  items: DigestQueueItem[];
}
