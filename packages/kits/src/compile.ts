// Loadout compiler, Plan A (PLAN.md §6): write a Role and its equipped Kits into an Attempt's
// worktree as files each CLI already reads. Never touches global ~/.claude or ~/.codex, and never modifies a file the project
// tracks in git. Where Plan A would need to, the feature is reported instead of silently skipped.
//
// Every "supported" below is an assumption until Stage 0 verifies it against a live T3 session
// (see docs/stage0.md); the report says so via `verified: false`.

import type { Loadout, McpServer } from "./load.ts";
import type { Provider } from "./schema.ts";

/** What already exists at a path in the target worktree. */
export interface ExistingFile {
  tracked: boolean;
  content: string;
}

export interface CompileInput {
  loadout: Loadout;
  provider: Provider;
  staff?: { name: string; soulOverride?: string };
  memoryBrief?: string;
  /** Upper bound on the memory brief injected into instructions. */
  memoryBudgetChars?: number;
  existing: (path: string) => ExistingFile | undefined;
}

export interface FileWrite {
  path: string;
  content: string;
  /** For an overlay of an untracked file: the original content to restore during cleanup. */
  original?: string;
}

export type Feature = "instructions" | "skills" | "mcp" | "permissions" | "memory";
export type FeatureStatus = "supported" | "degraded" | "unsupported";

export interface FeatureReport {
  feature: Feature;
  status: FeatureStatus;
  reason?: string;
  verified: false;
}

/** T3 permission modes (docs/user/permission-modes.md). */
export type T3RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";

export interface CompileResult {
  provider: Provider;
  files: FileWrite[];
  runtimeMode: T3RuntimeMode;
  model?: string;
  effort?: string;
  report: FeatureReport[];
  /** False when any feature is unsupported: launching would not enforce what the loadout declares. */
  launchable: boolean;
  /** Paths to add to .git/info/exclude so Kit files stay out of deliverable commits. */
  excludes: string[];
}

const DEFAULT_MEMORY_BUDGET = 6_000;
const MARKER = "<!-- studio:kit -->";

const RUNTIME_MODE: Record<Loadout["permissions"]["preset"], T3RuntimeMode> = {
  "read-only": "approval-required",
  "workspace-write": "auto-accept-edits",
  "full-access": "full-access",
};

