// The `studio` command, the same on Linux, macOS and Windows. The launchers (bin/studio for
// bash, bin/studio.cmd for Windows) find a new enough Node and run this file.

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import { homedir, hostname, networkInterfaces } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { accessKey, readSettings, type HubSettings } from "../apps/hub/src/access.ts";

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const STUDIO_DIR = join(import.meta.dirname, "..");
const STUDIO_HOME = process.env.STUDIO_HOME ?? join(homedir(), ".config", "studio");
const STATE_DIR = WIN
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "studio", "state")
  : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "studio");
const PORT = Number(process.env.STUDIO_PORT ?? 4600);
const T3_PORT = Number(process.env.T3_PORT ?? 3773);
const URL_ = `http://127.0.0.1:${PORT}`;
const T3_URL = `http://127.0.0.1:${T3_PORT}`;
const NODE_MIN = "22.18.0";
const T3_PIN = readFileSync(join(STUDIO_DIR, "T3_VERSION"), "utf8").trim();
const TASK = "Studio"; // Windows scheduled task
const RUN_FILE = join(STATE_DIR, "run.json");
const SETTINGS = await readSettings(STUDIO_HOME);
// One machine is the main: it runs the hub, which holds the jobs, vault and worker sign-ins.
// Every other machine is support (`studio join`): it runs only T3, as a worker for the main, and
// `studio` there opens the main's dashboard. So there is never a second hub to fight with.
const SUPPORT = SETTINGS.main !== undefined;
// A support machine's T3 has to be reachable from the main, so it listens on the network.
const T3_HOST = process.env.T3_HOST ?? SETTINGS.t3Host ?? (SUPPORT ? "0.0.0.0" : "127.0.0.1");
const OLD_WORKER_TASK = "T3 for Studio"; // deploy/windows-worker.ps1

// T3's installer puts `t3` in ~/.local/bin, which isn't on every PATH.
const LOCAL_BIN = join(homedir(), ".local", "bin");
process.env.PATH = [dirname(process.execPath), process.env.PATH ?? "", LOCAL_BIN].join(delimiter);

const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [bold, dim, green, yellow, red] = ["1", "2", "32", "33", "31"].map(c) as [(s: string) => string, (s: string) => string, (s: string) => string, (s: string) => string, (s: string) => string];
const say = (s = "") => console.log(s);
function die(msg: string): never {
  console.error(`${red("studio:")} ${msg}`);
  process.exit(1);
}

const HELP = `studio: run Studio on this machine. T3 Code (the local worker) runs underneath it.

  studio                 start T3 and the hub if they aren't running, then open Studio
                         (on a support machine: make sure T3 runs, then open the main's Studio)
  studio join <link>     make this machine support for a main Studio (link from \`studio lan\` there)
  studio leave           stop being support; \`studio\` runs a hub here again
  studio --no-browser    the same, without opening a browser
  studio stop            stop a Studio that \`studio\` started
  studio lan             show the link for using Studio from another computer
  studio lan on|off      let other computers on your network in (with a key), or not
  studio lan new-key     make a new key (old links stop working)
  studio service on      start Studio when you log in / at boot; \`off\` undoes it
  studio service status  also: start, stop, restart, logs (Linux)
  studio pair <name> <address> <code>   add another machine's T3 as a worker
  studio doctor          check Node, T3, agent CLIs, ports and pairing
  studio update          pull the latest Studio, reinstall packages, restart
  studio open            open Studio in the browser
  studio test            run the test suite and the type check

Settings (environment): STUDIO_PORT (4600), STUDIO_HOME (~/.config/studio), T3_PORT (3773).`;

// ------------------------------------------------------------------ helpers

function versionGe(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x![i] ?? 0) !== (y![i] ?? 0)) return (x![i] ?? 0) > (y![i] ?? 0);
  return true;
}

