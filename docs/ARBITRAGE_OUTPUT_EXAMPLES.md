# Arbitrage Output Examples

This document provides example output shapes for the Arbitrage Module.

Goal:

> make the contract concrete so future API, UI, demo, and adapter work all point to the same output language.

These examples are product-facing reference payloads.
They are not strict implementation snapshots.

---

## 1. Why example outputs matter

A strategy module becomes easier to build when everyone can see:

- what a rejected candidate should look like
- what a paper-trade decision should look like
- what a proposed execution should look like
- what a safe downgrade should look like

Without examples, contracts stay abstract.
With examples, implementation and demo work stay aligned.

---

## 2. Conventions used below

### Top-level fields

All examples use a shared top-level pattern:

- `module`
- `requestId`
- `mode`
- `status`
- `decision`
- `candidate`
- `simulation`
- `execution`
- `summary`
- `skillUsage`

### Reason usage

Examples show:

- `reasonCodes`
- `blockingReasonCodes`

### Skill attribution

Examples separate:

- `required`
- `enrichment`
- `distribution`

---

## 3. Example A — rejected candidate

### Scenario

A spread was detected, but the candidate failed validation because expected net edge was too low after enrichment and readiness checks.

```json
{
  "module": "arbitrage",
  "requestId": "req_reject_001",
  "mode": "paper",
  "status": "candidate_rejected",
  "decision": "reject",
  "candidate": {
    "candidateId": "cand_001",
    "module": "arbitrage",
    "status": "rejected",
    "opportunityType": "dex_spread",
    "pair": "ETH/USDC",
    "buyVenue": "dex-a",
    "sellVenue": "dex-b",
    "detectedAt": "2026-03-17T01:00:00.000Z",
    "metrics": {
      "grossEdgeBps": 41.2,
      "expectedNetEdgeBps": 18.6,
      "expectedNetUsd": 1.86,
      "notionalUsd": 1000,
      "liquidityUsd": 110000,
      "avgLatencyMs": 320
    },
    "context": {
      "chainId": 56,
      "tokenRisk": "normal",
      "balanceReady": true,
      "quoteFreshnessMs": 360
    },
    "reasonCodes": [
      "spread_detected",
      "token_info_attached",
      "balance_ready"
    ],
    "blockingReasonCodes": [
      "net_edge_below_threshold"
    ],
    "skillSources": [
      "binance/spot",
      "binance/assets",
      "binance-web3/query-token-info"
    ]
  },
  "simulation": null,
  "execution": null,
  "summary": {
    "headline": "Candidate rejected before simulation.",
    "explanation": "A raw spread was detected, but expected net edge was too low after validation, so the module rejected the opportunity."
  },
  "skillUsage": {
    "required": [
      "binance/spot",
      "binance/assets"
    ],
    "enrichment": [
      "binance-web3/query-token-info"
    ],
    "distribution": []
  }
}
```

---

## 4. Example B — accepted for paper trade

### Scenario

The candidate passed validation and remained profitable after simulation, so it was accepted for paper execution.

