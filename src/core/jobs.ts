import type { PiCfg } from "./config.ts";
import { displayPipeline, runPipelines, type Pipeline } from "./pipeline.ts";
import { runRemote, sshDisplay, target, knownAddress, type RunResult } from "./ssh.ts";

/**
 * A Step is the unit of transparency, and the UI shows exactly what it executes:
 *  - remote steps: `cmd` runs on the Pi via `ssh <pi> <cmd>` (the Pi's bash interprets it)
 *  - local steps: `run` is a list of pipelines executed in order (no local shell involved)
 */
export type Step = RemoteStep | LocalStep;
interface BaseStep {
  label: string;
  /** Shown instead of the generated text, e.g. to hide long ssh -o options. */
  display?: string;
  stdin?: string;
  /** Describes stdin in the displayed command, e.g. "generated udev rules". */
  stdinNote?: string;
  allowFail?: boolean;
  timeoutMs?: number;
}
export interface RemoteStep extends BaseStep {
  where: "remote";
  cmd: string;
}
export interface LocalStep extends BaseStep {
  where: "local";
  run: Pipeline[];
}

export function displayStep(step: Step, pi?: PiCfg): string {
  if (step.display) return step.display;
  const base =
    step.where === "remote"
      ? pi
        ? sshDisplay(`${pi.user}@${knownAddress(pi)}`, step.cmd)
        : step.cmd
      : step.run.map(displayPipeline).join("  &&  ");
  return step.stdinNote ? `${base}  < (${step.stdinNote})` : base;
}

export type JobStatus = "running" | "ok" | "failed";
export type StepStatus = "pending" | "running" | "ok" | "failed" | "skipped" | "warn";

export type JobEvent =
  | { type: "step"; index: number; status: StepStatus; display?: string; label?: string }
  | { type: "line"; index: number; stream: "stdout" | "stderr" | "info"; text: string }
  | { type: "done"; status: JobStatus };

interface JobStep {
  label: string;
  display: string;
  status: StepStatus;
  lines: { stream: "stdout" | "stderr" | "info"; text: string }[];
}

const MAX_LINES_PER_STEP = 4000;

export class Job {
  readonly id = crypto.randomUUID().slice(0, 8);
  readonly startedAt = Date.now();
  endedAt?: number;
  status: JobStatus = "running";
  steps: JobStep[] = [];
  private subs = new Set<(e: JobEvent) => void>();

  constructor(
    readonly title: string,
    readonly pi?: PiCfg,
  ) {}

  subscribe(fn: (e: JobEvent) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private emit(e: JobEvent) {
    for (const fn of this.subs) fn(e);
  }

  /** Add a step whose command is known up front (so the UI can list the whole plan). */
  plan(label: string, display: string): number {
    this.steps.push({ label, display, status: "pending", lines: [] });
    const index = this.steps.length - 1;
    this.emit({ type: "step", index, status: "pending", display, label });
    return index;
  }

  setStep(index: number, status: StepStatus, display?: string) {
    const s = this.steps[index]!;
    s.status = status;
    if (display) s.display = display;
    this.emit({ type: "step", index, status, display: s.display, label: s.label });
  }

  log(index: number, text: string, stream: "stdout" | "stderr" | "info" = "info") {
    const s = this.steps[index];
    if (!s) return;
    if (s.lines.length < MAX_LINES_PER_STEP) s.lines.push({ stream, text });
    else if (s.lines.length === MAX_LINES_PER_STEP) s.lines.push({ stream: "info", text: "… (output truncated in Gaia's buffer)" });
    this.emit({ type: "line", index, stream, text });
  }

  finish(status: JobStatus) {
    this.status = status;
    this.endedAt = Date.now();
    this.emit({ type: "done", status });
    this.subs.clear();
  }

  /** Execute a Step (planning it if `index` is not given). Throws StepFailed on non-zero exit. */
  async run(step: Step, index?: number): Promise<RunResult> {
    const i = index ?? this.plan(step.label, displayStep(step, this.pi));
    // Re-render once we know which address actually answered.
    if (step.where === "remote" && this.pi) {
      try {
        await target(this.pi);
      } catch (e) {
        this.setStep(i, "failed");
        this.log(i, (e as Error).message, "stderr");
        throw new StepFailed(step.label, 255);
      }
    }
    this.setStep(i, "running", displayStep(step, this.pi));
    const opts = {
      stdin: step.stdin,
      timeoutMs: step.timeoutMs,
      onLine: (line: string, stream: "stdout" | "stderr") => this.log(i, line, stream),
    };
    if (step.where === "remote" && !this.pi) throw new Error(`remote step "${step.label}" without a Pi`);
    const res = step.where === "remote" ? await runRemote(this.pi!, step.cmd, opts) : await runPipelines(step.run, opts);
    if (res.code !== 0 && !step.allowFail) {
      this.setStep(i, "failed");
      this.log(i, `exit code ${res.code}`, "info");
      throw new StepFailed(step.label, res.code);
    }
    // allowFail steps that fail are expected outcomes ("no cached image yet"), not errors.
    this.setStep(i, res.code === 0 ? "ok" : "warn");
    if (res.code !== 0) this.log(i, `exit code ${res.code} (expected; continuing)`, "info");
    return res;
  }
}

export class StepFailed extends Error {
  constructor(
    readonly step: string,
    readonly code: number,
  ) {
    super(`${step} failed (exit ${code})`);
  }
}

const jobs: Job[] = [];
const MAX_JOBS = 60;
const busyPis = new Map<string, Job>();

export function listJobs(): Job[] {
  return jobs;
}

export function getJob(id: string): Job | undefined {
  return jobs.find((j) => j.id === id);
}

export function busyJob(piId: string): Job | undefined {
  return busyPis.get(piId);
}

type JobListener = (job: Job) => void;
const finishListeners = new Set<JobListener>();
export function onJobFinished(fn: JobListener) {
  finishListeners.add(fn);
}

/**
 * Start a job in the background. `exclusive` Pis get a lock, so two mutating actions can't
 * race on the same Pi (e.g. Stop while a Deploy is still loading images).
 */
export function startJob(
  title: string,
  body: (job: Job) => Promise<void>,
  opts: { pi?: PiCfg; exclusive?: PiCfg[] } = {},
): Job {
  const job = new Job(title, opts.pi);
  for (const p of opts.exclusive ?? []) {
    const busy = busyPis.get(p.id);
    if (busy) throw new Error(`${p.name} is busy with "${busy.title}" — wait for it to finish.`);
  }
  for (const p of opts.exclusive ?? []) busyPis.set(p.id, job);
  jobs.unshift(job);
  if (jobs.length > MAX_JOBS) jobs.length = MAX_JOBS;
  queueMicrotask(async () => {
    try {
      await body(job);
      job.finish("ok");
    } catch (e) {
      if (!(e instanceof StepFailed)) {
        const i = job.steps.length ? job.steps.length - 1 : job.plan("Gaia", "(internal)");
        job.log(i, String((e as Error)?.stack ?? e), "stderr");
      }
      job.finish("failed");
    } finally {
      for (const p of opts.exclusive ?? []) if (busyPis.get(p.id) === job) busyPis.delete(p.id);
      for (const fn of finishListeners) fn(job);
    }
  });
  return job;
}
