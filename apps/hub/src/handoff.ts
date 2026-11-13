// Reads the "## Handoff" block every Kit-equipped agent ends with (kits/handoff). Agents write it
// by hand, so parsing is tolerant: the last block wins, and missing fields are undefined.

import { parse as parseYaml } from "yaml";

export const OUTCOMES = ["MERGED", "CONFLICT", "TESTS FAILED", "NOT CLEAN"] as const;

export interface Handoff {
  status?: "done" | "partial" | "blocked";
  /** Full or abbreviated sha, as the agent reported it. */
  commit?: string;
  verdict?: "APPROVE" | "CHANGES REQUESTED";
  /** Integrator only: what happened to the merge. */
  outcome?: (typeof OUTCOMES)[number];
  /** The "Notes for the reviewer" line, for job notes. */
  notes?: string;
}

export function parseHandoff(text: string): Handoff | undefined {
  // Prefer the last "## Handoff" block. Agents without the Handoff Kit sometimes write the fields
  // without the heading; then read the whole message, so "Commit:"/"Outcome:" lines still count.
  const at = text.lastIndexOf("## Handoff");
  const block = at >= 0 ? text.slice(at) : text;
  if (at < 0 && !/^\s*\**(Status|Commit|Outcome|Verdict)\**:/im.test(text)) return undefined;
  const field = (name: string) => block.match(new RegExp(`^\\s*\\**${name}\\**:\\s*\\**\\s*(.+?)\\s*$`, "im"))?.[1];

  const status = field("Status")?.toLowerCase().match(/^(done|partial|blocked)\b/)?.[1] as Handoff["status"];
  const commit = field("Commit")?.match(/\b([0-9a-f]{7,40})\b/i)?.[1]?.toLowerCase();
  const rawVerdict = field("Verdict")?.toUpperCase() ?? "";
  const verdict = rawVerdict.startsWith("APPROVE")
    ? "APPROVE"
    : rawVerdict.startsWith("CHANGES REQUESTED")
      ? "CHANGES REQUESTED"
      : undefined;
  const rawOutcome = field("Outcome")?.toUpperCase() ?? "";
  const outcome = OUTCOMES.find((o) => rawOutcome.startsWith(o));
  const notes = field("Notes for the reviewer");
  return {
    ...(status ? { status } : {}),
    ...(commit ? { commit } : {}),
    ...(verdict ? { verdict } : {}),
    ...(outcome ? { outcome } : {}),
    ...(notes ? { notes } : {}),
  };
}

export interface ProposedCard {
  title: string;
  role: string;
  priority: "high" | "normal" | "low";
  dependsOn: string[];
  description: string;
}

/** The Producer's plan: the last ```cards block, a YAML list. Malformed entries are skipped. */
export function parseCards(text: string): ProposedCard[] {
  const blocks = [...text.matchAll(/```cards\s*\n([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return [];
  let raw: unknown;
  try {
    raw = parseYaml(last);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c: Record<string, unknown>) => {
    if (typeof c?.title !== "string" || typeof c.role !== "string") return [];
    const priority = c.priority === "high" || c.priority === "low" ? c.priority : "normal";
    return [
      {
        title: c.title.trim(),
        role: c.role.trim(),
        priority,
        dependsOn: Array.isArray(c.depends_on) ? c.depends_on.map(String) : [],
        description: typeof c.description === "string" ? c.description.trim() : "",
      },
    ];
  });
}

/** Two shas name the same commit if one is a prefix of the other (agents often abbreviate). */
export function sameCommit(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}
