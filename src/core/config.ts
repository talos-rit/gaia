import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
export const CONFIG_FILE = resolve(ROOT, "gaia.config.yaml");
export const LOCAL_CONFIG_FILE = resolve(ROOT, "gaia.local.yaml");

export type ComponentId = "operator" | "camera" | "mediamtx" | "vision";
export const COMPONENTS: ComponentId[] = ["operator", "camera", "mediamtx", "vision"];
export const COMPONENT_LABEL: Record<ComponentId, string> = {
  operator: "Operator",
  camera: "Cam Streamer",
  mediamtx: "MediaMTX",
  vision: "Pi-Vision",
};

export type Source =
  | { mode: "git"; repo: string; ref: string }
  | { mode: "local"; path: string }
  | { mode: "builtin" };

export interface ComponentCfg {
  source: Source;
  buildArgs?: Record<string, string>;
}
export interface OperatorCfg extends ComponentCfg {
  runTests?: boolean;
}
export interface VisionCfg extends ComponentCfg {
  appDir: string;
  model: string;
  extraArgs?: string[];
  env?: Record<string, string>;
}
export type CameraCfg = ComponentCfg;
export interface MediamtxCfg extends ComponentCfg {
  /** bluenviron/mediamtx image tag. */
  version: string;
}

export interface UsbMatch {
  idPath: string;
  vendor?: string;
  product?: string;
}

/**
 * What drives the arm: the Scorbot's own controller box, or the team's custom ESP32 board. Gaia
 * keys hardware differences (e.g. Reset ESP) on this, never on the Operator profile.
 */
export type ControllerType = "native" | "talos";
export const CONTROLLER_TYPES: ControllerType[] = ["native", "talos"];
/**
 * The serial protocol Operator speaks (its ERV_CONTROLLER_PROFILE; Commander's controller_profile).
 * Both controller types speak native; Operator's other profile, esp-one-axis, was for firmware no
 * board runs any more.
 */
export const OPERATOR_PROFILE = "native";

export interface ArmCfg {
  controller: ControllerType;
  homesOnStart: boolean;
  operatorPort: number;
  visionPort: number;
  rtspPath: string;
  inferenceFps: number;
  encoder: "hardware" | "software";
  /** false = the controller sends no joint telemetry (Bluey's custom controller, for now). */
  telemetry: boolean;
  usb?: { serial?: UsbMatch; camera?: UsbMatch };
}

export interface PiCfg {
  id: string;
  name: string;
  host: string;
  fallbackHosts: string[];
  user: string;
  runtime: "isolated" | "system";
  runtimeDir: string;
  arm: ArmCfg;
}

/** The Commander checkout Gaia manages on this machine (not on a Pi). */
export interface CommanderCfg {
  /** As configured, relative to the Gaia checkout (for display). */
  path: string;
  /** Absolute path. */
  dir: string;
  repo: string;
  /** Branch that Set up clones. */
  branch: string;
}

export interface Config {
  server: { port: number };
  commander: CommanderCfg;
  stack: { dir: string; project: string };
  components: { operator: OperatorCfg; vision: VisionCfg; camera: CameraCfg; mediamtx: MediamtxCfg };
  pis: PiCfg[];
  /** Validation problems; shown as a banner in the UI instead of crashing. */
  problems: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * gaia.local.yaml is a JSON Merge Patch (RFC 7386) over gaia.config.yaml: objects merge key by
 * key, anything else (arrays included) is replaced, and `null` removes a key. So a local file
 * can add a Pi, change one field of a shared Pi, or remove a shared Pi (`pis: { bingo: null }`)
 * without copying or editing the team's file. A component `source` is replaced wholesale, never
 * mixed (a git repo with a local path makes no sense).
 */
function merge(base: unknown, over: unknown, key = ""): unknown {
  if (over === undefined) return base;
  if (key === "source" || !isObj(base) || !isObj(over)) return over;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = merge(base[k], v, k);
  }
  return out;
}

