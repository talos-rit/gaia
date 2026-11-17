import { COMPONENT_LABEL, COMPONENTS, type ComponentId, type Config, type PiCfg } from "./config.ts";
import { DAEMON_JSON, installDocker } from "./dockerInstall.ts";
import type { Job, RemoteStep, Step } from "./jobs.ts";
import { talos } from "./helper.ts";
import { task } from "./pipeline.ts";
import { docker, udevRules } from "./stack.ts";

export type ActionScope = "stack" | "service" | "troubleshoot";

/** Headings in the Troubleshoot menu, in display order. */
export const TROUBLESHOOT_GROUPS = ["Devices", "Containers & disk", "System & network", "One-time setup"] as const;
export type TroubleshootGroup = (typeof TROUBLESHOOT_GROUPS)[number];

export interface Action {
  id: string;
  label: string;
  scope: ActionScope;
  /** Troubleshoot menu heading. */
  group?: TroubleshootGroup;
  /** Destructive or disruptive: red in menus, red confirm button. */
  danger?: boolean;
  description: string;
  /** Hidden for Pis where it doesn't make sense (e.g. ESP reset on a native controller). */
  applies?: (pi: PiCfg, cfg: Config) => boolean;
  /** Text for a confirmation dialog, if the action is dangerous. */
  confirm?: (pi: PiCfg, service?: ComponentId) => string | undefined;
  /** Shown on hover. Executed as-is, unless `run` is given (multi-stage jobs like Install Docker). */
  steps: (cfg: Config, pi: PiCfg, service?: ComponentId) => Step[];
  run?: (job: Job, cfg: Config, pi: PiCfg) => Promise<void>;
}

const remote = (label: string, cmd: string, extra: Partial<RemoteStep> = {}): RemoteStep => ({ label, where: "remote", cmd, ...extra });

export const homeWarning = (pi: PiCfg) =>
  pi.arm.homesOnStart
    ? `Starting Operator on ${pi.name} physically HOMEs the arm.\n\nIs the workspace clear and the controller powered?`
    : undefined;

/**
 * Make sure Docker answers. Inline rather than `talos runtime`, because Deploy needs it before
 * the helper has been uploaded.
 */
export function ensureRuntime(pi: PiCfg): RemoteStep {
  if (pi.runtime === "system")
    return remote(
      "Check Docker is running",
      `command -v docker >/dev/null || { echo "Docker isn't installed: use Troubleshoot > Install Docker"; exit 1; }; ${docker(pi)} info --format 'docker {{.ServerVersion}} is up'`,
    );
  return remote(
    "Ensure Docker runtime is running",
    `systemctl is-active --quiet talos-docker.service || { sudo -n systemctl start talos-docker.service; ` +
      `for i in $(seq 1 20); do [ -S /run/talos-docker.sock ] && break; sleep 1; done; }; ` +
      `${docker(pi)} info --format 'docker {{.ServerVersion}} is up'`,
  );
}

const svcName = (s?: ComponentId) => {
  if (!s || !COMPONENTS.includes(s)) throw new Error(`unknown service ${s}`);
  return s;
};

/** A one-step action that runs `talos <args>` on the Pi. */
const t = (label: string, args: string, extra: Partial<RemoteStep> = {}) => remote(label, talos(args), extra);

/**
 * The Pis have no internet (so no NTP) and no RTC: they boot at the last saved time and drift.
 * Setting the clock (and timezone) from this computer keeps log timestamps meaningful.
 * The timezone is best-effort: a failure there shouldn't block a deploy.
 */
export function syncClock(): RemoteStep {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const setTz = tz && /^[A-Za-z0-9_+\-\/]+$/.test(tz)
    ? ` && { [ "$(timedatectl show -p Timezone --value 2>/dev/null)" = "${tz}" ] || sudo -n timedatectl set-timezone "${tz}" || echo "warning: couldn't set the timezone to ${tz}"; }`
    : "";
  return remote(
    "Set the Pi's clock and timezone from this computer (no internet time on the Pi)",
    `sudo -n date -u -s @${Math.round(Date.now() / 1000)} >/dev/null${setTz} && date`,
  );
}

