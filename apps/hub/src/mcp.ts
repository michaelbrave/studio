// Studio as an MCP server, for Hermes (or any MCP client) on this machine: read what is going on,
// and answer an agent's pending request. Served by the hub at /mcp (Streamable HTTP, stateless).
//
// Access: a bearer token, and no requests from web pages (an Origin header is refused), so a site
// open in your browser can't approve anything. There are two tokens:
//  - mcp-token (Hermes/Discord): read what is going on and answer requests. No starting jobs,
//    accepting or integrating from Discord, on purpose.
//  - desk-token (the Studio Manager you chat with in Studio, desk.ts): the same, plus setting
//    Studio up: hire and let go of staff, create projects, connect computers, start jobs, plan.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { INSTANCE, type Hub } from "./hub.ts";

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

export type McpScope = "hermes" | "desk";

/** A token, created once with owner-only permissions: `mcp-token` (Hermes) or `desk-token`. */
export async function mcpToken(home: string, file = "mcp-token"): Promise<string> {
  const path = join(home, file);
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    const token = randomBytes(24).toString("base64url");
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return token;
  }
}

/** Which scope the request's token grants, or null. */
function scopeOf(req: IncomingMessage, tokens: Record<McpScope, string>): McpScope | null {
  if (req.headers.origin) return null;
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  for (const [scope, token] of Object.entries(tokens) as Array<[McpScope, string]>) {
    const want = Buffer.from(token);
    if (got.length === want.length && timingSafeEqual(got, want)) return scope;
  }
  return null;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function studioMcpServer(hub: Hub, scope: McpScope = "hermes"): McpServer {
  const server = new McpServer({ name: "studio", version: "1.0.0" });
  const via = scope === "desk" ? "from the Studio chat" : "from Discord (Hermes)";

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
      await hub.respond(attemptId, requestId, decision, via);
      return text(`Done: ${decision} sent for request ${requestId}.`);
    },
  );

  if (scope === "desk") registerDeskTools(server, hub);
  return server;
}

const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const NOT_ASSIGNABLE = new Set(["critic", "integrator", "producer", "studio-manager"]);

