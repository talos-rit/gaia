import type { Child } from "hono/jsx";
import { ACTIONS, homeWarning, TROUBLESHOOT_GROUPS, type Action } from "../core/actions.ts";
import { COMPONENT_LABEL, COMPONENTS, localOverrideFor, sharedSource, type ComponentId, type Config, type PiCfg } from "../core/config.ts";
import { displayStep, type Job } from "../core/jobs.ts";
import { knownAddress, sshDisplay } from "../core/ssh.ts";
import { compose, docker } from "../core/stack.ts";
import {
  componentHealth,
  containerFor,
  fmtAge,
  getState,
  hostHealth,
  piLevel,
  type Container,
  type Level,
  type Manifest,
  type PiState,
} from "../core/status.ts";
import { busyJob } from "../core/jobs.ts";
import { Icon, type IconName } from "./icons.tsx";

const LEVEL_TITLE: Record<Level, string> = {
  ok: "healthy",
  partial: "online; not everything is running",
  warn: "needs attention",
  bad: "problem",
  off: "stopped",
  unknown: "unknown",
};

export const Dot = ({ level, title }: { level: Level; title?: string }) => <span class={`dot ${level}`} title={title ?? LEVEL_TITLE[level]} />;

/**
 * Data attributes for app.js's confirm dialog (replaces the browser's confirm()). The message
 * itself stays in hx-confirm; these name the subject, the button, and the tone.
 */
export const confirmAttrs = (subject: string, action: string, tone?: "home" | "danger") => ({
  "data-confirm-subject": subject,
  "data-confirm-action": action,
  "data-confirm-tone": tone,
});

export function Layout({ title, children }: { title: string; children: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/static/app.css" />
        <script src="/vendor/htmx.min.js" />
        <script src="/static/app.js" defer />
      </head>
      <body hx-headers='{"X-Gaia": "1"}'>{children}</body>
    </html>
  );
}

/** Hover card listing exactly what a button runs. */
export function Peek({ title, description, commands }: { title: string; description?: string; commands: string[] }) {
  return (
    <span class="peek" role="tooltip">
      <b>{title}</b>
      {description && <p>{description}</p>}
      <pre>{commands.map((c) => `$ ${c}`).join("\n\n")}</pre>
    </span>
  );
}

function commandsFor(a: Action, cfg: Config, pi: PiCfg, service?: ComponentId): string[] {
  return a.steps(cfg, pi, service).map((s) => displayStep(s, pi));
}

/** Service/stack buttons hide by state: `running` ones only show while something runs, `stopped` ones while something is stopped. */
type When = "running" | "stopped";

const ACTION_ICON: Record<string, IconName> = {
  start: "play",
  stop: "stop",
  restart: "restart",
  poweroff: "power",
  "svc-start": "play",
  "svc-stop": "stop",
  "svc-restart": "restart",
};

export function ActionButton({
  action,
  cfg,
  pi,
  service,
  variant,
  label,
  when,
}: {
  action: Action;
  cfg: Config;
  pi: PiCfg;
  service?: ComponentId;
  variant?: string;
  label?: string;
  when?: When;
}) {
  const confirm = action.confirm?.(pi, service);
  const tone = action.danger ? "danger" : confirm && confirm === homeWarning(pi) ? "home" : undefined;
  const what = service ? `${action.label} ${COMPONENT_LABEL[service]}` : action.scope === "stack" && !action.danger ? `${action.label} ${pi.name}` : action.label;
  const icon = variant?.includes("menu-item") ? undefined : ACTION_ICON[action.id];
  return (
    <span class={`act${when ? ` when-${when}` : ""}`}>
      <button
        class={`btn ${variant ?? ""}`}
        hx-post={`/pis/${pi.id}/actions/${action.id}`}
        hx-vals={service ? JSON.stringify({ service }) : undefined}
        hx-confirm={confirm}
        {...(confirm ? confirmAttrs(pi.name, what, tone) : {})}
        hx-target="#jobs"
        hx-swap="afterbegin"
      >
        {icon && <Icon name={icon} />}
        <span class="btn-label">{label ?? action.label}</span>
      </button>
      <Peek
        title={`${action.label}${service ? ` ${COMPONENT_LABEL[service]}` : ""} on ${pi.name}`}
        description={action.description}
        commands={commandsFor(action, cfg, pi, service)}
      />
    </span>
  );
}

const act = (id: string) => ACTIONS.find((a) => a.id === id)!;

