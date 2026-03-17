import type { SignalUrgency } from "../signal-radar";
import type { BuildDigestBatchInput, DigestBatch, DigestQueueItem, DigestSummaryItem } from "./types";

const URGENCY_RANK: Record<SignalUrgency, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function compareDetectedAtDesc(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  const leftValue = Number.isFinite(left) ? left : 0;
  const rightValue = Number.isFinite(right) ? right : 0;
  return rightValue - leftValue;
}

function toSummaryItem(item: DigestQueueItem): DigestSummaryItem {
  return {
    signalId: item.signalId,
    source: item.signal.source,
    type: item.signal.type,
    urgency: item.signal.urgency,
    title: item.signal.title,
    detectedAt: item.signal.detectedAt,
    reason: item.decisionReason,
    ...(item.signal.pair ? { pair: item.signal.pair } : {}),
    ...(item.signal.tokenAddress ? { tokenAddress: item.signal.tokenAddress } : {}),
  };
}

function buildHighlight(item: DigestSummaryItem): string {
  const reference = item.pair ?? item.tokenAddress ?? item.type;
  return `[${item.urgency}] ${item.title} (${reference})`;
}

function buildDigestText(
  signalCount: number,
  windowStartedAt: string,
  windowEndedAt: string,
  urgencyCounts: Record<SignalUrgency, number>,
  highlights: string[],
): string {
  const headline = `${signalCount} signal(s) batched from ${windowStartedAt} to ${windowEndedAt}.`;
  const urgencyLine = `Urgency mix: critical=${urgencyCounts.critical}, high=${urgencyCounts.high}, medium=${urgencyCounts.medium}, low=${urgencyCounts.low}.`;
  const highlightLine = highlights.length > 0 ? `Highlights: ${highlights.join(" | ")}` : "Highlights: none.";
  return [headline, urgencyLine, highlightLine, "Action: review_in_digest."].join("\n");
}

export function buildDigestBatch(input: BuildDigestBatchInput): DigestBatch {
  const urgencyCounts: Record<SignalUrgency, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  const sourceCounts: Record<string, number> = {};

  const items = input.items
    .map((item) => toSummaryItem(item))
    .sort((left, right) => {
      const urgencyDiff = URGENCY_RANK[right.urgency] - URGENCY_RANK[left.urgency];
      if (urgencyDiff !== 0) {
        return urgencyDiff;
      }
      return compareDetectedAtDesc(left.detectedAt, right.detectedAt);
    });

  for (const item of items) {
    urgencyCounts[item.urgency] += 1;
    sourceCounts[item.source] = (sourceCounts[item.source] ?? 0) + 1;
  }

  const highlights = items.slice(0, 3).map((item) => buildHighlight(item));
  const text = buildDigestText(
    items.length,
    input.windowStartedAt,
    input.windowEndedAt,
    urgencyCounts,
    highlights,
  );

  return {
    digestId: input.digestId,
    createdAt: input.createdAt,
    windowStartedAt: input.windowStartedAt,
    windowEndedAt: input.windowEndedAt,
    windowMinutes: input.windowMinutes,
    signalCount: items.length,
    urgencyCounts,
    sourceCounts,
    highlights,
    text,
    items,
  };
}
