// Staff (PLAN.md §7, "Staff (agent)"): a persistent agent you hire. It has a name, a Role it was
// hired into (a built-in one, or one made for it when hired from scratch or imported), the harness
// and model it runs on, its own soul, and the Kits it carries. It sits at a desk on its home
// machine's floor when it has no job, and does the work when you give it one.
//
// Everything is plain files under STUDIO_HOME, so it is readable and versionable without Studio:
//   staff/<name>/staff.yaml   who it is and how it runs
//   staff/<name>/soul.md      its own personality, when it has one
//   roles/<name>/             a Role made for it (from scratch or imported)
//   kits/<name>-tools/        the MCP servers and skills you picked from this computer

import { access, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PROVIDERS, type McpServer, type Provider } from "@studio/kits";
import { parse as parseYaml, stringify as toYaml } from "yaml";

export interface StaffMember {
  /** Kebab-case id; also its folder name. */
  name: string;
  /** What you call it, e.g. "Ada". */
  displayName: string;
  role: string;
  /** The machine whose floor it sits on when it has no job. */
  worker: string;
  runtime: Provider;
  /** Null means the harness's default model. */
  model: string | null;
  kits: string[];
  /** "role": use the Role's soul. "none": no personality section. "own": staff/<name>/soul.md. */
  soul: "role" | "none" | "own";
  hiredAt: string;
}

export type SoulChoice = { kind: "role" } | { kind: "none" } | { kind: "text"; text: string };

export interface HireInput {
  displayName: string;
  worker: string;
  /** "template": hire into an existing Role. "scratch" and "import": a new Role is made for it. */
  from: "template" | "scratch" | "import";
  role?: string;
  title?: string;
  description?: string;
  /** Duties and hard rules for a new Role (its rules.md). */
  duties?: string;
  department?: string;
  runtime: Provider;
  model?: string | null;
  soul: SoulChoice;
  kits?: string[];
  /** MCP servers and skills found on this computer (discoverTools) to give it. */
  mcp?: string[];
  skills?: string[];
}

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent"
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/** `---` YAML front matter and the body after it; no front matter means it is all body. */
export function frontMatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  try {
    const meta = parseYaml(m[1]!);
    return { meta: typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>) : {}, body: m[2]! };
  } catch {
    return { meta: {}, body: m[2]! };
  }
}

export class Staff {
  readonly dir: string;
  readonly rolesDir: string;
  readonly kitsDir: string;
  private readonly builtin: { roles: string; kits: string };
  /** Where to look for MCP servers and skills already set up (your home folder). */
  private readonly userHome: string;

  /** `home` is STUDIO_HOME; built-in Roles and Kits are only read, never written. */
  constructor(home: string, builtin: { roles: string; kits: string }, userHome = homedir()) {
    this.builtin = builtin;
    this.userHome = userHome;
    this.dir = join(home, "staff");
    this.rolesDir = join(home, "roles");
    this.kitsDir = join(home, "kits");
  }

  async list(): Promise<StaffMember[]> {
    const names = await subdirs(this.dir);
    const all = await Promise.all(names.map((n) => this.get(n).catch(() => null)));
    return all.filter((s): s is StaffMember => s !== null).sort((a, b) => a.hiredAt.localeCompare(b.hiredAt));
  }

  async get(name: string): Promise<StaffMember> {
    if (!KEBAB.test(name)) throw new Error(`no staff member named ${name}`);
    const raw = parseYaml(await readFile(join(this.dir, name, "staff.yaml"), "utf8").catch(() => {
      throw new Error(`no staff member named ${name}`);
    })) as Partial<StaffMember>;
    return {
      name,
      displayName: raw.displayName ?? name,
      role: String(raw.role ?? ""),
      worker: String(raw.worker ?? ""),
      runtime: (PROVIDERS as readonly string[]).includes(String(raw.runtime)) ? (raw.runtime as Provider) : "claude",
      model: raw.model ?? null,
      kits: Array.isArray(raw.kits) ? raw.kits.map(String) : [],
      soul: raw.soul === "none" || raw.soul === "own" ? raw.soul : "role",
      hiredAt: String(raw.hiredAt ?? ""),
    };
  }

