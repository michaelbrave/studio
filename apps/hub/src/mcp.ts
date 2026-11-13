// Studio as an MCP server, for Hermes (or any MCP client) on this machine: read what is going on,
// and answer an agent's pending request. Served by the hub at /mcp (Streamable HTTP, stateless).
//
// Access: a bearer token from ~/.config/studio/mcp-token (made on first start), and no requests
// from web pages (an Origin header is refused), so a site open in your browser can't approve
// anything. What may be done from chat is limited to these tools on purpose: no starting jobs,
// accepting or integrating from Discord.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Hub } from "./hub.ts";

const LABEL: Record<string, string> = {
  queued: "queued",
  preparing: "getting ready",
  running: "working",
  awaiting_input: "NEEDS YOU",
  capacity_paused: "on a break (usage limit)",
  status_unknown: "status unknown",
  stopped: "stopped",
  failed: "failed",
  result_available: "done, waiting for review",
};

/** The token Hermes sends; created once with owner-only permissions. */
export async function mcpToken(home: string): Promise<string> {
  const path = join(home, "mcp-token");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    const token = randomBytes(24).toString("base64url");
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return token;
  }
}

function allowed(req: IncomingMessage, token: string): boolean {
  if (req.headers.origin) return false;
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function studioMcpServer(hub: Hub): McpServer {
  const server = new McpServer({ name: "studio", version: "1.0.0" });

  server.registerTool(
    "studio_status",
    {
      description:
        "What is happening in Studio now: each machine (online or not) and every agent in the office with its role, job, state and latest activity. Use this to answer 'what's going on?'.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = await hub.state();
      const lines: string[] = [];
      for (const w of s.workers) lines.push(`Machine ${w.name}: ${w.online ? "online" : `OFFLINE (${w.error ?? "unreachable"})`}`);
      if (!s.workers.length) lines.push("No machines paired.");
      const agents = s.scene.agents;
      if (!agents.length) lines.push("No agents at work right now.");
      for (const a of agents) {
        const doing = a.doing ? `, latest: ${a.doing}` : "";
        lines.push(`- ${a.roleTitle} on "${a.jobTitle}" @ ${a.floor}: ${a.status}${doing} [attempt ${a.attemptId}]`);
      }
      const proposed = (s.cards as Array<{ column: string }>).filter((c) => c.column === "proposed").length;
      if (proposed) lines.push(`${proposed} proposed card(s) wait for approval on the Board (approve them in Studio).`);
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "studio_waiting",
    {
      description:
        "Agents blocked on you, with each pending request (usually a command or file change they want approval for). Returns attemptId and requestId to pass to studio_respond.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = await hub.state();
      const out: string[] = [];
      for (const job of s.jobs as unknown as Array<{ title: string; attempts: Array<{ id: string; state: string; role: string | null; worker: string }> }>) {
        const a = job.attempts.at(-1);
        if (a?.state !== "awaiting_input") continue;
        const { requests } = await hub.attempt(a.id);
        const role = s.roles.find((r) => r.name === a.role)?.title ?? a.role ?? "Agent";
        if (!requests.length) out.push(`- ${role} on "${job.title}" @ ${a.worker} [attempt ${a.id}]: waiting, but the request could not be read; open Studio.`);
        for (const r of requests)
          out.push(`- ${role} on "${job.title}" @ ${a.worker} [attempt ${a.id}, request ${r.id}] wants (${r.kind}):\n  ${(r.summary || "(no details)").replace(/\n/g, "\n  ")}`);
      }
      return text(out.length ? out.join("\n") : "Nothing is waiting for you.");
    },
  );

  server.registerTool(
    "studio_brief",
    {
      description:
        "The Studio brief: what finished, failed, was accepted or merged since the last daily brief, and what stands now (waiting for you, ready to review, working, machines offline). Use for 'catch me up' or 'give me the brief'.",
      annotations: { readOnlyHint: true },
    },
    async () => text(await hub.brief()),
  );

  server.registerTool(
    "studio_job",
    {
      description: "Details of one agent's attempt: state, recent state history, and its latest activity. Use before approving if the request is unclear.",
      inputSchema: { attemptId: z.string().describe("The attempt id from studio_status or studio_waiting") },
      annotations: { readOnlyHint: true },
    },
    async ({ attemptId }) => {
      const { attempt: a, history, messages } = await hub.attempt(attemptId);
      const lines = [`State: ${LABEL[a.state] ?? a.state} @ ${a.worker} (${a.provider ?? "?"} ${a.model ?? ""})`.trim()];
      if (a.error) lines.push(`Error: ${a.error}`);
      const past = history as unknown as Array<{ to_state: string; reason: string }>;
      lines.push("History:", ...past.slice(-8).map((h) => `  ${LABEL[h.to_state] ?? h.to_state}: ${h.reason}`));
      lines.push("Latest activity:");
      for (const m of messages.filter((m) => m.text || m.title).slice(-6)) lines.push(`  [${m.type}] ${(m.title ?? "") + (m.text ? ` ${m.text}` : "")}`.slice(0, 600));
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "studio_respond",
    {
      description:
        "Answer an agent's pending request. 'accept' approves this one action, 'acceptForSession' approves this kind of action for the rest of the run, 'decline' refuses it. Only do this when the user clearly said so for this specific request; if more than one request is waiting and it is unclear which, ask.",
      inputSchema: {
        attemptId: z.string(),
        requestId: z.string(),
        decision: z.enum(["accept", "acceptForSession", "decline"]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ attemptId, requestId, decision }) => {
      await hub.respond(attemptId, requestId, decision, "from Discord (Hermes)");
      return text(`Done: ${decision} sent for request ${requestId}.`);
    },
  );

  return server;
}

/** Handle one HTTP request to /mcp. Stateless: a fresh server and transport per request. */
export async function handleMcp(hub: Hub, token: string, req: IncomingMessage, res: ServerResponse, body: unknown) {
  if (!allowed(req, token)) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const server = studioMcpServer(hub);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
