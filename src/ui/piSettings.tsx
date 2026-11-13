// The Pi settings form: More › Settings on a card, and Fleet › Add a Pi. It edits one `pis:` entry;
// saving writes gaia.local.yaml (see savePiEntry), so shared Pis stay as gaia.config.yaml has them.

import { ARM_DEFAULTS, piYaml, removedSharedPis, type FormError, type PiEntryInfo } from "../core/config.ts";
import type { DetectResult } from "../core/piSetup.ts";
import { confirmAttrs, Modal } from "./components.tsx";
import { Icon } from "./icons.tsx";
import { Check, errorsFor, Field, Fold, FormErrors, Section, SettingsForm, type Fill } from "./settingsForm.tsx";

type Obj = Record<string, unknown>;

const CONTROLLERS = [
  { value: "native", label: "Scorbot controller (native)" },
  { value: "esp-one-axis", label: "ESP controller, one axis (esp-one-axis)" },
];

const get = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Obj)[k] : undefined), o);
const val = (o: Obj, path: string) => {
  const v = get(o, path);
  return v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
};

export interface PiFormProps {
  /** Existing Pi; absent when adding one. */
  id?: string;
  info?: PiEntryInfo;
  /** What to show in the fields (the saved entry, or what was just submitted). */
  entry: Obj;
  errors?: FormError[];
  /** Adding: the ID typed so far (kept when the form comes back with errors). */
  newId?: string;
  /** After a failed save: the form as submitted. */
  raw?: Record<string, unknown>;
}

