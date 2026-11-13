// Manifests for Roles (role.yaml) and Kits (kit.yaml). See PLAN.md §6.
//
// A Role is who an agent is: the hat it wears ("Gameplay Programmer"), its personality and
// duties, how it runs, and which Kits it may equip. A Kit is a bundle of tools an agent equips:
// skills, MCP servers, tool-usage rules and permissions. Kits show up as widgets on the desk.

export const PROVIDERS = ["claude", "codex", "opencode"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PERMISSION_PRESETS = ["read-only", "workspace-write", "full-access"] as const;
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number];

export interface RoleManifest {
  name: string;
  version: string;
  /** Printed on the agent's hat. */
  title: string;
  /** Which team the role belongs to; the board assigns work to departments and roles. */
  department: string;
  description: string;
  runtime: { preferred: Provider; fallback: Provider[] };
  model: { default?: string; effort?: string };
  soul?: string;
  rules?: string;
  permissions: { preset: PermissionPreset; allow: string[]; deny: string[] };
  /** `default` are equipped unless the job says otherwise; `optional` may be added per job. */
  kits: { default: string[]; optional: string[] };
  memory: { read: string[]; write: string[] };
  game: { points: string[]; categories: string[] };
}

export interface KitManifest {
  name: string;
  version: string;
  title: string;
  description: string;
  /** How to use this Kit's tools; added to the agent's instructions. */
  rules?: string;
  skills: string[];
  mcp?: string;
  permissions: { allow: string[]; deny: string[] };
  requires: { capabilities: string[] };
  /** The desk widget that represents this Kit in the studio view. */
  game: { widget: string };
}

export class KitValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid manifest:\n  - ${issues.join("\n  - ")}`);
    this.issues = issues;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

/** Collects every issue in a manifest instead of stopping at the first. */
class Reader {
  readonly issues: string[] = [];

  str(o: Obj, key: string, path: string, required = false): string | undefined {
    const v = o[key];
    if (v === undefined) {
      if (required) this.issues.push(`${path} is required`);
      return undefined;
    }
    if (typeof v === "number") return String(v);
    if (typeof v !== "string") {
      this.issues.push(`${path} must be a string`);
      return undefined;
    }
    return v;
  }

  list(o: Obj, key: string, path: string): string[] {
    const v = o[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      this.issues.push(`${path} must be a list of strings`);
      return [];
    }
    return v as string[];
  }

  names(o: Obj, key: string, path: string): string[] {
    const names = this.list(o, key, path);
    for (const n of names) if (!KEBAB.test(n)) this.issues.push(`${path}: "${n}" must be kebab-case`);
    return names;
  }

  sub(o: Obj, key: string, path: string): Obj {
    const v = o[key];
    if (v === undefined) return {};
    if (!isObj(v)) {
      this.issues.push(`${path} must be a mapping`);
      return {};
    }
    return v;
  }

  oneOf<T extends string>(v: string | undefined, allowed: readonly T[], path: string): T | undefined {
    if (v === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(v)) {
      this.issues.push(`${path} must be one of: ${allowed.join(", ")}`);
      return undefined;
    }
    return v as T;
  }

  root(raw: unknown): Obj {
    if (isObj(raw)) return raw;
    this.issues.push("manifest must be a mapping");
    return {};
  }

  name(o: Obj): string {
    const name = this.str(o, "name", "name", true) ?? "";
    if (name && !KEBAB.test(name)) this.issues.push("name must be kebab-case");
    return name;
  }

  done<T>(value: T): T {
    if (this.issues.length > 0) throw new KitValidationError(this.issues);
    return value;
  }
}

export function parseRoleManifest(raw: unknown): RoleManifest {
  const r = new Reader();
  const root = r.root(raw);
  const name = r.name(root);

  const runtime = r.sub(root, "runtime", "runtime");
  const preferred = r.oneOf(r.str(runtime, "preferred", "runtime.preferred", true), PROVIDERS, "runtime.preferred");
  const fallback = r
    .list(runtime, "fallback", "runtime.fallback")
    .filter((p, i) => r.oneOf(p, PROVIDERS, `runtime.fallback[${i}]`) !== undefined) as Provider[];
  const model = r.sub(root, "model", "model");
  const permissions = r.sub(root, "permissions", "permissions");
  const kits = r.sub(root, "kits", "kits");
  const memory = r.sub(root, "memory", "memory");
  const game = r.sub(root, "game", "game");

  return r.done({
    name,
    version: r.str(root, "version", "version", true) ?? "",
    title: r.str(root, "title", "title") ?? name,
    department: r.str(root, "department", "department") ?? "General",
    description: r.str(root, "description", "description") ?? "",
    runtime: { preferred: preferred ?? "claude", fallback },
    model: { default: r.str(model, "default", "model.default"), effort: r.str(model, "effort", "model.effort") },
    soul: r.str(root, "soul", "soul"),
    rules: r.str(root, "rules", "rules"),
    permissions: {
      preset:
        r.oneOf(r.str(permissions, "preset", "permissions.preset"), PERMISSION_PRESETS, "permissions.preset") ??
        "workspace-write",
      allow: r.list(permissions, "allow", "permissions.allow"),
      deny: r.list(permissions, "deny", "permissions.deny"),
    },
    kits: { default: r.names(kits, "default", "kits.default"), optional: r.names(kits, "optional", "kits.optional") },
    memory: { read: r.list(memory, "read", "memory.read"), write: r.list(memory, "write", "memory.write") },
    game: { points: r.list(game, "points", "game.points"), categories: r.list(game, "categories", "game.categories") },
  });
}

export function parseKitManifest(raw: unknown): KitManifest {
  const r = new Reader();
  const root = r.root(raw);
  const name = r.name(root);
  const permissions = r.sub(root, "permissions", "permissions");
  const requires = r.sub(root, "requires", "requires");
  const game = r.sub(root, "game", "game");

  return r.done({
    name,
    version: r.str(root, "version", "version", true) ?? "",
    title: r.str(root, "title", "title") ?? name,
    description: r.str(root, "description", "description") ?? "",
    rules: r.str(root, "rules", "rules"),
    skills: r.names(root, "skills", "skills"),
    mcp: r.str(root, "mcp", "mcp"),
    permissions: { allow: r.list(permissions, "allow", "permissions.allow"), deny: r.list(permissions, "deny", "permissions.deny") },
    requires: { capabilities: r.list(requires, "capabilities", "requires.capabilities") },
    game: { widget: r.str(game, "widget", "game.widget") ?? "toolbox" },
  });
}
