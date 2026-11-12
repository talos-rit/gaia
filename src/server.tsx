import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolve } from "node:path";
import { proc } from "./core/pipeline.ts";
import {
  COMPONENT_LABEL,
  COMPONENTS,
  ROOT,
  clearLocalSource,
  getPi,
  loadConfig,
  saveLocalSource,
  type ComponentId,
  type Config,
  type PiCfg,
} from "./core/config.ts";
import { resolveSource, stackFiles } from "./core/deploy.ts";
import { getJob, listJobs, onJobFinished, startJob } from "./core/jobs.ts";
import { ensureHelper, grabSnapshot, launch, launchCommander, launchDeploy, logsCommand, snapshotCommand } from "./core/ops.ts";
import { mountMcp } from "./mcp.ts";
import {
  COMMANDER_ACTIONS,
  commanderConfigFiles,
  commanderStatus,
  fetchBranches,
  fetchCommand,
  invalidateCommanderStatus,
  isCloned,
  LOG_FILE,
  listBranches,
  PREV_LOG_FILE,
  switchSteps,
  tailLog,
  type CommanderAction,
} from "./core/commander.ts";
import { knownAddress, readLines, runArgv, sq, sshDisplay, sshOpts, target } from "./core/ssh.ts";
import { rtspUrl, type Images } from "./core/stack.ts";
import { getState, probeCommand, PROBE_PATH, refreshSoon, startPolling } from "./core/status.ts";
import { ErrorNote, FleetPanel, JobView, Layout, Modal, PiCard, PiStatus, SourcesPanel } from "./ui/components.tsx";
import { BranchForm, CommanderCard, CommanderStatusView } from "./ui/commander.tsx";
import { Icon } from "./ui/icons.tsx";

const app = new Hono();
const cfgNow = () => loadConfig();

// Gaia can reboot robots and HOME arms, so: listen on localhost only (override with HOST=0.0.0.0
// at your own risk), refuse foreign Host headers (DNS rebinding), and require htmx's custom
// header on anything that changes state (a cross-site <form> POST can't set it).
const HOST = process.env.HOST ?? "127.0.0.1";
app.use("*", async (c, next) => {
  const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
  if (HOST === "127.0.0.1" && !["localhost", "127.0.0.1", "[::1]"].includes(host)) return c.text("forbidden host", 403);
  // /mcp is for agent harnesses, which can't send X-Gaia. A web page can't reach it either: it
  // needs Content-Type: application/json (a CORS preflight, which Gaia never answers), and any
  // Origin a browser sends must be Gaia's own.
  if (c.req.path === "/mcp") {
    const origin = c.req.header("origin");
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return c.text("forbidden origin", 403);
  } else if (c.req.method !== "GET" && c.req.header("x-gaia") !== "1") return c.text("missing X-Gaia header", 403);
  await next();
});

mountMcp(app, cfgNow);

const STATIC: Record<string, string> = { "app.css": "text/css", "app.js": "text/javascript" };
app.get("/static/:file", (c) => {
  const f = c.req.param("file");
  if (!STATIC[f]) return c.text("not found", 404);
  return new Response(Bun.file(resolve(ROOT, "public", f)), { headers: { "content-type": STATIC[f]!, "cache-control": "no-cache" } });
});
app.get("/vendor/htmx.min.js", () => new Response(Bun.file(resolve(ROOT, "node_modules/htmx.org/dist/htmx.min.js")), { headers: { "content-type": "text/javascript" } }));

