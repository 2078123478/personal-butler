# Agent-Comm Production Deployment Guide

**Status**: Production-validated (2026-03-10)  
**Based on**: Mainnet A↔B live testing on X Layer (chain 196)

This guide provides the minimal, battle-tested steps to deploy Agent-Comm v2 in production.

## Quick Facts

- **Protocol**: Agent-Comm v2 (envelope v2, contact-based trust)
- **Tested chain**: X Layer (196)
- **Transport**: Direct on-chain transactions
- **Encryption**: ECDH + AES-256-GCM
- **Trust model**: Contact cards + connection invite/accept

## Prerequisites

1. **Two funded wallets** (for A and B)
   - Each needs gas tokens on the target chain
   - Recommended: 0.01 ETH minimum for testing

2. **Node.js environment**
   - Node v22+ recommended
   - `better-sqlite3` for state storage

3. **RPC endpoint**
   - Public RPC works (e.g., `https://xlayerrpc.okx.com`)
   - Private RPC recommended for production

## Architecture Overview

```
Agent A                          Agent B
├─ LIW (identity wallet)        ├─ LIW (identity wallet)
├─ ACW (active comm wallet)     ├─ ACW (active comm wallet)
├─ Vault (encrypted secrets)    ├─ Vault (encrypted secrets)
├─ Contact: B                    ├─ Contact: A
└─ Runtime (listener + sender)  └─ Runtime (listener + sender)
```

## Step 1: Environment Setup

Create separate data directories and env files for A and B.

### Agent A

Create `.env.agent-comm-mainnet-a`:

```bash
NETWORK_PROFILE_ID=xlayer-recommended
DATA_DIR=/path/to/data/agent-comm-mainnet-a
VAULT_MASTER_PASSWORD=<generate-strong-password>
COMM_ENABLED=true
COMM_LISTENER_MODE=poll
COMM_POLL_INTERVAL_MS=3000
LOG_LEVEL=info
AGENT_COMM_PRIVATE_KEY=<your-private-key-or-leave-empty-to-generate>
PORT=3001
# Optional: webhook notification on inbound messages
# COMM_WEBHOOK_URL=http://127.0.0.1:18789/hooks/wake
# COMM_WEBHOOK_TOKEN=your-webhook-secret
```

### Agent B

Create `.env.agent-comm-mainnet-b`:

```bash
NETWORK_PROFILE_ID=xlayer-recommended
DATA_DIR=/path/to/data/agent-comm-mainnet-b
VAULT_MASTER_PASSWORD=<generate-strong-password>
COMM_ENABLED=true
COMM_LISTENER_MODE=poll
COMM_POLL_INTERVAL_MS=3000
LOG_LEVEL=info
AGENT_COMM_PRIVATE_KEY=<your-private-key-or-leave-empty-to-generate>
PORT=3002
# Optional: webhook notification on inbound messages
# COMM_WEBHOOK_URL=http://127.0.0.1:18789/hooks/wake
# COMM_WEBHOOK_TOKEN=your-webhook-secret
```

**Security note**: Use different `VAULT_MASTER_PASSWORD` for A and B.

### Webhook Notification (Optional)

Agent-Comm can notify an external system (e.g., OpenClaw, Slack, or any webhook endpoint) whenever an inbound message is received and processed. This is useful for:

- Triggering an AI agent heartbeat on new messages
- Sending alerts to a chat channel
- Integrating with automation pipelines

Add these environment variables to your `.env` file:

```bash
# Webhook URL to POST when an inbound message is processed
COMM_WEBHOOK_URL=http://127.0.0.1:18789/hooks/wake

# Bearer token for webhook authentication (optional, depends on endpoint)
COMM_WEBHOOK_TOKEN=your-webhook-secret
```

When a message is received, the runtime sends a fire-and-forget POST:

```json
{
  "text": "[agent-comm] Inbound ping from 0x7b2c...5A4 (tx: 0xac3f5a26…)",
  "mode": "now"
}
```

The request includes `Authorization: Bearer <token>` if `COMM_WEBHOOK_TOKEN` is set.

#### OpenClaw Integration Example

