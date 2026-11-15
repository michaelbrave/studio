// The chat box in Studio's office: a T3 thread you talk to without opening T3.
//
// A chat at the desk runs the Studio Manager (roles/studio-manager) in its own folder,
// STUDIO_HOME/desk, with Studio's MCP server attached (the "desk" scope in mcp.ts), so it can
// hire staff, set up projects and computers, and hand out jobs. A chat in a project is a plain
// T3 chat in that project's folder, the same as T3's own.
//
// Chats are recorded in the hub's database; the conversation itself lives in T3.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { compileLoadout, loadLoadout, type Provider } from "@studio/kits";
import { INSTANCE, type Hub, type WorkerConn } from "./hub.ts";
import { listProjects, readTail } from "./t3Worker.ts";

export interface ChatRow {
  id: string;
  worker: string;
  project: string;
  thread_id: string;
  title: string;
  provider: string | null;
  model: string | null;
  /** 1 for a Studio Manager chat at the desk; 0 for a plain chat in a project. */
  desk: number;
  created_at: number;
}

const MANAGER = "studio-manager";

/** Same folder? T3 and Windows may disagree on case and slashes. */
export function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

export class Desk {
  readonly dir: string;
  private readonly hub: Hub;
  private readonly mcp: { url: string; token: string };

  constructor(hub: Hub, home: string, mcp: { url: string; token: string }) {
    this.hub = hub;
    this.mcp = mcp;
    this.dir = join(home, "desk");
    hub.deskDir = this.dir;
  }

  list(): ChatRow[] {
    return this.hub.db.prepare("SELECT * FROM chats ORDER BY created_at DESC LIMIT 30").all() as unknown as ChatRow[];
  }

  get(id: string): ChatRow {
    const row = this.hub.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow | undefined;
    if (!row) throw new Error(`no chat ${id}`);
    return row;
  }

  /** The computer that runs desk chats: this one, since the hub writes the desk's files. */
  private localWorker(): WorkerConn {
    const conn = [...this.hub.workers.values()].find((w) => w.local);
    if (!conn) throw new Error("the chat needs this computer's T3: run `studio` here so it pairs");
    if (!conn.t3) throw new Error(`this computer's T3 is not answering${conn.error ? ` (${conn.error})` : ""}; is T3 running?`);
    return conn;
  }

