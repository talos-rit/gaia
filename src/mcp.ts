/**
 * MCP server for agents, served by the running Gaia at POST /mcp (Streamable HTTP, stateless).
 *
 * Every tool goes through the same code as the web UI (src/core/ops.ts): the same jobs, the same
 * per-Pi locks, and every command shows up in the Activity drawer. Mutating tools wait for their
 * job and then re-poll the Pi, so the agent sees the outcome without a second call.
 *
 * A fresh McpServer is built per request, so the schemas (Pi ids, component lists) always match
 * the current gaia.config.yaml + gaia.local.yaml.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ACTIONS, getAction } from "./core/actions.ts";
import {
  COMMANDER_ACTIONS,
  commanderConfigFiles,
  commanderStatus,
  fetchBranches,
  invalidateCommanderStatus,
  isCloned,
  listBranches,
  LOG_FILE,
  PREV_LOG_FILE,
  switchSteps,
  type CommanderAction,
  type CommanderStatus,
} from "./core/commander.ts";
import {
  COMPONENT_LABEL,
  COMPONENTS,
  ROOT,
  clearLocalSource,
  describeSource,
  getPi,
  loadConfig,
  localOverrideFor,
  saveLocalSource,
  sharedSource,
  type ComponentId,
  type Config,
  type PiCfg,
} from "./core/config.ts";
import { resolveSource, stackFiles } from "./core/deploy.ts";
import { busyJob, getJob, listJobs, startJob, type Job } from "./core/jobs.ts";
import { ensureHelper, grabSnapshot, jobDone, launch, launchCommander, launchDeploy, logsCommand } from "./core/ops.ts";
import { proc } from "./core/pipeline.ts";
import { knownAddress, runArgv, runRemote } from "./core/ssh.ts";
import { rtspUrl, type Images } from "./core/stack.ts";
import { componentHealth, containerFor, fmtAge, getState, hostHealth, piLevel, pollNow, type PiState } from "./core/status.ts";

type Text = { type: "text"; text: string };
type Image = { type: "image"; data: string; mimeType: string };
type Result = { content: (Text | Image)[]; isError?: boolean };

const text = (t: string, isError = false): Result => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
const fail = (t: string) => text(t, true);
const json = (v: unknown) => JSON.stringify(v, null, 2);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const enumOf = <T extends string>(values: readonly T[]) => z.enum(values as unknown as [T, ...T[]]);

const STACK_SERVICES = "operator (Operator: arm control), camera (Cam Streamer: ffmpeg → RTSP), mediamtx (MediaMTX: RTSP server), vision (Pi-Vision: pose inference)";

// ---- jobs ---------------------------------------------------------------------------------

const MAX_LINE = 400;
const MAX_FULL_CHARS = 120_000;

function fmtSecs(s: number) {
  return s < 90 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/** Plain-text job report: each step's status and command, plus the tail of its output (more for failures). */
function renderJob(job: Job, output: "summary" | "full" = "summary"): string {
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const out = [
    `Job ${job.id} "${job.title}": ${job.status === "running" ? `STILL RUNNING (${fmtSecs(elapsed)} so far)` : `${job.status.toUpperCase()} after ${fmtSecs(elapsed)}`}`,
  ];
  let chars = 0;
  for (const [i, s] of job.steps.entries()) {
    out.push(`${i + 1}. [${s.status}] ${s.label}`);
    if (s.status === "pending" || s.status === "skipped") continue;
    out.push(`   $ ${s.display}`);
    const n = output === "full" ? Infinity : { failed: 80, running: 20, warn: 12 }[s.status as string] ?? 3;
    const shown = s.lines.slice(-n);
    if (shown.length < s.lines.length) out.push(`   … ${s.lines.length - shown.length} earlier lines (get_job output="full" shows them)`);
    for (const l of shown) {
      const line = `   | ${l.text.length > MAX_LINE ? l.text.slice(0, MAX_LINE) + " …" : l.text}`;
      chars += line.length;
      if (output === "full" && chars > MAX_FULL_CHARS) {
        out.push("   … output cut off here (too long to return)");
        return out.join("\n");
      }
      out.push(line);
    }
  }
  if (job.status === "running") out.push(`\nThe job keeps running inside Gaia. Call get_job with job_id="${job.id}" and wait_seconds to wait for it.`);
  return out.join("\n");
}

/** Wait until every job is done or `seconds` pass. */
async function waitJobs(jobs: Job[], seconds: number) {
  await Promise.race([Promise.all(jobs.map(jobDone)), sleep(seconds * 1000)]);
}

// ---- status -------------------------------------------------------------------------------