export function compileLoadout(input: CompileInput): CompileResult {
  const { loadout, provider } = input;
  const role = loadout.role.manifest;
  const files: FileWrite[] = [];
  const report: FeatureReport[] = [];
  const note = (feature: Feature, status: FeatureStatus, reason?: string) =>
    report.push({ feature, status, ...(reason ? { reason } : {}), verified: false });

  /** Plan a write. Returns false (and plans nothing) when the path is tracked by the project. */
  const write = (path: string, content: string, merge?: (original: string) => string): boolean => {
    const found = input.existing(path);
    if (found?.tracked) return false;
    if (found) files.push({ path, content: merge ? merge(found.content) : content, original: found.content });
    else files.push({ path, content });
    return true;
  };

  // Memory brief: bounded, and truncation is reported rather than hidden.
  const budget = input.memoryBudgetChars ?? DEFAULT_MEMORY_BUDGET;
  let brief = input.memoryBrief?.trim() ?? "";
  if (brief.length > budget) {
    brief = `${brief.slice(0, budget)}\n\n[memory brief truncated at ${budget} characters]`;
    note("memory", "degraded", `brief truncated to ${budget} characters`);
  } else {
    note("memory", "supported");
  }

  const instructions = renderInstructions(loadout, input.staff, brief);

  if (provider === "claude") {
    // .claude/rules/ composes with the project's own CLAUDE.md instead of replacing it.
    if (write(".claude/rules/studio-role.md", instructions)) note("instructions", "supported");
    else note("instructions", "unsupported", ".claude/rules/studio-role.md is tracked by the project");

    planSkills(loadout, [".claude/skills"], write, note);

    const serverNames = Object.keys(loadout.mcpServers);
    let mcpOk = true;
    if (serverNames.length > 0) {
      mcpOk = write(".mcp.json", JSON.stringify({ mcpServers: loadout.mcpServers }, null, 2) + "\n", (orig) =>
        JSON.stringify({ mcpServers: { ...parseJson(orig).mcpServers, ...loadout.mcpServers } }, null, 2) + "\n",
      );
      if (mcpOk) note("mcp", "supported");
      else note("mcp", "unsupported", ".mcp.json is tracked; needs a session-injection seam (Plan B)");
    } else {
      note("mcp", "supported");
    }

    const { allow, deny } = loadout.permissions;
    const readOnlyDeny = loadout.permissions.preset === "read-only" ? ["Edit", "Write", "NotebookEdit"] : [];
    const settings = {
      permissions: { allow, deny: [...deny, ...readOnlyDeny] },
      ...(mcpOk && serverNames.length > 0 ? { enabledMcpjsonServers: serverNames } : {}),
    };
    const settingsOk = write(".claude/settings.local.json", JSON.stringify(settings, null, 2) + "\n", (orig) => {
      const o = parseJson(orig);
      const perms = (o.permissions ?? {}) as { allow?: string[]; deny?: string[] };
      return (
        JSON.stringify(
          {
            ...o,
            permissions: {
              ...perms,
              allow: [...(perms.allow ?? []), ...settings.permissions.allow],
              deny: [...(perms.deny ?? []), ...settings.permissions.deny],
            },
            ...(settings.enabledMcpjsonServers
              ? { enabledMcpjsonServers: [...(o.enabledMcpjsonServers ?? []), ...settings.enabledMcpjsonServers] }
              : {}),
          },
          null,
          2,
        ) + "\n"
      );
    });
    if (settingsOk) note("permissions", "supported");
    else if (settings.permissions.deny.length > 0)
      note("permissions", "unsupported", ".claude/settings.local.json is tracked; deny rules cannot be enforced");
    else note("permissions", "degraded", ".claude/settings.local.json is tracked; allow rules not applied (more prompts)");
  } else if (provider === "opencode") {
    compileOpenCode(loadout, instructions, input, write, note);
  } else {
    // Codex reads AGENTS.override.md in place of AGENTS.md, so compose the project's file into it.
    const agents = input.existing("AGENTS.md");
    const composed = agents ? `${agents.content.trimEnd()}\n\n${instructions}` : instructions;
    if (write("AGENTS.override.md", composed)) note("instructions", "supported");
    else note("instructions", "unsupported", "AGENTS.override.md is tracked by the project");

    planSkills(loadout, [".agents/skills"], write, note);

    if (Object.keys(loadout.mcpServers).length > 0) {
      // Codex only reads project .codex/config.toml in trusted projects; Stage 0 must confirm T3's sessions qualify.
      if (input.existing(".codex/config.toml")) {
        note("mcp", "unsupported", ".codex/config.toml already exists; needs a session-injection seam (Plan B)");
      } else {
        write(".codex/config.toml", renderCodexMcp(loadout.mcpServers));
        note("mcp", "supported");
      }
    } else {
      note("mcp", "supported");
    }

    // Codex has no per-tool blocklist; it enforces an OS sandbox instead. T3 picks the sandbox from
    // the runtime mode (CodexAdapterV2 codexRuntimeModeTurnDefaults): approval-required → read-only,
    // auto-accept-edits → workspace-write with network off, full-access → no sandbox at all.
    // The sandbox covers much of what deny rules are for (pushing, writing outside the job, sudo),
    // but not reads (secrets), destructive commands inside the job folder, or hosted tools. So
    // deny rules are accepted as degraded when sandboxed, with what remains spelled out, and
    // refused when nothing would enforce them.
    const { allow, deny } = loadout.permissions;
    const notes: string[] = [];
    if (deny.length > 0 && loadout.permissions.preset === "full-access") {
      note("permissions", "unsupported", "Codex runs unsandboxed in full access, so nothing would enforce the deny rules");
    } else {
      if (deny.length > 0) {
        // The sandbox limits writes and shell network, not reads, so say exactly what remains.
        const stillPossible = [
          "reading secrets such as .env files it can reach (their contents then reach the model provider)",
          "using Codex's hosted tools and MCP servers, which the shell's network block does not cover",
        ];
        if (loadout.permissions.preset !== "read-only") {
          stillPossible.unshift(
            "deleting or editing files inside the job folder (committed content can be restored; untracked files cannot)",
            "chmod on files in the job folder",
          );
        }
        notes.push(
          (loadout.permissions.preset === "read-only"
            ? "Codex has no blocklist; its read-only sandbox stands in (no writes, no shell network)"
            : "Codex has no blocklist; its sandbox stands in (writes only in the job folder and /tmp, no shell network)") +
            `. Still possible: ${stillPossible.join("; ")}`,
        );
      }
      if (allow.length > 0) notes.push("Codex ignores per-tool allow rules (more prompts)");
      if (notes.length > 0) note("permissions", "degraded", notes.join("; "));
      else note("permissions", "supported");
    }
  }

  return {
    provider,
    files,
    runtimeMode: RUNTIME_MODE[loadout.permissions.preset],
    // A Role's default model names a model of its preferred runtime; on a fallback, T3 picks.
    ...(role.model.default && provider === role.runtime.preferred ? { model: role.model.default } : {}),
    ...(role.model.effort ? { effort: role.model.effort } : {}),
    report,
    launchable: report.every((r) => r.status !== "unsupported"),
    // Overlaid files were untracked already, so excluding them changes nothing for the project.
    excludes: files.map((f) => f.path),
  };
}

