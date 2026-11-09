"""Gaia status probe. Runs on the Pi as `python3 - '<json args>'` with this file on stdin.

Read-only: it never connects to Operator's TCP port (Operator accepts a single client, and
Pi-Vision is that client). Operator health is inferred from the container, its listening
socket, its log file, and the arm telemetry that Pi-Vision reports.
"""
import json, os, re, shutil, subprocess, sys, time, urllib.request

args = json.loads(sys.argv[1])
DOCKER = args["docker"]  # argv prefix, e.g. ["sudo","-n","/opt/talos-docker/29.8.2/docker","-H","unix:///run/talos-docker.sock"]
out = {"t": time.time()}


def run(cmd, timeout=5):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except FileNotFoundError as e:
        return 127, "", str(e)


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def http_json(url, timeout=2.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode()), None
    except Exception as e:  # noqa: BLE001 - report any failure as text
        return None, str(e)


# ---- host ---------------------------------------------------------------------------------
meminfo = dict(re.findall(r"^(\w+):\s+(\d+)", read("/proc/meminfo", ""), re.M))
temp = read("/sys/class/thermal/thermal_zone0/temp")
_, throttled, _ = run(["vcgencmd", "get_throttled"], 2)
st = os.statvfs("/")
out["host"] = {
    "hostname": os.uname().nodename,
    "kernel": os.uname().release,
    "uptime_s": float(read("/proc/uptime", "0 0").split()[0]),
    "load": os.getloadavg()[0],
    "temp_c": round(int(temp) / 1000, 1) if temp else None,
    "throttled": throttled.strip().split("=")[-1] or None,
    "mem_avail_mb": int(meminfo.get("MemAvailable", 0)) // 1024,
    "mem_total_mb": int(meminfo.get("MemTotal", 0)) // 1024,
    "cma_mb": int(meminfo.get("CmaTotal", 0)) // 1024,
    "disk_free_gb": round(st.f_bavail * st.f_frsize / 1e9, 1),
}

units = ["mediamtx.service", "camera-streamer.service", "pivision-integration.service", "talos-docker.service"]
_, so, _ = run(["systemctl", "is-active", *units], 3)
out["units"] = dict(zip(units, (so.split() + ["unknown"] * len(units))[: len(units)]))

# ---- docker -------------------------------------------------------------------------------
rt = {"kind": args["runtime"], "up": False, "error": None}
if args["runtime"] == "isolated" and not os.path.exists("/run/talos-docker.sock"):
    rt["error"] = "talos-docker.service is not running"
else:
    code, so, se = run([*DOCKER, "ps", "-a", "--no-trunc", "--format", "{{json .}}"], 6)
    if code == 0:
        rt["up"] = True
        containers = []
        for line in so.splitlines():
            c = json.loads(line)
            labels = dict(kv.split("=", 1) for kv in c.get("Labels", "").split(",") if "=" in kv)
            containers.append({
                "name": c["Names"], "image": c["Image"], "state": c["State"], "status": c["Status"],
                "project": labels.get("com.docker.compose.project"),
                "service": labels.get("com.docker.compose.service"),
            })
        out["containers"] = containers
        names = [c["name"] for c in containers if c["project"] == args["project"]]
        if names:
            code, so, _ = run([*DOCKER, "inspect", "--format",
                               "{{.Name}}|{{.State.StartedAt}}|{{.State.ExitCode}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.Image}}|{{.RestartCount}}",
                               *names], 6)
            details = {}
            for line in so.splitlines():
                n, started, exit_code, health, image_id, restarts = line.split("|")
                details[n.lstrip("/")] = {"started_at": started, "exit_code": int(exit_code), "health": health or None,
                                          "image_id": image_id}
            for c in containers:
                c.update(details.get(c["name"], {}))
    else:
        rt["error"] = (se or so).strip()[-400:]
out["runtime"] = rt

# ---- devices ------------------------------------------------------------------------------
def dev(path):
    return {"path": path, "exists": os.path.exists(path), "target": os.path.realpath(path) if os.path.exists(path) else None}


out["devices"] = {"serial": dev(args["serial"]), "camera": dev(args["camera"]), "encoder": dev("/dev/video11")}

