import crypto from "node:crypto";
import type { DiscoveryCandidate } from "../types";
import type { NormalizedSignal, SignalRelevanceHint, SignalUrgency } from "./types";

interface BinanceAnnouncementEvent {
  kind: "binance_announcement";
  title: string;
  body?: string;
  type?: string;
  pair?: string;
  tokenAddress?: string;
  chainId?: number;
  urgency?: SignalUrgency;
  relevanceHint?: SignalRelevanceHint;
  detectedAt?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

interface ArbitrageOpportunityEvent {
  kind: "arbitrage_opportunity";
  candidate: DiscoveryCandidate;
}

interface TokenRiskAlertEvent {
  kind: "token_risk_alert";
  title?: string;
  body?: string;
  tokenAddress: string;
  pair?: string;
  chainId?: number;
  severity?: SignalUrgency;
  detectedAt?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

interface SquareNarrativeEvent {
  kind: "square_narrative";
  title: string;
  body?: string;
  urgency?: SignalUrgency;
  relevanceHint?: SignalRelevanceHint;
  detectedAt?: string;
  metadata?: Record<string, unknown>;
}

export type RawSignalEvent =
  | BinanceAnnouncementEvent
  | ArbitrageOpportunityEvent
  | TokenRiskAlertEvent
  | SquareNarrativeEvent
  | NormalizedSignal;

const URGENCY_RANK: Record<SignalUrgency, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function asIsoTimestamp(input?: string): string {
  if (!input) {
    return new Date().toISOString();
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNormalizedSignal(value: unknown): value is NormalizedSignal {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.signalId === "string" &&
    typeof value.source === "string" &&
    typeof value.type === "string" &&
    typeof value.title === "string" &&
    typeof value.urgency === "string" &&
    typeof value.relevanceHint === "string" &&
    typeof value.detectedAt === "string"
  );
}

function urgencyFromDiscovery(candidate: DiscoveryCandidate): SignalUrgency {
  if (candidate.confidence >= 0.9 || candidate.expectedNetBps >= 120) {
    return "critical";
  }
  if (candidate.confidence >= 0.75 || candidate.expectedNetBps >= 70) {
    return "high";
  }
  if (candidate.confidence >= 0.55 || candidate.expectedNetBps >= 25) {
    return "medium";
  }
  return "low";
}

function strongestUrgency(a: SignalUrgency, b: SignalUrgency): SignalUrgency {
  return URGENCY_RANK[a] >= URGENCY_RANK[b] ? a : b;
}

export function discoveryToSignal(candidate: DiscoveryCandidate): NormalizedSignal {
  const urgency = urgencyFromDiscovery(candidate);
  const scoreUrgency: SignalUrgency = candidate.score >= 85 ? "critical" : candidate.score >= 65 ? "high" : "medium";

  return {
    signalId: crypto.randomUUID(),
    source: "market_opportunity",
    type: "spread_detected",
    title: `Arbitrage candidate detected for ${candidate.pair}`,
    body: candidate.reason,
    urgency: strongestUrgency(urgency, scoreUrgency),
    relevanceHint: "likely_relevant",
    pair: candidate.pair,
    detectedAt: asIsoTimestamp(candidate.signalTs),
    rawPayload: candidate as unknown as Record<string, unknown>,
    metadata: {
      strategyId: candidate.strategyId,
      buyDex: candidate.buyDex,
      sellDex: candidate.sellDex,
      expectedNetUsd: candidate.expectedNetUsd,
      expectedNetBps: candidate.expectedNetBps,
      confidence: candidate.confidence,
      score: candidate.score,
      status: candidate.status,
      sessionId: candidate.sessionId,
    },
  };
}

export function normalizeSignal(event: RawSignalEvent): NormalizedSignal {
  if (isNormalizedSignal(event)) {
    return {
      ...event,
      detectedAt: asIsoTimestamp(event.detectedAt),
    };
  }

  if (event.kind === "binance_announcement") {
    return {
      signalId: crypto.randomUUID(),
      source: "binance_announcement",
      type: event.type ?? "announcement",
      title: event.title,
      body: event.body,
      urgency: event.urgency ?? "medium",
      relevanceHint: event.relevanceHint ?? (event.pair || event.tokenAddress ? "likely_relevant" : "unknown"),
      pair: event.pair,
      tokenAddress: event.tokenAddress,
      chainId: event.chainId,
      detectedAt: asIsoTimestamp(event.detectedAt),
      expiresAt: event.expiresAt,
      rawPayload: event as unknown as Record<string, unknown>,
      metadata: event.metadata,
    };
  }

  if (event.kind === "arbitrage_opportunity") {
    return discoveryToSignal(event.candidate);
  }

  if (event.kind === "token_risk_alert") {
    return {
      signalId: crypto.randomUUID(),
      source: "token_risk_change",
      type: "risk_alert",
      title: event.title ?? `Token risk alert for ${event.tokenAddress}`,
      body: event.body,
      urgency: event.severity ?? "high",
      relevanceHint: event.pair || event.tokenAddress ? "likely_relevant" : "unknown",
      pair: event.pair,
      tokenAddress: event.tokenAddress,
      chainId: event.chainId,
      detectedAt: asIsoTimestamp(event.detectedAt),
      expiresAt: event.expiresAt,
      rawPayload: event as unknown as Record<string, unknown>,
      metadata: event.metadata,
    };
  }

  if (event.kind === "square_narrative") {
    return {
      signalId: crypto.randomUUID(),
      source: "binance_square",
      type: "meme_surge",
      title: event.title,
      body: event.body,
      urgency: event.urgency ?? "medium",
      relevanceHint: event.relevanceHint ?? "likely_irrelevant",
      detectedAt: asIsoTimestamp(event.detectedAt),
      rawPayload: event as unknown as Record<string, unknown>,
      metadata: event.metadata,
    };
  }

  const eventType = typeof event === "object" && event !== null && "kind" in event ? String((event as { kind: unknown }).kind) : "unknown";
  throw new Error(`Unsupported signal event shape: ${eventType}`);
}
