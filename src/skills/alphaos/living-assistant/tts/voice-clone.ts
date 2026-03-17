const DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization";
const DEFAULT_MODEL = "voice-enrollment";
const DEFAULT_TARGET_MODEL = "cosyvoice-v2";
const DEFAULT_SAMPLE_RATE = 22050;
const DEFAULT_PAGE_INDEX = 0;
const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 30;

type JsonRecord = Record<string, unknown>;

export type CosyVoiceCloneStatus = "OK" | "DEPLOYING" | "UNDEPLOYED";

export interface CosyVoiceCloneServiceConfig {
  apiKey: string;
  endpoint?: string;
  model?: string;
  targetModel?: string;
  sampleRate?: number;
}

export interface CreateVoiceInput {
  prefix: string;
  audioUrl: string;
}

export interface CreateVoiceResult {
  voiceId: string;
  requestId?: string;
}

export interface DesignVoiceInput {
  prefix: string;
  voicePrompt: string;
  previewText: string;
}

export interface DesignVoiceResult extends CreateVoiceResult {
  previewAudioBase64: string;
}

export interface QueryVoiceResult {
  voiceId: string;
  status: CosyVoiceCloneStatus;
  requestId?: string;
}

export interface VoiceSummary {
  voiceId: string;
  status?: CosyVoiceCloneStatus | string;
  prefix?: string;
  raw: JsonRecord;
}

export interface ListVoicesResult {
  voices: VoiceSummary[];
  pageIndex: number;
  pageSize: number;
  totalCount?: number;
  requestId?: string;
}

export interface WaitForVoiceOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

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

function asRecordArray(value: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((item) => asRecord(item)).filter((item): item is JsonRecord => Boolean(item));
}

function optionalInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  return value;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function requireText(value: unknown, label: string): string {
  const normalized = optionalText(value);
  if (!normalized) {
    throw new Error(`[cosyvoice-clone] ${label} cannot be empty`);
  }
  return normalized;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`[cosyvoice-clone] ${label} must be a non-negative integer`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[cosyvoice-clone] ${label} must be a positive integer`);
  }
  return value;
}

function requireHttpUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`[cosyvoice-clone] ${label} must be a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`[cosyvoice-clone] ${label} must use http or https`);
  }
  return value;
}

function normalizeStatus(value: unknown): CosyVoiceCloneStatus | undefined {
  const normalized = optionalText(value)?.toUpperCase();
  if (normalized === "OK" || normalized === "DEPLOYING" || normalized === "UNDEPLOYED") {
    return normalized;
  }
  return undefined;
}

function pickError(payload: JsonRecord | undefined): string | undefined {
  const output = asRecord(payload?.output);
  const error = asRecord(payload?.error);
  return (
    optionalText(payload?.message) ??
    optionalText(output?.message) ??
    optionalText(error?.message) ??
    optionalText(payload?.code) ??
    optionalText(output?.code) ??
    optionalText(error?.code)
  );
}

function readRequestId(payload: JsonRecord | undefined): string | undefined {
  return optionalText(payload?.request_id) ?? optionalText(payload?.requestId);
}

function readVoiceId(payload: JsonRecord | undefined): string | undefined {
  const output = asRecord(payload?.output);
  return (
    optionalText(output?.voice_id) ??
    optionalText(output?.voiceId) ??
    optionalText(payload?.voice_id) ??
    optionalText(payload?.voiceId)
  );
}

function readPreviewAudioBase64(payload: JsonRecord | undefined): string | undefined {
  const output = asRecord(payload?.output);
  const outputAudio = asRecord(output?.audio);
  const previewAudio = asRecord(output?.preview_audio);
  return (
    optionalText(previewAudio?.data) ??
    optionalText(outputAudio?.data) ??
    optionalText(output?.preview_audio_base64) ??
    optionalText(output?.previewAudioBase64) ??
    optionalText(output?.audio_data) ??
    optionalText(payload?.preview_audio_base64) ??
    optionalText(payload?.audio_data)
  );
}

function mapVoiceSummary(record: JsonRecord): VoiceSummary | undefined {
  const voiceId = optionalText(record.voice_id) ?? optionalText(record.voiceId);
  if (!voiceId) {
    return undefined;
  }
  const status = normalizeStatus(record.status) ?? optionalText(record.status);
  const prefix = optionalText(record.prefix);
  return {
    voiceId,
    ...(status ? { status } : {}),
    ...(prefix ? { prefix } : {}),
    raw: record,
  };
}