export const ACTIONS: Action[] = [
  // ---- whole stack ----------------------------------------------------------------------
  {
    id: "start",
    label: "Start",
    scope: "stack",
    description: "Preflight (devices present, nothing else holding them), then start every container from the deployed compose.yaml.",
    confirm: (pi) => homeWarning(pi),
    steps: () => [t("Start stack", "start")],
  },
  {
    id: "stop",
    label: "Stop",
    scope: "stack",
    description: "Stop all containers (Pi-Vision first, Operator last). They're kept for a quick Start, and stay stopped across a reboot.",
    steps: () => [t("Stop stack", "stop")],
  },
  {
    id: "restart",
    label: "Restart",
    scope: "stack",
    description: "Restart all containers in place. Does not pick up a new deploy; use Deploy for that.",
    confirm: (pi) => homeWarning(pi),
    steps: () => [t("Restart stack", "restart")],
  },
  {
    id: "down",
    danger: true,
    label: "Remove containers",
    scope: "stack",
    description: "docker compose down: stop and delete the containers (images and logs are kept).",
    confirm: (pi) => `Remove all Talos containers on ${pi.name}? Images and logs stay on the Pi.`,
    steps: () => [t("Remove containers", "down")],
  },
  {
    id: "poweroff",
    danger: true,
    label: "Power off",
    scope: "stack",
    description:
      "End of day: stop the containers cleanly (Operator gets SIGINT), then shut the Pi down. Unplug only once the green ACT LED " +
      "has stopped flickering (~10 s). Yanking power without this is a common cause of corrupted microSD cards.",
    confirm: (pi) => `Shut down ${pi.name}? It stays off until you unplug and replug its power.`,
    steps: () => [
      t("Stop containers", "stop", { allowFail: true }),
      // The SSH session drops as the Pi goes down, so a non-zero exit here is expected.
      remote("Shut down", "sync && sudo -n systemctl poweroff", { allowFail: true }),
    ],
  },

  // ---- single service ------------------------------------------------------------------
  {
    id: "svc-start",
    label: "Start",
    scope: "service",
    description: "Start just this container; the others are left alone.",
    confirm: (pi, s) => (s === "operator" ? homeWarning(pi) : undefined),
    steps: (_cfg, _pi, s) => [t(`Start ${COMPONENT_LABEL[svcName(s)]}`, `start ${svcName(s)}`)],
  },
  {
    id: "svc-stop",
    label: "Stop",
    scope: "service",
    description: "Stop just this container.",
    steps: (_cfg, _pi, s) => [t(`Stop ${COMPONENT_LABEL[svcName(s)]}`, `stop ${svcName(s)}`)],
  },
  {
    id: "svc-restart",
    label: "Restart",
    scope: "service",
    description: "Restart just this container.",
    confirm: (pi, s) => (s === "operator" ? homeWarning(pi) : undefined),
    steps: (_cfg, _pi, s) => [t(`Restart ${COMPONENT_LABEL[svcName(s)]}`, `restart ${svcName(s)}`)],
  },

  // ---- troubleshooting ----------------------------------------------------------------
  {
    id: "runtime-start",
    label: "Start Docker runtime",
    scope: "troubleshoot",
    group: "Containers & disk",
    description: "The lab Pis' isolated Docker daemon (talos-docker.service) is not started at boot; start it after a reboot.",
    applies: (pi) => pi.runtime === "isolated",
    steps: () => [t("Start Docker runtime", "runtime")],
  },
  {
    id: "usb-rules",
    label: "Re-apply USB rules",
    scope: "troubleshoot",
    group: "Devices",
    description:
      "Install udev rules for /dev/talos-<pi>-serial and -camera, then re-trigger udev. This is what install-usb-rules.sh did, " +
      "and it fixes missing device names after re-plugging or a reboot.",
    applies: (pi) => udevRules(pi) !== null,
    steps: (_cfg, pi) => [t("Install rules and re-trigger udev", "usb-rules", { stdin: udevRules(pi)!, stdinNote: "generated udev rules (see More › Generated files)" })],
  },
  {
    id: "usb-detect",
    label: "Detect USB devices",
    scope: "troubleshoot",
    group: "Devices",
    description: "List serial adapters and cameras with their udev ID_PATH / vendor / product values (More › Settings can fill these in for you).",
    steps: () => [t("List USB serial + video devices", "usb-detect")],
  },
  {
    id: "device-owners",
    label: "Who owns the serial/camera?",
    scope: "troubleshoot",
    group: "Devices",
    description: "Show processes holding the arm's serial port and camera (two owners on one serial port = trouble).",
    steps: () => [t("fuser", "owners")],
  },
  {
    id: "esp-reset",
    label: "Reset ESP (pulse RTS)",
    scope: "troubleshoot",
    group: "Devices",
    description:
      "Reset the ESP32 through the USB-serial adapter's RTS line. Fixed Bluey on 2026-11-05, when the ESP stopped answering after a Pi reboot.",
    applies: (pi) => pi.arm.controller === "talos",
    confirm: (pi) => `Reset ${pi.name}'s ESP controller? The arm may twitch.`,
    steps: () => [t("Pulse RTS", "esp-reset")],
  },
  {
    id: "mediamtx-restart",
    label: "Restart MediaMTX",
    scope: "troubleshoot",
    group: "Containers & disk",
    description: "Restart the RTSP server, then the camera so it publishes again. Commander and Pi-Vision reconnect by themselves.",
    steps: () => [t("Restart MediaMTX and the camera", "restart mediamtx camera")],
  },
  {
    id: "retire-host-mediamtx",
    label: "Retire host MediaMTX service",
    scope: "troubleshoot",
    group: "One-time setup",
    description:
      "MediaMTX now runs in the stack. Stop and disable the old host mediamtx.service, which would hold port 8554. Deploy does this too. " +
      "Undo: sudo systemctl enable --now mediamtx",
    steps: () => [t("Stop + disable mediamtx.service", "retire-host-mediamtx")],
  },
  {
    id: "stop-legacy-services",
    label: "Stop legacy host services",
    scope: "troubleshoot",
    group: "Containers & disk",
    description: "Stop the pre-container camera-streamer / pivision-integration systemd units that grab the camera and ports.",
    steps: () => [t("Stop units", "stop-legacy")],
  },
  {
    id: "stop-foreign",
    label: "Stop non-Gaia containers",
    scope: "troubleshoot",
    group: "Containers & disk",
    description: "Stop containers from other compose projects, e.g. the old talos-arms stack from two-pi-20261104.",
    confirm: (pi) => `Stop every running container on ${pi.name} that Gaia didn't deploy?`,
    steps: () => [t("Stop foreign containers", "stop-foreign")],
  },
  {
    id: "host-check",
    label: "Check host health",
    scope: "troubleshoot",
    group: "System & network",
    description: "Kernel, CMA (the hardware encoder needs 256 MiB or more), encoder device, throttling, temperature, disk and memory.",
    steps: () => [t("Host checks", "host-check")],
  },
  {
    id: "kernel-log",
    label: "Kernel warnings (this boot)",
    scope: "troubleshoot",
    group: "System & network",
    description: "USB disconnects, codec faults and undervoltage show up here.",
    steps: () => [t("journalctl -k", "kernel-log")],
  },
  {
    id: "avahi-restart",
    label: "Fix mDNS name (restart avahi)",
    scope: "troubleshoot",
    group: "System & network",
    description:
      "If <pi>.local stopped resolving (avahi renamed the Pi to <pi>-2.local after a name conflict), restart avahi to reclaim the name. " +
      "Works even when .local doesn't resolve: Gaia also tries the addresses it last saw the Pi on.",
    steps: () => [remote("Restart avahi", `sudo -n systemctl restart avahi-daemon && sleep 2 && echo "advertising $(hostname).local"`)],
  },
  {
    id: "install-docker",
    label: "Install Docker",
    scope: "troubleshoot",
    group: "One-time setup",
    description:
      "Set up a normal Docker install from Docker's official Debian packages, downloaded on this computer (the Pis have no internet). " +
      "Stops the old isolated runtime if there is one (nothing is deleted). Safe to re-run to update Docker.",
    confirm: (pi) =>
      `Install Docker on ${pi.name}?\n\nIf the old isolated runtime is running, its containers stop. ` +
      `Afterwards set runtime: system for ${pi.id} in gaia.config.yaml and Deploy.`,
    steps: (_cfg, pi) => [
      { label: "Download the .debs", where: "local", run: [[task("download containerd.io, docker-ce-cli, docker-ce, docker-compose-plugin from download.docker.com (SHA-256 checked)", () => {})]] },
      remote("Copy them to the Pi", "tar -xf - -C /tmp/gaia-docker", { stdinNote: ".debs + daemon.json" }),
      remote("Stop the old isolated runtime", "sudo systemctl disable --now talos-docker.service   # if present"),
      remote("Install", "sudo install -D daemon.json /etc/docker/daemon.json && sudo apt-get install -y --no-install-recommends /tmp/gaia-docker/*.deb", {
        stdinNote: `daemon.json: ${DAEMON_JSON.replace(/\s+/g, " ").trim()}`,
      }),
      remote("Use Docker without sudo", `sudo usermod -aG docker ${pi.user} && sudo systemctl enable --now docker`),
      remote("Check", "docker info && docker compose version"),
    ],
    run: (job, cfg, pi) => installDocker(job, cfg, pi),
  },
  {
    id: "remove-isolated-runtime",
    danger: true,
    label: "Delete the old isolated runtime",
    scope: "troubleshoot",
    group: "One-time setup",
    description:
      "After moving to a normal Docker install: delete talos-docker.service, /opt/talos-docker and its images in /var/lib/talos-docker " +
      "(2-3 GB). ~/talos-containers is left alone.",
    applies: (pi) => pi.runtime === "system",
    confirm: (pi) => `Delete the old isolated Docker runtime and all its images on ${pi.name}? This can't be undone.`,
    steps: () => [
      remote(
        "Delete talos-docker",
        `if [ -e /etc/systemd/system/talos-docker.service ] || [ -d /var/lib/talos-docker ]; then ` +
          `sudo -n systemctl disable --now talos-docker.service 2>/dev/null; ` +
          `sudo -n rm -rf /var/lib/talos-docker /run/talos-docker /opt/talos-docker /etc/talos-containers /etc/systemd/system/talos-docker.service && ` +
          `sudo -n systemctl daemon-reload && echo "deleted"; else echo "nothing to delete"; fi; df -h / | tail -n 1`,
      ),
    ],
  },
  {
    id: "sync-clock",
    label: "Set clock and timezone from this computer",
    scope: "troubleshoot",
    group: "System & network",
    description: "The Pis have no internet time and no battery-backed clock, so after a reboot they can be days behind. Also copies this computer's timezone, so container logs are in local time. Deploy does this too.",
    steps: () => [syncClock()],
  },
  {
    id: "unique-identity",
    danger: true,
    label: "Give this Pi its own identity (cloned SD card)",
    scope: "troubleshoot",
    group: "One-time setup",
    description:
      "Pis flashed from one copied SD card share /etc/machine-id and NetworkManager's secret key, so they generate the same IPv6 " +
      "addresses. avahi sees the duplicate and renames one Pi to <name>-2.local. This makes new ones (old files kept as *.before-gaia), " +
      "then reboots. SSH host keys are left alone.",
    confirm: (pi) => `Give ${pi.name} a new machine-id and network secret, then reboot it? Operator stays stopped until you Start it.`,
    steps: () => [
      remote(
        "New machine-id + NetworkManager secret, then reboot",
        `sudo -n cp -n /etc/machine-id /etc/machine-id.before-gaia && sudo -n rm -f /etc/machine-id && sudo -n systemd-machine-id-setup && ` +
          `{ [ ! -f /var/lib/NetworkManager/secret_key ] || sudo -n mv /var/lib/NetworkManager/secret_key /var/lib/NetworkManager/secret_key.before-gaia; } && ` +
          `echo "new machine-id $(cat /etc/machine-id); rebooting" && sudo -n systemctl reboot`,
        { allowFail: true },
      ),
    ],
  },
  {
    id: "image-prune",
    label: "Prune dangling images",
    scope: "troubleshoot",
    group: "Containers & disk",
    description: "Remove untagged image layers left by repeated deploys. Tagged images, kept for rollback, are left alone.",
    steps: () => [t("Prune", "prune")],
  },
  {
    id: "reboot",
    danger: true,
    label: "Reboot Pi",
    scope: "troubleshoot",
    group: "System & network",
    description: "Reboot. MediaMTX, the camera and Pi-Vision come back by themselves (with a normal Docker install); Operator waits for Start.",
    confirm: (pi) => `Reboot ${pi.name}? Operator stays stopped until you Start it.`,
    steps: () => [remote("Reboot", "sudo -n systemctl reboot", { allowFail: true })],
  },
];

export function getAction(id: string) {
  return ACTIONS.find((a) => a.id === id);
}
