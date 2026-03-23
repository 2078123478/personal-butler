# Vigil Judge Guide

This guide is a one-page evaluator view of what Vigil is, what to inspect first, and one stable 5-minute verification path.

Companion docs:
- `docs/official-skills-manifest.json` (official skills coverage, stage, runtime, and output visibility)

## 0) Fast reading order

If you only open a few files, use this order:

1. `README.md` — top-level product loop and quick verification entry.
2. `docs/JUDGE_GUIDE.md` — this page.
3. `docs/JUDGE_ONE_PAGER.md` — expanded judge-facing context.
4. `docs/official-skills-manifest.json` — official skill coverage, stage, runtime, and output visibility.

## Term map

- **Living Assistant** = sensing + interruption judgment + briefing loop.
- **Signal Radar** = ecosystem signal ingestion layer.
- **Contact Policy** = policy engine that decides `silent -> call_escalation`.
- **Voice Brief** = short user-facing voice summary.
- **Execution** = paper-first execution and risk-control loop.
- **Agent-Comm** = wallet-based trust and communication layer.

## 1) What this project is

Vigil is a BNB ecosystem assistant runtime that:

- senses ecosystem signals,
- judges whether a user should be interrupted,
- and routes outcomes through paper-first, explainable execution paths.

Deployment note: Vigil is built on the OpenClaw platform, leveraging platform capabilities for channel binding, session orchestration, delivery, and callback handling. For end users, the practical entrypoints are Telegram / voice / call rather than direct repo configuration.

## 2) What problem it solves

In practical operations, teams face three recurring issues:

1. too many raw signals and not enough prioritization,
2. weak safety boundaries between quick verification behavior and real execution,
3. poor evidence quality when explaining "why this action was taken."

Vigil addresses this with a single loop: `sense -> judge -> brief/act`, plus paper-first execution and replayable outputs.

## Technical Architecture

```mermaid
graph TB
    subgraph Signal Layer
        BA[Binance Announcements API]
        BS[Binance Square API]
        TI[Token Info / Audit<br/>binance-web3]
    end

    subgraph Judgment Layer
        SR[Signal Radar<br/>NormalizedSignal]
        LLM[LLM Triage<br/>~87% noise reduction]
        CP[Contact Policy Engine<br/>6-level attention ladder]
    end

    subgraph Execution Layer
        PE[Paper Engine<br/>cost model + risk gates]
        RE[Risk Engine<br/>3-layer auto-degradation]
        SIM[Simulator<br/>paper ↔ live switch]
    end

    subgraph Delivery Layer
        TG[Telegram<br/>text + inline keyboard]
        VC[CosyVoice TTS<br/>cloned voice ≤15s]
        TW[Twilio<br/>call escalation]
    end

    subgraph Trust Layer
        WI[Wallet Identity<br/>EIP-712 signed cards]
        E2E[E2E Encryption<br/>ECDH + AES-256-GCM]
        LC[Lifecycle<br/>discover → invite → trust → revoke]
    end

    BA --> SR
    BS --> SR
    TI --> SR
    SR --> LLM
    LLM --> CP
    CP -->|silent / digest| DROP[Suppress or batch]
    CP -->|text_nudge| TG
    CP -->|voice_brief| VC
    CP -->|call_escalation| TW
    CP -->|execution trigger| PE
    PE --> RE
    RE --> SIM
    TG -->|callback| LOOP[Feedback Loop]
    WI -.->|identity| SR
    E2E -.->|encryption| TG
```

## 3) Three things to look at

1. **Judgment loop quality (Living Assistant)**
- Run `npm run demo:living-assistant`.
- Inspect fixture-driven scenarios in `fixtures/demo-scenarios/`.
- For API mode, inspect `/api/v1/living-assistant/demo/:scenarioName` and `/api/v1/living-assistant/evaluate`.

2. **Execution safety and evidence output**
- Start the API (`npm run dev`) and run `npm run demo:discovery`.
- Review generated artifacts in `demo-output/discovery-demo-*.json`.
- Check that the flow remains paper-safe by default unless explicitly switched.
- For approve routes, inspect `skillAttribution` (`requiredSkillsUsed`, `enrichmentSkillsUsed`, `distributionSkillsUsed`, `skillSources`) and compare with `docs/official-skills-manifest.json`.

3. **Trust and communication layer (Agent-Comm)**
- Review `scripts/agent-comm-demo.sh` and `docs/AGENT_COMM_EXPLAINED.md`.
- Look for wallet-based identity, signed contact cards, and encrypted message path.

## 4) 5-minute verification path

```bash
npm install
cp .env.example .env

# Terminal A
npm run dev

# Terminal B
npm run demo:judge
```

This path is a quick inspection shortcut, not the definition of the product. Vigil itself is designed around persistent sensing, policy-driven interruption, paper-first execution, and replayable evidence.

What `demo:judge` does:

1. verifies basic prerequisites,
2. runs `demo:living-assistant` (stable local path),
3. if API health is available, attempts `demo:discovery`,
4. points you to evidence artifacts under `demo-output/`.

If you see `401 unauthorized`, export the same secret used by the API before rerunning:

```bash
export ALPHAOS_API_SECRET="<your API_SECRET value>"
```

## 5) Verification vs live boundaries (repo-validated)

Treat the following as **real/external path**:

- `npm run demo:living-assistant -- --live` (live polling path; external feeds/config dependent),
- execution backend integration when `ONCHAINOS_*` credentials are configured,
- real outbound delivery when `--send` / `--call` is used with valid provider credentials.

Treat the following as **verification-safe path**:

- default `npm run demo:living-assistant` (fixture-driven local scenarios),
- `/api/v1/living-assistant/demo/:scenarioName` (demo scenario route),
- `npm run demo:discovery` default paper approval mode (`ALPHAOS_DISCOVERY_APPROVE_MODE=paper`),
- `npm run demo:living-assistant -- --call --demo-delivery` (simulated call delivery).

This boundary keeps quick review credible while avoiding claims that depend on unstable live conditions.
