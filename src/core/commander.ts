/**
 * Commander on this machine: clone, branch, build (uv + the Vite web UI) and run `uv run commander-web`.
 *
 * Commander runs detached, with its output going to .cache/commander/commander.log, and Gaia
 * tracks it through a PID file. It keeps running when Gaia restarts (bun --watch) or stops, and
 * Gaia picks it up again on the next start.
 * Stop is a Ctrl+C for the whole process group (uv, Python and Commander's worker processes);
 * on Windows it's `taskkill /T`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, type Config, type PiCfg } from "./config.ts";
import type { Lockable, Step } from "./jobs.ts";
import { task, type Stage } from "./pipeline.ts";
import { runArgv, sq } from "./ssh.ts";
import { rtspUrl } from "./stack.ts";

export const COMMANDER_LOCK: Lockable = { id: "commander", name: "Commander" };

const CACHE = resolve(ROOT, ".cache", "commander");
export const LOG_FILE = join(CACHE, "commander.log");
export const PREV_LOG_FILE = join(CACHE, "commander.previous.log");
const PROC_FILE = join(CACHE, "process.json");
const BUILD_FILE = join(CACHE, "build.json");
const LOG_SHOWN = ".cache/commander/commander.log";

const WIN = process.platform === "win32";
/** Gaia runs on Bun, so Bun is always here; using its path avoids PATH and .cmd shim issues on Windows. */
const BUN = process.execPath;

const webDir = (cfg: Config) => join(cfg.commander.dir, "web");
const shownPath = (cfg: Config) => cfg.commander.path.replace(/\\/g, "/");

/** A program run inside a directory, displayed as `cd <dir> && <cmd>`. */
function inDir(cwd: string, shownCwd: string, argv: string[], shown: string[] = argv): Stage {
  return { kind: "proc", argv, cwd, display: `cd ${sq(shownCwd)} && ${shown.map(sq).join(" ")}` };
}

export const isCloned = (cfg: Config) => existsSync(join(cfg.commander.dir, ".git"));

// ---- where commander-web listens ------------------------------------------------------------

export interface WebAddress {
  port: number;
  /** For Gaia's own health checks. */
  probe: string;
  /** For the link in the UI. */
  url: string;
}

/** Commander's web_host/web_port: env vars override app_settings.local.yaml, which overrides app_settings.yaml. */
export function webAddress(cfg: Config): WebAddress {
  let host = "127.0.0.1";
  let port = 8000;
  for (const f of ["app_settings.yaml", "app_settings.local.yaml"]) {
    try {
      const y = Bun.YAML.parse(readFileSync(join(cfg.commander.dir, "config", f), "utf8")) as Record<string, unknown> | null;
      if (y?.web_host) host = String(y.web_host);
      if (y?.web_port) port = Number(y.web_port);
    } catch {
      /* missing or unparsable: keep the defaults */
    }
  }
  if (process.env.COMMANDER_WEB_HOST) host = process.env.COMMANDER_WEB_HOST;
  if (process.env.COMMANDER_WEB_PORT) port = Number(process.env.COMMANDER_WEB_PORT);
  const local = ["0.0.0.0", "::", "127.0.0.1", "localhost"].includes(host);
  const h = local ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return { port, probe: `http://${h}:${port}`, url: `http://${local ? "localhost" : h}:${port}` };
}

export type Health = "ready" | "starting" | "down";

