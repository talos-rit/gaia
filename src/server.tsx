import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolve } from "node:path";
import { getAction } from "./core/actions.ts";
import { helperHash, installHelperStep, talos } from "./core/helper.ts";
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
import { deploy, resolveSource, stackFiles } from "./core/deploy.ts";
import { displayStep, getJob, listJobs, onJobFinished, startJob, type Job } from "./core/jobs.ts";
import { knownAddress, readLines, runArgv, sq, sshDisplay, sshOpts, target } from "./core/ssh.ts";
import { rtspUrl, type Images } from "./core/stack.ts";
import { getState, probeCommand, PROBE_PATH, refreshSoon, startPolling } from "./core/status.ts";
import { ErrorNote, FleetPanel, JobView, Layout, Modal, PiCard, PiStatus, SourcesPanel } from "./ui/components.tsx";

const app = new Hono();
const cfgNow = () => loadConfig();

// Gaia can reboot robots and HOME arms, so: listen on localhost only (override with HOST=0.0.0.0
// at your own risk), refuse foreign Host headers (DNS rebinding), and require htmx's custom
// header on anything that changes state (a cross-site <form> POST can't set it).
const HOST = process.env.HOST ?? "127.0.0.1";
app.use("*", async (c, next) => {
  const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
  if (HOST === "127.0.0.1" && !["localhost", "127.0.0.1", "[::1]"].includes(host)) return c.text("forbidden host", 403);
  if (c.req.method !== "GET" && c.req.header("x-gaia") !== "1") return c.text("missing X-Gaia header", 403);
  await next();
});

const STATIC: Record<string, string> = { "app.css": "text/css", "app.js": "text/javascript" };
app.get("/static/:file", (c) => {
  const f = c.req.param("file");
  if (!STATIC[f]) return c.text("not found", 404);
  return new Response(Bun.file(resolve(ROOT, "public", f)), { headers: { "content-type": STATIC[f]!, "cache-control": "no-cache" } });
});
app.get("/vendor/htmx.min.js", () => new Response(Bun.file(resolve(ROOT, "node_modules/htmx.org/dist/htmx.min.js")), { headers: { "content-type": "text/javascript" } }));

