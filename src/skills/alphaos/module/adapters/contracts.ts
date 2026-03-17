export interface AdapterProviderEnvelope<TPayload = Record<string, unknown>> {
  sourceSkill?: string;
  payload?: TPayload;
  rawUpstream?: unknown;
}

export interface SpotMarketAdapterPayload {
  pair?: string;
  venue?: string;
  bid?: number | string;
  ask?: number | string;
  gasUsd?: number | string;
  quoteTs?: string;
  chainId?: number | string;
  marketType?: string;
  alphaContext?: boolean | string;
}

export interface SpotMarketAdapterInput {
  request?: Partial<SpotMarketAdapterPayload>;
  provider?: AdapterProviderEnvelope<SpotMarketAdapterPayload>;
  internal?: Partial<SpotMarketAdapterPayload>;
}

export interface AssetsReadinessAdapterPayload {
  accountScope?: string;
  availableNotionalUsd?: number | string;
  requiredNotionalUsd?: number | string;
  balanceReady?: boolean | string;
  baseAssetReady?: boolean | string;
  quoteAssetReady?: boolean | string;
}

export interface AssetsReadinessAdapterInput {
  request?: Partial<AssetsReadinessAdapterPayload>;
  provider?: AdapterProviderEnvelope<AssetsReadinessAdapterPayload>;
  internal?: Partial<AssetsReadinessAdapterPayload>;
}

export interface TokenInfoAdapterPayload {
  name?: string;
  symbol?: string;
  chainId?: number | string;
  contractAddress?: string;
}

export interface TokenInfoAdapterInput {
  request?: Partial<TokenInfoAdapterPayload>;
  provider?: AdapterProviderEnvelope<TokenInfoAdapterPayload>;
  internal?: Partial<TokenInfoAdapterPayload>;
}

export type AdapterRiskLevel = "low" | "normal" | "high" | "unknown";

export interface TokenAuditAdapterPayload {
  tokenRisk?: AdapterRiskLevel | string;
  auditFlags?: string[];
  addressRiskLevel?: AdapterRiskLevel | string;
  blocked?: boolean | string;
}

export interface TokenAuditAdapterInput {
  request?: Partial<TokenAuditAdapterPayload>;
  provider?: AdapterProviderEnvelope<TokenAuditAdapterPayload>;
  internal?: Partial<TokenAuditAdapterPayload>;
}

export interface FirstBatchMarketAdapterInputs {
  spot?: SpotMarketAdapterInput;
  alpha?: AdapterProviderEnvelope;
}

export interface FirstBatchReadinessAdapterInputs {
  assets?: AssetsReadinessAdapterInput;
}

export interface FirstBatchEnrichmentAdapterInputs {
  tokenInfo?: TokenInfoAdapterInput;
  tokenAudit?: TokenAuditAdapterInput;
}

export interface FirstBatchArbitrageAdapterInputs {
  market?: FirstBatchMarketAdapterInputs;
  readiness?: FirstBatchReadinessAdapterInputs;
  enrichment?: FirstBatchEnrichmentAdapterInputs;
}