  /** The soul text this staff member brings, or undefined to use its Role's. */
  async soulOverride(s: StaffMember): Promise<string | undefined> {
    if (s.soul === "none") return "";
    if (s.soul === "own") return readFile(join(this.dir, s.name, "soul.md"), "utf8").catch(() => "");
    return undefined;
  }

  /**
   * Hire: write the staff member, and the Role and tools Kit made for it if any. Checks everything
   * before writing anything, so a failed hire leaves no half-made files behind.
   */
  async hire(input: HireInput, known: { roles: string[]; kits: string[]; workers: string[] }): Promise<StaffMember> {
    const displayName = input.displayName?.trim();
    if (!displayName) throw new Error("give your agent a name");
    if (!(PROVIDERS as readonly string[]).includes(input.runtime)) throw new Error(`unknown harness ${input.runtime}`);
    if (!known.workers.includes(input.worker)) throw new Error(`unknown computer ${input.worker}`);
    const taken = new Set(await subdirs(this.dir));
    const name = unique(slug(displayName), taken);

    const kits = [...new Set(input.kits ?? [])];
    const unknownKits = kits.filter((k) => !known.kits.includes(k));
    if (unknownKits.length) throw new Error(`unknown kits: ${unknownKits.join(", ")}`);

    // The Role: an existing one, or a new one made for this agent.
    let role: string;
    let newRole: { name: string; yaml: Record<string, unknown>; soul?: string; rules?: string } | null = null;
    if (input.from === "template") {
      if (!input.role || !known.roles.includes(input.role)) throw new Error("pick a role to start from");
      role = input.role;
    } else {
      const title = input.title?.trim();
      if (!title) throw new Error("give the job a title, e.g. \"Release Notes Writer\"");
      role = unique(slug(title), new Set(known.roles));
      const others = PROVIDERS.filter((p) => p !== input.runtime);
      newRole = {
        name: role,
        yaml: {
          name: role,
          version: "1",
          title,
          department: input.department?.trim() || "Staff",
          description: input.description?.trim() || `${title}, hired in Studio.`,
          runtime: { preferred: input.runtime, fallback: others },
          model: input.model ? { default: input.model } : {},
          permissions: { preset: "workspace-write", deny: ["Bash(git push*)"] },
          kits: { default: [], optional: [] }, // filled in below
          memory: { read: ["studio/", "projects/{project}/", "staff/{staff}/"], write: ["staff/{staff}/", "projects/{project}/inbox/"] },
          game: { points: ["tech", "polish"], categories: ["quality"] },
        },
      };
      if (input.duties?.trim()) newRole.rules = input.duties.trim() + "\n";
      // An agent made from scratch carries its soul in its Role, so other jobs in that Role get it too.
      if (input.soul.kind === "text" && input.soul.text.trim()) newRole.soul = input.soul.text.trim() + "\n";
    }

    // MCP servers and skills from this computer go into a Kit of the agent's own.
    const tools = await this.toolsKit(name, displayName, input.mcp ?? [], input.skills ?? []);
    if (tools) kits.push(tools.name);

    if (newRole) {
      newRole.yaml.kits = { default: kits, optional: known.kits.filter((k) => !kits.includes(k)) };
      if (newRole.soul) newRole.yaml.soul = "soul.md";
      if (newRole.rules) newRole.yaml.rules = "rules.md";
    }

    // Write: tools Kit, then Role, then the staff member (the last makes it visible).
    if (tools) await tools.write();
    if (newRole) {
      const dir = join(this.rolesDir, newRole.name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "role.yaml"), toYaml(newRole.yaml));
      if (newRole.soul) await writeFile(join(dir, "soul.md"), newRole.soul);
      if (newRole.rules) await writeFile(join(dir, "rules.md"), newRole.rules);
    }
    let soul: StaffMember["soul"] = input.soul.kind === "none" ? "none" : "role";
    if (input.soul.kind === "text" && !newRole?.soul) soul = input.soul.text.trim() ? "own" : "none";
    const member: StaffMember = {
      name,
      displayName,
      role,
      worker: input.worker,
      runtime: input.runtime,
      model: input.model || null,
      kits,
      soul,
      hiredAt: new Date().toISOString(),
    };
    const dir = join(this.dir, name);
    await mkdir(dir, { recursive: true });
    if (soul === "own") await writeFile(join(dir, "soul.md"), (input.soul as { text: string }).text.trim() + "\n");
    const { name: _n, ...rest } = member;
    await writeFile(join(dir, "staff.yaml"), toYaml(rest));
    return member;
  }

  /**
   * Let a staff member go. Its files are removed; jobs it did keep their records. A Role or tools
   * Kit made only for it stays, so other jobs can still use it (delete the folder to remove it).
   */
  async fire(name: string): Promise<void> {
    await this.get(name);
    await rm(join(this.dir, name), { recursive: true, force: true });
  }

  /** Plan a Kit holding the MCP servers and skills picked from this computer. */
  private async toolsKit(name: string, displayName: string, mcp: string[], skills: string[]) {
    if (!mcp.length && !skills.length) return null;
    const found = await discoverTools(this.userHome);
    const servers: Record<string, McpServer> = {};
    for (const m of mcp) {
      const s = found.mcp.find((x) => x.name === m);
      if (!s) throw new Error(`MCP server ${m} was not found on this computer`);
      servers[m] = s.config;
    }
    const picked = skills.map((k) => {
      const s = found.skills.find((x) => x.name === k);
      if (!s) throw new Error(`skill ${k} was not found on this computer`);
      return s;
    });
    const kitName = unique(`${name}-tools`, new Set(await subdirs(this.kitsDir)));
    const dir = join(this.kitsDir, kitName);
    return {
      name: kitName,
      write: async () => {
        await mkdir(dir, { recursive: true });
        for (const s of picked) await cp(s.dir, join(dir, "skills", s.name), { recursive: true });
        if (mcp.length) await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2) + "\n");
        await writeFile(
          join(dir, "kit.yaml"),
          toYaml({
            name: kitName,
            version: "1",
            title: `${displayName}'s tools`,
            description: [mcp.length ? `MCP: ${mcp.join(", ")}` : "", picked.length ? `Skills: ${picked.map((s) => s.name).join(", ")}` : ""]
              .filter(Boolean)
              .join(". "),
            skills: picked.map((s) => s.name),
            ...(mcp.length ? { mcp: "mcp.json" } : {}),
            game: { widget: "toolbox" },
          }),
        );
      },
    };
  }

  /** Every soul you could give a new agent: each Role's, and each staff member's own. */
  async souls(): Promise<Array<{ id: string; label: string; text: string }>> {
    const out: Array<{ id: string; label: string; text: string }> = [];
    for (const dir of [this.builtin.roles, this.rolesDir]) {
      for (const n of await subdirs(dir)) {
        const raw = parseYaml(await readFile(join(dir, n, "role.yaml"), "utf8").catch(() => "")) as { title?: string; soul?: string } | null;
        if (!raw?.soul) continue;
        const text = await readFile(join(dir, n, raw.soul), "utf8").catch(() => "");
        if (text.trim()) out.push({ id: `role:${n}`, label: `${raw.title ?? n} (role)`, text: text.trim() });
      }
    }
    for (const s of await this.list()) {
      if (s.soul !== "own") continue;
      const text = await readFile(join(this.dir, s.name, "soul.md"), "utf8").catch(() => "");
      if (text.trim()) out.push({ id: `staff:${s.name}`, label: `${s.displayName} (staff)`, text: text.trim() });
    }
    return out;
  }
}

