import type {
  ArbitrageSkillUsage,
  NormalizedEnrichmentContext,
  NormalizedMarketContext,
  NormalizedReadinessContext,
} from "../types";
import type { FirstBatchArbitrageAdapterInputs } from "./contracts";
import { normalizeSpotMarketContext } from "./market-context-spot";
import { normalizeAssetsReadinessContext } from "./readiness-assets";
import { normalizeTokenInfoEnrichment } from "./enrichment-token-info";
import { normalizeTokenAuditEnrichment } from "./enrichment-token-audit";
import { dedupe } from "./helpers";

export interface FirstBatchArbitrageAdapterComposition {
  marketContext?: NormalizedMarketContext;
  readinessContext?: NormalizedReadinessContext;
  enrichmentContext?: NormalizedEnrichmentContext;
  skillUsagePatch?: Partial<ArbitrageSkillUsage>;
}

function mergeRiskContext(
  preferred: NormalizedEnrichmentContext["risk"] | undefined,
  fallback: NormalizedEnrichmentContext["risk"] | undefined,
): NormalizedEnrichmentContext["risk"] | undefined {
  const tokenRisk = preferred?.tokenRisk ?? fallback?.tokenRisk;
  const addressRiskLevel = preferred?.addressRiskLevel ?? fallback?.addressRiskLevel;
  const auditFlags = dedupe([...(fallback?.auditFlags ?? []), ...(preferred?.auditFlags ?? [])]);
  if (!tokenRisk && !addressRiskLevel && auditFlags.length === 0) {
    return undefined;
  }
  return {
    tokenRisk,
    addressRiskLevel,
    auditFlags: auditFlags.length > 0 ? auditFlags : undefined,
  };
}

export function mergeNormalizedEnrichmentContexts(
  preferred: NormalizedEnrichmentContext | undefined,
  fallback: NormalizedEnrichmentContext | undefined,
): NormalizedEnrichmentContext | undefined {
  if (!preferred && !fallback) {
    return undefined;
  }
  if (preferred && !fallback) {
    return preferred;
  }
  if (!preferred && fallback) {
    return fallback;
  }

  const token = preferred?.token ?? fallback?.token;
  const risk = mergeRiskContext(preferred?.risk, fallback?.risk);
  const signal = preferred?.signal ?? fallback?.signal;
  const marketNarrative = preferred?.marketNarrative ?? fallback?.marketNarrative;
  const sourceSkills = dedupe([...(fallback?.sourceSkills ?? []), ...(preferred?.sourceSkills ?? [])]);

  if (!token && !risk && !signal && !marketNarrative && sourceSkills.length === 0) {
    return undefined;
  }

  return {
    token,
    risk,
    signal,
    marketNarrative,
    sourceSkills,
  };
}

export function composeFirstBatchArbitrageAdapterContexts(
  input: FirstBatchArbitrageAdapterInputs | undefined,
): FirstBatchArbitrageAdapterComposition {
  if (!input) {
    return {};
  }

  const marketContext = normalizeSpotMarketContext(input.market?.spot);
  const readinessContext = normalizeAssetsReadinessContext(input.readiness?.assets);
  const tokenInfoContext = normalizeTokenInfoEnrichment(input.enrichment?.tokenInfo);
  const tokenAuditContext = normalizeTokenAuditEnrichment(input.enrichment?.tokenAudit);
  const enrichmentContext = mergeNormalizedEnrichmentContexts(tokenInfoContext, tokenAuditContext);

  const required = dedupe(
    [marketContext?.sourceSkill, readinessContext?.sourceSkill].filter((skill): skill is string => Boolean(skill)),
  );
  const enrichment = dedupe(enrichmentContext?.sourceSkills ?? []);
  const hasAdapterOutputs = Boolean(marketContext || readinessContext || enrichmentContext);

  return {
    marketContext,
    readinessContext,
    enrichmentContext,
    skillUsagePatch: {
      required,
      enrichment,
      metadata: hasAdapterOutputs
        ? {
            source: "runtime",
            notes: "first-batch adapter composition (spot/assets/token-info/token-audit)",
          }
        : undefined,
    },
  };
}