/**
 * OpenCode reads `.opencode/opencode.json` as project config, alongside the project's own
 * AGENTS.md and opencode.json, so everything goes under `.opencode/` and nothing the project
 * owns is touched (one folder also keeps the Kit out of git on remote workers).
 *
 * Permissions: T3 gives every OpenCode session its own rules for the runtime mode, and OpenCode
 * applies the last matching rule, so T3's catch-all bash rule (ask, or allow in full access) wins
 * over anything a project config says. Allow rules therefore change nothing (more prompts), and
 * deny rules become approval prompts rather than hard blocks; in full access nothing enforces them.
 */
function compileOpenCode(
  loadout: Loadout,
  instructions: string,
  input: CompileInput,
  write: (path: string, content: string, merge?: (original: string) => string) => boolean,
  note: (feature: Feature, status: FeatureStatus, reason?: string) => void,
) {
  if (input.existing(".opencode/opencode.json")?.tracked) {
    // Studio does not edit project files, and without this config OpenCode never sees the role.
    note("instructions", "unsupported", ".opencode/opencode.json is tracked by the project");
    note("mcp", "unsupported", ".opencode/opencode.json is tracked by the project");
    note("skills", "degraded", ".opencode/opencode.json is tracked by the project");
  } else {
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      instructions: [".opencode/studio-role.md"],
    };
    if (write(".opencode/studio-role.md", instructions)) note("instructions", "supported");
    else note("instructions", "unsupported", ".opencode/studio-role.md is tracked by the project");

    planSkills(loadout, [".opencode/skills"], write, note);
    if (loadout.skills.size > 0) config.skills = { paths: [".opencode/skills"] };

    const servers = Object.entries(loadout.mcpServers);
    if (servers.length > 0) {
      // OpenCode interpolates {env:VAR}, not ${VAR}.
      const env = (v: string) => v.replace(/\$\{(\w+)\}/g, "{env:$1}");
      config.mcp = Object.fromEntries(
        servers.map(([name, s]) => [
          name,
          s.type === "http"
            ? { type: "remote", url: s.url, enabled: true, ...(s.headers ? { headers: Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, env(v)])) } : {}) }
            : { type: "local", command: [s.command, ...(s.args ?? [])], enabled: true, ...(s.env ? { environment: s.env } : {}) },
        ]),
      );
    }
    write(".opencode/opencode.json", JSON.stringify(config, null, 2) + "\n", (orig) => {
      const o = parseJson(orig);
      const instr = [...new Set([...((o.instructions as string[]) ?? []), ...(config.instructions as string[])])];
      return JSON.stringify({ ...o, ...config, instructions: instr, ...(config.mcp ? { mcp: { ...(o.mcp ?? {}), ...(config.mcp as object) } } : {}) }, null, 2) + "\n";
    });
    note("mcp", "supported");
  }

  const { allow, deny } = loadout.permissions;
  if (deny.length > 0 && loadout.permissions.preset === "full-access") {
    note("permissions", "unsupported", "OpenCode in full access allows everything for the session, so nothing would enforce the deny rules");
  } else {
    const notes: string[] = [];
    if (deny.length > 0)
      notes.push("OpenCode has no sandbox and T3's session rules override project rules, so deny rules become approval prompts (you see them as requests) instead of hard blocks");
    if (allow.length > 0) notes.push("allow rules are overridden by T3's session rules (more prompts)");
    if (notes.length) note("permissions", "degraded", notes.join("; "));
    else note("permissions", "supported");
  }
}