function which(cmd: string): string | undefined {
  const exts = WIN ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

async function up(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(url: string, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 4; i++) {
    if (await up(url)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Where this machine's Studio dashboard is: the local hub, or the main's for a support machine. */
function dashboard(): string {
  return SUPPORT ? `${SETTINGS.main}/?key=${SETTINGS.mainKey}` : URL_;
}

function openBrowser(url = dashboard()) {
  const [cmd, args] = WIN ? ["cmd", ["/c", "start", "", url]] : MAC ? ["open", [url]] : ["xdg-open", [url]];
  if (!WIN && !which(cmd as string)) return say(`Open ${url} in your browser.`);
  spawn(cmd as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true }).unref();
}

/** Run a command with output shown; npm and friends are .cmd files on Windows, which need a shell. */
function sh(cmd: string, args: string[], cwd = STUDIO_DIR): number {
  return spawnSync(cmd, args, { cwd, stdio: "inherit", shell: WIN }).status ?? 1;
}

function t3(): string {
  const bin = which("t3") ?? die(`T3 Code isn't installed. Run ${join(STUDIO_DIR, WIN ? "install.ps1" : "install.sh")} to install it.`);
  // On Windows, T3's installer writes t3.cmd containing `"<...>\t3.exe" %*`. Node can't start a
  // .cmd without a shell, so run the t3.exe it points at.
  if (WIN && bin.toLowerCase().endsWith(".cmd")) {
    const exe = readFileSync(bin, "utf8").match(/"([^"]+\.exe)"/i)?.[1];
    if (exe && existsSync(exe)) return exe;
  }
  return bin;
}

function t3Version(): string | undefined {
  if (!which("t3")) return undefined;
  try {
    return execFileSync(t3(), ["--version"], { encoding: "utf8" }).match(/\d+\.\d+\.\d+/)?.[0];
  } catch {
    return undefined;
  }
}

function needDeps() {
  if (!existsSync(join(STUDIO_DIR, "node_modules"))) die(`packages aren't installed. Run: cd "${STUDIO_DIR}" && npm ci`);
}

/** Stop a process and, on Windows, everything it started (T3 starts the agent CLIs). */
function killTree(pid: number | undefined) {
  if (pid === undefined) return;
  if (WIN) spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  else {
    try {
      process.kill(pid);
    } catch {}
  }
}

function writeSettings(s: HubSettings) {
  mkdirSync(STUDIO_HOME, { recursive: true });
  writeFileSync(join(STUDIO_HOME, "settings.json"), JSON.stringify(s, null, 2) + "\n");
}

/** Sign the hub in to the T3 on this machine as worker "local", once. We're on the same machine
 *  as T3, so we can mint the pairing code ourselves instead of asking you to copy one. */
async function pairLocal() {
  if (existsSync(join(STUDIO_HOME, "workers", "local.json"))) return;
  say("Pairing this machine's T3 with Studio as worker 'local'...");
  let code: string;
  try {
    const out = execFileSync(t3(), ["auth", "pairing", "create", "--json", "--ttl", "5m", "--label", "Studio hub (local)"], { encoding: "utf8" });
    code = (JSON.parse(out) as { credential: string }).credential;
  } catch (e) {
    die(`couldn't create a pairing code with 't3 auth pairing create': ${(e as Error).message}`);
  }
  const { T3Worker } = await import("@studio/t3-bridge");
  try {
    const worker = await T3Worker.pair("local", `${T3_URL}/mcp`, code);
    say(`signed in to local; ${(await worker.listTools()).length} tools available`);
    await worker.close();
  } catch (e) {
    die(`pairing with the local T3 failed: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------ studio (run)

interface RunRecord {
  supervisor: number;
  children: number[];
}

function readRun(): RunRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(RUN_FILE, "utf8")) as RunRecord;
    process.kill(r.supervisor, 0); // still alive?
    return r;
  } catch {
    return undefined;
  }
}

async function run(flags: string[]) {
  const background = flags.includes("--background"); // what the boot service runs
  const browser = !background && !flags.includes("--no-browser");
  for (const f of flags) if (!["--background", "--no-browser"].includes(f)) die(`unknown option: ${f}`);

  if (SUPPORT && (await up(T3_URL))) return showMain(browser);
  if (!SUPPORT && ((await up(URL_)) || linuxServiceActive())) {
    say(`Studio is already running: ${bold(URL_)}`);
    if (browser) openBrowser();
    return;
  }
  needDeps();
  mkdirSync(STATE_DIR, { recursive: true });
  const children: ChildProcess[] = [];
  const stopAll = (code: number) => {
    for (const ch of children) if (ch.exitCode === null) killTree(ch.pid);
    rmSync(RUN_FILE, { force: true });
    say();
    say("Studio stopped.");
    process.exit(code);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => stopAll(0));

  if (await up(T3_URL)) {
    say(dim(`T3 is already running on ${T3_URL}`));
  } else {
    const log = join(STATE_DIR, "t3.log");
    say(`Starting T3 on ${T3_URL} ${dim(`(log: ${log})`)}`);
    const fd = openSync(log, "a");
    children.push(
      spawn(t3(), ["serve", "--host", T3_HOST, "--port", String(T3_PORT), "--no-browser"], {
        cwd: homedir(),
        stdio: ["ignore", fd, fd],
        windowsHide: true,
      }),
    );
    if (!(await waitFor(T3_URL, 60))) {
      console.error(red(`T3 didn't start; see ${log}`));
      stopAll(1);
    }
  }
  if (SUPPORT) {
    writeRun(children);
    children[0]?.on("exit", (code) => stopAll(code ?? 1));
    say(`This machine is a worker for the main Studio.${background ? "" : dim("  (Ctrl+C stops T3 here)")}`);
    return showMain(browser);
  }
  await pairLocal();

  const settings = await readSettings(STUDIO_HOME);
  const lan = (process.env.STUDIO_HOST ?? settings.host ?? "127.0.0.1") !== "127.0.0.1";
  say(`Starting the hub on ${bold(URL_)}${lan ? " (open to your network: studio lan)" : ""}  ${dim(background ? "" : "(Ctrl+C stops Studio)")}`);
  const hubOut = background ? openSync(join(STATE_DIR, "hub.log"), "a") : "inherit";
  const hub = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "apps/hub/src/server.ts"], {
    cwd: STUDIO_DIR,
    stdio: ["ignore", hubOut, hubOut],
    windowsHide: true,
  });
  children.push(hub);
  writeRun(children);
  hub.on("exit", (code) => stopAll(code ?? 1));
  if (!(await waitFor(URL_, 30))) {
    console.error(red("the hub didn't start"));
    stopAll(1);
  }
  if (browser) openBrowser();
}

