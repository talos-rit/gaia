import { COMMANDER_ACTIONS, COMMANDER_LOCK, type Branch, type CommanderAction, type CommanderStatus } from "../core/commander.ts";
import type { Config } from "../core/config.ts";
import { busyJob, displayStep } from "../core/jobs.ts";
import { fmtAge, type Level } from "../core/status.ts";
import { Dot, Peek } from "./components.tsx";
import { Icon, type IconName } from "./icons.tsx";

const ICON: Partial<Record<CommanderAction, IconName>> = { setup: "download", build: "package", start: "play", stop: "stop", restart: "restart", pull: "download" };

function CommanderButton({ cfg, action, variant, when }: { cfg: Config; action: CommanderAction; variant?: string; when?: "running" | "stopped" }) {
  const a = COMMANDER_ACTIONS[action];
  const icon = ICON[action];
  return (
    <span class={`act${when ? ` when-${when}` : ""}`}>
      <button class={`btn ${variant ?? ""}`} hx-post={`/commander/actions/${action}`} hx-target="#jobs" hx-swap="afterbegin">
        {icon && <Icon name={icon} />}
        <span class="btn-label">{a.label}</span>
      </button>
      <Peek title={`${a.label} Commander`} description={a.description} commands={a.steps(cfg).map((s) => displayStep(s))} />
    </span>
  );
}

const ago = (ms?: number) => (ms ? `${fmtAge((Date.now() - ms) / 1000)} ago` : "");

function processLevel(s: CommanderStatus): Level {
  if (s.proc) return s.health === "ready" ? "ok" : "partial";
  if (s.health !== "down") return "warn"; // something Gaia didn't start holds the port
  if (s.lastExit && s.lastExit.code !== 0) return "bad";
  return s.cloned ? "off" : "unknown";
}

export function CommanderCard({ cfg, status }: { cfg: Config; status: CommanderStatus }) {
  const s = status;
  const parts = statusParts(cfg, s, false);
  if (!s.cloned)
    return (
      <section class="card commander" id="commander" hx-swap-oob="true">
        <header class="pi-head">
          <Dot level="unknown" />
          <h2>Commander</h2>
          <span class="muted mono">{cfg.commander.path}</span>
        </header>
        <p class="muted">
          No checkout at <span class="mono">{cfg.commander.path}</span> yet. Set up clones <span class="mono">{cfg.commander.branch}</span>, creates Commander's config for{" "}
          {cfg.pis.map((p) => p.name).join(" and ")}, builds the web UI and starts it. To use another folder, set <span class="mono">commander.path</span> in{" "}
          <span class="mono">gaia.local.yaml</span>.
        </p>
        {!s.uv && (
          <p class="bad-text">
            uv is not installed. Install it first: <a href="https://docs.astral.sh/uv/getting-started/installation/">docs.astral.sh/uv</a>
          </p>
        )}
        <div class="toolbar">
          <CommanderButton cfg={cfg} action="setup" variant="primary" />
        </div>
        <div hx-get="/commander/status?cloned=0" hx-trigger="every 4s" hx-swap="none" />
      </section>
    );

  return (
    <section class="card commander" id="commander" hx-swap-oob="true">
      <header class="pi-head">
        {parts.dot}
        <h2>Commander</h2>
        {parts.addr}
      </header>

      <div class="toolbar">
        <CommanderButton cfg={cfg} action="start" variant="good" when="stopped" />
        <CommanderButton cfg={cfg} action="stop" when="running" />
        <CommanderButton cfg={cfg} action="restart" when="running" />
        <CommanderButton cfg={cfg} action="build" variant="primary" />
        <span class="spacer" />
        <details class="menu">
          <summary class="btn ghost icon-only" title="More">
            <Icon name="more" />
            <span class="sr-only">More</span>
          </summary>
          <div class="menu-list">
            <button class="btn menu-item" hx-get="/commander/files" hx-target="#modal-body">
              Config files Gaia creates
            </button>
            <button class="btn menu-item" hx-get="/commander/logs?prev=1" hx-target="#modal-body">
              Previous run's output
            </button>
          </div>
        </details>
      </div>

      <div class="components">
        <div class="comp">
          {parts.checkout}
          <div class="comp-actions">
            <details class="menu right">
              <summary class="btn small" title="Switch branch">
                <Icon name="branch" />
                <span class="btn-label">Branch</span>
              </summary>
              <div class="menu-list form" hx-get="/commander/branches" hx-trigger="toggle[target.open] from:closest details" hx-swap="innerHTML">
                <span class="muted">Loading branches…</span>
              </div>
            </details>
            <CommanderButton cfg={cfg} action="pull" variant="small" />
          </div>
        </div>
        <div class="comp">
          {parts.web}
        </div>
        <div class="comp">
          {parts.process}
          <div class="comp-actions">
            <button class="btn small" hx-get="/commander/logs" hx-target="#modal-body" title="Follow commander-web's output">
              <Icon name="logs" />
              <span class="btn-label">Logs</span>
            </button>
          </div>
        </div>
      </div>
      <div hx-get="/commander/status?cloned=1" hx-trigger="every 4s" hx-swap="none" />
    </section>
  );
}