If you run [OpenClaw](https://github.com/openclaw/openclaw), enable its webhook endpoint:

```json5
// ~/.openclaw/openclaw.json
{
  hooks: {
    enabled: true,
    token: "your-webhook-secret"
  }
}
```

Then set in your agent-comm env:

```bash
COMM_WEBHOOK_URL=http://localhost:18789/hooks/wake
COMM_WEBHOOK_TOKEN=your-webhook-secret
```

This triggers an immediate OpenClaw heartbeat whenever an on-chain message arrives, so your AI agent can react in real time.

## Step 2: Initialize Wallets

### On Agent A

```bash
cd /path/to/personal-butler
source .env.agent-comm-mainnet-a

# Initialize wallet (generates LIW + ACW if not exists)
npm run dev -- agent-comm:wallet:init

# Check identity
npm run dev -- agent-comm:identity
```

Save the output, you'll need:
- `address` (ACW address)
- `pubkey` (ACW public key)
- `identityWallet` (LIW address)

### On Agent B

```bash
cd /path/to/personal-butler
source .env.agent-comm-mainnet-b

# Initialize wallet
npm run dev -- agent-comm:wallet:init

# Check identity
npm run dev -- agent-comm:identity
```

Save the same fields.

## Step 3: Export and Exchange Contact Cards

### Agent A exports card

```bash
source .env.agent-comm-mainnet-a

npm run dev -- agent-comm:card:export \
  --display-name "Agent A" \
  --capability-profile research-collab \
  --capabilities ping,start_discovery \
  --output ./data/agent-comm-mainnet-a/agent-a.card.json
```

Copy the `shareUrl` from output (or the JSON file).

### Agent B exports card

```bash
source .env.agent-comm-mainnet-b

npm run dev -- agent-comm:card:export \
  --display-name "Agent B" \
  --capability-profile research-collab \
  --capabilities ping,start_discovery \
  --output ./data/agent-comm-mainnet-b/agent-b.card.json
```

### Cross-import

**A imports B's card:**

```bash
source .env.agent-comm-mainnet-a
npm run dev -- agent-comm:card:import ./data/agent-comm-mainnet-b/agent-b.card.json
```

Note the `contactId` from output (e.g., `ct_9c2dac55-...`).

**B imports A's card:**

```bash
source .env.agent-comm-mainnet-b
npm run dev -- agent-comm:card:import ./data/agent-comm-mainnet-a/agent-a.card.json
```

Note the `contactId`.

## Step 4: Establish Trust

### A invites B

```bash
source .env.agent-comm-mainnet-a
npm run dev -- agent-comm:connect:invite <B's-contactId>
```

This sends an on-chain transaction.

### B accepts A

```bash
source .env.agent-comm-mainnet-b
npm run dev -- agent-comm:connect:accept <A's-contactId>
```

This also sends an on-chain transaction.

**Wait ~10 seconds** for both transactions to confirm.

## Step 5: Start Runtimes

### Start B's listener (receiver)

```bash
source .env.agent-comm-mainnet-b
nohup npm run dev > data/agent-comm-mainnet-b/runtime.log 2>&1 &
```

Check health:

```bash
curl -s http://localhost:3002/health | jq .
```

### Start A's listener (optional, if A also receives)

```bash
source .env.agent-comm-mainnet-a
nohup npm run dev > data/agent-comm-mainnet-a/runtime.log 2>&1 &
```

## Step 6: Send Test Message

### A sends ping to B

```bash
source .env.agent-comm-mainnet-a

npm run dev -- agent-comm:send ping contact:<B's-contactId> \
  --echo "hello from A" \
  --note "production-test"
```

Expected output:
- `txHash`: transaction hash
- `sentAt`: timestamp
- `envelopeVersion`: 2
- `contactId`: B's contact ID

### Verify B received it

Check B's database:

```bash
cd /path/to/personal-butler
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/agent-comm-mainnet-b/alpha.db', { readonly: true });
const msg = db.prepare('SELECT tx_hash, command_type, status, sent_at, executed_at FROM agent_messages WHERE direction=\"inbound\" ORDER BY created_at DESC LIMIT 1').get();
console.log(JSON.stringify(msg, null, 2));
db.close();
"
```

Expected:
- `tx_hash`: matches A's send
- `command_type`: "ping"
- `status`: "executed"
- `executed_at`: timestamp

## Known Issues and Solutions

### Issue 1: Listener cursor falls behind

**Symptom**: Messages sent hours ago still not received.

**Root cause**: Listener polls block-by-block, slow when catching up.

**Workaround**: Manually advance cursor to recent block:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/agent-comm-mainnet-b/alpha.db');
db.prepare('UPDATE listener_cursors SET cursor=\"<recent-block-number>\", updated_at=datetime(\"now\") WHERE address=\"<your-ACW-address>\" AND chain_id=\"196\"').run();
db.close();
"
```

Then restart runtime.

**Permanent fix**: Implement `eth_getLogs` batch fetching (see Performance Optimization below).

### Issue 2: Vault decryption error

**Symptom**: `Unsupported state or unable to authenticate data`

**Root cause**: Wrong `VAULT_MASTER_PASSWORD` or corrupted vault.

**Solution**: Verify password matches the one used during `wallet:init`.

### Issue 3: Contact not trusted

**Symptom**: `Contact is not trusted` when sending.

**Root cause**: Invite/accept flow incomplete.

**Solution**: Complete both `connect:invite` and `connect:accept`, wait for tx confirmation.

## Performance Optimization

### Current bottleneck: Block polling

The listener currently polls block-by-block. When cursor falls behind by 20,000+ blocks, catch-up takes ~50 minutes.

**Recommended fix**: Replace block polling with `eth_getLogs`:

```typescript
// Pseudo-code
const logs = await publicClient.getLogs({
  address: myAddress,
  fromBlock: lastCursor,
  toBlock: latestBlock
});

// Process only blocks with relevant transactions
for (const log of logs) {
  await processTransaction(log.transactionHash);
}
```

This reduces catch-up time from ~50 minutes to ~10 seconds.

### Polling interval tuning

- **Development**: 3000ms (current default)
- **Production**: 5000-10000ms (reduce RPC load)
- **High-frequency**: 1000ms (faster message delivery, higher cost)

## Production Checklist

Before going live:

- [ ] Wallets funded with sufficient gas
- [ ] Vault passwords backed up securely
- [ ] Contact cards exchanged and imported
- [ ] Trust established (invite + accept confirmed)
- [ ] Runtime health endpoints responding
- [ ] Test message sent and received successfully
- [ ] Listener cursor monitoring in place
- [ ] Log rotation configured
- [ ] Restart scripts tested

## Monitoring

### Health check

```bash
curl -s http://localhost:3002/health
```

Expected: `{"ok": true, ...}`

### Listener cursor status

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/agent-comm-mainnet-b/alpha.db', { readonly: true });
const cursor = db.prepare('SELECT cursor, updated_at FROM listener_cursors WHERE chain_id=\"196\"').get();
console.log(cursor);
db.close();
"
```

Compare `cursor` with current chain height. If gap > 1000 blocks, investigate.

### Message throughput

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/agent-comm-mainnet-b/alpha.db', { readonly: true });
const stats = db.prepare('SELECT direction, status, COUNT(*) as count FROM agent_messages GROUP BY direction, status').all();
console.log(stats);
db.close();
"
```

## Security Considerations

### Private key management

- **Never commit** `.env` files or private keys to git
- Use hardware wallets or HSM for high-value identities
- Rotate ACW periodically (see `agent-comm:wallet:rotate`)

### Vault encryption

- `VAULT_MASTER_PASSWORD` is the single point of failure
- Store it in a password manager or secrets vault
- Consider key derivation from hardware token for production

### Network exposure

- Runtime HTTP server has no authentication by default
- Set `API_SECRET` environment variable for production
- Use reverse proxy (nginx/caddy) with TLS
- Restrict access to trusted IPs

### Message validation

- Current implementation trusts contact-based senders
- Consider adding application-level signature verification
- Log all inbound messages for audit

## Troubleshooting

### Runtime exits immediately

Check:
1. Port already in use: `lsof -i :3002`
2. Database locked: `lsof data/agent-comm-mainnet-b/alpha.db`
3. Vault password wrong: check logs for decryption errors

### Messages not arriving

Check:
1. Listener cursor position (see Monitoring above)
2. Transaction confirmed on-chain: `eth_getTransactionReceipt`
3. Recipient address matches ACW: compare with `agent-comm:identity`
4. Trust established: `agent-comm:contacts:list` shows `status: "trusted"`

### High RPC costs

Reduce polling frequency:
- Set `COMM_POLL_INTERVAL_MS=10000` (10 seconds)
- Implement `eth_getLogs` batch fetching
- Use private RPC with rate limits

## Next Steps

After successful deployment:

1. **Implement getLogs optimization** (see Performance Optimization)
2. **Add monitoring/alerting** for cursor lag and message failures
3. **Document your specific use case** (discovery, trading signals, etc.)
4. **Consider multi-chain deployment** (same protocol, different chains)

## Related Documentation

- Protocol design: `docs/AGENT_COMM_V2_DESIGN.md`
- Operations guide: `docs/AGENT_COMM_V2_OPERATIONS.md`
- Privacy analysis: `docs/AGENT_COMM_PRIVACY_AND_TRUST_ANALYSIS.md`
- Artifact contracts: `docs/AGENT_COMM_V2_ARTIFACT_CONTRACTS.md`

## Support

For issues or questions:
- Check existing docs in `docs/`
- Review test suite: `tests/agent-comm-*.test.ts`
- Inspect runtime logs: `data/*/runtime.log`

---

**Last validated**: 2026-03-10  
**Test environment**: X Layer mainnet (chain 196)  
**Protocol version**: Agent-Comm v2 (envelope v2)