function writeRun(children: ChildProcess[]) {
  const pids = children.map((ch) => ch.pid).filter((p): p is number => p !== undefined);
  writeFileSync(RUN_FILE, JSON.stringify({ supervisor: process.pid, children: pids } satisfies RunRecord));
}

async function showMain(browser: boolean) {
  if (await up(SETTINGS.main!)) {
    say(`Studio runs on the main machine: ${bold(SETTINGS.main!)}`);
    if (browser) openBrowser();
  } else {
    say(yellow(`The main Studio at ${SETTINGS.main} isn't answering right now.`));
    say(dim("This machine's T3 is ready for when it's back. To run a hub here instead: studio leave"));
  }
}

function stop(): boolean {
  const r = readRun();
  if (!r) return false;
  for (const pid of [...r.children, r.supervisor]) killTree(pid);
  rmSync(RUN_FILE, { force: true });
  return true;
}

// ------------------------------------------------------------------ studio lan

function lanLinks(key: string): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${PORT}/?key=${key}`);
    }
  }
  return out;
}

async function restartIfRunning(): Promise<void> {
  if (linuxServiceActive()) {
    spawnSync("systemctl", ["--user", "restart", "studio-hub.service"]);
    say("Restarted the hub service.");
  } else if (WIN && winTaskExists() && readRun()) {
    stop();
    spawnSync("powershell", ["-NoProfile", "-Command", `Start-ScheduledTask -TaskName '${TASK}'`]);
    say("Restarted Studio.");
  } else if (await up(URL_)) {
    say(yellow("Restart Studio for this to take effect (Ctrl+C where it runs, then `studio`)."));
  }
}

async function lan(sub: string | undefined) {
  if (SUPPORT) {
    say(`This machine uses the main Studio at ${bold(SETTINGS.main!)}; \`studio open\` opens it here.`);
    say(dim("Network access is set on the main machine (`studio lan` there)."));
    return;
  }
  const settings = await readSettings(STUDIO_HOME);
  if (sub === "on") {
    writeSettings({ ...settings, host: "0.0.0.0" });
    say("Studio now lets other computers on your network in, with the access key.");
    await restartIfRunning();
  } else if (sub === "off") {
    const { host: _, ...rest } = settings;
    writeSettings(rest);
    say("Studio is back to this computer only.");
    await restartIfRunning();
    return;
  } else if (sub === "new-key") {
    rmSync(join(STUDIO_HOME, "web-key"), { force: true });
    await accessKey(STUDIO_HOME);
    say("Made a new key. Browsers that used the old link must open the new one.");
    await restartIfRunning();
  } else if (sub !== undefined) {
    die("usage: studio lan [on|off|new-key]");
  }

  const host = process.env.STUDIO_HOST ?? (await readSettings(STUDIO_HOME)).host ?? "127.0.0.1";
  if (host === "127.0.0.1" || host === "localhost") {
    say(`Studio only accepts this computer. To open it from another one on your network: ${bold("studio lan on")}`);
    return;
  }
  const key = await accessKey(STUDIO_HOME);
  say();
  say("Open one of these on the other computer (once per browser; it remembers):");
  for (const link of lanLinks(key)) say(`  ${bold(link)}`);
  say();
  say(dim("Anyone with this link can run agents on your machines: share it like a password."));
  say(dim("It's plain HTTP, fine on your home network or Tailscale; don't forward the port to the internet."));
  if (WIN) say(dim(`If Windows Firewall asks about Node.js, allow Private networks only.`));
  else if (!MAC && which("ufw")) say(dim(`If ufw is on: sudo ufw allow from 192.168.0.0/16 to any port ${PORT} proto tcp`));
}

