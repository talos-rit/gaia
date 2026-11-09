# Gaia

A small web app for deploying and running the Talos Pi stack (**Operator**, **Cam Streamer**, **Pi-Vision**) on any number of Raspberry Pis, with every command it runs shown to you.

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

Each Pi needs Docker (the lab Pis' isolated runtime, or a stock install), MediaMTX on port 8554, `python3`, and passwordless `sudo` for the SSH user.

## What it does

- **Status at a glance** for every Pi, polled every 5 s over one shared SSH connection:
  - **Operator**: container state, listening socket, serial device present, and whether arm telemetry is fresh, read from Pi-Vision's view. Gaia never connects to Operator's port itself, because Operator accepts only one client and Pi-Vision is that client.
  - **Cam Streamer**: `ffprobe` on the RTSP path, run *on the Pi* about every 15 s. Healthy means at least one video frame with a non-zero size arrived. **Snapshot** grabs one frame so you can see it.
  - **Pi-Vision**: `/api/status` and `/api/v1/observations`. Healthy means the pose model loaded, fps is above 0, and the observation sequence number advances between polls, even when no person is detected.
  - **Host**: Docker runtime, legacy systemd units that would steal the camera, throttling, temperature, disk, CMA, and containers that Gaia didn't deploy.
- **Start / Stop / Restart** the whole stack or a single service, plus **Logs** (live tail, like Portainer) and **Log file** (`operator.log`).
- **Deploy** builds three arm64 images on your machine, copies them to the Pi over SSH, writes `~/talos-stack/compose.yaml`, and starts the stack. The Pis need no internet access.
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

Changes made in the UI go to **`gaia.local.yaml`**, which is git-ignored and deep-merged over the shared `gaia.config.yaml`. Each person can deploy their own working copy without editing the team's config.

Builds are cached by their inputs: commit or content hash, Dockerfile, and build args. Deploying the same thing twice rebuilds nothing. Transfers skip any image the Pi already has. For a new image they send **only the layers the Pi is missing**, so a one-line Pi-Vision change ships a few KB instead of ~580 MB. Each Pi records what was deployed in `~/talos-stack/gaia-manifest.json` (source, revision, dirty flag, who deployed it and when), and the card shows it. A card warns when a running container doesn't match the deployed image.

> **Sources by default:** Operator from `operator@feat/dual-arm-containers`, Pi-Vision from `pi-vision@master`, and Cam Streamer from `cam_streamer@main`, which runs its `scripts/stream_camera.sh` with env vars generated per Pi.
>
> The old two-Pi containers ran Pi-Vision from `commander/tools/pi_tracker`. That copy added `--inference-fps` and `--processing-width` so two workers could share one Pi; `pi-vision` doesn't have them and runs inference uncapped, within the container's 2.5-CPU limit.
>
> Publishing at 10 fps from a 30 fps MJPEG capture needs `OUTPUT_FPS`, added on cam_streamer's `feat/output-fps` branch. Until that's merged, point Cam Streamer at your working copy (`{ mode: local, path: ../cam_streamer }`). An older script ignores `OUTPUT_FPS` and publishes at 30 fps.

## Adding a Pi

Add an entry under `pis:` in `gaia.config.yaml`. Use **Troubleshoot › Detect USB devices** on the new Pi to find the `ID_PATH` / vendor / product values for `usb:`, then run **Re-apply USB rules** to create `/dev/talos-<id>-serial` and `/dev/talos-<id>-camera`. Set `runtime: system` if the Pi uses a normal Docker install rather than the lab's isolated `/run/talos-docker.sock` daemon. List extra addresses in `fallbackHosts`. Gaia tries them all and uses the first that answers, which helps when `bluey.local` breaks because avahi renamed it to `bluey-2.local`.

## Safety

- Starting Operator on a native-controller arm (`homesOnStart: true`) **physically homes it**, so Start, Restart, and Deploy ask for confirmation. Containers use `restart: "no"` on purpose, so nothing restarts the arm unattended.
- One mutating job runs per Pi at a time.
- Gaia listens on `127.0.0.1` only. It refuses other `Host` headers and requires a custom header on POSTs, so a web page can't trigger actions on your robots. `HOST=0.0.0.0 bun run dev` exposes it to your network *without authentication*; don't.

## Moving from `two-pi-20261104`

Gaia deploys into `~/talos-stack` as compose project `talos`. It leaves `~/talos-containers` alone, and the old stack keeps working for rollback. The two must not run at the same time, because they share the same USB devices and ports. Deploy's preflight refuses to start while old `talos-arms-*` containers are running, and **Troubleshoot › Stop non-Gaia containers** stops them. `sh stack.sh --profile bingo up -d` in the old folder still brings the old stack back.

What changed compared with the old scripts:
- There are three images, one per component, instead of one shared `talos-arms` image.
- Images are built on your laptop rather than on the Pi. No venv or binary is copied, and the Pi needs no build tools.
- `compose.yaml` is generated per Pi, so each Pi runs three services with no profiles.
- The vision container has a Docker healthcheck.

The resource caps, SIGINT shutdown, host networking and `/dev/video11` passthrough are unchanged.

## Layout

```
gaia.config.yaml      fleet + sources (shared)       gaia.local.yaml   personal overrides (ignored)
stack/                Dockerfiles + pinned Pi-Vision deps (pi-vision's requirements.txt omits onnxruntime)
src/core/             no UI code: config, ssh, actions, jobs, status probe, build/deploy, compose generation
src/ui/, src/server.tsx   Hono + JSX + htmx; public/ has the small client script and CSS
.cache/               git mirrors, build contexts, image archives, files last uploaded to each Pi
```

`src/core` has no web dependencies, so a future Electron or installer front-end can reuse it as is.

## Limitations / next steps

- **Building on x86 (most Windows laptops):** the Pis are arm64.
  - Operator cross-compiles natively, and its tests run natively.
  - The Pi-Vision and Cam Streamer builds run their `apt`/`pip` steps under Docker Desktop's QEMU emulation. The first build takes a few minutes; after that it's cached, and code-only changes rebuild in seconds.
- **No SSH connection sharing on Windows:** Windows' OpenSSH can't multiplex connections, so each status poll opens a fresh connection (about 0.5 s). It works, just with a little more overhead.
- MediaMTX runs as a host systemd service. That's how the two-Pi setup ran it too; it was a host prerequisite there. Moving it into the stack (`bluenviron/mediamtx`) would make a fresh Pi a pure `docker compose up`, and its API would allow a cheaper stream health check.
- Rollback is manual for now: `previous-compose.yaml` sits next to `compose.yaml` on the Pi, and the old images stay tagged.
