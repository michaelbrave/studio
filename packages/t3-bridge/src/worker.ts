// A connection from the hub to one worker's stock T3 server, over its MCP endpoint.
// Tool names and semantics: t3code docs/orchestration-v2/orchestrator-mcp-server.md.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exchangePairingCode, T3Rpc } from "./rpc.ts";
import { FileOAuthProvider, readWorker, writeWorker, type WorkerRecord } from "./credentials.ts";

export class T3ToolError extends Error {
  readonly tool: string;
  /** T3's typed failure code when present, e.g. "thread_not_found". */
  readonly code: string | undefined;
  readonly payload: unknown;
  constructor(tool: string, payload: unknown) {
    const code = typeof payload === "object" && payload !== null ? (payload as { code?: string }).code : undefined;
    super(`${tool} failed${code ? ` (${code})` : ""}: ${JSON.stringify(payload)}`);
    this.tool = tool;
    this.code = code;
    this.payload = payload;
  }
}

export class T3Worker {
  readonly name: string;
  private client: Client;
  /** Typed RPC for what MCP does not offer (answering approvals). Absent for MCP-only pairings. */
  readonly rpc: T3Rpc | undefined;

  private constructor(name: string, client: Client, rpc: T3Rpc | undefined) {
    this.name = name;
    this.client = client;
    this.rpc = rpc;
  }

  /** Connect with saved credentials. Fails with UnauthorizedError if the worker needs login. */
  static async connect(name: string): Promise<T3Worker> {
    const record = await readWorker(name);
    const rpc = record.rpcToken ? new T3Rpc(new URL(record.url).origin, record.rpcToken) : undefined;
    return new T3Worker(name, await openClient(name), rpc);
  }

  /**
   * First sign-in with one pairing code from the worker (`t3 auth pairing create`, or
   * Settings → Connections). No browser is involved:
   *  1. the code is exchanged for an RPC bearer session;
   *  2. that session mints a second one-time code, because MCP sign-in is a separate OAuth
   *     audience and spends its own code;
   *  3. the hub submits the approval decision T3's approval page would, and finishes OAuth.
   */
  static async pair(name: string, url: string, pairingCode: string, access: McpAccess = "full-access"): Promise<T3Worker> {
    const base = new URL(url).origin;
    const rpcToken = await exchangePairingCode(base, pairingCode);
    const { credential: mcpCode } = await new T3Rpc(base, rpcToken).post<{ credential: string }>("/api/auth/pairing-token", {
      label: "Studio hub (MCP)",
    });
    const record: WorkerRecord = { name, url, rpcToken };
    await writeWorker(record);

    let code: string | undefined;
    const provider = new FileOAuthProvider(record, async (authUrl) => {
      code = await approveWithPairingCode(authUrl, mcpCode, access);
    });
    const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
    try {
      await new Client({ name: "studio-hub", version: "0.1.0" }).connect(transport);
    } catch (e) {
      if (!(e instanceof UnauthorizedError) || code === undefined) throw e;
      await transport.finishAuth(code);
    }
    return T3Worker.connect(name);
  }

  async listTools() {
    return (await this.client.listTools()).tools;
  }

  /** Call a T3 tool and return its structured result. Throws T3ToolError on a tool-level failure. */
  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    let result;
    try {
      result = await this.client.callTool({ name: tool, arguments: args });
    } catch (e) {
      // A restarted T3 forgets our MCP session. Open a new one and retry once; a worker that
      // is really down fails again here and the error reaches the caller.
      if (e instanceof UnauthorizedError) throw e;
      await this.client.close().catch(() => {});
      this.client = await openClient(this.name);
      result = await this.client.callTool({ name: tool, arguments: args });
    }
    const payload = result.structuredContent ?? parseTextContent(result.content);
    if (result.isError) throw new T3ToolError(tool, payload);
    return payload as T;
  }

  async close() {
    await this.client.close();
  }
}

async function openClient(name: string): Promise<Client> {
  const record = await readWorker(name);
  const provider = new FileOAuthProvider(record, () => {
    throw new UnauthorizedError(`worker "${name}" needs to be paired again`);
  });
  const client = new Client({ name: "studio-hub", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(record.url), { authProvider: provider }));
  return client;
}

function parseTextContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const text = content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text")
    .map((c) => c.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** T3's MCP access levels: read-only, or a runtime-mode ceiling for threads the client starts. */
export type McpAccess = "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access";

/** POST the approval decision for an authorize URL; returns the authorization code. */
async function approveWithPairingCode(authUrl: URL, pairingCode: string, access: McpAccess): Promise<string> {
  const response = await fetch(new URL("/oauth/mcp/decision", authUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authorization: Object.fromEntries(authUrl.searchParams),
      decision: { _tag: "pairing-code", code: pairingCode, access },
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { redirectTo?: string; message?: string };
  if (!response.ok || !body.redirectTo) {
    throw new Error(`worker refused the pairing code: ${body.message ?? response.status}`);
  }
  const redirect = new URL(body.redirectTo);
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error(`sign-in denied: ${redirect.searchParams.get("error") ?? "no code returned"}`);
  return code;
}