/** Commander's /api/health: `ready` once it has connected to the robots. Any HTTP answer means it's listening. */
async function health(addr: WebAddress): Promise<Health> {
  try {
    const r = await fetch(`${addr.probe}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!r.ok) return "starting";
    const j = (await r.json().catch(() => ({}))) as { ready?: boolean };
    return j.ready ? "ready" : "starting";
  } catch {
    return "down";
  }
}

// ---- the process ----------------------------------------------------------------------------

interface ProcRecord {
  pid: number;
  startedAt: number;
  branch?: string;
  sha?: string;
}

let child: Bun.Subprocess | undefined;
/** Set when commander-web exited without Gaia stopping it. */
let lastExit: { code: number | null; at: number } | undefined;
const stopRequested = new Set<number>();

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The commander-web Gaia started, if it's still running (also after Gaia restarted). */
export function runningProc(): ProcRecord | undefined {
  const r = readJson<ProcRecord>(PROC_FILE);
  if (!r) return undefined;
  if (alive(r.pid)) return r;
  rmSync(PROC_FILE, { force: true });
  return undefined;
}

function lastLines(file: string, n: number): string[] {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

async function startProcess(cfg: Config, log: (l: string) => void) {
  const running = runningProc();
  if (running) return log(`already running (pid ${running.pid})`);
  const addr = webAddress(cfg);
  if ((await health(addr)) !== "down")
    throw new Error(`something already answers at ${addr.url}, and Gaia didn't start it. Stop that Commander first (or change web_port).`);
  if (!Bun.which("uv")) throw new Error("uv is not installed: see https://docs.astral.sh/uv/getting-started/installation/");
  const git = await gitInfo(cfg);
  mkdirSync(CACHE, { recursive: true });
  if (existsSync(LOG_FILE)) renameSync(LOG_FILE, PREV_LOG_FILE);
  writeFileSync(LOG_FILE, `# ${new Date().toISOString()}  uv run commander-web  (in ${shownPath(cfg)}, ${git?.branch ?? "?"} @ ${git?.short ?? "?"})\n`);
  const fd = openSync(LOG_FILE, "a");
  let p: Bun.Subprocess;
  try {
    p = Bun.spawn(["uv", "run", "commander-web"], {
      cwd: cfg.commander.dir,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      // Own process group on macOS/Linux: survives Gaia restarts and Ctrl+C in Gaia's terminal,
      // and Stop can signal the whole group. Windows: a detached process would get its own console window.
      detached: !WIN,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
  } finally {
    closeSync(fd);
  }
  p.unref();
  child = p;
  lastExit = undefined;
  writeFileSync(PROC_FILE, JSON.stringify({ pid: p.pid, startedAt: Date.now(), branch: git?.branch, sha: git?.sha } satisfies ProcRecord));
  log(`started pid ${p.pid}; output goes to ${LOG_SHOWN} (Logs on the Commander card)`);
  let exited = false;
  void p.exited.then((code) => {
    exited = true;
    if (readJson<ProcRecord>(PROC_FILE)?.pid === p.pid) rmSync(PROC_FILE, { force: true });
    if (!stopRequested.delete(p.pid)) lastExit = { code, at: Date.now() };
    if (child === p) child = undefined;
  });

  // The first `uv run` after a branch switch may install packages, so give it a while.
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await Bun.sleep(1000);
    if (exited) {
      for (const l of lastLines(LOG_FILE, 40)) log(l);
      throw new Error(`commander-web exited (code ${p.exitCode}) before it started listening`);
    }
    const h = await health(addr);
    if (h !== "down") return log(h === "ready" ? `ready at ${addr.url}` : `listening at ${addr.url}; connecting to robots…`);
  }
  for (const l of lastLines(LOG_FILE, 20)) log(l);
  throw new Error(`commander-web didn't answer at ${addr.url}/api/health within 3 minutes (still running; see Logs)`);
}

async function stopProcess(log: (l: string) => void) {
  const r = runningProc();
  if (!r) return log("not running");
  const { pid } = r;
  stopRequested.add(pid);
  const gone = async (ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!alive(pid)) return true;
      await Bun.sleep(200);
    }
    return !alive(pid);
  };
  if (WIN) {
    const res = await runArgv(["taskkill", "/PID", String(pid), "/T", "/F"], { timeoutMs: 15_000 });
    for (const l of (res.stdout + res.stderr).split(/\r?\n/).filter(Boolean)) log(l);
  } else {
    // Ctrl+C for the whole group: uv, Python, and Commander's multiprocessing workers.
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {
          /* already gone */
        }
      }
    };
    signal("SIGINT");
    // Commander finishes the robot connection it's opening before it exits (~10 s per unreachable camera).
    if (!(await gone(20_000))) {
      log("still running after 20 s; sending SIGKILL");
      signal("SIGKILL");
    }
  }
  if (!(await gone(5_000))) throw new Error(`pid ${pid} is still running`);
  rmSync(PROC_FILE, { force: true });
  log(`stopped (pid ${pid})`);
}

// ---- git ------------------------------------------------------------------------------------

export interface GitInfo {
  branch: string;
  sha: string;
  short: string;
  /** Number of changed or untracked files. */
  dirty: number;
  upstream?: string;
  ahead: number;
  behind: number;
}

