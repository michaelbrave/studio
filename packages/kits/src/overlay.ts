// Apply a compiled Kit to a local git worktree as a reversible overlay, and remove it again.
// This is the worker-side fallback for remote preparation (PLAN.md §6) and the tool for Stage 0
// manual tests. The hub never writes worker paths directly.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { CompileResult, ExistingFile } from "./compile.ts";

const run = promisify(execFile);
const OVERLAY_MANIFEST = ".studio/overlay.json";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd })).stdout;
}

/** Build the `existing` lookup the compiler needs from a real worktree. */
export async function scanWorktree(worktree: string): Promise<(path: string) => ExistingFile | undefined> {
  const tracked = new Set((await git(worktree, "ls-files", "-z")).split("\0").filter(Boolean));
  return (path) => {
    try {
      return { tracked: tracked.has(path), content: readFileSync(join(worktree, path), "utf8") };
    } catch {
      return tracked.has(path) ? { tracked: true, content: "" } : undefined;
    }
  };
}

interface OverlayRecord {
  kitSnapshot?: string;
  files: Array<{ path: string; original?: string }>;
}

export async function applyOverlay(worktree: string, result: CompileResult, kitSnapshot?: string): Promise<void> {
  if (!result.launchable) {
    const blocked = result.report.filter((r) => r.status === "unsupported").map((r) => `${r.feature}: ${r.reason}`);
    throw new Error(`kit is not launchable on ${result.provider}:\n  ${blocked.join("\n  ")}`);
  }
  try {
    await readFile(join(worktree, OVERLAY_MANIFEST));
    throw new Error(`an overlay is already applied in ${worktree}; remove it first`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const record: OverlayRecord = { kitSnapshot, files: [] };
  for (const f of result.files) {
    const full = join(worktree, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content);
    record.files.push({ path: f.path, ...(f.original !== undefined ? { original: f.original } : {}) });
  }
  await mkdir(join(worktree, ".studio"), { recursive: true });
  await writeFile(join(worktree, OVERLAY_MANIFEST), JSON.stringify(record, null, 2));

  const excludeFile = (await git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude")).trim();
  const existing = await readFile(excludeFile, "utf8").catch(() => "");
  const wanted = ["/.studio/", ...result.excludes.map((p) => `/${p}`)].filter((l) => !existing.split("\n").includes(l));
  if (wanted.length > 0) {
    await mkdir(dirname(excludeFile), { recursive: true });
    await appendFile(excludeFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}# studio kit overlay\n${wanted.join("\n")}\n`);
  }
}

/**
 * Restore every overlaid file and delete created ones. Returns Kit paths that ended up in the git
 * index (e.g. an agent ran `git add -f`); that list must be empty before an artifact is handed off.
 */
export async function removeOverlay(worktree: string): Promise<string[]> {
  const record = JSON.parse(await readFile(join(worktree, OVERLAY_MANIFEST), "utf8")) as OverlayRecord;
  for (const f of record.files) {
    const full = join(worktree, f.path);
    if (f.original !== undefined) await writeFile(full, f.original);
    else {
      await rm(full, { force: true });
      // Remove directories the overlay created; rmdir refuses non-empty ones, so project files stay.
      for (let dir = dirname(f.path); dir !== "."; dir = dirname(dir)) {
        if (!(await rmdir(join(worktree, dir)).then(() => true, () => false))) break;
      }
    }
  }
  await rm(join(worktree, ".studio"), { recursive: true, force: true });

  // Excluded paths never appear in `git status`, so ask the index directly.
  const leaked = await git(worktree, "ls-files", "-z", "--", ...record.files.map((f) => f.path));
  return leaked.split("\0").filter(Boolean);
}
