import { afterEach, describe, expect, it, vi } from "vitest";
import { CosyVoiceTTSProvider } from "../src/skills/alphaos/living-assistant/tts/cosyvoice-provider";
import { createTTSProvider } from "../src/skills/alphaos/living-assistant/tts/provider-factory";
import type { TTSProviderConfig } from "../src/skills/alphaos/living-assistant/tts/types";

const wsState = vi.hoisted(() => {
  const instances: unknown[] = [];

  class HoistedMockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    public readonly endpoint: string;
    public readonly options?: { headers?: Record<string, string> };
    public readonly sentFrames: string[] = [];
    public readyState = HoistedMockWebSocket.CONNECTING;

    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(endpoint: string, options?: { headers?: Record<string, string> }) {
      this.endpoint = endpoint;
      this.options = options;
      instances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const handlers = this.listeners.get(event) ?? [];
      handlers.push(listener);
      this.listeners.set(event, handlers);
      return this;
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }

    send(data: string | Buffer) {
      this.sentFrames.push(typeof data === "string" ? data : data.toString("utf8"));
    }

    close(code = 1000, reason = "") {
      this.readyState = HoistedMockWebSocket.CLOSED;
      this.emit("close", code, Buffer.from(reason));
    }

    triggerOpen() {
      this.readyState = HoistedMockWebSocket.OPEN;
      this.emit("open");
    }

    triggerJson(payload: unknown) {
      this.emit("message", JSON.stringify(payload), false);
    }

    triggerAudio(chunk: Buffer) {
      this.emit("message", chunk, true);
    }

    triggerError(message: string) {
      this.emit("error", new Error(message));
    }

    private emit(event: string, ...args: unknown[]) {
      const handlers = this.listeners.get(event) ?? [];
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }

  return {
    instances,
    MockWebSocket: HoistedMockWebSocket,
  };
});

vi.mock("ws", () => ({ default: wsState.MockWebSocket }));

type MockWebSocket = InstanceType<typeof wsState.MockWebSocket>;

function lastSocket(): MockWebSocket {
  const socket = wsState.instances.at(-1) as MockWebSocket | undefined;
  if (!socket) {
    throw new Error("No websocket instance created");
  }
  return socket;
}

function frameAt(socket: MockWebSocket, index: number): Record<string, unknown> {
  const raw = socket.sentFrames[index];
  if (!raw) {
    throw new Error(`Missing frame at index ${index}`);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

afterEach(() => {
  wsState.instances.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("living assistant cosyvoice tts", () => {
  it("accepts a cosyvoice provider config", () => {
    const config = {
      type: "cosyvoice",
      apiKey: "dash-test",
      model: "cosyvoice-v2",
      defaultVoice: "longxiaochun_v2",
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

  it("runs websocket duplex flow and concatenates binary chunks", async () => {
    const provider = createTTSProvider({
      type: "cosyvoice",
      apiKey: "dash-key",
      endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference/",
      model: "cosyvoice-v2",
      defaultVoice: "longxiaochun_v2",
    });

    const synthesizePromise = provider.synthesize("Status update for you", {
      voice: "longwan_v2",
      format: "wav",
      speed: 1.25,
    });

    const socket = lastSocket();
    expect(socket.endpoint).toBe("wss://dashscope.aliyuncs.com/api-ws/v1/inference/");
    expect(socket.options?.headers?.Authorization).toBe("bearer dash-key");

    socket.triggerOpen();
    expect(socket.sentFrames).toHaveLength(1);

    const runTask = frameAt(socket, 0);
    const runHeader = runTask.header as Record<string, unknown>;
    const runPayload = runTask.payload as Record<string, unknown>;
    const runParameters = runPayload.parameters as Record<string, unknown>;
    expect(runHeader.action).toBe("run-task");
    expect(runHeader.streaming).toBe("duplex");
    expect(runPayload.model).toBe("cosyvoice-v2");
    expect(runParameters.voice).toBe("longwan_v2");
    expect(runParameters.format).toBe("wav");
    expect(runParameters.rate).toBe(1.25);
    expect(runParameters.sample_rate).toBe(22050);

    socket.triggerJson({
      header: { event: "task-started" },
    });
    expect(socket.sentFrames).toHaveLength(3);

    const continueTask = frameAt(socket, 1);
    const continueHeader = continueTask.header as Record<string, unknown>;
    const continuePayload = continueTask.payload as Record<string, unknown>;
    const continueInput = continuePayload.input as Record<string, unknown>;
    expect(continueHeader.action).toBe("continue-task");
    expect(continueHeader.task_id).toBe(runHeader.task_id);
    expect(continueInput.text).toBe("Status update for you");

    const finishTask = frameAt(socket, 2);
    const finishHeader = finishTask.header as Record<string, unknown>;
    expect(finishHeader.action).toBe("finish-task");
    expect(finishHeader.task_id).toBe(runHeader.task_id);

    socket.triggerAudio(Buffer.from([0x01, 0x02, 0x03]));
    socket.triggerAudio(Buffer.from([0x04, 0x05]));
    socket.triggerJson({
      header: { event: "task-finished" },
    });

    const result = await synthesizePromise;
    expect(result.audio).toBeDefined();
    expect(result.audio?.equals(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]))).toBe(true);
    expect(result.audioUrl).toBeUndefined();
    expect(result.format).toBe("wav");
    expect(result.provider).toBe("cosyvoice");
  });

  it("rejects reference-audio URL voice values", async () => {
    const provider = createTTSProvider({
      type: "cosyvoice",
      apiKey: "dash-key",
    });

    await expect(
      provider.synthesize("hello world", {
        voice: "https://example.com/reference-voice.wav",
      }),
    ).rejects.toThrow(/voice cloning API/i);
    expect(wsState.instances).toHaveLength(0);
  });

  it("surfaces task-failed event errors", async () => {
    const provider = createTTSProvider({
      type: "cosyvoice",
      apiKey: "bad-key",
    });
    const synthesizePromise = provider.synthesize("hello world");
    const socket = lastSocket();

    socket.triggerOpen();
    socket.triggerJson({
      header: { event: "task-started" },
    });
    socket.triggerJson({
      header: { event: "task-failed" },
      payload: { message: "Access denied due to invalid key." },
    });

    await expect(synthesizePromise).rejects.toThrow(/task failed/i);
    await expect(synthesizePromise).rejects.toThrow(/invalid key/i);
  });

  it("surfaces websocket connection errors", async () => {
    const provider = createTTSProvider({
      type: "cosyvoice",
      apiKey: "dash-key",
    });
    const synthesizePromise = provider.synthesize("hello world");
    const socket = lastSocket();

    socket.triggerError("network broken");
    await expect(synthesizePromise).rejects.toThrow(/connection error/i);
    await expect(synthesizePromise).rejects.toThrow(/network broken/i);
  });

  it("times out after 30 seconds", async () => {
    vi.useFakeTimers();

    const provider = createTTSProvider({
      type: "cosyvoice",
      apiKey: "dash-key",
    });
    const p = provider.synthesize("hello world");
    const rejection = expect(p).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
  });
});
