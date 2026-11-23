# Gaia TODO

Things we've agreed to change, and the open decisions. Keep this current: if it isn't
written here, assume nobody remembers it.

## Current baseline (2026-11-09)

Both Pis run a normal Docker install (Docker 29.9.3 from Docker's .debs) and four containers:

| Component | Source | Why |
|---|---|---|
| Operator | `operator` @ `feat/dual-arm-containers` | what the demo ran |
| Pi-Vision | `pi-vision` @ `feat/dual-arm-integration`, 320 model, `POSE_THREADS=2` | canonical repo; 320 for small targets (~3.5 fps accepted 2026-11-09) |
| Cam Streamer | `cam_streamer` @ `feat/output-fps` | reproduces the demo's ffmpeg command (MJPEG 30 fps in → 10 fps out) |
| MediaMTX | `bluenviron/mediamtx:1.15.3` + `stack/mediamtx.yml` (container) | moved into the stack 2026-11-09; host `mediamtx.service` disabled |

Bluey: Operator isn't running, because its ESP's USB-serial adapter (CP2102) wasn't plugged in on
2026-11-09 (`lsusb` showed only the webcam). Plug it in, then Start.

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

- [ ] PR → merge branch `feat/dual-arm-integration` (committed + pushed as 180387d; worktree
      `../pi-vision-dual-arm`). It brings 1-3 over from Commander's copy and fixes the `cv2.line` bug.
      Everything else that differs from Commander's copy is pi-vision being *newer* (head-aim /
      eye-line framing) or reformatting (`identity.py`). Commit → PR → merge.
      - 2026-11-09: tests pass in the image; the fake-Operator test passes (PROFILE + ACK).
        **Running on Bingo** via a `gaia.local.yaml` override: `controller_profile: native`.
        Verified by hand: Commander jogging and tracking work with it.
      - [ ] **Speed:** the 320 model with `POSE_THREADS=1` reaches only 2.7 fps (0.39 s per inference,
            python at ~120% CPU). The demo ran the 192 model at 3.5 fps. Options: add
            `yolo11n-pose-192.onnx` to pi-vision, or use `POSE_THREADS=2`.
            Tried `POSE_THREADS=2` (2026-11-09, local override): 3.3-3.8 fps, 0.33 s per inference,
            python ~205% CPU, camera still 10.5 fps, 65 °C, no throttling. A small gain for about half a
            core more. Next to try: the 192 model.
- [x] Switch `gaia.config.yaml` vision to `pi-vision` (2026-11-09; ref `feat/dual-arm-integration`).
- [ ] After the merge: set the vision ref in `gaia.config.yaml` to `master`.
- [ ] Delete `commander/tools/pi_tracker` (or replace it with a pointer to pi-vision) so this
      can't happen again.
- [x] Decided: 320 model, `POSE_THREADS=2`, `INFERENCE_FPS=4` cap (~3.5 fps actual).
- [ ] pi-vision README is stale outside the config section (tests via `commander`, `deploy_to_pi.bat`,
      `MODEL_WEIGHTS=yolo26n.onnx`); `yolo26n.onnx` is a dangling symlink; `__pycache__` is tracked.

## Cam Streamer

- [ ] PR → merge `cam_streamer` branch `feat/output-fps` (committed + pushed as ad5fd1b): adds
      `OUTPUT_FPS` + `KEYFRAME_INTERVAL` to `scripts/stream_camera.sh`, plus a README table.
- [ ] After merge: set the camera ref in `gaia.config.yaml` to `main`.

## A fresh Pi only needs Docker (done 2026-11-09)

- [x] `mediamtx` service (`bluenviron/mediamtx:1.15.3` + `stack/mediamtx.yml`, API on
      127.0.0.1:9997). Deploy retires the host `mediamtx.service`; preflight refuses to start while it
      runs. Same host network as the camera, so a combined container wouldn't cut latency.
- [x] MediaMTX's API feeds health (path live, readers). ffprobe still measures the camera's fps.
- [x] **Troubleshoot › Install Docker**: Docker's official .debs, downloaded on the laptop,
      SHA-256 checked, installed offline with apt. `daemon.json` keeps Docker off the firewall
      (`iptables: false`, `bridge: none`) and on the classic image store. `pi` is in the `docker`
      group, so no `sudo`. Both Pis migrated; `runtime: system` is now the default.
- [x] Boot behaviour (agreed): MediaMTX, camera, Pi-Vision `restart: unless-stopped`; Operator
      `restart: "no"`. Verified on Bingo with a reboot: three came back, Operator stayed stopped.
- [x] `talos` helper on each Pi (`/usr/local/bin/talos`); every button is one `talos …` call.
- [ ] **Delete the old isolated runtime** on both Pis once you're happy (Troubleshoot › Delete the
      old isolated runtime): frees ~2.7 GB on Bingo, ~0.8 GB on Bluey. It's stopped and disabled,
      not deleted, so `sudo systemctl enable --now talos-docker` still brings it back.
- [ ] The old `~/talos-containers`, `/etc/udev/rules.d/70-talos-arms.rules` (still what creates
      `/dev/talos-*` today!) and host `/usr/local/bin/mediamtx` are untouched. Switch to Gaia's
      `70-talos-gaia.rules` (Re-apply USB rules) before removing `70-talos-arms.rules`.