export function deployPreview(cfg: Config, pi: PiCfg): string[] {
  const tgt = `${pi.user}@${knownAddress(pi)}`;
  return [
    "docker info",
    ...COMPONENTS.map((c) => {
      const s = cfg.components[c].source;
      return s.mode === "git"
        ? `git fetch --depth 1 ${s.repo} ${s.ref} && git archive <sha> | tar -x -C .cache/ctx/${c}`
        : s.mode === "local"
          ? `git ls-files -co --exclude-standard (in ${s.path}) | tar … -C .cache/ctx/${c}`
          : `# ${c}: no source, built from stack/${c}.Dockerfile`;
    }),
    `docker buildx build --platform linux/arm64 --load -f stack/<component>.Dockerfile -t talos/<component>:<rev> .cache/ctx/<component>   # ×${COMPONENTS.length}, skipped if cached`,
    `docker save talos/<component>:<rev> | gzip | ${sshDisplay(tgt, `gunzip | ${docker(pi)} load`)}   # only layers the Pi lacks`,
    `tar compose.yaml operator.conf bin/talos … | ${sshDisplay(tgt, `cd ~/${cfg.stack.dir} && tar -xf -`)}`,
    sshDisplay(tgt, `cd ~/${cfg.stack.dir} && ${compose(pi)} config --quiet`),
    sshDisplay(tgt, "talos retire-host-mediamtx"),
    sshDisplay(tgt, "talos start"),
  ];
}

export function DeployButton({ cfg, pi }: { cfg: Config; pi: PiCfg }) {
  return (
    <span class="act">
      <button
        class="btn primary"
        hx-post="/deploy"
        hx-vals={JSON.stringify({ targets: pi.id, start: "on" })}
        hx-confirm={
          pi.arm.homesOnStart
            ? `Build and deploy the configured sources to ${pi.name}, then start it.\n\nIf Operator's image changed, its container is recreated and the arm HOMEs. Is the workspace clear?`
            : `Build and deploy the configured sources to ${pi.name}, then start it?`
        }
        {...confirmAttrs(pi.name, `Deploy to ${pi.name}`, pi.arm.homesOnStart ? "home" : undefined)}
        hx-target="#jobs"
        hx-swap="afterbegin"
      >
        <Icon name="upload" />
        Deploy
      </button>
      <Peek title={`Deploy to ${pi.name}`} description="Build images on this machine, copy them to the Pi over SSH, write compose.yaml, start." commands={deployPreview(cfg, pi)} />
    </span>
  );
}

