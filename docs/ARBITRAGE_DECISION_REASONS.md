# Arbitrage Decision Reasons

This document defines the normalized **reason-code taxonomy** for the Arbitrage Module.

The purpose is to make decisions:

- consistent
- explainable
- easy to analyze
- easy to surface in UI, logs, reports, and demos

A good arbitrage module should not only say what it did.
It should also say **why**.

---

## 1. Design goals

The reason taxonomy should:

1. normalize free-form internal messages into stable external codes
2. support both positive and negative explanations
3. work across discovery, enrichment, validation, simulation, and execution
4. be readable by both machines and humans

---

## 2. Reason-code usage rules

### Rule 1 — always include at least one reason code

Every meaningful module decision should carry:

- at least one `reasonCode`
- a short human-readable summary

### Rule 2 — separate supporting vs blocking reasons when useful

Recommended shape:

```json
{
  "reasonCodes": ["simulation_profitable", "balance_ready"],
  "blockingReasonCodes": []
}
```

or

```json
{
  "reasonCodes": ["spread_detected"],
  "blockingReasonCodes": ["quote_stale", "audit_flagged"]
}
```

### Rule 3 — prefer stable codes over sentence fragments

Good:

- `simulation_profitable`
- `liquidity_too_low`
- `execution_backend_unready`

Avoid using raw English sentences as canonical codes.

### Rule 4 — keep summary text separate

Codes are for consistency.
Summary text is for humans.
Do not overload codes with narrative.

---

## 3. Reason categories

Reason codes are grouped into seven categories:

1. discovery
2. enrichment
3. validation
4. simulation
5. decision / policy
6. execution
7. reporting / distribution

---

## 4. Discovery reasons

These explain why a candidate entered the pipeline.

| Code | Meaning |
|------|---------|
| `spread_detected` | a raw spread or mismatch was detected |
| `spread_above_threshold` | raw spread exceeded configured threshold |
| `candidate_ranked_high` | candidate ranked highly in discovery session |
| `signal_supported_candidate` | external signal increased candidate priority |
| `market_rank_selected` | candidate entered scan scope due to ranking input |
| `event_driven_candidate` | candidate entered scope due to event-driven source |

### Typical usage

- discovery reports
- initial candidate cards
- operator scan summaries

---

## 5. Enrichment reasons

These explain what context was attached to a candidate.

| Code | Meaning |
|------|---------|
| `token_info_attached` | token metadata enrichment succeeded |
| `token_audit_attached` | token audit context was added |
| `address_intel_attached` | address-level intelligence was added |
| `balance_context_attached` | account / balance context was added |
| `signal_context_attached` | signal context was added |
| `chain_context_attached` | chain / venue context was added |

### Positive enrichments

These are usually supportive rather than decisive.
They make the candidate more explainable.

---

## 6. Validation reasons — positive

These explain why the candidate passed rule checks.

| Code | Meaning |
|------|---------|
| `net_edge_above_threshold` | expected net edge met configured requirement |
| `liquidity_sufficient` | liquidity was sufficient for planned notional |
| `quote_fresh` | quote freshness was within allowed range |
| `balance_ready` | sufficient balance or account readiness confirmed |
| `audit_clear` | token audit did not produce a blocking signal |
| `address_risk_acceptable` | address intelligence did not produce a blocking signal |
| `execution_backend_ready` | backend readiness checks passed |
| `risk_policy_passed` | candidate passed risk-policy checks |
| `mode_allowed` | candidate is valid for the requested mode |

---

## 7. Validation reasons — blocking

These explain why a candidate was blocked before simulation or execution.

| Code | Meaning |
|------|---------|
| `spread_below_threshold` | spread was below configured threshold |
| `net_edge_below_threshold` | expected net edge was too low |
| `liquidity_too_low` | liquidity insufficient for desired notional |
| `quote_stale` | quote freshness outside allowed range |
| `balance_insufficient` | not enough balance or account readiness failed |
| `audit_flagged` | token audit produced a blocking signal |
| `address_risk_high` | address intelligence produced a blocking signal |
| `execution_backend_unready` | backend readiness did not pass |
| `risk_policy_failed` | risk policy blocked the candidate |
| `candidate_expired` | candidate was too old or opportunity window closed |
| `mode_not_allowed` | requested mode not permitted |

---

## 8. Simulation reasons — positive

These explain why simulation supports the candidate.

| Code | Meaning |
|------|---------|
| `simulation_completed` | simulation was successfully run |
| `simulation_profitable` | post-cost simulation remained profitable |
| `latency_risk_within_bounds` | latency-adjusted risk remained within threshold |
| `expected_shortfall_acceptable` | expected shortfall remained within policy |
| `failure_probability_acceptable` | estimated failure probability was acceptable |

---

## 9. Simulation reasons — blocking

These explain why simulation blocked the candidate.

| Code | Meaning |
|------|---------|
| `simulation_failed` | simulation failed to run or validate |
| `simulation_unprofitable` | post-cost simulation was not profitable enough |
| `latency_risk_too_high` | latency-adjusted risk too high |
| `expected_shortfall_too_high` | expected shortfall exceeded tolerance |
| `failure_probability_too_high` | failure probability exceeded tolerance |
| `invalid_execution_price` | simulation input prices were invalid |

