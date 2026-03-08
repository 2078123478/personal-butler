# Agent-Comm v2 Operations

Status: current default operator/developer guide  
Updated: 2026-03-08

This guide describes the product-default Agent-Comm v2 flow in this repo:

1. initialize LIW/ACW wallets
2. export/import signed contact cards
3. establish trust with `connection_invite` / `connection_accept`
4. send business commands after trust exists

Reference contracts:
- Design: `docs/AGENT_COMM_V2_DESIGN.md`
- Typed-data contracts: `docs/AGENT_COMM_V2_ARTIFACT_CONTRACTS.md`
- Card packaging: `docs/AGENT_COMM_V2_CARD_PACKAGING.md`

## Roles

### LIW
- long-lived identity wallet
- signs reusable contact artifacts
- should change rarely
- is the durable identity anchor for remote contacts

### ACW
- active comm wallet
- sends and receives direct-tx traffic
- can rotate on a shorter cadence than LIW
- is bound back to LIW by a signed `TransportBinding`

### Temporary demo wallet
- local-only/demo helper
- must not replace the LIW/ACW pair silently
- exists for controlled demos or throwaway testing

## Default CLI flow

### 1. Initialize the local identity

```bash
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:wallet:init
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:identity
```

Fresh installs create distinct LIW + ACW roles by default. Existing single-wallet installs are preserved as temporary dual-use state until the operator rotates.

### 2. Export a signed contact card bundle

```bash
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:card:export \
  --display-name "Agent A" \
  --capability-profile research-collab \
  --capabilities ping,start_discovery \
  --output ./agent-a.card.json
```

The response includes:
- `bundle`
- `contactCardDigest`
- `transportBindingDigest`
- `shareUrl`

`shareUrl` is the canonical text payload for QR or short-link wrapping.

### 3. Import the remote card

Any of these inputs work:

```bash
npm run dev -- agent-comm:card:import ./agent-b.card.json
npm run dev -- agent-comm:card:import '{"bundleVersion":1,...}'
npm run dev -- agent-comm:card:import 'agentcomm://card?v=1&bundle=<base64url>'
```

The import response tells you:
- whether verification succeeded
- the `contactId`
- the imported `identityWallet`
- the active transport address
- digest + fingerprint summaries

### 4. Inspect contacts

```bash
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:contacts:list
```

Look for:
- `contactId`
- `status`
- `supportedProtocols`
- `currentTransportAddress`
- `pendingInvites`
- legacy markers when a contact came from old v1 state

### 5. Establish trust

Sender:

```bash
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:connect:invite <contactId>
```

Receiver:

```bash
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:connect:accept <contactId>
```

Optional flags:
- `--attach-inline-card` to include the latest signed bundle inline
- `--requested-profile` / `--requested-capabilities` on invite
- `--capability-profile` / `--capabilities` on accept

Once accepted, the sender can use the existing business send surface with either:
- `contact:<contactId>`
- a compatible `legacyPeerId` if the contact advertises one

### 6. Send trusted business commands

```bash
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:send ping contact:<contactId> --echo hello
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:send start_discovery contact:<contactId> --strategy-id spread-threshold
```

The CLI stays backward compatible, but new contact-first onboarding no longer requires creating a manual `agent_peers` record before trusted v2 sends.

## HTTP flow

### Export/import cards

```bash
curl -X POST http://127.0.0.1:3000/api/v1/agent-comm/cards/export \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Agent A","capabilityProfile":"research-collab","capabilities":["ping","start_discovery"]}'

curl -X POST http://127.0.0.1:3000/api/v1/agent-comm/cards/import \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"bundle": {"bundleVersion":1,...}}'
```

### Invite/accept

```bash
curl -X POST http://127.0.0.1:3000/api/v1/agent-comm/connections/invite \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"contactId":"<contactId>","requestedProfile":"research-collab","requestedCapabilities":["ping","start_discovery"]}'

curl -X POST http://127.0.0.1:3000/api/v1/agent-comm/connections/<contactId>/accept \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"capabilityProfile":"research-collab","capabilities":["ping","start_discovery"]}'
```

