// Kit delivery to a worker the hub cannot reach by filesystem, through T3's project file RPCs.
// T3 offers read and write inside a workspace but no delete and no git, so compared with the
// local overlay (packages/kits/src/overlay.ts):
//  - "tracked" is inferred: T3 makes a fresh worktree per Attempt from a commit, so a file that
//    already exists there came from the repository and is never overwritten;
//  - T3 refuses writes inside .git, so .git/info/exclude is out of reach. Instead, every top-level
//    folder the Kit creates gets a `.gitignore` of `*`, which hides the folder (itself included)
//    without touching a project file. A Kit file that would land in the project root or in a
//    folder the project already has cannot be hidden, so delivery refuses it;
//  - files stay in the worktree after the Attempt ends (excluded, so they cannot be committed
//    by `git add -A`; a deliberate `git add -f` is not detectable here).

import { compileLoadout, type CompileResult, type ExistingFile, type Loadout, type Provider } from "@studio/kits";
import type { T3Rpc } from "@studio/t3-bridge";

async function readRemote(rpc: T3Rpc, cwd: string, relativePath: string): Promise<string | undefined> {
  try {
    return (await rpc.call<{ contents: string }>("projects.readFile", { cwd, relativePath })).contents;
  } catch {
    return undefined; // missing (T3 reports a failed realpath); unreadable files are treated the same
  }
}

export async function deliverKitRemote(input: {
  rpc: T3Rpc;
  worktree: string;
  loadout: Loadout;
  provider: Provider;
  memoryBrief?: string;
}): Promise<CompileResult> {
  const { rpc, worktree, loadout, provider, memoryBrief } = input;

  // The compiler asks synchronously, so look up every path it could ask about first.
  const candidates = new Set(["AGENTS.md", ...compileLoadout({ loadout, provider, existing: () => undefined }).files.map((f) => f.path)]);
  const existing = new Map<string, ExistingFile>();
  for (const path of candidates) {
    const content = await readRemote(rpc, worktree, path);
    if (content !== undefined) existing.set(path, { tracked: true, content });
  }
  const result = compileLoadout({ loadout, provider, existing: (p) => existing.get(p), ...(memoryBrief ? { memoryBrief } : {}) });
  if (!result.launchable) {
    const blocked = result.report.filter((r) => r.status === "unsupported").map((r) => `${r.feature}: ${r.reason}`);
    throw new Error(`${loadout.role.manifest.name} is not launchable on ${provider}: ${blocked.join("; ")}`);
  }

  const rootEntries = new Set(
    (await rpc.call<{ entries: Array<{ path: string }> }>("projects.listEntries", { cwd: worktree, directoryPath: "" })).entries.map(
      (e) => e.path,
    ),
  );
  const hiddenDirs = new Set<string>();
  for (const f of result.files) {
    const [top, ...rest] = f.path.split("/");
    if (rest.length === 0 || rootEntries.has(top!)) {
      throw new Error(`cannot keep ${f.path} out of git on a remote worker (T3 cannot write .git/info/exclude)`);
    }
    hiddenDirs.add(top!);
  }
  for (const dir of hiddenDirs) {
    await rpc.call("projects.writeFile", { cwd: worktree, relativePath: `${dir}/.gitignore`, contents: "# Studio Kit files; not part of the project\n*\n" });
  }

  for (const f of result.files) {
    await rpc.call("projects.writeFile", { cwd: worktree, relativePath: f.path, contents: f.content });
  }
  return result;
}
