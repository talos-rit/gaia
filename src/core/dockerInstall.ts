import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, type Config, type PiCfg } from "./config.ts";
import type { Job } from "./jobs.ts";
import { task } from "./pipeline.ts";
import { closeConnection, sshArgv, sshDisplay, target } from "./ssh.ts";
import { tarCreate } from "./tar.ts";

/**
 * Troubleshoot > Install Docker: a normal Docker Engine install from Docker's own Debian
 * packages (what https://docs.docker.com/engine/install/debian/ does), for Pis without internet.
 * Gaia downloads the .debs on this computer, checks their SHA-256 against Docker's package index,
 * copies them over SSH and installs them with apt. A Pi that does have internet can later update
 * them with plain `apt` once Docker's apt repository is added.
 */
const REPO = "https://download.docker.com/linux/debian";
const PACKAGES = ["containerd.io", "docker-ce-cli", "docker-ce", "docker-compose-plugin"];
const CACHE = resolve(ROOT, ".cache", "docker-debs");

/**
 * All containers use the host network, so Docker needn't touch the firewall or create a bridge
 * (the reason the emergency setup isolated its daemon). The classic image store is what Gaia's
 * layer-skipping transfer is built and tested against.
 */
export const DAEMON_JSON =
  JSON.stringify(
    {
      iptables: false,
      ip6tables: false,
      "ip-forward": false,
      "ip-masq": false,
      bridge: "none",
      features: { "containerd-snapshotter": false },
      "log-driver": "json-file",
      "log-opts": { "max-size": "5m", "max-file": "2" },
    },
    null,
    2,
  ) + "\n";

interface Pkg {
  name: string;
  version: string;
  filename: string;
  sha256: string;
  size: number;
  depends: string[];
}

