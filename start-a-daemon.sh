#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

export NETWORK_PROFILE_ID=xlayer-recommended
export DATA_DIR=/home/wilsen/apps/apps/onchainos/data/agent-comm-mainnet-a
export VAULT_MASTER_PASSWORD=mPSjHESqweV72q_7fyqiVUcXq3xMX1GT
export COMM_ENABLED=true
export COMM_LISTENER_MODE=poll
export COMM_POLL_INTERVAL_MS=3000
export LOG_LEVEL=info
export AGENT_COMM_PRIVATE_KEY=0x0f2dc585d9cfef6c722ab4d0d5a41764814e6ae7d25fcf86d7ffc362ce7c4ecd
export PORT=3001

exec node --require ./node_modules/tsx/dist/preflight.cjs \
  --import "file://$(pwd)/node_modules/tsx/dist/loader.mjs" \
  src/index.ts