```json
{
  "module": "arbitrage",
  "requestId": "req_paper_001",
  "mode": "paper",
  "status": "candidate_accepted",
  "decision": "paper_trade",
  "candidate": {
    "candidateId": "cand_002",
    "module": "arbitrage",
    "status": "simulated",
    "opportunityType": "dex_spread",
    "pair": "BTC/USDC",
    "buyVenue": "dex-a",
    "sellVenue": "dex-b",
    "detectedAt": "2026-03-17T01:10:00.000Z",
    "metrics": {
      "grossEdgeBps": 108.4,
      "expectedNetEdgeBps": 72.1,
      "expectedNetUsd": 7.21,
      "notionalUsd": 1000,
      "liquidityUsd": 320000,
      "avgLatencyMs": 270
    },
    "context": {
      "chainId": 56,
      "tokenRisk": "normal",
      "balanceReady": true,
      "signalSupport": true,
      "quoteFreshnessMs": 250
    },
    "reasonCodes": [
      "spread_above_threshold",
      "token_info_attached",
      "audit_clear",
      "balance_ready",
      "simulation_profitable"
    ],
    "blockingReasonCodes": [],
    "skillSources": [
      "binance/spot",
      "binance/assets",
      "binance-web3/query-token-info",
      "binance-web3/query-token-audit",
      "binance-web3/trading-signal"
    ]
  },
  "simulation": {
    "status": "pass",
    "summary": "Expected net remained positive after cost and latency adjustment.",
    "metrics": {
      "grossUsd": 10.84,
      "feeUsd": 2.11,
      "netUsd": 8.73,
      "netEdgeBps": 87.3,
      "latencyAdjustedNetUsd": 7.21,
      "expectedShortfall": 1.52,
      "pFail": 0.09
    },
    "reasonCodes": [
      "simulation_completed",
      "simulation_profitable",
      "latency_risk_within_bounds"
    ]
  },
  "execution": {
    "requestedMode": "paper",
    "effectiveMode": "paper",
    "degradedToPaper": false,
    "status": "completed",
    "tradeStatus": "confirmed",
    "txHash": "paper-cand_002",
    "summary": "Paper execution completed successfully.",
    "reasonCodes": [
      "paper_mode_selected",
      "paper_execution_recorded",
      "trade_recorded"
    ]
  },
  "summary": {
    "headline": "Arbitrage candidate accepted for paper trade.",
    "explanation": "The module detected a viable spread, enriched it with token and risk context, confirmed readiness, and accepted it after profitable simulation."
  },
  "skillUsage": {
    "required": [
      "binance/spot",
      "binance/assets"
    ],
    "enrichment": [
      "binance-web3/query-token-info",
      "binance-web3/query-token-audit",
      "binance-web3/trading-signal"
    ],
    "distribution": []
  }
}
```

---

## 5. Example C — propose execution (approval required)

### Scenario

The candidate is strong enough for live consideration, but policy requires human approval.

```json
{
  "module": "arbitrage",
  "requestId": "req_propose_001",
  "mode": "assisted-live",
  "status": "candidate_ready_for_approval",
  "decision": "propose_execution",
  "candidate": {
    "candidateId": "cand_003",
    "module": "arbitrage",
    "status": "approved",
    "opportunityType": "dex_spread",
    "pair": "BNB/USDT",
    "buyVenue": "dex-a",
    "sellVenue": "dex-b",
    "detectedAt": "2026-03-17T01:20:00.000Z",
    "metrics": {
      "grossEdgeBps": 126.3,
      "expectedNetEdgeBps": 85.4,
      "expectedNetUsd": 12.81,
      "notionalUsd": 1500,
      "liquidityUsd": 450000,
      "avgLatencyMs": 240
    },
    "context": {
      "chainId": 56,
      "tokenRisk": "normal",
      "balanceReady": true,
      "signalSupport": true,
      "quoteFreshnessMs": 190
    },
    "reasonCodes": [
      "spread_above_threshold",
      "audit_clear",
      "balance_ready",
      "risk_policy_passed",
      "simulation_profitable",
      "approval_required"
    ],
    "blockingReasonCodes": [],
    "skillSources": [
      "binance/spot",
      "binance/assets",
      "binance-web3/query-token-info",
      "binance-web3/query-token-audit"
    ]
  },
  "simulation": {
    "status": "pass",
    "summary": "Simulation remained profitable and policy-aligned.",
    "metrics": {
      "grossUsd": 18.95,
      "feeUsd": 3.22,
      "netUsd": 15.73,
      "netEdgeBps": 104.9,
      "latencyAdjustedNetUsd": 12.81,
      "expectedShortfall": 2.92,
      "pFail": 0.07
    },
    "reasonCodes": [
      "simulation_completed",
      "simulation_profitable",
      "expected_shortfall_acceptable"
    ]
  },
  "execution": {
    "requestedMode": "assisted-live",
    "effectiveMode": "assisted-live",
    "degradedToPaper": false,
    "status": "awaiting_approval",
    "tradeStatus": "pending",
    "txHash": null,
    "summary": "Candidate prepared for live execution but requires approval.",
    "reasonCodes": [
      "approval_required"
    ]
  },
  "summary": {
    "headline": "Candidate proposed for assisted-live execution.",
    "explanation": "The candidate passed validation and simulation strongly enough to be proposed, but policy requires approval before execution."
  },
  "skillUsage": {
    "required": [
      "binance/spot",
      "binance/assets"
    ],
    "enrichment": [
      "binance-web3/query-token-info",
      "binance-web3/query-token-audit"
    ],
    "distribution": []
  }
}
```

---

## 6. Example D — requested live but degraded to paper

### Scenario

The user requested live execution, but the backend or policy gate caused a safe downgrade to paper.