/** Debian version comparison (epoch:upstream-revision), enough for Docker's version strings. */
function cmpVersion(a: string, b: string): number {
  const split = (v: string) => {
    const [e, rest] = v.includes(":") ? [Number(v.split(":")[0]), v.slice(v.indexOf(":") + 1)] : [0, v];
    return { e, parts: rest.split(/(\d+)/).filter((x) => x !== "") };
  };
  const A = split(a), B = split(b);
  if (A.e !== B.e) return A.e - B.e;
  for (let i = 0; i < Math.max(A.parts.length, B.parts.length); i++) {
    const x = A.parts[i] ?? "", y = B.parts[i] ?? "";
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (x !== y) {
      // "~" sorts before everything, even the end of the string.
      if (x.startsWith("~") !== y.startsWith("~")) return x.startsWith("~") ? -1 : 1;
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function parseIndex(text: string): Pkg[] {
  return text.split(/\n\n+/).flatMap((stanza) => {
    const f: Record<string, string> = {};
    for (const line of stanza.split("\n")) {
      const m = line.match(/^([\w-]+):\s*(.*)$/);
      if (m) f[m[1]!] = m[2]!;
    }
    if (!f.Package || !f.Filename || !f.SHA256) return [];
    const depends = (f.Depends ?? "").split(",").map((d) => d.trim().split(/[\s(|]/)[0]!).filter(Boolean);
    return [{ name: f.Package, version: f.Version!, filename: f.Filename, sha256: f.SHA256, size: Number(f.Size), depends }];
  });
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Newest version of each package, downloaded into .cache/docker-debs (reused next time). */
async function fetchDebs(job: Job, codename: string, arch: string): Promise<{ pkgs: Pkg[]; files: Record<string, Uint8Array> }> {
  const indexUrl = `${REPO}/dists/${codename}/stable/binary-${arch}/Packages`;
  let pkgs: Pkg[] = [];
  const files: Record<string, Uint8Array> = {};
  await job.run({
    label: `Download Docker's packages for Debian ${codename}/${arch} on this computer (cached, SHA-256 checked)`,
    where: "local",
    timeoutMs: 900_000,
    run: [
      [
        task(`download ${indexUrl} and the newest ${PACKAGES.join(", ")} into .cache/docker-debs`, async (log) => {
          const res = await fetch(indexUrl);
          if (!res.ok) throw new Error(`${indexUrl}: HTTP ${res.status}`);
          const all = parseIndex(await res.text());
          pkgs = PACKAGES.map((name) => {
            const candidates = all.filter((p) => p.name === name).sort((a, b) => cmpVersion(b.version, a.version));
            if (!candidates[0]) throw new Error(`${name} not found in ${indexUrl}`);
            return candidates[0];
          });
          const dir = join(CACHE, `${codename}-${arch}`);
          mkdirSync(dir, { recursive: true });
          for (const p of pkgs) {
            const name = p.filename.split("/").pop()!;
            const path = join(dir, name);
            let data = existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined;
            if (data && sha256(data) === p.sha256) log(`cached     ${name}`);
            else {
              log(`download   ${name} (${(p.size / 1e6).toFixed(1)} MB)`);
              const r = await fetch(`${REPO}/${p.filename}`);
              if (!r.ok) throw new Error(`${p.filename}: HTTP ${r.status}`);
              data = new Uint8Array(await r.arrayBuffer());
              if (sha256(data) !== p.sha256) throw new Error(`${name}: SHA-256 mismatch (corrupt download?)`);
              writeFileSync(path + ".part", data);
              renameSync(path + ".part", path);
            }
            files[name] = data;
          }
        }),
      ],
    ],
  });
  return { pkgs, files };
}

export async function installDocker(job: Job, _cfg: Config, pi: PiCfg) {
  const os = await job.run({
    label: "Check the Pi's OS",
    where: "remote",
    cmd: `. /etc/os-release && echo "$ID $VERSION_CODENAME $(dpkg --print-architecture)"; docker --version 2>/dev/null || echo "docker: not installed"`,
  });
  const [id, codename, arch] = os.stdout.split("\n")[0]!.trim().split(/\s+/);
  if (id !== "debian" && id !== "raspbian") throw new Error(`expected Debian/Raspberry Pi OS, got ${id}`);

  const { pkgs, files } = await fetchDebs(job, codename!, arch!);

  // apt can't download anything on an offline Pi, so every other dependency must already be there.
  const deps = [...new Set(pkgs.flatMap((p) => p.depends))].filter((d) => !PACKAGES.includes(d)).sort();
  await job.run({
    label: "Check the Pi already has every dependency (it can't download any)",
    where: "remote",
    cmd:
      `missing=""; for p in ${deps.join(" ")}; do dpkg-query -W -f='\${Status}' "$p" 2>/dev/null | grep -q "ok installed" || missing="$missing $p"; done; ` +
      `if [ -n "$missing" ]; then echo "missing:$missing (give the Pi internet once and run: sudo apt-get install$missing)"; exit 1; fi; echo "all present: ${deps.join(" ")}"`,
  });

  await job.run({
    label: "Stop the old isolated Docker runtime, if any (its containers stop; nothing is deleted)",
    where: "remote",
    cmd:
      `if systemctl is-active --quiet talos-docker.service || systemctl is-enabled --quiet talos-docker.service 2>/dev/null; then ` +
      `sudo -n systemctl disable --now talos-docker.service && echo "talos-docker.service stopped and disabled (undo: sudo systemctl enable --now talos-docker)"; ` +
      `else echo "no isolated runtime in use"; fi`,
  });

  const tgt = await target(pi);
  const unpack = `rm -rf /tmp/gaia-docker && mkdir -p /tmp/gaia-docker && tar -xf - -C /tmp/gaia-docker && ls -l /tmp/gaia-docker`;
  const bundle = { ...files, "daemon.json": DAEMON_JSON };
  await job.run({
    label: `Copy ${pkgs.map((p) => `${p.name} ${p.version.replace(/^\d+:/, "").split("~")[0]}`).join(", ")} to the Pi`,
    where: "local",
    timeoutMs: 600_000,
    run: [
      [
        { kind: "source", display: `tar ${Object.keys(bundle).join(" ")}`, make: () => new Blob([tarCreate(bundle)]).stream() },
        { kind: "proc", argv: sshArgv(pi, tgt, unpack), display: sshDisplay(tgt, unpack) },
      ],
    ],
  });

  await job.run({
    label: "Install Docker (daemon.json first, so Docker starts with it)",
    where: "remote",
    timeoutMs: 900_000,
    cmd:
      `sudo -n install -D -m 0644 /tmp/gaia-docker/daemon.json /etc/docker/daemon.json && ` +
      `sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends /tmp/gaia-docker/*.deb`,
  });

  await job.run({
    label: `Let ${pi.user} use Docker without sudo, start Docker at boot`,
    where: "remote",
    cmd: `sudo -n usermod -aG docker ${pi.user} && sudo -n systemctl enable --now containerd.service docker.service && rm -rf /tmp/gaia-docker && echo ok`,
  });

  // Group membership applies to new logins only: drop the shared SSH connection.
  await job.run({
    label: "Reconnect so the new docker group applies",
    where: "local",
    run: [[task("ssh -O exit (close the shared connection)", () => closeConnection(pi))]],
  });

  await job.run({
    label: "Check Docker works",
    where: "remote",
    cmd: `docker info --format 'docker {{.ServerVersion}}, storage {{.Driver}}, cgroup {{.CgroupDriver}}' && docker compose version`,
  });
  if (pi.runtime !== "system")
    job.log(job.steps.length - 1, `Next: set "runtime: system" for ${pi.id} in gaia.config.yaml, then Deploy.`);
}
