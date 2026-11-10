import { resolve } from "node:path";
import { COMPONENTS, type ComponentId, type Config, type PiCfg } from "./config.ts";
import { learnAddresses, runRemote, Unreachable, sq } from "./ssh.ts";
import { cameraDevice, docker, serialDevice } from "./stack.ts";

export const PROBE_PATH = resolve(import.meta.dir, "probe.py");
const PROBE = await Bun.file(PROBE_PATH).text();

const POLL_MS = 5000;
const RTSP_EVERY = 3; // ffprobe on every 3rd poll (~15 s): it takes 1-3 s and decodes video.

export interface Container {
  name: string;
  image: string;
  state: string;
  status: string;
  project?: string;
  service?: string;
  started_at?: string;
  exit_code?: number;
  health?: string | null;
  image_id?: string;
}

export interface RtspResult {
  url: string;
  how: string;
  ok: boolean;
  ms: number;
  codec?: string;
  width?: number;
  height?: number;
  fps?: string;
  packets?: number;
  keyframes?: number;
  measured_fps?: number;
  window_s?: number;
  bytes?: number;
  error?: string;
  at?: number;
  /** Pi clock when measured (compare with container start times, which are Pi clock too). */
  pi_t?: number;
}

export interface Manifest {
  deployedAt: string;
  deployedBy: string;
  gaiaVersion?: string;
  components: Record<ComponentId, { image: string; imageId?: string; source: string; revision?: string; dirty?: boolean; ref?: string }>;
}

export interface ProbeData {
  t: number;
  host: {
    hostname: string;
    kernel: string;
    uptime_s: number;
    load: number;
    temp_c: number | null;
    throttled: string | null;
    mem_avail_mb: number;
    mem_total_mb: number;
    cma_mb: number;
    disk_free_gb: number;
    ips?: string[];
    machine_id?: string;
  };
  units: Record<string, string>;
  runtime: { kind: string; up: boolean; error: string | null };
  containers?: Container[];
  devices: Record<"serial" | "camera" | "encoder", { path: string; exists: boolean; target: string | null }>;
  stack: { deployed: boolean; manifest: Manifest | null; helper_sha?: string | null; helper_linked?: boolean };
  mediamtx?: {
    api: boolean;
    error: string | null;
    paths?: { name: string; ready: boolean; tracks: string[] | null; bytes_received: number; readers: number; source: string | null }[];
  };
  operator: { listening: boolean; log: { age_s: number; tail: string[] } | null };
  vision: {
    reachable: boolean;
    error: string | null;
    status?: {
      tracking_enabled: boolean;
      state: string;
      fps: number;
      fault: string | null;
      observation_age_s: number | null;
      pose?: { available: boolean; input: unknown };
      control_owner?: string;
      operator?: { connected: boolean; host: string; port: number };
      telemetry: { received: boolean; age_s: number | null };
    };
    control?: { has_profile_field: boolean; controller_profile: string | null; owner: string | null; enabled: boolean };
    observations?: { enabled: boolean; sequence: number | null; detections: number; fps: number; inference_s: number };
  };
  rtsp?: RtspResult;
}

export interface PiState {
  reachable: boolean | null; // null = not polled yet
  error?: string;
  at?: number;
  probeMs?: number;
  data?: ProbeData;
  rtsp?: RtspResult; // last RTSP result (kept between RTSP polls)
  seqAdvancing?: boolean;
}

const states = new Map<string, PiState>();
const prevSeq = new Map<string, number>();
const wakeups = new Map<string, () => void>();

export function getState(piId: string): PiState {
  return states.get(piId) ?? { reachable: null };
}

export function probeArgs(cfg: Config, pi: PiCfg, rtsp: boolean) {
  return {
    docker: docker(pi).split(" "),
    runtime: pi.runtime,
    project: cfg.stack.project,
    serial: serialDevice(pi),
    camera: cameraDevice(pi),
    stack_dir: cfg.stack.dir,
    operator_port: pi.arm.operatorPort,
    vision_port: pi.arm.visionPort,
    rtsp_path: pi.arm.rtspPath,
    rtsp_check: rtsp,
  };
}