### Trusted business send

```bash
curl -X POST http://127.0.0.1:3000/api/v1/agent-comm/send/ping \
  -H "Authorization: Bearer $API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"peerId":"contact:<contactId>","echo":"hello"}'
```

`peerId` is kept for backward compatibility, but it now accepts `contact:<contactId>` in addition to legacy peer aliases.

## Recommended capability templates

These templates are guidance, not hard-enforced registry entries.

| Profile | Intended use | Suggested capabilities |
|---|---|---|
| `research-collab` | collaborative discovery and ping-based health checks | `ping`, `start_discovery` |
| `ping-only` | smoke tests or narrow liveness checks | `ping` |

## Migration behavior

### Existing single-wallet installs
- startup preserves the historical wallet as temporary LIW + ACW dual-use state
- no trust relationships are dropped during upgrade
- rotating the ACW moves the runtime to the intended split without forcing immediate churn

### Existing `agent_peers`
- startup backfills them into v2 contact-oriented storage
- legacy/manual peer records keep working
- contact surfaces show legacy markers so operators can distinguish migrated/manual records from card-based v2 contacts

## Legacy fallback behavior

### What still works
- `agent-comm:peer:trust`
- `POST /api/v1/agent-comm/peers/trusted`
- v1 envelope receive paths
- v2 senders falling back to v1 when the trusted contact only supports `agent-comm/1`

### What changed
- manual peer creation now returns an explicit warning that it is a legacy/manual v1 fallback path
- `GET /api/v1/agent-comm/status` includes `legacyUsage` counts and thresholds so operators can see whether legacy onboarding is still common
- new trusted v2 contacts can use `agent-comm:send ... contact:<contactId>` without first creating a manual peer row

### Important limitation
A true v1 receiver still depends on the old trusted-peer trust path for business commands. v2 compatibility does not remove that legacy receiver requirement.

## Wallet rotation and recovery

Rotate the active comm wallet:

```bash
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:wallet:rotate \
  --grace-period-hours 48 \
  --display-name "Agent A" \
  --capability-profile research-collab \
  --capabilities ping,start_discovery
```

Rotation does three important things:
- archives the previous ACW in the vault
- keeps the old receive key active for a bounded grace window
- exports a fresh signed card/binding set for the new ACW

Recommended recovery posture:
- back up LIW and ACW secrets separately
- treat the archived ACW alias as temporary recovery material, not the new default wallet
- re-export the card after rotation and redistribute it to contacts
- verify that contacts import the new bundle or receive it inline during the next connection control-plane update

## Troubleshooting runbook

| Symptom | Likely cause | Action |
|---|---|---|
| `missing_inline_card` on an unknown v2 invite | sender did not attach a card and receiver had no prior contact | resend invite with `--attach-inline-card` or import the card first |
| binding verification or `tx.from` mismatch | sender rotated transport without distributing the new binding | export/import a fresh bundle or send a control-plane update with inline card |
| `Contact is not trusted` on business send | invite/accept flow is incomplete | finish `connect:invite` / `connect:accept` first |
| business send falls back to v1 unexpectedly | remote contact only advertises `agent-comm/1` or local state is legacy-only | inspect `supportedProtocols` in `agent-comm:contacts:list` |
| direct-tx send fails with insufficient balance | ACW has no gas token | fund the active comm wallet or restore a funded key |
| old receiver still rejects business commands | remote side is relying on legacy trusted-peer checks | keep the compatible manual peer record on the true v1 side until it upgrades |

## Related files
- Demo walkthrough: `scripts/agent-comm-demo.sh`
- Demo notes: `scripts/agent-comm-demo.md`
- Legacy/manual reference: `docs/AGENT_COMM_MIN_REUSE.md`