/** The merge patch that turns `base` into `target` (the inverse of `merge`). Empty = identical. */
function diff(base: Obj, target: Obj): Obj {
  const out: Obj = {};
  for (const k of Object.keys(base)) if (!(k in target)) out[k] = null;
  for (const [k, v] of Object.entries(target)) {
    const b = base[k];
    if (isObj(b) && isObj(v) && k !== "source") {
      const d = diff(b, v);
      if (Object.keys(d).length) out[k] = d;
    } else if (JSON.stringify(b) !== JSON.stringify(v)) out[k] = v;
  }
  return out;
}

function readYaml(path: string): Obj {
  if (!existsSync(path)) return {};
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  return isObj(parsed) ? parsed : {};
}

function validateSource(name: string, s: unknown, problems: string[]) {
  if (!isObj(s)) return problems.push(`components.${name}.source is missing`);
  if (s.mode === "git" && (typeof s.repo !== "string" || typeof s.ref !== "string"))
    problems.push(`components.${name}.source: git mode needs repo and ref`);
  else if (s.mode === "local" && typeof s.path !== "string")
    problems.push(`components.${name}.source: local mode needs path`);
  else if (!["git", "local", "builtin"].includes(String(s.mode)))
    problems.push(`components.${name}.source.mode must be git, local or builtin`);
}

export const PI_ID = /^[a-z0-9][a-z0-9-]*$/;

/** Defaults for everything outside `pis:` that the config may leave out (also the settings form's placeholders). */
export const DEFAULTS = {
  port: 4747,
  stackDir: "talos-stack",
  stackProject: "talos",
  commanderPath: "../commander",
  commanderRepo: "https://github.com/talos-rit/commander.git",
  commanderBranch: "main",
  visionAppDir: ".",
  visionModel: "yolo11n-pose-320.onnx",
  mediamtxVersion: "1.15.3",
} as const;

/** Defaults for the arm fields a Pi entry may leave out (also the Pi settings form's placeholders). */
export const ARM_DEFAULTS = {
  controller: "native",
  operatorPort: 61616,
  visionPort: 5051,
  inferenceFps: 4,
  encoder: "hardware",
} as const;

/** Before controller types, `controller` held the Operator profile, and `esp-one-axis` meant a Talos board. */
const LEGACY_CONTROLLER = "esp-one-axis";

export function piFromEntry(id: string, p: Obj): PiCfg {
  const arm = (isObj(p.arm) ? p.arm : {}) as Obj;
  return {
    id,
    name: String(p.name ?? id),
    host: String(p.host ?? ""),
    fallbackHosts: ((p.fallbackHosts as string[]) ?? []).map(String),
    user: String(p.user ?? "pi"),
    // system = a normal Docker install (what Troubleshoot > Install Docker sets up).
    runtime: p.runtime === "isolated" ? "isolated" : "system",
    runtimeDir: String(p.runtimeDir ?? "/opt/talos-docker/29.8.2"),
    arm: {
      controller: arm.controller === "talos" || arm.controller === LEGACY_CONTROLLER ? "talos" : "native",
      // Unset means "homes": the cautious reading, since Gaia then asks before starting Operator.
      homesOnStart: arm.homesOnStart !== false,
      operatorPort: Number(arm.operatorPort ?? ARM_DEFAULTS.operatorPort),
      visionPort: Number(arm.visionPort ?? ARM_DEFAULTS.visionPort),
      rtspPath: String(arm.rtspPath ?? id),
      inferenceFps: Number(arm.inferenceFps ?? ARM_DEFAULTS.inferenceFps),
      encoder: arm.encoder === "software" ? "software" : "hardware",
      telemetry: arm.telemetry !== false,
      usb: arm.usb as ArmCfg["usb"],
    },
  };
}

