import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ROOT, type PiCfg } from "./config.ts";

/** POSIX single-quote a string for a shell. */
export const sq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * Connection sharing (ControlMaster) makes the 5-second status polls cheap: one TCP/SSH
 * handshake per Pi, then each command is a new channel on the existing connection.
 */
const CONTROL_PATH = "/tmp/gaia-ssh-%C";
const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=5",
  // Windows' built-in OpenSSH has no connection multiplexing; there each command reconnects.
  ...(process.platform === "win32"
    ? []
    : ["-o", "ControlMaster=auto", "-o", `ControlPath=${CONTROL_PATH}`, "-o", "ControlPersist=120"]),
  "-o", "ServerAliveInterval=10",
  "-o", "ServerAliveCountMax=3",
];

/**
 * Per-Pi ssh options. HostKeyAlias checks every address (bingo.local, 192.168.0.6, …) against the
 * one known_hosts entry for the Pi's configured host, so a fallback IP doesn't fail BatchMode with
 * "host key verification failed" just because you never ssh'd to that IP by hand. accept-new
 * records the key on first contact; a *changed* key is still refused.
 */
export function sshOpts(pi: PiCfg): string[] {
  return [...SSH_OPTS, "-o", `HostKeyAlias=${pi.host}`, "-o", "StrictHostKeyChecking=accept-new"];
}

// ---- learned addresses ----------------------------------------------------------------------
// Each successful probe reports the Pi's hostname and IPv4 addresses. Gaia keeps them in
// .cache/addresses.json and tries them when mDNS fails, so "Fix mDNS name" etc. still work when
// <pi>.local doesn't resolve. A learned address only counts if it answers with the same hostname
// (DHCP may hand that IP to a different Pi later).
const ADDR_FILE = resolve(ROOT, ".cache", "addresses.json");
type Learned = Record<string, { hostname: string; addresses: string[]; at: string }>;
let learned: Learned = {};
try {
  if (existsSync(ADDR_FILE)) learned = JSON.parse(readFileSync(ADDR_FILE, "utf8"));
} catch {
  learned = {};
}

export function learnAddresses(pi: PiCfg, hostname: string, addresses: string[]) {
  const prev = learned[pi.id];
  const next = [...new Set(addresses.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)))];
  if (prev && prev.hostname === hostname && prev.addresses.join() === next.join()) return;
  learned[pi.id] = { hostname, addresses: next, at: new Date().toISOString() };
  mkdirSync(dirname(ADDR_FILE), { recursive: true });
  writeFileSync(ADDR_FILE, JSON.stringify(learned, null, 2) + "\n");
}

export function learnedFor(pi: PiCfg) {
  return learned[pi.id];
}

const resolved = new Map<string, { address: string; at: number }>();
const resolving = new Map<string, Promise<string>>();

export class Unreachable extends Error {}

export function candidates(pi: PiCfg): string[] {
  return [...new Set([pi.host, ...pi.fallbackHosts, ...(learned[pi.id]?.addresses ?? [])].filter(Boolean))];
}

/** Last address that worked for this Pi, if any (for display before the first connection). */
export function knownAddress(pi: PiCfg): string {
  return resolved.get(pi.id)?.address ?? pi.host;
}

export function forgetAddress(pi: PiCfg) {
  resolved.delete(pi.id);
}

async function tryAddress(pi: PiCfg, address: string, learnedOnly: boolean): Promise<boolean> {
  const proc = Bun.spawn(["ssh", ...sshOpts(pi), "-o", "ConnectTimeout=4", `${pi.user}@${address}`, "hostname"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const timer = setTimeout(() => proc.kill(), 7000);
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) return false;
  // A learned IP may since have gone to another Pi, and the lab Pis were cloned from one SD card
  // (same host keys), so the key alone can't tell them apart: require the hostname we saw there.
  // Configured hosts are trusted as written.
  const expect = learned[pi.id]?.hostname;
  return !learnedOnly || !expect || out.trim() === expect;
}

/** Find a working address: try the hostname and all fallbacks in parallel, prefer earlier entries. */
export async function resolveAddress(pi: PiCfg): Promise<string> {
  const cached = resolved.get(pi.id);
  if (cached) return cached.address;
  const inflight = resolving.get(pi.id);
  if (inflight) return inflight;
  const p = (async () => {
    const list = candidates(pi);
    const configured = new Set([pi.host, ...pi.fallbackHosts]);
    const results = await Promise.all(list.map((a) => tryAddress(pi, a, !configured.has(a))));
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
export function sshArgv(pi: PiCfg, tgt: string, remoteCmd: string): string[] {
  return ["ssh", ...sshOpts(pi), tgt, remoteCmd];
}

/**
 * Drop the shared connection, e.g. after adding the user to the `docker` group: group changes
 * only apply to new logins, and ControlPersist would otherwise keep reusing the old session.
 */
export async function closeConnection(pi: PiCfg) {
  const addr = resolved.get(pi.id)?.address;
  resolved.delete(pi.id);
  if (process.platform === "win32" || !addr) return;
  await runArgv(["ssh", ...sshOpts(pi), "-O", "exit", `${pi.user}@${addr}`], { timeoutMs: 5000 });
}

/** Human-readable form: connection-sharing options omitted. */
export function sshDisplay(tgt: string, remoteCmd: string): string {
  // Plain words (e.g. `talos stop camera`) need no quotes: ssh joins its arguments with spaces anyway.
  return `ssh ${tgt} ${/^[\w@%+=:,./ -]+$/.test(remoteCmd) ? remoteCmd : sq(remoteCmd)}`;
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
  const res = await runArgv(["ssh", ...sshOpts(pi), tgt, cmd], opts);
  if (res.code === 255) forgetAddress(pi); // ssh-level failure: re-resolve next time
  return res;
}
