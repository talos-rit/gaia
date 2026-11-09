import { COMPONENT_LABEL, COMPONENTS, type ComponentId, type Config, type PiCfg } from "./config.ts";
import type { RemoteStep, Step } from "./jobs.ts";
import { cameraDevice, compose, docker, inStack, serialDevice, udevRules } from "./stack.ts";

export type ActionScope = "stack" | "service" | "troubleshoot";

export interface Action {
  id: string;
  label: string;
  scope: ActionScope;
  description: string;
  /** Hidden for Pis where it doesn't make sense (e.g. ESP reset on a native controller). */
  applies?: (pi: PiCfg, cfg: Config) => boolean;
  /** Text for a confirmation dialog, if the action is dangerous. */
  confirm?: (pi: PiCfg, service?: ComponentId) => string | undefined;
  steps: (cfg: Config, pi: PiCfg, service?: ComponentId) => Step[];
}

const remote = (label: string, cmd: string, extra: Partial<RemoteStep> = {}): RemoteStep => ({ label, where: "remote", cmd, ...extra });

const homeWarning = (pi: PiCfg) =>
  pi.arm.homesOnStart
    ? `Starting Operator on ${pi.name} physically HOMEs the arm.\n\nIs the workspace clear and the controller powered?`
    : undefined;

/** Isolated runtime isn't boot-enabled on the lab Pis; start it on demand. */
export function ensureRuntime(pi: PiCfg): RemoteStep {
  if (pi.runtime === "system")
    return remote("Check Docker is running", `${docker(pi)} info --format 'docker {{.ServerVersion}} is up'`);
  return remote(
    "Ensure Docker runtime is running",
    `systemctl is-active --quiet talos-docker.service || { sudo -n systemctl start talos-docker.service; ` +
      `for i in $(seq 1 20); do [ -S /run/talos-docker.sock ] && break; sleep 1; done; }; ` +
      `${docker(pi)} info --format 'docker {{.ServerVersion}} is up'`,
  );
}

/** Refuse to start when devices are missing or something else owns them. */
export function preflight(cfg: Config, pi: PiCfg): RemoteStep {
  const devs = [serialDevice(pi), cameraDevice(pi), ...(pi.arm.encoder === "hardware" ? ["/dev/video11"] : [])];
  const script = [
    "fail=0",
    `for d in ${devs.join(" ")}; do if [ -e "$d" ]; then echo "ok        $d -> $(readlink -f $d)"; else echo "MISSING   $d  (unplugged? try Troubleshoot > Re-apply USB rules)"; fail=1; fi; done`,
    `for u in camera-streamer.service pivision-integration.service; do if systemctl is-active --quiet $u; then echo "CONFLICT  legacy host service $u is running (Troubleshoot > Stop legacy host services)"; fail=1; fi; done`,
    `others=$(${docker(pi)} ps --format '{{.Names}} {{.Label "com.docker.compose.project"}}' | awk '$2!="${cfg.stack.project}"{print $1}' | tr '\\n' ' ')`,
    `if [ -n "$others" ]; then echo "CONFLICT  non-Gaia containers running: $others(Troubleshoot > Stop non-Gaia containers)"; fail=1; fi`,
    `[ $fail = 0 ] && echo "preflight passed"`,
    "exit $fail",
  ].join("\n");
  return remote("Preflight: devices present, nothing else owns them", script);
}

const requireDeployed = (cfg: Config) =>
  `test -f ~/${cfg.stack.dir}/compose.yaml || { echo "Nothing deployed in ~/${cfg.stack.dir} yet: use Deploy first."; exit 1; }`;

const svcName = (s?: ComponentId) => {
  if (!s || !COMPONENTS.includes(s)) throw new Error(`unknown service ${s}`);
  return s;
};

