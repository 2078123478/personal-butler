import type { ContactDecision } from "../contact-policy";
import type { VoiceBrief } from "../voice-brief";
import type { WebhookNotifierPayload } from "./types";

function compactChannels(channels: string[]): string {
  return channels.length > 0 ? channels.join("|") : "none";
}

function briefSnippet(brief: VoiceBrief | undefined): string {
  if (!brief) {
    return "";
  }

  const snippet = brief.text.length > 140 ? `${brief.text.slice(0, 140)}...` : brief.text;
  return ` brief=${snippet}`;
}

export function formatWebhookDelivery(
  decision: ContactDecision,
  brief?: VoiceBrief,
): WebhookNotifierPayload {
  const contact = decision.shouldContact ? "yes" : "no";
  return {
    mode: "now",
    text:
      `[living-assistant][${decision.attentionLevel}] contact=${contact}` +
      ` channels=${compactChannels(decision.channels)}` +
      ` reason=${decision.reason}${briefSnippet(brief)}`,
  };
}
