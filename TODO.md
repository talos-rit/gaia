# Gaia TODO

Things we've agreed to change, and the open decisions. Keep this current: if it isn't
written here, assume nobody remembers it.

## Current baseline (2026-11-06)

What Gaia deploys right now, chosen to reproduce the Nov 5 demo exactly:

| Component | Source | Why |
|---|---|---|
| Operator | `operator` @ `feat/dual-arm-containers` | what the demo ran |
| Pi-Vision | `pi-vision` @ `feat/dual-arm-integration` (local worktree via `gaia.local.yaml` until pushed), 320 model, `POSE_THREADS=2` | canonical repo; 320 for small targets (~3.5 fps accepted 2026-11-09) |
| Cam Streamer | `cam_streamer` working copy, branch `feat/output-fps` (via `gaia.local.yaml`) | reproduces the demo's ffmpeg command (MJPEG 30 fps in → 10 fps out) |
| MediaMTX | host systemd service (`mediamtx.service`) | unchanged from before containers |

## Pi-Vision: one canonical copy (the `pi-vision` repo)

**Canonical = the `pi-vision` repo, always.** History, so nobody re-derives it:

- Until 2026-11-02, Bingo ran real pi-vision as a systemd service (`~/talos-vision-releases/…`).
- On 2026-11-03 the emergency container work (`operator/deploy/dual-arm`, probably AI-written)
  built Pi-Vision from **Commander's** `tools/pi_tracker` instead, and added dual-arm features
  only there.
- Both copies got elbow/shoulder tracking on 2026-10-23, which is why it kept working and the
  switch went unnoticed.

What `commander/tools/pi_tracker` has that pi-vision `master` lacks (Commander depends on #1):

1. **Controller-profile relay.** Operator sends `PROFILE native|esp-one-axis`; Pi-Vision reports
   it as `controller_profile` in `GET /api/v1/control/status`. **Commander blocks all motion
   without it** (Stop still works). `operator_client.py`, `control_api.py`.
2. **`ACK\0` receipt handling.** Operator `feat/dual-arm-containers` writes ACK tokens; pi-vision's
   line parser doesn't strip them. `operator_client.py`.
3. **`--inference-fps` / `--processing-width`.** Without them pi-vision runs uncapped on full
   720p frames (~130% CPU on a Pi 4). `main.py`, `config.py`, new `inference_rate.py`.
4. **Dual-stack `--host ::`.** Not needed; Gaia now passes `--host 0.0.0.0` like the old service.

pi-vision-only bug: **`web_server.py` skeleton overlay passes float keypoints to `cv2.line`**,
which crashes the MJPEG dashboard stream whenever a person is detected.

- [ ] Review the port on branch `feat/dual-arm-integration` (worktree `../pi-vision-dual-arm`,
      uncommitted). It brings 1-3 over from Commander's copy and fixes the `cv2.line` bug.
      Everything else that differs from Commander's copy is pi-vision being *newer* (head-aim /
      eye-line framing) or reformatting (`identity.py`). Commit → PR → merge.
      - 2026-11-09: tests pass in the image; the fake-Operator test passes (PROFILE + ACK).
        **Running on Bingo** via a `gaia.local.yaml` override: `controller_profile: native`.
        Not yet verified by a person: Commander jog, skeleton overlay, elbow tracking.
      - [ ] **Speed:** the 320 model with `POSE_THREADS=1` reaches only 2.7 fps (0.39 s per inference,
            python at ~120% CPU). The demo ran the 192 model at 3.5 fps. Options: add
            `yolo11n-pose-192.onnx` to pi-vision, or use `POSE_THREADS=2`.
            Tried `POSE_THREADS=2` (2026-11-09, local override): 3.3-3.8 fps, 0.33 s per inference,
            python ~205% CPU, camera still 10.5 fps, 65 °C, no throttling. A small gain for about half a
            core more. Next to try: the 192 model.
- [x] Switch `gaia.config.yaml` vision to `pi-vision` (2026-11-09; ref `feat/dual-arm-integration`).
- [ ] After the merge: set the ref to `master` and drop the vision override from `gaia.local.yaml`.
- [ ] Delete `commander/tools/pi_tracker` (or replace it with a pointer to pi-vision) so this
      can't happen again.
- [x] Decided: 320 model, `POSE_THREADS=2`, `INFERENCE_FPS=4` cap (~3.5 fps actual).
- [ ] pi-vision README is stale outside the config section (tests via `commander`, `deploy_to_pi.bat`,
      `MODEL_WEIGHTS=yolo26n.onnx`); `yolo26n.onnx` is a dangling symlink; `__pycache__` is tracked.