/** compact: for the status appended after an action (no arm config or host stats). */
function piStatus(cfg: Config, pi: PiCfg, st: PiState, detail: "summary" | "full" | "compact" = "summary") {
  const d = st.data;
  const host = hostHealth(cfg, pi, st);
  const manifest = d?.stack.manifest;
  const busy = busyJob(pi.id);
  const services = Object.fromEntries(
    COMPONENTS.map((c) => {
      const h = componentHealth(cfg, pi, st, c);
      const ctr = containerFor(cfg, d, c);
      const m = manifest?.components[c];
      return [
        c,
        {
          level: h.level,
          summary: h.summary,
          ...(h.details.filter(Boolean).length ? { details: h.details.filter(Boolean) } : {}),
          container: ctr ? `${ctr.state} (${ctr.status})` : "none",
          ...(m ? { deployed: `${m.source}${m.revision ? ` @ ${m.revision.slice(0, 10)}` : ""}${m.dirty ? " (dirty working copy)" : ""}` } : {}),
          ...(ctr?.state === "running" && m?.image && ctr.image !== m.image ? { warning: `running ${ctr.image}, not the deployed ${m.image}: Deploy (or start) to switch` } : {}),
        },
      ];
    }),
  );
  return {
    id: pi.id,
    name: pi.name,
    address: knownAddress(pi),
    overall: piLevel(cfg, pi, st),
    reachable: st.reachable,
    ...(st.at ? { polled: `${fmtAge((Date.now() - st.at) / 1000)} ago` } : {}),
    ...(st.error ? { last_poll_error: st.error } : {}),
    ...(busy ? { busy_with: { job_id: busy.id, title: busy.title } } : {}),
    ...(detail === "compact" ? {} : { arm: { controller: pi.arm.controller, operator_profile: pi.arm.operatorProfile, homes_on_start: pi.arm.homesOnStart, operator_port: pi.arm.operatorPort, vision_port: pi.arm.visionPort, rtsp: rtspUrl(pi, pi.host) } }),
    host: {
      level: host.level,
      summary: host.summary,
      ...(host.details.length > 1 ? { issues: host.details } : {}),
      ...(d && detail !== "compact"
        ? {
            stats: `${d.host.hostname}, up ${fmtAge(d.host.uptime_s)}, load ${d.host.load}, ${d.host.temp_c ?? "?"}°C, throttled ${d.host.throttled ?? "n/a"}, ` +
              `${d.host.mem_avail_mb}/${d.host.mem_total_mb} MB free, ${d.host.disk_free_gb} GB disk free`,
          }
        : {}),
    },
    // Without a single poll's data every service would just say "Pi unreachable".
    services: d ? services : "unknown: no data from this Pi yet",
    ...(manifest ? { last_deploy: `${manifest.deployedAt} by ${manifest.deployedBy}` } : d ? { last_deploy: "never (nothing deployed yet)" } : {}),
    ...(detail === "full" ? { raw_probe: st } : {}),
  };
}

function commanderSummary(cfg: Config, s: CommanderStatus) {
  return {
    checkout: s.cloned ? cfg.commander.path : `none at ${cfg.commander.path} (use commander operation="setup")`,
    ...(s.git ? { git: `${s.git.branch} @ ${s.git.short}${s.git.dirty ? `, ${s.git.dirty} uncommitted change(s)` : ""}${s.git.behind ? `, ${s.git.behind} behind ${s.git.upstream}` : ""}${s.git.ahead ? `, ${s.git.ahead} ahead` : ""}` } : {}),
    process: s.proc ? `running (pid ${s.proc.pid}, started ${fmtAge((Date.now() - s.proc.startedAt) / 1000)} ago on ${s.proc.branch ?? "?"} @ ${s.proc.sha?.slice(0, 7) ?? "?"})` : "not running",
    health: s.health,
    url: s.addr.url,
    ...(s.build ? { web_ui_built_from: s.build.sha ? `${s.build.sha.slice(0, 7)}${s.build.dirty ? " (dirty)" : ""}` : "unknown (built outside Gaia)" } : s.cloned ? { web_ui_built_from: "not built" } : {}),
    ...(s.lastExit ? { last_exit: `exited with code ${s.lastExit.code} ${fmtAge((Date.now() - s.lastExit.at) / 1000)} ago without being stopped (see commander_logs)` } : {}),
    ...(s.uv ? {} : { problem: "uv is not installed on this machine" }),
  };
}

let localEnvCache: { at: number; value: Record<string, unknown> } | undefined;
async function localEnv() {
  if (localEnvCache && Date.now() - localEnvCache.at < 10_000) return localEnvCache.value;
  const missing = ["ssh", "git", "docker"].filter((t) => !Bun.which(t));
  let docker = "not installed";
  if (Bun.which("docker")) {
    const r = await runArgv(["docker", "info", "--format", "{{.ServerVersion}} {{.Architecture}}"], { timeoutMs: 4000 });
    docker = r.code === 0 ? `up (${r.stdout.trim()})` : `DOWN: deploy needs it${Bun.which("colima") ? " (start_local_docker starts Colima)" : " (start Docker Desktop)"}`;
  }
  const value = { docker, ...(missing.length ? { missing_programs: missing } : {}) };
  localEnvCache = { at: Date.now(), value };
  return value;
}