function unique(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

// ------------------------------------------------------------------ what is on this computer

export interface FoundMcp {
  name: string;
  /** Where it was found, e.g. "Claude Code (user)". */
  source: string;
  /** "npx -y @foo/bar" or a URL; never env or headers, which may hold tokens. */
  summary: string;
  config: McpServer;
}

export interface FoundSkill {
  name: string;
  description: string;
  source: string;
  dir: string;
}

/** MCP servers and skills already set up for the agent CLIs on this computer. */
export async function discoverTools(home = homedir()): Promise<{ mcp: FoundMcp[]; skills: FoundSkill[] }> {
  const mcp: FoundMcp[] = [];
  const add = (name: string, cfg: unknown, source: string) => {
    if (mcp.some((m) => m.name === name) || typeof cfg !== "object" || cfg === null) return;
    const c = cfg as Record<string, unknown>;
    if ((c.type === "http" || c.type === "sse" || (!c.type && c.url)) && typeof c.url === "string") {
      // SSE servers are reached the same way by the CLIs Studio compiles for.
      mcp.push({ name, source, summary: c.url, config: { type: "http", url: c.url, ...(c.headers ? { headers: c.headers as Record<string, string> } : {}) } });
    } else if (typeof c.command === "string") {
      const args = Array.isArray(c.args) ? c.args.map(String) : [];
      mcp.push({
        name,
        source,
        summary: [c.command, ...args].join(" "),
        config: { command: c.command, ...(args.length ? { args } : {}), ...(c.env ? { env: c.env as Record<string, string> } : {}) },
      });
    }
  };
  const claudeJson = await readFile(join(home, ".claude.json"), "utf8").then(JSON.parse, () => ({}));
  for (const [n, c] of Object.entries((claudeJson.mcpServers ?? {}) as Record<string, unknown>)) add(n, c, "Claude Code (user)");
  for (const [path, p] of Object.entries((claudeJson.projects ?? {}) as Record<string, { mcpServers?: Record<string, unknown> }>)) {
    for (const [n, c] of Object.entries(p.mcpServers ?? {})) add(n, c, `Claude Code (${basename(path)})`);
  }
  const desktop = process.platform === "win32" ? join(process.env.APPDATA ?? join(home, "AppData/Roaming"), "Claude") : process.platform === "darwin" ? join(home, "Library/Application Support/Claude") : join(home, ".config/Claude");
  const desktopCfg = await readFile(join(desktop, "claude_desktop_config.json"), "utf8").then(JSON.parse, () => ({}));
  for (const [n, c] of Object.entries((desktopCfg.mcpServers ?? {}) as Record<string, unknown>)) add(n, c, "Claude Desktop");

  const skills: FoundSkill[] = [];
  for (const [root, source] of [
    [join(home, ".claude/skills"), "Claude Code"],
    [join(home, ".codex/skills"), "Codex"],
    [join(home, ".agents/skills"), "Agents"],
  ] as const) {
    for (const file of await findFiles(root, "SKILL.md", 4)) {
      const { meta } = frontMatter(await readFile(file, "utf8").catch(() => ""));
      const name = slug(String(meta.name ?? basename(dirname(file))));
      if (skills.some((s) => s.name === name)) continue;
      skills.push({ name, description: String(meta.description ?? "").slice(0, 300), source, dir: dirname(file) });
    }
  }
  return { mcp, skills };
}

/** Agent definitions you could import: Claude Code subagents (`.claude/agents/*.md`). */
export async function discoverAgents(home = homedir()): Promise<Array<{ name: string; description: string; model: string | null; body: string; source: string }>> {
  const dirs: Array<[string, string]> = [[join(home, ".claude/agents"), "Claude Code (user)"]];
  const claudeJson = await readFile(join(home, ".claude.json"), "utf8").then(JSON.parse, () => ({}));
  for (const path of Object.keys(claudeJson.projects ?? {}).slice(0, 50)) dirs.push([join(path, ".claude/agents"), basename(path)]);
  const out: Array<{ name: string; description: string; model: string | null; body: string; source: string }> = [];
  for (const [dir, source] of dirs) {
    for (const f of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".md"))) {
      const { meta, body } = frontMatter(await readFile(join(dir, f), "utf8").catch(() => ""));
      out.push({
        name: String(meta.name ?? f.slice(0, -3)),
        description: String(meta.description ?? ""),
        model: meta.model ? String(meta.model) : null,
        body: body.trim(),
        source,
      });
    }
  }
  return out;
}

async function findFiles(root: string, fileName: string, depth: number): Promise<string[]> {
  if (depth < 0 || !(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    if (e.isFile() && e.name === fileName) out.push(join(root, e.name));
    else if (e.isDirectory() && !e.name.startsWith(".")) out.push(...(await findFiles(join(root, e.name), fileName, depth - 1)));
  }
  return out;
}
