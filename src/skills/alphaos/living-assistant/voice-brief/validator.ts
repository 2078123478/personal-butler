import type { VoiceBrief, VoiceBriefProtocol } from "./types";

export interface VoiceBriefValidationResult {
  protocolCompliant: boolean;
  violations: string[];
  sentenceCount: number;
  estimatedDurationSeconds: number;
}

export const defaultVoiceBriefProtocol: VoiceBriefProtocol = {
  maxDurationSeconds: 15,
  maxSentences: 3,
  requiredParts: ["what_happened", "why_it_matters", "suggested_next"],
};

function countChineseCharacters(text: string): number {
  const matches = text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g);
  return matches ? matches.length : 0;
}

function countEnglishWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean).length;
}

export function countSentences(text: string): number {
  const sentences = text
    .split(/[.!?。！？]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return sentences.length;
}

export function estimateDurationSeconds(text: string, language: "zh" | "en"): number {
  if (language === "zh") {
    const characterCount = countChineseCharacters(text);
    return Number((characterCount / 4).toFixed(2));
  }

  const wordCount = countEnglishWords(text);
  return Number((wordCount / 2.5).toFixed(2));
}

function countNumbers(text: string): number {
  const matches = text.match(/-?\d+(?:\.\d+)?/g);
  return matches ? matches.length : 0;
}

function isNonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateVoiceBrief(
  brief: Pick<VoiceBrief, "text" | "parts" | "language">,
  protocol: VoiceBriefProtocol = defaultVoiceBriefProtocol,
): VoiceBriefValidationResult {
  const sentenceCount = countSentences(brief.text);
  const estimatedDurationSeconds = estimateDurationSeconds(brief.text, brief.language);
  const violations: string[] = [];

  if (sentenceCount > protocol.maxSentences) {
    violations.push(`sentence_count_exceeded:${sentenceCount}>${protocol.maxSentences}`);
  }

  if (estimatedDurationSeconds > protocol.maxDurationSeconds) {
    violations.push(`duration_exceeded:${estimatedDurationSeconds}>${protocol.maxDurationSeconds}`);
  }

  if (!isNonEmpty(brief.parts.whatHappened)) {
    violations.push("missing_part:what_happened");
  }
  if (!isNonEmpty(brief.parts.whyItMatters)) {
    violations.push("missing_part:why_it_matters");
  }
  if (!isNonEmpty(brief.parts.suggestedNext)) {
    violations.push("missing_part:suggested_next");
  }

  const numberCount = countNumbers(brief.text);
  if (numberCount > 3) {
    violations.push(`numeric_dump_detected:${numberCount}`);
  }

  return {
    protocolCompliant: violations.length === 0,
    violations,
    sentenceCount,
    estimatedDurationSeconds,
  };
}
