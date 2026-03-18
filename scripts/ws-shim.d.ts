declare module "ws" {
  type RawData = string | Buffer | ArrayBuffer | Buffer[];

  interface WebSocketOptions {
    headers?: Record<string, string>;
  }

  class WebSocket {
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    readyState: number;

    constructor(url: string, options?: WebSocketOptions);

    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: RawData, isBinary: boolean) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;

    send(data: string): void;
    close(): void;
    removeAllListeners(): this;
  }

  export { RawData };
  export default WebSocket;
}
