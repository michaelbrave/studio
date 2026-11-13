import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { KitValidationError, parseKitManifest, parseRoleManifest, type KitManifest, type RoleManifest } from "./schema.ts";

export type McpServer =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface LoadedRole {
  manifest: RoleManifest;
  soul: string;
  rules: string;
  hash: string;
}

export interface LoadedKit {
  manifest: KitManifest;
  rules: string;
  mcpServers: Record<string, McpServer>;
  /** skill name → (path inside the skill folder → content) */
  skills: Map<string, Map<string, string>>;
  hash: string;
}

/** A Role with the Kits it has equipped for one job, merged and frozen for an Attempt. */
export interface Loadout {
  role: LoadedRole;
  kits: LoadedKit[];
  skills: Map<string, Map<string, string>>;
  mcpServers: Record<string, McpServer>;
  permissions: { preset: RoleManifest["permissions"]["preset"]; allow: string[]; deny: string[] };
  /** Identifies exactly what ran: role and every equipped kit, by content. */
  snapshot: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

async function readTree(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files.set(relative(dir, full).split(sep).join("/"), await readFile(full, "utf8"));
  }
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

async function readManifest(path: string): Promise<unknown> {
  return parseYaml(await readFile(path, "utf8"));
}

export async function loadRole(dir: string): Promise<LoadedRole> {
  const manifest = parseRoleManifest(await readManifest(join(dir, "role.yaml")));
  const soul = manifest.soul ? await readOptional(join(dir, manifest.soul)) : "";
  const rules = manifest.rules ? await readOptional(join(dir, manifest.rules)) : "";
  const issues: string[] = [];
  if (manifest.soul && !soul) issues.push(`soul file ${manifest.soul} is missing or empty`);
  if (manifest.rules && !rules) issues.push(`rules file ${manifest.rules} is missing or empty`);
  if (issues.length > 0) throw new KitValidationError(issues.map((i) => `role ${manifest.name}: ${i}`));
  return { manifest, soul, rules, hash: sha(JSON.stringify([manifest, soul, rules])) };
}

export async function loadKit(dir: string): Promise<LoadedKit> {
  const manifest = parseKitManifest(await readManifest(join(dir, "kit.yaml")));
  const issues: string[] = [];

  const rules = manifest.rules ? await readOptional(join(dir, manifest.rules)) : "";
  if (manifest.rules && !rules) issues.push(`rules file ${manifest.rules} is missing or empty`);

  let mcpServers: Record<string, McpServer> = {};
  if (manifest.mcp) {
    const text = await readOptional(join(dir, manifest.mcp));
    if (!text) issues.push(`mcp file ${manifest.mcp} is missing or empty`);
    else mcpServers = (JSON.parse(text) as { mcpServers?: Record<string, McpServer> }).mcpServers ?? {};
  }

  const skills = new Map<string, Map<string, string>>();
  for (const name of manifest.skills) {
    const tree = await readTree(join(dir, "skills", name)).catch(() => new Map<string, string>());
    if (!tree.has("SKILL.md")) issues.push(`skill ${name} has no skills/${name}/SKILL.md`);
    skills.set(name, tree);
  }
  if (issues.length > 0) throw new KitValidationError(issues.map((i) => `kit ${manifest.name}: ${i}`));

  const skillsDigest = [...skills].map(([n, t]) => `${n}:${[...t].map(([p, c]) => `${p}=${sha(c)}`).join(",")}`);
  return { manifest, rules, mcpServers, skills, hash: sha(JSON.stringify([manifest, rules, mcpServers, skillsDigest])) };
}

/**
 * Equip a Role with Kits. `kits` defaults to the Role's default Kits; every Kit must be one the
 * Role lists. Two Kits may not provide the same skill or MCP server name: the agent would see
 * only one of them, so that is an error rather than a silent override.
 */
export async function loadLoadout(opts: { rolesDir: string; kitsDir: string; role: string; kits?: string[] }): Promise<Loadout> {
  const role = await loadRole(join(opts.rolesDir, opts.role));
  const { default: defaults, optional } = role.manifest.kits;
  const names = [...new Set(opts.kits ?? defaults)];
  const notAllowed = names.filter((k) => !defaults.includes(k) && !optional.includes(k));
  if (notAllowed.length > 0) {
    throw new KitValidationError([`role ${role.manifest.name} cannot equip: ${notAllowed.join(", ")}`]);
  }
  const kits = await Promise.all(names.map((k) => loadKit(join(opts.kitsDir, k))));

  const issues: string[] = [];
  const skills = new Map<string, Map<string, string>>();
  const skillOwner = new Map<string, string>();
  const mcpServers: Record<string, McpServer> = {};
  const mcpOwner = new Map<string, string>();
  for (const kit of kits) {
    for (const [name, tree] of kit.skills) {
      if (skillOwner.has(name)) issues.push(`skill ${name} is in both ${skillOwner.get(name)} and ${kit.manifest.name}`);
      skillOwner.set(name, kit.manifest.name);
      skills.set(name, tree);
    }
    for (const [name, server] of Object.entries(kit.mcpServers)) {
      if (mcpOwner.has(name)) issues.push(`MCP server ${name} is in both ${mcpOwner.get(name)} and ${kit.manifest.name}`);
      mcpOwner.set(name, kit.manifest.name);
      mcpServers[name] = server;
    }
  }
  if (issues.length > 0) throw new KitValidationError(issues);

  const unique = (xs: string[]) => [...new Set(xs)];
  return {
    role,
    kits,
    skills,
    mcpServers,
    permissions: {
      preset: role.manifest.permissions.preset,
      allow: unique([...role.manifest.permissions.allow, ...kits.flatMap((k) => k.manifest.permissions.allow)]),
      deny: unique([...role.manifest.permissions.deny, ...kits.flatMap((k) => k.manifest.permissions.deny)]),
    },
    snapshot: sha(JSON.stringify([role.hash, ...kits.map((k) => [k.manifest.name, k.hash])])),
  };
}