---

## 10. Decision / policy reasons

These explain final routing or policy-level decisions.

| Code | Meaning |
|------|---------|
| `monitor_only` | candidate should be watched but not acted on |
| `paper_mode_selected` | candidate routed to paper mode |
| `approval_required` | live action requires approval |
| `auto_execute_allowed` | policy allows direct execution |
| `degraded_to_paper` | requested live path downgraded to paper |
| `daily_loss_cap_reached` | policy blocked action due to loss cap |
| `too_many_recent_failures` | policy blocked action due to recent failures |
| `live_gate_failed` | live-mode gate did not pass |
| `live_gate_passed` | live-mode gate passed |

---

## 11. Execution reasons — positive

These explain successful or acceptable execution outcomes.

| Code | Meaning |
|------|---------|
| `execution_started` | execution was initiated |
| `execution_submitted` | execution submitted successfully |
| `execution_confirmed` | execution confirmed successfully |
| `paper_execution_recorded` | paper path completed and was recorded |
| `trade_recorded` | result successfully persisted |
| `notification_sent` | result notification was emitted |

---

## 12. Execution reasons — blocking or failure

These explain execution failures or downgrades.

| Code | Meaning |
|------|---------|
| `execution_failed` | execution failed |
| `permission_denied` | permissions blocked execution |
| `whitelist_restricted` | execution limited by whitelist |
| `network_error` | execution failed due to network condition |
| `validation_error` | execution request failed validation |
| `unknown_execution_error` | execution failed with unknown error |
| `trade_record_failed` | result could not be recorded properly |
| `notification_failed` | result notification failed |

---

## 13. Reporting and distribution reasons

These explain post-execution reporting and social distribution outcomes.

| Code | Meaning |
|------|---------|
| `summary_generated` | operator/judge summary was produced |
| `share_card_generated` | shareable card was produced |
| `square_post_prepared` | content prepared for Binance Square |
| `square_post_published` | content posted successfully |
| `distribution_skipped` | distribution intentionally skipped |
| `distribution_failed` | distribution attempted but failed |

---

## 14. Decision-to-reason expectations

Recommended minimal reason sets by decision class:

### `reject`

Should usually include:

- one positive context reason if available
- at least one blocking reason

Examples:

- `spread_detected` + `net_edge_below_threshold`
- `token_info_attached` + `audit_flagged`

### `monitor`

Should usually include:

- `spread_detected`
- one or two “not enough yet” reasons such as:
  - `quote_stale`
  - `signal_context_attached`
  - `monitor_only`

### `simulate_only`

Should include:

- validation success reason(s)
- simulation-related reason(s)

### `paper_trade`

Should include:

- validation success reason(s)
- `simulation_profitable`
- `paper_mode_selected` or `degraded_to_paper`

### `propose_execution`

Should include:

- strong validation success reasons
- `simulation_profitable`
- `approval_required`

### `execute`

Should include:

- strong validation and simulation reasons
- `auto_execute_allowed`
- execution status reasons as available

---

## 15. Suggested mapping from current internal strings

These mappings are approximate and should be implemented in a thin adapter layer.

| Current message pattern | Suggested normalized code |
|-------------------------|---------------------------|
| `net edge ... below threshold` | `net_edge_below_threshold` |
| `net edge ... bps` | `net_edge_above_threshold` |
| `risk-adjusted net edge ... passed` | `simulation_profitable` |
| `risk-adjusted net edge ... below` | `simulation_unprofitable` |
| `invalid opportunity price` | `invalid_execution_price` |
| `invalid quote price` | `invalid_execution_price` |
| `missing fresh quotes` | `quote_stale` |
| `risk policy blocked execution` | `risk_policy_failed` |
| `LIVE_ENABLED is false` | `live_gate_failed` |
| `simulation win rate ... must be >=` | `live_gate_failed` |
| `permission failures ... must be 0` | `permission_denied` or `live_gate_failed` depending stage |
| `consecutive failures exceeded threshold` | `too_many_recent_failures` |

---

## 16. Recommended response shape

A typical module response should look like:

```json
{
  "decision": "paper_trade",
  "reasonCodes": [
    "spread_above_threshold",
    "balance_ready",
    "simulation_profitable",
    "paper_mode_selected"
  ],
  "blockingReasonCodes": [],
  "summary": "Candidate passed validation and remained profitable after simulation, so it was accepted for paper execution."
}
```

---

## 17. Recommended implementation order

1. freeze this reason taxonomy in docs
2. add normalization helper(s)
3. map current evaluate / simulate / risk / execute outputs to normalized reasons
4. expose reasons in candidate cards, module responses, and demo outputs
5. later add analytics and filtering on top

---

## 18. One-sentence summary

**The Arbitrage Decision Reasons taxonomy turns free-form engine messages into stable, reusable codes so the module can explain discovery, validation, simulation, policy, execution, and reporting outcomes consistently across docs, UI, logs, and demos.**
