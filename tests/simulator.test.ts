import { describe, expect, it } from "vitest";
import { Simulator } from "../src/skills/alphaos/runtime/simulator";

describe("Simulator", () => {
  it("applies dual-leg realistic costs and risk fields", () => {
    const simulator = new Simulator({
      slippageBps: 10,
      takerFeeBps: 20,
      gasUsdDefault: 1,
      mevPenaltyBps: 5,
      liquidityUsdDefault: 1_000_000,
      volatilityDefault: 0,
      avgLatencyMsDefault: 100,
    });

    const result = simulator.estimate(
      {
        opportunityId: "opp-1",
        strategyId: "dex-arbitrage",
        pair: "ETH/USDC",
        buyDex: "a",
        sellDex: "b",
        buyPrice: 100,
        sellPrice: 101.4,
        notionalUsd: 1000,
      },
      "paper",
      {
        minNetEdgeBpsPaper: 45,
        minNetEdgeBpsLive: 60,
        maxTradePctBalance: 0.03,
        maxDailyLossPct: 0.015,
        maxConsecutiveFailures: 3,
      },
    );

    expect(result.grossUsd).toBeCloseTo(14, 6);
    expect(result.feeUsd).toBeCloseTo(7.3032455532, 6);
    expect(result.netUsd).toBeCloseTo(6.6967544468, 6);
    expect(result.netEdgeBps).toBeCloseTo(66.967544468, 6);
    expect(result.latencyAdjustedNetUsd).toBeCloseTo(6.3821343613, 5);
    expect(result.pFail).toBeGreaterThan(0);
    expect(result.pFail).toBeLessThan(1);
    expect(result.expectedShortfall).toBeGreaterThan(0);
    expect(result.pass).toBe(true);
  });
});