  /**
   * Start a chat with its first message. `where` is "desk" (the Studio Manager) or
   * "<computer>/<projectId>" for a plain chat in that project.
   */
  async start(input: { message: string; where?: string; provider?: Provider; model?: string | null }) {
    const message = input.message?.trim();
    if (!message) throw new Error("say something first");
    const provider: Provider = input.provider ?? "claude";
    const atDesk = !input.where || input.where === "desk";

    let conn: WorkerConn;
    let project: string;
    let runtimeMode: string;
    let model = input.model || null;
    if (atDesk) {
      conn = this.localWorker();
      const setup = await this.prepareDesk(provider);
      runtimeMode = setup.runtimeMode;
      // The role's default model, if this computer's T3 has it for the chosen harness.
      if (!model && setup.model && conn.models[INSTANCE[provider]]?.includes(setup.model)) model = setup.model;
      project = await this.deskProject(conn);
    } else {
      const [worker, ...rest] = input.where!.split("/");
      conn = this.hub.workers.get(worker!)!;
      if (!conn?.t3) throw new Error(`computer ${worker} is offline`);
      project = rest.join("/");
      runtimeMode = "auto-accept-edits";
    }
    // No model chosen: the harness's first model, as T3 lists them.
    model ??= conn.models[INSTANCE[provider]]?.[0] ?? null;
    if (conn.models[INSTANCE[provider]] === undefined && Object.keys(conn.models).length) {
      throw new Error(`${provider} is not signed in on ${conn.name}`);
    }

    const title = `${atDesk ? "Studio" : "Chat"}: ${message.replace(/\s+/g, " ").slice(0, 60)}`;
    const { threadId } = await conn.t3!.call<{ threadId: string }>("t3_thread_launch", {
      projectId: project,
      title,
      workspaceStrategy: { type: "root" },
      ...(model ? { modelSelection: { instanceId: INSTANCE[provider], model } } : {}),
      runtimeMode,
      message,
    });
    const id = `chat_${randomUUID()}`;
    this.hub.db
      .prepare("INSERT INTO chats (id, worker, project, thread_id, title, provider, model, desk, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, conn.name, project, threadId, title, provider, model, atDesk ? 1 : 0, Date.now());
    return { id };
  }

  async send(id: string, message: string) {
    if (!message?.trim()) throw new Error("say something first");
    const chat = this.get(id);
    await this.hub.t3(chat.worker).call("t3_thread_send", { threadId: chat.thread_id, message: message.trim(), clientRequestId: `${id}-${randomUUID()}` });
    return { ok: true };
  }

  /** The conversation so far, whether the agent is busy, and anything it asks you to approve. */
  async read(id: string) {
    const chat = this.get(id);
    // The newest part of the conversation: T3 pages from the start, so a long chat must be read
    // from its end or new messages never show (docs/known-issues.md).
    const read = await readTail<{ status: string; pendingRequestCount?: number }>(this.hub.t3(chat.worker), chat.thread_id, {
      view: "activity",
      last: 150,
      maxCharsPerItem: 12_000,
    });
    const items = read.items.map((i) => ({ type: i.type, text: i.text, title: i.title, status: i.status, by: i.createdBy, at: i.updatedAt }));
    const waiting = !!read.thread.pendingRequestCount;
    const requests = waiting ? await this.hub.openRequests(chat.worker, chat.thread_id, items) : [];
    return { chat, status: waiting ? "waiting" : read.thread.status, items, requests, t3Url: this.hub.threadUrl(chat.worker, chat.thread_id) };
  }

  async respond(id: string, requestId: string, decision: string) {
    if (!["accept", "acceptForSession", "decline"].includes(decision)) throw new Error(`unknown decision ${decision}`);
    const chat = this.get(id);
    const rpc = this.hub.t3(chat.worker).rpc;
    if (!rpc) throw new Error("this computer was paired without RPC access; pair it again");
    await rpc.dispatch({ type: "runtime-request.respond", threadId: chat.thread_id, requestId, decision }, `respond:${requestId}`);
    return { ok: true };
  }

  async interrupt(id: string) {
    const chat = this.get(id);
    await this.hub.t3(chat.worker).call("t3_thread_interrupt", { threadId: chat.thread_id, reason: "stopped from Studio" });
    return { ok: true };
  }

  /** Write the Studio Manager's instructions, permissions and Studio MCP server into the desk. */
  private async prepareDesk(provider: Provider) {
    await mkdir(this.dir, { recursive: true });
    // T3 runs chats in a project folder; a git repository keeps it happy and the history readable.
    if (!(await access(join(this.dir, ".git")).then(() => true, () => false))) {
      spawnSync("git", ["init", "-q"], { cwd: this.dir, windowsHide: true });
    }
    // The role's default Kits: the skills for running Studio itself (kits/studio-ops).
    const loadout = await loadLoadout({ rolesDir: this.hub.rolesDirs, kitsDir: this.hub.kitsDirs, role: MANAGER });
    loadout.mcpServers = { studio: { type: "http", url: this.mcp.url, headers: { Authorization: `Bearer ${this.mcp.token}` } } };
    // Written fresh each time, so a changed role or token takes effect in the next chat.
    const result = compileLoadout({ loadout, provider, existing: () => undefined });
    if (!result.launchable) {
      const why = result.report.filter((r) => r.status === "unsupported").map((r) => r.reason);
      throw new Error(`the Studio Manager cannot run on ${provider}: ${why.join("; ")}`);
    }
    for (const f of result.files) {
      const path = join(this.dir, f.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, f.content);
    }
    return { runtimeMode: result.runtimeMode, model: result.model };
  }

  /** The T3 project for the desk folder, made the first time. */
  private async deskProject(conn: WorkerConn): Promise<string> {
    type P = { id: string; workspaceRoot: string };
    const find = async () => (await listProjects<P>(conn.t3!)).find((p) => sameFolder(p.workspaceRoot, this.dir));
    const found = await find();
    if (found) return found.id;
    await conn.t3!.call("t3_project_create", { title: "Studio desk", workspaceRoot: this.dir, createWorkspaceRootIfMissing: true });
    const made = await find();
    if (!made) throw new Error("T3 did not list the desk project after creating it");
    return made.id;
  }
}