/** Setting Studio up from chat: what the Studio Manager (roles/studio-manager) may do. */
function registerDeskTools(server: McpServer, hub: Hub) {
  server.registerTool(
    "studio_catalog",
    {
      description:
        "Everything Studio can offer, as JSON: computers (with the harnesses and models each one's T3 has signed in), projects (id as \"<computer>/<projectId>\"), hired staff and whether they are busy, roles (job templates), kits (tool bundles), souls (personalities), and MCP servers and skills already set up on this computer. Call this before proposing a hire or a job.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = await hub.state();
      const options = await hub.hireOptions();
      const busy = hub.busyStaff();
      return json({
        computers: s.workers.map((w) => ({
          name: w.name,
          online: w.online,
          thisComputer: w.local,
          harnesses: w.providers.map((p) => ({ harness: Object.entries(INSTANCE).find(([, id]) => id === p.id)?.[0] ?? p.id, models: p.models })),
        })),
        projects: s.workers.flatMap((w) => w.projects.filter((p) => !p.desk).map((p) => ({ id: `${w.name}/${p.id}`, title: p.title, folder: p.workspaceRoot }))),
        staff: s.staff.map((m) => ({ ...m, busy: busy.has(m.name) })),
        roles: s.roles.filter((r) => !NOT_ASSIGNABLE.has(r.name)).map((r) => ({ name: r.name, title: r.title, department: r.department, description: r.description, harness: r.preferred, model: r.model, kits: r.kits })),
        kits: s.kits.map((k) => ({ name: k.name, title: k.title, description: k.description, skills: k.skills, mcp: k.mcp })),
        souls: options.souls.map((x) => ({ id: x.id, label: x.label, preview: x.text.slice(0, 200) })),
        onThisComputer: { mcpServers: options.mcp, skills: options.skills },
      });
    },
  );

  server.registerTool(
    "studio_hire",
    {
      description:
        "Hire a staff member. from=template hires into an existing role; from=scratch makes a new role from title/description/duties. soul: \"role\" (the role's), \"none\", or text for its own personality (to reuse a soul from studio_catalog, pass its text). kits are kit names; mcp and skills are names from onThisComputer. Confirm the setup with the user first. Studio refuses to hire into a role someone already holds (give that person the work instead) unless evenIfRedundant=true, for when the user wants two working in parallel.",
      inputSchema: {
        name: z.string().describe("What to call it, e.g. Ada"),
        computer: z.string().describe("The computer whose floor it sits on"),
        from: z.enum(["template", "scratch"]),
        role: z.string().optional().describe("from=template: the role name"),
        title: z.string().optional().describe("from=scratch: job title"),
        description: z.string().optional(),
        duties: z.string().optional().describe("from=scratch: duties and hard rules"),
        harness: z.enum(["claude", "codex", "opencode"]),
        model: z.string().optional().describe("A model the computer reports for that harness; omit for the default"),
        soul: z.string().describe('"role", "none", or the personality text'),
        kits: z.array(z.string()).optional(),
        mcp: z.array(z.string()).optional(),
        skills: z.array(z.string()).optional(),
        evenIfRedundant: z.boolean().optional().describe("Hire even though someone already holds this role (only when the user asked for a second one)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (i) => {
      if (i.from === "template" && i.role && !i.evenIfRedundant) {
        const same = ((await hub.staff?.list()) ?? []).filter((m) => m.role === i.role);
        if (same.length) {
          const busy = hub.busyStaff();
          const who = same.map((m) => `${m.displayName} (staff id ${m.name}, ${busy.has(m.name) ? "busy" : "free"})`).join(", ");
          return text(
            `Not hired: ${who} already ${same.length === 1 ? "holds" : "hold"} the ${i.role} role. Give the work to them with studio_start_job staff=<id> ` +
              `(or studio_start_card). Only if the user wants another one working in parallel, call studio_hire again with evenIfRedundant=true.`,
          );
        }
      }
      const m = await hub.hire({
        displayName: i.name,
        worker: i.computer,
        from: i.from,
        ...(i.role ? { role: i.role } : {}),
        ...(i.title ? { title: i.title } : {}),
        ...(i.description ? { description: i.description } : {}),
        ...(i.duties ? { duties: i.duties } : {}),
        runtime: i.harness,
        model: i.model ?? null,
        soul: i.soul === "role" ? { kind: "role" } : i.soul === "none" ? { kind: "none" } : { kind: "text", text: i.soul },
        kits: i.kits ?? [],
        mcp: i.mcp ?? [],
        skills: i.skills ?? [],
      });
      return text(`Hired ${m.displayName} (staff id ${m.name}) as ${m.role}. They are at a desk on ${m.worker}'s floor.`);
    },
  );

  server.registerTool(
    "studio_fire",
    {
      description: "Let a staff member go (their past jobs keep their records). Only when the user explicitly asked to remove this one.",
      inputSchema: { staff: z.string().describe("Staff id from studio_catalog") },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ staff }) => {
      await hub.fire(staff);
      return text(`${staff} has left the studio.`);
    },
  );

  server.registerTool(
    "studio_create_project",
    {
      description: "Create a project on a computer. Without a folder, T3 makes a new git repository for it; with one, it uses (or creates) that folder.",
      inputSchema: { computer: z.string(), title: z.string(), folder: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ computer, title, folder }) => json(await hub.createProject(computer, title, folder)),
  );

  server.registerTool(
    "studio_connect_computer",
    {
      description: "Connect another computer's T3 as a worker: its address (e.g. 192.168.1.50:3773) and the pairing code `t3 serve` printed there.",
      inputSchema: { name: z.string().describe("kebab-case, e.g. desktop"), address: z.string(), pairingCode: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ name, address, pairingCode }) => {
      await hub.pairWorker(name, address, pairingCode);
      return text(`Connected ${name}. Its floor is in the office now.`);
    },
  );

  server.registerTool(
    "studio_start_job",
    {
      description:
        "Give someone a job. project is \"<computer>/<projectId>\" from studio_catalog. Either staff (a hired staff id; preferred) or role (+ optional harness). With only a role, a free staff member in that role gets the job; a one-off agent is brought in only if none is free (or oneOff=true). The brief says what to do and how we'll know it's done. The job gets a card on the Board (or pass card to work on an existing one). A Code Critic cross-checks the result unless review=false.",
      inputSchema: {
        project: z.string(),
        title: z.string(),
        brief: z.string(),
        staff: z.string().optional(),
        role: z.string().optional(),
        harness: z.enum(["claude", "codex", "opencode"]).optional(),
        review: z.boolean().optional(),
        card: z.string().optional().describe("A card id from studio_board this job works on"),
        oneOff: z.boolean().optional().describe("Bring in a one-off agent for the role even if a staff member is free"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (i) => {
      const [worker, ...rest] = i.project.split("/");
      // Free staff first: hiring or bringing in someone new is for when everyone in the role is busy.
      const staff = i.staff ?? (i.role && !i.oneOff && !i.harness ? (await hub.freeStaff(i.role))?.name : undefined);
      const { attemptId } = await hub.startJob({
        worker: worker!,
        project: rest.join("/"),
        title: i.title,
        brief: i.brief,
        ...(staff ? { staff } : {}),
        ...(i.role ? { role: i.role } : {}),
        ...(i.harness ? { provider: i.harness } : {}),
        ...(i.review === false ? { autoReview: false } : {}),
        ...(i.card ? { card: i.card } : {}),
        by: "the Studio Manager",
      });
      const name = staff ? ((await hub.staff?.get(staff).catch(() => null))?.displayName ?? staff) : null;
      return text(
        `Started "${i.title}" (attempt ${attemptId}). ${name ? `${name} is on it` : "A one-off agent is on it"}; it shows in the office, on the Board and in the Jobs tab.`,
      );
    },
  );

  server.registerTool(
    "studio_board",
    {
      description:
        "The task board as JSON: every card with its id, column (proposed, backlog, ready, doing, review, done, blocked), project, role, priority, and the state of its latest job. Optionally only one project (\"<computer>/<projectId>\"). Use it to answer 'what is left?' and before adding cards, so you do not add one that is already there.",
      inputSchema: { project: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      const s = await hub.state();
      const jobs = s.jobs as unknown as Array<{ id: string; milestone: string | null; attempts: Array<{ id: string; state: string; staff: string | null }> }>;
      const cards = (s.cards as Array<{ id: string; title: string; column: string; project: string; role: string; priority: string; jobs: string[]; body: string }>)
        .filter((c) => !project || c.project === project)
        .map((c) => {
          const job = jobs.find((j) => j.id === c.jobs.at(-1));
          const a = job?.attempts.at(-1);
          return {
            id: c.id,
            title: c.title,
            column: c.column,
            project: c.project,
            role: c.role,
            priority: c.priority,
            job: a ? { attemptId: a.id, state: LABEL[a.state] ?? a.state, staff: a.staff, milestone: job?.milestone ?? null } : null,
            details: c.body.slice(0, 300),
          };
        });
      return json(cards);
    },
  );

  server.registerTool(
    "studio_add_card",
    {
      description:
        "Add a task card to the Board for later (column backlog by default; ready when it can start now). role is a role name from studio_catalog; body says what to do and the acceptance criteria. Use this to keep track of work the user mentions that is not started yet.",
      inputSchema: {
        project: z.string(),
        title: z.string(),
        role: z.string(),
        body: z.string().optional(),
        priority: z.enum(["high", "normal", "low"]).optional(),
        column: z.enum(["backlog", "ready"]).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (i) => {
      const card = await hub.workflow.createCard({
        project: i.project,
        title: i.title,
        role: i.role,
        column: i.column ?? "backlog",
        ...(i.body ? { body: i.body } : {}),
        ...(i.priority ? { priority: i.priority } : {}),
      });
      return text(`Added card ${card.id} "${card.title}" to ${card.column}.`);
    },
  );

  server.registerTool(
    "studio_update_card",
    {
      description:
        "Change a card: move it to another column (approve a proposed card by moving it to backlog or ready), reassign its role, retitle it, change its priority or details. Cards with a job move by themselves as the job goes; move those only when the user asks.",
      inputSchema: {
        card: z.string(),
        column: z.enum(["proposed", "backlog", "ready", "doing", "review", "done", "blocked"]).optional(),
        role: z.string().optional(),
        title: z.string().optional(),
        priority: z.enum(["high", "normal", "low"]).optional(),
        body: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ card, ...patch }) => {
      const c = await hub.workflow.updateCard(card, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      return text(`Card ${c.id} "${c.title}" is in ${c.column}.`);
    },
  );

  server.registerTool(
    "studio_start_card",
    {
      description:
        "Start the job for a card. A free staff member in the card's role takes it (or the one you name with staff); only if none is free is a one-off agent brought in. The card moves through doing, review and done by itself.",
      inputSchema: { card: z.string(), staff: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ card, staff }) => {
      const { attemptId } = await hub.workflow.startCard(card, { ...(staff ? { staff } : {}), by: "the Studio Manager" });
      return text(`Started card ${card} (attempt ${attemptId}).`);
    },
  );

  server.registerTool(
    "studio_restart",
    {
      description:
        "Send a failed or stopped agent back to work in the same thread and worktree, e.g. after it hit a subscription limit. It carries on from where it stopped. Check studio_status and studio_usage first; only restart what the user asked to restart, and not while that plan's limit is still used up.",
      inputSchema: { attemptId: z.string(), note: z.string().optional().describe("Anything the agent should know, e.g. what to do differently") },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ attemptId, note }) => {
      await hub.restart(attemptId, note);
      return text(`Restarted attempt ${attemptId}; it is back at work.`);
    },
  );

  server.registerTool(
    "studio_usage",
    {
      description: "How much of each harness's subscription plan is used (session and weekly windows) and when each resets, as T3 reads it. Use before starting big jobs or restarting agents that hit a limit.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const report = await hub.usage();
      if (!report.length) return text("No plan usage available (T3 reports none for the signed-in harnesses).");
      return text(
        report
          .map((u) => `${u.label}: ` + u.windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}% used${w.resetsAt ? `, resets ${w.resetsAt}` : ""}`).join("; "))
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "studio_plan",
    {
      description: "Ask the Producer to plan a goal into board cards for a project (\"<computer>/<projectId>\"). The cards land in Proposed for the user to approve.",
      inputSchema: { project: z.string(), goal: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ project, goal }) => {
      const [worker, ...rest] = project.split("/");
      const { attemptId } = await hub.workflow.plan({ worker: worker!, project: rest.join("/"), goal });
      return text(`The Producer is planning (attempt ${attemptId}); proposed cards will appear on the Board.`);
    },
  );
}

/** Handle one HTTP request to /mcp. Stateless: a fresh server and transport per request. */
export async function handleMcp(hub: Hub, tokens: Record<McpScope, string>, req: IncomingMessage, res: ServerResponse, body: unknown) {
  const scope = scopeOf(req, tokens);
  if (!scope) {
    res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const server = studioMcpServer(hub, scope);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