export function loadConfig(): Config {
  const problems: string[] = [];
  let raw: Obj = {};
  try {
    migrateLocal();
    raw = merge(readYaml(CONFIG_FILE), readYaml(LOCAL_CONFIG_FILE)) as Obj;
  } catch (e) {
    problems.push(`Could not parse config: ${(e as Error).message}`);
  }
  const comps = (raw.components ?? {}) as Obj;
  // MediaMTX is built entirely by Gaia (stack/mediamtx.Dockerfile); no config needed.
  comps.mediamtx = { source: { mode: "builtin" }, version: DEFAULTS.mediamtxVersion, ...((comps.mediamtx as Obj) ?? {}) };
  for (const c of COMPONENTS) validateSource(c, (comps[c] as Obj | undefined)?.source, problems);

  if (Array.isArray(raw.pis)) problems.push("pis must be a map keyed by Pi id (pis: { bingo: { host: …, arm: … } }), not a list");
  const pis: PiCfg[] = [];
  for (const [id, entry] of Object.entries(isObj(raw.pis) ? raw.pis : {})) {
    if (!isObj(entry)) continue;
    if (!PI_ID.test(id)) problems.push(`Pi id "${id}" must be lowercase letters, digits or dashes`);
    if (!entry.host) problems.push(`pis.${id}.host is required`);
    const arm = isObj(entry.arm) ? entry.arm : {};
    if (arm.controller != null && arm.controller !== LEGACY_CONTROLLER && !CONTROLLER_TYPES.includes(arm.controller as ControllerType))
      problems.push(`pis.${id}.arm.controller must be ${CONTROLLER_TYPES.join(" or ")}`);
    pis.push(piFromEntry(id, entry));
  }
  const stack = (raw.stack ?? {}) as Obj;
  const vision = (comps.vision ?? {}) as Obj;
  const cmd = (raw.commander ?? {}) as Obj;
  const cmdPath = String(cmd.path ?? DEFAULTS.commanderPath);
  return {
    commander: {
      path: cmdPath,
      dir: resolve(ROOT, cmdPath),
      repo: String(cmd.repo ?? DEFAULTS.commanderRepo),
      branch: String(cmd.branch ?? DEFAULTS.commanderBranch),
    },
    server: { port: Number(process.env.PORT ?? (raw.server as Obj | undefined)?.port ?? DEFAULTS.port) },
    stack: { dir: String(stack.dir ?? DEFAULTS.stackDir), project: String(stack.project ?? DEFAULTS.stackProject) },
    components: {
      operator: { runTests: true, ...(comps.operator as Obj) } as unknown as OperatorCfg,
      camera: { ...(comps.camera as Obj) } as unknown as CameraCfg,
      vision: { appDir: DEFAULTS.visionAppDir, model: DEFAULTS.visionModel, extraArgs: [], env: {}, ...vision } as unknown as VisionCfg,
      mediamtx: { ...(comps.mediamtx as Obj) } as unknown as MediamtxCfg,
    },
    pis,
    problems,
  };
}

const LOCAL_HEADER =
  "# Personal Gaia overrides (git-ignored): a merge patch over gaia.config.yaml (null removes a key).\n" +
  "# Written by the Gaia UI (or its MCP server); safe to hand-edit.\n";

function writeLocal(local: Obj) {
  if (isObj(local.pis) && Object.keys(local.pis).length === 0) delete local.pis;
  if (isObj(local.components) && Object.keys(local.components).length === 0) delete local.components;
  writeFileSync(LOCAL_CONFIG_FILE, LOCAL_HEADER + (Object.keys(local).length ? Bun.YAML.stringify(local, null, 2) + "\n" : ""));
}

/**
 * One-time rewrite of a gaia.local.yaml from before controller types: `controller: esp-one-axis`
 * becomes `controller: talos`.
 * (gaia.config.yaml is the team's file and was migrated in git.)
 */
function migrateLocal() {
  const local = readYaml(LOCAL_CONFIG_FILE);
  let changed = false;
  for (const entry of Object.values(isObj(local.pis) ? local.pis : {})) {
    const arm = isObj(entry) && isObj(entry.arm) ? entry.arm : undefined;
    if (arm?.controller !== LEGACY_CONTROLLER) continue;
    arm.controller = "talos";
    changed = true;
  }
  if (changed) writeLocal(local);
}

