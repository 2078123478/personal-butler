import type { CosyVoiceTTSProviderConfig, TTSOptions, TTSProvider, TTSResult } from "./types";

const DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const DEFAULT_MODEL = "cosyvoice-v2";
const DEFAULT_VOICE = "longxiaochun";
const DEFAULT_FORMAT = "wav";

type JsonRecord = Record<string, unknown>;

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

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeFormat(format: string): "mp3" | "wav" | "ogg" {
  const lower = format.trim().toLowerCase();
  if (lower === "wav" || lower === "ogg") {
    return lower;
  }
  return "mp3";
}

function estimateDurationSeconds(audioBytes: number): number {
  return Number((audioBytes / 2_000).toFixed(2));
}

function inferFormatFromUrl(audioUrl: string): "mp3" | "wav" | "ogg" | undefined {
  try {
    const pathname = new URL(audioUrl).pathname.toLowerCase();
    if (pathname.endsWith(".wav")) {
      return "wav";
    }
    if (pathname.endsWith(".ogg")) {
      return "ogg";
    }
    if (pathname.endsWith(".mp3")) {
      return "mp3";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function decodeBase64Audio(value: unknown): Buffer | undefined {
  const encoded = optionalText(value);
  if (!encoded) {
    return undefined;
  }

  try {
    const audio = Buffer.from(encoded, "base64");
    return audio.byteLength > 0 ? audio : undefined;
  } catch {
    return undefined;
  }
}

function readAudioUrl(payload: JsonRecord | undefined): string | undefined {
  const output = asRecord(payload?.output);
  const outputAudio = asRecord(output?.audio);
  const topLevelAudio = asRecord(payload?.audio);

  return (
    optionalText(outputAudio?.url) ??
    optionalText(output?.audio_url) ??
    optionalText(output?.audioUrl) ??
    optionalText(topLevelAudio?.url) ??
    optionalText(payload?.audio_url) ??
    optionalText(payload?.audioUrl)
  );
}

function readAudioBytes(payload: JsonRecord | undefined): Buffer | undefined {
  const output = asRecord(payload?.output);
  const outputAudio = asRecord(output?.audio);
  const topLevelAudio = asRecord(payload?.audio);

  return (
    decodeBase64Audio(outputAudio?.data) ??
    decodeBase64Audio(outputAudio?.audio_data) ??
    decodeBase64Audio(output?.audio_data) ??
    decodeBase64Audio(topLevelAudio?.data) ??
    decodeBase64Audio(payload?.audio_data)
  );
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

function isReferenceAudioUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export class CosyVoiceTTSProvider implements TTSProvider {
  public readonly name = "cosyvoice";
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultVoice: string;
  private readonly defaultFormat: "mp3" | "wav" | "ogg";

  constructor(config: CosyVoiceTTSProviderConfig) {
    this.endpoint = trimTrailingSlashes(optionalText(config.endpoint) ?? DEFAULT_ENDPOINT);
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
    const requestBody: JsonRecord = {
      model: this.model,
      input: {
        text: input,
        ...(isReferenceAudioUrl(voice) ? { reference_audio: voice } : { voice }),
      },
    };

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[${this.name}] request failed: ${message}`);
    }

    const rawBody = await response
      .text()
      .then((value) => value.trim())
      .catch(() => "");
    const payload = rawBody
      ? (() => {
          try {
            return JSON.parse(rawBody) as JsonRecord;
          } catch {
            return undefined;
          }
        })()
      : undefined;

    if (!response.ok) {
      const detail = pickError(payload) ?? rawBody;
      const suffix = detail ? ` - ${detail}` : "";
      throw new Error(`[${this.name}] HTTP ${response.status} ${response.statusText}${suffix}`);
    }

    const audio = readAudioBytes(payload);
    const audioUrl = readAudioUrl(payload);
    if (!audio && !audioUrl) {
      throw new Error(`[${this.name}] response does not include audio bytes or audio URL`);
    }

    const format =
      inferFormatFromUrl(audioUrl ?? "") ??
      normalizeFormat(optionalText(options.format) ?? this.defaultFormat);

    return {
      ...(audio ? { audio } : {}),
      ...(audioUrl ? { audioUrl } : {}),
      format,
      durationSeconds: audio ? estimateDurationSeconds(audio.byteLength) : 0,
      provider: this.name,
      generatedAt: new Date().toISOString(),
    };
  }
}
