import type { SignalUrgency } from "../signal-radar";

// The attention ladder from the champion blueprint
export type AttentionLevel =
  | "silent" // Level 0: log only
  | "digest" // Level 0.5: include in next digest
  | "text_nudge" // Level 1: short text message
  | "voice_brief" // Level 2: micro voice brief
  | "strong_interrupt" // Level 3: message + voice + explicit choices
  | "call_escalation"; // Level 4: repeated high-priority contact

export type ContactChannel = "telegram" | "discord" | "webhook" | "voice";

export interface ContactDecision {
  shouldContact: boolean;
  attentionLevel: AttentionLevel;
  channels: ContactChannel[];
  reason: string; // one-line explanation of why this level
  suggestedActions?: string[]; // e.g. ['simulate_now', 'remind_later', 'ignore']
  cooldownUntil?: string; // ISO timestamp: don't re-escalate before this
  degradedFrom?: AttentionLevel; // if policy downgraded the level
  degradeReason?: string;
}

export interface UserContext {
  localHour: number; // 0-23, user's local time
  recentContactCount: number; // contacts in last N hours
  lastContactAt?: string; // ISO timestamp
  activeStrategies: string[]; // strategy IDs user cares about
  watchlist: string[]; // pairs or tokens user watches
  riskTolerance: "conservative" | "moderate" | "aggressive";
  quietHoursStart?: number; // e.g. 23
  quietHoursEnd?: number; // e.g. 8
  maxDailyContacts?: number; // rate limit
}

export interface ContactPolicyConfig {
  quietHoursStart: number;
  quietHoursEnd: number;
  maxContactsPerHour: number;
  maxContactsPerDay: number;
  minSignalUrgencyForVoice: SignalUrgency; // default: 'high'
  minSignalUrgencyForCallEscalation: SignalUrgency; // default: 'critical'
  allowVoiceBrief: boolean;
  allowCallEscalation: boolean;
  digestWindowMinutes: number; // batch low-priority signals into digest
}