const git = async (cfg: Config, ...args: string[]) => {
  const r = await runArgv(["git", "-C", cfg.commander.dir, ...args], { timeoutMs: 8000 });
  return r.code === 0 ? r.stdout.trim() : undefined;
};

export async function gitInfo(cfg: Config): Promise<GitInfo | undefined> {
  if (!isCloned(cfg)) return undefined;
  const [branch, sha, porcelain, upstream, counts] = await Promise.all([
    git(cfg, "rev-parse", "--abbrev-ref", "HEAD"),
    git(cfg, "rev-parse", "HEAD"),
    git(cfg, "status", "--porcelain"),
    git(cfg, "rev-parse", "--abbrev-ref", "@{u}"),
    git(cfg, "rev-list", "--left-right", "--count", "HEAD...@{u}"),
  ]);
  if (!sha) return undefined;
  const [ahead, behind] = (counts ?? "0 0").split(/\s+/).map(Number);
  return {
    branch: branch ?? "?",
    sha,
    short: sha.slice(0, 7),
    dirty: porcelain ? porcelain.split("\n").filter(Boolean).length : 0,
    upstream,
    ahead: ahead ?? 0,
    behind: behind ?? 0,
  };
}

export interface Branch {
  name: string;
  /** Only on origin; `git switch` creates a local tracking branch. */
  remoteOnly: boolean;
}