function sourcesSummary(cfg: Config) {
  return Object.fromEntries(COMPONENTS.map((c) => [c, `${describeSource(cfg.components[c].source)}${localOverrideFor(c) ? " (gaia.local.yaml override)" : ""}`]));
}

/** Re-poll these Pis (so the answer reflects what the job just did) and summarise them. */
async function freshStatus(cfg: Config, pis: PiCfg[]) {
  const states = await Promise.all(pis.map((pi) => pollNow(cfg, pi)));
  return pis.map((pi, i) => piStatus(cfg, pi, states[i]!, "compact"));
}

// ---- the server -----------------------------------------------------------------------------

const INSTRUCTIONS = `Gaia manages the Talos robot-arm stack: Raspberry Pis (each running four containers: ${STACK_SERVICES}) plus Commander, which runs on this computer.

How to work with it:
- Start with \`status\`. It shows every Pi's services, host health, what's deployed, any running job, Commander and local Docker.
- Tools that change something start a job: the same job the Gaia web UI would run, shown live in its Activity drawer. They wait up to wait_seconds, then report each step's command and output, and re-poll the Pi so you see the result. If a job is still running when the wait ends, it carries on inside Gaia: use get_job to wait for it. Don't start it again.
- Each Pi runs one mutating job at a time. A "busy" error names the running job; wait for it with get_job.
- Code changes reach a Pi only through \`deploy\`. Restarting runs the image that's already deployed. To deploy a working copy: set_source(component, mode="local") once (it's saved in gaia.local.yaml), then deploy. Builds are cached, so deploying again only rebuilds what changed.
- Starting or restarting Operator on an arm with homes_on_start (and a deploy with start=true that recreates Operator) homes that arm. That's expected and harmless: no confirmation needed.
- Powering off or rebooting a Pi needs the user's assent, but informal or contextual assent is enough. See the \`power\` tool.
- For anything the dedicated tools don't cover, \`pi_exec\` runs a shell command on a Pi (\`talos help\` lists the Pi-side helper's commands).`;

