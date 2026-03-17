import crypto from "node:crypto";
import type { ContactDecision } from "../contact-policy";
import type { NormalizedSignal } from "../signal-radar";
import type { VoiceBrief, VoiceBriefProtocol } from "./types";
import { defaultVoiceBriefProtocol, validateVoiceBrief } from "./validator";

export interface GenerateVoiceBriefOptions {
  language?: "zh" | "en";
  protocol?: VoiceBriefProtocol;
}

function truncateWords(input: string, maxWords: number): string {
  const words = input
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(" ");
  }
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function truncateChars(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, maxChars)}...`;
}

function toHumanSignalLabel(signal: NormalizedSignal, language: "zh" | "en"): string {
  if (language === "zh") {
    if (signal.pair) {
      return `${signal.pair}新信号`;
    }
    return truncateChars(signal.title, 18);
  }

  if (signal.pair) {
    return `${signal.pair} signal`;
  }
  return truncateWords(signal.title, 9);
}

function mapUrgencyZh(urgency: NormalizedSignal["urgency"]): string {
  if (urgency === "critical") {
    return "极高";
  }
  if (urgency === "high") {
    return "高";
  }
  if (urgency === "medium") {
    return "中";
  }
  return "低";
}

function suggestedNextByLevel(attentionLevel: ContactDecision["attentionLevel"], language: "zh" | "en"): string {
  if (language === "zh") {
    if (attentionLevel === "call_escalation") {
      return "要我现在升级提醒，还是两分钟后再确认？";
    }
    if (attentionLevel === "strong_interrupt") {
      return "要我立刻执行模拟，还是先忽略一次？";
    }
    return "要我现在给你10秒结论，还是先发卡片？";
  }

  if (attentionLevel === "call_escalation") {
    return "Should I escalate now, or check again in two minutes?";
  }
  if (attentionLevel === "strong_interrupt") {
    return "Should I simulate now, or ignore this one time?";
  }
  return "Want a 10-second summary now, or should I send a card?";
}

function buildParts(signal: NormalizedSignal, decision: ContactDecision, language: "zh" | "en") {
  const label = toHumanSignalLabel(signal, language);

  if (language === "zh") {
    const target = signal.pair ?? signal.tokenAddress ?? "当前策略";
    return {
      whatHappened: `老大，出现了和${label}相关的新动态。`,
      whyItMatters: `这和你关注的${target}相关，当前是${mapUrgencyZh(signal.urgency)}优先级。`,
      suggestedNext: suggestedNextByLevel(decision.attentionLevel, language),
    };
  }

  const target = signal.pair ?? signal.tokenAddress ?? "tracked strategy";
  return {
    whatHappened: `Hey, there is a new update tied to your ${label}.`,
    whyItMatters: `This matters for your ${target} setup and is marked ${signal.urgency} urgency.`,
    suggestedNext: suggestedNextByLevel(decision.attentionLevel, language),
  };
}

function joinParts(parts: VoiceBrief["parts"], language: "zh" | "en"): string {
  if (language === "zh") {
    return `${parts.whatHappened}${parts.whyItMatters}${parts.suggestedNext}`;
  }
  return `${parts.whatHappened} ${parts.whyItMatters} ${parts.suggestedNext}`;
}

export function generateVoiceBrief(
  signal: NormalizedSignal,
  decision: ContactDecision,
  options: GenerateVoiceBriefOptions = {},
): VoiceBrief {
  const language = options.language ?? "en";
  const protocol = options.protocol ?? defaultVoiceBriefProtocol;
  const generatedAt = new Date().toISOString();

  const parts = buildParts(signal, decision, language);
  const text = joinParts(parts, language);
  const validation = validateVoiceBrief({ text, parts, language }, protocol);

  return {
    briefId: crypto.randomUUID(),
    signalId: signal.signalId,
    attentionLevel: decision.attentionLevel,
    text,
    parts,
    estimatedDurationSeconds: validation.estimatedDurationSeconds,
    sentenceCount: validation.sentenceCount,
    protocolCompliant: validation.protocolCompliant,
    violations: validation.violations.length > 0 ? validation.violations : undefined,
    language,
    generatedAt,
  };
}
