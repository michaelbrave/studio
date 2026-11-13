// Notifications: when an agent needs you, finishes, fails or stops, or a machine drops off, the hub
// posts one line to a webhook. Built for a Hermes webhook route with `deliver_only: true` that
// forwards the line to a Discord channel without running a model (see docs/discord.md).
//
// Each event is sent once: what was last announced per Attempt is kept in the database, so a
// restart does not repeat old news. On the very first run, current states are recorded silently.

import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface NotifyConfig {
  /** e.g. http://127.0.0.1:8644/webhooks/studio */
  url: string;
  /** The route's HMAC secret. */
  secret: string;
  /** Where Studio is, for the link in each message. */
  studioUrl?: string;
  /** Daily brief time, local "HH:MM" (default "08:00"); false for no brief. See brief.ts. */
  brief?: string | false;
}

/** ~/.config/studio/notify.json, or null when notifications are not set up. */
export async function readNotifyConfig(home: string): Promise<NotifyConfig | null> {
  try {
    const c = JSON.parse(await readFile(join(home, "notify.json"), "utf8")) as NotifyConfig;
    return c.url && c.secret ? c : null;
  } catch {
    return null;
  }
}

const SEEDED = "_seeded";

/** Attempt states worth telling you about. Everything else (queued, preparing, running...) is quiet. */
const ANNOUNCED = new Set(["awaiting_input", "result_available", "failed", "capacity_paused", "status_unknown"]);

export interface AttemptView {
  id: string;
  state: string;
  worker: string;
  roleTitle: string;
  jobTitle: string;
  jobKind: string;
  verdict: string | null;
  error: string | null;
}

export interface StudioEvent {
  id: string;
  event_type: string;
  attempt_id: string | null;
  worker: string;
  message: string;
}

/** What changed since last time, as events; and the new announced-state map to store. */
export function diffEvents(
  previous: Map<string, string>,
  attempts: AttemptView[],
  detail: (a: AttemptView) => string | undefined = () => undefined,
): { events: StudioEvent[]; next: Map<string, string> } {
  const next = new Map(previous);
  const events: StudioEvent[] = [];
  for (const a of attempts) {
    if (!ANNOUNCED.has(a.state)) {
      // Back to work: forget, so the same state later is news again.
      if (next.has(a.id) && a.state === "running") next.delete(a.id);
      continue;
    }
    if (previous.get(a.id) === a.state) continue;
    next.set(a.id, a.state);
    events.push({
      id: `${a.id}:${a.state}:${randomUUID().slice(0, 8)}`,
      event_type: `attempt.${a.state}`,
      attempt_id: a.id,
      worker: a.worker,
      message: describe(a, detail(a)),
    });
  }
  return { events, next };
}

function describe(a: AttemptView, detail?: string): string {
  const who = `**${a.roleTitle}**`;
  const job = `“${a.jobTitle}”`;
  const where = ` · ${a.worker}`;
  switch (a.state) {
    case "awaiting_input":
      return [`🙋 ${who} needs you on ${job}${where}`, detail ? `> ${clip(detail, 300).replace(/\n/g, "\n> ")}` : null, "Reply here to approve or deny."]
        .filter(Boolean)
        .join("\n");
    case "result_available":
      if (a.jobKind === "review") {
        const v = a.verdict === "APPROVE" ? "approved it" : a.verdict ? "asked for changes" : "finished the review";
        return `🔍 ${who} ${v}: ${job}${where}`;
      }
      if (a.jobKind === "planning") return `🗂️ ${who} proposed cards: ${job}${where}. Approve them on the Board.`;
      if (a.jobKind === "integration") return `🔀 ${who} finished integrating ${job}${where}`;
      return `✅ ${who} finished ${job}${where}. Ready for your review.`;
    case "failed":
      return `❌ ${who} failed on ${job}${where}${a.error ? `\n> ${clip(a.error, 200)}` : ""}`;
    case "capacity_paused":
      return `☕ ${who} hit a usage limit on ${job}${where}. It continues when the limit resets.`;
    case "status_unknown":
      return `❓ Studio lost track of ${who} on ${job}${where}. Check it in Studio.`;
    default:
      return `${who}: ${a.state} on ${job}${where}`;
  }
}

