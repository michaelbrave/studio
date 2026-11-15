// The studio simulation (PLAN.md §10): real hub state in, a scene out. Pure: no I/O, no clock of
// its own, so every rule here is testable. The web view only draws what this decides.
//
// Rules from the plan: activity is not progress; unknown, disconnected, waiting and blocked are
// distinct visible states; nothing is invented when the hub does not know.

export type Pose =
  | "working" // the agent is running
  | "waiting" // needs you: an approval or question is pending
  | "unknown" // the hub cannot confirm what is happening
  | "break" // stopped by a subscription limit
  | "done" // result available, waiting for your decision
  | "failed"
  | "preparing"
  | "offline" // its machine is not reachable
  | "idle"; // a hired staff member with no job: at its desk, free for work

/** What the speech bubble over an agent's head says; the view picks an emoji for each. */
export type Bubble = "dots" | "exclamation" | "question" | "sleep" | "star" | "cross" | "bars" | "idea" | "hourglass" | "plug" | null;

export interface SceneInput {
  now: number;
  workers: Array<{ name: string; online: boolean; error: string | null; local: boolean }>;
  roles: Array<{ name: string; title: string; department: string }>;
  kits: Array<{ name: string; title: string; widget: string }>;
  harnesses: Record<string, { label: string; vendor: string; color: string }>;
  jobs: Array<{
    id: string;
    title: string;
    kind: string;
    milestone: string | null;
    reviews_attempt: string | null;
    attempts: Array<{
      id: string;
      worker: string;
      state: string;
      role: string | null;
      kits: string | null;
      provider: string | null;
      model: string | null;
      verdict: string | null;
      created_at: number;
      last_observed_at: number | null;
      /** The hired staff member doing it, if any. */
      staff?: string | null;
      /** When you opened the finished attempt in Studio; looking at it lets the agent move on. */
      seen_at?: number | null;
    }>;
  }>;
  cards: Array<{ id: string; title: string; column: string; role: string; project: string }>;
  /** Latest activity per running Attempt, if the hub has read it. */
  activity: Record<string, { kind: string; title: string | null }>;
  /** Hired staff. Those with no job in the office sit at a desk on their home machine's floor. */
  staff?: Array<{ name: string; displayName: string; role: string; worker: string; runtime: string; model: string | null; kits: string[] }>;
}

export interface Agent {
  /** The Attempt this agent is working on; for an idle staff member, "staff:<name>". */
  attemptId: string;
  /** The hired staff member this is, and its name; null for an agent hired for one job. */
  staff: string | null;
  name: string | null;
  jobId: string;
  jobTitle: string;
  floor: string;
  /** Desk index on the floor; null when the agent is standing somewhere else. */
  desk: number | null;
  /** Where a standing agent is: next to another agent's desk, or at the wall board. */
  visiting: { attemptId: string } | { place: "board" } | null;
  role: string;
  roleTitle: string;
  department: string;
  harness: { provider: string; label: string; vendor: string; color: string };
  model: string;
  kits: Array<{ name: string; title: string; widget: string }>;
  pose: Pose;
  bubble: Bubble;
  /** One line for the hover card. */
  status: string;
  /** The agent's latest visible activity while it runs (a tool call or step title), shortened; null when unknown. */
  doing: string | null;
  /** Picks skin, hair and face so the same agent always looks the same. */
  look: number;
}

export interface Floor {
  worker: string;
  online: boolean;
  local: boolean;
  error: string | null;
  desks: number;
}

export interface Scene {
  floors: Floor[];
  agents: Agent[];
  /** Finished work waiting for your accept or reject, whether or not its agent is still at a desk. */
  toReview: Array<{ attemptId: string; jobId: string; jobTitle: string; name: string | null; roleTitle: string }>;
  /** Cards pinned to the wall, by column; `project` is "<worker>/<projectId>". */
  wall: Record<string, Array<{ id: string; title: string; role: string; project: string }>>;
  /** Desk assignments to pass back in next time, so agents keep their desks. */
  seats: Record<string, number>;
}

/**
 * A result waiting for your review, or a failure, shows at the desk until you open it in Studio,
 * or for this long; then a hired agent is free again (the result itself stays in "to review").
 */
export const REVIEW_WAIT_MS = 2 * 60 * 60_000;
/** Cross-checks, plans and integrations need nothing from you; they show the outcome this long. */
export const LINGER_MS = 10 * 60_000;
export const DESKS_PER_FLOOR = 8;
const ACTIVE = new Set(["queued", "preparing", "running", "awaiting_input", "capacity_paused", "status_unknown"]);

export function poseFor(state: string, online: boolean): Pose {
  if (!online && ACTIVE.has(state)) return "offline";
  switch (state) {
    case "running":
      return "working";
    case "awaiting_input":
      return "waiting";
    case "status_unknown":
      return "unknown";
    case "capacity_paused":
      return "break";
    case "result_available":
      return "done";
    case "failed":
      return "failed";
    default:
      return "preparing";
  }
}

