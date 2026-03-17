import fs from "node:fs";
import path from "node:path";
import { defaultContactPolicyConfig, type ContactPolicyConfig, type UserContext } from "../src/skills/alphaos/living-assistant/contact-policy";
import { TelegramVoiceSender, type DeliveryExecutorConfig } from "../src/skills/alphaos/living-assistant/delivery";
import { runLivingAssistantLoop } from "../src/skills/alphaos/living-assistant/loop";
import { normalizeSignal, pollBinanceAnnouncements, type NormalizedSignal } from "../src/skills/alphaos/living-assistant/signal-radar";
import { createTTSProvider, type TTSOptions, type TTSProvider } from "../src/skills/alphaos/living-assistant/tts";

interface DemoScenarioFixture {
  name: string;
  description: string;
  signal: unknown;
  userContext: UserContext;
  policyConfig?: Partial<ContactPolicyConfig>;
}

interface LoadedDemoScenario {
  name: string;
  description: string;
  signal: NormalizedSignal;
  userContext: UserContext;
  policyConfig?: Partial<ContactPolicyConfig>;
}

interface DemoCliOptions {
  live: boolean;
  dryRun: boolean;
  send: boolean;
}

interface DemoRuntime {
  ttsProvider?: TTSProvider;
  ttsOptions?: TTSOptions;
  deliveryExecutor?: DeliveryExecutorConfig;
}

interface LoopScenarioInput {
  name: string;
  description: string;
  signal: NormalizedSignal;
  userContext: UserContext;
  policyConfig?: Partial<ContactPolicyConfig>;
}