## Cam Streamer

- [ ] Review → commit → PR `cam_streamer` branch `feat/output-fps` (uncommitted): adds
      `OUTPUT_FPS` + `KEYFRAME_INTERVAL` to `scripts/stream_camera.sh`, plus a README table.
- [ ] After merge: remove the `camera` override from `gaia.local.yaml` (shared config already
      points at `cam_streamer@main`).

## MediaMTX into the stack (agreed: yes)

Goal: a fresh Pi only needs Docker.

- [ ] Add a `mediamtx` service (`bluenviron/mediamtx`, pin to the host's 1.15.3) with a
      Gaia-generated `mediamtx.yml` (publisher paths, API on 127.0.0.1:9997 for health checks).
- [ ] Migration on each Pi: stop + disable host `mediamtx.service` (Troubleshoot action), make
      preflight catch a still-running host MediaMTX on :8554.
- [ ] Use MediaMTX's API for stream health instead of ffprobe.

## Bluey: no telemetry on the custom controller

- [ ] Per-arm `telemetry: false` in `gaia.config.yaml`. Operator health then uses container +
      listening socket + Pi-Vision connection + log activity, and never warns "no telemetry".

## Where images get built (open decision)

Today: on the laptop (needs Docker Desktop/Colima), shipped as layer diffs over SSH.
Alternative: ship source to the Pi and `docker build` there, so laptops need only ssh + git + Bun.

- Pro: Windows teammates skip Docker Desktop entirely.
- Con: slower builds on a Pi 4; apt/pip need internet. The emergency scripts solved that with an
  HTTP proxy tunnelled from a laptop (`download_proxy.py`, `HTTP_PROXY=127.0.0.1:18081` in
  `talos-docker.service`). It's only needed when dependencies change.
- [ ] Decide. Lotus rule: whichever has fewer moving parts for the team.

## Windows

- [ ] Have a teammate run `bun install && bun run dev` on plain Windows. Nothing has been
      tested on Windows yet; the cross-compile path was only tested by forcing x86 on a Mac.

## Hardware notes

- Bingo's Scorbot controller printed `USER RAM CHECKPOINT ERROR → INSTALLING DEFAULT SETUP` at
  power-on (2026-11-06), then `Illegal Trap` two minutes after homing. If the checkpoint error
  appears on *every* power-on, suspect the controller's backup battery. Its fan bearing is also
  failing (loud).

- Bluey's `bluey.local` stops resolving because avahi hits a **host-name conflict at boot** and
  renames itself to `bluey-2.local` (seen 2026-11-09; its Ethernet and Wi-Fi were both on the LAN
  during boot). Troubleshoot › Restart avahi fixed it. If it keeps happening, consider having Gaia
  detect a `-2` name.

## Command previews are too noisy (UI)

The hover previews only earn their place if they *teach* something; right now they're walls of
`sudo -n /opt/talos-docker/29.8.2/docker -H unix:///run/talos-docker.sock …` with `'\''` quoting
noise, which mostly distracts. Either shorten them (below) or remove them. Ideas, roughly in
order of payoff:

1. **Drop the isolated Docker runtime; use a stock Docker install.** It is the main source of
   length. The isolated daemon (`/run/talos-docker.sock`, `talos-docker.service`, standalone
   `docker-compose` binary under `/opt/talos-docker/29.8.2`) exists only because the emergency
   setup didn't want Docker touching the host's firewall/bridges. With stock Docker and `pi` in
   the `docker` group, `sudo -n /opt/…/docker -H unix:///…` becomes plain `docker` and
   `sudo -n env DOCKER_HOST=… /opt/…/docker-compose` becomes `docker compose`. It's also the
   standard thing a new user would install (pairs with "MediaMTX into the stack" above). Cost:
   one-time install per Pi (offline: ship the Docker `.deb`s, or one hotspot session).
2. **A tiny helper on each Pi, uploaded by Deploy:** e.g. `~/talos-stack/talos`:
   `talos up | stop | restart [svc] | logs <svc> | ps | preflight`. Previews become
   `ssh pi@bingo.local talos stop`, which is short and is something you can type yourself after
   `ssh`-ing in (that's the teaching value). The full command is one `cat ~/talos-stack/talos` away.
   Same idea for the long inline scripts (preflight, USB detect, host check, RTS reset): ship them as
   files in `~/talos-stack/bin/` instead of inlining them into the ssh command.
3. **No `cd ~/talos-stack &&`:** `docker compose -p talos stop` works without a directory for
   existing containers (stop/restart/logs/ps); only `up` needs the compose file. The helper hides
   this anyway.
4. **No single quotes in remote commands.** The `'\''` noise comes from quoting Go templates
   (`--format '{{.Id}}'`) inside the ssh argument. Moving those into helper scripts removes it.
5. **Show a summary in the preview, the literal command in the Activity log.** For example,
   `docker compose stop` in the hover, the exact ssh line in the job view. Elide the noisy parts
   of local steps (`--label …` ×5, `--build-arg …`, `.cache/…` paths) as `…` in the preview only.
6. **Fallback if previews stay:** show them only on hover of a small `⌘`/`?` icon next to a button
   (not the whole button), or behind a global "show commands" toggle, off by default.

## Commander local testing → containers

`project_documentation/technical/commander/Commander WebUI Local Testing.md` (276 lines) walks a
teammate through installing MediaMTX + FFmpeg + pi-vision + Commander by hand, per OS. Most of it
can become one `docker compose up` (e.g. `gaia/local-test/compose.yaml`, or a "Local test" mode in
Gaia), keeping the guide as the "how it works" explainer:

- **MediaMTX:** the `bluenviron/mediamtx` image, ports 8554 (RTSP) and 8889 (WebRTC).
- **Pi-Vision:** the same Dockerfile Gaia already has, built for the *host* platform (amd64 on
  Windows) instead of arm64: `--camera rtsp://mediamtx:8554/camera --edge-control`.
- **Camera, the catch:** Docker Desktop on macOS/Windows can't pass a webcam into a container.
  Options:
  - **Browser publishing (recommended):** MediaMTX serves a built-in WebRTC publish page at
    `http://localhost:8889/camera/publish`. Open it, allow the camera, and it publishes to the
    `camera` path, which Commander and Pi-Vision then read over RTSP. No FFmpeg on the host, and
    the same steps on every OS. (Check the latency and codec on Commander's side; the guide
    insists on H.264 with `-g 30 -bf 0`.)
  - **Test video file:** an `ffmpeg` container looping a clip (`-re -stream_loop -1 -i clip.mp4 …`
    → `rtsp://mediamtx:8554/camera`). That answers the guide's open "Video on Disk" TODO and
    gives repeatable tests.
  - Host FFmpeg as today (one command), for people who want their real webcam via V4L2/AVFoundation.
- **Commander:** optional container (uv + `bun run build` for `web/`), or keep running it from a
  checkout since that's what devs are editing. The guide's robot settings (`localhost`,
  `rtsp://localhost:8554/camera`, PiVision `http://localhost:5050`) could ship as a ready-made
  `robot_configs` example.

## Power off

- [x] Per-Pi **Power off** + fleet **Power off all**: `compose stop`, then `sync && sudo systemctl
      poweroff`. (Added 2026-11-09; not yet run for real.)
- [ ] After a Gaia-initiated poweroff, show the card as "powered off" instead of a red
      "unreachable".

## Changes Gaia work made outside this repo (as of 2026-11-09)

Nothing is committed or pushed anywhere.

- `../cam_streamer`: new branch `feat/output-fps` (from `main`), uncommitted edits to
  `scripts/stream_camera.sh` and `README.md`. (`yolo11n-pose.pt` was already untracked before.)
- `../pi-vision`: **checkout untouched** (still `feat/elbow-tracking`; its modified
  `__pycache__` files predate Gaia). Added a *git worktree* `../pi-vision-dual-arm` on new branch
  `feat/dual-arm-integration` (from `origin/master`) with uncommitted edits to `config.py`,
  `control_api.py`, `main.py`, `operator_client.py`, `web_server.py` + new `inference_rate.py`.
  Remove with `git -C ../pi-vision worktree remove ../pi-vision-dual-arm`.
- `../operator`, `../commander`, `../pi-vision`, `../cam_streamer`: `git fetch` only (remote-tracking
  refs). Operator's modified files on `twinning` and Commander's stash predate Gaia.
- **Bingo:** `~/talos-stack/` (compose.yaml, operator.conf, gaia-manifest.json, logs/, previous-*),
  `talos/*` images in the isolated Docker runtime, `talos-docker.service` started. The old
  `~/talos-containers/` folder and `talos-arms-*` containers are untouched. `70-talos-gaia.rules`
  has *not* been installed (only by Troubleshoot › Re-apply USB rules).
- **Bluey:** nothing (unreachable the whole time).

## Smaller Gaia items

- [ ] Operator truncates `operator.log` on every start; keep the previous run (e.g. rotate in Gaia)
      so crashes like the one above aren't lost.
- [ ] Commit the Gaia repo (nothing is committed yet).