function readVoiceSummaries(payload: JsonRecord | undefined): VoiceSummary[] {
  const output = asRecord(payload?.output);
  const candidates = [
    asRecordArray(output?.voices),
    asRecordArray(output?.voice_list),
    asRecordArray(output?.items),
    asRecordArray(payload?.voices),
  ];

  for (const candidate of candidates) {
    if (candidate && candidate.length > 0) {
      return candidate.map((item) => mapVoiceSummary(item)).filter((item): item is VoiceSummary => Boolean(item));
    }
  }

  return [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class CosyVoiceCloneService {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly targetModel: string;
  private readonly sampleRate: number;

  constructor(config: CosyVoiceCloneServiceConfig) {
    this.endpoint = trimTrailingSlashes(optionalText(config.endpoint) ?? DEFAULT_ENDPOINT);
    this.apiKey = requireText(config.apiKey, "apiKey");
    this.model = optionalText(config.model) ?? DEFAULT_MODEL;
    this.targetModel = optionalText(config.targetModel) ?? DEFAULT_TARGET_MODEL;
    this.sampleRate = requirePositiveInteger(config.sampleRate ?? DEFAULT_SAMPLE_RATE, "sampleRate");
  }

  async createVoice(input: CreateVoiceInput): Promise<CreateVoiceResult> {
    const prefix = requireText(input.prefix, "prefix");
    const audioUrl = requireHttpUrl(requireText(input.audioUrl, "audioUrl"), "audioUrl");
    const payload = await this.post(
      {
        action: "create_voice",
        target_model: this.targetModel,
        prefix,
        url: audioUrl,
      },
      {
        sample_rate: this.sampleRate,
      },
    );

    return {
      voiceId: this.requireVoiceId(payload, "createVoice"),
      requestId: readRequestId(payload),
    };
  }

  async designVoice(input: DesignVoiceInput): Promise<DesignVoiceResult> {
    const prefix = requireText(input.prefix, "prefix");
    const voicePrompt = requireText(input.voicePrompt, "voicePrompt");
    const previewText = requireText(input.previewText, "previewText");
    const payload = await this.post(
      {
        action: "create_voice",
        target_model: this.targetModel,
        prefix,
        voice_prompt: voicePrompt,
        preview_text: previewText,
      },
      {
        sample_rate: this.sampleRate,
      },
    );

    const previewAudioBase64 = readPreviewAudioBase64(payload);
    if (!previewAudioBase64) {
      throw new Error("[cosyvoice-clone] designVoice response does not include preview audio");
    }

    return {
      voiceId: this.requireVoiceId(payload, "designVoice"),
      previewAudioBase64,
      requestId: readRequestId(payload),
    };
  }

  async queryVoice(voiceId: string): Promise<QueryVoiceResult> {
    const normalizedVoiceId = requireText(voiceId, "voiceId");
    const payload = await this.post({
      action: "query_voice",
      voice_id: normalizedVoiceId,
    });

    const output = asRecord(payload.output);
    const status = normalizeStatus(output?.status ?? payload.status);
    if (!status) {
      throw new Error("[cosyvoice-clone] queryVoice response does not include a valid status");
    }

    return {
      voiceId: this.requireVoiceId(payload, "queryVoice"),
      status,
      requestId: readRequestId(payload),
    };
  }

  async listVoices(pageIndex = DEFAULT_PAGE_INDEX, pageSize = DEFAULT_PAGE_SIZE): Promise<ListVoicesResult> {
    const normalizedPageIndex = requireNonNegativeInteger(pageIndex, "pageIndex");
    const normalizedPageSize = requirePositiveInteger(pageSize, "pageSize");
    const payload = await this.post({
      action: "list_voice",
      page_index: normalizedPageIndex,
      page_size: normalizedPageSize,
    });

    const output = asRecord(payload.output);
    return {
      voices: readVoiceSummaries(payload),
      pageIndex: optionalInteger(output?.page_index) ?? optionalInteger(payload.page_index) ?? normalizedPageIndex,
      pageSize: optionalInteger(output?.page_size) ?? optionalInteger(payload.page_size) ?? normalizedPageSize,
      totalCount: optionalInteger(output?.total_count) ?? optionalInteger(payload.total_count),
      requestId: readRequestId(payload),
    };
  }

  async waitForVoice(voiceId: string, options: WaitForVoiceOptions = {}): Promise<QueryVoiceResult> {
    const normalizedVoiceId = requireText(voiceId, "voiceId");
    const pollIntervalMs = requirePositiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    const maxAttempts = requirePositiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts");

    let lastResult: QueryVoiceResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      lastResult = await this.queryVoice(normalizedVoiceId);
      if (lastResult.status === "OK") {
        return lastResult;
      }
      if (attempt < maxAttempts) {
        await delay(pollIntervalMs);
      }
    }

    const lastStatus = lastResult?.status ?? "unknown";
    throw new Error(
      `[cosyvoice-clone] voice ${normalizedVoiceId} did not become ready after ${maxAttempts} attempts (last status: ${lastStatus})`,
    );
  }

  private requireVoiceId(payload: JsonRecord, methodName: string): string {
    const voiceId = readVoiceId(payload);
    if (!voiceId) {
      throw new Error(`[cosyvoice-clone] ${methodName} response does not include voice_id`);
    }
    return voiceId;
  }

  private async post(input: JsonRecord, parameters?: JsonRecord): Promise<JsonRecord> {
    const requestBody: JsonRecord = {
      model: this.model,
      input,
      ...(parameters ? { parameters } : {}),
    };

    let response: Response;
    try {
      if (typeof globalThis.fetch !== "function") {
        throw new Error("global fetch is not available");
      }
      response = await globalThis.fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[cosyvoice-clone] request failed: ${message}`);
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
      throw new Error(`[cosyvoice-clone] HTTP ${response.status} ${response.statusText}${suffix}`);
    }

    if (!payload) {
      throw new Error("[cosyvoice-clone] response is not valid JSON");
    }

    return payload;
  }
}
