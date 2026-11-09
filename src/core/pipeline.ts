/**
 * Local commands without a shell. Each pipeline is a chain of stages:
 *   - proc:   a real program (git, docker, ssh), spawned with an argv (no quoting pitfalls)
 *   - source / xform / sink / task: done inside Gaia (tar, gzip, file copies), shown as "[gaia] ..."
 * This is what makes Gaia run identically on macOS, Linux and plain Windows (no WSL / Git Bash).
 */
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { ROOT } from "./config.ts";
import { readLines, sq, type RunResult } from "./ssh.ts";

export type Stage =
  | { kind: "proc"; argv: string[]; display?: string; env?: Record<string, string> }
  | { kind: "source"; display: string; make: () => ReadableStream<Uint8Array> }
  | { kind: "xform"; display: string; make: (input: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array> }
  | { kind: "sink"; display: string; consume: (input: ReadableStream<Uint8Array>) => Promise<void> }
  | { kind: "task"; display: string; run: (log: (line: string) => void) => Promise<void> };

export type Pipeline = Stage[];

export const proc = (...argv: string[]): Stage => ({ kind: "proc", argv });

/** Streaming gzip (level 1: the LAN is the bottleneck, not the CPU). */
export const gzip: Stage = {
  kind: "xform",
  display: "gzip -1",
  make: (input) => Readable.toWeb(Readable.fromWeb(input as never).pipe(createGzip({ level: 1 }))) as unknown as ReadableStream<Uint8Array>,
};
export const task = (display: string, run: (log: (l: string) => void) => Promise<void> | void): Stage => ({
  kind: "task",
  display,
  run: async (log) => void (await run(log)),
});

/** Shorten paths inside the Gaia checkout for display. */
export function rel(s: string): string {
  const roots = [ROOT + "/", ROOT + "\\"];
  for (const r of roots) s = s.split(r).join("");
  return s;
}

export function displayStage(s: Stage): string {
  if (s.kind === "proc") return s.display ?? rel(s.argv.map(sq).join(" "));
  return `[gaia] ${rel(s.display)}`;
}

export function displayPipeline(p: Pipeline): string {
  return p.map(displayStage).join(" | ");
}

export interface PipeOpts {
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  timeoutMs?: number;
}

export async function runPipeline(p: Pipeline, opts: PipeOpts = {}): Promise<RunResult> {
  const procs: Bun.Subprocess[] = [];
  const waits: Promise<number>[] = [];
  const stderrDone: Promise<unknown>[] = [];
  let stderr = "";
  const errLine = (l: string) => {
    stderr += l + "\n";
    opts.onLine?.(l, "stderr");
  };
  let stream: ReadableStream<Uint8Array> | undefined;
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        for (const pr of procs) pr.kill();
      }, opts.timeoutMs)
    : undefined;

  const guard = (fn: () => Promise<void>) =>
    fn().then(
      () => 0,
      (e) => {
        errLine(`[gaia] ${(e as Error)?.message ?? e}`);
        for (const pr of procs) pr.kill();
        return 1;
      },
    );

  try {
    for (const s of p) {
      if (s.kind === "task") {
        const c = await guard(() => s.run((l) => opts.onLine?.(l, "stdout")));
        waits.push(Promise.resolve(c));
        if (c !== 0) break;
      } else if (s.kind === "source") stream = s.make();
      else if (s.kind === "xform") stream = s.make(stream!);
      else if (s.kind === "sink") {
        const input = stream!;
        stream = undefined;
        waits.push(guard(() => s.consume(input)));
      } else {
        const pr = Bun.spawn(s.argv, {
          stdin: stream ?? "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, LC_ALL: "C", ...(s.env ?? {}) },
        });
        procs.push(pr);
        stderrDone.push(readLines(pr.stderr, errLine));
        waits.push(pr.exited);
        stream = pr.stdout;
      }
    }
  } catch (e) {
    errLine(`[gaia] ${(e as Error).message}`);
    for (const pr of procs) pr.kill();
    await stream?.cancel().catch(() => {}); // never dump a half-built (binary) stream into the log
    stream = undefined;
    waits.push(Promise.resolve(1));
  }

  const stdout = stream ? await readLines(stream, (l) => opts.onLine?.(l, "stdout")).catch(() => "") : "";
  const codes = await Promise.all(waits);
  await Promise.all(stderrDone);
  if (timer) clearTimeout(timer);
  const code = timedOut ? 124 : (codes.find((c) => c !== 0) ?? 0);
  return { code, stdout, stderr: timedOut ? stderr + `(timed out after ${opts.timeoutMs} ms)\n` : stderr };
}

/** Run pipelines one after another (like `a && b`), concatenating stdout. */
export async function runPipelines(ps: Pipeline[], opts: PipeOpts = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  for (const p of ps) {
    const r = await runPipeline(p, opts);
    stdout += r.stdout;
    stderr += r.stderr;
    if (r.code !== 0) return { code: r.code, stdout, stderr };
  }
  return { code: 0, stdout, stderr };
}
