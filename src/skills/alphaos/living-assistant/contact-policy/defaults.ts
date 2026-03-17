import type { ContactPolicyConfig } from "./types";

export const defaultContactPolicyConfig: ContactPolicyConfig = {
  quietHoursStart: 23,
  quietHoursEnd: 8,
  maxContactsPerHour: 3,
  maxContactsPerDay: 12,
  minSignalUrgencyForVoice: "high",
  minSignalUrgencyForCallEscalation: "critical",
  allowVoiceBrief: true,
  allowCallEscalation: true,
  digestWindowMinutes: 60,
};