export const ACTIONS: Action[] = [
  // ---- whole stack ----------------------------------------------------------------------
  {
    id: "start",
    label: "Start",
    scope: "stack",
    description: "Create/start all three containers from the deployed compose.yaml.",
    confirm: (pi) => homeWarning(pi),
    steps: (cfg, pi) => [
      ensureRuntime(pi),
      preflight(cfg, pi),
      remote("Start stack", `${requireDeployed(cfg)} && ${inStack(cfg, `${compose(pi)} up -d`)}`),
    ],
  },
  {
    id: "stop",
    label: "Stop",
    scope: "stack",
    description: "Stop all containers (Pi-Vision first, Operator last). Containers are kept for a quick Start.",
    steps: (cfg, pi) => [remote("Stop stack", inStack(cfg, `${compose(pi)} stop`))],
  },
  {
    id: "restart",
    label: "Restart",
    scope: "stack",
    description: "Restart all containers in place. Does not pick up a new deploy; use Deploy for that.",
    confirm: (pi) => homeWarning(pi),
    steps: (cfg, pi) => [ensureRuntime(pi), remote("Restart stack", inStack(cfg, `${compose(pi)} restart`))],
  },
  {
    id: "down",
    label: "Remove containers",
    scope: "stack",
    description: "docker compose down: stop and delete the containers (images and logs are kept).",
    confirm: (pi) => `Remove all Talos containers on ${pi.name}? Images and logs stay on the Pi.`,
    steps: (cfg, pi) => [remote("Remove containers", inStack(cfg, `${compose(pi)} down`))],
  },

  {
    id: "poweroff",
    label: "Power off",
    scope: "stack",
    description:
      "End of day: stop the containers cleanly (Operator gets SIGINT), then shut the Pi down. Unplug only once the green ACT LED " +
      "has stopped flickering (~10 s). Yanking power without this is a common cause of corrupted microSD cards.",
    confirm: (pi) => `Shut down ${pi.name}? It stays off until you unplug and replug its power.`,
    steps: (cfg, pi) => [
      remote(
        "Stop containers",
        `if [ -f ~/${cfg.stack.dir}/compose.yaml ]; then ${inStack(cfg, `${compose(pi)} stop`)}; else echo "no Gaia stack deployed; nothing to stop"; fi`,
        { allowFail: true },
      ),
      // The SSH session drops as the Pi goes down, so a non-zero exit here is expected.
      remote("Shut down", "sync && sudo -n systemctl poweroff", { allowFail: true }),
    ],
  },

  // ---- single service ------------------------------------------------------------------
  {
    id: "svc-start",
    label: "Start",
    scope: "service",
    description: "Start just this container (--no-deps leaves the others alone).",
    confirm: (pi, s) => (s === "operator" ? homeWarning(pi) : undefined),
    steps: (cfg, pi, s) => [
      ensureRuntime(pi),
      remote(`Start ${COMPONENT_LABEL[svcName(s)]}`, `${requireDeployed(cfg)} && ${inStack(cfg, `${compose(pi)} up -d --no-deps ${svcName(s)}`)}`),
    ],
  },
  {
    id: "svc-stop",
    label: "Stop",
    scope: "service",
    description: "Stop just this container.",
    steps: (cfg, pi, s) => [remote(`Stop ${COMPONENT_LABEL[svcName(s)]}`, inStack(cfg, `${compose(pi)} stop ${svcName(s)}`))],
  },
  {
    id: "svc-restart",
    label: "Restart",
    scope: "service",
    description: "Restart just this container.",
    confirm: (pi, s) => (s === "operator" ? homeWarning(pi) : undefined),
    steps: (cfg, pi, s) => [remote(`Restart ${COMPONENT_LABEL[svcName(s)]}`, inStack(cfg, `${compose(pi)} restart ${svcName(s)}`))],
  },

  // ---- troubleshooting ----------------------------------------------------------------
  {
    id: "runtime-start",
    label: "Start Docker runtime",
    scope: "troubleshoot",
    description: "The lab Pis' isolated Docker daemon (talos-docker.service) is not boot-enabled; start it after a reboot.",
    applies: (pi) => pi.runtime === "isolated",
    steps: (_cfg, pi) => [ensureRuntime(pi)],
  },
  {
    id: "usb-rules",
    label: "Re-apply USB rules",
    scope: "troubleshoot",
    description:
      "Install udev rules for /dev/talos-<pi>-serial and -camera, then re-trigger udev. This is what install-usb-rules.sh does, " +
      "and it fixes missing device aliases after re-plugging or a reboot.",
    applies: (pi) => udevRules(pi) !== null,
    steps: (_cfg, pi) => [
      remote(
        "Install rules and re-trigger udev",
        [
          `sudo -n tee /etc/udev/rules.d/70-talos-gaia.rules >/dev/null`,
          `sudo -n udevadm control --reload-rules`,
          `sudo -n udevadm trigger --action=add --subsystem-match=tty`,
          `sudo -n udevadm trigger --action=add --subsystem-match=video4linux`,
          `sudo -n udevadm settle`,
          `ls -l /dev/talos-*`,
        ].join(" && "),
        { stdin: udevRules(pi)!, stdinNote: "generated udev rules (see Files)" },
      ),
    ],
  },
  {
    id: "usb-detect",
    label: "Detect USB devices",
    scope: "troubleshoot",
    description: "List serial adapters and cameras with the udev ID_PATH / vendor / product values used in gaia.config.yaml.",
    steps: () => [
      remote(
        "List USB serial + video devices",
        `for d in /dev/ttyUSB* /dev/ttyACM* /dev/video*; do [ -e "$d" ] || continue; ` +
          `p=$(udevadm info -q property -n "$d"); idp=$(echo "$p" | sed -n 's/^ID_PATH=//p'); ` +
          `[ -n "$idp" ] || continue; case "$idp" in *usb*) ;; *) continue;; esac; ` +
          `echo "$d  ID_PATH=$idp  vendor=$(echo "$p" | sed -n 's/^ID_VENDOR_ID=//p') product=$(echo "$p" | sed -n 's/^ID_MODEL_ID=//p')  $(echo "$p" | sed -n 's/^ID_MODEL=//p')"; done; ` +
          `echo; ls -l /dev/talos-* 2>/dev/null || echo "no /dev/talos-* aliases present"`,
      ),
    ],
  },
  {
    id: "device-owners",
    label: "Who owns the serial/camera?",
    scope: "troubleshoot",
    description: "Show processes holding the arm's serial port and camera (two owners on one serial port = trouble).",
    steps: (_cfg, pi) => [
      remote("fuser", `sudo -n fuser -v ${serialDevice(pi)} ${cameraDevice(pi)} 2>&1 || echo "(no process has them open)"`),
    ],
  },
  {
    id: "esp-reset",
    label: "Reset ESP (pulse RTS)",
    scope: "troubleshoot",
    description:
      "Reset the ESP32 through the USB-serial adapter's RTS line. Fixed Bluey on 2026-11-05, when the ESP stopped answering after a Pi reboot.",
    applies: (pi) => pi.arm.controller.startsWith("esp"),
    confirm: (pi) => `Reset ${pi.name}'s ESP controller? The arm may twitch.`,
    steps: (_cfg, pi) => [
      remote(
        "Pulse RTS",
        `sudo -n python3 - <<'EOF'\n` +
          `import fcntl, os, struct, time\n` +
          `fd = os.open("${serialDevice(pi)}", os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)\n` +
          `TIOCMBIS, TIOCMBIC, DTR, RTS = 0x5416, 0x5417, 0x002, 0x004\n` +
          `fcntl.ioctl(fd, TIOCMBIC, struct.pack("I", DTR)); fcntl.ioctl(fd, TIOCMBIS, struct.pack("I", RTS))\n` +
          `time.sleep(0.2); fcntl.ioctl(fd, TIOCMBIC, struct.pack("I", RTS)); time.sleep(1.5)\n` +
          `os.close(fd); print("reset pulsed")\n` +
          `EOF`,
      ),
    ],
  },
  {
    id: "mediamtx-restart",
    label: "Restart MediaMTX",
    scope: "troubleshoot",
    description: "Restart the host RTSP server. The camera container reconnects only after its own restart.",
    steps: (cfg, pi) => [
      remote("Restart mediamtx.service", "sudo -n systemctl restart mediamtx.service && systemctl is-active mediamtx.service"),
      remote("Restart camera container", inStack(cfg, `${compose(pi)} restart camera`), { allowFail: true }),
    ],
  },
  {
    id: "stop-legacy-services",
    label: "Stop legacy host services",
    scope: "troubleshoot",
    description: "Stop the pre-container camera-streamer / pivision-integration systemd units that grab the camera and ports.",
    steps: () => [
      remote(
        "Stop units",
        "sudo -n systemctl stop camera-streamer.service pivision-integration.service 2>&1; " +
          "systemctl is-active camera-streamer.service pivision-integration.service; true",
      ),
    ],
  },
  {
    id: "stop-foreign",
    label: "Stop non-Gaia containers",
    scope: "troubleshoot",
    description: "Stop containers from other compose projects, e.g. the old talos-arms stack from two-pi-20261104.",
    confirm: (pi) => `Stop every running container on ${pi.name} that Gaia didn't deploy?`,
    steps: (cfg, pi) => [
      remote(
        "Stop foreign containers",
        `for c in $(${docker(pi)} ps --format '{{.Names}} {{.Label "com.docker.compose.project"}}' | awk '$2!="${cfg.stack.project}"{print $1}'); ` +
          `do echo "stopping $c"; ${docker(pi)} stop -t 8 "$c"; done; echo done`,
      ),
    ],
  },
  {
    id: "host-check",
    label: "Check host health",
    scope: "troubleshoot",
    description: "Kernel, CMA (the hardware encoder needs 256 MiB or more), encoder device, throttling, temperature, disk and memory.",
    steps: () => [
      remote(
        "Host checks",
        `echo "kernel:    $(uname -r)"; ` +
          `echo "cma:       $(awk '/^CmaTotal:/{print $2/1024 " MiB"}' /proc/meminfo)"; ` +
          `echo "encoder:   $([ -e /dev/video11 ] && echo /dev/video11 present || echo /dev/video11 MISSING)"; ` +
          `echo "throttled: $(vcgencmd get_throttled 2>/dev/null || echo n/a)   (0x0 = never throttled)"; ` +
          `echo "temp:      $(vcgencmd measure_temp 2>/dev/null || echo n/a)"; ` +
          `echo "uptime:   $(uptime)"; echo; free -h; echo; df -h / | tail -n 1; echo; ` +
          `systemctl is-active mediamtx.service talos-docker.service 2>&1 | paste -sd' ' | sed 's/^/mediamtx, talos-docker: /'`,
      ),
    ],
  },
  {
    id: "kernel-log",
    label: "Kernel warnings (this boot)",
    scope: "troubleshoot",
    description: "USB disconnects, codec faults and undervoltage show up here.",
    steps: () => [remote("journalctl -k", "sudo -n journalctl -k -b -p warning --no-pager | tail -n 120")],
  },
  {
    id: "avahi-restart",
    label: "Fix mDNS name (restart avahi)",
    scope: "troubleshoot",
    description:
      "If <pi>.local stopped resolving (avahi renamed the Pi to <pi>-2.local because it was on ethernet and Wi-Fi at once), restart avahi to reclaim the name.",
    steps: () => [remote("Restart avahi", "sudo -n systemctl restart avahi-daemon && sleep 2 && hostname && avahi-resolve -n \"$(hostname).local\" 2>&1 || true")],
  },
  {
    id: "image-prune",
    label: "Disk: prune dangling images",
    scope: "troubleshoot",
    description: "Remove untagged image layers left by repeated deploys. Tagged images, kept for rollback, are left alone.",
    steps: (_cfg, pi) => [remote("Prune", `${docker(pi)} image prune -f && ${docker(pi)} system df && df -h / | tail -n 1`)],
  },
  {
    id: "reboot",
    label: "Reboot Pi",
    scope: "troubleshoot",
    description: "Reboot. Containers do not auto-start (restart: no), and the isolated runtime must be started again.",
    confirm: (pi) => `Reboot ${pi.name}? Everything on it stops until you Start again.`,
    steps: () => [remote("Reboot", "sudo -n systemctl reboot", { allowFail: true })],
  },
];

export function getAction(id: string) {
  return ACTIONS.find((a) => a.id === id);
}
