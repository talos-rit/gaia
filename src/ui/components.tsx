import type { Child } from "hono/jsx";
import { ACTIONS, type Action } from "../core/actions.ts";
import { COMPONENT_LABEL, COMPONENTS, describeSource, localOverrideFor, type ComponentId, type Config, type PiCfg } from "../core/config.ts";
import { displayStep, type Job } from "../core/jobs.ts";
import { knownAddress, sshDisplay } from "../core/ssh.ts";
import { compose, docker, inStack } from "../core/stack.ts";
import {
  componentHealth,
  containerFor,
  fmtAge,
  getState,
  hostHealth,
  piLevel,
  type Level,
  type PiState,
} from "../core/status.ts";
import { busyJob } from "../core/jobs.ts";

export const Dot = ({ level, title }: { level: Level; title?: string }) => <span class={`dot ${level}`} title={title ?? level} />;

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
function Peek({ title, description, commands }: { title: string; description?: string; commands: string[] }) {
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

export function ActionButton({
  action,
  cfg,
  pi,
  service,
  variant,
  label,
}: {
  action: Action;
  cfg: Config;
  pi: PiCfg;
  service?: ComponentId;
  variant?: string;
  label?: string;
}) {
  const confirm = action.confirm?.(pi, service);
  return (
    <span class="act">
      <button
        class={`btn ${variant ?? ""}`}
        hx-post={`/pis/${pi.id}/actions/${action.id}`}
        hx-vals={service ? JSON.stringify({ service }) : undefined}
        hx-confirm={confirm}
        hx-target="#jobs"
        hx-swap="afterbegin"
      >
        {label ?? action.label}
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
  const lines = [
    "docker info",
    ...COMPONENTS.map((c) => {
      const s = cfg.components[c].source;
      return s.mode === "git"
        ? `git fetch --depth 1 ${s.repo} ${s.ref} && git archive <sha> | tar -x -C .cache/ctx/${c}`
        : s.mode === "local"
          ? `git ls-files -co --exclude-standard (in ${s.path}) | tar … -C .cache/ctx/${c}`
          : `# ${c}: no source, built from stack/${c}.Dockerfile`;
    }),
    `docker buildx build --platform linux/arm64 --load -f stack/<component>.Dockerfile -t talos/<component>:<rev> .cache/ctx/<component>   # ×3, skipped if cached`,
    `docker save talos/<component>:<rev> | zstd | ${sshDisplay(tgt, `zstd -dc | ${docker(pi)} load`)}   # only images the Pi lacks`,
    `tar -cf - compose.yaml operator.conf gaia-manifest.json … | ${sshDisplay(tgt, `cd ~/${cfg.stack.dir} && tar -xf -`)}`,
    `${sshDisplay(tgt, "<preflight: devices present, no conflicting services/containers>")}`,
    sshDisplay(tgt, inStack(cfg, `${compose(pi)} up -d --remove-orphans`)),
  ];
  return lines;
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
        hx-target="#jobs"
        hx-swap="afterbegin"
      >
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
        <ActionButton action={act("start")} cfg={cfg} pi={pi} variant="good" />
        <ActionButton action={act("stop")} cfg={cfg} pi={pi} />
        <ActionButton action={act("restart")} cfg={cfg} pi={pi} />
        <DeployButton cfg={cfg} pi={pi} />
        <ActionButton action={act("poweroff")} cfg={cfg} pi={pi} variant="danger" />
        <span class="spacer" />
        <details class="menu">
          <summary class="btn ghost">Troubleshoot ▾</summary>
          <div class="menu-list">
            {troubleshoot.map((a) => (
              <ActionButton action={a} cfg={cfg} pi={pi} variant="menu-item" />
            ))}
            <ActionButton action={act("down")} cfg={cfg} pi={pi} variant="menu-item danger" />
          </div>
        </details>
        <details class="menu">
          <summary class="btn ghost">More ▾</summary>
          <div class="menu-list">
            <button class="btn menu-item" hx-get={`/pis/${pi.id}/files`} hx-target="#modal-body">
              Generated files (compose.yaml, udev rules…)
            </button>
            <button class="btn menu-item" hx-get={`/probe?pi=${pi.id}`} hx-target="#modal-body">
              How is status checked?
            </button>
            <a class="btn menu-item" href={`http://${knownAddress(pi)}:${pi.arm.visionPort}/`} target="_blank" rel="noreferrer">
              Pi-Vision dashboard ↗
            </a>
          </div>
        </details>
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
                Logs
              </button>
              {c === "operator" && (
                <button class="btn small" hx-get={`/pis/${pi.id}/logs/operator?file=1`} hx-target="#modal-body" title="tail -F ~/talos-stack/logs/operator.log">
                  Log file
                </button>
              )}
              {c === "camera" && (
                <button class="btn small" hx-get={`/pis/${pi.id}/snapshot`} hx-target="#modal-body" title="Grab one frame from the RTSP stream">
                  Snapshot
                </button>
              )}
              <ActionButton action={act("svc-restart")} cfg={cfg} pi={pi} service={c} variant="small" />
              <ActionButton action={act("svc-stop")} cfg={cfg} pi={pi} service={c} variant="small" />
              <ActionButton action={act("svc-start")} cfg={cfg} pi={pi} service={c} variant="small" />
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
      <a id={`chip-${pi.id}`} hx-swap-oob="true" class="chip" href={`#pi-${pi.id}`}>
        <Dot level={level} /> {pi.name}
        {busy && <span class="muted"> · {busy.title}…</span>}
      </a>
      <span id={`addr-${pi.id}`} hx-swap-oob="true" class="muted mono">
        {pi.user}@{knownAddress(pi)}
        {knownAddress(pi) !== pi.host && <span class="tag warn" title={`${pi.host} did not answer; using a fallback address`}>fallback</span>}
      </span>

      <div id={`deployed-${pi.id}`} hx-swap-oob="true" class="deployed muted">
        {!d ? null : manifest ? (
          <>
            Deployed {ago(manifest.deployedAt)} by {manifest.deployedBy}:{" "}
            {COMPONENTS.map((c) => {
              const m = manifest.components[c];
              const running = containerFor(cfg, d, c);
              const stale = running?.state === "running" && m?.image && running.image !== m.image;
              return (
                <span class="prov" title={m?.image}>
                  {COMPONENT_LABEL[c]} <span class="mono">{m?.revision ? m.revision.slice(0, 7) : m?.image.split(":")[1]}</span>
                  {m?.ref && <span> ({m.ref})</span>}
                  {m?.dirty && <span class="tag warn">dirty</span>}
                  {stale && <span class="tag bad" title={`running ${running!.image}`}>running older image</span>}
                </span>
              );
            })}
          </>
        ) : d.stack.deployed ? (
          "Deployed without a Gaia manifest"
        ) : (
          <span>Nothing deployed by Gaia yet. Use Deploy.</span>
        )}
      </div>

      {COMPONENTS.map((c) => {
        const h = componentHealth(cfg, pi, st, c);
        const ctr = containerFor(cfg, d, c);
        return (
          <div id={`comp-${pi.id}-${c}`} hx-swap-oob="true" class="comp-main">
            <Dot level={h.level} /> <b>{COMPONENT_LABEL[c]}</b> <span>{h.summary}</span>
            <div class="comp-details muted">
              {ctr && (
                <span class="mono" title={ctr.image}>
                  {ctr.name}: {ctr.status}
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
        {busy && (
          <div class="busy">
            ⏳ {busy.title} in progress
          </div>
        )}
        {d ? (
          <div>
            {d.host.hostname} · {d.host.kernel} · up {fmtAge(d.host.uptime_s)} · {d.host.temp_c}°C · load {d.host.load.toFixed(2)} ·{" "}
            {(d.host.mem_avail_mb / 1024).toFixed(1)}/{(d.host.mem_total_mb / 1024).toFixed(1)} GB free · {d.host.disk_free_gb} GB disk · docker{" "}
            {d.runtime.up ? "up" : "down"} · polled {st.at ? fmtAge((Date.now() - st.at) / 1000) : "?"} ago ({st.probeMs} ms)
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

export function JobView({ job }: { job: Job }) {
  return (
    <details class={`job ${job.status}`} data-job={job.id} data-status={job.status} open={job.status === "running" || undefined}>
      <summary>
        <span class={`chip-status ${job.status}`}>{job.status}</span> <b>{job.title}</b>{" "}
        <span class="muted">{new Date(job.startedAt).toLocaleTimeString()}</span>
      </summary>
      <ol class="steps">
        {job.status !== "running" &&
          job.steps.map((s, i) => (
            <li data-i={i} class={s.status}>
              <div class="step-head">
                <span class={`st ${s.status}`} /> {s.label}
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
            <div class="src">
              <div class="src-head">
                <b>{COMPONENT_LABEL[c]}</b>
                <span class={`tag ${s.mode}`}>{s.mode === "git" ? "pinned ref" : s.mode === "local" ? "working copy" : "built-in"}</span>
                {override && <span class="tag" title="Overridden in gaia.local.yaml">local override</span>}
                <span class="spacer" />
                {s.mode !== "builtin" && (
                  <details class="menu right">
                    <summary class="btn small ghost">Change</summary>
                    <form class="menu-list form" hx-post={`/sources/${c}`} hx-target="#sources" hx-swap="outerHTML">
                      <label>
                        <input type="radio" name="mode" value="git" checked={s.mode === "git"} /> Pinned branch/tag/commit from a remote
                      </label>
                      <input name="repo" placeholder="https://github.com/talos-rit/…" value={s.mode === "git" ? s.repo : defaultRepo(c, cfg)} />
                      <input name="ref" placeholder="branch, tag or commit" value={s.mode === "git" ? s.ref : ""} />
                      <label>
                        <input type="radio" name="mode" value="local" checked={s.mode === "local"} /> Working copy on this machine
                      </label>
                      <input name="path" placeholder="../operator" value={s.mode === "local" ? s.path : defaultPath(c)} />
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
              <div class="mono">{describeSource(s)}</div>
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

const defaultRepo = (c: ComponentId, cfg: Config) => {
  const s = cfg.components[c].source;
  return s.mode === "git" ? s.repo : c === "operator" ? "https://github.com/talos-rit/operator.git" : "https://github.com/talos-rit/commander.git";
};
const defaultPath = (c: ComponentId) => (c === "operator" ? "../operator" : c === "vision" ? "../commander" : "");

export function FleetPanel({ cfg }: { cfg: Config }) {
  return (
    <section class="card fleet">
      <h3>Fleet</h3>
      <div class="chips">
        {cfg.pis.map((pi) => (
          <a id={`chip-${pi.id}`} class="chip" href={`#pi-${pi.id}`}>
            <Dot level="unknown" /> {pi.name}
          </a>
        ))}
      </div>
      <form class="deploy-form" hx-post="/deploy" hx-target="#jobs" hx-swap="afterbegin" data-homing={cfg.pis.filter((p) => p.arm.homesOnStart).map((p) => p.id).join(",")}>
        <div class="row wrap">
          <span>Deploy to:</span>
          {cfg.pis.map((pi) => (
            <label>
              <input type="checkbox" name="targets" value={pi.id} checked /> {pi.name}
            </label>
          ))}
        </div>
        <div class="row wrap">
          <label title="Run docker compose up -d after copying. Unchecked = only stage the new images and files.">
            <input type="checkbox" name="start" checked /> start after deploy
          </label>
          <label title="Rebuild even if an image with identical inputs exists">
            <input type="checkbox" name="force" /> force rebuild
          </label>
          <button class="btn primary" type="submit">
            Build &amp; deploy
          </button>
          <button class="btn" type="submit" name="buildOnly" value="1" title="Build the three arm64 images locally without touching any Pi">
            Build only
          </button>
        </div>
      </form>
      <div class="row wrap">
        <span>All Pis:</span>
        {["start", "stop", "restart"].map((a) => (
          <button
            class="btn small"
            hx-post={`/fleet/${a}`}
            hx-target="#jobs"
            hx-swap="afterbegin"
            hx-confirm={a !== "stop" && cfg.pis.some((p) => p.arm.homesOnStart) ? `${a} every Pi? This HOMEs: ${cfg.pis.filter((p) => p.arm.homesOnStart).map((p) => p.name).join(", ")}.` : undefined}
          >
            {a[0]!.toUpperCase() + a.slice(1)} all
          </button>
        ))}
        <button
          class="btn small danger"
          hx-post="/fleet/poweroff"
          hx-target="#jobs"
          hx-swap="afterbegin"
          hx-confirm={`End of day: stop every stack and shut down ${cfg.pis.map((p) => p.name).join(", ")}?\n\nUnplug only after each Pi's green LED stops flickering.`}
          title="Stop containers, then sudo systemctl poweroff on every Pi"
        >
          Power off all
        </button>
      </div>
    </section>
  );
}

export function Modal({ title, children }: { title: string; children: Child }) {
  return (
    <div class="modal-content">
      <header>
        <h3>{title}</h3>
        <button class="btn ghost" data-close-modal>
          ✕
        </button>
      </header>
      {children}
    </div>
  );
}
