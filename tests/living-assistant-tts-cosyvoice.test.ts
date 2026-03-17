import { afterEach, describe, expect, it, vi } from "vitest";
import { CosyVoiceTTSProvider } from "../src/skills/alphaos/living-assistant/tts/cosyvoice-provider";
import { createTTSProvider } from "../src/skills/alphaos/living-assistant/tts/provider-factory";
import type { TTSProviderConfig } from "../src/skills/alphaos/living-assistant/tts/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("living assistant cosyvoice tts", () => {
  it("accepts a cosyvoice provider config", () => {
    const config = {
      type: "cosyvoice",
      apiKey: "dash-test",
      model: "cosyvoice-v2",
      defaultVoice: "longxiaochun",
    } satisfies TTSProviderConfig;

    expect(config.type).toBe("cosyvoice");
    expect(config.model).toContain("cosyvoice");
  });

  it("createTTSProvider supports cosyvoice type", () => {
    const provider = createTTSProvider({
      type: "cosyvoice",
      apiKey: "dash-test",
    });

    expect(provider).toBeInstanceOf(CosyVoiceTTSProvider);
    expect(provider.name).toBe("cosyvoice");
  });

  it("cosyvoice provider sends preset voices as input.voice", async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            output: {
              audio: {
                url: "https://cdn.example.com/cosyvoice.wav",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = createTTSProvider({
      type: "cosyvoice",
      apiKey: "dash-key",
      endpoint: "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation/",
      model: "cosyvoice-v2",
      defaultVoice: "longxiaochun",
    });

    const result = await provider.synthesize("Status update for you", {
      voice: "longwan",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = mockFetch.mock.calls[0];
    expect(String(requestUrl)).toBe(
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(requestInit?.method).toBe("POST");

    const headers = requestInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dash-key");
    expect(headers["Content-Type"]).toBe("application/json");

    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: "cosyvoice-v2",
      input: {
        text: "Status update for you",
        voice: "longwan",
      },
    });

    expect(result.audio).toBeUndefined();
    expect(result.audioUrl).toBe("https://cdn.example.com/cosyvoice.wav");
    expect(result.format).toBe("wav");
    expect(result.durationSeconds).toBe(0);
    expect(result.provider).toBe("cosyvoice");
  });

  it("cosyvoice provider sends reference audio URL as input.reference_audio", async () => {
    const audioBytes = Buffer.alloc(2_000, 1);
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            output: {
              audio: {
                data: audioBytes.toString("base64"),
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = createTTSProvider({
      type: "cosyvoice",
      apiKey: "dash-key",
    });

    const result = await provider.synthesize("Status update for you", {
      voice: "https://example.com/reference-voice.wav",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, requestInit] = mockFetch.mock.calls[0];

    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: "cosyvoice-v2",
      input: {
        text: "Status update for you",
        reference_audio: "https://example.com/reference-voice.wav",
      },
    });

    expect(result.audioUrl).toBeUndefined();
    expect(result.audio).toBeDefined();
    expect(result.audio?.byteLength).toBe(audioBytes.byteLength);
    expect(result.format).toBe("wav");
    expect(result.durationSeconds).toBe(1);
    expect(result.provider).toBe("cosyvoice");
  });

  it("cosyvoice provider surfaces HTTP errors with provider name and status", async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            code: "InvalidApiKey",
            message: "Access denied due to invalid key.",
          }),
          {
            status: 401,
            statusText: "Unauthorized",
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const provider = createTTSProvider({
      type: "cosyvoice",
      apiKey: "bad-key",
    });

    await expect(provider.synthesize("hello world")).rejects.toThrow(/cosyvoice/i);
    await expect(provider.synthesize("hello world")).rejects.toThrow(/401/);
  });
});
