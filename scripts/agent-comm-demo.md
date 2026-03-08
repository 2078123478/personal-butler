# Agent-Comm v2 Demo Walkthrough

This is the default two-runtime walkthrough for Agent-Comm v2 in this repo.

Flow:
1. initialize A + B
2. export signed cards
3. import cards on the opposite side
4. start listeners
5. send `connection_invite`
6. send `connection_accept`
7. send a trusted business command with `contact:<contactId>`

## Run it

```bash
./scripts/agent-comm-demo.sh
```

## Clean demo data

```bash
./scripts/agent-comm-demo.sh clean
```

## Notes
- The script demonstrates the contact-first v2 flow, not the old `peer:trust` bootstrap.
- `agent-comm:card:export` emits `shareUrl`, and the script intentionally imports one side from that share-url form.
- Direct-tx sends still require gas on the active comm wallets.
- Runtime logs are written to `data-a/runtime.log` and `data-b/runtime.log`.

## Key commands used by the script

```bash
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:wallet:init
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:card:export --output ./agent.card.json
npm run dev -- agent-comm:card:import ./agent.card.json
npm run dev -- agent-comm:card:import 'agentcomm://card?v=1&bundle=<base64url>'
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:connect:invite <contactId>
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:connect:accept <contactId>
VAULT_MASTER_PASSWORD=pass123 npm run dev -- agent-comm:send ping contact:<contactId> --echo hello
```

## Troubleshooting
- `insufficient funds`: fund the ACW that is sending the direct transaction.
- `Contact is not trusted`: wait for the invite/accept round-trip or inspect `agent-comm:contacts:list`.
- invite not applied: confirm both runtimes are running with `COMM_ENABLED=true` and `COMM_LISTENER_MODE=poll`.
