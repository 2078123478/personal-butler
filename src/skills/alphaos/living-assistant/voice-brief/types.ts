import type { AttentionLevel } from "../contact-policy";

export interface VoiceBriefProtocol {
  maxDurationSeconds: number; // default: 15
  maxSentences: number; // default: 3
  requiredParts: ["what_happened", "why_it_matters", "suggested_next"];
}

export interface VoiceBrief {
  briefId: string;
  signalId: string;
  attentionLevel: AttentionLevel;
  text: string; // the full brief text, ready for TTS
  parts: {
    whatHappened: string;
    whyItMatters: string;
    suggestedNext: string;
  };
  estimatedDurationSeconds: number;
  sentenceCount: number;
  protocolCompliant: boolean;
  violations?: string[]; // if not compliant, what failed
  language: "zh" | "en";
  generatedAt: string;
}