// ------------------------------------------------------------------ services

const UNIT_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");

function units(): string[] {
  if (SUPPORT) return ["studio-t3.service"];
  const u = ["studio-t3.service", "studio-hub.service"];
  // Hermes installs its own unit (docs/discord.md). Once you've enabled it, Studio switches it on
  // and off with the rest; until then (no Discord bot yet) Studio leaves it alone.
  const hermes = "hermes-gateway.service";
  if (existsSync(join(UNIT_DIR, hermes)) && spawnSync("systemctl", ["--user", "is-enabled", "--quiet", hermes]).status === 0) u.push(hermes);
  return u;
}

function linuxServiceActive(): boolean {
  const unit = SUPPORT ? "studio-t3.service" : "studio-hub.service";
  return !WIN && !MAC && spawnSync("systemctl", ["--user", "is-active", "--quiet", unit]).status === 0;
}

function systemctl(...args: string[]): number {
  return spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" }).status ?? 1;
}

/** Write the units; returns the ones whose content changed (so they can be restarted). */
function writeUnits(): string[] {
  needDeps();
  const changed: string[] = [];
  const write = (name: string, text: string) => {
    const path = join(UNIT_DIR, name);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) changed.push(name);
    writeFileSync(path, text);
  };
  const t3bin = t3();
  mkdirSync(UNIT_DIR, { recursive: true });
  // Services don't read your shell profile: give them the PATH you have now, so T3 can find
  // claude, codex, opencode, git and node when it starts agents.
  const header = `# Written by ${join(STUDIO_DIR, "bin", "studio.ts")}; edit that, not this file.`;
  write(
    "studio-t3.service",
    `${header}
[Unit]
Description=T3 Code server for Studio (local worker, ${T3_HOST}:${T3_PORT})
After=network-online.target

[Service]
WorkingDirectory=%h
Environment=PATH=${process.env.PATH}
ExecStart=${t3bin} serve --host ${T3_HOST} --port ${T3_PORT} --no-browser
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
  );
  if (SUPPORT) {
    // Support machines run no hub: the main's is the one you use.
    spawnSync("systemctl", ["--user", "disable", "--now", "studio-hub.service"], { stdio: "ignore" });
    rmSync(join(UNIT_DIR, "studio-hub.service"), { force: true });
    systemctl("daemon-reload");
    return changed;
  }
  write(
    "studio-hub.service",
    `${header}
# The hub copes with workers being down, so it only prefers to start after T3.
[Unit]
Description=Studio hub (web UI on ${URL_})
Wants=studio-t3.service
After=studio-t3.service

[Service]
WorkingDirectory=${STUDIO_DIR}
Environment=PATH=${process.env.PATH}
Environment=STUDIO_HOME=${STUDIO_HOME}
Environment=STUDIO_PORT=${PORT}
ExecStart=${process.execPath} --disable-warning=ExperimentalWarning apps/hub/src/server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
  );
  systemctl("daemon-reload");
  return changed;
}

