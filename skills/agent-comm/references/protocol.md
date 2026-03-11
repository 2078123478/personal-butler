# Agent-Comm Protocol Reference

## Architecture Overview

```
┌─────────────┐     on-chain tx      ┌─────────────┐
│   Agent A    │ ──────────────────→  │   Agent B    │
│              │                      │              │
│ tx-sender    │                      │ tx-listener  │
│ ecdh-crypto  │  E2E encrypted      │ ecdh-crypto  │
│ peer-registry│  EIP-712 signed     │ inbox-proc   │
│ local-identity                      │ task-router  │
└─────────────┘                      └─────────────┘
```

## Identity Model

Each agent has one or more local identity profiles:

| Role | Purpose |
|------|---------|
| `liw` | Long-lived Identity Wallet — primary persistent identity |
| `acw` | Agent-Comm Wallet — dedicated comm signing key |
| `temporary_demo` | Ephemeral demo wallet, no vault password needed |

Identity is anchored to a secp256k1 keypair. The wallet address is the canonical peer identifier.

## Signed Artifacts (EIP-712)

Three artifact types, all signed with EIP-712 typed-data:

### ContactCard
```
{
  peerId, walletAddress, publicKey, displayName, handle,
  capabilityProfile, capabilities[], chainId, contractAddress,
  issuedAt, expiresAt, keyId, version
}
```

### TransportBinding
```
{
  peerId, chainId, contractAddress, endpointType, issuedAt, expiresAt
}
```

### RevocationNotice
```
{
  artifactDigest, artifactType, revokedAt, replacementDigest, reason,
  issuerAddress, chainId
}
```

Full typed-data definitions: `docs/AGENT_COMM_V2_ARTIFACT_CONTRACTS.md`

## Connection Flow

```
A: card:export → publishes card (JSON/HTML/QR)
B: card:import → stores contact (status: imported)
B: connect:invite → sends on-chain connection_invite
A: inbox receives invite → contact status: pending_inbound
A: connect:accept → sends connection_accept (optionally attaches own card)
B: inbox receives accept → mutual trust established
```

Rejection: `connect:reject` sends `connection_reject`, contact stays non-trusted.

## Message Envelope (v2)

```json
{
  "v": 2,
  "protocol": "agent-comm/2",
  "from": "0x..sender",
  "to": "0x..recipient",
  "kex": "secp256k1-ecdh-aes256gcm-v2",
  "ephemeralPub": "04..hex",
  "iv": "hex",
  "ciphertext": "hex",
  "tag": "hex",
  "nonce": 42,
  "ts": 1710000000
}
```

Encryption: ECDH shared secret (sender ephemeral + recipient static) → AES-256-GCM.

## Command Types

### Business Commands
| Command | Purpose | Key Params |
|---------|---------|------------|
| `ping` | Liveness check | `echo`, `note` |
| `probe_onchainos` | Query execution readiness | `pair`, `chainIndex`, `notionalUsd` |
| `start_discovery` | Request discovery session | `strategyId`, `pairs`, `durationMinutes` |
| `get_discovery_report` | Fetch discovery results | `sessionId` |
| `approve_candidate` | Approve discovered candidate | `sessionId`, `candidateId`, `mode` |
| `request_mode_change` | Request paper↔live switch | `requestedMode`, `reason` |

### Connection Commands
| Command | Purpose |
|---------|---------|
| `connection_invite` | Request connection |
| `connection_accept` | Accept connection |
| `connection_reject` | Reject connection |
| `connection_confirm` | Confirm mutual trust |

## Trust State Machine

```
imported ──invite──→ pending_outbound ──accept──→ trusted
         ←invite──  pending_inbound  ──accept──→ trusted
                                     ──reject──→ imported
trusted ──block──→ blocked
trusted ──revoke──→ revoked
```

## Listener Modes

| Mode | Mechanism | Use Case |
|------|-----------|----------|
| `poll` | Poll chain every N seconds | Default, reliable |
| `ws` | WebSocket subscription | Lower latency (if RPC supports) |
| `disabled` | No listening | CLI-only usage |

Catch-up optimization: `getBlockReceipts` pre-filters by contract address before decoding, avoiding per-block full scan.

## x402 Paid Messaging

Optional gating for cold-inbound messages:

| Mode | Behavior |
|------|----------|
| `disabled` | All messages free |
| `observe` | Log payment status, don't enforce |
| `enforce` | Reject unpaid cold-inbound |

## Docs Index

- `docs/AGENT_COMM_ONE_PAGER.md` — high-level overview
- `docs/AGENT_COMM_V2_DESIGN.md` — full v2 design spec
- `docs/AGENT_COMM_V2_ARTIFACT_CONTRACTS.md` — EIP-712 typed-data contracts
- `docs/AGENT_COMM_V2_CARD_PACKAGING.md` — share URL + HTML card spec
- `docs/AGENT_COMM_V2_OPERATIONS.md` — operational runbook
- `docs/AGENT_COMM_EXTENSIONS_DESIGN.md` — extension roadmap
- `docs/AGENT_COMM_PRIVACY_AND_TRUST_ANALYSIS.md` — security analysis
- `docs/AGENT_COMM_REVOLUTIONARY_DESIGN.md` — vision narrative
- `docs/examples/agent-comm/` — sample card JSON, share URL, HTML
