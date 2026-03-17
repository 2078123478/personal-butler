# Arbitrage Implementation Gap

This document compares the **target arbitrage module framing** with the **current implementation reality**.

The goal is not to criticize the current codebase.
The goal is to answer one practical question:

> what already exists, what is missing, and what is the shortest path from the current `dex-arbitrage` runtime to a credible Binance Skills-compatible flagship module?

---

## 1. Executive summary

The current repository already has a strong execution core for an arbitrage product:

- strategy plugin structure
- opportunity scanning
- evaluation and planning
- simulation
- risk gating
- paper/live modes
- discovery sessions
- execution backend integration
- notification and reporting surfaces

What is **not** yet fully present is the product-facing layer that makes this feel like a Binance Skills-compatible strategy module.

The biggest gaps are not in raw execution.
The biggest gaps are in:

- compatibility adapters
- product-facing module contract output
- standardized decision reason taxonomy
- explicit enrichment stage
- demo-friendly surface and wording consistency

That is good news.
It means the repo already has a real engine, and the next step is mostly about **formalization, adapters, and packaging**, not rebuilding the system from scratch.

---

## 2. Current implementation strengths

## 2.1 Strategy plugin exists today

Current anchor:

- `src/skills/alphaos/plugins/dex-arbitrage.ts`

Already present:

- `scan()`
- `evaluate()`
- `plan()`

What this means:

- we already have a real strategy unit
- we are not inventing the arbitrage module from zero
- the module can be built by wrapping and extending an existing implementation

---

## 2.2 Engine orchestration already matches most of the desired flow

Current anchor:

- `src/skills/alphaos/engine/alpha-engine.ts`

Observed current flow:

- fetch quotes
- detect candidate opportunity
- evaluate candidate
- build plan
- simulate
- execute
- record
- notify

This is extremely close to the desired module framing:

```text
discover → enrich → validate → simulate → decide → execute → summarize
```

Gap:

- `enrich`
- explicit `decide` output layer
- product-facing `summarize` layer are not yet first-class module concepts

---

## 2.3 Risk gating is already real, not hand-wavy

Current anchor:

- `src/skills/alphaos/runtime/risk-engine.ts`

Already present:

- live promotion gates
- circuit breaker logic
- daily loss threshold logic
- latency, slippage, reject-rate related protections
- max notional logic based on risk policy

What this means:

- the system already has credible safety mechanics
- the docs should surface them more explicitly in product/module language

Gap:

- reason outputs are human-readable strings, but not yet normalized into a stable module reason-code taxonomy

---

## 2.4 Simulation is already a serious layer

Current anchor:

- `src/skills/alphaos/runtime/simulator.ts`

Already present:

- gross vs fee vs net modeling
- liquidity and volatility sensitivity
- latency-adjusted net value
- failure probability estimate
- expected shortfall estimate
- pass/fail based on policy thresholds

What this means:

- a strong demo can already truthfully claim “simulation before action”
- this is one of the project’s strongest assets

Gap:

- simulation outputs are not yet wrapped in a broader product-facing candidate / decision object

---

## 2.5 Discovery infrastructure already exists

Current anchors:

- `src/skills/alphaos/runtime/discovery/`
- `docs/OPENCLAW_DISCOVERY_PLAYBOOK.md`

Already present:

- discovery sessions
- candidate lists
- reports
- approval flow
- `paper` default
- hooks / milestone events

What this means:

- the “discover” half of the arbitrage product already has operational support
- the demo story does not need to be fabricated

Gap:

- discovery candidates are not yet explicitly framed as Binance Skills-enriched module candidates

---

## 3. Current implementation gaps

## 3.1 No formal official-skill compatibility adapter layer yet

Status:

- missing as a first-class implementation layer

Why it matters:

- current code can be strong and still fail the “Binance Skills-compatible” test if it cannot clearly show where official skills plug in

What is needed:

- adapter boundary for skill-derived market context
- adapter boundary for token / risk enrichment
- adapter boundary for balance / readiness enrichment
- optional distribution adapter

Recommended first step:

- implement docs + interface shims before deep code changes

Priority:

- **high**

---

## 3.2 No explicit enrichment stage yet

Status:

- partially present through metadata and quote-derived values
- not present as a dedicated stage

Why it matters:

- the target module story depends on “spread + context + safety + simulation”, not just spread detection

What is needed:

A first-class enrichment stage that can attach:

- token metadata
- token audit result
- balance readiness
- signal support
- chain / venue context

Recommended first step:

- add a module-facing enrichment object before altering strategy internals

Priority:

- **high**

---

## 3.3 No stable decision contract yet

Status:

- current code returns strong internal structures, but not a unified product-facing decision object

Examples of current internal outputs:

- `EvalResult`
- `SimulationResult`
- `TradeResult`
- discovery approve responses

Why it matters:

