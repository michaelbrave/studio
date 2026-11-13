// The studio vault (PLAN.md §7): a git repository of markdown the hub alone writes. Workers and
// agents never edit it directly; they get read-only memory briefs. Obsidian can open it as is.
//
//   raw/jobs/<attempt>.md            immutable record of one finished Attempt
//   projects/<project>/inbox/*.md    short notes waiting for the Librarian (Stage 3) to merge
//   roles/<role>/feedback.md         your rating notes, so a Role learns from feedback
//   board/cards/<id>.md              kanban cards, one file each so git merges stay clean

import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** File-name-safe form of an id such as "mcp:12e0…" or "44ac3769-…". */
export const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-");

export class Vault {
  readonly dir: string;
  private pending = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const isRepo = await stat(join(this.dir, ".git")).then(() => true, () => false);
    if (!isRepo) {
      await this.git("init", "-q", "-b", "main");
      await writeFile(
        join(this.dir, "index.md"),
        "# Studio vault\n\nWritten by the Studio hub. Job records are in `raw/jobs/`, notes waiting to be merged into\nthe wiki in `projects/*/inbox/`, rating feedback in `roles/*/feedback.md`, and the task board in\n`board/cards/`.\n",
      );
      await this.commit("Create the studio vault");
    }
  }

  async write(path: string, content: string, { overwrite = true } = {}): Promise<boolean> {
    const full = join(this.dir, path);
    if (!overwrite && (await stat(full).then(() => true, () => false))) return false;
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    this.pending = true;
    return true;
  }

  async append(path: string, content: string): Promise<void> {
    const full = join(this.dir, path);
    await mkdir(dirname(full), { recursive: true });
    await appendFile(full, content);
    this.pending = true;
  }

  async remove(path: string): Promise<void> {
    await rm(join(this.dir, path), { force: true });
    this.pending = true;
  }

  async read(path: string): Promise<string | undefined> {
    return readFile(join(this.dir, path), "utf8").catch(() => undefined);
  }

  /** Files in a folder, newest name last (names start with a timestamp where order matters). */
  async list(path: string): Promise<string[]> {
    return (await readdir(join(this.dir, path)).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).sort();
  }

  /** Commit whatever changed since the last commit. Called once per hub tick, not per write. */
  async commit(message = "Update from the Studio hub"): Promise<void> {
    if (!this.pending && message === "Update from the Studio hub") return;
    await this.git("add", "-A");
    const { stdout } = await this.git("status", "--porcelain");
    if (stdout.trim()) {
      await this.git("-c", "user.name=Studio hub", "-c", "user.email=hub@studio.local", "commit", "-q", "-m", message);
    }
    this.pending = false;
  }

  private git(...args: string[]) {
    return run("git", args, { cwd: this.dir });
  }
}
