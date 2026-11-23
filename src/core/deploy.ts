import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { ensureRuntime, syncClock } from "./actions.ts";
import { HELPER_PATH, helperScript, talos } from "./helper.ts";
import { COMPONENT_LABEL, COMPONENTS, ROOT, describeSource, type ComponentId, type Config, type PiCfg, type Source } from "./config.ts";
import type { Job } from "./jobs.ts";
import { gzip, proc, rel, task, type Stage } from "./pipeline.ts";
import { runArgv, sq, sshArgv, sshDisplay, target } from "./ssh.ts";
import { compose, composeYaml, docker, inStack, operatorConf, udevRules, type Images } from "./stack.ts";
import type { Manifest } from "./status.ts";
import { tarCreate, tarExtract, tarFilter, tarReadFile } from "./tar.ts";

const CACHE = resolve(ROOT, ".cache");
const STACK_DIR = resolve(ROOT, "stack");
const PLATFORM = "linux/arm64";

interface Prepared {
  component: ComponentId;
  image: string; // talos/<component>:<tag>
  contextDir: string;
  buildKey: string;
  revision?: string;
  ref?: string;
  dirty?: boolean;
  source: string;
  buildArgs: Record<string, string>;
}

const short = (s: string, n = 7) => s.slice(0, n);
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const slug = (s: string) => s.replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/[^\w.-]+/g, "_");
// Never let Git for Windows' autocrlf turn shell scripts into CRLF on their way into an image.
const GIT = ["git", "-c", "core.autocrlf=false"];

/** Repo-relative paths a component needs (undefined = the whole repo). */
function includePaths(cfg: Config, c: ComponentId): string[] | undefined {
  if (c === "camera") return ["scripts"];
  if (c !== "vision") return undefined;
  const v = cfg.components.vision;
  return v.appDir === "." || v.appDir === "" ? undefined : [v.appDir, v.model];
}

function buildArgs(cfg: Config, c: ComponentId): Record<string, string> {
  const extra = cfg.components[c].buildArgs ?? {};
  if (c === "operator") return { RUN_TESTS: cfg.components.operator.runTests === false ? "0" : "1", ...extra };
  if (c === "vision") return { APP_DIR: cfg.components.vision.appDir || ".", MODEL: cfg.components.vision.model, ...extra };
  if (c === "mediamtx") return { MEDIAMTX_VERSION: cfg.components.mediamtx.version, ...extra };
  return extra;
}

function dockerfileHash(c: ComponentId) {
  const extra: Partial<Record<ComponentId, string[]>> = { vision: ["vision-requirements.lock"], mediamtx: ["mediamtx.yml"] };
  const files = [`${c}.Dockerfile`, ...(extra[c] ?? [])];
  return sha256(files.map((f) => readFileSync(join(STACK_DIR, f))).join("\0"));
}

const emptyDir = (dir: string): Stage =>
  task(`rm -rf ${dir} && mkdir -p ${dir}`, () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });

const extractTo = (dir: string, job: Job): Stage => ({
  kind: "sink",
  display: `untar into ${dir}`,
  consume: (input) => tarExtract(input, dir, (m) => job.log(job.steps.length - 1, m)),
});

