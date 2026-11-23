# Gaia

A small web app for deploying and running the Talos Pi stack (**Operator**, **Cam Streamer**, **MediaMTX**, **Pi-Vision**) on any number of Raspberry Pis, plus **Commander** on your own machine, with every command it runs shown to you.

```sh
bun install
bun run dev          # → http://localhost:4747
```

Works on **macOS, Linux and plain Windows** (no WSL or Git Bash needed). Your machine needs:

- [Bun](https://bun.sh) ≥ 1.3 (Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`)
- `git`
- `ssh` with key access to the Pis: `ssh pi@bingo.local` must work without a password prompt. Windows 10/11 ships OpenSSH. To set up a key once from PowerShell:
  ```powershell
  ssh-keygen -t ed25519            # accept the defaults
  type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh pi@bingo.local "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
  ```
- Docker with buildx to build images: Docker Desktop, or Colima on macOS (the header has a **Start Colima** button). The header warns if any of these are missing.

Each Pi needs only Raspberry Pi OS (Debian bookworm) with `python3`, SSH key access and passwordless `sudo` for the SSH user. **Troubleshoot › Install Docker** installs Docker from Docker's official packages, downloaded on your machine, since the Pis have no internet. Everything else, MediaMTX included, runs in containers.

## What it does

- **Status at a glance** for every Pi, polled every 5 s over one shared SSH connection:
  - **Operator**: container state, listening socket, serial device present, and whether arm telemetry is fresh, read from Pi-Vision's view. Gaia never connects to Operator's port itself, because Operator accepts only one client and Pi-Vision is that client. Operator builds from 2026-11-23 also log a `Serial link:` summary every 10 s (damaged replies, framing errors, recovered prompts); Gaia sums the last minute and warns at 5% damaged, or as soon as Operator had to recover a lost prompt, which is what a loose serial connector looks like.
  - **Cam Streamer**: `ffprobe` on the RTSP path, run *on the Pi* about every 15 s. Healthy means at least one video frame with a non-zero size arrived. **Snapshot** grabs one frame so you can see it.
  - **Pi-Vision**: `/api/status` and `/api/v1/observations`. Healthy means the pose model loaded, fps is above 0, and the observation sequence number advances between polls, even when no person is detected.
  - **Host**: Docker runtime, legacy systemd units that would steal the camera, throttling, temperature, disk, CMA, and containers that Gaia didn't deploy.
- **Start / Stop / Restart** the whole stack or a single service, plus **Logs** (live tail, like Portainer) and **Log file** (`operator.log`).
- **Deploy** builds four arm64 images on your machine, copies them to the Pi over SSH, writes `~/talos-stack/compose.yaml`, and starts the stack. The Pis need no internet access.
- **Troubleshoot** menu: re-apply USB rules (what `install-usb-rules.sh` did), detect USB devices, see who owns the serial port or camera, reset a stuck ESP via RTS, restart MediaMTX, stop legacy host services or old containers, check host health, read kernel warnings, fix a lost `.local` name (avahi), prune images, reboot.

### Seeing what runs

Hover any button for about half a second to see the exact command or commands it will run. Remote commands run in the Pi's bash. Local commands run as programs (`git`, `docker`, `ssh`) without a shell. Work Gaia does itself, such as tar, gzip and file copies, appears as `[gaia] …` in the command line. That's what lets the same code run on Windows. Clicking opens the **Activity** drawer, which shows each step's command followed by its live output. Remote commands are shown as `ssh pi@host '<cmd>'`; the only things left out are the connection-sharing `-o` options (see `src/core/ssh.ts`). **More › How is status checked?** shows the probe script and the latest raw result. **More › Generated files** shows the `compose.yaml`, `operator.conf` and udev rules Gaia writes.

Every action is defined once, in `src/core/actions.ts`. The same step list is both displayed and executed, so what you see is what runs.

## Choosing what gets deployed

The **Sources** panel (or `gaia.config.yaml` › `components`) picks where each image comes from:

| Mode | Config | Build context |
|---|---|---|
| Pinned ref | `{ mode: git, repo: https://github.com/talos-rit/operator.git, ref: twinning }` | A fresh `git fetch` of exactly that branch, tag or commit, exported with `git archive`. Local patches can't sneak in. |
| Working copy | `{ mode: local, path: ../operator }` | Your checkout as it is now: tracked and untracked files, minus `.gitignore`'d ones. The image is tagged `g<sha>-dirty-<contenthash>`. |
| Built-in | `{ mode: builtin }` | Only `stack/<component>.Dockerfile` (Cam Streamer is plain Debian ffmpeg). |

Changes made in the UI go to **`gaia.local.yaml`**, which is git-ignored and applied over the shared `gaia.config.yaml` (see [Configuration](#configuration)). Each person can deploy their own working copy without editing the team's config.

Builds are cached by their inputs: commit or content hash, Dockerfile, and build args. Deploying the same thing twice rebuilds nothing. Transfers skip any image the Pi already has. For a new image they send **only the layers the Pi is missing**, so a one-line Pi-Vision change ships a few KB instead of ~580 MB. Each Pi records what was deployed in `~/talos-stack/gaia-manifest.json` (source, revision, dirty flag, who deployed it and when), and the card shows it. A card warns when a running container doesn't match the deployed image.

> **Sources by default:** Operator from `operator@feat/dual-arm-containers`, Pi-Vision from `pi-vision@feat/dual-arm-integration` (until it's merged to `master`), Cam Streamer from `cam_streamer@main`, which runs its `scripts/stream_camera.sh` with env vars generated per Pi, and MediaMTX from the official `bluenviron/mediamtx` image plus `stack/mediamtx.yml`.
>
> Publishing at 10 fps from a 30 fps MJPEG capture needs `OUTPUT_FPS`, added on cam_streamer's `feat/output-fps` branch. An older script ignores it and publishes at 30 fps.

## Commander

The **Commander** card manages a Commander checkout on this machine (`commander.path` in `gaia.config.yaml`, `../commander` by default). It runs directly, not in Docker, and needs [uv](https://docs.astral.sh/uv/getting-started/installation/).

- **Set up** (when there's no checkout yet): `git clone --branch <commander.branch>`, then the same steps as Build & run.
- **Build & run**: create Commander's config files if they're missing, `uv sync --inexact` (no extras: Pi-Vision does the pose detection, so Commander needs neither YOLO nor MediaPipe), `bun install` and `bun run build` in `web/`, then (re)start `uv run commander-web`.
- **Start / Stop / Restart** without rebuilding, **Logs** (live), **Branch** (fetch, `git switch`, `git pull --ff-only`, then optionally Build & run) and **Pull**.

**Config files.** From the Pis in `gaia.config.yaml` + `gaia.local.yaml`, Gaia writes `config/robot_configs.local.yaml` (one entry per Pi: Operator port, RTSP URL, Pi-Vision URL, controller profile) and `config/app_settings.local.yaml` (feeds 1 and 2 = the first two Pis). It **only creates them when they don't exist** and never overwrites one. **More › Config files Gaia creates** shows what it would write, so you can copy entries into an existing file by hand.

**The process.** commander-web runs detached, with its output in `.cache/commander/commander.log` (the previous run's in `commander.previous.log`), and Gaia tracks it through `.cache/commander/process.json`. It keeps running when Gaia restarts or stops; the next Gaia picks it up again. Stop is a Ctrl+C for its whole process group (SIGKILL after 20 s); on Windows it's `taskkill /T /F`. Gaia reads Commander's `web_host`/`web_port` from its app settings (and `COMMANDER_WEB_*` env vars) to link to it and check `/api/health`.

## Agents (MCP)

The running Gaia also serves an [MCP](https://modelcontextprotocol.io) server at `http://localhost:4747/mcp` (Streamable HTTP), so a coding agent can do everything the UI does: check status, start/stop/restart services, deploy (including from a working copy), read logs, grab a camera frame, troubleshoot, power off or reboot Pis, and manage Commander. Its jobs are the UI's jobs: they take the same per-Pi locks and appear in the Activity drawer as they run.

Gaia must be running (`bun run dev`). To register it:

```sh
claude mcp add --scope user --transport http gaia http://localhost:4747/mcp   # Claude Code, from any directory
```

This checkout's `.mcp.json` already registers it for agents working inside `gaia/`. Other harnesses take the same URL as an HTTP / Streamable HTTP server; one that only speaks stdio can use `npx mcp-remote http://localhost:4747/mcp`.

Tools that change something wait for their job (`wait_seconds`) and then re-poll the Pi, so the agent sees the result in one call. A job still running when the wait ends keeps going, and `get_job` waits for it. Homing is treated as harmless, so Start and Deploy don't ask first. The `power` tool tells agents to power off or reboot only with the user's assent, but informal or contextual assent is enough. The tools live in `src/mcp.ts`.

## Configuration

Gaia reads two files:

- **`gaia.config.yaml`** (committed): the team's defaults. That's the component sources and the RIT lab's Pis (Bingo and Bluey), so a teammate who clones Gaia has a working setup without configuring anything.
- **`gaia.local.yaml`** (git-ignored): this computer's changes, as a [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7386) over the shared file. It uses the same keys, objects merge field by field, lists are replaced, and `null` removes a key. You rarely edit it by hand, because the UI writes it:
  - **Sources** panel: where each image is built from.
  - A Pi's **More › Settings** and **Fleet › Add a Pi**: the Pis.
  - **Settings** in the header: everything else (Commander's checkout, each component's build options such as Pi-Vision's model and environment and its Docker build arguments, the stack's folder and compose project on the Pis, and Gaia's port).

  A blue dot marks each field this computer changes; its reset button puts `gaia.config.yaml`'s value back (Save to keep it). A Pi's settings also have **Reset to shared** for the whole Pi.

```yaml
# gaia.local.yaml: Bluey on a different network, Bingo hidden, plus a Pi of my own
pis:
  bluey: { fallbackHosts: [10.0.0.42] }
  bingo: null
  shelf-pi: { name: Shelf Pi, host: shelf.local, arm: { controller: talos, homesOnStart: false } }
```

Pis are keyed by id. The id names the Pi's devices (`/dev/talos-<id>-serial`) and its robot entry in Commander, so it can't be changed once set. A Pi entry only needs `host`; the other fields have defaults (listed at the top of `pis:` in `gaia.config.yaml`).

`arm.controller` is the hardware: `native` (a Scorbot controller box) or `talos` (our custom ESP32 board). Gaia keys hardware differences on it: **Reset ESP** is only offered on `talos`, and Commander's config never tracks with the shoulder on `talos`, which doesn't drive it. Both speak Operator's `native` protocol. Older configs that say `controller: esp-one-axis` (Operator's profile for the retired one-axis firmware) still load as `talos`, and Gaia rewrites them that way in `gaia.local.yaml`.

**Not in the RIT lab?** Open each lab Pi's **More › Settings** and choose **Remove from Gaia**, then add your own. This only writes `bingo: null` and `bluey: null` to your `gaia.local.yaml`, so pulling new versions of Gaia never conflicts. Removed Pis can be restored from **Fleet › Add a Pi**.

## Adding a Pi

1. Flash Raspberry Pi OS Lite (64-bit), with SSH and your key enabled, and give it a unique hostname.
2. **Fleet › Add a Pi**: name, host, SSH user and the arm's controller. **Detect USB devices** in the same form lists the Pi's serial adapters and cameras; **Use as serial adapter** / **Use as camera** fills in the USB fields. The Pi is saved to `gaia.local.yaml` (on this computer only).
3. **Troubleshoot › Install Docker.**
4. If the SD card was copied from another Pi, run **Troubleshoot › Give this Pi its own identity** (Gaia warns when two Pis share a machine-id). Cloned Pis generate the same IPv6 addresses, and avahi then renames one of them to `<name>-2.local`.
5. **Troubleshoot › Re-apply USB rules** creates `/dev/talos-<id>-serial` and `/dev/talos-<id>-camera`.
6. **Deploy.**

To give the whole team a Pi (or a change to a lab Pi), copy the YAML at the bottom of its **More › Settings** into `gaia.config.yaml`, commit it, then use **Reset to shared** so your local copy doesn't shadow later changes.

When `<name>.local` doesn't resolve, Gaia also tries `fallbackHosts` and the IP addresses it last saw the Pi on (`.cache/addresses.json`, only used if the same hostname answers). Every address is checked against the host key recorded for `host`.

## On the Pi: the `talos` command

Deploy installs a small script, `~/talos-stack/bin/talos`, linked as `/usr/local/bin/talos`. Every Gaia button runs one `talos …` command, which is what the hover preview shows. After `ssh pi@bingo.local` you can run the same commands yourself: `talos stop`, `talos logs vision -f`, `talos start camera`, `talos help`. `cat $(which talos)` shows what each one does.

## Safety

- Starting Operator on a native-controller arm (`homesOnStart: true`) **physically homes it**, so Start, Restart, and Deploy ask for confirmation. Operator uses `restart: "no"`, so nothing restarts the arm unattended, not even a reboot.
- MediaMTX, the camera and Pi-Vision use `restart: unless-stopped`: they restart after a crash and come up at boot, unless you stopped them.
- One mutating job runs per Pi at a time.
- Gaia listens on `127.0.0.1` only. It refuses other `Host` headers and requires a custom header on POSTs, so a web page can't trigger actions on your robots. `/mcp` takes only JSON (which a cross-site page can't send without a CORS preflight Gaia never answers) and refuses foreign `Origin` headers. `HOST=0.0.0.0 bun run dev` exposes it to your network *without authentication*; don't.

## Moving from `two-pi-20261104`

Gaia deploys into `~/talos-stack` as compose project `talos`. It leaves `~/talos-containers` alone, and the old stack keeps working for rollback. The two must not run at the same time, because they share the same USB devices and ports. Deploy's preflight refuses to start while old `talos-arms-*` containers are running, and **Troubleshoot › Stop non-Gaia containers** stops them. `sh stack.sh --profile bingo up -d` in the old folder still brings the old stack back.

What changed compared with the old scripts:
- There are four images, one per component, instead of one shared `talos-arms` image. MediaMTX moved from a host service into the stack.
- A normal Docker install replaces the isolated `talos-docker.service` runtime.
- Images are built on your laptop rather than on the Pi. No venv or binary is copied, and the Pi needs no build tools.
- `compose.yaml` is generated per Pi, so each Pi runs four services with no profiles.
- The vision container has a Docker healthcheck.

The resource caps, SIGINT shutdown, host networking and `/dev/video11` passthrough are unchanged.

## Layout

```
gaia.config.yaml      lab fleet + sources (shared)   gaia.local.yaml   this computer's changes (ignored)
stack/                Dockerfiles, pinned Pi-Vision deps, mediamtx.yml
src/core/             no UI code: config, ssh, actions, jobs, status probe, build/deploy, compose generation
src/ui/, src/server.tsx   Hono + JSX + htmx; public/ has the small client script and CSS
src/mcp.ts            MCP server for agents (mounted at /mcp; uses the same src/core/ops.ts as the UI)
.cache/               git mirrors, build contexts, image archives, files last uploaded to each Pi, commander/ (log, pid)
```

`src/core` has no web dependencies, so a future Electron or installer front-end can reuse it as is.

## Limitations / next steps

- **Building on x86 (most Windows laptops):** the Pis are arm64.
  - Operator cross-compiles natively, and its tests run natively.
  - The Pi-Vision and Cam Streamer builds run their `apt`/`pip` steps under Docker Desktop's QEMU emulation. The first build takes a few minutes; after that it's cached, and code-only changes rebuild in seconds.
- **No SSH connection sharing on Windows:** Windows' OpenSSH can't multiplex connections, so each status poll opens a fresh connection (about 0.5 s). It works, just with a little more overhead.
- Rollback is manual for now: `previous-compose.yaml` sits next to `compose.yaml` on the Pi, and the old images stay tagged.