## Bluey: no telemetry on the custom controller

- [x] Per-arm `telemetry: false` in `gaia.config.yaml` (2026-11-09; set for Bluey).
- [x] Bluey's firmware sends TELP now (Jacob/Aleck, 2026-11-19), so `feat/controller-types` drops
      Bluey's `telemetry: false`. No arm needs the flag; the `!pi.arm.telemetry` branch in
      `src/core/status.ts` stays for new setups whose controller has none.
- Bluey's demo firmware lives on esp-driver branch `maker-fair-2026` (Aleck, temporary), not `main`.
  Its limit-switch homing is off: HOME drives the arm back to wherever it was when the ESP powered
  on, so pose the arm at home before powering the ESP. Revisit `homesOnStart` and the README's
  custom-controller note when real homing returns.

## Where images get built (decided 2026-11-11: on the laptop)

Images are built on the laptop (Docker Desktop/Colima) and shipped as layer diffs over SSH.

Building on the Pi was rejected: its `apt`/`pip` steps need internet and the Pis have none. The
emergency scripts got around that with an HTTP proxy tunnelled from a laptop (`download_proxy.py`,
`HTTP_PROXY=127.0.0.1:18081` in `talos-docker.service`), which is one more moving part, and Pi 4
builds are slow. The cost is that Windows teammates need Docker Desktop.

## Windows

- [ ] Have a teammate run `bun install && bun run dev` on plain Windows. Nothing has been
      tested on Windows yet; the cross-compile path was only tested by forcing x86 on a Mac.

## Hardware notes

- Bingo's Scorbot controller printed `USER RAM CHECKPOINT ERROR → INSTALLING DEFAULT SETUP` at
  power-on (2026-11-06), then `Illegal Trap` two minutes after homing. If the checkpoint error
  appears on *every* power-on, suspect the controller's backup battery. Its fan bearing is also
  failing (loud).

- **`.local` names breaking (`bingo-2.local`, `bluey-2.local`): root cause found 2026-11-09.** Bingo
  and Bluey were flashed from one SD card image (Nov 19, 2024): same `/etc/machine-id`, same
  NetworkManager `secret_key`, same SSH host keys. So they generated the *same IPv6 link-local
  address*; avahi saw the duplicate and renamed whichever Pi booted second. Fixed by giving Bingo a
  new machine-id + NM secret (Troubleshoot › Give this Pi its own identity; old files kept as
  `*.before-gaia`). After a reboot, Bingo kept `bingo.local`. Gaia now warns when two Pis share a machine-id.
- [ ] Both Pis still share **SSH host keys**, so neither key proves which Pi you reached.
      Regenerating them on one Pi (`sudo rm /etc/ssh/ssh_host_* && sudo dpkg-reconfigure
      openssh-server`) means everyone must delete its old line from `~/.ssh/known_hosts` once.
      Gaia works around it by also checking the hostname on learned addresses.
- The Pis have no internet (no NTP) and no RTC; Bingo was 4 days behind. Deploy now sets the clock
  from the laptop, and Troubleshoot › Set clock does it on demand.

## Command previews are too noisy (UI) — mostly done 2026-11-09

Done: stock Docker (1), the `talos` helper (2), no `cd` (3), no quotes on simple commands (4).
Buttons now show e.g. `ssh pi@bingo.local talos stop camera`. Still long: Deploy's preview and
the few inline commands (Install Docker, clock, identity). Remaining ideas: 5 and 6.

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

- `../cam_streamer`: branch `feat/output-fps` (committed + pushed by you as ad5fd1b).
- `../pi-vision`: your checkout is untouched (still `feat/elbow-tracking`; its modified
  `__pycache__` files predate Gaia). Git worktree `../pi-vision-dual-arm` on branch
  `feat/dual-arm-integration` (committed + pushed by you as 180387d). Remove the worktree with
  `git -C ../pi-vision worktree remove ../pi-vision-dual-arm`.
- `../operator`, `../commander`: `git fetch` only.
- **Both Pis:**
  - Docker 29.9.3 installed from Docker's .debs (`/etc/docker/daemon.json`); `pi` added to the
    `docker` group; `docker.service` enabled at boot.
  - `talos-docker.service` and host `mediamtx.service` stopped and disabled, not deleted.
  - `~/talos-stack/` (compose.yaml, operator.conf, gaia-manifest.json, bin/talos, logs/, previous-*),
    plus the symlink `/usr/local/bin/talos`. Clock set from the laptop.
  - Untouched: `~/talos-containers/`, `70-talos-arms.rules`, `/var/lib/talos-docker` (old images).
- **Bingo only:** new `/etc/machine-id` and `/var/lib/NetworkManager/secret_key` (originals kept as
  `/etc/machine-id.before-gaia` and `secret_key.before-gaia`). Rebooted twice.

## Smaller Gaia items

- [ ] Operator truncates `operator.log` on every start; keep the previous run (e.g. rotate in Gaia)
      so crashes like the one above aren't lost.
- [ ] Commit the MCP server (`src/mcp.ts`, `src/core/ops.ts`, `.mcp.json`) and its README section.
