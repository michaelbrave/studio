// T3's typed RPC, the surface its own web/mobile clients use. Studio needs it for what MCP
// deliberately does not offer, such as answering permission requests. Wire format: Effect RPC
// with JSON serialization over a WebSocket (t3code packages/client-runtime/src/rpc/session.ts).

import { createHash } from "node:crypto";

const PROTOCOL_HEADER = { "x-t3-orchestration-protocol": "2" };

type RpcMessage =
  | { _tag: "Exit"; requestId: string; exit: { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: unknown[] } }
  | { _tag: "Chunk"; requestId: string; values: unknown[] }
  | { _tag: "Ping" | "Pong" | "Defect" | "ClientProtocolError"; [k: string]: unknown };

export class T3RpcError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** Exchange a one-time pairing code for a long-lived bearer session on a worker. */
export async function exchangePairingCode(baseUrl: string, code: string, label = "Studio hub"): Promise<string> {
  const response = await fetch(new URL("/oauth/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: code,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: label,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string; message?: string };
  if (!response.ok || !body.access_token) {
    throw new T3RpcError(`worker refused the pairing code: ${body.error_description ?? body.message ?? response.status}`);
  }
  return body.access_token;
}

export class T3Rpc {
  readonly baseUrl: string;
  private readonly token: string;
  private socket: WebSocket | undefined;
  private connecting: Promise<WebSocket> | undefined;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  /** Authenticated GET against the worker's HTTP API. */
  async get<T>(path: string): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      headers: { authorization: `Bearer ${this.token}`, ...PROTOCOL_HEADER },
    });
    if (!response.ok) throw new T3RpcError(`GET ${path} → ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }

  /** Authenticated POST against the worker's HTTP API. */
  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new T3RpcError(`POST ${path} → ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }

  /** Call one RPC method and wait for its result. */
  async call<T = unknown>(method: string, payload: unknown): Promise<T> {
    const socket = await this.connect();
    const id = String(this.nextId++);
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    socket.send(JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }));
    return (await result) as T;
  }

  /**
   * Dispatch an orchestration command. The command id is derived from `idempotencyKey`, so
   * retrying the same logical command is answered from T3's command receipt instead of re-run.
   */
  async dispatch<T = unknown>(command: Record<string, unknown>, idempotencyKey: string): Promise<T> {
    const commandId = `studio:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
    return this.call<T>("orchestration.dispatchCommand", { ...command, commandId });
  }

  close() {
    this.socket?.close();
    this.socket = undefined;
    this.connecting = undefined;
  }

  private connect(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket);
    this.connecting ??= (async () => {
      // Long-lived tokens stay out of socket URLs; T3 issues a short-lived ticket instead.
      const { ticket } = await this.post<{ ticket: string }>("/api/auth/websocket-ticket", {});
      const url = new URL("/ws", this.baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("wsTicket", ticket);
      url.searchParams.set("orchestrationProtocol", "2");
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new T3RpcError(`could not open ${url.origin}/ws`)), { once: true });
      });
      socket.addEventListener("message", (event) => this.onMessage(String(event.data)));
      socket.addEventListener("close", () => {
        for (const p of this.pending.values()) p.reject(new T3RpcError("worker connection closed"));
        this.pending.clear();
        this.socket = undefined;
        this.connecting = undefined;
      });
      this.socket = socket;
      return socket;
    })().catch((e) => {
      this.connecting = undefined;
      throw e;
    });
    return this.connecting;
  }

  private onMessage(data: string) {
    const parsed = JSON.parse(data) as RpcMessage | RpcMessage[];
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      if (msg._tag === "Ping") this.socket?.send(JSON.stringify({ _tag: "Pong" }));
      if (msg._tag !== "Exit") continue;
      const waiter = this.pending.get(msg.requestId);
      if (!waiter) continue;
      this.pending.delete(msg.requestId);
      if (msg.exit._tag === "Success") waiter.resolve(msg.exit.value);
      else waiter.reject(new T3RpcError(`RPC failed: ${JSON.stringify(msg.exit.cause).slice(0, 500)}`, msg.exit.cause));
    }
  }
}
