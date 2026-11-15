// npm run hub — the hub's HTTP API and the Studio web UI, on one port.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { STUDIO_HOME } from "@studio/t3-bridge";
import { LOCKED_PAGE, accessKey, checkAccess, readSettings } from "./access.ts";
import { openDb } from "./db.ts";
import { Hub } from "./hub.ts";
import { Desk } from "./desk.ts";
import { handleMcp, mcpToken } from "./mcp.ts";
import { readNotifyConfig } from "./notify.ts";
import { Vault } from "./vault.ts";

const settings = await readSettings(STUDIO_HOME);
const PORT = Number(process.env.STUDIO_PORT ?? 4600);
// "0.0.0.0" (studio lan on) lets other computers in, with the access key (access.ts).
const HOST = process.env.STUDIO_HOST ?? settings.host ?? "127.0.0.1";
const ROOT = join(import.meta.dirname, "../../..");
const WEB = join(ROOT, "apps/web");
const TICK_MS = 3_000;

const vault = new Vault(process.env.STUDIO_VAULT ?? join(STUDIO_HOME, "vault"));
await vault.init();
const notify = await readNotifyConfig(STUDIO_HOME);
const hub = new Hub(openDb(join(STUDIO_HOME, "hub.db")), { roles: join(ROOT, "roles"), kits: join(ROOT, "kits"), home: STUDIO_HOME }, vault, notify);
console.log(notify ? `Notifications: ${notify.url}` : "Notifications: off (no notify.json)");
await hub.loadWorkers();
await hub.tick().catch((e) => console.error("startup reconcile failed:", e));

const routes: Record<string, (body: any, match: RegExpMatchArray) => Promise<unknown>> = {
  "GET /api/state": () => hub.state(),
  "POST /api/workers": (b) => hub.pairWorker(b.name, b.url, b.code),
  "GET /api/hire/options": () => hub.hireOptions(),
  "POST /api/staff": (b) => hub.hire(b),
  "POST /api/staff/([\\w-]+)/fire": (_, m) => hub.fire(m[1]!),
  "GET /api/chats": async () => desk.list(),
  "POST /api/chats": (b) => desk.start(b),
  "GET /api/chats/([\\w-]+)": (_, m) => desk.read(m[1]!),
  "POST /api/chats/([\\w-]+)/send": (b, m) => desk.send(m[1]!, b.message),
  "POST /api/chats/([\\w-]+)/respond": (b, m) => desk.respond(m[1]!, b.requestId, b.decision),
  "POST /api/chats/([\\w-]+)/stop": (_, m) => desk.interrupt(m[1]!),
  "POST /api/projects": (b) => hub.createProject(b.worker, b.title, b.workspaceRoot || undefined),
  "POST /api/jobs": (b) => hub.startJob(b),
  "POST /api/preview": (b) => hub.preview(b),
  // Opening a finished agent's work in Studio counts as having looked at it.
  "GET /api/attempts/([\\w-]+)": (_, m) => hub.attempt(m[1]!, { seen: true }),
  "POST /api/attempts/([\\w-]+)/restart": (b, m) => hub.restart(m[1]!, b.note || undefined),
  "GET /api/usage": () => hub.usage(),
  "POST /api/attempts/([\\w-]+)/cancel": (_, m) => hub.cancel(m[1]!),
  "POST /api/attempts/([\\w-]+)/respond": (b, m) => hub.respond(m[1]!, b.requestId, b.decision),
  "POST /api/attempts/([\\w-]+)/rate": (b, m) => hub.workflow.rate(m[1]!, b.ratings ?? []),
  "POST /api/jobs/([\\w-]+)/accept": async (_, m) => hub.workflow.accept(m[1]!),
  "POST /api/jobs/([\\w-]+)/reject": async (b, m) => hub.workflow.reject(m[1]!, b.note),
  "POST /api/jobs/([\\w-]+)/integrate": (b, m) => hub.workflow.integrate(m[1]!, b),
  "GET /api/brief": async () => ({ text: await hub.brief() }),
  "GET /api/leaderboard": async () => hub.workflow.leaderboard(),
  "POST /api/plan": (b) => hub.workflow.plan(b),
  "POST /api/cards": (b) => hub.workflow.createCard(b),
  "POST /api/cards/([\\w-]+)": (b, m) => hub.workflow.updateCard(m[1]!, b),
  "POST /api/cards/([\\w-]+)/start": (b, m) => hub.workflow.startCard(m[1]!, b),
  "POST /api/cards/([\\w-]+)/discard": (_, m) => hub.workflow.discardCard(m[1]!),
};

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

const tokens = { hermes: await mcpToken(STUDIO_HOME), desk: await mcpToken(STUDIO_HOME, "desk-token") };
const desk = new Desk(hub, STUDIO_HOME, { url: `http://127.0.0.1:${PORT}/mcp`, token: tokens.desk });
const key = await accessKey(STUDIO_HOME);

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://hub");
  const access = checkAccess(req, url, key, settings.allowedHosts);
  if (!access.ok) {
    if (access.status === 303) return void res.writeHead(303, { location: access.location, "set-cookie": access.cookie }).end();
    if (url.pathname.startsWith("/api/")) return json(res, access.status, { error: access.reason });
    return void res.writeHead(access.status, { "content-type": "text/html" }).end(LOCKED_PAGE);
  }
  if (url.pathname === "/mcp") {
    try {
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "null") : undefined;
      return await handleMcp(hub, tokens, req, res, body);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: (e as Error).message });
      return;
    }
  }
  for (const [key, fn] of Object.entries(routes)) {
    const [method, pattern] = key.split(" ") as [string, string];
    const match = url.pathname.match(new RegExp(`^${pattern}$`));
    if (req.method !== method || !match) continue;
    try {
      const body = method === "POST" ? JSON.parse((await readBody(req)) || "{}") : undefined;
      return json(res, 200, (await fn(body, match)) ?? { ok: true });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
  }
  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  try {
    const content = await readFile(join(WEB, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(content);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

createServer((req, res) => void handle(req, res)).listen(PORT, HOST, () => {
  console.log(`Studio hub on http://${HOST}:${PORT}`);
});

let ticking = false;
setInterval(() => {
  if (ticking) return;
  ticking = true;
  hub
    .tick()
    .catch((e) => console.error("reconcile failed:", e))
    .finally(() => (ticking = false));
}, TICK_MS);