/** Out-of-band fragments that refresh the Commander card's dynamic parts. */
export function CommanderStatusView({ cfg, status }: { cfg: Config; status: CommanderStatus }) {
  const p = statusParts(cfg, status, true);
  return (
    <>
      {p.dot}
      {p.addr}
      {p.checkout}
      {p.web}
      {p.process}
    </>
  );
}

/** The card's dynamic pieces; `oob` marks them for the status poll's out-of-band swap. */
function statusParts(cfg: Config, s: CommanderStatus, oob: boolean) {
  const swap = oob ? "true" : undefined;
  const g = s.git;
  const b = s.build;
  const busy = busyJob(COMMANDER_LOCK.id);
  const staleWeb = !!(b && g && b.sha && b.sha !== g.sha);
  const staleRun = !!(s.proc?.sha && g && s.proc.sha !== g.sha);
  const running = !!s.proc;
  return {
    dot: (
      <span id="commander-dot" hx-swap-oob={swap}>
        <Dot level={processLevel(s)} />
      </span>
    ),
    addr: (
      <span id="commander-addr" hx-swap-oob={swap} class="muted mono">
        {running ? (
          <a href={s.addr.url} target="_blank" rel="noreferrer">
            {s.addr.url.replace(/^http:\/\//, "")} <Icon name="external" />
          </a>
        ) : (
          cfg.commander.path
        )}
      </span>
    ),
    checkout: (
      <div id="commander-checkout" hx-swap-oob={swap} class="comp-main">
        <b>Checkout</b>{" "}
        {g ? (
          <span class="mono">
            {g.branch} · {g.short}
          </span>
        ) : (
          <span>git can't read {cfg.commander.path}</span>
        )}
        {g && (
          <div class="comp-details muted">
            {g.dirty > 0 && <span>{g.dirty === 1 ? "1 uncommitted change" : `${g.dirty} uncommitted changes`}</span>}
            {g.upstream ? (
              (g.behind > 0 || g.ahead > 0) && (
                <span title="As of the last fetch">
                  {g.upstream}: {[g.behind && `${g.behind} behind`, g.ahead && `${g.ahead} ahead`].filter(Boolean).join(", ")}
                </span>
              )
            ) : (
              <span>no upstream branch</span>
            )}
          </div>
        )}
      </div>
    ),
    web: (
      <div id="commander-web" hx-swap-oob={swap} class="comp-main">
        <b>Web UI</b>{" "}
        {!b ? (
          <span>not built; Build &amp; run builds it</span>
        ) : (
          <span>
            built {ago(b.at)}
            {staleWeb && <span class="tag warn">older than checkout</span>}
          </span>
        )}
      </div>
    ),
    process: (
      <div id="commander-process" hx-swap-oob={swap} class="comp-main" data-run={running ? "running" : "stopped"}>
        <b>commander-web</b>{" "}
        <span>
          {running
            ? s.health === "ready"
              ? "running"
              : s.health === "starting"
                ? "connecting to robots…"
                : "starting…"
            : s.health !== "down"
              ? `something Gaia didn't start answers at ${s.addr.url}`
              : s.lastExit
                ? `exited with code ${s.lastExit.code} ${ago(s.lastExit.at)}`
                : "stopped"}
        </span>
        <div class="comp-details muted">
          {busy && <span class="busy">{busy.title} in progress…</span>}
          {s.proc && (
            <span class="meta">
              <span>pid {s.proc.pid}</span>
              <span>up {fmtAge((Date.now() - s.proc.startedAt) / 1000)}</span>
              {s.proc.sha && (
                <span class="rev">
                  {s.proc.sha.slice(0, 7)}
                  {staleRun && <span class="tag warn">running older checkout</span>}
                </span>
              )}
            </span>
          )}
          {!s.uv && <span class="bad-text">uv is not installed</span>}
        </div>
      </div>
    ),
  };
}

export function BranchForm({ branches, current, fetched }: { branches: Branch[]; current?: string; fetched?: { ok: boolean; output: string } }) {
  return (
    <form hx-post="/commander/switch" hx-target="#jobs" hx-swap="afterbegin">
      <label class="field-label" for="commander-branch">
        Branch
      </label>
      <select name="branch" id="commander-branch">
        {branches.map((b) => (
          <option value={b.name} selected={b.name === current}>
            {b.name}
            {b.remoteOnly ? "  (origin only)" : ""}
          </option>
        ))}
      </select>
      <label title="Install dependencies, rebuild the web UI and restart commander-web on the new branch">
        <input type="checkbox" name="rebuild" value="1" checked /> then build &amp; run
      </label>
      <div class="row">
        <button class="btn primary" type="submit">
          <Icon name="branch" />
          Switch
        </button>
        <button class="btn ghost" type="button" hx-get="/commander/branches?fetch=1" hx-target="closest .menu-list" hx-swap="innerHTML" title="git fetch --prune origin">
          <Icon name="restart" />
          Fetch
        </button>
      </div>
      {fetched && <pre class={`fetch-out${fetched.ok ? "" : " bad-text"}`}>{fetched.output || (fetched.ok ? "Up to date." : "git fetch failed")}</pre>}
      <p class="muted small-print">
        Runs <span class="mono">git fetch</span>, <span class="mono">git switch &lt;branch&gt;</span> and <span class="mono">git pull --ff-only</span>. Uncommitted changes come
        along unless they conflict, in which case git refuses and nothing changes.
      </p>
    </form>
  );
}
