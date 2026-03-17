import { afterEach, describe, expect, it, vi } from "vitest";
import { CosyVoiceCloneService } from "../src/skills/alphaos/living-assistant/tts/voice-clone";

const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
    ...init,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("living assistant cosyvoice voice clone", () => {
  it("createVoice posts audio-url enrollment request", async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({
        output: {
          voice_id: "cosyvoice-myvoice-123",
        },
        request_id: "req-create-1",
      }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const service = new CosyVoiceCloneService({ apiKey: "dash-key" });
    const result = await service.createVoice({
      prefix: "myvoice",
      audioUrl: "https://cdn.example.com/reference.wav",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = mockFetch.mock.calls[0];
    expect(String(requestUrl)).toBe("https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization");
    expect(requestInit?.method).toBe("POST");

    const headers = requestInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dash-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        target_model: "cosyvoice-v2",
        prefix: "myvoice",
        url: "https://cdn.example.com/reference.wav",
      },
      parameters: {
        sample_rate: 22050,
      },
    });

    expect(result).toEqual({
      voiceId: "cosyvoice-myvoice-123",
      requestId: "req-create-1",
    });
  });

  it("designVoice posts prompt-based enrollment request and returns preview audio", async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({
        output: {
          voice_id: "cosyvoice-designer-456",
          preview_audio_base64: "cHJldmlldy1hdWRpbw==",
        },
        request_id: "req-design-1",
      }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const service = new CosyVoiceCloneService({ apiKey: "dash-key" });
    const result = await service.designVoice({
      prefix: "designer",
      voicePrompt: "Warm male voice with a calm cadence.",
      previewText: "Portfolio update.",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, requestInit] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: "voice-enrollment",
      input: {
        action: "create_voice",
        target_model: "cosyvoice-v2",
        prefix: "designer",
        voice_prompt: "Warm male voice with a calm cadence.",
        preview_text: "Portfolio update.",
      },
      parameters: {
        sample_rate: 22050,
      },
    });

    expect(result).toEqual({
      voiceId: "cosyvoice-designer-456",
      previewAudioBase64: "cHJldmlldy1hdWRpbw==",
      requestId: "req-design-1",
    });
  });

  it("queryVoice posts status request and returns normalized status", async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({
        output: {
          voice_id: "cosyvoice-status-1",
          status: "DEPLOYING",
        },
        request_id: "req-query-1",
      }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const service = new CosyVoiceCloneService({ apiKey: "dash-key" });
    const result = await service.queryVoice("cosyvoice-status-1");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, requestInit] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: "voice-enrollment",
      input: {
        action: "query_voice",
        voice_id: "cosyvoice-status-1",
      },
    });

    expect(result).toEqual({
      voiceId: "cosyvoice-status-1",
      status: "DEPLOYING",
      requestId: "req-query-1",
    });
  });

  it("listVoices posts pagination request and normalizes returned voices", async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({
        output: {
          page_index: 1,
          page_size: 2,
          total_count: 3,
          voices: [
            {
              voice_id: "cosyvoice-a",
              status: "OK",
              prefix: "alpha",
            },
            {
              voice_id: "cosyvoice-b",
              status: "UNDEPLOYED",
            },
          ],
        },
        request_id: "req-list-1",
      }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const service = new CosyVoiceCloneService({ apiKey: "dash-key" });
    const result = await service.listVoices(1, 2);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, requestInit] = mockFetch.mock.calls[0];
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: "voice-enrollment",
      input: {
        action: "list_voice",
        page_index: 1,
        page_size: 2,
      },
    });

    expect(result.requestId).toBe("req-list-1");
    expect(result.pageIndex).toBe(1);
    expect(result.pageSize).toBe(2);
    expect(result.totalCount).toBe(3);
    expect(result.voices).toHaveLength(2);
    expect(result.voices[0]).toMatchObject({
      voiceId: "cosyvoice-a",
      status: "OK",
      prefix: "alpha",
    });
    expect(result.voices[1]).toMatchObject({
      voiceId: "cosyvoice-b",
      status: "UNDEPLOYED",
    });
  });

  it("waitForVoice polls until status becomes OK", async () => {
    vi.useFakeTimers();

    const mockFetch = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        jsonResponse({
          output: {
            voice_id: "cosyvoice-ready-1",
            status: "DEPLOYING",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          output: {
            voice_id: "cosyvoice-ready-1",
            status: "DEPLOYING",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          output: {
            voice_id: "cosyvoice-ready-1",
            status: "OK",
          },
          request_id: "req-ready-3",
        }),
      );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const service = new CosyVoiceCloneService({ apiKey: "dash-key" });
    const waitPromise = service.waitForVoice("cosyvoice-ready-1", {
      pollIntervalMs: 500,
      maxAttempts: 3,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await waitPromise;

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const requestBodies = mockFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requestBodies).toEqual([
      {
        model: "voice-enrollment",
        input: {
          action: "query_voice",
          voice_id: "cosyvoice-ready-1",
        },
      },
      {
        model: "voice-enrollment",
        input: {
          action: "query_voice",
          voice_id: "cosyvoice-ready-1",
        },
      },
      {
        model: "voice-enrollment",
        input: {
          action: "query_voice",
          voice_id: "cosyvoice-ready-1",
        },
      },
    ]);
    expect(result).toEqual({
      voiceId: "cosyvoice-ready-1",
      status: "OK",
      requestId: "req-ready-3",
    });
  });

  it("surfaces HTTP errors with status and message", async () => {
    const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse(
        {
          code: "InvalidApiKey",
          message: "Access denied due to invalid key.",
        },
        {
          status: 401,
          statusText: "Unauthorized",
        },
      ),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const service = new CosyVoiceCloneService({ apiKey: "bad-key" });

    await expect(
      service.createVoice({
        prefix: "myvoice",
        audioUrl: "https://cdn.example.com/reference.wav",
      }),
    ).rejects.toThrow(/401/);
    await expect(
      service.createVoice({
        prefix: "myvoice",
        audioUrl: "https://cdn.example.com/reference.wav",
      }),
    ).rejects.toThrow(/invalid key/i);
  });
});