app.get("/", (c) => {
  const cfg = cfgNow();
  return c.html(
    <Layout title="Gaia · Talos stack">
      <header class="top">
        <h1>
          Gaia <span class="muted">Talos Pi stack manager</span>
        </h1>
        <span class="spacer" />
        <span id="local-docker" hx-get="/local/status" hx-trigger="load, every 15s" hx-swap="innerHTML" />
        <button class="btn ghost" data-toggle-drawer>
          Activity <span id="activity-badge" />
        </button>
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
          <SourcesPanel cfg={cfg} />
        </div>
        <div class="grid">
          {cfg.pis.map((pi) => (
            <PiCard cfg={cfg} pi={pi} />
          ))}
        </div>
      </main>
      <aside id="drawer" class="drawer">
        <header>
          <h3>Activity</h3>
          <span id="activity-status" class="muted" data-toggle-drawer title="Show Activity">
            Every command Gaia runs appears here with its output.
          </span>
          <span class="spacer" />
          <button class="btn ghost small" data-toggle-drawer>
            Hide
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

// ---- talos helper on the Pi ---------------------------------------------------------------

const helperInstalled = new Map<string, string>(); // pi id -> hash we installed this session

function helperCurrent(cfg: Config, pi: PiCfg): boolean {
  const want = helperHash(cfg, pi);
  const st = getState(pi.id).data?.stack;
  return helperInstalled.get(pi.id) === want || (st?.helper_sha === want && !!st.helper_linked);
}

/** For views that run `talos …` outside a job (logs, snapshot): install the helper first if needed, as a visible job. */
async function ensureHelper(cfg: Config, pi: PiCfg) {
  if (helperCurrent(cfg, pi)) return;
  const job = startJob(`${pi.name}: install the talos helper`, async (j) => void (await j.run(installHelperStep(cfg, pi))), { pi });
  await new Promise<void>((r) => (job.status !== "running" ? r() : job.subscribe((e) => e.type === "done" && r())));
  if (job.status === "ok") helperInstalled.set(pi.id, helperHash(cfg, pi));
}

function launch(cfg: Config, pi: PiCfg, actionId: string, service?: ComponentId): Job {
  const action = getAction(actionId);
  if (!action) throw new Error(`unknown action ${actionId}`);
  const title = `${pi.name}: ${action.label}${service ? ` ${COMPONENT_LABEL[service]}` : ""}`;
  const exclusive = action.scope === "troubleshoot" && !action.confirm ? [] : [pi];
  if (action.run) return startJob(title, (j) => action.run!(j, cfg, pi), { pi, exclusive });
  // Actions are `talos <command>` calls; add a step that installs/updates the helper when the Pi lacks the current one.
  const usesHelper = action.steps(cfg, pi, service).some((s) => s.where === "remote" && s.cmd.startsWith("talos "));
  const steps = [...(usesHelper && !helperCurrent(cfg, pi) ? [installHelperStep(cfg, pi)] : []), ...action.steps(cfg, pi, service)];
  const job = startJob(
    title,
    async (j) => {
      const idx = steps.map((s) => j.plan(s.label, displayStep(s, pi)));
      for (let i = 0; i < steps.length; i++) {
        try {
          await j.run(steps[i]!, idx[i]);
        } catch (e) {
          for (const k of idx.slice(i + 1)) j.setStep(k, "skipped");
          throw e;
        }
        if (steps[i] && steps[i]!.label === installHelperStep(cfg, pi).label) helperInstalled.set(pi.id, helperHash(cfg, pi));
      }
    },
    { pi, exclusive },
  );
  return job;
}

onJobFinished((job) => {
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
  if (!pis.length && !buildOnly) return c.html(<ErrorNote message="Select at least one Pi to deploy to." />);
  if (cfg.problems.length) return c.html(<ErrorNote message={`Fix config problems first: ${cfg.problems.join("; ")}`} />);
  try {
    const targets = buildOnly ? [] : pis;
    const title = buildOnly ? "Build images (no deploy)" : `Deploy → ${pis.map((p) => p.name).join(", ")}`;
    const job = startJob(title, (j) => deploy(j, cfg, targets, { start: body.start === "on", force: body.force === "on" }), {
      pi: targets.length === 1 ? targets[0] : undefined,
      exclusive: targets,
    });
    return c.html(<JobView job={job} />);
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

function logsCommand(svc: ComponentId, file: boolean, tail: number) {
  // `timeout` makes sure the remote follower dies even if the SSH channel lingers.
  return file ? `timeout 3600 ${talos(`oplog -n ${tail} -F`)}` : `timeout 3600 ${talos(`logs ${svc} -f --tail ${tail}`)}`;
}

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

const snapshotCommand = () => talos("snapshot");

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
  await ensureHelper(cfg, pi);
  const proc = Bun.spawn(["ssh", ...sshOpts(pi), await target(pi), snapshotCommand()], { stdout: "pipe", stderr: "pipe" });
  const [buf, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  if (code !== 0 || buf.byteLength === 0) return c.text(await new Response(proc.stderr).text(), 502);
  return new Response(buf, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
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

// ---- boot -------------------------------------------------------------------------------

const cfg = cfgNow();
startPolling(cfgNow);
const server = Bun.serve({ hostname: HOST, port: cfg.server.port, fetch: app.fetch, idleTimeout: 0 });
console.log(`Gaia → http://${HOST === "127.0.0.1" ? "localhost" : HOST}:${server.port}  (${cfg.pis.map((p) => `${p.name}=${p.user}@${p.host}`).join(", ")})`);
if (cfg.problems.length) console.warn("Config problems:\n  " + cfg.problems.join("\n  "));