export function probeCommand(cfg: Config, pi: PiCfg, rtsp: boolean) {
  return `python3 - ${sq(JSON.stringify(probeArgs(cfg, pi, rtsp)))}`;
}

async function pollOnce(cfg: Config, pi: PiCfg, rtsp: boolean) {
  const t0 = Date.now();
  const prev = getState(pi.id);
  try {
    const res = await runRemote(pi, probeCommand(cfg, pi, rtsp), { stdin: PROBE, timeoutMs: 20000 });
    if (res.code !== 0) throw new Error(res.stderr.trim().split("\n").slice(-3).join(" ") || `probe exit ${res.code}`);
    const data = JSON.parse(res.stdout) as ProbeData;
    if (data.host.ips?.length) learnAddresses(pi, data.host.hostname, data.host.ips);
    const seq = data.vision.observations?.sequence ?? undefined;
    const last = prevSeq.get(pi.id);
    if (seq != null) prevSeq.set(pi.id, seq);
    states.set(pi.id, {
      reachable: true,
      at: Date.now(),
      probeMs: Date.now() - t0,
      data,
      rtsp: data.rtsp ? { ...data.rtsp, at: Date.now(), pi_t: data.t } : prev.rtsp,
      seqAdvancing: seq != null && last != null ? seq > last : undefined,
    });
  } catch (e) {
    states.set(pi.id, {
      reachable: e instanceof Unreachable ? false : (prev.reachable ?? false),
      error: (e as Error).message,
      at: Date.now(),
      data: e instanceof Unreachable ? undefined : prev.data,
      rtsp: prev.rtsp,
    });
  }
}

/** Background poll loop per Pi; `loadCfg` is re-read each cycle so config edits apply live. */
export function startPolling(loadCfg: () => Config) {
  const running = new Set<string>();
  const ensure = () => {
    for (const pi of loadCfg().pis) {
      if (running.has(pi.id)) continue;
      running.add(pi.id);
      (async () => {
        let n = 0;
        let forceRtsp = false;
        while (true) {
          const cfg = loadCfg();
          const current = cfg.pis.find((p) => p.id === pi.id);
          if (!current) break;
          await pollOnce(cfg, current, forceRtsp || n % RTSP_EVERY === 0);
          forceRtsp = false;
          n++;
          await new Promise<void>((r) => {
            const t = setTimeout(r, POLL_MS);
            wakeups.set(pi.id, () => {
              clearTimeout(t);
              forceRtsp = true;
              r();
            });
          });
        }
        running.delete(pi.id);
      })();
    }
  };
  ensure();
  setInterval(ensure, 10000);
}

/** Poll now (after an action finishes) instead of waiting for the next cycle. */
export function refreshSoon(piId: string, delayMs = 800) {
  setTimeout(() => wakeups.get(piId)?.(), delayMs);
}

// ---- health rules --------------------------------------------------------------------------

export type Level = "ok" | "warn" | "bad" | "off" | "unknown";
export interface Health {
  level: Level;
  summary: string;
  details: string[];
}

const RANK: Record<Level, number> = { ok: 0, off: 1, unknown: 2, warn: 3, bad: 4 };
export const worst = (levels: Level[]): Level => levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "ok" as Level);

export function containerFor(cfg: Config, data: ProbeData | undefined, svc: ComponentId): Container | undefined {
  return data?.containers?.find((c) => c.project === cfg.stack.project && c.service === svc);
}

/**
 * Seconds since the container started, by the *Pi's* clock (probe time `t`). The lab Pis have no
 * internet and so no NTP; their clocks can be days off from this computer's.
 */
export const sinceStart = (c: Container | undefined, d: ProbeData) => (c?.started_at ? d.t - Date.parse(c.started_at) / 1000 : Infinity);

function profileDetails(pi: PiCfg, d: ProbeData): string[] {
  const p = d.vision.control?.controller_profile;
  return p ? [`controller profile ${p}${p === pi.arm.controller ? " ✓" : ` (expected ${pi.arm.controller})`}`] : [];
}