/** Persist a component source override to gaia.local.yaml (other local settings are preserved). */
export function saveLocalSource(component: ComponentId, source: Source, extra: Obj = {}) {
  const local = readYaml(LOCAL_CONFIG_FILE);
  const comps = (local.components ?? {}) as Obj;
  comps[component] = { ...((comps[component] as Obj) ?? {}), ...extra, source };
  local.components = comps;
  writeLocal(local);
}

// ---- Editing config from the UI ----------------------------------------------------------------
// The settings forms edit one section at a time (a Pi, Commander, a component's build options…).
// Saving writes gaia.local.yaml as a merge patch: only the fields that differ from the shared
// gaia.config.yaml, so later changes to the team's file still reach this computer.

const at = (o: unknown, path: string[]): unknown => path.reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), o);

/** Set (or with `undefined`, delete) the value at `path` in gaia.local.yaml, pruning emptied parents. */
function setLocal(path: string[], value: unknown) {
  const local = readYaml(LOCAL_CONFIG_FILE);
  const chain: Obj[] = [local];
  for (const k of path.slice(0, -1)) {
    const o = chain.at(-1)!;
    if (!isObj(o[k])) o[k] = {};
    chain.push(o[k] as Obj);
  }
  const last = path.at(-1)!;
  if (value === undefined) delete chain.at(-1)![last];
  else chain.at(-1)![last] = value;
  for (let i = path.length; i > 0; i--) {
    const v = chain[i - 1]![path[i - 1]!];
    if (isObj(v) && Object.keys(v).length === 0) delete chain[i - 1]![path[i - 1]!];
  }
  writeLocal(local);
}

// Shown and compared as one value (the merge still goes field by field for env/buildArgs).
const ATOMIC = new Set(["usb", "source", "env", "buildArgs"]);
const paths = (o: Obj, prefix = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) => (isObj(v) && !ATOMIC.has(k) ? paths(v, `${prefix}${k}.`) : [`${prefix}${k}`]));

/** A settings form's validation error. `field` is the input's name, so the form can show it there. */
export interface FormError {
  field?: string;
  message: string;
}

export interface SectionInfo {
  /** The section as written (shared + local patch), before defaults are filled in. */
  value: Obj;
  /** The section in gaia.config.yaml, if it has one. */
  shared: Obj | undefined;
  /** gaia.local.yaml removes it (`null`). */
  removed: boolean;
  /** Fields this computer changes, as dotted paths relative to the section ("arm.operatorPort"). */
  changed: string[];
}

export function section(path: string[]): SectionInfo {
  const shared = at(readYaml(CONFIG_FILE), path);
  const patch = at(readYaml(LOCAL_CONFIG_FILE), path);
  const s = isObj(shared) ? shared : undefined;
  if (patch === null) return { value: {}, shared: s, removed: true, changed: [] };
  const value = (s ? merge(s, patch) : isObj(patch) ? patch : {}) as Obj;
  return { value, shared: s, removed: false, changed: s && isObj(patch) ? paths(diff(s, value)) : [] };
}

/**
 * Save a section's full value; gaia.local.yaml keeps only what differs from gaia.config.yaml.
 * `keep` names fields another form owns (a component's `source`): their local value stays as
 * written, even when it happens to equal the shared one.
 */
export function saveSection(path: string[], value: Obj, keep: string[] = []) {
  const shared = at(readYaml(CONFIG_FILE), path);
  const prev = at(readYaml(LOCAL_CONFIG_FILE), path);
  const omit = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([k]) => !keep.includes(k)));
  const kept = isObj(prev) ? Object.fromEntries(Object.entries(prev).filter(([k]) => keep.includes(k))) : {};
  const patch = { ...(isObj(shared) ? diff(omit(shared), omit(value)) : omit(value)), ...kept };
  setLocal(path, Object.keys(patch).length ? patch : undefined);
}