function build(cfg: Config): McpServer {
  const server = new McpServer({ name: "gaia", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const piIds = cfg.pis.map((p) => p.id);
  const piEnum = piIds.length ? enumOf(piIds) : z.string();
  const piOrAll = piIds.length ? enumOf([...piIds, "all"]) : z.string();
  const service = enumOf(COMPONENTS);
  const waitArg = (dflt: number, max = 1800) =>
    z.number().int().min(0).max(max).default(dflt).describe(`Seconds to wait for the job before returning (0 = return at once). The job keeps running either way. Default ${dflt}.`);
  const pisFor = (id: string): PiCfg[] => (id === "all" ? cfg.pis : [getPi(cfg, id)!].filter(Boolean));
  const homers = cfg.pis.filter((p) => p.arm.homesOnStart).map((p) => p.name);
  const homingNote = homers.length
    ? `Starting or restarting Operator on ${homers.join(", ")} homes the arm (homes_on_start). That's expected and harmless: do it without asking.`
    : "";

  /** Launch one job per Pi, wait, then report the jobs plus fresh status for the Pis whose job finished. */
  async function runOnPis(pis: PiCfg[], start: (pi: PiCfg) => Job, wait: number, opts: { refresh?: boolean } = {}): Promise<Result> {
    const jobs: Job[] = [];
    const errors: string[] = [];
    for (const pi of pis) {
      try {
        jobs.push(start(pi));
      } catch (e) {
        errors.push(`${pi.name}: ${(e as Error).message}`);
      }
    }
    await waitJobs(jobs, wait);
    const parts = [...errors.map((e) => `NOT STARTED: ${e}`), ...jobs.map((j) => renderJob(j))];
    const done = jobs.filter((j) => j.status !== "running" && j.pi).map((j) => j.pi!);
    if (opts.refresh !== false && done.length) parts.push(`Status now:\n${json(await freshStatus(cfg, done))}`);
    const failed = errors.length > 0 || jobs.some((j) => j.status === "failed");
    return text(parts.join("\n\n"), failed);
  }

  // ---- read-only ----------------------------------------------------------------------------

  server.registerTool(
    "status",
    {
      title: "Fleet status",
      description:
        "Health of every Pi (or one), from Gaia's background poll (every 5 s): each service's level (ok/warn/bad/off/unknown), a one-line summary and details, " +
        "container state, what's deployed (source, revision, dirty), host health, and any job holding the Pi. Also Commander, local Docker, the configured build sources and config problems. " +
        "fresh=true re-polls first (1-3 s per Pi). detail=full adds the raw probe data.",
      inputSchema: {
        pi: piEnum.optional().describe("Only this Pi. Default: all Pis plus Commander and local info."),
        fresh: z.boolean().default(false).describe("Poll the Pi(s) now instead of using the last poll (at most ~5 s old)."),
        detail: z.enum(["summary", "full"]).default("summary"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pi, fresh, detail }) => {
      const pis = pi ? pisFor(pi) : cfg.pis;
      const states = fresh ? await Promise.all(pis.map((p) => pollNow(cfg, p))) : pis.map((p) => getState(p.id));
      const out: Record<string, unknown> = {};
      if (cfg.problems.length) out.config_problems = cfg.problems;
      out.pis = pis.map((p, i) => piStatus(cfg, p, states[i]!, detail));
      if (!pi) {
        out.commander = commanderSummary(cfg, await commanderStatus(cfg));
        out.local = await localEnv();
        out.sources = sourcesSummary(cfg);
        const running = listJobs().filter((j) => j.status === "running");
        if (running.length) out.running_jobs = running.map((j) => ({ job_id: j.id, title: j.title }));
      }
      return text(json(out));
    },
  );

  server.registerTool(
    "logs",
    {
      title: "Service logs",
      description:
        `Recent logs from one service's container on a Pi (docker logs; stdout and stderr together). Services: ${STACK_SERVICES}. ` +
        "source=operator_log_file reads Operator's own log file (~/talos-stack/logs/operator.log), which survives container restarts and has more detail than its container output.",
      inputSchema: {
        pi: piEnum,
        service: service.default("operator"),
        lines: z.number().int().min(1).max(5000).default(200),
        source: z.enum(["container", "operator_log_file"]).default("container"),
        since: z.string().regex(/^\d+[smhd]$|^\d{4}-\d\d-\d\dT/).optional().describe('Only lines newer than this, e.g. "10m", "2h" (container logs only). Uses the Pi\'s clock.'),
        filter: z.string().optional().describe("Keep only lines matching this case-insensitive regex (applied after taking the last `lines` lines)."),
        timestamps: z.boolean().default(false).describe("Prefix each line with Docker's timestamp (container logs only)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pi: id, service: svc, lines, source, since, filter, timestamps }) => {
      const pi = getPi(cfg, id)!;
      const file = source === "operator_log_file";
      try {
        await ensureHelper(cfg, pi);
        const cmd = logsCommand(svc, file, lines, { follow: false, since, timestamps });
        const got: string[] = [];
        const r = await runRemote(pi, cmd, { timeoutMs: 30_000, onLine: (l) => got.push(l) });
        let re: RegExp | undefined;
        if (filter) {
          try {
            re = new RegExp(filter, "i");
          } catch {
            re = new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          }
        }
        const kept = re ? got.filter((l) => re!.test(l)) : got;
        const head = `$ ssh ${pi.user}@${knownAddress(pi)} ${cmd}   (exit ${r.code}; ${kept.length}${re ? ` of ${got.length}` : ""} lines)`;
        return text(`${head}\n${kept.join("\n")}`, r.code !== 0 && got.length === 0);
      } catch (e) {
        return fail(`${pi.name}: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "snapshot",
    {
      title: "Camera snapshot",
      description: "Grab one JPEG frame from a Pi's RTSP stream (the same stream Commander and Pi-Vision read). Fails if the camera or MediaMTX isn't running.",
      inputSchema: { pi: piEnum },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ pi: id }) => {
      const pi = getPi(cfg, id)!;
      try {
        const r = await grabSnapshot(cfg, pi);
        if (!r.ok) return fail(`No frame from ${rtspUrl(pi)} on ${pi.name}: ${r.error}`);
        return { content: [{ type: "image", data: Buffer.from(r.jpeg).toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `${pi.name}: one frame from ${rtspUrl(pi)}` }] };
      } catch (e) {
        return fail(`${pi.name}: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "list_jobs",
    {
      title: "Recent jobs",
      description: "Jobs Gaia ran recently (from the UI or from agents), newest first: id, title, status and duration. Use get_job for a job's steps and output.",
      inputSchema: { limit: z.number().int().min(1).max(60).default(15), running_only: z.boolean().default(false) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, running_only }) => {
      const jobs = listJobs().filter((j) => !running_only || j.status === "running").slice(0, limit);
      if (!jobs.length) return text(running_only ? "No jobs running." : "No jobs yet.");
      return text(
        jobs
          .map((j) => `${j.id}  ${j.status.padEnd(7)}  started ${fmtAge((Date.now() - j.startedAt) / 1000)} ago, ${fmtSecs(((j.endedAt ?? Date.now()) - j.startedAt) / 1000)}  ${j.title}`)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Job details",
      description: "A job's steps, each with the exact command and its output (the tail, more for failed steps; output=full for everything). Optionally wait for a running job to finish first.",
      inputSchema: {
        job_id: z.string(),
        wait_seconds: z.number().int().min(0).max(1800).default(0).describe("Wait up to this long for the job to finish before answering."),
        output: z.enum(["summary", "full"]).default("summary"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ job_id, wait_seconds, output }) => {
      const job = getJob(job_id.trim());
      if (!job) return fail(`No job ${job_id}. Recent: ${listJobs().slice(0, 8).map((j) => `${j.id} (${j.title})`).join(", ") || "none"}`);
      await waitJobs([job], wait_seconds);
      const parts = [renderJob(job, output)];
      if (job.status !== "running" && job.pi && wait_seconds > 0) parts.push(`Status now:\n${json(await freshStatus(cfg, [job.pi]))}`);
      return text(parts.join("\n\n"), job.status === "failed");
    },
  );

  server.registerTool(
    "get_generated_files",
    {
      title: "Generated files",
      description:
        "Files Gaia generates. For a Pi: compose.yaml, operator.conf, the talos helper script and udev rules it writes to ~/talos-stack (image tags from the last deploy). " +
        "For target=commander: the config files Gaia creates in the Commander checkout when missing (it never overwrites existing ones).",
      inputSchema: { target: piIds.length ? enumOf([...piIds, "commander"]) : z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ target }) => {
      if (target === "commander")
        return text(commanderConfigFiles(cfg).map((f) => `==> ${f.name} (${f.exists ? "exists, so Gaia leaves it alone" : "missing, so Gaia will create it"})\n${f.body}`).join("\n"));
      const pi = getPi(cfg, target)!;
      const m = getState(pi.id).data?.stack.manifest;
      const images = Object.fromEntries(COMPONENTS.map((k) => [k, m?.components[k]?.image ?? `talos/${k}:<tag chosen at deploy>`])) as Images;
      return text(Object.entries(stackFiles(cfg, pi, images)).map(([n, b]) => `==> ${n}\n${b}`).join("\n"));
    },
  );

  // ---- the stack on a Pi --------------------------------------------------------------------

  server.registerTool(
    "control_stack",
    {
      title: "Start/stop/restart services",
      description:
        `Start, stop or restart the containers on a Pi (or on every Pi with pi="all"): the whole stack, or one service. Services: ${STACK_SERVICES}. ` +
        "start runs a preflight (devices present, nothing else holding them) when starting the whole stack. restart runs the image already deployed: use deploy to ship new code. " +
        'operation="down" removes the containers (images and logs stay; start recreates them). ' +
        `${homingNote} Waits for the job, then returns its output and the Pi's fresh status.`,
      inputSchema: {
        pi: piOrAll,
        operation: z.enum(["start", "stop", "restart", "down"]),
        service: service.optional().describe("Just this service. Omit for the whole stack. Not allowed with down."),
        wait_seconds: waitArg(120),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ pi, operation, service: svc, wait_seconds }) => {
      if (svc && operation === "down") return fail('down always removes the whole stack; to stop one service use operation="stop" with service.');
      const action = svc ? `svc-${operation}` : operation;
      return runOnPis(pisFor(pi), (p) => launch(cfg, p, action, svc), wait_seconds);
    },
  );

  server.registerTool(
    "power",
    {
      title: "Power off or reboot a Pi",
      description:
        "poweroff: stop the containers cleanly, then shut the Pi down. It stays off until someone physically unplugs and replugs its power, so nothing on it can be reached remotely afterwards. " +
        "reboot: restart the Pi; MediaMTX, the camera and Pi-Vision come back by themselves, Operator stays stopped until started (control_stack). " +
        "USER ASSENT: only power off or reboot when the user wants it. Informal or contextual assent is enough: the user asked for it, said they're done for the day, " +
        "or a reboot is clearly part of a fix they asked you to carry out. If you have that, go ahead without asking again (also for further reboots in the same task). " +
        "If you don't, ask once.",
      inputSchema: { pi: piOrAll, operation: z.enum(["poweroff", "reboot"]) },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ pi, operation }) => {
      const res = await runOnPis(pisFor(pi), (p) => launch(cfg, p, operation), 60, { refresh: false });
      const after =
        operation === "reboot"
          ? "\n\nThe Pi takes about a minute to come back; status shows it reachable again once it's up. Operator needs control_stack start after the reboot."
          : "\n\nShut down. Tell the user to wait for the green ACT LED to stop flickering (~10 s) before unplugging.";
      return { ...res, content: [{ type: "text", text: (res.content[0] as Text).text + after }] };
    },
  );

  const troubleshootActions = ACTIONS.filter((a) => a.scope === "troubleshoot" && a.id !== "reboot");
  server.registerTool(
    "troubleshoot",
    {
      title: "Troubleshooting actions",
      description:
        "Gaia's Troubleshoot menu. Actions:\n" +
        troubleshootActions.map((a) => `- ${a.id}: ${a.label}. ${a.description}${a.applies ? " (not on every Pi)" : ""}`).join("\n") +
        "\nunique-identity reboots the Pi, so it needs user assent like the power tool.",
      inputSchema: { pi: piEnum, action: enumOf(troubleshootActions.map((a) => a.id)), wait_seconds: waitArg(300) },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ pi: id, action, wait_seconds }) => {
      const pi = getPi(cfg, id)!;
      const a = getAction(action)!;
      if (a.applies && !a.applies(pi, cfg)) return fail(`${a.label} doesn't apply to ${pi.name} (${a.description})`);
      return runOnPis([pi], (p) => launch(cfg, p, action), wait_seconds, { refresh: !["unique-identity"].includes(action) });
    },
  );

  server.registerTool(
    "pi_exec",
    {
      title: "Run a shell command on a Pi",
      description:
        "Run a non-interactive bash command on a Pi over SSH, for inspection the other tools don't cover (talos ps, talos docker inspect <c>, journalctl, ls /dev, cat a file). " +
        "It's recorded as a job in Gaia's Activity drawer. `talos help` lists the Pi-side helper's commands; sudo -n works. " +
        "Prefer the dedicated tools for anything they do (control_stack, deploy, logs, troubleshoot, power): they keep Gaia's locks and status in step. " +
        "Don't run commands that never end (e.g. logs -f); they're killed at timeout_seconds.",
      inputSchema: { pi: piEnum, command: z.string().min(1), timeout_seconds: z.number().int().min(1).max(600).default(60) },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ pi: id, command, timeout_seconds }) => {
      const pi = getPi(cfg, id)!;
      let res: { code: number; stdout: string; stderr: string } | undefined;
      const job = startJob(`${pi.name}: agent command`, async (j) => {
        res = await j.run({ label: "Agent command", where: "remote", cmd: command, timeoutMs: timeout_seconds * 1000, allowFail: true });
      }, { pi });
      await jobDone(job);
      if (!res) return fail(renderJob(job, "full"));
      const cap = (s: string) => (s.length > 60_000 ? `… (${s.length - 60_000} earlier characters cut)\n` + s.slice(-60_000) : s);
      const parts = [`exit ${res.code}${res.code === 124 ? " (timed out)" : ""}`];
      if (res.stdout.trim()) parts.push(`stdout:\n${cap(res.stdout.trimEnd())}`);
      if (res.stderr.trim()) parts.push(`stderr:\n${cap(res.stderr.trimEnd())}`);
      return text(parts.join("\n"), res.code !== 0);
    },
  );

  // ---- deploy & sources -----------------------------------------------------------------------

  server.registerTool(
    "deploy",
    {
      title: "Build and deploy",
      description:
        "Build all four arm64 images on this computer from the configured sources, copy them to the Pi(s) over SSH (only layers the Pi lacks), write compose.yaml, validate it, " +
        "and with start=true bring the stack up (only containers whose image or config changed are recreated). Builds are cached by their inputs, so unchanged components cost nothing. " +
        `Current sources: ${Object.entries(sourcesSummary(cfg)).map(([c, s]) => `${c} = ${s}`).join("; ")}. Change them with set_source first. ` +
        "build_only=true builds without touching any Pi (a quick way to check a working copy compiles and passes Operator's tests). " +
        `${homers.length ? `With start=true a recreated Operator homes ${homers.join(", ")}'s arm: harmless, no need to ask. ` : ""}` +
        "Needs local Docker (status shows it). A first build can take several minutes; the job keeps running if the wait ends first.",
      inputSchema: {
        pis: z.array(piEnum).optional().describe("Pis to deploy to. Default: all of them. Ignored with build_only."),
        start: z.boolean().default(true).describe("Start the stack after deploying. false = only stage the images and files."),
        force: z.boolean().default(false).describe("Rebuild even when an image with identical inputs exists."),
        build_only: z.boolean().default(false),
        wait_seconds: waitArg(900),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ pis, start, force, build_only, wait_seconds }) => {
      const targets = pis?.length ? [...new Set(pis)].map((id) => getPi(cfg, id)!).filter(Boolean) : cfg.pis;
      let job: Job;
      try {
        job = launchDeploy(cfg, { pis: targets, start, force, buildOnly: build_only });
      } catch (e) {
        return fail((e as Error).message);
      }
      await waitJobs([job], wait_seconds);
      const parts = [renderJob(job)];
      if (job.status !== "running" && !build_only) parts.push(`Status now:\n${json(await freshStatus(cfg, targets))}`);
      return text(parts.join("\n\n"), job.status === "failed");
    },
  );

  server.registerTool(
    "sources",
    {
      title: "Build sources",
      description:
        "Where deploy builds each image from: a pinned git ref (fresh fetch, local changes can't sneak in), a working copy on this machine (tracked + untracked files minus .gitignore'd), " +
        "or built into Gaia. Shows the effective source, the shared default from gaia.config.yaml, whether gaia.local.yaml overrides it, and what it resolves to right now (commit, uncommitted changes).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const resolved = await Promise.all(COMPONENTS.map((c) => resolveSource(cfg, c)));
      const out = Object.fromEntries(
        COMPONENTS.map((c, i) => {
          const shared = sharedSource(c);
          return [
            c,
            {
              label: COMPONENT_LABEL[c],
              source: cfg.components[c].source,
              resolves_to: resolved[i]!.text,
              ...(localOverrideFor(c) ? { overridden_in_gaia_local_yaml: true, shared_default: shared ? describeSource(shared) : "?" } : {}),
            },
          ];
        }),
      );
      return text(json(out));
    },
  );

  const editable = COMPONENTS.filter((c) => c !== "mediamtx");
  server.registerTool(
    "set_source",
    {
      title: "Change a build source",
      description:
        "Choose where deploy builds a component from. Saved to the git-ignored gaia.local.yaml (personal, not the team's gaia.config.yaml), the same as the Sources panel. " +
        "It takes effect on the next deploy; nothing running changes. " +
        'mode="local": build from a working copy on this machine (path defaults to ../<repo name>, e.g. ../operator). ' +
        'mode="git": a branch, tag or commit from a remote (repo defaults to the current/shared repo, so usually just pass ref). ' +
        'mode="default": drop the override and use gaia.config.yaml\'s source again. MediaMTX is built into Gaia and can\'t be changed.',
      inputSchema: {
        component: enumOf(editable),
        mode: z.enum(["local", "git", "default"]),
        path: z.string().optional().describe("mode=local: path to the working copy, relative to the Gaia checkout (or absolute)."),
        repo: z.string().optional().describe("mode=git: repository URL."),
        ref: z.string().optional().describe("mode=git: branch, tag or commit (required)."),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ component: c, mode, path, repo, ref }) => {
      const shared = sharedSource(c);
      const current = cfg.components[c].source;
      if (mode === "default") clearLocalSource(c);
      else if (mode === "local") {
        const gitRepo = shared?.mode === "git" ? shared.repo : current.mode === "git" ? current.repo : undefined;
        const p = path?.trim() || (shared?.mode === "local" ? shared.path : gitRepo ? `../${gitRepo.replace(/\/+$/, "").split("/").pop()!.replace(/\.git$/, "")}` : "");
        if (!p) return fail("Pass path: there's no default working copy location for this component.");
        if (!existsSync(resolve(ROOT, p))) return fail(`${resolve(ROOT, p)} doesn't exist. Pass path (relative to ${ROOT}).`);
        saveLocalSource(c, { mode: "local", path: p });
      } else {
        if (!ref?.trim()) return fail("mode=git needs ref (a branch, tag or commit).");
        const r = repo?.trim() || (current.mode === "git" ? current.repo : shared?.mode === "git" ? shared.repo : "");
        if (!r) return fail("Pass repo: there's no default repository for this component.");
        saveLocalSource(c, { mode: "git", repo: r, ref: ref.trim() });
      }
      const next = loadConfig();
      const res = await resolveSource(next, c);
      return text(
        `${COMPONENT_LABEL[c]} now builds from ${describeSource(next.components[c].source)}${localOverrideFor(c) ? " (gaia.local.yaml)" : " (shared default)"}.\n` +
          `Resolves to: ${res.text}\nRun deploy to ship it.`,
        !res.ok,
      );
    },
  );

  server.registerTool(
    "start_local_docker",
    {
      title: "Start local Docker (Colima)",
      description: "Run `colima start` on this computer, for when status says local Docker is down. Deploy needs it. Only on machines with Colima; otherwise ask the user to start Docker Desktop.",
      inputSchema: { wait_seconds: waitArg(300, 600) },
      annotations: { openWorldHint: false },
    },
    async ({ wait_seconds }) => {
      if (!Bun.which("colima")) return fail("Colima isn't installed here. Ask the user to start Docker Desktop.");
      const job = startJob("Start Colima (local Docker)", async (j) => {
        await j.run({ label: "colima start", where: "local", run: [[proc("colima", "start")]], timeoutMs: 300_000 });
        localEnvCache = undefined;
      });
      await waitJobs([job], wait_seconds);
      return text(renderJob(job), job.status === "failed");
    },
  );

  // ---- Commander ------------------------------------------------------------------------------

  const commanderAfter = async (job: Job, wait: number): Promise<Result> => {
    await waitJobs([job], wait);
    invalidateCommanderStatus();
    const parts = [renderJob(job)];
    if (job.status !== "running") parts.push(`Commander now:\n${json(commanderSummary(cfg, await commanderStatus(cfg)))}`);
    return text(parts.join("\n\n"), job.status === "failed");
  };

  server.registerTool(
    "commander",
    {
      title: "Manage Commander",
      description:
        `Commander runs on this computer (checkout at ${cfg.commander.path}, not in Docker). Operations:\n` +
        (Object.entries(COMMANDER_ACTIONS) as [CommanderAction, { label: string; description: string }][]).map(([id, a]) => `- ${id}: ${a.description}`).join("\n") +
        "\nbuild is what picks up code changes; restart reuses the last build. setup only works when there's no checkout yet; the others need one. " +
        "Gaia creates Commander's config/*.local.yaml files only when they're missing, never overwriting them.",
      inputSchema: { operation: enumOf(Object.keys(COMMANDER_ACTIONS) as CommanderAction[]), wait_seconds: waitArg(600) },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ operation, wait_seconds }) => {
      if (operation === "setup" ? isCloned(cfg) : !isCloned(cfg))
        return fail(operation === "setup" ? `${cfg.commander.path} is already a git checkout; use build.` : `No Commander checkout at ${cfg.commander.path}; use setup.`);
      try {
        return await commanderAfter(launchCommander(COMMANDER_ACTIONS[operation].label, COMMANDER_ACTIONS[operation].steps(cfg)), wait_seconds);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "commander_branches",
    {
      title: "Commander branches",
      description: "List the Commander checkout's local and origin branches, and which one is checked out. fetch=true runs git fetch --prune first.",
      inputSchema: { fetch: z.boolean().default(false) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fetch }) => {
      if (!isCloned(cfg)) return fail(`No Commander checkout at ${cfg.commander.path}; use commander operation="setup".`);
      let note = "";
      if (fetch) {
        const r = await fetchBranches(cfg);
        note = r.code === 0 ? "fetched origin\n" : `git fetch failed: ${(r.stderr || r.stdout).trim()}\n`;
        invalidateCommanderStatus();
      }
      const [branches, st] = await Promise.all([listBranches(cfg), commanderStatus(cfg)]);
      return text(note + `current: ${st.git?.branch ?? "?"}\n` + branches.map((b) => `${b.name === st.git?.branch ? "* " : "  "}${b.name}${b.remoteOnly ? "  (origin only)" : ""}`).join("\n"));
    },
  );

  server.registerTool(
    "commander_switch_branch",
    {
      title: "Switch Commander's branch",
      description:
        "git fetch, git switch <branch>, git pull --ff-only in the Commander checkout, then (rebuild=true, the default) build and restart commander-web so the new code runs. " +
        "git refuses the switch if uncommitted changes would be overwritten; nothing is stashed or discarded.",
      inputSchema: { branch: z.string().min(1), rebuild: z.boolean().default(true), wait_seconds: waitArg(600) },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ branch, rebuild, wait_seconds }) => {
      if (!isCloned(cfg)) return fail(`No Commander checkout at ${cfg.commander.path}; use commander operation="setup".`);
      let known = await listBranches(cfg);
      if (!known.some((b) => b.name === branch)) {
        await fetchBranches(cfg);
        known = await listBranches(cfg);
      }
      if (!known.some((b) => b.name === branch)) return fail(`No branch "${branch}" locally or on origin. Branches: ${known.map((b) => b.name).join(", ")}`);
      try {
        return await commanderAfter(launchCommander(`switch to ${branch}`, switchSteps(cfg, branch, rebuild)), wait_seconds);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "commander_logs",
    {
      title: "Commander output",
      description: "The last lines of commander-web's output (.cache/commander/commander.log). previous=true reads the run before the current one, e.g. to see why it crashed before a restart.",
      inputSchema: { lines: z.number().int().min(1).max(5000).default(200), previous: z.boolean().default(false), filter: z.string().optional().describe("Case-insensitive regex.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ lines, previous, filter }) => {
      const file = previous ? PREV_LOG_FILE : LOG_FILE;
      if (!existsSync(file)) return fail(previous ? "No previous run's output." : "No output yet: Commander hasn't been started by Gaia.");
      let all = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines);
      if (filter) {
        let re: RegExp;
        try {
          re = new RegExp(filter, "i");
        } catch {
          re = new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        }
        all = all.filter((l) => re.test(l));
      }
      return text(all.join("\n") || "(no matching lines)");
    },
  );

  return server;
}

/** Mount the MCP endpoint at /mcp. Stateless: each request gets its own server, built from the current config. */
export function mountMcp(app: Hono, loadCfg: () => Config) {
  app.all("/mcp", async (c) => {
    const server = build(loadCfg());
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
}