app.get("/", async (c) => {
  const cfg = cfgNow();
  const commander = await commanderStatus(cfg);
  return c.html(
    <Layout title="Gaia">
      <header class="top">
        <h1>
          Gaia <span class="muted">Talos Pi stack manager</span>
        </h1>
        <span class="spacer" />
        <span id="local-docker" hx-get="/local/status" hx-trigger="load, every 15s" hx-swap="innerHTML" />
      </header>
      {cfg.problems.length > 0 && (
        <div class="banner bad">
          <b>Config problems:</b>
          <ul>
            {cfg.problems.map((p) => (
              <li>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <main>
        <div class="side">
          <FleetPanel cfg={cfg} />
          <CommanderCard cfg={cfg} status={commander} />
          <SourcesPanel cfg={cfg} />
        </div>
        <div class="grid">
          {cfg.pis.map((pi) => (
            <PiCard cfg={cfg} pi={pi} />
          ))}
        </div>
      </main>
      <aside id="drawer" class="drawer">
        <header data-toggle-drawer title="Show or hide Activity">
          <h3>
            Activity <span id="activity-badge" />
          </h3>
          <span id="activity-status" class="muted">
            Every command Gaia runs appears here with its output.
          </span>
          <span class="spacer" />
          <button class="btn ghost small icon-only drawer-toggle" aria-label="Show or hide Activity">
            <Icon name="chevron" />
          </button>
        </header>
        <div id="jobs">
          {listJobs().map((j) => (
            <JobView job={j} />
          ))}
        </div>
      </aside>
      <dialog id="modal">
        <div id="modal-body" />
      </dialog>
      <dialog id="confirm">
        <form method="dialog" class="confirm-body">
          <div class="confirm-subject" data-subject />
          <div class="confirm-message" data-message />
          <div class="confirm-buttons">
            <button class="btn ghost" value="cancel" data-cancel>
              Cancel
            </button>
            <button class="btn" value="ok" data-ok />
          </div>
        </form>
      </dialog>
    </Layout>,
  );
});

// ---- status -----------------------------------------------------------------------------

app.get("/pis/:id/status", (c) => {
  const cfg = cfgNow();
  const pi = getPi(cfg, c.req.param("id"));
  if (!pi) return c.text("unknown pi", 404);
  return c.html(<PiStatus cfg={cfg} pi={pi} />);
});

app.get("/pis/:id/state.json", (c) => c.json(getState(c.req.param("id"))));

let localDocker: { at: number; html: string } | undefined;
app.get("/local/status", async (c) => {
  if (localDocker && Date.now() - localDocker.at < 10000) return c.html(localDocker.html);
  const missing = ["ssh", "git", "docker"].filter((t) => !Bun.which(t));
  if (missing.length) {
    const html = `<span class="chip" title="Gaia runs these programs directly; install them and restart Gaia"><span class="dot bad"></span> missing on this computer: ${missing.join(", ")}</span>`;
    localDocker = { at: Date.now(), html };
    return c.html(html);
  }
  const r = await runArgv(["docker", "info", "--format", "{{.ServerVersion}} {{.Architecture}} {{.Name}}"], { timeoutMs: 4000 });
  const hasColima = !!Bun.which("colima");
  const up = r.code === 0;
  const html = up
    ? `<span class="chip" title="docker info: ${r.stdout.trim()}"><span class="dot ok"></span> local Docker up</span>`
    : `<span class="chip" title="${(r.stderr || "").replace(/"/g, "'").trim()}"><span class="dot bad"></span> local Docker down (start Docker Desktop${hasColima ? " or Colima" : ""}; needed to build)</span>` +
      (hasColima
        ? ` <span class="act"><button class="btn small" hx-post="/local/colima-start" hx-target="#jobs" hx-swap="afterbegin">Start Colima</button><span class="peek"><b>Start Colima</b><pre>$ colima start</pre></span></span>`
        : "");
  localDocker = { at: Date.now(), html };
  return c.html(html);
});

app.post("/local/colima-start", (c) => {
  const job = startJob("Start Colima (local Docker)", async (j) => {
    await j.run({ label: "colima start", where: "local", run: [[proc("colima", "start")]], timeoutMs: 300_000 });
    localDocker = undefined;
  });
  return c.html(<JobView job={job} />);
});

// ---- actions ----------------------------------------------------------------------------

onJobFinished((job) => {
  invalidateCommanderStatus();
  if (job.pi) refreshSoon(job.pi.id);
  else for (const pi of cfgNow().pis) refreshSoon(pi.id);
});

app.post("/pis/:id/actions/:action", async (c) => {
  const cfg = cfgNow();
  const pi = getPi(cfg, c.req.param("id"));
  if (!pi) return c.text("unknown pi", 404);
  const body = await c.req.parseBody();
  const service = body.service ? (String(body.service) as ComponentId) : undefined;
  if (service && !COMPONENTS.includes(service)) return c.html(<ErrorNote message={`unknown service ${service}`} />);
  try {
    return c.html(<JobView job={launch(cfg, pi, c.req.param("action"), service)} />);
  } catch (e) {
    return c.html(<ErrorNote message={(e as Error).message} />);
  }
});

app.post("/fleet/:action", (c) => {
  const cfg = cfgNow();
  const action = c.req.param("action");
  if (!["start", "stop", "restart", "poweroff"].includes(action)) return c.text("bad action", 400);
  const out = cfg.pis.map((pi) => {
    try {
      return <JobView job={launch(cfg, pi, action)} />;
    } catch (e) {
      return <ErrorNote message={(e as Error).message} />;
    }
  });
  return c.html(<>{out}</>);
});

app.post("/deploy", async (c) => {
  const cfg = cfgNow();
  const body = await c.req.parseBody({ all: true });
  const ids = ([] as string[]).concat((body.targets as string | string[]) ?? []);
  const pis = ids.map((id) => getPi(cfg, id)).filter((p): p is PiCfg => !!p);
  const buildOnly = body.buildOnly === "1";
  try {
    return c.html(<JobView job={launchDeploy(cfg, { pis, buildOnly, start: body.start === "on", force: body.force === "on" })} />);
  } catch (e) {
    return c.html(<ErrorNote message={(e as Error).message} />);
  }
});

// ---- jobs -------------------------------------------------------------------------------

app.get("/jobs/:id/events", (c) => {
  const job = getJob(c.req.param("id"));
  if (!job) return c.text("no such job", 404);
  return streamSSE(c, async (stream) => {
    // Replay everything so far, then follow live.
    for (const [i, s] of job.steps.entries()) {
      await stream.writeSSE({ event: "step", data: JSON.stringify({ index: i, status: s.status, display: s.display, label: s.label }) });
      for (const l of s.lines) await stream.writeSSE({ event: "line", data: JSON.stringify({ index: i, ...l }) });
    }
    if (job.status !== "running") {
      await stream.writeSSE({ event: "done", data: JSON.stringify({ status: job.status }) });
      return;
    }
    const queue: { event: string; data: string }[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const unsub = job.subscribe((e) => {
      queue.push({ event: e.type, data: JSON.stringify(e) });
      if (e.type === "done") done = true;
      wake?.();
    });
    stream.onAbort(() => {
      unsub();
      done = true;
      wake?.();
    });
    while (true) {
      while (queue.length) await stream.writeSSE(queue.shift()!);
      if (done) break;
      await new Promise<void>((r) => (wake = r));
    }
    unsub();
  });
});

// ---- logs -------------------------------------------------------------------------------

app.get("/pis/:id/logs/:svc", (c) => {
  const cfg = cfgNow();
  const pi = getPi(cfg, c.req.param("id"));
  const svc = c.req.param("svc") as ComponentId;
  if (!pi || !COMPONENTS.includes(svc)) return c.text("not found", 404);
  const file = c.req.query("file") === "1";
  const cmd = logsCommand(svc, file, 300);
  return c.html(
    <Modal title={`${pi.name} · ${COMPONENT_LABEL[svc]} · ${file ? "operator.log" : "container logs"}`}>
      <pre class="cmd">$ {sshDisplay(`${pi.user}@${knownAddress(pi)}`, cmd)}</pre>
      <div class="row">
        <label>
          <input type="checkbox" data-follow checked /> follow
        </label>
        <label>
          <input type="checkbox" data-wrap /> wrap
        </label>
        <input type="search" placeholder="filter…" data-filter />
        <span class="muted" data-logstate>
          connecting…
        </span>
      </div>
      <pre class="logs" data-logsrc={`/pis/${pi.id}/logs/${svc}/stream${file ? "?file=1" : ""}`} />
    </Modal>,
  );
});

app.get("/pis/:id/logs/:svc/stream", async (c) => {
  const cfg = cfgNow();
  const pi = getPi(cfg, c.req.param("id"));
  const svc = c.req.param("svc") as ComponentId;
  if (!pi || !COMPONENTS.includes(svc)) return c.text("not found", 404);
  const cmd = logsCommand(svc, c.req.query("file") === "1", 300);
  return streamSSE(c, async (stream) => {
    let tgt: string;
    try {
      await ensureHelper(cfg, pi);
      tgt = await target(pi);
    } catch (e) {
      await stream.writeSSE({ event: "end", data: (e as Error).message });
      return;
    }
    const proc = Bun.spawn(["ssh", ...sshOpts(pi), tgt, cmd], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    stream.onAbort(() => proc.kill());
    await stream.writeSSE({ event: "open", data: "" });
    const send = (l: string) => stream.writeSSE({ event: "line", data: l }).catch(() => proc.kill());
    await Promise.all([readLines(proc.stdout, send), readLines(proc.stderr, send)]);
    const code = await proc.exited;
    await stream.writeSSE({ event: "end", data: `stream ended (exit ${code})` }).catch(() => {});
  });
});

// ---- snapshot ---------------------------------------------------------------------------

app.get("/pis/:id/snapshot", (c) => {
  const cfg = cfgNow();
  const pi = getPi(cfg, c.req.param("id"));
  if (!pi) return c.text("not found", 404);
  return c.html(
    <Modal title={`${pi.name} · camera snapshot`}>
      <pre class="cmd">$ {sshDisplay(`${pi.user}@${knownAddress(pi)}`, snapshotCommand())}</pre>
      <p class="muted">
        One frame pulled from <span class="mono">{rtspUrl(pi)}</span> on the Pi itself, the same stream Commander and Pi-Vision read. Remote viewers use{" "}
        <span class="mono">{rtspUrl(pi, knownAddress(pi))}</span>.
      </p>
      <img class="snapshot" src={`/pis/${pi.id}/snapshot.jpg?t=${Date.now()}`} alt="(no frame: is the camera container running and publishing?)" />
      <div class="row">
        <button class="btn small" hx-get={`/pis/${pi.id}/snapshot`} hx-target="#modal-body">
          Grab another
        </button>
      </div>
    </Modal>,
  );
});

app.get("/pis/:id/snapshot.jpg", async (c) => {
  const cfg = cfgNow();
  const pi = getPi(cfg, c.req.param("id"));
  if (!pi) return c.text("not found", 404);
  const r = await grabSnapshot(cfg, pi);
  if (!r.ok) return c.text(r.error, 502);
  return new Response(r.jpeg, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
});

// ---- transparency views -----------------------------------------------------------------

app.get("/pis/:id/files", (c) => {
  const cfg = cfgNow();
  const pi = getPi(cfg, c.req.param("id"));
  if (!pi) return c.text("not found", 404);
  const m = getState(pi.id).data?.stack.manifest;
  const images = Object.fromEntries(COMPONENTS.map((k) => [k, m?.components[k]?.image ?? `talos/${k}:<tag chosen at deploy>`])) as Images;
  const files = stackFiles(cfg, pi, images);
  return c.html(
    <Modal title={`${pi.name} · files Gaia writes to ~/${cfg.stack.dir}`}>
      <p class="muted">
        Generated from the current config{m ? " and the image tags of the last deploy" : ""}. The udev rules are installed by Troubleshoot › Re-apply USB rules into{" "}
        <span class="mono">/etc/udev/rules.d/70-talos-gaia.rules</span>.
      </p>
      {Object.entries(files).map(([name, body]) => (
        <details open={name === "compose.yaml"}>
          <summary class="mono">{name}</summary>
          <pre class="file">{body}</pre>
        </details>
      ))}
    </Modal>,
  );
});

app.get("/probe", async (c) => {
  const cfg = cfgNow();
  const pi = getPi(cfg, c.req.query("pi") ?? "") ?? cfg.pis[0]!;
  const script = await Bun.file(PROBE_PATH).text();
  return c.html(
    <Modal title="How Gaia checks status">
      <p>
        Every 5 s Gaia runs one read-only SSH command per Pi; ffprobe runs on every third poll. It never connects to Operator's TCP port, because Operator
        accepts only one client and Pi-Vision is that client. Operator health comes from Pi-Vision's view of the arm telemetry.
      </p>
      <pre class="cmd">$ {sshDisplay(`${pi.user}@${knownAddress(pi)}`, probeCommand(cfg, pi, true))} &lt; src/core/probe.py</pre>
      <details>
        <summary class="mono">src/core/probe.py</summary>
        <pre class="file">{script}</pre>
      </details>
      <details>
        <summary>Latest raw result for {pi.name}</summary>
        <pre class="file">{JSON.stringify(getState(pi.id), null, 2)}</pre>
      </details>
    </Modal>,
  );
});

// ---- sources ----------------------------------------------------------------------------

app.get("/sources/:c/resolve", async (c) => {
  const comp = c.req.param("c") as ComponentId;
  if (!COMPONENTS.includes(comp)) return c.text("?", 404);
  const r = await resolveSource(cfgNow(), comp);
  return c.html(
    <span class={r.ok ? "" : "bad-text"} title={r.cmd ? `$ ${r.cmd}` : undefined}>
      {r.text}
    </span>,
  );
});

app.post("/sources/:c", async (c) => {
  const comp = c.req.param("c") as ComponentId;
  if (!COMPONENTS.includes(comp)) return c.text("?", 404);
  const b = await c.req.parseBody();
  if (b.mode === "git") saveLocalSource(comp, { mode: "git", repo: String(b.repo).trim(), ref: String(b.ref).trim() });
  else if (b.mode === "local") saveLocalSource(comp, { mode: "local", path: String(b.path).trim() });
  return c.html(<SourcesPanel cfg={cfgNow()} />);
});

app.post("/sources/:c/reset", (c) => {
  const comp = c.req.param("c") as ComponentId;
  if (!COMPONENTS.includes(comp)) return c.text("?", 404);
  clearLocalSource(comp);
  return c.html(<SourcesPanel cfg={cfgNow()} />);
});

// ---- commander (runs on this machine) ------------------------------------------------------

app.get("/commander/status", async (c) => {
  const cfg = cfgNow();
  const status = await commanderStatus(cfg);
  // Cloned or removed since the card was drawn: redraw the whole card (its buttons differ).
  if (String(Number(status.cloned)) !== c.req.query("cloned")) return c.html(<CommanderCard cfg={cfg} status={status} />);
  return c.html(<CommanderStatusView cfg={cfg} status={status} />);
});

app.post("/commander/actions/:action", (c) => {
  const cfg = cfgNow();
  const id = c.req.param("action") as CommanderAction;
  const action = COMMANDER_ACTIONS[id];
  if (!action) return c.text("unknown action", 404);
  if (id === "setup" ? isCloned(cfg) : !isCloned(cfg))
    return c.html(<ErrorNote message={id === "setup" ? `${cfg.commander.path} is already a git checkout.` : `No Commander checkout at ${cfg.commander.path}; use Set up.`} />);
  try {
    return c.html(<JobView job={launchCommander(action.label, action.steps(cfg))} />);
  } catch (e) {
    return c.html(<ErrorNote message={(e as Error).message} />);
  }
});

app.get("/commander/branches", async (c) => {
  const cfg = cfgNow();
  let fetched: { ok: boolean; output: string } | undefined;
  if (c.req.query("fetch") === "1") {
    const r = await fetchBranches(cfg);
    fetched = { ok: r.code === 0, output: `$ ${fetchCommand(cfg).join(" ")}\n${(r.stdout + r.stderr).trim()}`.trim() };
    invalidateCommanderStatus();
  }
  const [branches, status] = await Promise.all([listBranches(cfg), commanderStatus(cfg)]);
  return c.html(<BranchForm branches={branches} current={status.git?.branch} fetched={fetched} />);
});

app.post("/commander/switch", async (c) => {
  const cfg = cfgNow();
  const b = await c.req.parseBody();
  const branch = String(b.branch ?? "");
  if (!(await listBranches(cfg)).some((x) => x.name === branch)) return c.html(<ErrorNote message={`unknown branch "${branch}"`} />);
  try {
    return c.html(<JobView job={launchCommander(`switch to ${branch}`, switchSteps(cfg, branch, b.rebuild === "1"))} />);
  } catch (e) {
    return c.html(<ErrorNote message={(e as Error).message} />);
  }
});

app.get("/commander/logs", (c) => {
  const prev = c.req.query("prev") === "1";
  return c.html(
    <Modal title={`Commander · ${prev ? "previous run's output" : "commander-web output"}`}>
      <pre class="cmd">$ tail -n 300 {prev ? "" : "-F "}.cache/commander/{prev ? "commander.previous.log" : "commander.log"}</pre>
      <div class="row">
        <label>
          <input type="checkbox" data-follow checked /> follow
        </label>
        <label>
          <input type="checkbox" data-wrap /> wrap
        </label>
        <input type="search" placeholder="filter…" data-filter />
        <span class="muted" data-logstate>
          connecting…
        </span>
      </div>
      <pre class="logs" data-logsrc={`/commander/logs/stream${prev ? "?prev=1" : ""}`} />
    </Modal>,
  );
});

app.get("/commander/logs/stream", (c) => {
  const prev = c.req.query("prev") === "1";
  return streamSSE(c, async (stream) => {
    let aborted = false;
    stream.onAbort(() => void (aborted = true));
    await stream.writeSSE({ event: "open", data: "" });
    const send = (l: string) => stream.writeSSE({ event: "line", data: l }).catch(() => void (aborted = true));
    await tailLog(prev ? PREV_LOG_FILE : LOG_FILE, 300, send, () => aborted, !prev);
    if (prev) await stream.writeSSE({ event: "end", data: "end of the previous run's output" }).catch(() => {});
  });
});

app.get("/commander/files", (c) => {
  const cfg = cfgNow();
  const files = commanderConfigFiles(cfg);
  return c.html(
    <Modal title="Commander config files Gaia creates">
      <p class="muted">
        Generated from the Pis in <span class="mono">gaia.config.yaml</span> and <span class="mono">gaia.local.yaml</span>. Set up and Build &amp; run create each file in{" "}
        <span class="mono">{cfg.commander.path}</span> only if it doesn't exist; an existing file is never touched. To regenerate one, delete it, then run Build &amp; run.
      </p>
      {files.map((f) => (
        <details open>
          <summary>
            <span class="mono">{f.name}</span> <span class="muted">{f.exists ? "· exists, so Gaia leaves it alone" : "· missing, so Gaia will create it"}</span>
          </summary>
          <pre class="file">{f.body}</pre>
        </details>
      ))}
    </Modal>,
  );
});

// ---- boot -------------------------------------------------------------------------------

const cfg = cfgNow();
startPolling(cfgNow);
const server = Bun.serve({ hostname: HOST, port: cfg.server.port, fetch: app.fetch, idleTimeout: 0 });
console.log(`Gaia → http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${server.port}  (${cfg.pis.map((p) => `${p.name}=${p.user}@${p.host}`).join(", ")})`);
if (cfg.problems.length) console.warn("Config problems:\n  " + cfg.problems.join("\n  "));