```json
{
  "module": "arbitrage",
  "requestId": "req_degrade_001",
  "mode": "live",
  "status": "candidate_executed_with_downgrade",
  "decision": "paper_trade",
  "candidate": {
    "candidateId": "cand_004",
    "module": "arbitrage",
    "status": "executed",
    "opportunityType": "dex_spread",
    "pair": "ETH/USDT",
    "buyVenue": "dex-a",
    "sellVenue": "dex-b",
    "detectedAt": "2026-03-17T01:30:00.000Z",
    "metrics": {
      "grossEdgeBps": 112.0,
      "expectedNetEdgeBps": 69.4,
      "expectedNetUsd": 6.94,
      "notionalUsd": 1000,
      "liquidityUsd": 280000,
      "avgLatencyMs": 310
    },
    "context": {
      "chainId": 56,
      "tokenRisk": "normal",
      "balanceReady": true,
      "quoteFreshnessMs": 220
    },
    "reasonCodes": [
      "spread_above_threshold",
      "balance_ready",
      "simulation_profitable",
      "degraded_to_paper"
    ],
    "blockingReasonCodes": [
      "execution_backend_unready"
    ],
    "skillSources": [
      "binance/spot",
      "binance/assets",
      "binance-web3/query-token-info"
    ]
  },
  "simulation": {
    "status": "pass",
    "summary": "Simulation passed, but live readiness gate did not.",
    "metrics": {
      "grossUsd": 11.2,
      "feeUsd": 2.36,
      "netUsd": 8.84,
      "netEdgeBps": 88.4,
      "latencyAdjustedNetUsd": 6.94,
      "expectedShortfall": 1.9,
      "pFail": 0.1
    },
    "reasonCodes": [
      "simulation_completed",
      "simulation_profitable"
    ]
  },
  "execution": {
    "requestedMode": "live",
    "effectiveMode": "paper",
    "degradedToPaper": true,
    "status": "completed",
    "tradeStatus": "confirmed",
    "txHash": "paper-cand_004",
    "summary": "Live execution was requested but safely downgraded to paper due to backend readiness policy.",
    "reasonCodes": [
      "degraded_to_paper",
      "live_gate_failed",
      "paper_execution_recorded"
    ]
  },
  "summary": {
    "headline": "Candidate executed in paper mode after live downgrade.",
    "explanation": "The opportunity remained valid, but the system downgraded the requested live path to paper to preserve safety and repeatability."
  },
  "skillUsage": {
    "required": [
      "binance/spot",
      "binance/assets"
    ],
    "enrichment": [
      "binance-web3/query-token-info"
    ],
    "distribution": []
  }
}
```

---

## 7. Example E — successful ecosystem-facing summary package

### Scenario

A paper-validated result is turned into a shareable ecosystem-facing summary.

```json
{
  "module": "arbitrage",
  "requestId": "req_share_001",
  "mode": "paper",
  "status": "summary_prepared",
  "decision": "paper_trade",
  "summary": {
    "headline": "BNB Chain arbitrage candidate paper-validated.",
    "explanation": "The module detected a BNB Chain opportunity, enriched it with token and readiness context, and kept positive expected net after simulation."
  },
  "distribution": {
    "distributionTarget": "binance-square",
    "ready": true,
    "shareableText": "Paper-validated a BNB Chain arbitrage candidate after token, readiness, and simulation checks. Strategy layer > raw spread.",
    "reasonCodes": [
      "summary_generated",
      "share_card_generated",
      "square_post_prepared"
    ]
  },
  "skillUsage": {
    "required": [
      "binance/spot",
      "binance/assets"
    ],
    "enrichment": [
      "binance-web3/query-token-info",
      "binance-web3/query-token-audit"
    ],
    "distribution": [
      "binance/square-post"
    ]
  }
}
```

---

## 8. Recommended minimum response for MVP

If implementation time is tight, the minimum response that still feels credible should include:

- `module`
- `mode`
- `status`
- `decision`
- `candidate.pair`
- `candidate.reasonCodes`
- `candidate.blockingReasonCodes`
- `summary.headline`
- `skillUsage.required`
- `skillUsage.enrichment`

That is enough to support:

- demos
- UI cards
- logs
- future adapters

---

## 9. One-sentence summary

**These output examples make the Arbitrage Module contract tangible by showing how rejection, paper acceptance, approval-gated execution, safe downgrade, and ecosystem-facing summary flows should look in a product-ready response shape.**