function winTaskExists(): boolean {
  return spawnSync("schtasks", ["/Query", "/TN", TASK], { stdio: "ignore" }).status === 0;
}

function ps(script: string): number {
  return spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: "inherit" }).status ?? 1;
}

async function service(sub = "status") {
  if (WIN) return winService(sub);
  if (MAC) die("boot services aren't supported on macOS yet. Run `studio` when you want it.");
  if (!which("systemctl")) die("boot services need systemd. Run `studio` when you want it.");
  const u = units();
  switch (sub) {
    case "on": {
      const changed = writeUnits();
      const wasActive = (n: string) => spawnSync("systemctl", ["--user", "is-active", "--quiet", n]).status === 0;
      const restart = changed.filter(wasActive); // `enable --now` won't apply a changed unit to a running service
      systemctl("enable", "--now", "studio-t3.service");
      if (restart.includes("studio-t3.service")) systemctl("restart", "studio-t3.service");
      if (!SUPPORT && (await waitFor(T3_URL, 60))) await pairLocal();
      systemctl("enable", "--now", ...u);
      const others = restart.filter((n) => n !== "studio-t3.service");
      if (others.length) systemctl("restart", ...others);
      const linger = spawnSync("loginctl", ["show-user", process.env.USER ?? "", "-p", "Linger", "--value"], { encoding: "utf8" }).stdout?.trim();
      if (linger !== "yes") say(`Note: these start when you log in. To start them at boot before login:\n  loginctl enable-linger ${process.env.USER}`);
      say(SUPPORT ? `This machine's T3 starts at boot, as a worker for ${SETTINGS.main}.` : `Studio is on and starts at boot: ${URL_}`);
      break;
    }
    case "off":
      spawnSync("systemctl", ["--user", "disable", "--now", ...u], { stdio: "ignore" });
      say("Studio is off and won't start at boot. Turn it back on with: studio service on");
      break;
    case "start":
    case "stop":
    case "restart":
      process.exitCode = systemctl(sub, ...u);
      break;
    case "status":
      for (const name of u) {
        const q = (what: string) => spawnSync("systemctl", ["--user", what, name], { encoding: "utf8" }).stdout.trim();
        say(`${name.padEnd(24)} ${q("is-active").padEnd(10)} at boot: ${q("is-enabled")}`);
      }
      break;
    case "logs":
      spawnSync("journalctl", ["--user", ...u.flatMap((n) => ["-u", n]), "-f"], { stdio: "inherit" });
      break;
    default:
      die("usage: studio service on|off|start|stop|restart|status|logs");
  }
}

/** Windows has no user services; a scheduled task at logon runs `studio --background` hidden. */
async function winService(sub: string) {
  switch (sub) {
    case "on": {
      needDeps();
      t3();
      // A worker set up with deploy/windows-worker.ps1 already starts T3 at login, open to the
      // network for another hub. Two login tasks would race for the port, so Studio's task takes
      // over: it starts T3 the same way (on every interface) and the old task goes.
      if (spawnSync("schtasks", ["/Query", "/TN", OLD_WORKER_TASK], { stdio: "ignore" }).status === 0) {
        writeSettings({ ...(await readSettings(STUDIO_HOME)), t3Host: "0.0.0.0" });
        ps(`Unregister-ScheduledTask -TaskName '${OLD_WORKER_TASK}' -Confirm:$false`);
        say(`Replaced the '${OLD_WORKER_TASK}' task: Studio now starts T3 at login, still reachable from your other hub.`);
      }
      stop(); // an instance from before (maybe in the other role) makes way for the task's
      const cmd = `& '${process.execPath}' '${join(STUDIO_DIR, "bin", "studio.ts")}' --background`;
      const code = ps(`
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -Command "${cmd.replace(/'/g, "''")}"' -WorkingDirectory $HOME
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName '${TASK}' -Action $action -Trigger $trigger -Settings $settings -Description 'Studio hub and T3 Code' -Force | Out-Null
Start-ScheduledTask -TaskName '${TASK}'`);
      if (code !== 0) die("couldn't register the scheduled task");
      say(SUPPORT ? `This machine's T3 starts when you log in, as a worker for ${SETTINGS.main}.` : `Studio is on and starts when you log in: ${URL_}`);
      say(dim(`Logs: ${STATE_DIR}`));
      break;
    }
    case "off":
      stop();
      ps(`Unregister-ScheduledTask -TaskName '${TASK}' -Confirm:$false -ErrorAction SilentlyContinue`);
      say("Studio is off and won't start at login. Turn it back on with: studio service on");
      break;
    case "start":
      ps(`Start-ScheduledTask -TaskName '${TASK}'`);
      break;
    case "stop":
      if (!stop()) say("Studio wasn't running.");
      break;
    case "restart":
      stop();
      ps(`Start-ScheduledTask -TaskName '${TASK}'`);
      break;
    case "status":
      say(`scheduled task '${TASK}'  ${winTaskExists() ? "registered (starts at login)" : "not registered"}`);
      if (SUPPORT) say(`main Studio ${SETTINGS.main}  ${(await up(SETTINGS.main!)) ? "reachable" : "not answering"}`);
      else say(`hub on ${URL_}  ${(await up(URL_)) ? "running" : "not running"}`);
      say(`T3 on ${T3_URL}  ${(await up(T3_URL)) ? "running" : "not running"}`);
      break;
    case "logs":
      say(`Logs are in ${STATE_DIR} (hub.log, t3.log).`);
      break;
    default:
      die("usage: studio service on|off|start|stop|restart|status|logs");
  }
}

