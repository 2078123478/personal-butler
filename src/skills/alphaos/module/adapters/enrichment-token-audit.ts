import type { NormalizedEnrichmentContext } from "../types";
import type { AdapterRiskLevel, TokenAuditAdapterInput, TokenAuditAdapterPayload } from "./contracts";
import { dedupe, parseBoolean, parseString, parseStringArray } from "./helpers";

const TOKEN_AUDIT_SKILL = "binance-web3/query-token-audit";

function readField(
  input: TokenAuditAdapterInput | undefined,
  key: keyof TokenAuditAdapterPayload,
): unknown {
  return input?.provider?.payload?.[key] ?? input?.request?.[key] ?? input?.internal?.[key];
}

function normalizeRiskLevel(value: unknown): AdapterRiskLevel | undefined {
  const normalized = parseString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "low" || normalized === "normal" || normalized === "high" || normalized === "unknown") {
    return normalized;
  }
  if (normalized === "critical" || normalized === "severe") {
    return "high";
  }
  if (normalized === "medium" || normalized === "moderate") {
    return "normal";
  }
  return undefined;
}

export function normalizeTokenAuditEnrichment(
  input: TokenAuditAdapterInput | undefined,
): NormalizedEnrichmentContext | undefined {
  if (!input) {
    return undefined;
  }

  const tokenRisk = normalizeRiskLevel(readField(input, "tokenRisk"));
  const addressRiskLevel = normalizeRiskLevel(readField(input, "addressRiskLevel"));
  const flags = dedupe(parseStringArray(readField(input, "auditFlags")));
  const blocked = parseBoolean(readField(input, "blocked")) ?? false;
  const auditFlags = blocked ? dedupe([...flags, "blocked_by_upstream_policy"]) : flags;

  if (!tokenRisk && !addressRiskLevel && auditFlags.length === 0) {
    return undefined;
  }

  const sourceSkill = parseString(input.provider?.sourceSkill) ?? TOKEN_AUDIT_SKILL;
  return {
    risk: {
      tokenRisk,
      auditFlags,
      addressRiskLevel,
    },
    sourceSkills: [sourceSkill],
  };
}