function containerGate(c: Container | undefined, data: ProbeData): Health | null {
  if (!data.runtime.up) return { level: "off", summary: "Docker runtime not running", details: [`${data.runtime.error ?? ""}. Start brings it up.`] };
  if (!c) return { level: "off", summary: data.stack.deployed ? "no container (use Start)" : "not deployed", details: [] };
  if (c.state === "running") return null;
  if (c.state === "exited" && c.exit_code && c.exit_code !== 0 && c.exit_code !== 130)
    return { level: "bad", summary: `crashed: ${c.status}`, details: ["Open Logs to see why."] };
  return { level: "off", summary: c.status || c.state, details: [] };
}

export function componentHealth(cfg: Config, pi: PiCfg, st: PiState, svc: ComponentId): Health {
  const d = st.data;
  if (!d) return { level: "unknown", summary: st.reachable === false ? "Pi unreachable" : "waiting for first poll…", details: [] };
  const c = containerFor(cfg, d, svc);
  const gate = containerGate(c, d);
  if (gate) return gate;
  const young = sinceStart(c, d) < 45;

  if (svc === "operator") {
    const details: string[] = [];
    if (!d.devices.serial.exists) return { level: "bad", summary: `${d.devices.serial.path} missing`, details: ["Check the USB cable, then Re-apply USB rules."] };
    if (!d.operator.listening)
      return { level: young ? "warn" : "bad", summary: young ? "starting (homing?)…" : `not listening on :${pi.arm.operatorPort}`, details };
    if (d.operator.log) details.push(`log updated ${fmtAge(d.operator.log.age_s)} ago`);
    const vs = d.vision.status;
    // Faults come from the arm controller via Operator (Pi-Vision just relays them).
    if (vs?.fault) return { level: "bad", summary: `arm controller fault: ${vs.fault}`, details: [...details, "Power-cycle the controller, then restart Operator (it re-HOMEs)."] };
    if (!pi.arm.telemetry) {
      // TODO(TODO.md): drop this branch once Bluey's controller reports telemetry.
      if (vs?.operator && !vs.operator.connected) return { level: "warn", summary: "listening; Pi-Vision not connected", details };
      return {
        level: "ok",
        summary: vs ? "listening; Pi-Vision connected" : `listening on :${pi.arm.operatorPort}`,
        details: [...details, ...profileDetails(pi, d), "this controller sends no telemetry (arm.telemetry: false), so arm health is unverified"],
      };
    }
    if (vs?.telemetry.received && (vs.telemetry.age_s ?? 99) < 3)
      return { level: "ok", summary: `arm telemetry ${vs.telemetry.age_s?.toFixed(1)}s old`, details: [...details, ...profileDetails(pi, d)] };
    if (vs?.telemetry.received)
      return { level: "bad", summary: `arm telemetry stale (${fmtAge(vs.telemetry.age_s ?? Infinity)}): controller not responding`, details: [...details, "Check the controller is powered; see Log file for its last words."] };
    if (vs && vs.operator && !vs.operator.connected)
      return { level: "warn", summary: `listening; Pi-Vision not connected`, details };
    if (vs && !vs.telemetry.received)
      return { level: "warn", summary: "no arm telemetry (controller off? ESP stuck?)", details: [...details, pi.arm.controller.startsWith("esp") ? "Try Troubleshoot > Reset ESP." : "Is the controller powered?"] };
    return { level: "ok", summary: `listening on :${pi.arm.operatorPort}`, details: [...details, "telemetry unverified (Pi-Vision is down)"] };
  }

  if (svc === "camera") {
    if (!d.devices.camera.exists) return { level: "bad", summary: `${d.devices.camera.path} missing`, details: ["Check the USB cable, then Re-apply USB rules."] };
    const inStack = !!containerFor(cfg, d, "mediamtx");
    if (!inStack && d.units["mediamtx.service"] !== "active")
      return { level: "bad", summary: "no RTSP server running", details: ["MediaMTX runs in the stack after the next Deploy."] };
    const path = d.mediamtx?.paths?.find((p) => p.name === pi.arm.rtspPath);
    if (d.mediamtx?.api && !path?.ready)
      return { level: young ? "warn" : "bad", summary: young ? "starting…" : `not publishing to MediaMTX path "${pi.arm.rtspPath}"`, details: ["Open Logs to see ffmpeg's error."] };
    const r = st.rtsp;
    if (!r || (r.pi_t && c?.started_at && r.pi_t * 1000 < Date.parse(c.started_at)))
      return { level: "unknown", summary: "checking stream…", details: [] };
    if (r.ok) {
      const expected = Number(fmtFps(r.fps));
      const slow = expected > 0 && (r.measured_fps ?? 0) < expected * 0.6;
      return {
        level: slow ? "warn" : "ok",
        summary: `${r.codec?.toUpperCase()} ${r.width}×${r.height}, ${r.measured_fps} fps measured${slow ? ` (expected ${expected})` : ""}`,
        details: [`${r.packets} packets (${r.keyframes} keyframes), ${(r.bytes! / 1024).toFixed(0)} KiB in ${r.window_s}s via ${r.how}; checked ${fmtAge((Date.now() - (r.at ?? 0)) / 1000)} ago`],
      };
    }
    return { level: young ? "warn" : "bad", summary: young ? "starting…" : "no RTSP frames", details: [r.error ?? "", r.url] };
  }

  if (svc === "mediamtx") {
    const m = d.mediamtx;
    if (!m?.api) return { level: young ? "warn" : "bad", summary: young ? "starting…" : "API not answering on 127.0.0.1:9997", details: [m?.error ?? ""] };
    const path = m.paths?.find((p) => p.name === pi.arm.rtspPath);
    const others = (m.paths ?? []).filter((p) => p !== path).map((p) => p.name);
    if (!path?.ready) return { level: "warn", summary: `up; nothing published on "${pi.arm.rtspPath}" yet`, details: others.length ? [`other paths: ${others.join(", ")}`] : [] };
    return {
      level: "ok",
      summary: `"${path.name}" live, ${path.readers} reader${path.readers === 1 ? "" : "s"}`,
      details: [`${(path.tracks ?? []).join(", ")} · ${(path.bytes_received / 1e6).toFixed(0)} MB received`, ...(others.length ? [`other paths: ${others.join(", ")}`] : [])],
    };
  }

  // vision
  const v = d.vision;
  if (!v.reachable || !v.status)
    return { level: young ? "warn" : "bad", summary: young ? "starting (loading model)…" : "API not responding", details: [v.error ?? ""] };
  const s = v.status;
  const o = v.observations;
  const details = [
    `state ${s.state}${s.tracking_enabled ? " · tracking ON" : " · tracking off"}`,
    o ? `${o.detections} ${o.detections === 1 ? "person" : "people"} · inference ${(o.inference_s * 1000).toFixed(0)} ms · seq ${o.sequence}${st.seqAdvancing === false ? " (stalled)" : ""}` : "",
  ].filter(Boolean);
  const ctl = v.control;
  if (ctl && !ctl.has_profile_field)
    return { level: "warn", summary: "doesn't report controller_profile: Commander will refuse to move the arm", details: [...details, "This Pi-Vision build lacks the dual-arm integration (controller profile passthrough)."] };
  // Pi-Vision learns the profile from Operator's "PROFILE <name>" message, so it's null whenever
  // Operator isn't running or connected: that's "nothing to check yet", not a mismatch.
  const opUp = containerFor(cfg, d, "operator")?.state === "running" && d.operator.listening;
  const noOperator = !!ctl && !ctl.controller_profile && (!opUp || s.operator?.connected === false);
  if (noOperator) details.push(`Operator ${opUp ? "not connected" : "not running"}: no arm control (controller profile is checked once it connects)`);
  else if (ctl && ctl.controller_profile !== pi.arm.controller)
    return { level: "warn", summary: `controller profile ${ctl.controller_profile ?? "unknown"} ≠ expected ${pi.arm.controller}: Commander blocks motion`, details };
  if (s.pose && !s.pose.available) return { level: "bad", summary: "pose model unavailable", details };
  if (o && o.enabled === false) return { level: "warn", summary: "perception paused", details };
  const fps = o?.fps ?? s.fps;
  if (!fps) return { level: young ? "warn" : "bad", summary: "0 fps: no frames from camera?", details };
  if (st.seqAdvancing === false) return { level: "warn", summary: "observations not advancing", details };
  if ((s.observation_age_s ?? 0) > 5) return { level: "warn", summary: `stale observations (${s.observation_age_s}s)`, details };
  return { level: "ok", summary: `${fps.toFixed(1)} fps pose inference`, details };
}