async function prepareGit(job: Job, cfg: Config, c: ComponentId, src: Extract<Source, { mode: "git" }>): Promise<Prepared> {
  const repoDir = join(CACHE, "repos", slug(src.repo) + ".git");
  const ctx = join(CACHE, "ctx", c);
  const fetched = await job.run({
    label: `${COMPONENT_LABEL[c]}: fetch ${src.ref}`,
    where: "local",
    run: [
      ...(existsSync(repoDir) ? [] : [[proc("git", "init", "--bare", "-q", repoDir)]]),
      [proc(...GIT, "-C", repoDir, "fetch", "--depth", "1", "--force", "--no-tags", src.repo, src.ref)],
      [proc("git", "-C", repoDir, "rev-parse", "FETCH_HEAD")],
    ],
    timeoutMs: 300_000,
  });
  const sha = fetched.stdout.trim().split("\n").pop()!.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not resolve ${src.ref}: ${sha}`);
  const paths = includePaths(cfg, c);
  await job.run({
    label: `${COMPONENT_LABEL[c]}: export ${short(sha)} as a clean build context`,
    where: "local",
    run: [[emptyDir(ctx)], [proc(...GIT, "-C", repoDir, "archive", sha, ...(paths ? ["--", ...paths] : [])), extractTo(ctx, job)]],
  });
  const args = buildArgs(cfg, c);
  return {
    component: c,
    image: `talos/${c}:g${short(sha)}`,
    contextDir: ctx,
    buildKey: sha256([sha, JSON.stringify(paths), JSON.stringify(args), dockerfileHash(c)].join("|")),
    revision: sha,
    ref: src.ref,
    dirty: false,
    source: describeSource(src),
    buildArgs: args,
  };
}

function walkFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if ([".git", "__pycache__", "node_modules", ".venv", "build", ".cache"].includes(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, base, out);
    else if (st.isFile()) out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

async function prepareLocal(job: Job, cfg: Config, c: ComponentId, src: Extract<Source, { mode: "local" }>): Promise<Prepared> {
  const dir = resolve(ROOT, src.path);
  if (!existsSync(dir)) throw new Error(`${COMPONENT_LABEL[c]}: working copy ${dir} does not exist`);
  const paths = includePaths(cfg, c);
  const pathArgs = paths ? ["--", ...paths] : [];
  const ctx = join(CACHE, "ctx", c);
  const isGit = (await runArgv(["git", "-C", dir, "rev-parse", "--git-dir"])).code === 0;

  let sha: string | undefined;
  let branch: string | undefined;
  let dirty = true;
  let files: string[];
  if (isGit) {
    const info = await job.run({
      label: `${COMPONENT_LABEL[c]}: inspect working copy ${src.path}`,
      where: "local",
      run: [
        [proc("git", "-C", dir, "rev-parse", "HEAD")],
        [proc("git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD")],
        [proc("git", "-C", dir, "status", "--short", ...pathArgs)],
      ],
    });
    const [s, b, ...changes] = info.stdout.split("\n");
    sha = s?.trim();
    branch = b?.trim();
    dirty = changes.some((l) => l.trim());
    const ls = await runArgv(["git", "-C", dir, "ls-files", "-z", "-co", "--exclude-standard", ...pathArgs]);
    files = [...new Set(ls.stdout.split("\0").filter(Boolean))].filter((f) => {
      try {
        return statSync(join(dir, f)).isFile(); // skips deleted files and dangling symlinks
      } catch {
        return false;
      }
    });
  } else {
    files = (paths ?? ["."]).flatMap((p) => (statSync(join(dir, p)).isDirectory() ? walkFiles(join(dir, p), dir) : [p]));
  }
  files.sort();
  await job.run({
    label: `${COMPONENT_LABEL[c]}: copy ${files.length} files into a build context`,
    where: "local",
    run: [
      [emptyDir(ctx)],
      [
        task(
          `copy ${files.length} files from ${src.path} → ${ctx}  (${isGit ? "git ls-files -co --exclude-standard: tracked + untracked, minus .gitignore'd" : "not a git repo: everything except .git, caches, venvs"})`,
          () => {
            for (const f of files) {
              mkdirSync(dirname(join(ctx, f)), { recursive: true });
              copyFileSync(join(dir, f), join(ctx, f));
            }
          },
        ),
      ],
    ],
  });
  const h = createHash("sha256");
  for (const f of files) h.update(f + "\0").update(readFileSync(join(dir, f)));
  const contentHash = h.digest("hex");
  const tag = sha ? (dirty ? `g${short(sha)}-dirty-${short(contentHash, 8)}` : `g${short(sha)}`) : `local-${short(contentHash, 8)}`;
  const args = buildArgs(cfg, c);
  return {
    component: c,
    image: `talos/${c}:${tag}`,
    contextDir: ctx,
    buildKey: sha256([contentHash, JSON.stringify(paths), JSON.stringify(args), dockerfileHash(c)].join("|")),
    revision: sha,
    ref: branch,
    dirty,
    source: describeSource(src),
    buildArgs: args,
  };
}

async function prepare(job: Job, cfg: Config, c: ComponentId): Promise<Prepared> {
  const src = cfg.components[c].source;
  if (src.mode === "git") return prepareGit(job, cfg, c, src);
  if (src.mode === "local") return prepareLocal(job, cfg, c, src);
  const ctx = join(CACHE, "ctx", c);
  mkdirSync(ctx, { recursive: true });
  const key = sha256(dockerfileHash(c) + JSON.stringify(buildArgs(cfg, c)));
  const tag = c === "mediamtx" ? `${cfg.components.mediamtx.version}-${short(key, 6)}` : `b${short(key, 8)}`;
  return { component: c, image: `talos/${c}:${tag}`, contextDir: ctx, buildKey: key, source: describeSource(src), buildArgs: buildArgs(cfg, c) };
}

async function build(job: Job, p: Prepared, force: boolean) {
  const existing = await job.run({
    label: `${COMPONENT_LABEL[p.component]}: check for an up-to-date cached image`,
    where: "local",
    run: [[proc("docker", "image", "inspect", "--format", '{{index .Config.Labels "dev.talos.gaia.key"}}', p.image)]],
    allowFail: true,
  });
  if (!force && existing.stdout.trim() === p.buildKey) {
    job.log(job.steps.length - 1, `${p.image} already built from identical inputs, skipping build`);
    return;
  }
  const labels: Record<string, string> = {
    "dev.talos.gaia.key": p.buildKey,
    "dev.talos.gaia.source": p.source,
    "dev.talos.gaia.dirty": String(!!p.dirty),
    ...(p.revision ? { "org.opencontainers.image.revision": p.revision } : {}),
    ...(p.ref ? { "dev.talos.gaia.ref": p.ref } : {}),
  };
  const argv = [
    "docker", "buildx", "build",
    "--platform", PLATFORM,
    "--load",
    "--progress", "plain",
    "--build-context", `gaia=${STACK_DIR}`,
    "-f", join(STACK_DIR, `${p.component}.Dockerfile`),
    "-t", p.image,
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    ...Object.entries(p.buildArgs).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
    p.contextDir,
  ];
  await job.run({ label: `${COMPONENT_LABEL[p.component]}: build ${p.image} (${PLATFORM})`, where: "local", run: [[proc(...argv)]], timeoutMs: 3_600_000 });
}

async function localImageId(image: string): Promise<string> {
  const r = await runArgv(["docker", "image", "inspect", "--format", "{{.Id}}", image]);
  return r.stdout.trim();
}

const archivePath = (imageId: string) => join(CACHE, "images", `${imageId.replace("sha256:", "").slice(0, 16)}.tar`);

/** `docker save` once per image; reused for every Pi in the same deploy. */
async function saveImage(job: Job, image: string, imageId: string): Promise<string> {
  const file = archivePath(imageId);
  if (existsSync(file)) return file;
  mkdirSync(dirname(file), { recursive: true });
  await job.run({
    label: `Export ${image} to an archive`,
    where: "local",
    run: [[proc("docker", "save", image, "-o", file + ".part")], [task(`mv ${file}.part ${file}`, () => renameSync(file + ".part", file))]],
    timeoutMs: 600_000,
  });
  return file;
}

/**
 * Copy an image to the Pi, skipping it entirely if the Pi already has the same image ID.
 *
 * Layer-aware: `docker load` (classic image store, as on the lab Pis) never opens a layer whose
 * chain already exists, so Gaia strips the archive of the leading layers the Pi already has.
 * A one-line Pi-Vision change then ships only the top app layer, not the ~550 MB Python/OpenCV
 * base. If the trimmed load fails for any reason, it retries with the full archive.
 */
async function ship(job: Job, pi: PiCfg, image: string, imageId: string) {
  const D = docker(pi);
  const check = await job.run({
    label: `${pi.name}: does the Pi already have ${image} (or some of its layers)?`,
    where: "remote",
    pi,
    cmd:
      `echo "id=$(${D} image inspect --format '{{.Id}}' ${image} 2>/dev/null)"; ` +
      `ids=$(${D} images -q --no-trunc | sort -u); [ -z "$ids" ] || ${D} image inspect --format 'layers={{json .RootFS.Layers}}' $ids; true`,
  });
  const stepIdx = job.steps.length - 1;
  if (check.stdout.includes(`id=${imageId}`)) {
    job.log(stepIdx, "identical image already on the Pi, skipping transfer");
    return;
  }
  // Longest prefix of our layer chain that some image on the Pi already has.
  const ours = JSON.parse((await runArgv(["docker", "image", "inspect", "--format", "{{json .RootFS.Layers}}", image])).stdout) as string[];
  let common = 0;
  for (const line of check.stdout.split("\n")) {
    if (!line.startsWith("layers=")) continue;
    const theirs = JSON.parse(line.slice(7)) as string[];
    let k = 0;
    while (k < ours.length && k < theirs.length && ours[k] === theirs[k]) k++;
    common = Math.max(common, k);
  }
  const file = await saveImage(job, image, imageId);
  const manifest = JSON.parse((await tarReadFile(Bun.file(file).stream(), "manifest.json")) ?? "[]") as { Layers: string[] }[];
  const paths = manifest[0]?.Layers ?? [];
  const keep = new Set(paths.slice(common));
  const omit = new Set(paths.slice(0, common).filter((p) => !keep.has(p)));
  job.log(stepIdx, `Pi already has ${common} of ${ours.length} layers; sending ${ours.length - common}`);

  const tgt = await target(pi);
  const remoteCmd = `gunzip | ${D} load`;
  const send = (trim: boolean, label: string, allowFail: boolean) => {
    const source: Stage = trim
      ? { kind: "source", display: `read ${file}, minus ${omit.size} layer blobs the Pi already has`, make: () => tarFilter(Bun.file(file).stream(), omit) }
      : { kind: "source", display: `read ${file}`, make: () => Bun.file(file).stream() };
    const ssh: Stage = { kind: "proc", argv: sshArgv(pi, tgt, remoteCmd), display: sshDisplay(tgt, remoteCmd) };
    return job.run({ label, where: "local", run: [[source, gzip, ssh]], timeoutMs: 1_800_000, allowFail });
  };
  const res = await send(omit.size > 0, `${pi.name}: transfer ${image} (${ours.length - common}/${ours.length} layers)`, omit.size > 0);
  if (res.code !== 0) await send(false, `${pi.name}: retry with the full image`, false);
}

/** Files Gaia writes into ~/<stack.dir> on a Pi. Also used by the "Files" preview. */
export function stackFiles(cfg: Config, pi: PiCfg, images: Images, manifest?: Manifest): Record<string, string> {
  const files: Record<string, string> = {
    "compose.yaml": composeYaml(cfg, pi, images),
    "operator.conf": operatorConf(pi),
    [HELPER_PATH]: helperScript(cfg, pi),
  };
  if (manifest) files["gaia-manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";
  const rules = udevRules(pi);
  if (rules) files["70-talos-gaia.rules"] = rules;
  return files;
}

async function upload(job: Job, cfg: Config, pi: PiCfg, files: Record<string, string>) {
  const dir = join(CACHE, "deploy", pi.id);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  const tgt = await target(pi);
  const remoteCmd =
    `mkdir -p ~/${cfg.stack.dir}/logs && cd ~/${cfg.stack.dir} && ` +
    `for f in compose.yaml gaia-manifest.json; do [ -f $f ] && cp $f "previous-$f"; done; ` +
    `tar -xf - && chmod 0755 ${HELPER_PATH} && sudo -n ln -sfn "$HOME/${cfg.stack.dir}/${HELPER_PATH}" /usr/local/bin/talos && ls -l`;
  const names = Object.keys(files);
  await job.run({
    label: `${pi.name}: upload stack files to ~/${cfg.stack.dir} (previous compose.yaml kept as previous-compose.yaml)`,
    where: "local",
    run: [
      [
        { kind: "source", display: `tar ${names.join(" ")}  (copies in ${dir})`, make: () => new Blob([tarCreate(files) as Uint8Array<ArrayBuffer>]).stream() },
        { kind: "proc", argv: sshArgv(pi, tgt, remoteCmd), display: sshDisplay(tgt, remoteCmd) },
      ],
    ],
  });
}

export interface DeployOpts {
  start: boolean;
  force: boolean;
}

export async function deploy(job: Job, cfg: Config, pis: PiCfg[], opts: DeployOpts) {
  await job.run({
    label: "Local Docker is running (Docker Desktop, or Colima on macOS)",
    where: "local",
    run: [[proc("docker", "info", "--format", "docker {{.ServerVersion}} on {{.OperatingSystem}} ({{.Architecture}})")]],
  });

  const prepared = {} as Record<ComponentId, Prepared>;
  for (const c of COMPONENTS) {
    prepared[c] = await prepare(job, cfg, c);
    await build(job, prepared[c], opts.force);
  }
  const ids = {} as Record<ComponentId, string>;
  for (const c of COMPONENTS) ids[c] = await localImageId(prepared[c].image);
  const images = Object.fromEntries(COMPONENTS.map((c) => [c, prepared[c].image])) as Images;
  // Drop exported archives of images we're no longer deploying (they're ~100-600 MB each).
  const keepArchives = new Set(Object.values(ids).map(archivePath));
  const archiveDir = join(CACHE, "images");
  if (existsSync(archiveDir))
    for (const f of readdirSync(archiveDir)) if (!keepArchives.has(join(archiveDir, f))) rmSync(join(archiveDir, f), { force: true });

  for (const pi of pis) {
    const clock = syncClock();
    await job.run({ ...clock, pi, label: `${pi.name}: ${clock.label}` });
    const rt = ensureRuntime(pi);
    await job.run({ ...rt, pi, label: `${pi.name}: ${rt.label}` });
    for (const c of COMPONENTS) await ship(job, pi, images[c], ids[c]);
    const manifest: Manifest = {
      deployedAt: new Date().toISOString(),
      deployedBy: `${userInfo().username}@${hostname()}`,
      components: Object.fromEntries(
        COMPONENTS.map((c) => {
          const p = prepared[c];
          return [c, { image: p.image, imageId: ids[c], source: p.source, revision: p.revision, ref: p.ref, dirty: p.dirty }];
        }),
      ) as Manifest["components"],
    };
    await upload(job, cfg, pi, stackFiles(cfg, pi, images, manifest));
    // Validate before touching any running container, so a bad file can't leave a half-started stack.
    // Compose would also load a hand-made compose.override.yaml and silently override what Gaia
    // deploys (it happened on Bluey), so move one aside first.
    await job.run({
      label: `${pi.name}: validate compose.yaml`,
      where: "remote",
      pi,
      cmd: inStack(
        cfg,
        `if [ -f compose.override.yaml ]; then mv compose.override.yaml compose.override.yaml.disabled && ` +
          `echo "moved a hand-made compose.override.yaml aside to compose.override.yaml.disabled: Gaia's compose.yaml is the whole config"; fi; ` +
          `${compose(pi)} config --quiet && echo "compose.yaml is valid"`,
      ),
    });
    if (opts.start) {
      // MediaMTX moved into the stack; the old host service would hold port 8554.
      await job.run({ label: `${pi.name}: retire the host MediaMTX service, if any`, where: "remote", pi, cmd: talos("retire-host-mediamtx") });
      await job.run({
        label: `${pi.name}: preflight, then start (only containers whose image or config changed are recreated)`,
        where: "remote",
        pi,
        cmd: talos("start"),
      });
    }
  }
}

/** Quick, non-building look at what a source currently points to (for the Sources panel). */
export async function resolveSource(cfg: Config, c: ComponentId): Promise<{ text: string; cmd: string; ok: boolean }> {
  const src = cfg.components[c].source;
  if (src.mode === "git") {
    const cmd = `git ls-remote ${sq(src.repo)} ${sq(src.ref)}`;
    if (/^[0-9a-f]{40}$/.test(src.ref)) return { text: `pinned commit ${short(src.ref)}`, cmd: "(none: ref is a commit)", ok: true };
    const r = await runArgv(["git", "ls-remote", src.repo, src.ref], { timeoutMs: 15000 });
    const line = r.stdout.split("\n").find((l) => /refs\/(heads|tags)\//.test(l)) ?? r.stdout.split("\n")[0];
    const sha = line?.split(/\s+/)[0];
    if (r.code !== 0 || !sha) return { text: `could not resolve: ${(r.stderr || "ref not found").trim().split("\n").pop()}`, cmd, ok: false };
    return { text: `${src.ref} → ${short(sha)}`, cmd, ok: true };
  }
  if (src.mode === "local") {
    const dir = resolve(ROOT, src.path);
    const paths = includePaths(cfg, c);
    const cmd = rel(`git -C ${sq(dir)} rev-parse --abbrev-ref HEAD && git -C ${sq(dir)} rev-parse --short HEAD && git -C ${sq(dir)} status --porcelain${paths ? " -- " + paths.map(sq).join(" ") : ""}`);
    if (!existsSync(dir)) return { text: `${dir} does not exist`, cmd, ok: false };
    const branch = await runArgv(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.code !== 0) return { text: "not a git repo (content-hashed)", cmd, ok: true };
    const sha = await runArgv(["git", "-C", dir, "rev-parse", "--short", "HEAD"]);
    const st = await runArgv(["git", "-C", dir, "status", "--porcelain", ...(paths ? ["--", ...paths] : [])]);
    const n = st.stdout.split("\n").filter(Boolean).length;
    return { text: `${branch.stdout.trim()} @ ${sha.stdout.trim()}${n ? ` + ${n} uncommitted change${n === 1 ? "" : "s"}` : " (clean)"}`, cmd, ok: true };
  }
  if (c === "mediamtx") return { text: `bluenviron/mediamtx:${cfg.components.mediamtx.version} + stack/mediamtx.yml`, cmd: "", ok: true };
  return { text: "stack/" + c + ".Dockerfile", cmd: "", ok: true };
}
