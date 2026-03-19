#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${ALPHAOS_BASE_URL:-http://127.0.0.1:3000}"
OUT_DIR="${ALPHAOS_DEMO_OUT_DIR:-demo-output}"
SEED="${ALPHAOS_REPLAY_SEED:-demo-$(date +%s)}"
WAIT_SECONDS="${ALPHAOS_SIGNAL_WAIT_SECONDS:-8}"

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
JSON_OUT="$OUT_DIR/demo-$STAMP.json"
CSV_OUT="$OUT_DIR/backtest-$STAMP.csv"

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

echo "[1/7] health check"
request GET /health > /dev/null

echo "[2/7] set strategy profile AB"
request POST /api/v1/strategies/profile '{"strategyId":"dex-arbitrage","variant":"B","params":{"notionalMultiplier":1.25,"minNetEdgeBpsPaper":35}}' > /dev/null

echo "[3/7] force paper mode"
request POST /api/v1/engine/mode '{"mode":"paper"}' > /dev/null

echo "[4/7] wait ${WAIT_SECONDS}s for engine ticks"
sleep "$WAIT_SECONDS"

echo "[5/7] capture metrics + share + strategy status + integration"
{
  echo '{'
  echo '  "capturedAt": "'"$(date -Is)"'",'
  echo '  "baseUrl": "'"$BASE_URL"'",'
  echo '  "metrics":'
  request GET /api/v1/metrics/today
  echo ','
  echo '  "strategies":'
  request GET /api/v1/strategies/status
  echo ','
  echo '  "share":'
  request GET /api/v1/growth/share/latest || echo '{"error":"share unavailable"}'
  echo ','
  echo '  "moments":'
  request GET /api/v1/growth/moments?limit=5 || echo '{"error":"moments unavailable"}'
  echo ','
  echo '  "integration":'
  request GET /api/v1/integration/execution/status || echo '{"error":"integration status unavailable"}'
  echo ','
  echo '  "replay":'
  request POST /api/v1/replay/sandbox "{\"seed\":\"$SEED\",\"hours\":24,\"mode\":\"paper\"}"
  echo '}'
} > "$JSON_OUT"

echo "[6/7] export backtest csv"
curl -sS "$BASE_URL/api/v1/backtest/snapshot?hours=24&format=csv" > "$CSV_OUT"

echo "[7/7] done"
echo "json: $JSON_OUT"
echo "csv:  $CSV_OUT"

if [[ "${ALPHAOS_TRY_LIVE:-false}" == "true" ]]; then
  echo "[optional] request live mode"
  request POST /api/v1/engine/mode '{"mode":"live"}'
  echo
fi