function clip(s: string, n: number) {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Signed POST in the Hermes generic-webhook V2 format: HMAC-SHA256 hex of "<timestamp>.<body>". */
export function signedRequest(config: NotifyConfig, event: StudioEvent, now = Date.now()) {
  const body = JSON.stringify(event);
  const ts = String(Math.floor(now / 1000));
  const sig = createHmac("sha256", config.secret).update(`${ts}.${body}`).digest("hex");
  return {
    url: config.url,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Webhook-Timestamp": ts,
        "X-Webhook-Signature-V2": sig,
        "X-Request-ID": event.id,
      },
      body,
    },
  };
}

export class Notifier {
  private readonly db: DatabaseSync;
  private readonly config: NotifyConfig | null;
  private workersSeen: Map<string, boolean> | null = null;
  /** After a failed send, wait before trying again rather than retrying every tick. */
  private retryAt = 0;

  constructor(db: DatabaseSync, config: NotifyConfig | null) {
    this.db = db;
    this.config = config;
    db.exec("CREATE TABLE IF NOT EXISTS notified (attempt_id TEXT PRIMARY KEY, state TEXT NOT NULL)");
  }

  get enabled() {
    return this.config !== null;
  }

  /** The configured brief time (undefined = default), or false when off or notifications are off. */
  get briefSetting(): string | false | undefined {
    return this.config ? this.config.brief : false;
  }

  /** Send one message that is not about a single attempt (the daily brief). */
  async post(eventType: string, message: string): Promise<boolean> {
    if (!this.config) return false;
    return this.send({ id: `${eventType}:${randomUUID().slice(0, 8)}`, event_type: eventType, attempt_id: null, worker: "", message });
  }

  async check(attempts: AttemptView[], workers: Array<{ name: string; online: boolean }>, detail: (a: AttemptView) => Promise<string | undefined>) {
    if (!this.config || Date.now() < this.retryAt) return;
    const rows = this.db.prepare("SELECT attempt_id, state FROM notified").all() as Array<{ attempt_id: string; state: string }>;
    const first = rows.length === 0;
    const previous = new Map(rows.filter((r) => r.attempt_id !== SEEDED).map((r) => [r.attempt_id, r.state]));

    // Details (what an approval is for) cost a worker call, so fetch them only for new events.
    const details = new Map<string, string | undefined>();
    for (const a of attempts) if (a.state === "awaiting_input" && previous.get(a.id) !== a.state) details.set(a.id, await detail(a).catch(() => undefined));
    const { events, next } = diffEvents(previous, attempts, (a) => details.get(a.id));

    // Machines going away and coming back.
    const seen = this.workersSeen;
    this.workersSeen = new Map(workers.map((w) => [w.name, w.online]));
    if (seen) {
      for (const w of workers) {
        const was = seen.get(w.name);
        if (was === undefined || was === w.online) continue;
        events.push({
          id: `worker:${w.name}:${w.online}:${randomUUID().slice(0, 8)}`,
          event_type: w.online ? "worker.online" : "worker.offline",
          attempt_id: null,
          worker: w.name,
          message: w.online ? `🔌 **${w.name}** is back online.` : `🔌 **${w.name}** is unreachable. Its agents show as offline in Studio.`,
        });
      }
    }

    const save = this.db.prepare("INSERT INTO notified (attempt_id, state) VALUES (?, ?) ON CONFLICT(attempt_id) DO UPDATE SET state = excluded.state");
    const drop = this.db.prepare("DELETE FROM notified WHERE attempt_id = ?");
    for (const id of previous.keys()) if (!next.has(id)) drop.run(id);
    if (first) {
      // Don't announce the past: record where things stand and start from here.
      for (const [id, state] of next) save.run(id, state);
      save.run(SEEDED, "-");
      return;
    }
    for (const e of events) {
      if (!(await this.send(e))) {
        // Not recorded, so it is sent once the webhook answers again.
        this.retryAt = Date.now() + 60_000;
        return;
      }
      if (e.attempt_id) save.run(e.attempt_id, e.event_type.slice("attempt.".length));
    }
  }

  private async send(e: StudioEvent): Promise<boolean> {
    const message = this.config!.studioUrl ? `${e.message}\n<${this.config!.studioUrl}>` : e.message;
    const { url, init } = signedRequest(this.config!, { ...e, message });
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) console.error(`notify: ${res.status} from ${url}: ${(await res.text()).slice(0, 200)}`);
      return res.ok;
    } catch (err) {
      console.error(`notify: ${url} unreachable: ${(err as Error).message}`);
      return false;
    }
  }
}
