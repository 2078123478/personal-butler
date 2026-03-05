import type { GateCheck, RiskPolicy } from "../types";

interface CircuitBreakInput {
  consecutiveFailures: number;
  dailyNetUsd: number;
  balanceUsd: number;
  permissionFailures24h: number;
  rejectRate24h: number;
  avgLatencyMs24h: number;
  avgSlippageDeviationBps24h: number;
}

export class RiskEngine {
  constructor(private readonly policy: RiskPolicy) {}

  canPromoteToLive(input: GateCheck): { passed: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (!input.liveEnabled) {
      reasons.push("LIVE_ENABLED is false");
    }
    if (input.simulationNetUsd24h <= 0) {
      reasons.push("simulation net in last 24h must be > 0");
    }
    if (input.simulationWinRate24h < 0.55) {
      reasons.push("simulation win rate in last 24h must be >= 55%");
    }
    if (input.consecutiveFailures >= this.policy.maxConsecutiveFailures) {
      reasons.push("consecutive failures exceeded threshold");
    }
    if (input.permissionFailures24h > 0) {
      reasons.push("permission failures in last 24h must be 0");
    }
    if (input.rejectRate24h > 0.4) {
      reasons.push("reject rate in last 24h must be <= 40%");
    }
    if (input.avgLatencyMs24h > 3500) {
      reasons.push("average latency in last 24h must be <= 3500ms");
    }
    if (input.avgSlippageDeviationBps24h > 45) {
      reasons.push("average slippage deviation in last 24h must be <= 45bps");
    }
    return { passed: reasons.length === 0, reasons };
  }

  shouldCircuitBreak(input: CircuitBreakInput): { breakNow: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (input.consecutiveFailures >= this.policy.maxConsecutiveFailures) {
      reasons.push("max consecutive failures hit");
    }
    if (input.dailyNetUsd < 0 && Math.abs(input.dailyNetUsd) > input.balanceUsd * this.policy.maxDailyLossPct) {
      reasons.push("max daily loss threshold exceeded");
    }
    if (input.permissionFailures24h >= 2) {
      reasons.push("permission failures exceeded threshold");
    }
    if (input.rejectRate24h > 0.6) {
      reasons.push("reject rate exceeded threshold");
    }
    if (input.avgLatencyMs24h > 5000) {
      reasons.push("average latency exceeded threshold");
    }
    if (input.avgSlippageDeviationBps24h > 80) {
      reasons.push("average slippage deviation exceeded threshold");
    }
    return { breakNow: reasons.length > 0, reasons };
  }

  maxNotional(balanceUsd: number): number {
    return Math.max(0, balanceUsd * this.policy.maxTradePctBalance);
  }
}
