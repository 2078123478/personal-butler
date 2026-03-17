import type { AttentionLevel, ContactDecision } from "../contact-policy";
import type { VoiceBrief } from "../voice-brief";

export type TelegramPriority = "normal" | "high" | "critical";

export interface TelegramInlineButton {
  text: string;
  action: string;
}

export interface TelegramFollowUpPlan {
  intervalMinutes: number;
  maxAttempts: number;
  strategy: "repeat_until_acknowledged";
}

export interface TelegramDeliveryPayload {
  platform: "telegram";
  attentionLevel: AttentionLevel;
  priority: TelegramPriority;
  message: string;
  briefText?: string;
  inlineButtons?: TelegramInlineButton[];
  followUpPlan?: TelegramFollowUpPlan;
  metadata: {
    shouldContact: boolean;
    reason: string;
    suggestedActions?: string[];
    cooldownUntil?: string;
  };
}

export interface WebhookNotifierPayload {
  text: string;
  mode: "now";
}

export interface DeliveryAdapterInput {
  decision: ContactDecision;
  brief?: VoiceBrief;
}
