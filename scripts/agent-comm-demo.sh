#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${1:-}" == "clean" ]]; then
  rm -rf data-a data-b
  echo "Cleaned demo data: data-a data-b"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required"
  exit 1
fi

json_field() {
  local field="$1"
  node -e 'const fs=require("node:fs"); const path=process.argv[1].split("."); let value=JSON.parse(fs.readFileSync(0,"utf8")); for (const key of path) value=value?.[key]; if (value === undefined) process.exit(2); process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));' "$field"
}

run_json() {
  "$@"
}

wait_for_health() {
  local url="$1"
  for _ in {1..20}; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cleanup() {
  if [[ -n "${PID_A:-}" ]]; then kill "$PID_A" >/dev/null 2>&1 || true; fi
  if [[ -n "${PID_B:-}" ]]; then kill "$PID_B" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

rm -rf data-a data-b
mkdir -p data-a data-b

export NETWORK_PROFILE_ID="${NETWORK_PROFILE_ID:-xlayer-recommended}"
export VAULT_MASTER_PASSWORD="${VAULT_MASTER_PASSWORD:-pass123}"

printf '\n== Agent-Comm v2 contact-first demo ==\n\n'
printf 'This walkthrough requires gas on both active comm wallets for direct-tx sends.\n\n'

printf '== Step 1: initialize A and B ==\n'
export DATA_DIR=data-a
A_INIT=$(run_json npm run dev -- agent-comm:wallet:init)
printf '%s\n' "$A_INIT"
A_ADDRESS=$(printf '%s' "$A_INIT" | json_field address)

export DATA_DIR=data-b
B_INIT=$(run_json npm run dev -- agent-comm:wallet:init)
printf '%s\n' "$B_INIT"
B_ADDRESS=$(printf '%s' "$B_INIT" | json_field address)

printf '\nA address: %s\nB address: %s\n\n' "$A_ADDRESS" "$B_ADDRESS"

printf '== Step 2: export signed cards ==\n'
export DATA_DIR=data-a
A_CARD=$(run_json npm run dev -- agent-comm:card:export \
  --display-name "Demo Agent A" \
  --capability-profile research-collab \
  --capabilities ping,start_discovery \
  --output ./data-a/agent-a.card.json)
printf '%s\n' "$A_CARD"
A_SHARE_URL=$(printf '%s' "$A_CARD" | json_field shareUrl)

export DATA_DIR=data-b
B_CARD=$(run_json npm run dev -- agent-comm:card:export \
  --display-name "Demo Agent B" \
  --capability-profile research-collab \
  --capabilities ping,start_discovery \
  --output ./data-b/agent-b.card.json)
printf '%s\n' "$B_CARD"
B_SHARE_URL=$(printf '%s' "$B_CARD" | json_field shareUrl)

printf '\nA shareUrl (for QR/short-link wrapping): %s\n' "$A_SHARE_URL"
printf 'B shareUrl (for QR/short-link wrapping): %s\n\n' "$B_SHARE_URL"

printf '== Step 3: import cards on the opposite side ==\n'
export DATA_DIR=data-a
A_IMPORT_B=$(run_json npm run dev -- agent-comm:card:import ./data-b/agent-b.card.json)
printf '%s\n' "$A_IMPORT_B"
CONTACT_B_ON_A=$(printf '%s' "$A_IMPORT_B" | json_field contactId)

export DATA_DIR=data-b
B_IMPORT_A=$(run_json npm run dev -- agent-comm:card:import "$A_SHARE_URL")
printf '%s\n' "$B_IMPORT_A"
CONTACT_A_ON_B=$(printf '%s' "$B_IMPORT_A" | json_field contactId)

printf '\nB on A contactId: %s\n' "$CONTACT_B_ON_A"
printf 'A on B contactId: %s\n\n' "$CONTACT_A_ON_B"

printf '== Step 4: start both listeners ==\n'
export COMM_ENABLED=true
export COMM_LISTENER_MODE=poll
export COMM_POLL_INTERVAL_MS="${COMM_POLL_INTERVAL_MS:-3000}"

export DATA_DIR=data-a
export PORT=3001
export API_SECRET=demo-secret-a
npm run dev > data-a/runtime.log 2>&1 &
PID_A=$!

export DATA_DIR=data-b
export PORT=3002
export API_SECRET=demo-secret-b
npm run dev > data-b/runtime.log 2>&1 &
PID_B=$!

wait_for_health http://127.0.0.1:3001/health
wait_for_health http://127.0.0.1:3002/health
printf 'Both runtimes are healthy.\n\n'

printf '== Step 5: A invites B ==\n'
export DATA_DIR=data-a
A_INVITE=$(run_json npm run dev -- agent-comm:connect:invite "$CONTACT_B_ON_A")
printf '%s\n\n' "$A_INVITE"

printf 'Waiting for B to process the invite...\n'
sleep 5

printf '== Step 6: B accepts A ==\n'
export DATA_DIR=data-b
B_ACCEPT=$(run_json npm run dev -- agent-comm:connect:accept "$CONTACT_A_ON_B")
printf '%s\n\n' "$B_ACCEPT"

printf 'Waiting for A to observe the acceptance...\n'
sleep 5

printf '== Step 7: inspect contact state ==\n'
export DATA_DIR=data-a
npm run dev -- agent-comm:contacts:list
printf '\n'
export DATA_DIR=data-b
npm run dev -- agent-comm:contacts:list
printf '\n'

printf '== Step 8: trusted business send using contact:<contactId> ==\n'
export DATA_DIR=data-a
A_PING=$(run_json npm run dev -- agent-comm:send ping "contact:${CONTACT_B_ON_A}" --echo "hello from A" --note "agent-comm-v2-demo")
printf '%s\n\n' "$A_PING"

printf 'Waiting for B to receive the ping...\n'
sleep 5

printf '== Step 9: query messages ==\n'
printf '\n-- A outbound messages --\n'
curl -fsS "http://127.0.0.1:3001/api/v1/agent-comm/messages?limit=10&direction=outbound" || true
printf '\n\n-- B inbound messages --\n'
curl -fsS "http://127.0.0.1:3002/api/v1/agent-comm/messages?limit=10&direction=inbound" || true
printf '\n\nDone. Data remains in data-a/ and data-b/.\n'
printf 'Use ./scripts/agent-comm-demo.sh clean to reset.\n'
