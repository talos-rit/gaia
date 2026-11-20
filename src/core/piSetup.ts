// Backing for the Pi settings form (src/ui/piSettings.tsx): turning the form into a config entry,
// and detecting USB devices on a Pi that may not be saved yet (so no `talos` helper on it).

import { PI_ID, piIdTaken, piFromEntry, type FormError, type PiCfg } from "./config.ts";
import { runRemote, sshDisplay } from "./ssh.ts";

type Obj = Record<string, unknown>;
type Body = Record<string, string | File | (string | File)[]>;

const str = (b: Body, k: string) => {
  const v = b[k];
  return typeof v === "string" ? v.trim() : "";
};

/** Fields the form owns. Anything else already in the entry (e.g. `runtime`) is kept as is. */
const FORM_KEYS = ["name", "host", "user", "fallbackHosts"];
const FORM_ARM_KEYS = ["controller", "homesOnStart", "telemetry", "operatorPort", "visionPort", "rtspPath", "inferenceFps", "encoder", "usb"];

export interface FormResult {
  id: string;
  entry: Obj;
  errors: FormError[];
}

/**
 * Build a Pi entry from the settings form. Blank fields are left out so the defaults apply (and a
 * blank field on a shared Pi becomes `null` in gaia.local.yaml, i.e. "use the default here").
 */
export function entryFromForm(body: Body, existing: { id: string; entry: Obj } | undefined): FormResult {
  const errors: FormError[] = [];
  const err = (field: string, message: string) => errors.push({ field, message });
  const name = str(body, "name");
  const id = existing?.id ?? (str(body, "id") || slug(name));
  if (!name) err("name", "Name is required.");
  if (!existing) {
    if (!id) err("id", "ID is required.");
    else if (!PI_ID.test(id)) err("id", `Use only lowercase letters, digits and dashes.`);
    else if (piIdTaken(id)) err("id", `There's already a Pi with ID "${id}" (it may be one you removed; restore it instead).`);
  }

  const base = { ...(existing?.entry ?? {}) };
  for (const k of FORM_KEYS) delete base[k];
  const baseArm = { ...((base.arm as Obj | undefined) ?? {}) };
  for (const k of FORM_ARM_KEYS) delete baseArm[k];

  const entry: Obj = { name, ...base };
  const host = str(body, "host");
  if (!host) err("host", "Host is required.");
  else entry.host = host;
  const fallbacks = str(body, "fallbackHosts").split(/[\s,]+/).filter(Boolean);
  if (fallbacks.length) entry.fallbackHosts = fallbacks;
  if (str(body, "user")) entry.user = str(body, "user");

  const arm: Obj = { ...baseArm };
  if (str(body, "arm.controller")) arm.controller = str(body, "arm.controller");
  arm.homesOnStart = body["arm.homesOnStart"] === "on";
  if (body["arm.telemetry"] !== "on") arm.telemetry = false;
  for (const k of ["operatorPort", "visionPort", "inferenceFps"]) {
    const v = str(body, `arm.${k}`);
    if (!v) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || (k !== "inferenceFps" && (!Number.isInteger(n) || n > 65535))) err(`arm.${k}`, k === "inferenceFps" ? "Must be a positive number." : "Must be a port number (1–65535).");
    else arm[k] = n;
  }
  if (str(body, "arm.rtspPath")) arm.rtspPath = str(body, "arm.rtspPath");
  if (str(body, "arm.encoder")) arm.encoder = str(body, "arm.encoder");

  const usb: Obj = {};
  const serial = compact({ idPath: str(body, "usb.serial.idPath"), vendor: str(body, "usb.serial.vendor"), product: str(body, "usb.serial.product") });
  if (serial) {
    if (!serial.idPath) err("usb.serial.idPath", "The serial adapter needs an ID_PATH (vendor and product alone don't say which port).");
    usb.serial = serial;
  }
  const camera = compact({ idPath: str(body, "usb.camera.idPath") });
  if (camera) usb.camera = camera;
  if (Object.keys(usb).length) arm.usb = usb;
  entry.arm = arm;
  return { id, entry, errors };
}

const compact = (o: Record<string, string>) => {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v));
  return Object.keys(out).length ? out : undefined;
};

export const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// ---- USB detection ----------------------------------------------------------------------------

/**
 * Same idea as `talos usb-detect`, but sent inline (a Pi being set up has no helper yet) and
 * tab-separated for parsing. Cameras: only video4linux index 0, the capture node the udev rule
 * matches (index 1 is the same camera's metadata node).
 */
const DETECT_SCRIPT = String.raw`for d in /dev/ttyUSB* /dev/ttyACM* /dev/video*; do
  [ -e "$d" ] || continue
  p=$(udevadm info -q property -n "$d" 2>/dev/null) || continue
  g() { printf '%s\n' "$p" | sed -n "s/^$1=//p" | head -n 1; }
  idp=$(g ID_PATH); case "$idp" in *usb*) ;; *) continue ;; esac
  case "$d" in /dev/video*) [ "$(cat /sys/class/video4linux/${"$"}{d#/dev/}/index 2>/dev/null)" = 0 ] || continue ;; esac
  m=$(g ID_MODEL_FROM_DATABASE); [ -n "$m" ] || m=$(g ID_MODEL | tr _ ' ')
  printf '%s\t%s\t%s\t%s\t%s\n' "$d" "$idp" "$(g ID_VENDOR_ID)" "$(g ID_MODEL_ID)" "$m"
done
`;

export interface UsbDevice {
  dev: string;
  kind: "serial" | "camera";
  idPath: string;
  vendor: string;
  product: string;
  model: string;
  /** "1.3" from …-usb-0:1.3:1.0: the physical port, which is what the rule pins. */
  port: string;
}

export interface DetectResult {
  display: string;
  devices: UsbDevice[];
  error?: string;
}

/** Run detection on `pi` (a saved Pi, or a draft built from the form's host and user). */
export async function detectUsb(pi: PiCfg): Promise<DetectResult> {
  const display = `${sshDisplay(`${pi.user}@${pi.host}`, "bash -s")} < usb-detect script`;
  let r;
  try {
    r = await runRemote(pi, "bash -s", { stdin: DETECT_SCRIPT, timeoutMs: 15_000 });
  } catch (e) {
    return { display, devices: [], error: (e as Error).message };
  }
  if (r.code !== 0) return { display, devices: [], error: (r.stderr || r.stdout).trim() || `exit ${r.code}` };
  const devices = r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line): UsbDevice => {
      const [dev = "", idPath = "", vendor = "", product = "", model = ""] = line.split("\t");
      return { dev, idPath, vendor, product, model, kind: dev.startsWith("/dev/video") ? "camera" : "serial", port: /usb-\d+:([\d.]+)/.exec(idPath)?.[1] ?? "" };
    });
  return { display, devices };
}

/** A PiCfg for a Pi that only exists in the form so far (ssh needs host, user, fallbacks). */
export function draftPi(body: Body, id: string): PiCfg {
  const host = str(body, "host");
  const user = str(body, "user") || "pi";
  return piFromEntry(`draft-${id || "new"}-${user}@${host}`, { host, user, fallbackHosts: str(body, "fallbackHosts").split(/[\s,]+/).filter(Boolean) });
}
