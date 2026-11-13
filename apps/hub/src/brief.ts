// The morning brief: once a day, one Discord message with what happened since the last brief and
// what stands now (waiting for you, ready to review, working, machines down). Built only from the
// hub's own records (attempt_log, jobs, the board), so it costs no model tokens and never guesses.
//
// Scheduling: at the time in notify.json "brief" (default "08:00", false turns it off). If the hub
// was off at that time, the brief is sent when it starts, up to CATCH_UP after the hour; later than
// that the day is skipped. Each day's brief is recorded so a restart does not send it twice.

import type { DatabaseSync } from "node:sqlite";

/** Late briefs still go out up to this long after the set time (e.g. the PC was off at 08:00). */
export const CATCH_UP = 4 * 60 * 60 * 1000;
/** Most items listed per section; the rest become "+N more". */
const LIST = 6;
/** Discord rejects messages over 2000 characters; leave room for the Studio link. */
const MAX = 1900;

export interface Item {
  roleTitle: string;
  jobTitle: string;
  worker: string;
}

export interface LogRow extends Item {
  attemptId: string;
  at: number;
  fromState: string | null;
  toState: string;
  reason: string;
  jobKind: string;
  verdict: string | null;
}

export interface BriefInput {
  now: number;
  since: number;
  /** attempt_log rows between since and now, joined with their job and role. */
  log: LogRow[];
  waiting: Item[];
  toReview: Item[];
  working: Item[];
  proposedCards: number;
  /** Card counts per column (proposed is reported separately). */
  board: Record<string, number>;
  workers: Array<{ name: string; online: boolean }>;
}

/** "08:00" -> today's timestamp at that local time; null when the brief is off or malformed. */
export function scheduledAt(setting: string | false | undefined, now: number): number | null {
  if (setting === false) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(setting ?? "08:00");
  if (!m || +m[1]! > 23 || +m[2]! > 59) return null;
  const d = new Date(now);
  d.setHours(+m[1]!, +m[2]!, 0, 0);
  return d.getTime();
}

/** Local calendar day, the key a sent brief is recorded under. */
export const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Is today's brief due now? */
export function briefDue(setting: string | false | undefined, now: number, sentToday: boolean): boolean {
  const at = scheduledAt(setting, now);
  return at !== null && !sentToday && now >= at && now - at <= CATCH_UP;
}

const who = (i: Item) => `${i.roleTitle} “${i.jobTitle}” · ${i.worker}`;

function section(icon: string, label: string, items: string[]): string | null {
  if (!items.length) return null;
  const shown = items.slice(0, LIST).map((s) => `  • ${s}`);
  if (items.length > LIST) shown.push(`  • +${items.length - LIST} more`);
  return `${icon} ${label} (${items.length})\n${shown.join("\n")}`;
}

function since(since: number, now: number): string {
  const d = new Date(since);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (now - since < 36 * 60 * 60 * 1000 && dayKey(since) !== dayKey(now)) return `since yesterday ${time}`;
  if (dayKey(since) === dayKey(now)) return `since ${time}`;
  return `since ${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

/** The brief's text. Pure, so it is tested without a hub. */
export function composeBrief(b: BriefInput): string {
  // What happened: each attempt counted once per kind of event.
  const seen = new Set<string>();
  const once = (kind: string, r: LogRow) => !seen.has(`${kind}:${r.attemptId}`) && seen.add(`${kind}:${r.attemptId}`);
  const finished: string[] = [];
  const reviews: string[] = [];
  const planned: string[] = [];
  const failed: string[] = [];
  const accepted: string[] = [];
  const rejected: string[] = [];
  const integrated: string[] = [];
  let limits = 0;
  for (const r of b.log) {
    const entered = r.fromState !== r.toState;
    if (entered && r.toState === "result_available" && once("done", r)) {
      if (r.jobKind === "review") {
        const v = r.verdict === "APPROVE" ? "approved" : r.verdict ? "asked for changes on" : "reviewed";
        reviews.push(`${r.roleTitle} ${v} “${r.jobTitle}”`);
      } else if (r.jobKind === "planning") planned.push(who(r));
      else if (r.jobKind !== "integration") finished.push(who(r));
    } else if (entered && r.toState === "failed" && once("failed", r)) failed.push(who(r));
    else if (entered && r.toState === "capacity_paused" && once("limit", r)) limits++;
    else if (r.reason === "you accepted the result" && once("accepted", r)) accepted.push(`“${r.jobTitle}”`);
    else if (r.reason.startsWith("you rejected the result") && once("rejected", r)) rejected.push(`“${r.jobTitle}”`);
    else if (r.reason.startsWith("integrated as ") && once("integrated", r)) integrated.push(`“${r.jobTitle}” (${r.reason.slice(14)})`);
  }

  const out: string[] = [`☀️ **Studio brief** · ${since(b.since, b.now)}`];
  const happened = [
    section("✅", "Finished", finished),
    section("🔍", "Reviews", reviews),
    section("🗂️", "Plans proposed", planned),
    section("❌", "Failed", failed),
    section("👍", "You accepted", accepted),
    section("↩️", "You sent back", rejected),
    section("🔀", "Integrated", integrated),
    limits ? `☕ Usage limits hit: ${limits}` : null,
  ].filter((s): s is string => s !== null);
  out.push(happened.length ? happened.join("\n") : "Nothing finished, failed or merged.");

  const offline = b.workers.filter((w) => !w.online).map((w) => w.name);
  const now = [
    section("🙋", "Waiting for you", b.waiting.map(who)),
    section("👀", "Ready for your review", b.toReview.map(who)),
    section("🛠️", "Working", b.working.map(who)),
    b.proposedCards ? `🗂️ ${b.proposedCards} proposed card${b.proposedCards === 1 ? "" : "s"} to approve on the Board` : null,
    offline.length ? `🔌 Offline: ${offline.join(", ")}` : null,
  ].filter((s): s is string => s !== null);
  out.push(`**Now**\n${now.length ? now.join("\n") : "Nothing is running or waiting for you."}`);

  const board = ["ready", "doing", "review", "blocked", "done"].filter((c) => b.board[c]).map((c) => `${b.board[c]} ${c}`);
  if (board.length) out.push(`Board: ${board.join(" · ")}`);

  const text = out.join("\n\n");
  return text.length > MAX ? `${text.slice(0, MAX - 30)}…\n(more in Studio)` : text;
}

/** Which days have had their brief, and when the last one went out. */
export class BriefLog {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("CREATE TABLE IF NOT EXISTS briefs (day TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }
  sent(day: string): boolean {
    return this.db.prepare("SELECT 1 FROM briefs WHERE day = ?").get(day) !== undefined;
  }
  /** When the previous brief went out, or a day ago if there never was one. */
  lastAt(now: number): number {
    const row = this.db.prepare("SELECT MAX(at) AS at FROM briefs").get() as { at: number | null };
    return row.at ?? now - 24 * 60 * 60 * 1000;
  }
  record(day: string, at: number) {
    this.db.prepare("INSERT OR REPLACE INTO briefs (day, at) VALUES (?, ?)").run(day, at);
  }
}