export function hostHealth(cfg: Config, pi: PiCfg, st: PiState): Health & { foreign: Container[] } {
  const d = st.data;
  if (st.reachable === null) return { level: "unknown", summary: "connecting…", details: [], foreign: [] };
  if (!d) return { level: "bad", summary: "unreachable", details: [], foreign: [] };
  const issues: { level: Level; text: string }[] = [];
  if (st.reachable === false || st.error) issues.push({ level: "bad", text: `last poll failed: ${st.error}` });
  if (!d.runtime.up) issues.push({ level: "warn", text: d.runtime.error ?? "Docker not reachable" });
  for (const u of ["camera-streamer.service", "pivision-integration.service"])
    if (d.units[u] === "active") issues.push({ level: "bad", text: `legacy ${u} is running (conflicts with containers)` });
  if (d.units["mediamtx.service"] === "active" && containerFor(cfg, d, "mediamtx"))
    issues.push({ level: "bad", text: "host mediamtx.service is running too and holds port 8554 (Troubleshoot > Retire host MediaMTX service)" });
  const twins = cfg.pis.filter((o) => o.id !== pi.id && d.host.machine_id && getState(o.id).data?.host.machine_id === d.host.machine_id);
  if (twins.length)
    issues.push({
      level: "warn",
      text: `same machine-id as ${twins.map((o) => o.name).join(", ")} (cloned SD card): expect .local name conflicts. Troubleshoot > Give this Pi its own identity`,
    });
  if (d.host.throttled && d.host.throttled !== "0x0") issues.push({ level: "warn", text: `throttled=${d.host.throttled} (undervoltage/thermal)` });
  if ((d.host.temp_c ?? 0) > 75) issues.push({ level: "warn", text: `hot: ${d.host.temp_c}°C` });
  if (d.host.disk_free_gb < 3) issues.push({ level: "warn", text: `low disk: ${d.host.disk_free_gb} GB free` });
  if (pi.arm.encoder === "hardware" && d.host.cma_mb < 256) issues.push({ level: "warn", text: `CMA ${d.host.cma_mb} MiB < 256 (hardware encoder may fault)` });
  const foreign = (d.containers ?? []).filter((c) => c.project !== cfg.stack.project && c.state === "running");
  if (foreign.length) issues.push({ level: "warn", text: `${foreign.length} non-Gaia container(s) running: ${foreign.map((c) => c.name).join(", ")}` });
  return {
    level: worst(issues.map((i) => i.level)),
    summary: issues.length ? issues[0]!.text : "healthy",
    details: issues.map((i) => i.text),
    foreign,
  };
}

export function piLevel(cfg: Config, pi: PiCfg, st: PiState): Level {
  if (st.reachable === false && !st.data) return "bad";
  return worst([hostHealth(cfg, pi, st).level, ...COMPONENTS.map((c) => componentHealth(cfg, pi, st, c).level)]);
}

export function fmtAge(s: number): string {
  if (!isFinite(s)) return "?";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function fmtFps(f?: string) {
  if (!f) return "?";
  const [a, b] = f.split("/").map(Number);
  return b ? (a! / b).toFixed(1).replace(/\.0$/, "") : f;
}