const LIVE_CONTEXT_SCENARIO = "proactive-arbitrage-alert";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSafeFileName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function loadDemoScenarios(
  fixtureDir = path.resolve(process.cwd(), "fixtures", "demo-scenarios"),
): LoadedDemoScenario[] {
  const files = fs
    .readdirSync(fixtureDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  return files.map((fileName) => {
    const filePath = path.resolve(fixtureDir, fileName);
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Invalid scenario payload: ${fileName}`);
    }

    const fixture = parsed as unknown as DemoScenarioFixture;
    const scenarioName =
      typeof fixture.name === "string" && fixture.name.trim()
        ? fixture.name.trim()
        : fileName.replace(/\.json$/i, "");

    return {
      name: scenarioName,
      description: typeof fixture.description === "string" ? fixture.description : "",
      signal: normalizeSignal(fixture.signal as never),
      userContext: fixture.userContext,
      policyConfig: fixture.policyConfig,
    };
  });
}

function formatDurationMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function printUsageAndExit(): never {
  console.log("Usage: npm run demo:living-assistant -- [--live] [--dry-run|--send]");
  console.log("");
  console.log("Flags:");
  console.log("  --live     Poll real Binance announcements and run one loop per signal");
  console.log("  --dry-run  Print decision/brief only (default)");
  console.log("  --send     Run real delivery (requires TTS and Telegram env vars)");
  process.exit(0);
}

function parseCliOptions(argv = process.argv.slice(2)): DemoCliOptions {
  const knownFlags = new Set(["--live", "--dry-run", "--send", "--help", "-h"]);
  for (const arg of argv) {
    if (!knownFlags.has(arg)) {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    printUsageAndExit();
  }

  const send = argv.includes("--send");
  const dryRunFlag = argv.includes("--dry-run");
  if (send && dryRunFlag) {
    throw new Error("Cannot combine --send and --dry-run");
  }

  return {
    live: argv.includes("--live"),
    dryRun: !send,
    send,
  };
}

function buildOptionalTTS(): DemoRuntime {
  const baseUrl = process.env.TTS_BASE_URL?.trim();
  const apiKey = process.env.TTS_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    return {};
  }

  const model = process.env.TTS_MODEL?.trim() || undefined;
  const voice = process.env.TTS_VOICE?.trim() || undefined;
  return {
    ttsProvider: createTTSProvider({
      type: "openai-compatible",
      baseUrl,
      apiKey,
      model,
      defaultVoice: voice,
      defaultFormat: "mp3",
    }),
    ttsOptions: {
      format: "mp3",
      ...(voice ? { voice } : {}),
    },
  };
}

function buildSendRuntime(): DemoRuntime {
  const runtime = buildOptionalTTS();
  if (!runtime.ttsProvider) {
    throw new Error("--send requires TTS_BASE_URL and TTS_API_KEY");
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) {
    throw new Error("--send requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  }

  runtime.deliveryExecutor = {
    telegramSender: new TelegramVoiceSender({
      botToken,
      chatId,
    }),
  };
  return runtime;
}

function resolveLiveContext(
  scenarios: LoadedDemoScenario[],
): Pick<LoadedDemoScenario, "userContext" | "policyConfig"> {
  const preferred = scenarios.find((scenario) => scenario.name === LIVE_CONTEXT_SCENARIO);
  if (preferred) {
    return {
      userContext: preferred.userContext,
      policyConfig: preferred.policyConfig,
    };
  }

  const fallback = scenarios[0];
  if (!fallback) {
    throw new Error("At least one fixture scenario is required to provide userContext for --live mode");
  }

  return {
    userContext: fallback.userContext,
    policyConfig: fallback.policyConfig,
  };
}

async function runLoopScenario(
  scenario: LoopScenarioInput,
  runtime: DemoRuntime,
  demoMode: boolean,
  outputDir?: string,
): Promise<{ briefGenerated: boolean; audioWritten: boolean; loopTotalMs: number }> {
  const loopOutput = await runLivingAssistantLoop({
    signal: scenario.signal,
    userContext: scenario.userContext,
    policyConfig: {
      ...defaultContactPolicyConfig,
      ...(scenario.policyConfig ?? {}),
    },
    demoMode,
    ...(runtime.ttsProvider ? { ttsProvider: runtime.ttsProvider, ttsOptions: runtime.ttsOptions } : {}),
    ...(runtime.deliveryExecutor ? { deliveryExecutor: runtime.deliveryExecutor } : {}),
  });

  console.log(`Signal: source=${loopOutput.signal.source}, type=${loopOutput.signal.type}, title=${loopOutput.signal.title}, urgency=${loopOutput.signal.urgency}`);
  console.log(
    `Decision: attentionLevel=${loopOutput.decision.attentionLevel}, shouldContact=${loopOutput.decision.shouldContact}, reason=${loopOutput.decision.reason}, channels=${loopOutput.decision.channels.join("|") || "none"}`,
  );

  if (loopOutput.brief?.text) {
    console.log(`Brief: ${loopOutput.brief.text}`);
  } else {
    console.log("Brief: not generated");
  }

  let audioWritten = false;
  if (loopOutput.audio && outputDir) {
    const filePath = path.resolve(outputDir, `${toSafeFileName(`${scenario.name}-${loopOutput.signal.signalId}`)}.mp3`);
    fs.writeFileSync(filePath, loopOutput.audio.audio);
    audioWritten = true;
    console.log(`Audio file: ${filePath}`);
  }

  if (!loopOutput.audio) {
    console.log("Audio: not generated");
  }

  if (!demoMode) {
    console.log(`Delivery: ${JSON.stringify(loopOutput.delivery ?? null)}`);
  }

  console.log(
    `Timing: policy=${formatDurationMs(loopOutput.timings.policyMs)}, brief=${formatDurationMs(loopOutput.timings.briefMs)}, tts=${formatDurationMs(loopOutput.timings.ttsMs)}, delivery=${formatDurationMs(loopOutput.timings.deliveryMs)}, total=${formatDurationMs(loopOutput.timings.totalMs)}`,
  );
  console.log(`Loop status: demoMode=${loopOutput.demoMode}, loopCompletedAt=${loopOutput.loopCompletedAt}`);

  return {
    briefGenerated: Boolean(loopOutput.brief),
    audioWritten,
    loopTotalMs: loopOutput.timings.totalMs,
  };
}

async function main(): Promise<void> {
  console.log("Personal Butler — Living Assistant Demo");
  const cli = parseCliOptions();
  console.log(`Mode: source=${cli.live ? "live" : "fixture"}, execution=${cli.send ? "send" : "dry-run"}`);

  const demoMode = cli.dryRun;
  const runtime = cli.send ? buildSendRuntime() : {};
  const outputDir = runtime.ttsProvider ? path.resolve(process.cwd(), "demo-output") : undefined;
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const scenarios = loadDemoScenarios();
  let runScenarios: LoopScenarioInput[] = [];
  let pollDurationMs: number | undefined;

  if (cli.live) {
    const liveContext = resolveLiveContext(scenarios);
    const pollStartedAt = performance.now();
    const pollResult = await pollBinanceAnnouncements();
    pollDurationMs = performance.now() - pollStartedAt;

    if (pollResult.error) {
      console.error(`Poll error: ${pollResult.error}`);
      process.exit(1);
    }

    console.log(
      `Live poll: fetchedAt=${pollResult.fetchedAt}, articleCount=${pollResult.articleCount}, newSignals=${pollResult.signals.length}, duration=${formatDurationMs(pollDurationMs)}`,
    );

    if (pollResult.signals.length === 0) {
      console.log("No new Binance announcement signals.");
      return;
    }

    runScenarios = pollResult.signals.map((signal, index) => ({
      name: `live-signal-${index + 1}`,
      description: `Binance announcement signal ${signal.signalId}`,
      signal,
      userContext: liveContext.userContext,
      policyConfig: liveContext.policyConfig,
    }));
  } else {
    runScenarios = cli.send
      ? scenarios.filter((scenario) => scenario.name === LIVE_CONTEXT_SCENARIO)
      : scenarios;

    if (cli.send && runScenarios.length !== 1) {
      throw new Error(`--send in fixture mode requires scenario fixture: ${LIVE_CONTEXT_SCENARIO}`);
    }
  }

  let briefsGenerated = 0;
  let audioFilesWritten = 0;
  let loopTotalMs = 0;

  for (const scenario of runScenarios) {
    console.log("");
    console.log(`Scenario: ${scenario.name}`);
    console.log(`Description: ${scenario.description}`);

    const runResult = await runLoopScenario(scenario, runtime, demoMode, outputDir);
    if (runResult.briefGenerated) {
      briefsGenerated += 1;
    }
    if (runResult.audioWritten) {
      audioFilesWritten += 1;
    }
    loopTotalMs += runResult.loopTotalMs;
  }

  console.log("");
  const summaryParts = [
    `${runScenarios.length} loops run`,
    `${briefsGenerated} briefs generated`,
    `${audioFilesWritten} audio files created`,
    `loopTotal=${formatDurationMs(loopTotalMs)}`,
  ];
  if (typeof pollDurationMs === "number") {
    summaryParts.push(`poll=${formatDurationMs(pollDurationMs)}`);
  }
  console.log(`Summary: ${summaryParts.join(", ")}`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
