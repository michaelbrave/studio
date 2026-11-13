// The task board: kanban cards kept as markdown files in the vault, so the board is versioned
// and synced with git and needs no hosting. Each card is assigned to a Role, whose department
// is its column of people in the studio.

import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Vault } from "./vault.ts";

export const COLUMNS = ["proposed", "backlog", "ready", "doing", "review", "done", "blocked"] as const;
export type Column = (typeof COLUMNS)[number];

export interface Card {
  id: string;
  title: string;
  column: Column;
  /** "<worker>/<projectId>": where the work happens. */
  project: string;
  /** Role name the card is assigned to (its hat and department). */
  role: string;
  priority: "high" | "normal" | "low";
  /** Jobs started from this card, oldest first. */
  jobs: string[];
  /** Who wrote the card: you, or the Producer job that proposed it. */
  createdBy: string;
  created: string;
  /** Description and acceptance criteria, in markdown. */
  body: string;
}

const cardPath = (id: string) => `board/cards/${id}.md`;

export function serializeCard(card: Card): string {
  const { body, ...meta } = card;
  return `---\n${stringifyYaml(meta).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export function parseCard(text: string): Card | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return undefined;
  const meta = parseYaml(m[1]!) as Partial<Card> | null;
  if (!meta?.id || !meta.title) return undefined;
  return {
    id: meta.id,
    title: meta.title,
    column: COLUMNS.includes(meta.column as Column) ? (meta.column as Column) : "backlog",
    project: meta.project ?? "",
    role: meta.role ?? "",
    priority: meta.priority === "high" || meta.priority === "low" ? meta.priority : "normal",
    jobs: Array.isArray(meta.jobs) ? meta.jobs.map(String) : [],
    createdBy: meta.createdBy ?? "you",
    created: meta.created ?? "",
    body: (m[2] ?? "").trim(),
  };
}

export class Board {
  private readonly vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  async list(): Promise<Card[]> {
    const cards: Card[] = [];
    for (const file of await this.vault.list("board/cards")) {
      const card = parseCard((await this.vault.read(`board/cards/${file}`)) ?? "");
      if (card) cards.push(card);
    }
    return cards.sort((a, b) => a.created.localeCompare(b.created));
  }

  async get(id: string): Promise<Card> {
    const card = parseCard((await this.vault.read(cardPath(id))) ?? "");
    if (!card) throw new Error(`no card ${id}`);
    return card;
  }

  async create(input: Omit<Card, "id" | "jobs" | "created"> & { jobs?: string[] }): Promise<Card> {
    const card: Card = { ...input, id: `card-${randomUUID().slice(0, 8)}`, jobs: input.jobs ?? [], created: new Date().toISOString() };
    await this.vault.write(cardPath(card.id), serializeCard(card));
    return card;
  }

  async update(id: string, patch: Partial<Omit<Card, "id" | "created">>): Promise<Card> {
    const card = { ...(await this.get(id)), ...patch };
    await this.vault.write(cardPath(id), serializeCard(card));
    return card;
  }

  /** The card a Job was started from, if any. */
  async forJob(jobId: string): Promise<Card | undefined> {
    return (await this.list()).find((c) => c.jobs.includes(jobId));
  }
}