/** What the agent is visibly doing. Activity picks the working bubble; it never implies progress. */
export function bubbleFor(pose: Pose, activity?: { kind: string; title: string | null }): Bubble {
  switch (pose) {
    case "waiting":
      return "exclamation";
    case "unknown":
      return "question";
    case "offline":
      return "plug";
    case "preparing":
      return "hourglass";
    case "break":
      return "sleep";
    case "done":
      return "star";
    case "failed":
      return "cross";
    case "working": {
      const kind = activity?.kind ?? "";
      const text = `${activity?.title ?? ""}`.toLowerCase();
      if (kind === "command_execution" && /\b(test|pytest|jest|vitest|cargo test|go test)\b/.test(text)) return "bars";
      if (kind === "reasoning" || kind === "plan") return "idea";
      return "dots";
    }
    default:
      return null;
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type JobIn = SceneInput["jobs"][number];
type AttemptIn = JobIn["attempts"][number];

/** A result for you to accept or reject, or a failure for you to restart or drop. */
function needsYou(job: JobIn, a: AttemptIn): boolean {
  return (a.state === "result_available" && job.kind === "work" && !job.milestone) || a.state === "failed";
}

/**
 * Whether an Attempt has someone in the office right now. Once you have dealt with the outcome
 * (accepted or rejected it, or opened it to look) the agent is settled: a hired one is free at
 * its desk again, and one brought in for the job goes home.
 */
export function present(job: JobIn, a: AttemptIn, now: number): boolean {
  if (ACTIVE.has(a.state)) return true;
  if (a.state === "stopped") return false;
  const ended = a.last_observed_at ?? a.created_at;
  if (needsYou(job, a)) return !a.seen_at && now - ended < REVIEW_WAIT_MS;
  if (job.kind === "work") return false; // you decided: accepted, rejected or integrated
  return now - ended < LINGER_MS;
}

/** What a finished agent's hover line says: only work waits for your review. */
function doneStatus(job: JobIn, a: AttemptIn): string {
  const verdict = a.verdict ? (a.verdict === "APPROVE" ? "approved" : "changes requested") : null;
  switch (job.kind) {
    case "review":
      return verdict ? `cross-check done: ${verdict}` : "cross-check done";
    case "planning":
      return "plan done: cards are on the Board";
    case "integration":
      return "integration done";
    default:
      return STATUS.done + (verdict ? ` · ${verdict}` : "");
  }
}

export function buildScene(input: SceneInput, previousSeats: Record<string, number> = {}): Scene {
  const online = new Map(input.workers.map((w) => [w.name, w.online]));
  const roles = new Map(input.roles.map((r) => [r.name, r]));
  const kits = new Map(input.kits.map((k) => [k.name, k]));

  // Only the latest attempt of each job is in the office.
  const people: Array<{ job: SceneInput["jobs"][number]; a: SceneInput["jobs"][number]["attempts"][number] }> = [];
  for (const job of input.jobs) {
    const a = job.attempts.at(-1);
    if (a && present(job, a, input.now)) people.push({ job, a });
  }
  people.sort((x, y) => x.a.created_at - y.a.created_at);
  const visibleIds = new Set(people.map((p) => p.a.id));

  const agents: Agent[] = [];
  const seats: Record<string, number> = {};
  const taken = new Map<string, Set<number>>(); // floor → desks in use

  // Reviewers visit the desk of the work they review while it is in the office; the Producer
  // works at the wall board. Everyone else sits at a desk.
  const standing = (job: SceneInput["jobs"][number]): Agent["visiting"] => {
    if (job.reviews_attempt && visibleIds.has(job.reviews_attempt)) return { attemptId: job.reviews_attempt };
    if (job.kind === "planning") return { place: "board" };
    return null;
  };

  // Who is in the office: each present Attempt, then each staff member with no job here. Staff
  // keep one seat ("staff:<name>") whether idle or working, so they do not change desks.
  const staffBy = new Map((input.staff ?? []).map((m) => [m.name, m]));
  const floors = new Set(input.workers.map((w) => w.name));
  type Occupant = { key: string; floor: string; visiting: Agent["visiting"]; make: (desk: number | null) => Agent };
  const occupants: Occupant[] = [];
  const seatKeys = new Set<string>();
  for (const { job, a } of people) {
    const member = a.staff ? staffBy.get(a.staff) : undefined;
    const staffKey = a.staff ? `staff:${a.staff}` : null;
    const key = staffKey && !seatKeys.has(staffKey) ? staffKey : a.id;
    seatKeys.add(key);
    occupants.push({
      key,
      floor: a.worker,
      visiting: standing(job),
      make: (desk) => {
        const role = roles.get(a.role ?? "");
        const harness = input.harnesses[a.provider ?? ""] ?? { label: a.provider ?? "?", vendor: "?", color: "#777777" };
        const pose = poseFor(a.state, online.get(a.worker) ?? false);
        const bubble = bubbleFor(pose, input.activity[a.id]);

        return {
          attemptId: a.id,
          staff: a.staff ?? null,
          name: member?.displayName ?? a.staff ?? null,
          jobId: job.id,
          jobTitle: job.title,
          floor: a.worker,
          desk,
          visiting: standing(job),
          role: a.role ?? "",
          roleTitle: role?.title ?? a.role ?? "Agent",
          department: role?.department ?? "",
          harness: { provider: a.provider ?? "", ...harness },
          model: a.model ?? "default model",
          kits: (a.kits ? (JSON.parse(a.kits) as string[]) : []).map((k) => kits.get(k) ?? { name: k, title: k, widget: "toolbox" }),
          pose,
          bubble,
          status: pose === "done" ? doneStatus(job, a) : STATUS[pose],
          doing: pose === "working" ? doingLine(input.activity[a.id]) : null,
          look: hash(a.staff ? `staff:${a.staff}` : a.id),
        };
      },
    });
  }
  for (const m of input.staff ?? []) {
    const key = `staff:${m.name}`;
    if (seatKeys.has(key)) continue; // at work
    // A staff member whose home machine is gone sits on the first floor there is.
    const floor = floors.has(m.worker) ? m.worker : input.workers[0]?.name;
    if (!floor) continue;
    seatKeys.add(key);
    occupants.push({
      key,
      floor,
      visiting: null,
      make: (desk) => {
        const role = roles.get(m.role);
        const harness = input.harnesses[m.runtime] ?? { label: m.runtime, vendor: "?", color: "#777777" };
        const pose: Pose = online.get(floor) ? "idle" : "offline";
        return {
          attemptId: key,
          staff: m.name,
          name: m.displayName,
          jobId: "",
          jobTitle: "No job yet",
          floor,
          desk,
          visiting: null,
          role: m.role,
          roleTitle: role?.title ?? m.role,
          department: role?.department ?? "",
          harness: { provider: m.runtime, ...harness },
          model: m.model ?? "default model",
          kits: m.kits.map((k) => kits.get(k) ?? { name: k, title: k, widget: "toolbox" }),
          pose,
          bubble: bubbleFor(pose),
          status: STATUS[pose],
          doing: null,
          look: hash(key),
        };
      },
    });
  }

  // Keep previous seats first, then fill free desks in arrival order.
  const order = [
    ...occupants.filter((o) => previousSeats[o.key] !== undefined),
    ...occupants.filter((o) => previousSeats[o.key] === undefined),
  ];
  for (const o of order) {
    let desk: number | null = null;
    if (!o.visiting) {
      const used = taken.get(o.floor) ?? new Set<number>();
      const prev = previousSeats[o.key];
      desk = prev !== undefined && !used.has(prev) ? prev : [...Array(DESKS_PER_FLOOR).keys()].find((d) => !used.has(d)) ?? null;
      if (desk === null) continue; // a full floor: the extra agent waits off screen
      used.add(desk);
      taken.set(o.floor, used);
      seats[o.key] = desk;
    }
    agents.push(o.make(desk));
  }

  const wall: Scene["wall"] = {};
  for (const c of input.cards) (wall[c.column] ??= []).push({ id: c.id, title: c.title, role: c.role, project: c.project });

  const toReview: Scene["toReview"] = [];
  for (const job of input.jobs) {
    const a = job.attempts.at(-1);
    if (!a || a.state !== "result_available" || job.kind !== "work" || job.milestone) continue;
    const member = a.staff ? staffBy.get(a.staff) : undefined;
    toReview.push({
      attemptId: a.id,
      jobId: job.id,
      jobTitle: job.title,
      name: member?.displayName ?? a.staff ?? null,
      roleTitle: roles.get(a.role ?? "")?.title ?? a.role ?? "Agent",
    });
  }

  return {
    floors: input.workers.map((w) => ({ worker: w.name, online: w.online, local: w.local, error: w.error, desks: DESKS_PER_FLOOR })),
    agents,
    toReview,
    wall,
    seats,
  };
}

/** One short line from the latest activity, for the label over an agent's head. */
export function doingLine(activity?: { kind: string; title: string | null }): string | null {
  const text = (activity?.title ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

const STATUS: Record<Pose, string> = {
  working: "working",
  waiting: "needs you",
  unknown: "status unknown",
  break: "on a break (usage limit)",
  done: "done, waiting for your review",
  failed: "failed",
  preparing: "getting ready",
  offline: "machine unreachable",
  idle: "free: give me a job",
};