export function PiSettings({ id, info, entry, errors, newId, raw }: PiFormProps) {
  const adding = !id;
  const name = val(entry, "name") || id || "New Pi";
  const action = adding ? "/fleet/add" : `/pis/${id}/settings`;
  const controller = val(entry, "arm.controller") || ARM_DEFAULTS.controller;
  const encoder = val(entry, "arm.encoder") || ARM_DEFAULTS.encoder;
  const host = val(entry, "host") || (typeof raw?.host === "string" ? raw.host : "");
  const removed = adding ? removedSharedPis() : [];
  const err = errorsFor(errors);

  // A shared Pi's fields that this computer changes get a mark and a reset button that puts
  // gaia.config.yaml's value back in the form.
  const changed = new Set(info?.origin === "shared" ? info.changed : []);
  const shared = info?.shared ?? {};
  const reset = (path: string, name = path): Fill | undefined => (changed.has(path) ? { [name]: val(shared, path) } : undefined);
  const resetCheck = (path: string) => (changed.has(path) ? get(shared, path) !== false : undefined);
  const usbPart = (part: "serial" | "camera", keys: string[]): Fill | undefined =>
    changed.has("arm.usb") && JSON.stringify(get(shared, `arm.usb.${part}`) ?? null) !== JSON.stringify(get(entry, `arm.usb.${part}`) ?? null)
      ? Object.fromEntries(keys.map((k) => [`usb.${part}.${k}`, val(shared, `arm.usb.${part}.${k}`)]))
      : undefined;
  /** An input's text: as submitted after a failed save (so a wrong value stays put to fix), else as saved. */
  const shown = (name: string, path = name) => (typeof raw?.[name] === "string" ? (raw[name] as string) : val(entry, path));
  const field = (path: string, name = path) => ({ value: shown(name, path), reset: reset(path, name), error: err.of(name) });

  const portPaths = ["arm.operatorPort", "arm.visionPort", "arm.rtspPath", "arm.inferenceFps", "arm.encoder"];
  const portsOpen = portPaths.some((p) => changed.has(p)) || err.any(...portPaths);

  const body = (
    <>
      <FormErrors errors={err.general} />

      <Section title="Connection">
        <Field label="Name" {...field("name")}>
          <input name="name" class="w-m text" value={shown("name")} placeholder="Bingo" required data-slug-source={adding || undefined} autofocus={(adding && !errors?.length) || undefined} />
        </Field>
        {adding ? (
          <Field label="ID" hint="Names the Pi's devices (/dev/talos-<id>-serial) and its robot in Commander. It can't be changed later." error={err.of("id")}>
            <input name="id" class="w-m" value={newId ?? ""} placeholder="bingo" pattern="[a-z0-9][a-z0-9\-]*" data-slug-target />
          </Field>
        ) : (
          <Field label="ID">
            <span class="mono">{id}</span>
          </Field>
        )}
        <Field label="Host" hint="Gaia connects with ssh <user>@<host>, so key login must work without a password." {...field("host")}>
          <input name="host" class="w-m" value={shown("host")} placeholder="raspberrypi.local" required />
        </Field>
        <Field label="SSH user" {...field("user")}>
          <input name="user" class="w-s" value={shown("user") || (adding && !raw ? "pi" : "")} placeholder="pi" />
        </Field>
        <Field label="Fallback addresses" hint="Tried when the host doesn't answer, e.g. when its .local name stops resolving. Comma-separated." {...field("fallbackHosts")}>
          <input name="fallbackHosts" value={shown("fallbackHosts")} placeholder="192.168.1.20" />
        </Field>
      </Section>

      <Section title="Arm">
        <Field label="Controller" {...field("arm.controller")}>
          <select name="arm.controller" class="w-l">
            {CONTROLLERS.map((c) => (
              <option value={c.value} selected={c.value === controller}>
                {c.label}
              </option>
            ))}
            {!CONTROLLERS.some((c) => c.value === controller) && (
              <option value={controller} selected>
                {controller}
              </option>
            )}
          </select>
        </Field>
        <Check
          name="arm.homesOnStart"
          label="Starting Operator homes the arm"
          hint="Gaia then asks before Start, Restart and Deploy."
          checked={get(entry, "arm.homesOnStart") !== false}
          reset={resetCheck("arm.homesOnStart")}
        />
        <Check
          name="arm.telemetry"
          label="Controller sends joint telemetry"
          hint="Uncheck it if the controller has none, so Operator's health check doesn't wait for it."
          checked={get(entry, "arm.telemetry") !== false}
          reset={resetCheck("arm.telemetry")}
        />
      </Section>

      <Fold title="Ports, stream and encoder" open={portsOpen}>
        <p class="hint">These only need to match what Commander expects; Gaia writes them into Commander's config.</p>
        <Field label="Operator port" def={String(ARM_DEFAULTS.operatorPort)} {...field("arm.operatorPort")}>
          <input name="arm.operatorPort" class="w-xs" value={shown("arm.operatorPort")} placeholder={String(ARM_DEFAULTS.operatorPort)} inputmode="numeric" />
        </Field>
        <Field label="Pi-Vision port" def={String(ARM_DEFAULTS.visionPort)} {...field("arm.visionPort")}>
          <input name="arm.visionPort" class="w-xs" value={shown("arm.visionPort")} placeholder={String(ARM_DEFAULTS.visionPort)} inputmode="numeric" />
        </Field>
        <Field label="RTSP path" prefix={<span class="mono">rtsp://{host || "<host>"}:8554/</span>} def={id} {...field("arm.rtspPath")}>
          <input name="arm.rtspPath" class="w-s" value={shown("arm.rtspPath")} placeholder={id ?? "same as ID"} />
        </Field>
        <Field label="Inference rate" suffix="FPS" hint="Pose inferences per second, at most." def={String(ARM_DEFAULTS.inferenceFps)} {...field("arm.inferenceFps")}>
          <input name="arm.inferenceFps" class="w-xs" value={shown("arm.inferenceFps")} placeholder={String(ARM_DEFAULTS.inferenceFps)} inputmode="decimal" />
        </Field>
        <Field label="Encoder" {...field("arm.encoder")}>
          <select name="arm.encoder" class="w-l">
            <option value="hardware" selected={encoder === "hardware"}>
              Hardware H.264, 1280×720
            </option>
            <option value="software" selected={encoder === "software"}>
              Software x264, 640×480 (fallback)
            </option>
          </select>
        </Field>
      </Fold>

      <Section title="USB devices">
        <p class="hint">
          Gaia pins the serial adapter and the camera to their USB ports, so they stay /dev/talos-{id ?? "<id>"}-serial and -camera whichever order they're
          plugged in.
        </p>
        <Field label="Serial adapter" group reset={usbPart("serial", ["idPath", "vendor", "product"])} error={err.of("usb.serial.idPath")}>
          <span class="stack">
            <input name="usb.serial.idPath" value={shown("usb.serial.idPath", "arm.usb.serial.idPath")} placeholder="ID_PATH" aria-label="Serial adapter ID_PATH" />
            <span class="control">
              <label class="inline">
                <span class="affix">Vendor</span>
                <input name="usb.serial.vendor" class="w-xs" value={shown("usb.serial.vendor", "arm.usb.serial.vendor")} />
              </label>
              <label class="inline">
                <span class="affix">Product</span>
                <input name="usb.serial.product" class="w-xs" value={shown("usb.serial.product", "arm.usb.serial.product")} />
              </label>
            </span>
          </span>
        </Field>
        <Field label="Camera" reset={usbPart("camera", ["idPath"])}>
          <input name="usb.camera.idPath" value={shown("usb.camera.idPath", "arm.usb.camera.idPath")} placeholder="ID_PATH" />
        </Field>
        <div class="setting">
          <span class="setting-label" />
          <span class="setting-input">
            <span>
              <button class="btn small" type="button" hx-post="/usb-detect" hx-include="closest form" hx-target="#usb-found" hx-swap="innerHTML">
                <Icon name="search" />
                Detect USB devices
              </button>
            </span>
            <div id="usb-found" />
          </span>
        </div>
        {!adding && (
          <Check
            name="applyUsb"
            label="Re-apply USB rules after saving"
            hint="Runs Troubleshoot › Re-apply USB rules, so new ports take effect. Ticks itself when you change a USB field."
            checked={false}
          />
        )}
      </Section>

      {info && (
        <details class="share">
          <summary>YAML for gaia.config.yaml</summary>
          <p class="hint">To give the whole team this Pi as it's set up here, paste it into gaia.config.yaml and commit, then Reset to shared.</p>
          <div class="copyable">
            <pre class="file" id="pi-yaml">{piYaml(id!, entry)}</pre>
            <button class="btn small" type="button" data-copy="#pi-yaml">
              <Icon name="copy" />
              Copy
            </button>
          </div>
        </details>
      )}

      {removed.length > 0 && (
        <div class="removed">
          <span class="muted">Removed from this computer:</span>
          {removed.map((r) => (
            <button class="btn small" type="button" hx-post={`/pis/${r.id}/reset`}>
              Restore {r.name}
            </button>
          ))}
        </div>
      )}
    </>
  );

  const footer = (
    <>
      <button class="btn primary" type="submit">
        {adding ? "Add Pi" : "Save"}
      </button>
      <button class="btn ghost" type="button" data-close-modal>
        Cancel
      </button>
      <span class="hint save-note">Saved in gaia.local.yaml, on this computer only.</span>
      {info?.origin === "shared" && info.changed.length > 0 && (
        <button
          class="btn ghost"
          type="button"
          hx-post={`/pis/${id}/reset`}
          hx-confirm={`Drop this computer's changes to ${name} and use gaia.config.yaml's settings?`}
          {...confirmAttrs(name, "Reset to shared")}
        >
          Reset to shared
        </button>
      )}
      {!adding && (
        <button
          class="btn ghost danger"
          type="button"
          hx-post={`/pis/${id}/remove`}
          hx-confirm={
            info?.origin === "shared"
              ? `Remove ${name} from Gaia on this computer?\n\nThis doesn't touch the Pi or anyone else's Gaia. Restore it later from Fleet › Add a Pi.`
              : `Remove ${name} from Gaia?\n\nThis doesn't touch the Pi itself.`
          }
          {...confirmAttrs(name, "Remove", "danger")}
        >
          Remove from Gaia
        </button>
      )}
    </>
  );

  return (
    <Modal title={adding ? "Add a Pi" : `${name} · settings`}>
      <SettingsForm action={action} dirty={err.count > 0} body={body} footer={footer} />
    </Modal>
  );
}

export function UsbFound({ result }: { result: DetectResult }) {
  const { devices, error, display } = result;
  return (
    <div class="usb-found">
      <pre class="cmd">$ {display}</pre>
      {error ? (
        <p class="bad-text">{error}</p>
      ) : devices.length === 0 ? (
        <p class="muted">No USB serial adapters or cameras found. Are they plugged in?</p>
      ) : (
        devices.map((d) => {
          const fill =
            d.kind === "serial"
              ? { "usb.serial.idPath": d.idPath, "usb.serial.vendor": d.vendor, "usb.serial.product": d.product }
              : { "usb.camera.idPath": d.idPath };
          return (
            <div class="usb-dev">
              <span class="mono">{d.dev}</span>
              <span>{d.model || `${d.vendor}:${d.product}`}</span>
              {d.port && <span class="muted">port {d.port}</span>}
              <span class="spacer" />
              <button class="btn small" type="button" data-fill={JSON.stringify(fill)} title={d.idPath}>
                {d.kind === "serial" ? "Use as serial adapter" : "Use as camera"}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
