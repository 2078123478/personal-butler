import type { NormalizedSignal, SignalUrgency } from "../signal-radar";
import { defaultContactPolicyConfig } from "./defaults";
import type { AttentionLevel, ContactChannel, ContactDecision, ContactPolicyConfig, UserContext } from "./types";

const URGENCY_RANK: Record<SignalUrgency, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const CONTACTABLE_LEVELS: AttentionLevel[] = ["text_nudge", "voice_brief", "strong_interrupt", "call_escalation"];

function isUrgencyAtLeast(actual: SignalUrgency, minimum: SignalUrgency): boolean {
  return URGENCY_RANK[actual] >= URGENCY_RANK[minimum];
}

function isInQuietHours(localHour: number, start: number, end: number): boolean {
  if (start === end) {
    return false;
  }
  if (start < end) {
    return localHour >= start && localHour < end;
  }
  return localHour >= start || localHour < end;
}

function normalizeWatchItem(value: string): string {
  return String(value).trim().toLowerCase();
}

function isWatchlistRelevant(signal: NormalizedSignal, watchlist: string[]): boolean {
  if (watchlist.length === 0) {
    return false;
  }
  const normalizedWatchlist = watchlist.map((item) => normalizeWatchItem(item));
  const pair = signal.pair ? normalizeWatchItem(signal.pair) : "";
  const tokenAddress = signal.tokenAddress ? normalizeWatchItem(signal.tokenAddress) : "";

  if (pair && normalizedWatchlist.includes(pair)) {
    return true;
  }
  if (tokenAddress && normalizedWatchlist.includes(tokenAddress)) {
    return true;
  }

  return normalizedWatchlist.some((item) => {
    if (!item) {
      return false;
    }
    return pair.includes(item) || tokenAddress.includes(item);
  });
}

function mapChannels(level: AttentionLevel): ContactChannel[] {
  if (level === "silent" || level === "digest") {
    return [];
  }
  if (level === "text_nudge") {
    return ["telegram"];
  }
  if (level === "voice_brief") {
    return ["telegram", "voice"];
  }
  if (level === "strong_interrupt") {
    return ["telegram", "voice", "webhook"];
  }
  return ["telegram", "voice", "webhook", "discord"];
}

function mapSuggestedActions(level: AttentionLevel): string[] | undefined {
  if (level === "silent") {
    return undefined;
  }
  if (level === "digest") {
    return ["review_in_digest"];
  }
  if (level === "text_nudge") {
    return ["simulate_now", "remind_later", "ignore"];
  }
  if (level === "voice_brief") {
    return ["give_10s_summary", "send_card", "remind_later"];
  }
  if (level === "strong_interrupt") {
    return ["act_now", "defer_5m", "ignore_once"];
  }
  return ["act_now", "call_me_now", "defer_2m"];
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function evaluateContactPolicy(
  signal: NormalizedSignal,
  userContext: UserContext,
  config: ContactPolicyConfig = defaultContactPolicyConfig,
): ContactDecision {
  const watchlistHit = isWatchlistRelevant(signal, userContext.watchlist);
  const relevant = watchlistHit || signal.relevanceHint === "likely_relevant";

  let level: AttentionLevel = "digest";
  let reason = "Signal routed to digest by default policy.";
  let degradedFrom: AttentionLevel | undefined;
  let degradeReason: string | undefined;

  const applyDegrade = (next: AttentionLevel, why: string) => {
    if (level === next) {
      return;
    }
    if (!degradedFrom) {
      degradedFrom = level;
    }
    level = next;
    degradeReason = degradeReason ? `${degradeReason}; ${why}` : why;
  };

  if (signal.urgency === "low" && !watchlistHit) {
    level = "silent";
    reason = "Low-urgency signal outside watchlist; logging only.";
  } else if (!relevant) {
    if (signal.urgency === "critical") {
      level = "strong_interrupt";
      reason = "Critical signal escalated despite low relevance confidence.";
    } else {
      level = "digest";
      reason = "Signal not clearly relevant; queued for digest.";
    }
  } else if (signal.urgency === "medium") {
    level = "text_nudge";
    reason = watchlistHit
      ? "Watchlist match and medium urgency triggered text nudge."
      : "Relevant medium-urgency signal triggered text nudge.";
  } else if (signal.urgency === "high") {
    level = "voice_brief";
    reason = watchlistHit
      ? "Watchlist match and high urgency triggered voice brief."
      : "Relevant high-urgency signal triggered voice brief.";
  } else if (signal.urgency === "critical") {
    level = "call_escalation";
    reason = "Relevant critical signal triggered escalation.";
  } else {
    level = "digest";
    reason = "Relevant low-urgency signal queued for digest.";
  }

  if (level === "voice_brief" && !config.allowVoiceBrief) {
    applyDegrade("text_nudge", "Voice brief is disabled by policy config.");
  } else if (level === "voice_brief" && !isUrgencyAtLeast(signal.urgency, config.minSignalUrgencyForVoice)) {
    applyDegrade("text_nudge", "Signal urgency below voice brief threshold.");
  }

  if (level === "call_escalation" && !config.allowCallEscalation) {
    applyDegrade("strong_interrupt", "Call escalation is disabled by policy config.");
  } else if (level === "call_escalation" && !isUrgencyAtLeast(signal.urgency, config.minSignalUrgencyForCallEscalation)) {
    applyDegrade("strong_interrupt", "Signal urgency below call escalation threshold.");
  }

  const quietHoursStart = userContext.quietHoursStart ?? config.quietHoursStart;
  const quietHoursEnd = userContext.quietHoursEnd ?? config.quietHoursEnd;

  if (CONTACTABLE_LEVELS.includes(level) && signal.urgency !== "critical") {
    if (isInQuietHours(userContext.localHour, quietHoursStart, quietHoursEnd)) {
      applyDegrade("digest", `Quiet hours (${quietHoursStart}:00-${quietHoursEnd}:00) active.`);
    }
  }

  const dayLimit = userContext.maxDailyContacts ?? config.maxContactsPerDay;
  const exceededRateLimit =
    userContext.recentContactCount >= config.maxContactsPerHour ||
    userContext.recentContactCount >= dayLimit ||
    userContext.recentContactCount >= config.maxContactsPerDay;

  if (CONTACTABLE_LEVELS.includes(level) && exceededRateLimit) {
    applyDegrade("digest", "Recent contacts exceed policy rate limits.");
  }

  const shouldContact = CONTACTABLE_LEVELS.includes(level);
  let cooldownUntil: string | undefined;
  if (level === "digest") {
    cooldownUntil = minutesFromNow(config.digestWindowMinutes);
  } else if (level === "call_escalation") {
    cooldownUntil = minutesFromNow(5);
  } else if (shouldContact) {
    cooldownUntil = minutesFromNow(15);
  }

  return {
    shouldContact,
    attentionLevel: level,
    channels: mapChannels(level),
    reason,
    suggestedActions: mapSuggestedActions(level),
    cooldownUntil,
    degradedFrom,
    degradeReason,
  };
}
