import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type { CosyVoiceTTSProviderConfig, TTSOptions, TTSProvider, TTSResult } from "./types";

const DEFAULT_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const DEFAULT_MODEL = "cosyvoice-v2";
const DEFAULT_VOICE = "longxiaochun_v2";
const DEFAULT_FORMAT = "mp3";
const DEFAULT_SAMPLE_RATE = 22050;
const DEFAULT_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;
type CosyVoiceFormat = "mp3" | "wav" | "pcm";

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function normalizeFormat(format: string): CosyVoiceFormat {
  const lower = format.trim().toLowerCase();
  if (lower === "wav" || lower === "pcm") {
    return lower;
  }
  return "mp3";
}

function normalizeRate(speed: number | undefined): number {
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0) {
    return 1;
  }
  return Number(speed.toFixed(3));
}

function estimateDurationSeconds(audioBytes: number): number {
  return Number((audioBytes / 2_000).toFixed(2));
}

function isReferenceAudioUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function rawDataToBuffer(data: RawData): Buffer {
  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.alloc(0);
}

function parseJsonMessage(data: RawData): JsonRecord | undefined {
  const rawText = rawDataToBuffer(data).toString("utf8").trim();
  if (!rawText) {
    return undefined;
  }
  try {
    return JSON.parse(rawText) as JsonRecord;
  } catch {
    return undefined;
  }
}

function pickError(payload: JsonRecord | undefined): string | undefined {
  const output = asRecord(payload?.output);
  return (
    optionalText(payload?.message) ??
    optionalText(output?.message) ??
    optionalText(payload?.code) ??
    optionalText(output?.code)
  );
}

export class CosyVoiceTTSProvider implements TTSProvider {
  public readonly name = "cosyvoice";
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultVoice: string;
  private readonly defaultFormat: CosyVoiceFormat;

  constructor(config: CosyVoiceTTSProviderConfig) {
    this.endpoint = optionalText(config.endpoint) ?? DEFAULT_ENDPOINT;
    this.apiKey = config.apiKey.trim();
    this.model = optionalText(config.model) ?? DEFAULT_MODEL;
    this.defaultVoice = optionalText(config.defaultVoice) ?? DEFAULT_VOICE;
    this.defaultFormat = normalizeFormat(config.defaultFormat ?? DEFAULT_FORMAT);
  }

  async synthesize(text: string, options: TTSOptions = {}): Promise<TTSResult> {
    const input = text.trim();
    if (!input) {
      throw new Error(`[${this.name}] text input cannot be empty`);
    }

    const voice = optionalText(options.voice) ?? this.defaultVoice;
    if (isReferenceAudioUrl(voice)) {
      throw new Error(
        `[${this.name}] reference audio URL is not supported yet, create a voice name via voice cloning API first`,
      );
    }

    const format = normalizeFormat(optionalText(options.format) ?? this.defaultFormat);
    const rate = normalizeRate(options.speed);
    const taskId = randomUUID();
    const audioChunks: Buffer[] = [];

    return new Promise<TTSResult>((resolve, reject) => {
      const ws = new WebSocket(this.endpoint, {
        headers: {
          Authorization: `bearer ${this.apiKey}`,
        },
      });

      let settled = false;
      let taskStarted = false;
      let taskFinished = false;

      const timeout = setTimeout(() => {
        fail(`request timed out after ${DEFAULT_TIMEOUT_MS}ms`);
      }, DEFAULT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        ws.removeAllListeners();
      };

      const closeSocket = () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };

      const fail = (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        closeSocket();
        reject(new Error(`[${this.name}] ${message}`));
      };

      const succeed = () => {
        if (settled) {
          return;
        }
        const audio = Buffer.concat(audioChunks);
        if (audio.byteLength === 0) {
          fail("task finished without audio data");
          return;
        }

        settled = true;
        cleanup();
        closeSocket();
        resolve({
          audio,
          format,
          durationSeconds: estimateDurationSeconds(audio.byteLength),
          provider: this.name,
          generatedAt: new Date().toISOString(),
        });
      };

      const sendCommand = (action: "run-task" | "continue-task" | "finish-task", payload: JsonRecord): boolean => {
        try {
          ws.send(
            JSON.stringify({
              header: {
                action,
                task_id: taskId,
                streaming: "duplex",
              },
              payload,
            }),
          );
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          fail(`failed to send ${action}: ${message}`);
          return false;
        }
      };

      ws.on("open", () => {
        sendCommand("run-task", {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: this.model,
          parameters: {
            text_type: "PlainText",
            voice,
            format,
            sample_rate: DEFAULT_SAMPLE_RATE,
            volume: 50,
            rate,
            pitch: 1,
          },
          input: {},
        });
      });

      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          const chunk = rawDataToBuffer(data);
          if (chunk.byteLength > 0) {
            audioChunks.push(chunk);
          }
          return;
        }

        const message = parseJsonMessage(data);
        if (!message) {
          return;
        }

        const header = asRecord(message.header);
        const event = optionalText(header?.event);

        if (event === "task-started") {
          if (taskStarted) {
            return;
          }
          taskStarted = true;
          const continued = sendCommand("continue-task", {
            input: {
              text: input,
            },
          });
          if (continued) {
            sendCommand("finish-task", {
              input: {},
            });
          }
          return;
        }

        if (event === "task-failed") {
          const detail = pickError(asRecord(message.payload));
          fail(`task failed${detail ? `: ${detail}` : ""}`);
          return;
        }

        if (event === "task-finished") {
          taskFinished = true;
          succeed();
        }
      });

      ws.on("error", (error: Error) => {
        fail(`connection error: ${error.message}`);
      });

      ws.on("close", (code: number, reason: Buffer) => {
        if (settled) {
          return;
        }
        const reasonText = optionalText(reason.toString("utf8"));
        const suffix = reasonText ? `: ${reasonText}` : "";
        if (!taskStarted) {
          fail(`connection closed before task-started (code ${code})${suffix}`);
          return;
        }
        if (!taskFinished) {
          fail(`connection closed before task-finished (code ${code})${suffix}`);
          return;
        }
        fail(`connection closed unexpectedly (code ${code})${suffix}`);
      });
    });
  }
}