# ---- deployed stack ----------------------------------------------------------------------
stack_dir = os.path.expanduser("~/" + args["stack_dir"])
manifest = read(os.path.join(stack_dir, "gaia-manifest.json"))
out["stack"] = {"deployed": os.path.exists(os.path.join(stack_dir, "compose.yaml")),
                "manifest": json.loads(manifest) if manifest else None}

# ---- operator ----------------------------------------------------------------------------
_, so, _ = run(["ss", "-ltnH"], 3)
listening = any(re.search(r":%d\s" % args["operator_port"], l + " ") for l in so.splitlines())
log_path = os.path.join(stack_dir, "logs", "operator.log")
log = None
if os.path.exists(log_path):
    _, tail, _ = run(["tail", "-n", "6", log_path], 2)
    log = {"age_s": round(time.time() - os.path.getmtime(log_path), 1), "tail": tail.splitlines()}
out["operator"] = {"listening": listening, "log": log}

# ---- pi-vision ---------------------------------------------------------------------------
# "localhost" resolves to both 127.0.0.1 and ::1, so an IPv6-only listener still answers.
base = "http://localhost:%d" % args["vision_port"]
status, err = http_json(base + "/api/status")
vision = {"reachable": status is not None, "error": err}
if status:
    vision["status"] = {k: status.get(k) for k in ("tracking_enabled", "state", "fps", "fault", "observation_age_s", "pose", "control_owner")}
    vision["status"]["operator"] = status.get("operator")
    tel = status.get("telemetry") or {}
    vision["status"]["telemetry"] = {"received": tel.get("received"), "age_s": tel.get("age_s")}
    ctl, _ = http_json(base + "/api/v1/control/status")
    if ctl is not None:
        # Commander refuses to move the arm unless this matches the robot's configured profile.
        vision["control"] = {"has_profile_field": "controller_profile" in ctl, "controller_profile": ctl.get("controller_profile"),
                             "owner": ctl.get("owner"), "enabled": ctl.get("enabled")}
    obs, oerr = http_json(base + "/api/v1/observations")
    if obs:
        sample = obs.get("sample") or {}
        vision["observations"] = {"enabled": obs.get("enabled"), "sequence": sample.get("sequence"),
                                  "detections": len(sample.get("detections") or []), "fps": sample.get("fps"),
                                  "inference_s": sample.get("inference_s")}
out["vision"] = vision

# ---- RTSP --------------------------------------------------------------------------------
if args.get("rtsp_check"):
    # Count packets for 2 s without decoding: robust (no need to land on a keyframe) and cheap.
    url = "rtsp://127.0.0.1:8554/" + args["rtsp_path"]
    window = 2.0
    probe = ["ffprobe", "-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name,width,height,avg_frame_rate:packet=size,flags",
             "-read_intervals", "%%+%g" % window, "-show_packets", "-of", "json", url]
    how = "host ffprobe"
    if not shutil.which("ffprobe"):
        # The camera image ships ffmpeg (and ffprobe), so borrow it.
        probe = [*DOCKER, "exec", args["project"] + "-camera-1", *probe]
        how = "ffprobe inside camera container"
    t0 = time.time()
    code, so, se = run(probe, 12)
    r = {"url": url, "how": how, "ok": False, "ms": int((time.time() - t0) * 1000), "window_s": window}
    if code == 0:
        try:
            j = json.loads(so)
            s0 = (j.get("streams") or [{}])[0]
            pk = j.get("packets") or []
            r.update(codec=s0.get("codec_name"), width=s0.get("width"), height=s0.get("height"),
                     fps=s0.get("avg_frame_rate"), packets=len(pk), keyframes=sum("K" in (p.get("flags") or "") for p in pk),
                     bytes=sum(int(p.get("size") or 0) for p in pk))
            r["measured_fps"] = round(r["packets"] / window, 1)
            r["ok"] = r["packets"] > 0 and r["bytes"] > 0
            if not r["ok"]:
                r["error"] = "stream is published but no video packets arrived in %gs" % window
        except ValueError:
            r["error"] = "unparseable ffprobe output"
    else:
        lines = (se or so).strip().splitlines()
        r["error"] = lines[-1] if lines else "ffprobe exit %d" % code
    out["rtsp"] = r

print(json.dumps(out))