// ------------------------------------------------------------------ doctor, update, pair

async function doctor() {
  let bad = false;
  const ok = (s: string) => say(`  ${green("✓")} ${s}`);
  const warn = (s: string) => say(`  ${yellow("!")} ${s}`);
  const fail = (s: string) => ((bad = true), say(`  ${red("✗")} ${s}`));

  say(`${bold("Studio")} ${STUDIO_DIR}`);
  if (versionGe(process.versions.node, NODE_MIN)) ok(`Node ${process.version}`);
  else fail(`Node ${process.version} is older than ${NODE_MIN}`);
  if (existsSync(join(STUDIO_DIR, "node_modules"))) ok("packages installed");
  else fail("packages missing (npm ci)");
  const v = t3Version();
  if (!v) fail(`T3 not installed (run ${WIN ? "install.ps1" : "install.sh"})`);
  else if (v !== T3_PIN) warn(`T3 ${v} (Studio is tested with ${T3_PIN})`);
  else ok(`T3 ${v}`);
  if (which("git")) ok("git");
  else fail("git not found (agents work in git worktrees)");

  say(`${bold("Agents")} ${dim("(T3 needs at least one, signed in)")}`);
  let any = false;
  for (const cli of ["claude", "codex", "opencode"]) {
    if (which(cli)) (ok(cli), (any = true));
    else warn(`${cli} not installed`);
  }
  if (!any) fail("no agent CLI found: install Claude Code, Codex or OpenCode");

  say(bold("Running"));
  if (await up(T3_URL)) ok(`T3 on ${T3_URL}${T3_HOST === "127.0.0.1" ? "" : " (reachable from your network)"}`);
  else warn("T3 not running ('studio' starts it)");
  if (SUPPORT) {
    ok(`support machine: works for the main Studio at ${SETTINGS.main} ('studio leave' to undo)`);
    if (await up(SETTINGS.main!)) ok("main Studio reachable");
    else warn("main Studio not answering");
  } else {
    if (await up(URL_)) ok(`hub on ${URL_}`);
    else warn("hub not running ('studio' starts it)");
    if ((SETTINGS.host ?? "127.0.0.1") === "127.0.0.1") ok("this computer only ('studio lan on' to open it to your network)");
    else ok("open to your network with the access key ('studio lan' for the link)");
  }
  if (WIN) (winTaskExists() ? ok : warn)(`starts at login: ${winTaskExists() ? "yes" : "no ('studio service on')"}`);
  else if (!MAC && which("systemctl")) (linuxServiceActive() ? ok : warn)(linuxServiceActive() ? "boot services on" : "boot services off ('studio service on')");

  if (SUPPORT) return void (process.exitCode = bad ? 1 : 0); // workers are listed on the main
  say(`${bold("Workers")} ${dim(`(${join(STUDIO_HOME, "workers")})`)}`);
  const dir = join(STUDIO_HOME, "workers");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
  for (const f of files) {
    const url = (JSON.parse(readFileSync(join(dir, f), "utf8")) as { url?: string }).url ?? "";
    ok(`${f.slice(0, -5)}  ${url}`);
  }
  if (!files.length) warn("none yet ('studio' pairs this machine's T3 on first run)");
  process.exitCode = bad ? 1 : 0;
}