function planSkills(
  loadout: Loadout,
  roots: string[],
  write: (path: string, content: string) => boolean,
  note: (feature: Feature, status: FeatureStatus, reason?: string) => void,
) {
  const blocked: string[] = [];
  for (const [name, tree] of loadout.skills) {
    for (const root of roots) {
      for (const [rel, content] of tree) {
        if (!write(`${root}/${name}/${rel}`, content)) blocked.push(`${root}/${name}/${rel}`);
      }
    }
  }
  if (blocked.length === 0) note("skills", "supported");
  else note("skills", "degraded", `project already tracks: ${blocked.join(", ")}`);
}

function renderInstructions(loadout: Loadout, staff: CompileInput["staff"], brief: string): string {
  const role = loadout.role;
  const m = role.manifest;
  const sections = [
    MARKER,
    `<!-- Generated by Studio: role ${m.name}@${m.version}, kits ${loadout.kits.map((k) => k.manifest.name).join(", ") || "none"} (${loadout.snapshot}). Not part of the project; do not commit. -->`,
    "",
    `# Your role: ${m.title}${staff ? ` (${staff.name})` : ""}`,
    "",
    m.description,
    "",
    "The project's own instructions also apply. Where they conflict with the rules below, follow the project and say so in your handoff.",
  ];
  const soul = staff?.soulOverride ?? role.soul;
  if (soul.trim()) sections.push("", "## Personality", "", soul.trim());
  if (role.rules.trim()) sections.push("", "## Rules", "", role.rules.trim());
  if (loadout.kits.length > 0) {
    sections.push("", "## Your equipped Kits");
    for (const kit of loadout.kits) {
      const k = kit.manifest;
      const skills = k.skills.length > 0 ? ` Skills: ${k.skills.map((s) => `\`${s}\``).join(", ")}.` : "";
      sections.push("", `### ${k.title}`, "", `${k.description}${skills}`);
      if (kit.rules.trim()) sections.push("", kit.rules.trim());
    }
  }
  if (brief) sections.push("", "## What the studio already knows", "", brief);
  return sections.join("\n") + "\n";
}

function renderCodexMcp(servers: Record<string, McpServer>): string {
  const q = (s: string) => JSON.stringify(s); // JSON strings are valid TOML basic strings
  const lines: string[] = ["# Generated by Studio. Not part of the project; do not commit."];
  for (const [name, s] of Object.entries(servers)) {
    lines.push("", `[mcp_servers.${q(name)}]`);
    if (s.type === "http") {
      lines.push(`url = ${q(s.url)}`);
      if (s.headers) lines.push(`http_headers = { ${Object.entries(s.headers).map(([k, v]) => `${q(k)} = ${q(v)}`).join(", ")} }`);
    } else {
      lines.push(`command = ${q(s.command)}`);
      if (s.args?.length) lines.push(`args = [${s.args.map(q).join(", ")}]`);
      if (s.env) lines.push(`env = { ${Object.entries(s.env).map(([k, v]) => `${q(k)} = ${q(v)}`).join(", ")} }`);
    }
  }
  return lines.join("\n") + "\n";
}

function parseJson(text: string): Record<string, any> {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    return {};
  }
}
