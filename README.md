# Gaia
> [!info]
> Note for Contributors: This README is intended as a human-written and relatively succinct (yet appropriately thorough) explanation and guide as to what Gaia is and how to set it up. **Do not** add every single little new feature to this document! Only update this document when it becomes factually untrue or when there is a major expansion of functionality to necessitate it. Everything else can be documented in [README_DETAILED.md](README_DETAILED.md) instead.

Gaia is a lightweight utility for deploying and running the Talos Pi stack (**Operator**, **Cam Streamer**, **MediaMTX**, and **Pi-Vision**) on any number of Raspberry Pi's, as well as Commander on your own machine.

**Gaia can:**
- Set up a new Pi from scratch (just needs Raspberry Pi OS)
- Build, deploy, and monitor Operator, Cam Streamer, MediaMTX, and Pi-Vision on that Pi
- Build & deploy Commander's WebUI on your local machine
- Easily create images from a specified branch or your working copy
- Super simple troubleshooting without having to touch a command line
- Live-tail the logs of each running container
- Power off the Pi's properly (please don't yank the cables out! that can cause microSD card corruption!)
- Cache builds, so that you only have to transmit the layers you actually changed, greatly increasing iteration speed
- Display live stats about the Pi's e.g., temperature, CPU load, memory load

**Requirements:**
- Raspberry Pi running Raspberry Pi OS
	- Must have SSH keys set up; this will be covered in the [[#Getting Started]] guide
		- (Must have passwordless `sudo`)
	- Must have `python3` (I *think* this ships in Pi OS (Debian bookworm) by default though)
	- Does NOT require the Pi to have access to the internet!
- Local machine that will run Gaia & Commander
	- [Bun](https://bun.sh) ≥ 1.3 (Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`)
	- `git`
	- Docker with buildx to build images: Docker Desktop, or Colima on macOS. (Gaia's header warns if any of these are missing)

## Background
### What Gaia Replaces
Gaia exists to simplify the build and deployment process for developing software on the Pi's. Without Gaia, building a new version of Pi-Vision would have been a many-step process with lots of pitfalls for developers. Gaia streamlines this by making it as simple as clicking one (1) button in many cases.

More concretely, Gaia replaces an emergency setup that we were using for the demo after a Pi seemingly died the week of an important demo. The only way to run two copies of the pi stack on one pi was containerization, so we quickly bodged together a solution that would have been terrible to maintain in the long term. Gaia is the solution to that problem.

It also (notably) solves the problem of configuration uncertainty. Previously, we had multiple disparate versions of Operator with heavily ambiguous directory names, and team members found it difficult to communicate which version of Operator worked for any given task at any given time. It was a source of great confusion. Gaia displays the commit hash front-and-center (unless it's a working copy, of course), and it'll even tell you if someone else deployed a different version of Operator than the one you have configured.

So no more confusion over whether you run `/home/pi/operator2/operator/build/bin/erv` or `/home/pi/operator-dev/build/bin/erv`. And no more confusion over when that build was made and what branch it's from. Gaia makes everything clear and simple.

Some other changes made by Gaia include:
- MediaMTX now runs in a Docker container instead of as a `systemd` service
	- This makes deployment more streamlined, even though it's true that we don't "own" MediaMTX and won't really be bumping versions very often. It's especially better for deploying to new Pi's.
- We explicitly no longer use the version of Pi-Vision that (at time of writing) is still inside Commander. We always deploy from the pi-vision repo. This solves some more confusion we had about what was actually running for the demo.
- Gaia sets the Pi's clocks on deploy since their system clocks get reset every time they boot up
- Gaia also creates a utility script called `talos` that it uses to run many common operations on the Pi's ( `~/talos-stack/bin/talos`, linked as `/usr/local/bin/talos`)
- Builds occur **on the laptop**, not the Pi (so no need to tunnel your WAN connection over SSH!)
- Fixed duplicate machine-id and IPv6 address problems on Bingo & Bluey's Pi's in the process of setting up Gaia
	- (Gaia will also fall back onto recent IP addresses it's seen the Pi's on to make life easier)

### Pros & Cons
**Pros:**
- Greatly simplified iteration from your laptop *once you've set it up*
- Easy, clear version pinning
- Super simple setup of new Pi's
- Pi's don't need internet (**this project would not exist if not for this requirement**)
- Automatic configuration of Commander
- Exposes an [MCP Server](#MCP%20Server) to assist in agentic development efforts

**Cons:**
- Not a super user-friendly tool to set up & configure
- Requires Docker Desktop to use on Windows
- Obfuscates the actual infrastructure, meaning complexity can balloon without us realizing (this is more of a philosophical point; one could argue that, because it handles the infra work, there's very little reason to care about such a thing)

## Getting Started
Gaia is currently a tool aimed primarily at developers, so that is the intended audience of this guide. If you aren't a developer and just want to set up Talos with your Scorbots, you might want to view the main Talos docs. *(TODO: link to those once we figure out hosting)*

> [!note]
> In case you skip the SSH Keys section: Replace `pi@raspberrypi.local` in these commands with `<YOUR_PI_USERNAME>@<IP_OR_ZEROCONF_HOSTNAME>`! For instance, if your username on the Pi is `johnny` and your Pi's configured hostname is `appleseed`, you would use `johnny@appleseed.local`.
>
> If you're in the official Talos senior project group at RIT, your Pi's are probably on `pi@bingo.local` for the ER-V and `pi@bluey.local` for the dark teal/bluish-green ER-4pc. That being said, either Pi can feasibly connect to either robot, with the only real change (theoretically) being changing the Gaia config.

### Dependencies
#### SSH Keys
As mentioned above, you need to set up SSH keys. There are lots of great guides for how to do this, so I'll give you the short version.

On the Pi, run these commands to enable SSH and get your hostname:

```bash
sudo systemctl enable --now ssh
hostname -I
```

Replace `pi@raspberrypi.local` in future commands with `<YOUR_PI_USERNAME>@<IP_OR_ZEROCONF_HOSTNAME>`. *(I use `pi@raspberrypi.local` because those are the defaults and are most likely to be what you're working with.)*

Now, if you're on a Windows machine, open a Terminal to Powershell and use these commands to generate an SSH keypair:

```powershell
# Generate key (press Enter for default path; passphrase optional)
ssh-keygen -t ed25519 -C "you@windows"

# Copy public key to the Pi (asks for the Pi password once)
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh pi@raspberrypi.local "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"

# Test - should log in without a password
ssh pi@raspberrypi.local
```
*(If `ssh` isn't found, go to Settings → System → Optional features → add **OpenSSH Client**.)*

If you're on Linux or macOS, use these commands instead:

```bash
# Generate key (press Enter for default path; passphrase optional)
ssh-keygen -t ed25519 -C "you@linux"

# Copy public key to the Pi (asks for the Pi password once)
ssh-copy-id -i ~/.ssh/id_ed25519.pub pi@raspberrypi.local

# Test - should log in without a password
ssh pi@raspberrypi.local
```

#### Docker
##### Windows
Most of you are on Windows so I'll be a little more thorough with this one.

For the Docker backend, the official Talos stamp of "*least worst*" goes to WSL 2. Hyper-V is really meant for Windows containers, and Docker VMM is still in Beta. Maybe it will prove to be more stable in the long term, but at time of writing, it's apparently not really worth the drama. If you're super RAM-constrained, however, you could definitely consider it!

In a "Run as Administrator" PowerShell terminal:

```powershell
wsl --install          # reboot when it asks
wsl --update
wsl --version          # need WSL 2.1.5+
winget install -e --id Docker.DockerDesktop
```

Launch Docker Desktop and leave "Use WSL 2 instead of Hyper-V" checked. Now Docker's backend should hopefully be running!

If you want to, you can cap WSL's RAM usage in `%UserProfile%\.wslconfig`:

```ini
[wsl2]
memory=8GB
processors=4
```

> [!info] An Alternative
> If you don't want to use Docker Desktop for one reason or another, you can just skip the `winget` installation and install Docker *inside your WSL2 Ubuntu distro*!
>
> (Enable systemd first: add `[boot]` / `systemd=true` to `/etc/wsl.conf`, then `wsl --shutdown`).
>
> Follow the Linux steps below for the rest of the setup.

##### macOS (Colima)
```bash
# install homebrew if you somehow don't already have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# install Docker & Colima
brew install colima docker docker-compose docker-buildx

# let the docker CLI find the compose/buildx plugins
mkdir -p ~/.docker
cat > ~/.docker/config.json <<EOF
{ "cliPluginsExtraDirs": ["$(brew --prefix)/lib/docker/cli-plugins"] }
EOF

# OPTIONAL: start Colima at login
brew services start colima
# (not recommended unless you're frequently working with containers, especially if you're resource-constrained)
```

Gaia has a button to start Colima in its UI, so you don't need to start it just yet if you don't want to.

To start it manually with 4 max cores and 8GB max RAM:
```bash
colima start --cpu 4 --memory 8 --disk 60
```

##### Linux (Debian/Ubuntu)
On Ubuntu, swap `debian` for `ubuntu` in both URLs.

```bash
# remove distro packages that conflict
for p in docker.io docker-doc docker-compose podman-docker containerd runc; do sudo apt-get remove -y $p; done

# add Docker's apt repo
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# install
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# run without sudo (log out/in, or newgrp for this shell)
sudo usermod -aG docker $USER
newgrp docker

sudo systemctl enable --now docker
```

#### Other Dependencies
##### Bun
This is our official canon Javascript runtime and package manager. It's faster than `npm` or `pnpm` at installing packages, and it's more fun to type than `npm`. I think you could theoretically get away with just using `npm` instead, but we highly recommend Bun!

On Windows:

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
```

On macOS or Linux:

```bash
curl -fsSL https://bun.sh/install | bash
```

##### Git
This is a developer guide so you probably already have it, but just in case...

On Windows:

```powershell
winget install --id Git.Git -e --source winget
```

On macOS:

```bash
brew install git
```

On Linux: Use the appropriate package manager, e.g. apt. Here's [git's guide on the subject](https://git-scm.com/install/linux).

##### uv
If you're managing Commander through Gaia as well, you'll need `uv` installed.

On Windows, you can use WinGet:

```powershell
winget install --id=astral-sh.uv -e
```

On macOS/Linux:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

*(Or you can use homebrew if you want.)*

### Installation
This part's easy:
```bash
git clone https://github.com/talos-rit/gaia
cd gaia
bun install
bun run dev # http://localhost:4747
```

### Setup
Navigate to `http://localhost:4747` in your browser if you haven't already and check whether the default config works for you. If you're a member of the Talos senior project group at RIT, it probably does! If you aren't a team member, you may have to change the config to match your setup.

#### Configuring Gaia with Your Own Pi
Inside Gaia, click the ellipses (`...`) menu on the "Bingo" card, right under the yellow text that says "homes on start" and to the right of the red "Power off" button. In the dropdown, click Settings, then look at the bottom for the red "**Remove from Gaia**" button and click it. Do the same for Bluey's Pi.

Now, in the "Fleet" card/panel of the UI, click the "**Add a Pi**" button. Your Pi needs:
- a name to identify it in Gaia
- an ID to identify it in its serial/camera devices & in Commander
- a username and hostname where it can be reached
- (*optional*) fallback addresses in case Avahi (zeroconf) messes something up
- controller type (see [Setting Controller Type](#Setting%20Controller%20Type) below)
- USB device identifiers (see [[#Identifying USB Devices]] below)

Everything else in that menu can be safely left at defaults, but there are two that could be worth changing if you're on a different version of Pi, both under the "**Ports, stream and encoder**" section: Inference rate and Encoder.
- If you later notice thermal issues with your Pi, you might want to try lowering the inference rate cap
- If you aren't getting any video at all (or are getting other weird issues relating to the video feed), you might be having hardware encoder problems, in which case you can try switching to software encoding (albeit at lower quality)

However, you don't need to set these now. We advise you wait until you encounter problems before starting the troubleshooting process.

##### Setting Controller Type
This one needed more elaboration than can fit into a bullet point, but it's still (relatively) simple: Do you have a native, brand-name controller box, or our custom controller board setup powered by an ESP32? If you're using a Scorbot controller box, keep the "**Arm**" section at its defaults. Otherwise, set it to "ESP controller".

> [!warning]
> **At time of writing**, starting Operator does not home the ESP controller setup, and there is no telemetry implemented in the ESP firmware, so those two checkboxes should also be unchecked. However, the custom controller PCB hasn't even been finished yet; that is to say, we still have much to complete, including achieving higher firmware parity (e.g. by adding a homing sequence and adding support for the telemetry commands).

##### Identifying USB Devices
Click the "Detect USB devices" button underneath the text boxes, then click "Use as serial adapter" and "Use as camera" as appropriate. This *should* set you up for success, though you may have to search the internet some to find out what the vendor and product IDs map to. (You could also ask an AI chatbot)

#### Configuring Gaia
You may have also noticed the "Settings" button at the top-right of the screen. If you'd like to, you can click on it and explore some.

Generally, these settings are self-explanatory. For instance, if you already have a clone of Commander on your machine, and it isn't in `../commander` relative to Gaia, you should probably change the "**Commander → Checkout folder**" setting to match the correct relative path. If you want to speed up builds when iterating on Operator, you could theoretically disable the tests (although I wouldn't recommend it).

Some noteworthy config options:
- Pi-Vision
	- **Pose model:** If you want higher inference speed at the cost of worse pose detection quality, you can use a smaller pose model e.g. `yolo11n-pose-192.onnx` as opposed to the `-320` model (192px square versus 320px square). However, at time of writing this model must be in the pi-vision repository, so you'd have to fork it (or always use a working copy as your source - though this somewhat beats the purpose of Gaia)
	- **Environment:** If you're using a Pi 5 or some other more powerful Linux machine, you could theoretically get away with setting `POSE_THREADS` to a higher number.

Other config options are far more niche and contextual. I wouldn't bother messing with them unless you have a good reason to!

## Using Gaia
With your Pi(/Pi's) accessible to your computer:
1. Look on the "**Fleet**" panel on the left-hand side of the screen, and click the blue "Build & deploy" button.
	- This will start all containers by default, so be sure that the robots are able to run their homing sequence safely!
2. Then, just below it, in the "**Commander**" panel, click the "Set up" button.
	- If Commander is already installed in `../commander` (path relative to where you put Gaia), then click "Build & run" instead.
	- If you don't have a `../commander/config/robot_configs.local.yaml` file already, Gaia will write one for you based on your Gaia setup!! So be sure to set up `gaia.local.yaml` with info about your Pi('s)/robot(s) to make this config as accurate as possible - see [Gaia's Config File](#Gaia's%20Config%20File) for more info.
		- (Note: Gaia never overwrites an existing local config.)
	- You can then click the text that says "`localhost:8000`" to open Commander in a new tab.

That's it! Those are the basics, at least. However, this doesn't cover Gaia's killer features: Troubleshooting and Version Changing. For more info, see the sections on [Troubleshooting](#Troubleshooting) and [Developing with Gaia](#Developing%20with%20Gaia) respectively.

### Troubleshooting
TODO: a section on how to troubleshoot common/notorious pi issues

### Developing with Gaia
In this section, I'll walk through the process of completing one iteration of the Pi-Vision repo with Gaia to show just how simple it really is. We'll start with Gaia at its default settings, with all Pi stack items pulling from `main`/`master` (or the most relevant current branch[^1]).

**TODO**: flesh out this section. use screenshots as needed!!

1. demonstrate gaia UI basics
2. go to “More” then click “Pi-Vision dashboard” to show the current “EYE LINE (1/3)” line
3. open Zed and change `"EYE LINE (1/3)"` to `"HELLO GAIA"` (~~it’s a hello world joke~~)
4. in gaia UI, change pi-vision ref to to “Working copy” with path of `../pi-vision-dual-arm` (mention that it’s a worktree!) and hit Save
5. on Bingo, hit “Deploy”
6. wait a little bit
7. refresh pi-vision dashboard tab

## MCP Server
If you want your agent to handle something (or everything) for you, from Pi management to troubleshooting to container deployment, then I've got good news for you: Gaia exposes an MCP server! For the unaware, MCP is just a more marketable way of saying "documented API".

The easiest way to add our MCP server is probably just to ask your agent to do it, especially if you're using a more obscure harness. But in the interest of saving tokens, here's how to do it for several of the more noteworthy harnesses:

**Claude:**

```bash
claude mcp add --scope user --transport http gaia http://localhost:4747/mcp
```

**OpenAI Codex:**

```bash
codex mcp add gaia --url http://localhost:4747/mcp
```

**Cursor:** Add the following to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "gaia": {
      "url": "http://localhost:4747/mcp"
    }
  }
}
```

(or add it to `.cursor/mcp.json` on a project-by-project basis if you'd prefer to avoid bloating your context elsewhere)

(be sure to restart Cursor after saving!)

**OpenCode:**

```bash
opencode mcp add gaia --global --url http://localhost:4747/mcp
```

**Google Antigravity / Cognition Windsurf:**

Add to `~/.gemini/config/mcp_config.json` or `~/.codeium/windsurf/mcp_config.json` respectively:

```json
{
  "mcpServers": {
    "gaia": {
      "serverUrl": "http://localhost:4747/mcp"
    }
  }
}
```

For `agy`, you can also do project-specific configuration by putting that JSON in `.agents/mcp_config.json` inside the relevant project.

I think Gemini CLI is getting deprecated but the command is very similar to Claude if you're still using it somehow: `gemini mcp add --scope user --transport http gaia http://localhost:4747/mcp`


[^1]: at time of writing, for instance, the default config pulls Operator from `feat/dual-arm-containers` since that's the most up-to-date branch
