// Backing for the Gaia settings page (src/ui/gaiaSettings.tsx): everything in the config outside
// `pis:` (Pis have their own form) and component sources (the Sources panel).

import { COMPONENTS, saveSection, section, type ComponentId, type FormError, type SectionInfo } from "./config.ts";

type Obj = Record<string, unknown>;
type Body = Record<string, string | File | (string | File)[]>;

/** One settings section: where it lives in the config and which fields the page owns. */
export interface SettingsSection {
  key: string;
  path: string[];
  fields: string[];
}

export const SECTIONS: SettingsSection[] = [
  { key: "commander", path: ["commander"], fields: ["path", "repo", "branch"] },
  { key: "operator", path: ["components", "operator"], fields: ["runTests", "buildArgs"] },
  { key: "vision", path: ["components", "vision"], fields: ["model", "appDir", "extraArgs", "env", "buildArgs"] },
  { key: "camera", path: ["components", "camera"], fields: ["buildArgs"] },
  { key: "mediamtx", path: ["components", "mediamtx"], fields: ["version", "buildArgs"] },
  { key: "stack", path: ["stack"], fields: ["dir", "project"] },
  { key: "server", path: ["server"], fields: ["port"] },
];

export const sectionByKey = (key: string) => SECTIONS.find((s) => s.key === key);

/** The section as saved, minus a component's `source` (that's the Sources panel's). */
export function sectionInfo(s: SettingsSection): SectionInfo {
  const info = section(s.path);
  return { ...info, changed: info.changed.filter((k) => k !== "source") };
}

const str = (b: Body, k: string) => {
  const v = b[k];
  return typeof v === "string" ? v.trim() : "";
};

/** "KEY=value" per line → { KEY: "value" }. */
function parseVars(text: string, field: string, errors: FormError[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) errors.push({ field, message: `"${line}" isn't NAME=value.` });
    else out[m[1]!] = m[2]!;
  }
  return Object.keys(out).length ? out : undefined;
}

export const formatVars = (v: unknown) =>
  v && typeof v === "object"
    ? Object.entries(v as Obj)
        .map(([k, x]) => `${k}=${x}`)
        .join("\n")
    : "";

/** Each section's new value from the form. Blank fields are left out, so the defaults apply. */
export function sectionsFromForm(body: Body): { values: Map<string, Obj>; errors: FormError[] } {
  const errors: FormError[] = [];
  const err = (field: string, message: string) => errors.push({ field, message });
  const values = new Map<string, Obj>();
  for (const s of SECTIONS) {
    const value = { ...sectionInfo(s).value };
    for (const f of s.fields) delete value[f];
    const set = (f: string, v: unknown) => {
      if (v !== undefined && v !== "") value[f] = v;
    };
    const k = (f: string) => `${s.key}.${f}`;
    switch (s.key) {
      case "commander":
        for (const f of s.fields) set(f, str(body, k(f)));
        break;
      case "operator":
        value.runTests = body[k("runTests")] === "on";
        break;
      case "vision":
        set("model", str(body, k("model")));
        set("appDir", str(body, k("appDir")));
        {
          const args = str(body, k("extraArgs")).split(/\s+/).filter(Boolean);
          if (args.length) value.extraArgs = args;
        }
        set("env", parseVars(str(body, k("env")), k("env"), errors));
        break;
      case "mediamtx": {
        const v = str(body, k("version"));
        if (v && !/^[\w.-]+$/.test(v)) err(k("version"), `"${v}" isn't an image tag.`);
        set("version", v);
        break;
      }
      case "stack": {
        const dir = str(body, k("dir"));
        if (dir && (!/^[\w.-]+(\/[\w.-]+)*$/.test(dir) || dir.split("/").includes(".."))) err(k("dir"), `Use a path inside the home folder, like talos-stack.`);
        const project = str(body, k("project"));
        if (project && !/^[a-z0-9][a-z0-9_-]*$/.test(project)) err(k("project"), `Use only lowercase letters, digits, - and _.`);
        set("dir", dir);
        set("project", project);
        break;
      }
      case "server": {
        const v = str(body, k("port"));
        const n = Number(v);
        if (v && (!Number.isInteger(n) || n < 1 || n > 65535)) err(k("port"), `"${v}" isn't a port number.`);
        else if (v) value.port = n;
        break;
      }
    }
    if (COMPONENTS.includes(s.key as ComponentId))
      set("buildArgs", parseVars(str(body, k("buildArgs")), k("buildArgs"), errors));
    values.set(s.key, value);
  }
  return { values, errors };
}

export function saveSections(values: Map<string, Obj>) {
  for (const s of SECTIONS) {
    const v = values.get(s.key);
    if (v) saveSection(s.path, v, ["source"]);
  }
}
