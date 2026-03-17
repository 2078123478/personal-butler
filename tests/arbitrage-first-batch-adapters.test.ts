import { describe, expect, it } from "vitest";
import {
  composeFirstBatchArbitrageAdapterContexts,
  normalizeAssetsReadinessContext,
  normalizeSpotMarketContext,
  normalizeTokenAuditEnrichment,
  normalizeTokenInfoEnrichment,
} from "../src/skills/alphaos/module/adapters";

describe("arbitrage first-batch adapters", () => {
  it("normalizes market context from binance/spot payloads", () => {
    const marketContext = normalizeSpotMarketContext({
      request: {
        pair: "ETH/USDC",
      },
      provider: {
        sourceSkill: "binance/spot",
        payload: {
          pair: "ETH/USDC",
          bid: "2048.1",
          ask: "2048.6",
          gasUsd: "1.2",
          quoteTs: "2026-03-17T01:00:00.000Z",
          chainId: "56",
        },
      },
    });

    expect(marketContext).toEqual({
      pair: "ETH/USDC",
      venue: "binance-spot",
      bid: 2048.1,
      ask: 2048.6,
      gasUsd: 1.2,
      quoteTs: "2026-03-17T01:00:00.000Z",
      marketContext: {
        chainId: 56,
        marketType: "spot",
        alphaContext: false,
      },
      sourceSkill: "binance/spot",
    });
  });

  it("normalizes readiness from binance/assets and derives blocking state", () => {
    const readiness = normalizeAssetsReadinessContext({
      provider: {
        sourceSkill: "binance/assets",
        payload: {
          accountScope: "default",
          availableNotionalUsd: 850,
          requiredNotionalUsd: 1000,
          baseAssetReady: true,
          quoteAssetReady: false,
        },
      },
    });

    expect(readiness?.balanceReady).toBe(false);
    expect(readiness?.blocking).toBe(true);
    expect(readiness?.assetReadiness?.baseAssetReady).toBe(true);
    expect(readiness?.assetReadiness?.quoteAssetReady).toBe(false);
    expect(readiness?.sourceSkill).toBe("binance/assets");
  });

  it("normalizes token info and audit enrichment payloads", () => {
    const tokenInfo = normalizeTokenInfoEnrichment({
      provider: {
        sourceSkill: "binance-web3/query-token-info",
        payload: {
          name: "Wrapped Ether",
          symbol: "ETH",
          chainId: 56,
          contractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        },
      },
    });

    const tokenAudit = normalizeTokenAuditEnrichment({
      provider: {
        sourceSkill: "binance-web3/query-token-audit",
        payload: {
          tokenRisk: "critical",
          addressRiskLevel: "high",
          auditFlags: ["owner_can_mint"],
          blocked: true,
        },
      },
    });

    expect(tokenInfo?.token?.symbol).toBe("ETH");
    expect(tokenInfo?.sourceSkills).toEqual(["binance-web3/query-token-info"]);
    expect(tokenAudit?.risk?.tokenRisk).toBe("high");
    expect(tokenAudit?.risk?.auditFlags).toEqual(
      expect.arrayContaining(["owner_can_mint", "blocked_by_upstream_policy"]),
    );
    expect(tokenAudit?.sourceSkills).toEqual(["binance-web3/query-token-audit"]);
  });

  it("composes spot/assets/token-info/token-audit into normalized module contexts", () => {
    const composed = composeFirstBatchArbitrageAdapterContexts({
      market: {
        spot: {
          provider: {
            sourceSkill: "binance/spot",
            payload: {
              pair: "ETH/USDC",
              bid: 2048.1,
              ask: 2048.6,
              quoteTs: "2026-03-17T01:00:00.000Z",
              chainId: 56,
            },
          },
        },
      },
      readiness: {
        assets: {
          provider: {
            sourceSkill: "binance/assets",
            payload: {
              availableNotionalUsd: 2000,
              requiredNotionalUsd: 1000,
              baseAssetReady: true,
              quoteAssetReady: true,
            },
          },
        },
      },
      enrichment: {
        tokenInfo: {
          provider: {
            sourceSkill: "binance-web3/query-token-info",
            payload: {
              name: "Wrapped Ether",
              symbol: "ETH",
              chainId: 56,
            },
          },
        },
        tokenAudit: {
          provider: {
            sourceSkill: "binance-web3/query-token-audit",
            payload: {
              tokenRisk: "normal",
              auditFlags: [],
            },
          },
        },
      },
    });

    expect(composed.marketContext?.pair).toBe("ETH/USDC");
    expect(composed.readinessContext?.balanceReady).toBe(true);
    expect(composed.enrichmentContext?.token?.symbol).toBe("ETH");
    expect(composed.enrichmentContext?.risk?.tokenRisk).toBe("normal");
    expect(composed.enrichmentContext?.sourceSkills).toEqual(
      expect.arrayContaining(["binance-web3/query-token-info", "binance-web3/query-token-audit"]),
    );
    expect(composed.skillUsagePatch?.required).toEqual(
      expect.arrayContaining(["binance/spot", "binance/assets"]),
    );
    expect(composed.skillUsagePatch?.enrichment).toEqual(
      expect.arrayContaining(["binance-web3/query-token-info", "binance-web3/query-token-audit"]),
    );
  });
});