// ------------------------------------------------------------------ join, leave

function ownAddresses(): Set<string> {
  const out = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const addrs of Object.values(networkInterfaces())) for (const a of addrs ?? []) out.add(a.address);
  return out;
}

/** This machine's address as the main machine would see it (the interface that routes there). */
function addressToward(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    sock.on("error", reject);
    sock.connect(port, host, () => {
      const { address } = sock.address();
      sock.close();
      resolve(address);
    });
  });
}

async function joinMain(args: string[]) {
  const usage = "usage: studio join <link from `studio lan` on the main machine> [--name <worker name>]";
  const link = args[0] ?? die(usage);
  const nameAt = args.indexOf("--name");
  const name = (nameAt >= 0 ? args[nameAt + 1] : hostname()) ?? die(usage);
  const workerName = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(link) ? link : `http://${link}`);
  } catch {
    die(usage);
  }
  const key = url.searchParams.get("key") ?? die("the link needs its ?key=... part: copy the whole link `studio lan` prints on the main machine");
  const main = url.origin;
  if (ownAddresses().has(url.hostname.replace(/^\[|\]$/g, "")) && Number(url.port || 80) === PORT) die("that link is this machine's own Studio. Run `studio join` on the other machines.");

  const api = async (path: string, init: RequestInit = {}) =>
    fetch(`${main}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${key}`, "content-type": "application/json" }, signal: AbortSignal.timeout(60_000) });
  const res = await api("/api/state").catch(() => undefined);
  if (!res) die(`can't reach ${main}. Is Studio running there, with \`studio lan on\`?`);
  if (res.status === 401) die("the main Studio refused that key. Copy a fresh link from `studio lan` there.");
  if (!res.ok) die(`the main Studio answered ${res.status}`);
  const state = (await res.json()) as { workers: { name: string; url: string }[] };

  // This machine stops being a hub of its own (its data stays in STUDIO_HOME for `studio leave`).
  if (!SUPPORT && (linuxServiceActive() || readRun() || (await up(URL_)))) {
    if (linuxServiceActive()) spawnSync("systemctl", ["--user", "disable", "--now", "studio-hub.service"], { stdio: "ignore" });
    stop();
    say("Stopped this machine's own hub. Its jobs and vault stay where they are; `studio leave` brings it back.");
  }
  writeSettings({ ...SETTINGS, main, mainKey: key, t3Host: "0.0.0.0" });
  say(`This machine is now support for the main Studio at ${bold(main)}.`);

  // Keep T3 running on the network, now and at boot/login, in a fresh process that reads the
  // new settings. Without a boot service (macOS), start T3 in the background instead.
  const self = join(STUDIO_DIR, "bin", "studio.ts");
  const service = !MAC && (WIN || which("systemctl")) ? spawnSync(process.execPath, [self, "service", "on"], { stdio: "inherit" }).status : 1;
  if (service !== 0 && !(await up(T3_URL))) {
    mkdirSync(STATE_DIR, { recursive: true });
    const fd = openSync(join(STATE_DIR, "t3.log"), "a");
    spawn(t3(), ["serve", "--host", "0.0.0.0", "--port", String(T3_PORT), "--no-browser"], { cwd: homedir(), stdio: ["ignore", fd, fd], detached: true, windowsHide: true }).unref();
    say(dim("Started T3 in the background (no boot service here; run `studio` after a restart)."));
  }

  const me = await addressToward(url.hostname, Number(url.port || 80));
  const t3Lan = `http://${me}:${T3_PORT}`;
  if (!(await waitFor(t3Lan, 60))) {
    die(`T3 here isn't reachable at ${t3Lan}. ${WIN ? "Allow t3.exe through Windows Firewall (Private networks)" : "Check the firewall for port " + T3_PORT}, then run this again.`);
  }

  const known = state.workers.find((w) => {
    try {
      return new URL(w.url).host === `${me}:${T3_PORT}`;
    } catch {
      return false;
    }
  });
  if (known) {
    say(`The main Studio already uses this machine as worker '${known.name}'.`);
  } else {
    const replacing = state.workers.find((w) => w.name === workerName);
    say(`${replacing ? "Updating" : "Adding"} this machine as worker '${workerName}' (${me}:${T3_PORT})...`);
    const out = execFileSync(t3(), ["auth", "pairing", "create", "--json", "--ttl", "5m", "--label", "Studio main hub"], { encoding: "utf8" });
    const code = (JSON.parse(out) as { credential: string }).credential;
    const r = await api("/api/workers", { method: "POST", body: JSON.stringify({ name: workerName, url: `${me}:${T3_PORT}`, code }) });
    if (!r.ok) die(`the main Studio couldn't pair this machine: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status}`);
    say(green(`Done: '${workerName}' shows up as a floor in the main Studio.`));
  }
  say(`From now on \`studio\` here opens ${main}.`);
}

