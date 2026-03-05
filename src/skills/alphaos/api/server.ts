import express from "express";
import type { AlphaEngine } from "../engine/alpha-engine";
import { OnchainOsClient } from "../runtime/onchainos-client";
import { StateStore } from "../runtime/state-store";
import { SandboxReplayService } from "../runtime/sandbox-replay";
import type { BacktestSnapshotRow, RiskPolicy, SkillManifest } from "../types";

function toLimit(input: unknown, fallback: number): number {
  const parsed = Number(input ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function toHours(input: unknown, fallback: number): number {
  const parsed = Number(input ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(24 * 30, Math.floor(parsed)));
}

function csvEscape(value: unknown): string {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(rows: BacktestSnapshotRow[]): string {
  const headers = [
    "strategyId",
    "opportunities",
    "planned",
    "executed",
    "failed",
    "rejected",
    "avgEstimatedNetUsd",
    "realizedNetUsd",
    "tradeWinRate",
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.strategyId,
        row.opportunities,
        row.planned,
        row.executed,
        row.failed,
        row.rejected,
        row.avgEstimatedNetUsd.toFixed(6),
        row.realizedNetUsd.toFixed(6),
        row.tradeWinRate.toFixed(6),
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function demoHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AlphaOS Live Demo</title>
  <style>
    :root {
      --bg: radial-gradient(circle at 10% 20%, #0f172a 0%, #111827 38%, #041022 100%);
      --card: rgba(255, 255, 255, 0.08);
      --line: rgba(255, 255, 255, 0.22);
      --text: #f8fafc;
      --muted: #94a3b8;
      --ok: #34d399;
      --warn: #fb923c;
      --bad: #f87171;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      padding: 24px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 14px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--card);
      backdrop-filter: blur(4px);
      padding: 14px;
    }
    h1 { margin: 0 0 14px; font-size: 24px; }
    h2 { margin: 0 0 8px; font-size: 15px; color: var(--muted); }
    .kpi { font-size: 28px; font-weight: 700; color: var(--ok); }
    pre {
      margin: 0;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      color: #dbeafe;
    }
    .feed { max-height: 280px; overflow: auto; }
    .chip { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 8px; margin:0 4px 4px 0; font-size:12px; }
    .warn { color: var(--warn); }
    .status.available { color: var(--ok); }
    .status.restricted { color: var(--warn); }
    .status.degraded { color: var(--bad); }
    .meta { margin-top: 8px; font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
  <h1>AlphaOS Championship Console</h1>
  <div class="grid">
    <div class="card"><h2>Today Net PnL</h2><div id="net" class="kpi">0.00</div></div>
    <div class="card"><h2>Trades</h2><div id="trades" class="kpi">0</div></div>
    <div class="card"><h2>Opportunities</h2><div id="opps" class="kpi">0</div></div>
    <div class="card"><h2>Mode</h2><div id="mode" class="kpi warn">paper</div></div>
    <div class="card">
      <h2>Official Link</h2>
      <div id="official-status" class="kpi status degraded">降级</div>
      <div id="official-hint" class="meta">Probe pending...</div>
    </div>
  </div>

  <div class="grid" style="margin-top:14px;">
    <div class="card">
      <h2>Strategy Leaderboard</h2>
      <div id="strategies"></div>
    </div>
    <div class="card">
      <h2>Latest Share Card</h2>
      <pre id="share">No successful trade yet</pre>
    </div>
    <div class="card">
      <h2>OnchainOS v6 Probe</h2>
      <pre id="probe">Probe pending...</pre>
    </div>
    <div class="card feed">
      <h2>Live Stream Feed</h2>
      <pre id="feed"></pre>
    </div>
  </div>

  <script>
    const el = {
      net: document.getElementById("net"),
      trades: document.getElementById("trades"),
      opps: document.getElementById("opps"),
      mode: document.getElementById("mode"),
      officialStatus: document.getElementById("official-status"),
      officialHint: document.getElementById("official-hint"),
      strategies: document.getElementById("strategies"),
      share: document.getElementById("share"),
      probe: document.getElementById("probe"),
      feed: document.getElementById("feed"),
    };

    const OFFICIAL_LABEL = {
      available: "可用",
      restricted: "受限",
      degraded: "降级",
    };

    function isV6Path(path) {
      return typeof path === "string" && path.startsWith("/api/v6/");
    }

    function includesRestrictedHint(text) {
      const value = String(text || "").toLowerCase();
      return (
        value.includes("whitelist") ||
        value.includes("permission") ||
        value.includes("unauthorized") ||
        value.includes("forbidden") ||
        value.includes("restricted") ||
        value.includes("403") ||
        value.includes("401")
      );
    }

    function classifyOfficialStatus(probe, integration, statusCode) {
      const message = probe && typeof probe === "object" ? probe.message : "";
      const restricted = includesRestrictedHint(message) || includesRestrictedHint(integration && integration.lastError);

      const probePaths = [
        probe && probe.quotePath,
        probe && probe.swapPath,
        probe && probe.simulatePath,
      ].filter((path) => typeof path === "string" && path.length > 0);
      const fallbackByProbe = probePaths.some((path) => !isV6Path(path));
      const fallbackByStatus = integration && typeof integration.lastUsedPath === "string" && !isV6Path(integration.lastUsedPath);

      if (probe && probe.ok === true && !fallbackByProbe && !fallbackByStatus) {
        return "available";
      }
      if (restricted || statusCode === 401 || statusCode === 403) {
        return "restricted";
      }
      return "degraded";
    }

    function renderOfficialStatus(level) {
      el.officialStatus.textContent = OFFICIAL_LABEL[level];
      el.officialStatus.className = "kpi status " + level;
      el.officialHint.textContent =
        level === "available"
          ? "官方 v6 链路可用"
          : level === "restricted"
            ? "权限受限，建议核验白名单与 API 权限"
            : "官方链路受阻，按降级路径运行";
    }

    async function refreshProbe() {
      const requestedAt = new Date().toISOString();
      try {
        const [integrationResp, probeResp] = await Promise.all([
          fetch("/api/v1/integration/onchainos/status"),
          fetch("/api/v1/integration/onchainos/probe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pair: "ETH/USDC", chainIndex: "196", notionalUsd: 25 }),
          }),
        ]);
        const integration = integrationResp.ok ? await integrationResp.json() : null;
        const probe = await probeResp.json();
        const level = classifyOfficialStatus(probe, integration, probeResp.status);
        renderOfficialStatus(level);
        el.probe.textContent = JSON.stringify(
          {
            officialStatus: level,
            checkedAt: probe.checkedAt || requestedAt,
            integration,
            probe,
          },
          null,
          2,
        );
      } catch (error) {
        renderOfficialStatus("degraded");
        el.probe.textContent = JSON.stringify(
          {
            officialStatus: "degraded",
            checkedAt: requestedAt,
            error: String(error),
          },
          null,
          2,
        );
      }
    }

    refreshProbe();
    setInterval(refreshProbe, 30000);

    const stream = new EventSource("/api/v1/stream/metrics");
    stream.onmessage = (evt) => {
      const data = JSON.parse(evt.data);
      el.net.textContent = Number(data.metrics.netUsd || 0).toFixed(2);
      el.trades.textContent = String(data.metrics.trades || 0);
      el.opps.textContent = String(data.metrics.opportunities || 0);
      el.mode.textContent = data.mode;
      el.mode.className = "kpi " + (data.mode === "live" ? "" : "warn");

      const chips = (data.strategies || [])
        .map((s) => '<span class="chip">' + s.strategyId + ': ' + Number(s.netUsd || 0).toFixed(2) + '</span>')
        .join("");
      el.strategies.innerHTML = chips || "<span class='warn'>No strategy stats yet</span>";

      if (data.share) {
        el.share.textContent = data.share.text;
      }

      const line = "[" + new Date().toISOString() + "] net=" + Number(data.metrics.netUsd || 0).toFixed(2) + " trades=" + data.metrics.trades + " mode=" + data.mode;
      el.feed.textContent = (line + "\n" + el.feed.textContent).slice(0, 6000);
    };
  </script>
</body>
</html>`;
}

export function createServer(
  engine: AlphaEngine,
  store: StateStore,
  manifest: SkillManifest,
  options?: { defaultRiskPolicy?: RiskPolicy; onchainClient?: OnchainOsClient },
) {
  const app = express();
  app.use(express.json({ limit: "512kb" }));
  const replay = new SandboxReplayService(store, options?.defaultRiskPolicy ?? {
    minNetEdgeBpsPaper: 45,
    minNetEdgeBpsLive: 60,
    maxTradePctBalance: 0.03,
    maxDailyLossPct: 0.015,
    maxConsecutiveFailures: 3,
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, mode: engine.getCurrentMode(), service: "alphaos", strategies: manifest.strategyIds });
  });

  app.get("/demo", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(demoHtml());
  });

  app.get("/api/v1/manifest", (_req, res) => {
    res.json(manifest);
  });

  app.get("/api/v1/integration/onchainos/status", (_req, res) => {
    if (!options?.onchainClient) {
      res.status(503).json({ error: "onchain client unavailable" });
      return;
    }
    res.json(options.onchainClient.getIntegrationStatus());
  });

  app.post("/api/v1/integration/onchainos/probe", async (req, res) => {
    if (!options?.onchainClient) {
      res.status(503).json({ error: "onchain client unavailable" });
      return;
    }

    const pair = typeof req.body?.pair === "string" ? req.body.pair.trim().toUpperCase() : undefined;
    const chainIndex = typeof req.body?.chainIndex === "string" ? req.body.chainIndex.trim() : undefined;
    const userWalletAddress =
      typeof req.body?.userWalletAddress === "string" ? req.body.userWalletAddress.trim() : undefined;
    const notionalRaw = Number(req.body?.notionalUsd);
    const notionalUsd = Number.isFinite(notionalRaw) ? notionalRaw : undefined;

    const result = await options.onchainClient.probeConnection({
      pair,
      chainIndex,
      userWalletAddress,
      notionalUsd,
    });
    res.status(result.ok ? 200 : 503).json(result);
  });

  app.get("/api/v1/integration/onchainos/token-cache", (req, res) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol.trim().toUpperCase() : undefined;
    const chainIndex = typeof req.query.chainIndex === "string" ? req.query.chainIndex.trim() : undefined;
    const limit = toLimit(req.query.limit, 100);
    res.json({
      items: store.listTokenCache(limit, symbol, chainIndex),
    });
  });

  app.get("/api/v1/stream/metrics", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = () => {
      const payload = {
        mode: engine.getCurrentMode(),
        metrics: store.getTodayMetrics(),
        strategies: store.listStrategyStatusToday(),
        share: store.getLatestShareCard(),
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send();
    const timer = setInterval(send, 1000);
    req.on("close", () => {
      clearInterval(timer);
      res.end();
    });
  });

  app.post("/api/v1/engine/mode", (req, res) => {
    const mode = req.body?.mode;
    if (mode !== "paper" && mode !== "live") {
      res.status(400).json({ error: "mode must be paper or live" });
      return;
    }
    const result = engine.requestMode(mode);
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.get("/api/v1/metrics/today", (_req, res) => {
    res.json(store.getTodayMetrics());
  });

  app.get("/api/v1/strategies/status", (_req, res) => {
    res.json({ items: store.listStrategyStatusToday() });
  });

  app.get("/api/v1/strategies/profiles", (_req, res) => {
    res.json({ items: store.listStrategyProfiles() });
  });

  app.post("/api/v1/strategies/profile", (req, res) => {
    const strategyId = String(req.body?.strategyId ?? "").trim();
    const variant = req.body?.variant === "B" ? "B" : "A";
    const params = req.body?.params;

    if (!strategyId) {
      res.status(400).json({ error: "strategyId is required" });
      return;
    }

    if (!params || typeof params !== "object" || Array.isArray(params)) {
      res.status(400).json({ error: "params must be an object" });
      return;
    }

    store.upsertStrategyProfile(strategyId, variant, params as Record<string, unknown>);
    res.status(200).json({ ok: true, strategyId, variant });
  });

  app.get("/api/v1/opportunities", (req, res) => {
    const limit = toLimit(req.query.limit, 50);
    res.json({ items: store.listOpportunities(limit) });
  });

  app.get("/api/v1/trades", (req, res) => {
    const limit = toLimit(req.query.limit, 50);
    res.json({ items: store.listTrades(limit) });
  });

  app.get("/api/v1/growth/share/latest", (_req, res) => {
    const card = store.getLatestShareCard();
    if (!card) {
      res.status(404).json({ error: "no successful trade yet" });
      return;
    }
    res.json(card);
  });

  app.get("/api/v1/backtest/snapshot", (req, res) => {
    const hours = toHours(req.query.hours, 24);
    const format = String(req.query.format ?? "json");
    const rows = store.getBacktestSnapshot(hours);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="alphaos-backtest-${hours}h.csv"`);
      res.send(toCsv(rows));
      return;
    }

    res.json({ hours, generatedAt: new Date().toISOString(), rows });
  });

  app.post("/api/v1/replay/sandbox", (req, res) => {
    const seed = String(req.body?.seed ?? `seed-${Date.now()}`);
    const mode = req.body?.mode === "live" ? "live" : "paper";
    const hours = toHours(req.body?.hours, 24);
    const strategyIdRaw = req.body?.strategyId;
    const strategyId = typeof strategyIdRaw === "string" && strategyIdRaw.trim() ? strategyIdRaw.trim() : undefined;
    const minEdgeRaw = req.body?.minEdgeBpsOverride;
    const minEdgeBpsOverride = Number.isFinite(Number(minEdgeRaw)) ? Number(minEdgeRaw) : undefined;

    const result = replay.run({
      seed,
      mode,
      hours,
      strategyId,
      minEdgeBpsOverride,
    });
    res.json(result);
  });

  app.post("/api/v1/signals/whale", (req, res) => {
    const wallet = String(req.body?.wallet ?? "").trim();
    const token = String(req.body?.token ?? "").trim();
    const side = req.body?.side;
    const sizeUsd = Number(req.body?.sizeUsd);
    const confidence = Number(req.body?.confidence);
    const sourceTxHash = req.body?.sourceTxHash ? String(req.body.sourceTxHash) : undefined;

    if (!wallet || !token || (side !== "buy" && side !== "sell")) {
      res.status(400).json({ error: "wallet, token, side are required" });
      return;
    }

    if (
      !Number.isFinite(sizeUsd) ||
      sizeUsd <= 0 ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      res.status(400).json({ error: "sizeUsd must be > 0 and confidence must be in [0,1]" });
      return;
    }

    const id = store.insertWhaleSignal({
      wallet,
      token,
      side,
      sizeUsd,
      confidence,
      sourceTxHash,
    });

    res.status(202).json({ accepted: true, signalId: id });
  });

  app.get("/api/v1/signals/whale", (req, res) => {
    const rawStatus = String(req.query.status ?? "all");
    const status =
      rawStatus === "pending" || rawStatus === "consumed" || rawStatus === "ignored" || rawStatus === "all"
        ? rawStatus
        : "all";
    const limit = toLimit(req.query.limit, 50);
    res.json({ items: store.listWhaleSignals(status, limit) });
  });

  return app;
}
