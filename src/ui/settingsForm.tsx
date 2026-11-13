// Building blocks shared by the settings forms (Gaia settings, Pi settings): a scrolling body with
// a pinned footer, labelled rows, and per-field "changed on this computer" marks with a reset
// button. Resetting happens in the browser (app.js fills in the shared value), so it never throws
// away other edits; Save writes it like any other change.

import type { Child } from "hono/jsx";
import type { FormError } from "../core/config.ts";
import { Icon, type IconName } from "./icons.tsx";

/** Input name → value a reset button fills in (booleans tick or untick a checkbox). */
export type Fill = Record<string, string | boolean>;

function ResetButton({ fill }: { fill: Fill }) {
  const values = Object.values(fill);
  const one = values.length === 1 && typeof values[0] === "string" ? (values[0] as string) : undefined;
  const title = one !== undefined ? `Use the shared value from gaia.config.yaml${one ? `: ${one}` : " (the default)"}` : "Use the shared values from gaia.config.yaml";
  return (
    <button class="btn small ghost icon-only reset" type="button" data-fill={JSON.stringify(fill)} data-reset title={title} aria-label={title}>
      <Icon name="undo" />
    </button>
  );
}

const ChangedMark = () => <span class="changed-mark" title="Changed on this computer (gaia.local.yaml)" />;

export interface FieldProps {
  label: string;
  hint?: Child;
  children: Child;
  /** Text right before the input, e.g. "rtsp://bingo.local:8554/". */
  prefix?: Child;
  /** Text right after it, e.g. "FPS". */
  suffix?: Child;
  /** Set when this computer changes the field: what its reset button fills in. */
  reset?: Fill;
  /** The default, shown next to the input while it holds something else. */
  def?: string;
  value?: string;
  error?: string;
  /** Several controls or a fold inside: a <div>, since a <label> would forward clicks to the first input. */
  group?: boolean;
  extraClass?: string;
}

export function Field({ label, hint, children, prefix, suffix, reset, def, value, error, group, extraClass }: FieldProps) {
  const Tag = group ? "div" : "label";
  return (
    <Tag class={`setting${reset ? " changed" : ""}${error ? " invalid" : ""}${extraClass ? ` ${extraClass}` : ""}`}>
      {reset && <ChangedMark />}
      <span class="setting-label">{label}</span>
      <span class="setting-input">
        <span class="control">
          {prefix && <span class="affix">{prefix}</span>}
          {children}
          {suffix && <span class="affix">{suffix}</span>}
          {def !== undefined && value && value !== def && <span class="hint default">default {def}</span>}
          {reset && <ResetButton fill={reset} />}
        </span>
        {error && <span class="field-error">{error}</span>}
        {hint && <span class="hint">{hint}</span>}
      </span>
    </Tag>
  );
}

/** A checkbox row: the box and its label sit in the input column. */
export function Check({ name, label, hint, checked, reset }: { name: string; label: string; hint?: Child; checked: boolean; reset?: boolean }) {
  return (
    <div class={`setting${reset !== undefined ? " changed" : ""}`}>
      {reset !== undefined && <ChangedMark />}
      <span class="setting-label" />
      <span class="setting-input">
        <span class="control">
          <label class="check">
            <input type="checkbox" name={name} checked={checked} /> {label}
          </label>
          {reset !== undefined && <ResetButton fill={{ [name]: reset }} />}
        </span>
        {hint && <span class="hint check-hint">{hint}</span>}
      </span>
    </div>
  );
}

export function Section({ title, children, id }: { title: string; children: Child; id?: string }) {
  return (
    <section class="form-section" id={id}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

/** A section folded away by default. */
export function Fold({ title, open, children }: { title: string; open?: boolean; children: Child }) {
  return (
    <details class="form-section fold" open={open || undefined}>
      <summary>
        <h4>{title}</h4>
      </summary>
      <div class="fold-body">{children}</div>
    </details>
  );
}

/**
 * Controls hidden behind a small button until they're needed (or already have a value). `block`:
 * whole rows inside, with the button lined up with the inputs above it.
 */
export function Reveal({ label, open, icon = "plus", block, children }: { label: string; open?: boolean; icon?: IconName; block?: boolean; children: Child }) {
  return (
    <details class={`reveal${block ? " block" : ""}`} open={open || undefined}>
      <summary class="btn small ghost">
        <Icon name={icon} />
        {label}
      </summary>
      {children}
    </details>
  );
}

/** Errors that don't belong to one field (field errors show under their input). */
export function FormErrors({ errors }: { errors: FormError[] }) {
  return errors.length > 0 ? (
    <ul class="form-errors">
      {errors.map((e) => (
        <li>{e.message}</li>
      ))}
    </ul>
  ) : null;
}

/** A field's error, plus the errors that have no field of their own. */
export function errorsFor(errors: FormError[] | undefined) {
  const list = errors ?? [];
  return {
    of: (field: string) => list.find((e) => e.field === field)?.message,
    any: (...fields: string[]) => list.some((e) => e.field && fields.includes(e.field)),
    general: list.filter((e) => !e.field),
    count: list.length,
  };
}

export interface NavItem {
  id: string;
  label: string;
  /** Something in the section is changed on this computer. */
  changed?: boolean;
}

/**
 * The form layout: `body` scrolls, `footer` (Save, Cancel, …) stays put. With `nav`, a list of the
 * sections sits beside the body (app.js scrolls to them and marks the one in view). `data-dirty`
 * makes the form count as changed even before an edit (it came back with errors, so nothing's saved).
 */
export function SettingsForm({ action, dirty, body, footer, nav }: { action: string; dirty?: boolean; body: Child; footer: Child; nav?: NavItem[] }) {
  const scroller = (
    <div class="settings-body" tabindex={-1}>
      {body}
    </div>
  );
  return (
    <form class={`settings-form${nav ? " has-nav" : ""}`} hx-post={action} hx-target="#modal-body" data-dirty={dirty ? "1" : undefined}>
      {nav ? (
        <div class="settings-main">
          <nav class="settings-nav" aria-label="Sections">
            {nav.map((n, i) => (
              <a href={`#${n.id}`} data-nav={n.id} aria-current={i === 0 ? "true" : undefined}>
                {n.label}
                {n.changed && <span class="changed-mark inline" title="Changed on this computer (gaia.local.yaml)" />}
              </a>
            ))}
          </nav>
          {scroller}
        </div>
      ) : (
        scroller
      )}
      <footer class="form-buttons">{footer}</footer>
    </form>
  );
}
