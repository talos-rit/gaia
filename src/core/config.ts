import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
export const CONFIG_FILE = resolve(ROOT, "gaia.config.yaml");
export const LOCAL_CONFIG_FILE = resolve(ROOT, "gaia.local.yaml");

export type ComponentId = "operator" | "camera" | "vision";
export const COMPONENTS: ComponentId[] = ["operator", "camera", "vision"];
export const COMPONENT_LABEL: Record<ComponentId, string> = {
  operator: "Operator",
  camera: "Cam Streamer",
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

export interface UsbMatch {
  idPath: string;
  vendor?: string;
  product?: string;
}

export interface ArmCfg {
  controller: string;
  homesOnStart: boolean;
  operatorPort: number;
  visionPort: number;
  rtspPath: string;
  inferenceFps: number;
  encoder: "hardware" | "software";
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

export interface Config {
  server: { port: number };
  stack: { dir: string; project: string };
  components: { operator: OperatorCfg; vision: VisionCfg; camera: CameraCfg };
  pis: PiCfg[];
  /** Validation problems; shown as a banner in the UI instead of crashing. */
  problems: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge; arrays are replaced, except `pis`, which is merged by `id`. */
function merge(base: unknown, over: unknown, key = ""): unknown {
  if (key === "pis" && Array.isArray(base) && Array.isArray(over)) {
    const out = base.map((p) => ({ ...(p as Obj) }));
    for (const o of over as Obj[]) {
      const i = out.findIndex((p) => p.id === o.id);
      if (i >= 0) out[i] = merge(out[i], o) as Obj;
      else out.push(o);
    }
    return out;
  }
  if (key === "source") return over ?? base; // a source is replaced wholesale, never mixed
  if (isObj(base) && isObj(over)) {
    const out: Obj = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v, k) : v;
    return out;
  }
  return over === undefined ? base : over;
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

export function loadConfig(): Config {
  const problems: string[] = [];
  let raw: Obj = {};
  try {
    raw = merge(readYaml(CONFIG_FILE), readYaml(LOCAL_CONFIG_FILE)) as Obj;
  } catch (e) {
    problems.push(`Could not parse config: ${(e as Error).message}`);
  }
  const comps = (raw.components ?? {}) as Obj;
  for (const c of COMPONENTS) validateSource(c, (comps[c] as Obj | undefined)?.source, problems);

  const pis: PiCfg[] = [];
  const seen = new Set<string>();
  for (const [i, p] of ((raw.pis as Obj[]) ?? []).entries()) {
    const arm = (p.arm ?? {}) as Obj;
    const id = String(p.id ?? `pi${i}`);
    if (!/^[a-z0-9-]+$/.test(id)) problems.push(`pis[${i}].id "${id}" must be lowercase letters, digits or dashes`);
    if (seen.has(id)) problems.push(`duplicate Pi id "${id}"`);
    seen.add(id);
    if (!p.host) problems.push(`pis.${id}.host is required`);
    for (const k of ["operatorPort", "visionPort"]) if (typeof arm[k] !== "number") problems.push(`pis.${id}.arm.${k} must be a number`);
    pis.push({
      id,
      name: String(p.name ?? id),
      host: String(p.host ?? ""),
      fallbackHosts: ((p.fallbackHosts as string[]) ?? []).map(String),
      user: String(p.user ?? "pi"),
      runtime: p.runtime === "system" ? "system" : "isolated",
      runtimeDir: String(p.runtimeDir ?? "/opt/talos-docker/29.8.2"),
      arm: {
        controller: String(arm.controller ?? "native"),
        homesOnStart: arm.homesOnStart !== false,
        operatorPort: Number(arm.operatorPort ?? 61616),
        visionPort: Number(arm.visionPort ?? 5051),
        rtspPath: String(arm.rtspPath ?? id),
        inferenceFps: Number(arm.inferenceFps ?? 2),
        encoder: arm.encoder === "software" ? "software" : "hardware",
        usb: arm.usb as ArmCfg["usb"],
      },
    });
  }
  const stack = (raw.stack ?? {}) as Obj;
  const vision = (comps.vision ?? {}) as Obj;
  return {
    server: { port: Number(process.env.PORT ?? (raw.server as Obj | undefined)?.port ?? 4747) },
    stack: { dir: String(stack.dir ?? "talos-stack"), project: String(stack.project ?? "talos") },
    components: {
      operator: { runTests: true, ...(comps.operator as Obj) } as unknown as OperatorCfg,
      camera: { ...(comps.camera as Obj) } as unknown as CameraCfg,
      vision: { appDir: ".", model: "model.onnx", extraArgs: [], env: {}, ...vision } as unknown as VisionCfg,
    },
    pis,
    problems,
  };
}

/** Persist a component source override to gaia.local.yaml (other local settings are preserved). */
export function saveLocalSource(component: ComponentId, source: Source, extra: Obj = {}) {
  const local = readYaml(LOCAL_CONFIG_FILE);
  const comps = (local.components ?? {}) as Obj;
  comps[component] = { ...((comps[component] as Obj) ?? {}), ...extra, source };
  local.components = comps;
  const header =
    "# Personal Gaia overrides (git-ignored). Deep-merged over gaia.config.yaml.\n" +
    "# Written by the Gaia UI; safe to hand-edit.\n";
  writeFileSync(LOCAL_CONFIG_FILE, header + Bun.YAML.stringify(local, null, 2) + "\n");
}

/** Remove a component override so the shared gaia.config.yaml default applies again. */
export function clearLocalSource(component: ComponentId) {
  const local = readYaml(LOCAL_CONFIG_FILE);
  const comps = (local.components ?? {}) as Obj;
  if (isObj(comps[component])) delete (comps[component] as Obj).source;
  if (isObj(comps[component]) && Object.keys(comps[component] as Obj).length === 0) delete comps[component];
  local.components = comps;
  writeFileSync(LOCAL_CONFIG_FILE, Bun.YAML.stringify(local, null, 2) + "\n");
}

export function localOverrideFor(component: ComponentId): boolean {
  const comps = readYaml(LOCAL_CONFIG_FILE).components as Obj | undefined;
  return isObj(comps?.[component]) && "source" in (comps![component] as Obj);
}

export function getPi(cfg: Config, id: string): PiCfg | undefined {
  return cfg.pis.find((p) => p.id === id);
}

export function describeSource(s: Source): string {
  if (s.mode === "git") return `${s.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")} @ ${s.ref}`;
  if (s.mode === "local") return `working copy ${s.path}`;
  return "built into Gaia";
}