function leaveMain() {
  if (!SUPPORT) die("this machine isn't support for another Studio.");
  const { main, mainKey: _, ...rest } = SETTINGS;
  writeSettings(rest);
  say(`This machine no longer uses ${main}. Its T3 keeps running (the main may still use it as a worker).`);
  say(`To run a hub here: ${bold("studio")}, or ${bold("studio service on")} to start it at boot.`);
}

async function update() {
  const hasRemote = spawnSync("git", ["remote", "get-url", "origin"], { cwd: STUDIO_DIR, stdio: "ignore" }).status === 0;
  if (hasRemote) {
    if (sh("git", ["pull", "--ff-only"]) !== 0) die("git pull failed");
  } else say(dim("No git remote to pull from; reinstalling packages only."));
  if (sh("npm", ["ci", "--no-audit", "--no-fund"]) !== 0) die("npm ci failed");
  if (linuxServiceActive()) (systemctl("restart", ...units()), say("Services restarted."));
  else if (WIN && winTaskExists() && readRun()) (stop(), ps(`Start-ScheduledTask -TaskName '${TASK}'`), say("Restarted Studio."));
  else if (await up(URL_)) say(yellow("Restart Studio to use the new version."));
  say("Studio is up to date.");
}

async function pair(args: string[]) {
  if (SUPPORT) die(`workers are added on the main machine (${SETTINGS.main}); this one joined it with \`studio join\`.`);
  if (args.length !== 3) die("usage: studio pair <name> <address, e.g. 192.168.1.20:3773> <pairing code>");
  needDeps();
  const [name, address, code] = args as [string, string, string];
  let url = /^https?:\/\//.test(address) ? address : `http://${address}`;
  if (!url.endsWith("/mcp")) url = `${url.replace(/\/$/, "")}/mcp`;
  const { T3Worker } = await import("@studio/t3-bridge");
  const worker = await T3Worker.pair(name, url, code);
  say(`signed in to ${name}; ${(await worker.listTools()).length} tools available`);
  await worker.close();
  if (await up(URL_)) say(yellow("Restart Studio so the running hub picks up the new worker, or add workers from the UI next time."));
}

// ------------------------------------------------------------------ main

if (!versionGe(process.versions.node, NODE_MIN)) die(`Studio needs Node >= ${NODE_MIN} (this is ${process.version}).`);
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case undefined:
  case "run":
  case "--no-browser":
  case "--background":
    await run(cmd?.startsWith("--") ? [cmd, ...rest] : rest);
    break;
  case "stop":
    say(stop() ? "Studio stopped." : linuxServiceActive() ? "Studio runs as a service here: studio service stop" : "Studio wasn't started by `studio`.");
    break;
  case "lan":
    await lan(rest[0]);
    break;
  case "join":
    await joinMain(rest);
    break;
  case "leave":
    leaveMain();
    break;
  case "service":
    await service(rest[0]);
    break;
  case "pair":
    await pair(rest);
    break;
  case "doctor":
    await doctor();
    break;
  case "update":
    await update();
    break;
  case "open":
    openBrowser();
    break;
  case "test":
    process.exitCode = sh("npm", ["test"]) || sh("npm", ["run", "typecheck"]);
    break;
  case "help":
  case "-h":
  case "--help":
    say(HELP);
    break;
  default:
    die(`unknown command '${cmd}' (try: studio help)`);
}
