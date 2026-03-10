#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export NETWORK_PROFILE_ID=xlayer-recommended
export DATA_DIR=/home/wilsen/apps/apps/onchainos/data/agent-comm-mainnet-b
export VAULT_MASTER_PASSWORD=SGR8DHzCrZivdh3zhDlCqSPBbxUiINPN
export COMM_ENABLED=true
export COMM_LISTENER_MODE=poll
export COMM_POLL_INTERVAL_MS=3000
export LOG_LEVEL=info
export AGENT_COMM_PRIVATE_KEY=0xfc8860dc256df479eb0db8280ec6db2de0422c5fd363ad96d1ad64c1338a00c1
export PORT=3002

exec node --require ./node_modules/tsx/dist/preflight.cjs \
  --import "file://$(pwd)/node_modules/tsx/dist/loader.mjs" \
  src/index.ts
