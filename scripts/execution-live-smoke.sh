#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${ALPHAOS_BASE_URL:-http://127.0.0.1:3000}"
OUT_DIR="${ALPHAOS_DEMO_OUT_DIR:-demo-output}"
PAIR="${ALPHAOS_PROBE_PAIR:-ETH/USDC}"
CHAIN_INDEX="${ALPHAOS_PROBE_CHAIN_INDEX:-196}"
NOTIONAL_USD="${ALPHAOS_PROBE_NOTIONAL_USD:-25}"
WALLET="${ALPHAOS_PROBE_WALLET:-0x1111111111111111111111111111111111111111}"

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
STATUS_JSON="$OUT_DIR/integration-status-$STAMP.json"
PROBE_JSON="$OUT_DIR/integration-probe-$STAMP.json"
REPORT_JSON="$OUT_DIR/integration-smoke-$STAMP.json"

request() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  if [[ -n "$data" ]]; then
    curl -sS -X "$method" "$BASE_URL$path" -H 'Content-Type: application/json' -d "$data"
  else
    curl -sS -X "$method" "$BASE_URL$path"
  fi
}

echo "[1/4] health check"
request GET /health > /dev/null

echo "[2/4] integration status"
request GET /api/v1/integration/execution/status > "$STATUS_JSON"

echo "[3/4] integration probe"
request POST /api/v1/integration/execution/probe \
  "{\"pair\":\"$PAIR\",\"chainIndex\":\"$CHAIN_INDEX\",\"notionalUsd\":$NOTIONAL_USD,\"userWalletAddress\":\"$WALLET\"}" \
  > "$PROBE_JSON"

echo "[4/4] merge report"
node - <<'NODE' "$STATUS_JSON" "$PROBE_JSON" "$REPORT_JSON"
const fs = require("node:fs");
const [statusPath, probePath, reportPath] = process.argv.slice(2);
const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
const report = {
  capturedAt: new Date().toISOString(),
  status,
  probe,
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
if (!probe.ok) {
  console.error("probe failed:", probe.message || "unknown error");
  process.exit(1);
}
NODE

echo "status: $STATUS_JSON"
echo "probe:  $PROBE_JSON"
echo "report: $REPORT_JSON"
