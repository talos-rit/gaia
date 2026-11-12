/**
 * Operations shared by the web UI and the MCP server: both launch the same jobs, take the same
 * locks and show up in the same Activity drawer.
 */
import { getAction } from "./actions.ts";
import { COMMANDER_LOCK, invalidateCommanderStatus } from "./commander.ts";
import { COMPONENT_LABEL, type ComponentId, type Config, type PiCfg } from "./config.ts";
import { deploy } from "./deploy.ts";
import { helperHash, installHelperStep, talos } from "./helper.ts";
import { busyJob, displayStep, runPlanned, startJob, type Job, type Lockable, type Step } from "./jobs.ts";
import { sshOpts, target } from "./ssh.ts";
import { getState } from "./status.ts";

// ---- talos helper on the Pi ---------------------------------------------------------------

const helperInstalled = new Map<string, string>(); // pi id -> hash we installed this session

export function helperCurrent(cfg: Config, pi: PiCfg): boolean {
  const want = helperHash(cfg, pi);
  const st = getState(pi.id).data?.stack;
  return helperInstalled.get(pi.id) === want || (st?.helper_sha === want && !!st.helper_linked);
}

/** Resolves when the job has finished (immediately if it already has). */
export function jobDone(job: Job): Promise<void> {
  return new Promise<void>((r) => (job.status !== "running" ? r() : job.subscribe((e) => e.type === "done" && r())));
}

/** For things that run `talos …` outside a job (logs, snapshot): install the helper first if needed, as a visible job. */
export async function ensureHelper(cfg: Config, pi: PiCfg) {
  if (helperCurrent(cfg, pi)) return;
  const job = startJob(`${pi.name}: install the talos helper`, async (j) => void (await j.run(installHelperStep(cfg, pi))), { pi });
  await jobDone(job);
  if (job.status === "ok") helperInstalled.set(pi.id, helperHash(cfg, pi));
}

/** `startJob` with a lock error that names the job holding the lock. */
function start(title: string, body: (job: Job) => Promise<void>, opts: { pi?: PiCfg; exclusive?: Lockable[] }): Job {
  try {
    return startJob(title, body, opts);
  } catch (e) {
    const holder = opts.exclusive?.map((p) => busyJob(p.id)).find(Boolean);
    throw new Error(holder ? `${(e as Error).message} (job ${holder.id})` : (e as Error).message);
  }
}

// ---- actions --------------------------------------------------------------------------------

/** Run an action from actions.ts on a Pi. Throws for an unknown action or a busy Pi. */
export function launch(cfg: Config, pi: PiCfg, actionId: string, service?: ComponentId): Job {
  const action = getAction(actionId);
  if (!action) throw new Error(`unknown action ${actionId}`);
  const title = `${pi.name}: ${action.label}${service ? ` ${COMPONENT_LABEL[service]}` : ""}`;
  const exclusive = action.scope === "troubleshoot" && !action.confirm ? [] : [pi];
  if (action.run) return start(title, (j) => action.run!(j, cfg, pi), { pi, exclusive });
  // Actions are `talos <command>` calls; add a step that installs/updates the helper when the Pi lacks the current one.
  const usesHelper = action.steps(cfg, pi, service).some((s) => s.where === "remote" && s.cmd.startsWith("talos "));
  const helperStep = installHelperStep(cfg, pi);
  const steps = [...(usesHelper && !helperCurrent(cfg, pi) ? [helperStep] : []), ...action.steps(cfg, pi, service)];
  return start(
    title,
    async (j) => {
      const idx = steps.map((s) => j.plan(s.label, displayStep(s, pi)));
      for (let i = 0; i < steps.length; i++) {
        try {
          await j.run(steps[i]!, idx[i]);
        } catch (e) {
          for (const k of idx.slice(i + 1)) j.setStep(k, "skipped");
          throw e;
        }
        if (steps[i]!.label === helperStep.label) helperInstalled.set(pi.id, helperHash(cfg, pi));
      }
    },
    { pi, exclusive },
  );
}

export interface DeployRequest {
  pis: PiCfg[];
  start: boolean;
  force: boolean;
  /** Build the images only; no Pi is touched. */
  buildOnly: boolean;
}

export function launchDeploy(cfg: Config, req: DeployRequest): Job {
  if (!req.pis.length && !req.buildOnly) throw new Error("Select at least one Pi to deploy to.");
  if (cfg.problems.length) throw new Error(`Fix config problems first: ${cfg.problems.join("; ")}`);
  const targets = req.buildOnly ? [] : req.pis;
  const title = req.buildOnly ? "Build images (no deploy)" : `Deploy → ${targets.map((p) => p.name).join(", ")}`;
  return start(title, (j) => deploy(j, cfg, targets, { start: req.start, force: req.force }), {
    pi: targets.length === 1 ? targets[0] : undefined,
    exclusive: targets,
  });
}

export function launchCommander(title: string, steps: Step[]): Job {
  invalidateCommanderStatus();
  return start(`Commander: ${title}`, (j) => runPlanned(j, steps), { exclusive: [COMMANDER_LOCK] });
}

// ---- logs and snapshots -------------------------------------------------------------------

/** `talos logs` / `talos oplog`. Following commands get a `timeout` so the remote side dies even if the SSH channel lingers. */
export function logsCommand(svc: ComponentId, file: boolean, tail: number, opts: { follow?: boolean; since?: string; timestamps?: boolean } = {}) {
  const follow = opts.follow ?? true;
  if (file) return follow ? `timeout 3600 ${talos(`oplog -n ${tail} -F`)}` : talos(`oplog -n ${tail}`);
  const extra = [opts.since ? `--since ${opts.since}` : "", opts.timestamps ? "--timestamps" : ""].filter(Boolean).join(" ");
  const args = `logs ${svc}${follow ? " -f" : ""} --tail ${tail}${extra ? ` ${extra}` : ""}`;
  return follow ? `timeout 3600 ${talos(args)}` : talos(args);
}

export const snapshotCommand = () => talos("snapshot");

/** One JPEG frame from the Pi's RTSP stream. */
export async function grabSnapshot(cfg: Config, pi: PiCfg): Promise<{ ok: true; jpeg: ArrayBuffer } | { ok: false; error: string }> {
  await ensureHelper(cfg, pi);
  const proc = Bun.spawn(["ssh", ...sshOpts(pi), await target(pi), snapshotCommand()], { stdout: "pipe", stderr: "pipe" });
  const [buf, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  if (code !== 0 || buf.byteLength === 0) return { ok: false, error: (await new Response(proc.stderr).text()).trim() || `exit ${code}` };
  return { ok: true, jpeg: buf };
}
