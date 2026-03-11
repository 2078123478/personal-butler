# AlphaOS

A skill-oriented autonomous agent framework built on the [OnchainOS](https://www.okx.com/zh-hans/web3/build/docs/waas/onchainos-overview) ecosystem. The core primitive is **Agent-Comm** — a contact-first, blockchain-native messaging protocol that gives every agent a wallet-based identity, consent-gated connections, and end-to-end encrypted on-chain communication.

Built for X Layer. Runs on any EVM chain.

## Agent-Comm — Core Protocol

Agents need their own communication layer — with identity, trust, privacy, and on-chain verifiability. Agent-Comm is that layer.

- **Wallet = Identity** — Every agent holds a secp256k1 keypair. EIP-712 signed contact cards prove identity without infrastructure.
- **Consent-gated trust** — Importing a card doesn't auto-connect. The peer requests; you approve or reject. No spam.
- **Encrypted inscription transport** — Messages are encrypted (ECDH + AES-256-GCM) and written into transaction calldata on-chain. No servers, no brokers, no contracts to deploy.
- **Chain-agnostic** — Works on any EVM chain. First deployed on X Layer (Chain 196).

![Agent-Comm Contact Card](docs/assets/agent-comm-card-preview.png)

### Quick Start

```bash
# Initialize agent identity
VAULT_MASTER_PASSWORD=pass123 npx tsx src/index.ts agent-comm:wallet:init

# Export a shareable HTML contact card with QR code
VAULT_MASTER_PASSWORD=pass123 npx tsx src/index.ts agent-comm:card:export --html --output ./my-card.html

# Import a peer's card (file, JSON, or agentcomm:// share URL)
npx tsx src/index.ts agent-comm:card:import ./peer-card.json

# Request connection → peer approves → mutual trust
VAULT_MASTER_PASSWORD=pass123 npx tsx src/index.ts agent-comm:connect:invite <contactId>

# Send encrypted command to trusted peer
VAULT_MASTER_PASSWORD=pass123 npx tsx src/index.ts agent-comm:send ping contact:<contactId> --echo hello
```

### Connection Flow

```
Export card → Peer imports → Peer sends invite → You approve → Mutual trust → Encrypted messaging
```

### Supported Commands

| Command | Purpose |
|---------|---------|
| `ping` | Liveness check |
| `probe_onchainos` | Query peer's OnchainOS execution readiness |
| `start_discovery` | Request opportunity scanning |
| `request_mode_change` | Request paper↔live switch |

Full CLI reference: `npx tsx src/index.ts agent-comm:help`

### Documentation

- [One Pager](docs/AGENT_COMM_ONE_PAGER.md) — Human-friendly overview
- [Protocol Design](docs/AGENT_COMM_V2_DESIGN.md) — Full v2 specification
- [Artifact Contracts](docs/AGENT_COMM_V2_ARTIFACT_CONTRACTS.md) — EIP-712 typed-data definitions
- [Card Packaging](docs/AGENT_COMM_V2_CARD_PACKAGING.md) — Share URL + HTML card spec
- [Operations Runbook](docs/AGENT_COMM_V2_OPERATIONS.md) — Deployment and operations
- [Production Guide](docs/AGENT_COMM_PRODUCTION_DEPLOYMENT.md) — Battle-tested deployment steps
- [Privacy Analysis](docs/AGENT_COMM_PRIVACY_AND_TRUST_ANALYSIS.md) — Trust model and privacy boundaries

---

## Skill Architecture

AlphaOS organizes capabilities as composable skills. Each skill has a self-contained definition (`SKILL.md`) with triggers, operations, and extension points.

```
skills/
├── agent-comm/    # P2P identity, contact cards, encrypted messaging
├── alphaos/       # DEX arbitrage engine (scan → evaluate → execute → record)
└── discovery/     # Multi-strategy opportunity scanning
```

Skills share runtime infrastructure (SQLite state store, vault, config) but maintain clear boundaries. See each `skills/*/SKILL.md` for details.

---

## Arbitrage Engine (alphaos skill)

A plugin-based DEX arbitrage engine that leverages OnchainOS v6 execution infrastructure for on-chain trading.

**Core flow:** `scan → evaluate → plan → simulate → execute → record → notify`

Paper trading on X Layer (Chain 196), March 4–10, 2026:

- **305 trades**, **100% win rate**, **$895.94 net profit**
- 1,661 opportunities scanned across DEX pairs

![AlphaOS Performance](docs/assets/pnl-performance.png)

### Execution Modes

| Mode | Behavior |
|------|----------|
| `paper` | Virtual execution, full PnL tracking |
| `live` | Real execution via OnchainOS v6 (quote → swap → simulate → broadcast) |

Live promotion requires 24h paper track record: net profit > 0, win rate ≥ 55%, zero permission failures.

### OnchainOS Integration

AlphaOS integrates with [OnchainOS](https://www.okx.com/zh-hans/web3/build/docs/waas/onchainos-overview) as its execution infrastructure layer:

- Official v6 execution flow: `quote → swap → simulate → broadcast → history`
- Token resolution and chain indexing via OnchainOS API
- Execution readiness probing: `POST /api/v1/integration/onchainos/probe`
- Auth modes: `bearer`, `api-key`, `hmac`

### Run

```bash
cp .env.example .env
# Configure OnchainOS credentials and network profile
npm install && npm run dev
```

Demo scripts:
```bash
npm run demo:run            # Full arbitrage cycle
npm run demo:discovery      # Discovery engine demo
npm run demo:smoke:live     # OnchainOS v6 integration smoke test
```

---

## Discovery Engine (discovery skill)

Time-bounded market scanning sessions with three pluggable strategies:

| Strategy | Signal |
|----------|--------|
| `spread-threshold` | Static spread threshold |
| `mean-reversion` | Z-score deviation from rolling mean |
| `volatility-breakout` | Volatility ratio exceeds baseline |

Can be triggered locally via API or remotely via Agent-Comm (`start_discovery` command).

---

## API Overview

### Agent-Comm
```
GET  /api/v1/agent-comm/status
GET  /api/v1/agent-comm/contacts
GET  /api/v1/agent-comm/messages
POST /api/v1/agent-comm/cards/export
POST /api/v1/agent-comm/cards/import
POST /api/v1/agent-comm/connections/invite
POST /api/v1/agent-comm/connections/:contactId/accept
POST /api/v1/agent-comm/connections/:contactId/reject
POST /api/v1/agent-comm/send/ping
POST /api/v1/agent-comm/send/start-discovery
```

### Engine
```
GET  /api/v1/metrics/today
POST /api/v1/engine/mode
GET  /api/v1/opportunities
GET  /api/v1/trades
GET  /api/v1/strategies/status
```

### Discovery
```
POST /api/v1/discovery/sessions/start
GET  /api/v1/discovery/sessions/:id/report
POST /api/v1/discovery/sessions/:id/approve
```

### Growth & Observability
```
GET  /api/v1/growth/share/latest
GET  /api/v1/growth/moments
GET  /api/v1/stream/metrics          (SSE)
GET  /api/v1/backtest/snapshot
POST /api/v1/replay/sandbox
GET  /demo                           (live dashboard)
```

---

## Network Profiles

| Profile | Chain | Config |
|---------|-------|--------|
| `xlayer-recommended` | X Layer (196) | Auto RPC, poll listener, HMAC auth |
| `evm-custom` | Any EVM chain | Manual RPC, listener, auth config |

---

## Storage

- Business state: `data/alpha.db` (SQLite)
- Secrets: `data/vault.db` (AES-256-GCM + PBKDF2)
- Both excluded from git via `.gitignore`

## License

[Business Source License 1.1](LICENSE) — source available, commercial use requires authorization. Converts to Apache 2.0 on 2030-03-11.
