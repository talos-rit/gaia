import type { PiCfg } from "./config.ts";

/** POSIX single-quote a string for a shell. */
export const sq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Connection sharing (ControlMaster) makes the 5-second status polls cheap: one TCP/SSH
 * handshake per Pi, then each command is a new channel on the existing connection.
 */
export const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=5",
  // Windows' built-in OpenSSH has no connection multiplexing; there each command reconnects.
  ...(process.platform === "win32"
    ? []
    : ["-o", "ControlMaster=auto", "-o", "ControlPath=/tmp/gaia-ssh-%C", "-o", "ControlPersist=120"]),
  "-o", "ServerAliveInterval=10",
  "-o", "ServerAliveCountMax=3",
];

const resolved = new Map<string, { address: string; at: number }>();
const resolving = new Map<string, Promise<string>>();

export class Unreachable extends Error {}

export function candidates(pi: PiCfg): string[] {
  return [pi.host, ...pi.fallbackHosts].filter(Boolean);
}

/** Last address that worked for this Pi, if any (for display before the first connection). */
export function knownAddress(pi: PiCfg): string {
  return resolved.get(pi.id)?.address ?? pi.host;
}

export function forgetAddress(pi: PiCfg) {
  resolved.delete(pi.id);
}

async function tryAddress(pi: PiCfg, address: string): Promise<boolean> {
  const proc = Bun.spawn(["ssh", ...SSH_OPTS, "-o", "ConnectTimeout=4", `${pi.user}@${address}`, "true"], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), 7000);
  const code = await proc.exited;
  clearTimeout(timer);
  return code === 0;
}

/** Find a working address: try the hostname and all fallbacks in parallel, prefer earlier entries. */
export async function resolveAddress(pi: PiCfg): Promise<string> {
  const cached = resolved.get(pi.id);
  if (cached) return cached.address;
  const inflight = resolving.get(pi.id);
  if (inflight) return inflight;
  const p = (async () => {
    const list = candidates(pi);
    const results = await Promise.all(list.map((a) => tryAddress(pi, a)));
    const idx = results.findIndex(Boolean);
    if (idx < 0) throw new Unreachable(`No SSH answer from ${list.join(", ")}`);
    resolved.set(pi.id, { address: list[idx]!, at: Date.now() });
    return list[idx]!;
  })().finally(() => resolving.delete(pi.id));
  resolving.set(pi.id, p);
  return p;
}

export async function target(pi: PiCfg): Promise<string> {
  return `${pi.user}@${await resolveAddress(pi)}`;
}

/** argv for running `remoteCmd` on the Pi (the remote side is the Pi's bash, so shell syntax is fine there). */
export function sshArgv(tgt: string, remoteCmd: string): string[] {
  return ["ssh", ...SSH_OPTS, tgt, remoteCmd];
}

/** Human-readable form: connection-sharing options omitted. */
export function sshDisplay(tgt: string, remoteCmd: string): string {
  return `ssh ${tgt} ${sq(remoteCmd)}`;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  stdin?: string;
  timeoutMs?: number;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
}

export async function readLines(stream: ReadableStream<Uint8Array>, cb: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  let all = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    all += text;
    buf += text;
    // Treat \r as a line break too, so progress output (docker load, git fetch) shows up live.
    const parts = buf.split(/\r\n|\n|\r/);
    buf = parts.pop() ?? "";
    for (const p of parts) cb(p);
  }
  if (buf) cb(buf);
  return all;
}

/** Spawn a process, stream its lines, and resolve with collected output. */
export async function runArgv(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, opts.timeoutMs)
    : undefined;
  const onAbort = () => proc.kill();
  opts.signal?.addEventListener("abort", onAbort);
  const [stdout, stderr, code] = await Promise.all([
    readLines(proc.stdout, (l) => opts.onLine?.(l, "stdout")),
    readLines(proc.stderr, (l) => opts.onLine?.(l, "stderr")),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);
  return { code: timedOut ? 124 : code, stdout, stderr: timedOut ? stderr + `\n(timed out after ${opts.timeoutMs} ms)` : stderr };
}

export async function runRemote(pi: PiCfg, cmd: string, opts: RunOpts = {}): Promise<RunResult> {
  const tgt = await target(pi);
  const res = await runArgv(["ssh", ...SSH_OPTS, tgt, cmd], opts);
  if (res.code === 255) forgetAddress(pi); // ssh-level failure: re-resolve next time
  return res;
}