export async function listBranches(cfg: Config): Promise<Branch[]> {
  const out = (await git(cfg, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin")) ?? "";
  const local = new Set<string>();
  const remote = new Set<string>();
  for (const ref of out.split("\n").filter(Boolean)) {
    if (ref.startsWith("refs/heads/")) local.add(ref.slice(11));
    else if (ref !== "refs/remotes/origin/HEAD") remote.add(ref.slice("refs/remotes/origin/".length));
  }
  return [...new Set([...local, ...remote])].sort().map((name) => ({ name, remoteOnly: !local.has(name) }));
}

export const fetchCommand = (cfg: Config) => ["git", "-C", cfg.commander.dir, "fetch", "--prune", "origin"];

export async function fetchBranches(cfg: Config) {
  return runArgv(fetchCommand(cfg), { timeoutMs: 30_000 });
}

// ---- Commander's config files (created once, never overwritten) -----------------------------

const PROFILES = ["native", "esp-one-axis"];

/** One robot_configs.local.yaml entry per Pi, in the shape of Commander's docs/examples/two-pi-robots.yaml. */
function robotEntry(pi: PiCfg): Record<string, unknown> {
  const e: Record<string, unknown> = {
    robot_id: pi.id,
    socket_host: pi.host,
    socket_port: pi.arm.operatorPort,
    ...(PROFILES.includes(pi.arm.controller) ? { controller_profile: pi.arm.controller } : {}),
    camera_index: rtspUrl(pi, pi.host),
    pi_vision_enabled: true,
    pi_vision_url: `http://${pi.host}:${pi.arm.visionPort}`,
  };
  // Vertical tracking needs joint telemetry; the one-axis ESP controller has neither.
  if (pi.arm.controller === "esp-one-axis" || !pi.arm.telemetry) Object.assign(e, { track_elbow: false, track_shoulder: false, track_polar_vertical: false });
  return e;
}

export interface ConfigFile {
  /** Relative to the Commander checkout. */
  name: string;
  path: string;
  body: string;
  exists: boolean;
}

export function commanderConfigFiles(cfg: Config): ConfigFile[] {
  const header = (what: string) =>
    `# Created by Gaia from gaia.config.yaml (+ gaia.local.yaml) on ${new Date().toLocaleDateString("sv")}: ${what}.\n` +
    "# Gaia never overwrites this file; edit it here or in Commander's Settings.\n";
  const robots = Object.fromEntries(cfg.pis.map((pi) => [pi.id, robotEntry(pi)]));
  const settings: Record<string, unknown> = {};
  if (cfg.pis[0]) settings.camera_1_host = cfg.pis[0].id;
  if (cfg.pis[1]) settings.camera_2_host = cfg.pis[1].id;
  const files = [
    { name: "config/robot_configs.local.yaml", body: header("one entry per Pi") + Bun.YAML.stringify(robots, null, 2) + "\n" },
    { name: "config/app_settings.local.yaml", body: header("feeds 1 and 2 show the first two Pis") + Bun.YAML.stringify(settings, null, 2) + "\n" },
  ];
  return files.map((f) => {
    const path = join(cfg.commander.dir, ...f.name.split("/"));
    return { ...f, path, exists: existsSync(path) };
  });
}

function writeConfigs(cfg: Config, log: (l: string) => void) {
  for (const f of commanderConfigFiles(cfg)) {
    try {
      mkdirSync(join(f.path, ".."), { recursive: true });
      // "wx" = create only: fails if the file exists, atomically, so an existing config is never touched.
      writeFileSync(f.path, f.body, { flag: "wx" });
      log(`created ${f.name}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      log(`kept the existing ${f.name} (Gaia never overwrites it)`);
    }
  }
}

// ---- web UI build record --------------------------------------------------------------------

export interface BuildInfo {
  /** Commit the web UI was built from; undefined when it was built outside Gaia. */
  sha?: string;
  dirty?: boolean;
  /** dist/index.html mtime. */
  at?: number;
}

export function buildInfo(cfg: Config): BuildInfo | undefined {
  const index = join(webDir(cfg), "dist", "index.html");
  if (!existsSync(index)) return undefined;
  const rec = readJson<{ dir: string; sha: string; dirty: boolean }>(BUILD_FILE);
  return { ...(rec?.dir === cfg.commander.dir ? { sha: rec.sha, dirty: rec.dirty } : {}), at: statSync(index).mtimeMs };
}

// ---- steps ----------------------------------------------------------------------------------

export function cloneStep(cfg: Config): Step {
  const { repo, branch, dir } = cfg.commander;
  return {
    where: "local",
    label: `Clone Commander (${branch})`,
    run: [[{ kind: "proc", argv: ["git", "clone", "--branch", branch, repo, dir], display: `git clone --branch ${sq(branch)} ${repo} ${sq(shownPath(cfg))}` }]],
    timeoutMs: 600_000,
  };
}

export function configStep(cfg: Config): Step {
  const names = commanderConfigFiles(cfg).map((f) => f.name);
  return {
    where: "local",
    label: "Create Commander config files (only if missing)",
    run: [[task(`create ${names.join(" and ")} in ${shownPath(cfg)} unless they exist`, (log) => writeConfigs(cfg, log))]],
  };
}

export function buildSteps(cfg: Config): Step[] {
  const d = cfg.commander;
  const web = `${shownPath(cfg)}/web`;
  return [
    configStep(cfg),
    // No extras: Pi-Vision does the pose detection, so Commander needs neither YOLO nor MediaPipe.
    // --inexact keeps any extras someone installed by hand.
    { where: "local", label: "Install Python dependencies", run: [[inDir(d.dir, shownPath(cfg), ["uv", "sync", "--inexact"])]], timeoutMs: 900_000 },
    { where: "local", label: "Install web UI dependencies", run: [[inDir(webDir(cfg), web, [BUN, "install"], ["bun", "install"])]], timeoutMs: 600_000 },
    {
      where: "local",
      label: "Build the web UI",
      run: [
        [inDir(webDir(cfg), web, [BUN, "run", "build"], ["bun", "run", "build"])],
        [
          task("note which commit the web UI was built from", async () => {
            const g = await gitInfo(cfg);
            mkdirSync(CACHE, { recursive: true });
            writeFileSync(BUILD_FILE, JSON.stringify({ dir: d.dir, sha: g?.sha, dirty: (g?.dirty ?? 0) > 0 }));
          }),
        ],
      ],
      timeoutMs: 600_000,
    },
  ];
}

export function startStep(cfg: Config): Step {
  const addr = webAddress(cfg);
  return {
    where: "local",
    label: "Start commander-web",
    display: `cd ${sq(shownPath(cfg))} && uv run commander-web > ${LOG_SHOWN} 2>&1 &    # then wait for ${addr.url}/api/health`,
    run: [[task("start", (log) => startProcess(cfg, log))]],
  };
}

export function stopStep(): Step {
  const pid = runningProc()?.pid ?? "<pid>";
  return {
    where: "local",
    label: "Stop commander-web",
    display: WIN ? `taskkill /PID ${pid} /T /F` : `kill -INT -${pid}    # Ctrl+C for commander-web and its worker processes; SIGKILL after 20 s`,
    run: [[task("stop", (log) => stopProcess(log))]],
  };
}

const gitStep = (cfg: Config, label: string, args: string[], extra: Partial<Step> = {}): Step =>
  ({
    where: "local",
    label,
    run: [[inDir(cfg.commander.dir, shownPath(cfg), ["git", ...args])]],
    timeoutMs: 120_000,
    ...extra,
  }) as Step;

export type CommanderAction = "setup" | "build" | "start" | "stop" | "restart" | "pull";

export const COMMANDER_ACTIONS: Record<CommanderAction, { label: string; description: string; steps: (cfg: Config) => Step[] }> = {
  setup: {
    label: "Set up",
    description: "Clone Commander, create its config files for the Pis in gaia.config.yaml, install its dependencies, build the web UI, and start it.",
    steps: (cfg) => [cloneStep(cfg), ...buildSteps(cfg), startStep(cfg)],
  },
  build: {
    label: "Build & run",
    description: "Install dependencies, build the web UI, then (re)start commander-web.",
    steps: (cfg) => [...buildSteps(cfg), ...(runningProc() ? [stopStep()] : []), startStep(cfg)],
  },
  start: { label: "Start", description: "Run commander-web as it was last built.", steps: (cfg) => [startStep(cfg)] },
  stop: { label: "Stop", description: "Stop commander-web, like pressing Ctrl+C.", steps: () => [stopStep()] },
  restart: { label: "Restart", description: "Stop, then start commander-web (no rebuild).", steps: (cfg) => [stopStep(), startStep(cfg)] },
  pull: {
    label: "Pull",
    description: "Fast-forward the current branch to its upstream. Run Build & run afterwards to use the new code.",
    steps: (cfg) => [gitStep(cfg, "Pull", ["pull", "--ff-only"])],
  },
};

export function switchSteps(cfg: Config, branch: string, rebuild: boolean): Step[] {
  return [
    gitStep(cfg, "Fetch branches", ["fetch", "--prune", "origin"], { allowFail: true }),
    gitStep(cfg, `Switch to ${branch}`, ["switch", branch]),
    // A branch with no upstream can't be pulled; that's fine.
    gitStep(cfg, "Pull", ["pull", "--ff-only"], { allowFail: true }),
    ...(rebuild ? COMMANDER_ACTIONS.build.steps(cfg) : []),
  ];
}

// ---- status for the card --------------------------------------------------------------------

export interface CommanderStatus {
  cloned: boolean;
  uv: boolean;
  git?: GitInfo;
  build?: BuildInfo;
  proc?: ProcRecord;
  health: Health;
  lastExit?: { code: number | null; at: number };
  addr: WebAddress;
}

let cached: { at: number; dir: string; value: Promise<CommanderStatus> } | undefined;

export function invalidateCommanderStatus() {
  cached = undefined;
}

export function commanderStatus(cfg: Config): Promise<CommanderStatus> {
  if (cached && cached.dir === cfg.commander.dir && Date.now() - cached.at < 2500) return cached.value;
  const value = (async (): Promise<CommanderStatus> => {
    const addr = webAddress(cfg);
    const [g, h] = await Promise.all([gitInfo(cfg), health(addr)]);
    return { cloned: isCloned(cfg), uv: !!Bun.which("uv"), git: g, build: buildInfo(cfg), proc: runningProc(), health: h, lastExit, addr };
  })();
  cached = { at: Date.now(), dir: cfg.commander.dir, value };
  return value;
}

// ---- logs -----------------------------------------------------------------------------------

/** `tail -n <n> -F` for the log file, in-process (works the same on Windows). */
export async function tailLog(file: string, n: number, onLine: (l: string) => Promise<unknown>, isAborted: () => boolean, follow = true) {
  for (const l of lastLines(file, n)) await onLine(l);
  if (!follow) return;
  let ino = existsSync(file) ? statSync(file).ino : -1;
  let offset = existsSync(file) ? statSync(file).size : 0;
  let decoder = new TextDecoder();
  let carry = "";
  while (!isAborted()) {
    await Bun.sleep(500);
    if (!existsSync(file)) continue;
    const st = statSync(file);
    if (st.ino !== ino || st.size < offset) {
      // A new run replaced the log.
      ino = st.ino;
      offset = 0;
      carry = "";
      decoder = new TextDecoder();
      await onLine("──────── commander-web restarted ────────");
    }
    if (st.size <= offset) continue;
    const chunk = await Bun.file(file).slice(offset, st.size).arrayBuffer();
    offset = st.size;
    const parts = (carry + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
    carry = parts.pop() ?? "";
    for (const p of parts) await onLine(p);
  }
}