export function PiCard({ cfg, pi }: { cfg: Config; pi: PiCfg }) {
  const troubleshoot = ACTIONS.filter((a) => a.scope === "troubleshoot" && (a.applies?.(pi, cfg) ?? true));
  return (
    <section class="pi card" id={`pi-${pi.id}`}>
      <header class="pi-head">
        <span id={`dot-${pi.id}`}>
          <Dot level="unknown" />
        </span>
        <h2>{pi.name}</h2>
        <span class="muted mono" id={`addr-${pi.id}`}>
          {pi.user}@{pi.host}
        </span>
        <span class="tags">
          <span class="tag">{pi.arm.controller}</span>
          {pi.arm.homesOnStart && <span class="tag warn" title="Starting Operator physically homes this arm">homes on start</span>}
        </span>
      </header>

      <div class="toolbar">
        <ActionButton action={act("start")} cfg={cfg} pi={pi} variant="good" when="stopped" />
        <ActionButton action={act("stop")} cfg={cfg} pi={pi} when="running" />
        <ActionButton action={act("restart")} cfg={cfg} pi={pi} when="running" />
        <DeployButton cfg={cfg} pi={pi} />
        <ActionButton action={act("poweroff")} cfg={cfg} pi={pi} variant="danger" />
        <span class="spacer" />
        <span class="toolbar-menus">
        <details class="menu">
          <summary class="btn ghost" title="Troubleshoot">
            <Icon name="wrench" />
            <span class="btn-label">Troubleshoot</span>
          </summary>
          <div class="menu-list">
            {TROUBLESHOOT_GROUPS.map((g) => {
              const items = troubleshoot.filter((a) => a.group === g);
              return (
                items.length > 0 && (
                  <div class="menu-group">
                    <div class="menu-heading">{g}</div>
                    {items.map((a) => (
                      <ActionButton action={a} cfg={cfg} pi={pi} variant="menu-item" />
                    ))}
                    {g === "Containers & disk" && <ActionButton action={act("down")} cfg={cfg} pi={pi} variant="menu-item danger" />}
                  </div>
                )
              );
            })}
          </div>
        </details>
        <details class="menu">
          <summary class="btn ghost icon-only" title="More">
            <Icon name="more" />
            <span class="sr-only">More</span>
          </summary>
          <div class="menu-list">
            <button class="btn menu-item" hx-get={`/pis/${pi.id}/settings`} hx-target="#modal-body">
              Settings
            </button>
            <button class="btn menu-item" hx-get={`/pis/${pi.id}/files`} hx-target="#modal-body">
              Generated files (compose.yaml, udev rules…)
            </button>
            <button class="btn menu-item" hx-get={`/probe?pi=${pi.id}`} hx-target="#modal-body">
              How is status checked?
            </button>
            <a class="btn menu-item" href={`http://${knownAddress(pi)}:${pi.arm.visionPort}/`} target="_blank" rel="noreferrer">
              Pi-Vision dashboard <Icon name="external" />
            </a>
          </div>
        </details>
        </span>
      </div>

      <div id={`deployed-${pi.id}`} class="deployed muted" />

      <div class="components">
        {COMPONENTS.map((c) => (
          <div class="comp">
            <div class="comp-main" id={`comp-${pi.id}-${c}`}>
              <Dot level="unknown" /> <b>{COMPONENT_LABEL[c]}</b> <span class="muted">…</span>
            </div>
            <div class="comp-actions">
              <button class="btn small" hx-get={`/pis/${pi.id}/logs/${c}`} hx-target="#modal-body" title="Tail container logs">
                <Icon name="logs" />
                <span class="btn-label">Logs</span>
              </button>
              {c === "operator" && (
                <button class="btn small" hx-get={`/pis/${pi.id}/logs/operator?file=1`} hx-target="#modal-body" title="tail -F ~/talos-stack/logs/operator.log">
                  <Icon name="file" />
                  <span class="btn-label">Log file</span>
                </button>
              )}
              {c === "camera" && (
                <button class="btn small" hx-get={`/pis/${pi.id}/snapshot`} hx-target="#modal-body" title="Grab one frame from the RTSP stream">
                  <Icon name="camera" />
                  <span class="btn-label">Snapshot</span>
                </button>
              )}
              <ActionButton action={act("svc-restart")} cfg={cfg} pi={pi} service={c} variant="small" when="running" />
              <ActionButton action={act("svc-stop")} cfg={cfg} pi={pi} service={c} variant="small" when="running" />
              <ActionButton action={act("svc-start")} cfg={cfg} pi={pi} service={c} variant="small" when="stopped" />
            </div>
          </div>
        ))}
      </div>

      <div id={`host-${pi.id}`} class="host muted" />
      <div hx-get={`/pis/${pi.id}/status`} hx-trigger="load, every 3s" hx-swap="none" />
    </section>
  );
}

function ago(iso?: string) {
  return iso ? fmtAge((Date.now() - Date.parse(iso)) / 1000) + " ago" : "?";
}

/** Is the service's container running? Drives which Start/Stop/Restart buttons show (see app.css). */
function runState(st: PiState, ctr: Container | undefined): "running" | "stopped" | "unknown" {
  if (!st.data) return "unknown";
  return ctr?.state === "running" ? "running" : "stopped";
}

/** "8bb425f (feat/x)" for what was deployed, plus a warning when the container runs something else. */
function Revision({ manifest, c, ctr }: { manifest: Manifest | null | undefined; c: ComponentId; ctr: Container | undefined }) {
  const m = manifest?.components[c];
  if (!m) return null;
  const stale = ctr?.state === "running" && m.image && ctr.image !== m.image;
  return (
    <span class="rev" title={`${m.ref ? `${m.ref} · ` : ""}${m.image}`}>
      {m.revision ? m.revision.slice(0, 7) : m.image.split(":")[1]}
      {m.dirty && <span class="tag warn">dirty</span>}
      {stale && <span class="tag bad" title={`running ${ctr!.image}`}>running older image</span>}
    </span>
  );
}

/** One host reading; `level` colours the value when it's out of range. */
const Stat = ({ k, v, level }: { k: string; v: Child; level?: "warn" | "bad" }) => (
  <span class={`stat${level ? ` ${level}` : ""}`}>
    <span class="k">{k}</span> {v}
  </span>
);

