// Signal source categories
export type SignalSource =
  | "binance_announcement"
  | "binance_square"
  | "binance_alpha"
  | "market_opportunity" // from existing discovery engine
  | "token_risk_change"
  | "trading_signal"
  | "meme_rush"
  | "external_feed"
  | "manual_inject";

// Signal urgency as estimated by the radar (before judgment)
export type SignalUrgency = "low" | "medium" | "high" | "critical";

// Signal relevance hint (radar's best guess, judgment engine refines)
export type SignalRelevanceHint = "unknown" | "likely_relevant" | "likely_irrelevant";

export interface NormalizedSignal {
  signalId: string;
  source: SignalSource;
  type: string; // e.g. 'new_listing', 'spread_detected', 'risk_alert'
  title: string; // one-line human summary
  body?: string; // optional detail
  urgency: SignalUrgency;
  relevanceHint: SignalRelevanceHint;
  pair?: string; // if market-related
  tokenAddress?: string; // if token-specific
  chainId?: number;
  detectedAt: string; // ISO timestamp
  expiresAt?: string; // optional TTL
  rawPayload?: Record<string, unknown>; // original data for debugging
  metadata?: Record<string, unknown>;
}
