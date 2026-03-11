---
name: discovery
description: Multi-strategy opportunity discovery engine for DEX pair scanning. Use when implementing discovery sessions, adding discovery strategies (spread-threshold, mean-reversion, volatility-breakout), generating discovery reports, or approving discovered candidates for execution.
---

# Discovery Skill

Autonomous market scanning engine that runs time-bounded sessions to find actionable DEX opportunities using pluggable statistical strategies.

## Code Location

All runtime code lives in `src/skills/alphaos/runtime/discovery/`. Key files:

- `discovery-engine.ts` — session lifecycle, tick loop, candidate ranking
- `report-builder.ts` — generates structured reports with charts and summaries
- `strategies/types.ts` — strategy interface + shared math utilities (mean, stdDev, percentileRank)
- `strategies/spread-threshold.ts` — static threshold strategy
- `strategies/mean-reversion.ts` — z-score based mean reversion
- `strategies/volatility-breakout.ts` — volatility ratio breakout

## Core Concepts

**Session**: a time-bounded scan across one or more pairs with a chosen strategy. Produces ranked candidates.

**Candidate**: a discovered opportunity with pair, strategy scores, expected edge, and approval status.

**Report**: aggregated session results — top candidates, spread charts, summary stats.

## Workflow

```
start session → tick loop (sample quotes → compute spread/vol/z-score → evaluate strategy → store candidates) → build report → approve candidate → execute via alpha engine
```

## API Endpoints

```
POST /api/v1/discovery/start     — start a new session
GET  /api/v1/discovery/sessions  — list sessions
GET  /api/v1/discovery/report/:id — get session report
POST /api/v1/discovery/approve   — approve candidate for execution
```

## CLI (via agent-comm)

A remote peer can trigger discovery:

```bash
# Request peer to run discovery
agent-comm:send start_discovery <peerId> \
  --strategy-id spread-threshold \
  --pairs ETH/USDC,WBTC/USDC \
  --duration-minutes 30 \
  --top-n 5
```

## Strategies

### spread-threshold
Static threshold: flag when `spreadBps > minSpreadBps` and expected net is positive after costs.

Best for: stable pairs with predictable spreads.

### mean-reversion
Z-score based: flag when spread deviates significantly from rolling mean (`|z| > zEnter`).

Best for: pairs that oscillate around a mean spread.

### volatility-breakout
Volatility ratio: flag when current volatility exceeds historical baseline (`volRatio > volRatioMin`).

Best for: detecting regime changes and breakout opportunities.

### Strategy Interface

```typescript
interface DiscoveryStrategy {
  id: DiscoveryStrategyId;
  evaluate(ctx: DiscoveryStrategyContext): Omit<DiscoveryCandidate, "id" | "status"> | null;
}

interface DiscoveryStrategyContext {
  pair: string;
  quotes: Quote[];
  historySpreads: number[];
  spreadBps: number;
  dynamicThresholdBps: number;
  expectedNetBpsBase: number;
  expectedNetUsdBase: number;
  // ... session config, timestamps
}
```

Return a candidate object to flag an opportunity, or `null` to skip.

## Configuration

Key parameters in `DiscoveryEngineOptions`:

| Param | Default | Purpose |
|-------|---------|---------|
| `dexes` | `[dexA, dexB]` | DEX pair to compare |
| `defaultDurationMinutes` | — | Session length |
| `defaultSampleIntervalSec` | — | Quote polling interval |
| `defaultTopN` | — | Max candidates per report |
| `lookbackSamples` | — | Rolling window for stats |
| `zEnter` | — | Z-score threshold (mean-reversion) |
| `volRatioMin` | — | Volatility ratio threshold (breakout) |
| `minSpreadBps` | — | Minimum spread (spread-threshold) |
| `notionalUsd` | — | Notional size for cost estimation |
| `takerFeeBps` | — | Taker fee estimate |
| `slippageBps` | — | Slippage estimate |

## Extension Points

- Add new strategy: create file in `strategies/`, implement `DiscoveryStrategy` interface, register in `discovery-engine.ts` constructor
- Custom cost model: modify cost params in options or plug into `cost-model.ts`
- External data sources: extend `DiscoveryStrategyContext` with additional market data

## Demo

```bash
npm run demo:discovery    # runs discovery-demo.sh → outputs to demo-output/
```

## Docs

- `docs/OPENCLAW_DISCOVERY_PLAYBOOK.md` — OpenClaw integration for discovery orchestration
- `docs/ALGORITHM.md` — algorithm details (Chinese)
