// The Gaia settings page (header › Settings): Commander, each component's build options, the
// stack on each Pi, and Gaia's own port. Pis have their own form (piSettings.tsx) and sources the
// Sources panel; this page links to both rather than repeating them.

import type { Child } from "hono/jsx";
import { COMPONENT_LABEL, COMPONENTS, DEFAULTS, describeSource, type ComponentId, type Config, type FormError } from "../core/config.ts";
import { formatVars, sectionByKey, sectionInfo } from "../core/gaiaSettings.ts";
import { Modal } from "./components.tsx";
import { Icon } from "./icons.tsx";
import { Check, errorsFor, Field, FormErrors, Reveal, Section, SettingsForm, type Fill, type NavItem } from "./settingsForm.tsx";

type Obj = Record<string, unknown>;

const str = (v: unknown) => (v == null ? "" : Array.isArray(v) ? v.join(" ") : String(v));

/** Values to show: what's saved, or (after a failed save) what was submitted. */
type Shown = Record<string, Obj>;

export interface GaiaSettingsProps {
  cfg: Config;
  shown?: Shown;
  /** After a failed save: the form as submitted, so a textarea keeps the line that was wrong. */
  raw?: Record<string, unknown>;
  errors?: FormError[];
}

export function GaiaSettings({ cfg, shown, raw, errors }: GaiaSettingsProps) {
  const info = (key: string) => sectionInfo(sectionByKey(key)!);
  const v = (key: string) => shown?.[key] ?? info(key).value;
  const err = errorsFor(errors);
  const changed = (key: string, f: string) => info(key).changed.includes(f);
  /** A field this computer changes: its reset button puts gaia.config.yaml's value back. */
  const reset = (key: string, f: string, fmt: (v: unknown) => string = str): Fill | undefined =>
    changed(key, f) ? { [`${key}.${f}`]: fmt(info(key).shared?.[f]) } : undefined;
  /** A field's text: as submitted after a failed save (so a wrong value stays put to fix), else as saved. */
  const text = (key: string, f: string, fmt: (v: unknown) => string = str) => {
    const r = raw?.[`${key}.${f}`];
    return typeof r === "string" ? r : fmt(v(key)[f]);
  };
  const textarea = (key: string, f: string) => text(key, f, formatVars);
  const field = (key: string, f: string) => ({ value: text(key, f), reset: reset(key, f), error: err.of(`${key}.${f}`) });

  const SourceLine = ({ c }: { c: ComponentId }) => (
    <Field label="Source" group>
      <span class="mono">{describeSource(cfg.components[c].source)}</span>
      <button class="btn small ghost" type="button" data-open-source={c} title="Change it in the Sources panel">
        <Icon name="pencil" />
        Change
      </button>
    </Field>
  );

  const BuildArgs = ({ c }: { c: ComponentId }) => {
    const name = `${c}.buildArgs`;
    const text = textarea(c, "buildArgs");
    const r = reset(c, "buildArgs", formatVars);
    return (
      <Field label="Build arguments" group reset={r} error={err.of(name)}>
        <Reveal label="Add" open={!!text || !!r || !!err.of(name)}>
          <textarea name={name} rows={2} placeholder="NAME=value">
            {text}
          </textarea>
          <span class="hint">Extra docker --build-arg values, one NAME=value per line.</span>
        </Reveal>
      </Field>
    );
  };

  const commander = v("commander");
  const operator = v("operator");
  const stack = v("stack");
  const stackOpen = info("stack").changed.length > 0 || err.any("stack.dir", "stack.project");
  const envPort = process.env.PORT;

  const sections: Record<ComponentId, Child> = {
    operator: (
      <Section title={COMPONENT_LABEL.operator} id="gs-operator">
        <SourceLine c="operator" />
        <Check
          name="operator.runTests"
          label="Run the tests during the build"
          hint="A failing CppUTest test then means no image, so nothing broken reaches the arm."
          checked={operator.runTests !== false}
          reset={changed("operator", "runTests") ? info("operator").shared?.runTests !== false : undefined}
        />
        <BuildArgs c="operator" />
      </Section>
    ),
    camera: (
      <Section title={COMPONENT_LABEL.camera} id="gs-camera">
        <SourceLine c="camera" />
        <BuildArgs c="camera" />
      </Section>
    ),
    mediamtx: (
      <Section title={COMPONENT_LABEL.mediamtx} id="gs-mediamtx">
        <Field label="Version" hint="The bluenviron/mediamtx image tag. Gaia adds stack/mediamtx.yml to it." def={DEFAULTS.mediamtxVersion} {...field("mediamtx", "version")}>
          <input name="mediamtx.version" class="w-xs" value={text("mediamtx", "version")} placeholder={DEFAULTS.mediamtxVersion} />
        </Field>
        <BuildArgs c="mediamtx" />
      </Section>
    ),
    vision: (
      <Section title={COMPONENT_LABEL.vision} id="gs-vision">
        <SourceLine c="vision" />
        <Field label="Pose model" hint="Relative to the repository root." {...field("vision", "model")}>
          <input name="vision.model" class="w-m" value={text("vision", "model")} placeholder={DEFAULTS.visionModel} />
        </Field>
        <Field label="App folder" hint="The folder with main.py, relative to the repository root." {...field("vision", "appDir")}>
          <input name="vision.appDir" class="w-m" value={text("vision", "appDir")} placeholder={DEFAULTS.visionAppDir} />
        </Field>
        <Field label="Extra arguments" hint="Added to python main.py --model … --port … --edge-control. Separated by spaces." {...field("vision", "extraArgs")}>
          <input name="vision.extraArgs" value={text("vision", "extraArgs")} placeholder="--processing-width 640" />
        </Field>
        <Field label="Environment" hint="One NAME=value per line, e.g. POSE_THREADS (onnxruntime threads)." reset={reset("vision", "env", formatVars)} error={err.of("vision.env")}>
          <textarea name="vision.env" rows={3} placeholder="POSE_THREADS=2">
            {textarea("vision", "env")}
          </textarea>
        </Field>
        <BuildArgs c="vision" />
      </Section>
    ),
  };

  const body = (
    <>
      <FormErrors errors={err.general} />

      <Section title="Commander" id="gs-commander">
        <Field label="Checkout folder" hint="Relative to this Gaia checkout. Gaia clones Commander here on Set up." {...field("commander", "path")}>
          <input name="commander.path" class="w-m" value={text("commander", "path")} placeholder={DEFAULTS.commanderPath} />
        </Field>
        <Field label="Repository" {...field("commander", "repo")}>
          <input name="commander.repo" value={text("commander", "repo")} placeholder={DEFAULTS.commanderRepo} />
        </Field>
        <Field label="Branch" hint="What Set up clones. To switch an existing checkout, use Branch on the Commander card." {...field("commander", "branch")}>
          <input name="commander.branch" class="w-m" value={text("commander", "branch")} placeholder={DEFAULTS.commanderBranch} />
        </Field>
      </Section>

      {COMPONENTS.map((c) => sections[c])}

      <Section title="Stack on each Pi" id="gs-stack">
        <Field label="Folder" hint="On each Pi, relative to the SSH user's home." group extraClass="ro">
          <span class="mono">{cfg.stack.dir}</span>
        </Field>
        <Field label="Compose project" hint={`Containers are named <project>-<service>-1, e.g. ${cfg.stack.project}-operator-1.`} group extraClass="ro">
          <span class="mono">{cfg.stack.project}</span>
        </Field>
        <Reveal label="Change on this computer" icon="pencil" block open={stackOpen}>
          <p class="hint warn-text">
            Everyone deploying to the same Pis must use the same values, so change these in gaia.config.yaml for the whole team. Stop each Pi's stack first:
            containers started under the old name keep running and holding the camera.
          </p>
          <Field label="Folder" hint="On each Pi, relative to the SSH user's home." {...field("stack", "dir")}>
            <input name="stack.dir" class="w-m" value={text("stack", "dir")} placeholder={DEFAULTS.stackDir} />
          </Field>
          <Field label="Compose project" hint="Containers are named <project>-<service>-1." {...field("stack", "project")}>
            <input name="stack.project" class="w-m" value={text("stack", "project")} placeholder={DEFAULTS.stackProject} />
          </Field>
        </Reveal>
      </Section>

      <Section title="This computer" id="gs-server">
        <Field
          label="Gaia's port"
          hint={envPort ? `Gaia is using port ${envPort} from the PORT environment variable, which overrides this.` : "Takes effect when Gaia restarts. Gaia only listens on localhost."}
          def={String(DEFAULTS.port)}
          {...field("server", "port")}
        >
          <input name="server.port" class="w-xs" value={text("server", "port")} placeholder={String(DEFAULTS.port)} inputmode="numeric" />
        </Field>
      </Section>

      <Section title="Pis" id="gs-pis">
        <Field label="Settings" hint="Each Pi has its own, also under More › Settings on its card." group>
          <span class="control wrap">
            {cfg.pis.map((p) => (
              <button class="btn small" type="button" hx-get={`/pis/${p.id}/settings`} hx-target="#modal-body">
                <Icon name="settings" />
                {p.name}
              </button>
            ))}
            <button class="btn small ghost" type="button" hx-get="/fleet/add" hx-target="#modal-body">
              <Icon name="plus" />
              Add a Pi
            </button>
          </span>
        </Field>
      </Section>
    </>
  );

  const nav: NavItem[] = [
    { id: "gs-commander", label: "Commander", changed: info("commander").changed.length > 0 },
    ...COMPONENTS.map((c) => ({ id: `gs-${c}`, label: COMPONENT_LABEL[c], changed: info(c).changed.length > 0 })),
    { id: "gs-stack", label: "Stack on each Pi", changed: info("stack").changed.length > 0 },
    { id: "gs-server", label: "This computer", changed: info("server").changed.length > 0 },
    { id: "gs-pis", label: "Pis" },
  ];

  const footer = (
    <>
      <button class="btn primary" type="submit">
        Save
      </button>
      <button class="btn ghost" type="button" data-close-modal>
        Cancel
      </button>
      <span class="hint save-note">Saved in gaia.local.yaml, on this computer only. Shared defaults come from gaia.config.yaml.</span>
    </>
  );

  return (
    <Modal title="Gaia settings">
      <SettingsForm action="/settings" dirty={err.count > 0} body={body} footer={footer} nav={nav} />
    </Modal>
  );
}