const over = (v: number | null | undefined, warn: number, bad: number) => (v == null ? undefined : v >= bad ? "bad" : v >= warn ? "warn" : undefined);

/** Out-of-band fragments that refresh the dynamic parts of a Pi card. */
export function PiStatus({ cfg, pi }: { cfg: Config; pi: PiCfg }) {
  const st: PiState = getState(pi.id);
  const d = st.data;
  const host = hostHealth(cfg, pi, st);
  const level = piLevel(cfg, pi, st);
  const busy = busyJob(pi.id);
  const manifest = d?.stack.manifest;
  return (
    <>
      <span id={`dot-${pi.id}`} hx-swap-oob="true">
        <Dot level={level} />
      </span>
      <a id={`chip-${pi.id}`} hx-swap-oob="true" class="chip" href={`#pi-${pi.id}`} data-name={pi.name}>
        <Dot level={level} /> {pi.name}
        {busy && <span class="muted"> · {busy.title}…</span>}
      </a>
      <span id={`addr-${pi.id}`} hx-swap-oob="true" class="muted mono">
        {pi.user}@{knownAddress(pi)}
        {knownAddress(pi) !== pi.host && <span class="tag warn" title={`${pi.host} did not answer; using a fallback address`}>fallback</span>}
      </span>

      <div id={`deployed-${pi.id}`} hx-swap-oob="true" class="deployed muted">
        {!d ? null : manifest ? (
          <span title={COMPONENTS.map((c) => manifest.components[c]?.image).filter(Boolean).join("\n")}>
            Deployed {ago(manifest.deployedAt)} by {manifest.deployedBy}
          </span>
        ) : d.stack.deployed ? (
          "Deployed without a Gaia manifest"
        ) : (
          <span>Nothing deployed by Gaia yet. Use Deploy.</span>
        )}
      </div>

      {COMPONENTS.map((c) => {
        const h = componentHealth(cfg, pi, st, c);
        const ctr = containerFor(cfg, d, c);
        // The summary often *is* the container status ("Exited (0) 16 minutes ago"); don't say it twice.
        const status = ctr && !h.summary.includes(ctr.status) ? ctr.status : undefined;
        return (
          <div
            id={`comp-${pi.id}-${c}`}
            hx-swap-oob="true"
            class="comp-main"
            data-run={runState(st, ctr)}
            title={ctr ? `${ctr.name} · ${ctr.image}` : undefined}
          >
            <Dot level={h.level} /> <b>{COMPONENT_LABEL[c]}</b> <span>{h.summary}</span>
            <div class="comp-details muted">
              {(status || manifest?.components[c]) && (
                <span class="meta">
                  {status && <span>{status}</span>}
                  <Revision manifest={manifest} c={c} ctr={ctr} />
                </span>
              )}
              {h.details.filter(Boolean).map((x) => (
                <span>{x}</span>
              ))}
            </div>
          </div>
        );
      })}

      <div id={`host-${pi.id}`} hx-swap-oob="true" class="host muted">
        {busy && <div class="busy">{busy.title} in progress…</div>}
        {d ? (
          <div class="stats" title={`${d.host.hostname} · kernel ${d.host.kernel} · probe took ${st.probeMs} ms`}>
            <Stat k="up" v={fmtAge(d.host.uptime_s)} />
            <Stat k="temp" v={d.host.temp_c == null ? "?" : `${d.host.temp_c}°C`} level={over(d.host.temp_c, 70, 80)} />
            <Stat k="load" v={d.host.load.toFixed(2)} level={over(d.host.load, 3.5, 6)} />
            <Stat
              k="mem"
              v={`${(d.host.mem_avail_mb / 1024).toFixed(1)} / ${(d.host.mem_total_mb / 1024).toFixed(1)} GB free`}
              level={d.host.mem_avail_mb < 150 ? "bad" : d.host.mem_avail_mb < 300 ? "warn" : undefined}
            />
            <Stat k="disk" v={`${d.host.disk_free_gb} GB free`} level={d.host.disk_free_gb < 1 ? "bad" : d.host.disk_free_gb < 3 ? "warn" : undefined} />
            {!d.runtime.up && <Stat k="docker" v="down" level="bad" />}
            <span class="spacer" />
            <span class="polled">polled {st.at ? fmtAge((Date.now() - st.at) / 1000) : "?"} ago</span>
          </div>
        ) : (
          <div>{st.reachable === null ? "Connecting…" : `Unreachable: ${st.error}`}</div>
        )}
        {host.details.length > 0 && (
          <ul class="issues">
            {host.details.map((x) => (
              <li>{x}</li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

const STEP_ICON: Record<string, string> = { pending: "○", running: "◌", ok: "✓", failed: "✗", skipped: "–", warn: "!" };

export function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function JobView({ job }: { job: Job }) {
  return (
    <details class={`job ${job.status}`} data-job={job.id} data-status={job.status} data-started={job.startedAt} open={job.status === "running" || undefined}>
      <summary>
        <span class={`chip-status ${job.status}`}>{job.status}</span> <b>{job.title}</b>{" "}
        <span class="muted">
          {new Date(job.startedAt).toLocaleTimeString()}
          <span class="dur">{job.endedAt ? ` · took ${fmtDuration(job.endedAt - job.startedAt)}` : ""}</span>
        </span>
      </summary>
      <ol class="steps">
        {job.status !== "running" &&
          job.steps.map((s, i) => (
            <li data-i={i} class={s.status}>
              <div class="step-head">
                <span class={`st ${s.status}`}>{STEP_ICON[s.status]}</span> <span class="label">{s.label}</span>
                {s.status === "skipped" && <span class="step-note">skipped</span>}
              </div>
              <pre class="cmd">$ {s.display}</pre>
              <pre class="out">{s.lines.map((l) => l.text).join("\n")}</pre>
            </li>
          ))}
      </ol>
    </details>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div class="job failed note">
      <b>Not started:</b> {message}
    </div>
  );
}

export function SourcesPanel({ cfg }: { cfg: Config }) {
  return (
    <section class="card sources" id="sources">
      <h3>Sources</h3>
      <p class="muted">
        What Deploy builds. Shared defaults come from <span class="mono">gaia.config.yaml</span>; your edits here go to the git-ignored{" "}
        <span class="mono">gaia.local.yaml</span>.
      </p>
      <div class="src-list">
        {COMPONENTS.map((c) => {
          const s = cfg.components[c].source;
          const override = localOverrideFor(c);
          return (
            <div class="src" data-source={c}>
              <div class="src-head">
                <b>{COMPONENT_LABEL[c]}</b>
                <span class={`tag ${s.mode}`}>{s.mode === "git" ? "pinned ref" : s.mode === "local" ? "working copy" : "built-in"}</span>
                {override && <span class="tag" title="Overridden in gaia.local.yaml">local override</span>}
                <span class="spacer" />
                {s.mode !== "builtin" && (
                  <details class="menu right">
                    <summary class="btn small ghost">
                      <Icon name="pencil" />
                      Change
                    </summary>
                    <form class="menu-list form" hx-post={`/sources/${c}`} hx-target="#sources" hx-swap="outerHTML">
                      <label>
                        <input type="radio" name="mode" value="git" checked={s.mode === "git"} /> Pinned branch/tag/commit from a remote
                      </label>
                      <input name="repo" placeholder="https://github.com/talos-rit/…" value={s.mode === "git" ? s.repo : defaultRepo(c)} />
                      <input name="ref" placeholder="branch, tag or commit" value={s.mode === "git" ? s.ref : defaultRef(c)} />
                      <label>
                        <input type="radio" name="mode" value="local" checked={s.mode === "local"} /> Working copy on this machine
                      </label>
                      <input name="path" placeholder={defaultPath(c) || "../repo"} value={s.mode === "local" ? s.path : defaultPath(c)} />
                      <div class="row">
                        <button class="btn primary" type="submit">
                          Save
                        </button>
                        {override && (
                          <button class="btn ghost" type="button" hx-post={`/sources/${c}/reset`} hx-target="#sources" hx-swap="outerHTML">
                            Reset to shared default
                          </button>
                        )}
                      </div>
                    </form>
                  </details>
                )}
              </div>
              {s.mode !== "builtin" && <div class="mono">{s.mode === "git" ? repoName(s.repo) : `working copy ${s.path}`}</div>}
              <div class="mono muted" hx-get={`/sources/${c}/resolve`} hx-trigger="load" hx-swap="innerHTML">
                resolving…
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// The ref is on the resolve line below ("feat/x → 8bb425f"), so the repo line leaves it out.
const repoName = (repo: string) => repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");

// Prefill the field that isn't active from the shared gaia.config.yaml, so switching between
// "pinned ref" and "working copy" offers this component's own repo, not someone else's.
const sharedGit = (c: ComponentId) => {
  const s = sharedSource(c);
  return s?.mode === "git" ? s : undefined;
};
const defaultRepo = (c: ComponentId) => sharedGit(c)?.repo ?? "";
const defaultRef = (c: ComponentId) => sharedGit(c)?.ref ?? "";
const defaultPath = (c: ComponentId) => {
  const s = sharedSource(c);
  if (s?.mode === "local") return s.path;
  const name = sharedGit(c)?.repo.replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "");
  return name ? `../${name}` : "";
};

export function FleetPanel({ cfg }: { cfg: Config }) {
  const homing = cfg.pis.filter((p) => p.arm.homesOnStart);
  const everyone = cfg.pis.map((p) => p.name).join(", ");
  const FLEET_ICON: Record<string, IconName> = { start: "play", stop: "stop", restart: "restart" };
  return (
    <section class="card fleet">
      <div class="card-head">
        <h3>Fleet</h3>
        <span class="spacer" />
        <button class="btn small ghost" hx-get="/fleet/add" hx-target="#modal-body">
          <Icon name="plus" />
          Add a Pi
        </button>
      </div>
      {cfg.pis.length === 0 && <p class="muted">No Pis on this computer yet.</p>}
      <div class="chips">
        {cfg.pis.map((pi) => (
          <a id={`chip-${pi.id}`} class="chip" href={`#pi-${pi.id}`} data-name={pi.name}>
            <Dot level="unknown" /> {pi.name}
          </a>
        ))}
      </div>
      {cfg.pis.length > 0 && (
        <>
          <form class="deploy-form group" hx-post="/deploy" hx-target="#jobs" hx-swap="afterbegin" data-homing={homing.map((p) => p.id).join(",")}>
            <h4>Deploy</h4>
            <div class="field">
              <span class="field-label">To</span>
              {cfg.pis.map((pi) => (
                <label>
                  <input type="checkbox" name="targets" value={pi.id} checked /> {pi.name}
                </label>
              ))}
            </div>
            <div class="field">
              <span class="field-label">Options</span>
              <label title="Run docker compose up -d after copying. Unchecked = only stage the new images and files.">
                <input type="checkbox" name="start" checked /> start after deploy
              </label>
              <label title="Rebuild even if an image with identical inputs exists">
                <input type="checkbox" name="force" /> force rebuild
              </label>
            </div>
            <div class="row">
              <button class="btn primary" type="submit">
                <Icon name="upload" />
                Build &amp; deploy
              </button>
              <button class="btn" type="submit" name="buildOnly" value="1" title="Build the arm64 images locally without touching any Pi">
                <Icon name="package" />
                Build only
              </button>
            </div>
          </form>
          <div class="group">
            <h4>All Pis</h4>
            <div class="row wrap">
              {["start", "stop", "restart"].map((a) => {
                const label = `${a[0]!.toUpperCase() + a.slice(1)} all`;
                const confirm = a !== "stop" && homing.length ? `${label}? This HOMEs: ${homing.map((p) => p.name).join(", ")}.\n\nIs every workspace clear?` : undefined;
                return (
                  <button
                    class="btn small"
                    hx-post={`/fleet/${a}`}
                    hx-target="#jobs"
                    hx-swap="afterbegin"
                    hx-confirm={confirm}
                    {...(confirm ? confirmAttrs(everyone, label, "home") : {})}
                  >
                    <Icon name={FLEET_ICON[a]!} />
                    {label}
                  </button>
                );
              })}
              <button
                class="btn small danger"
                hx-post="/fleet/poweroff"
                hx-target="#jobs"
                hx-swap="afterbegin"
                hx-confirm={`End of day: stop every stack and shut down ${everyone}?\n\nUnplug only after each Pi's green LED stops flickering.`}
                {...confirmAttrs(everyone, "Power off all", "danger")}
                title="Stop containers, then sudo systemctl poweroff on every Pi"
              >
                <Icon name="power" />
                Power off all
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export function Modal({ title, children }: { title: string; children: Child }) {
  return (
    <div class="modal-content">
      <header>
        <h3>{title}</h3>
        <button class="btn ghost icon-only" data-close-modal title="Close">
          <Icon name="close" />
        </button>
      </header>
      {children}
    </div>
  );
}