/** Drop this computer's changes to a section (for a removed shared Pi: restore it). */
export function resetSection(path: string[]) {
  setLocal(path, undefined);
}

// ---- Pi entries (src/ui/piSettings.tsx) -----------------------------------------------------------
// Shared Pis live in gaia.config.yaml (the lab's fleet, so a new teammate gets it for free).

const piMap = (file: string): Obj => {
  const p = readYaml(file).pis;
  return isObj(p) ? p : {};
};

export type PiOrigin = "shared" | "local";

export interface PiEntryInfo {
  /** The Pi's entry as written (shared + local patch), before defaults are filled in. */
  entry: Obj;
  /** The entry in gaia.config.yaml (shared Pis only): what a field's reset button goes back to. */
  shared: Obj | undefined;
  origin: PiOrigin;
  /** Shared Pi with local changes: the changed fields as dotted paths (e.g. "arm.operatorPort"). */
  changed: string[];
}

export function piEntry(id: string): PiEntryInfo | undefined {
  const s = section(["pis", id]);
  if (s.removed || (!s.shared && Object.keys(s.value).length === 0)) return undefined;
  return { entry: s.value, shared: s.shared, origin: s.shared ? "shared" : "local", changed: s.changed };
}

export const savePiEntry = (id: string, entry: Obj) => saveSection(["pis", id], entry);

/** Remove a Pi from this computer: a shared one is hidden with `null`, a local one is deleted. */
export function removePi(id: string) {
  setLocal(["pis", id], id in piMap(CONFIG_FILE) ? null : undefined);
}

/** Drop this computer's changes to a shared Pi (or un-remove it). */
export const resetPi = (id: string) => resetSection(["pis", id]);

/** Shared Pis this computer has removed, for "Restore". */
export function removedSharedPis(): { id: string; name: string }[] {
  const shared = piMap(CONFIG_FILE);
  return Object.entries(piMap(LOCAL_CONFIG_FILE))
    .filter(([id, v]) => v === null && isObj(shared[id]))
    .map(([id]) => ({ id, name: String((shared[id] as Obj).name ?? id) }));
}

/** Is `id` taken by a shared or local Pi (including a removed shared one)? */
export function piIdTaken(id: string): boolean {
  return id in piMap(CONFIG_FILE) || id in piMap(LOCAL_CONFIG_FILE);
}

/** YAML for one Pi entry, as it would appear under `pis:` (for "share with the team"). */
export function piYaml(id: string, entry: Obj): string {
  return Bun.YAML.stringify({ pis: { [id]: entry } }, null, 2) + "\n";
}

/** Remove a component override so the shared gaia.config.yaml default applies again. */
export function clearLocalSource(component: ComponentId) {
  const local = readYaml(LOCAL_CONFIG_FILE);
  const comps = (local.components ?? {}) as Obj;
  if (isObj(comps[component])) delete (comps[component] as Obj).source;
  if (isObj(comps[component]) && Object.keys(comps[component] as Obj).length === 0) delete comps[component];
  local.components = comps;
  writeLocal(local);
}

export function localOverrideFor(component: ComponentId): boolean {
  const comps = readYaml(LOCAL_CONFIG_FILE).components as Obj | undefined;
  return isObj(comps?.[component]) && "source" in (comps![component] as Obj);
}

/** A component's source from gaia.config.yaml alone (ignoring gaia.local.yaml overrides). */
export function sharedSource(component: ComponentId): Source | undefined {
  try {
    const s = ((readYaml(CONFIG_FILE).components as Obj | undefined)?.[component] as Obj | undefined)?.source;
    return isObj(s) ? (s as unknown as Source) : undefined;
  } catch {
    return undefined;
  }
}

export function getPi(cfg: Config, id: string): PiCfg | undefined {
  return cfg.pis.find((p) => p.id === id);
}

export function describeSource(s: Source): string {
  if (s.mode === "git") return `${s.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")} @ ${s.ref}`;
  if (s.mode === "local") return `working copy ${s.path}`;
  return "built into Gaia";
}