- demos, UI, partner explanations, and future module APIs need a stable output shape

What is needed:

- unified response contract
- canonical decision labels
- candidate lifecycle states
- explicit requested vs effective mode exposure

Priority:

- **high**

---

## 3.4 No standardized reason-code taxonomy yet

Status:

- missing

Current behavior:

- reasons are mostly free-form strings such as:
  - threshold-related messages
  - invalid price messages
  - gate failure messages

Why it matters:

- hard to compare outcomes consistently
- hard to build UI filters or analytics
- hard to make demos and partner explanations feel polished

What is needed:

- stable reason code taxonomy
- mapping layer from current free text to normalized codes

Priority:

- **high**

---

## 3.5 Product-layer vocabulary still trails implementation-layer vocabulary

Status:

- transition in progress

Examples:

- `alphaos`
- `onchainos`
- `dex-arbitrage`
- backend-first explanations

Why it matters:

- internally these names are fine
- externally they can obscure the actual product story

What is needed:

- keep implementation names true
- expose product-layer names consistently in docs, demo, and summaries

Priority:

- **medium**

---

## 3.6 No dedicated one-pager for arbitrage yet

Status:

- missing before this pass

Why it matters:

- spec, tasks, contract, mapping, and demo script help builders
- a one-pager helps judges, partners, and fast readers

What is needed:

- short ecosystem-facing arbitrage page
- 30-60 second read path

Priority:

- **medium**

---

## 3.7 No explicit Binance-Skill attribution in outputs yet

Status:

- missing

Why it matters:

- if we say the module is Binance Skills-compatible, outputs should show which upstream capability families contributed

What is needed:

Fields such as:

- `skillSources`
- `requiredSkillsUsed`
- `enrichmentSkillsUsed`
- `distributionSkillsUsed`

Priority:

- **medium-high**

---

## 4. Gap table

| Area | Current status | Gap severity | Suggested approach |
|------|----------------|--------------|--------------------|
| strategy core | present | low | reuse current plugin |
| engine orchestration | present | low | wrap with product vocabulary |
| risk engine | present | low | normalize outward-facing reasons |
| simulation | present | low | expose richer module output |
| discovery flow | present | low | connect to module lifecycle framing |
| enrichment stage | partial | high | add first-class enrichment object |
| official skill adapters | absent | high | start with adapter docs + interfaces |
| decision contract | absent | high | add product-facing response adapter |
| reason taxonomy | absent | high | define code set + mapping layer |
| skill attribution | absent | medium-high | add usage metadata fields |
| one-pager | absent | medium | write short external-facing page |
| product wording consistency | partial | medium | continue doc cleanup |

---

## 5. Shortest credible implementation path

The shortest path is **not** a rewrite.

The shortest path is:

### Step 1 — keep the engine

Do not replace:

- `dex-arbitrage`
- `alpha-engine`
- `simulator`
- `risk-engine`
- `onchainos-client`

These are assets.

### Step 2 — add a module output adapter

Wrap current outputs into:

- candidate lifecycle state
- structured decision
- normalized reasons
- skill attribution metadata
- operator/judge summaries

### Step 3 — add enrichment adapters

Start with shallow adapters for:

- token info
- token audit
- balance readiness
- optional signal support

### Step 4 — add compatibility attribution

Make the module visibly say:

- what upstream capability sources were used
- which were required vs optional enrichments

### Step 5 — only then consider deeper refactor

If later needed:

- rename abstractions
- create dedicated module service layer
- separate internal backend and product module boundaries more formally

---

## 6. Recommended implementation order

### Order A — fastest path with the best storytelling payoff

1. `ARBITRAGE_DECISION_REASONS.md`
2. output adapter for module contract
3. enrichment object model
4. skill attribution fields
5. one-pager and demo asset refinement

### Why this order works

- reason codes stabilize the language
- contract adapter stabilizes outputs
- enrichment makes compatibility visible
- attribution makes the BN ecosystem story concrete

---

## 7. What does not need to change immediately

To avoid churn, these do **not** need immediate surgery:

- internal folder names
- package name
- core engine loop
- current risk formulas
- current simulator structure
- current discovery APIs

The repo can move significantly closer to the target product before any heavy internal rename or backend redesign.

---

## 8. Recommended first engineering milestone

A realistic first engineering milestone would be:

- keep current arbitrage plugin running
- add normalized reason codes
- add product-facing module response adapter
- add enrichment placeholders / interfaces
- show `skillSources` in output
- update one demo path to use the new response shape

If that is done, the project can already present an honest and convincing “Binance Skills-compatible arbitrage module” story.

---

## 9. One-sentence summary

**The current codebase already has a strong arbitrage engine; the main missing pieces are product-facing adapters, enrichment, normalized reasons, and explicit Binance-skill compatibility surfaces — which means the next step is structured layering, not a rewrite.**
