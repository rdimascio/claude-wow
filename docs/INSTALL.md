# Installing WoWGPT

Every route ends in the same place: the code on your machine, a `wowgpt` command, the addon in the game folder, and a bridge that is running while you play. Pick one route; the rest of this page (service, updating, uninstalling) is the same for all of them.

Before any of them you need:

- **World of Warcraft: Forever** or **World of Warcraft Classic** (Classic Era), run at least once with the account you play on (setup reads the account folder). Setup finds every client in `_classic_beta_`, `_forever_` and `_classic_era_` and installs into all of them; one bridge serves them all.
- **Nothing else, on route 1 or 3**: the bridge ships as one self-contained binary for macOS (arm64, x64), Linux (x64) and Windows (x64), with its runtime inside. Route 2 (npm), route 4 (a clone), and route 3 where there is no binary for your machine, run the code with **Node.js 22.2 or newer** (`node -v`: [nodejs.org](https://nodejs.org), `brew install node`, `winget install OpenJS.NodeJS.LTS`) or [Bun](https://bun.sh).
- **At least one agent CLI**, installed and logged in: `claude`, `codex`, `grok`, `agy` or `hermes` (see [AGENTS.md](AGENTS.md)). One is enough; the bridge lists what it found.

The addon can also come from the addon zip on the GitHub release. Every route below still needs the bridge and `wowgpt setup`, and setup writes the addon that ships with the bridge into `Interface/AddOns/WoWGPT` either way. The README's [Install](../README.md#install) section is the short version for players.

Platform notes that are not about installing (which display mode, screen-capture permissions, Wine and X11) stay in [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) and [INSTALL-LINUX.md](INSTALL-LINUX.md), and in the README's macOS section.

## The short way

```sh
brew install rdimascio/claude-wow/wowgpt     # macOS; or, anywhere with Node.js 22.2+: npm i -g wowgpt
wowgpt setup
```

Then fully quit and relaunch World of Warcraft and type `/wowgpt` in game. Nothing else is done by hand: setup finds the game, stops with "Quit World of Warcraft, then run setup again" while a client runs, installs the addon, picks the agent you have installed (and says "not ready: install one agent" when there is none), asks whether to share your game state, and installs the background service (Enter means yes; an existing service is reinstalled without asking). The agents get a project folder of their own, `~/wowgpt`; your home folder is never a project. `wowgpt setup --project <folder>` picks another one, and `/wowgpt cd` picks one per chat.

## Route 1: Homebrew (macOS)

```sh
brew install rdimascio/claude-wow/wowgpt
wowgpt setup
```

Until the first stable release fills in the formula's checksums, only `--HEAD` works (`brew install --HEAD rdimascio/claude-wow/wowgpt`): it installs the checkout and runs it with Homebrew's node. After that release, the command above installs the binary.

Homebrew installs the bridge and the `wowgpt` command: the self-contained binary for your Mac from the tagged release, or the checkout with `--HEAD`. It cannot put an addon into the game folder or read your WoW account, so `wowgpt setup` is a separate, required step. The keg holds only code: your config, the agents' sessions, transcripts and logs live in `~/.wowgpt` (`WOWGPT_HOME`, see [CONFIGURATION.md](CONFIGURATION.md#where-the-bridge-keeps-its-files)), so `brew upgrade` keeps them; `wowgpt setup` afterwards reinstalls the service, which restarts the bridge on the new code. The formula is in [`homebrew/`](../homebrew/README.md).

## Route 2: npm (macOS, Linux, Windows)

```sh
npm i -g wowgpt
wowgpt setup
```

This needs Node.js 22.2 or newer. npm puts the `wowgpt` command on your PATH; setup does the rest, as on route 1. The package is published with the first stable release; until then, use route 1 with `--HEAD`, route 3 or route 4.

## Route 3: the one-line installer

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.sh | sh
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.ps1 | iex
```

(Until a release with binaries exists, the installer finds no binary to download and installs from source, which needs Node.js 22.2 or newer.)

The script downloads the `wowgpt` binary for your machine from the project's GitHub releases into `~/.local/bin` (Windows: `%LocalAppData%\Programs\wowgpt\bin`, put on your user PATH), checks it against the release's `SHA256SUMS`, runs it once, and runs `wowgpt setup` (config, state and logs go to `~/.wowgpt`), which installs the background service: an existing service, under this name or an old one, is reinstalled without asking, so an update restarts the bridge on the new binary; a fresh install asks, and Enter means yes. When `~/.local/bin` is not on your PATH it offers to add it (Enter means yes) and otherwise prints the command's full path. Nothing else is installed: the binary is the bridge, setup and the service commands with their runtime inside. Where there is no binary for your machine (another platform, or no release yet), or with `--from-source` (`$env:WOWGPT_SOURCE = "1"` on Windows), it installs from source instead: checks for Node.js 22.2+, downloads the code (git if you have it, otherwise the archive) into `~/.wowgpt/app` (Windows: `%LocalAppData%\Programs\wowgpt`) and writes a `wowgpt` shim that runs it with node. An install under the project's old name (`~/.wow-ai`, the `wow-ai` command and service) is carried over; see [Coming from wow-ai](#coming-from-wow-ai). It never asks for sudo or administrator rights, it is safe to run again (that is how you update), and if something is missing it stops and says what to do.

Options go after `sh -s --` (macOS/Linux) or in the environment before `iex` (Windows):

| | macOS / Linux | Windows |
|---|---|---|
| Client folder, if setup cannot find it | `--wow "/Applications/World of Warcraft/_classic_beta_"` | `$env:WOWGPT_WOW = "D:\Games\World of Warcraft\_classic_beta_"` |
| Default project folder for the agents | `--project ~/code/my-game` | `$env:WOWGPT_PROJECT = "C:\code\my-game"` |
| Background service without asking / never (an existing one is otherwise reinstalled) | `--service` / `--no-service` | `$env:WOWGPT_SERVICE = "yes"` / `"no"` |
| The source with Node instead of the binary | `--from-source` | `$env:WOWGPT_SOURCE = "1"` |
| Which release's binary | `--release <tag>` | `$env:WOWGPT_RELEASE = "<tag>"` |
| Where the source goes (from source) | `--dir <folder>` | `$env:WOWGPT_DIR = "<folder>"` |

Without a release option the script takes the latest stable release. When that has no binary for your machine (for example, only pre-releases such as `v0.5.0-beta.1` exist so far), it takes the newest release of any kind, pre-releases included, and checks it against that release's `SHA256SUMS` the same way. To install one exact release, beta or not, name its tag: `--release v0.5.0-beta.1` (Windows: `$env:WOWGPT_RELEASE = "v0.5.0-beta.1"`). A named tag never falls back: when that release has no binary for your machine or the download fails, the installer stops and says so. It does not take another release or install from source. Add `--from-source` (`$env:WOWGPT_SOURCE = "1"`) when you want the source.

For example:

```sh
curl -fsSL https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.sh | sh -s -- --project ~/code/my-game --service
```

When it finishes: fully quit and relaunch WoW, enable *WoWGPT* on the AddOns screen, and type `/wowgpt hello` in game.

## Route 4: by hand (git)

```sh
git clone https://github.com/rdimascio/claude-wow
cd claude-wow
node setup.js --project ~/code/my-game     # or --wow "<client folder>" if it cannot find the client
npm start                                  # the bridge, in this terminal
```

This route needs Node.js 22.2+ or Bun (`bun setup.js`, `bun bridge/supervisor.js`); run `npm install` once: it fetches the Chat SDK packages that Discord sync (`discord.enabled`) loads, and the test tools. `npm run build` makes the self-contained binaries the other routes install (see [CONTRIBUTING.md](../CONTRIBUTING.md#building-the-binary)). To have the `wowgpt` command from any folder, `npm link` in the repo (see [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md) for what that does and the PowerShell execution-policy note), or write a two-line shim that runs `node <repo>/bridge/supervisor.js "$@"`.

## What setup does

`wowgpt setup` (the same as `node setup.js`) finds the client (or takes `--wow`), copies the addon into `Interface/AddOns/WoWGPT`, writes `config.json` in `~/.wowgpt` (or `WOWGPT_HOME`) with the paths and the default project folder, reports which agent CLIs it found (when the default agent is not installed and exactly one other is, that one becomes the default), and creates the 200 reply-slot addons plus about 16,400 tiny signal files. That count is normal: the client only sees addon files that existed at launch, so every signal file exists up front and the bridge signals by deleting one. Re-running it keeps your config and the slot pool; `--project <folder>` on a re-run corrects the default folder. A new config's default folder is `~/wowgpt` (made for it), never the folder setup runs in; `--project` refuses your home folder and a disk root, and setup warns when an existing config names one. Setup stops before it changes anything in the game folder while a configured client runs; when it cannot tell, it warns and goes on. At the end it installs the background service: `--service` and `--no-service` decide, an existing service (under this name or an old one) is reinstalled without asking so it runs this version, and otherwise a terminal is asked (Enter means yes). The last lines say what is left to do, with the `wowgpt` command's full path when it is not on your PATH. On the first run it asks one question: share your game state with the agent? The answer is no unless you type yes, and without a terminal it is no. `--share-game-state yes|no` answers it, and on a re-run changes it (see [Privacy](../README.md#privacy-what-leaves-your-machine)). The addon loads in WoW Forever (`_classic_beta_`) and in Classic Era (`_classic_era_`). Setup puts every client it finds into `clients` in `config.json` and installs the same build into each, with one `addon` line per client that names the build; `--wow <client folder>` adds one more client (or updates its entry) instead. The bridge then answers whichever client you play, in that client only. Setup prints a `restart:` line for each client that is running while it arms new signal files: fully quit and relaunch that one. It uses the same process check as the chat log clean (macOS, Windows and Linux; see [ARCHITECTURE.md](ARCHITECTURE.md)). When it cannot tell whether a client runs (for example in WSL or a container), it asks you to relaunch every client. To leave a client out, set `"enabled": false` on its entry ([CONFIGURATION.md](CONFIGURATION.md#clients)). After an update, run setup once and restart the bridge; there is nothing to switch.

Then **fully quit and relaunch each World of Warcraft client you play** (a `/reload` is not enough) and enable *WoWGPT* on the character-select AddOns screen. The 200 *WoWGPT slot* entries stay enabled; leave them alone.

## Game data

Claude checks game IDs (items, quests, zones, flight paths, skill lines) against the client tables of your own game. Fetch them once per game you play, and again after a game patch:

| Game | Command | Folder |
|---|---|---|
| World of Warcraft: Forever (`1.60.*`) | `wowgpt data sync` | `~/.wowgpt/data/forever/` |
| World of Warcraft Classic, Classic Era (`1.15.*`) | `wowgpt data sync --flavor classic_era` | `~/.wowgpt/data/classic_era/` |
| Classic Era NPCs and quest givers (community data, after the line above) | `wowgpt data sync --flavor classic_era --source community` | `~/.wowgpt/data/classic_era/community/` |

The bridge reads the client build the game reports and uses only the data of that game. With no data for it, the bridge refuses ID tokens in orders, goals and campaigns, and `ask` runs go without the `wowdata` tools; the bridge log names the command to run. No restart is needed after a sync. Details in [CONFIGURATION.md](CONFIGURATION.md#game-data).

## Running the bridge

Two ways, not both at once (two bridges fight over the slot files):

- **In a terminal:** `wowgpt` from the project folder you want the agents to work in (that folder becomes the default for chats), or `npm start` inside the repo. Leave the window open; Ctrl+C stops it; it restarts itself after a crash.
- **As a background service:** setup installs it, or `wowgpt service install`. It starts now and at every login, comes back after a crash, and needs no window. `wowgpt service status` says whether it is running, with its pid, uptime and the last log lines; `wowgpt service logs` (or `logs -f`) shows the log; `stop`, `start`, `restart` do what they say; `uninstall` removes it.

Under the service the bridge's default project folder is `defaultCwd` from `~/.wowgpt/config.json` (`wowgpt setup --project <folder>` sets it); chats still pick their own with `/wowgpt cd`.

### What the service is, per platform

| | Definition | Logs |
|---|---|---|
| macOS | LaunchAgent `~/Library/LaunchAgents/io.wowgpt.bridge.plist` (`RunAtLoad` + `KeepAlive`: starts at login, restarted by launchd 10 s after any exit) | `~/Library/Logs/wowgpt/bridge.log` |
| Linux | systemd user unit `~/.config/systemd/user/wowgpt-bridge.service` (`Restart=always`; needs `systemctl --user`, which every mainstream desktop has) | `~/.local/state/wowgpt/bridge.log` (`$XDG_STATE_HOME`) |
| Windows | `WoWGPT bridge.vbs` in your Startup folder, which starts the bridge with no window at login; the supervisor does the crash restarts | `%LocalAppData%\wowgpt\logs\bridge.log` |

Logs rotate at 5 MB with five old files kept, so they never grow without bound. The bridge's own `~/.wowgpt/bridge.log` is rotated the same way, in every mode. On macOS and Linux the service logs, `launchd.log` and every archive are mode `0600` and the service log folder is `0700`; the supervisor repairs older files when it starts.

Things worth knowing:

- **The service sees the PATH you had when you installed it.** launchd and systemd hand services an almost empty environment, so `wowgpt service install` bakes your PATH into the definition; the bridge finds `claude`, `codex` and the rest through it. After installing a new agent CLI, or a new Node, run `wowgpt service install` again.
- **macOS and screen capture.** A background process cannot ask for Screen Recording or Automation permission. The default screenshot transport needs neither (the addon takes a screenshot with the strip up; the bridge reads the file), so the service just works; `install` says so if `config.json` still names the deprecated pixel transport (`"mode": "pixel"` under `capture`), which exists only until `Screenshot()` is confirmed on Windows and Linux/Wine. On the pixel transport, run the bridge from a terminal that has the permissions instead.
- **Linux and X11 capture.** The deprecated pixel transport needs `DISPLAY`; the unit carries the one you had at install time. The default screenshot transport needs nothing.
- **If the screenshot transport cannot work on your client** (no `Screenshot()` function, or every shot fails), the bridge falls back to the pixel capture on its own, logs `TRANSPORT FALLBACK` with the reason, remembers it in `state.json`, and `/wowgpt diag` in game shows it; see the README's *Transports* section.
- **Windows without a restart-on-crash guarantee for the supervisor itself:** the Startup-folder route restarts the bridge when it crashes (that is what the supervisor does) but not the supervisor. If you want that too, create a Task Scheduler task (*Create Basic Task*, trigger *When I log on*, action `node "C:\...\wowgpt\bridge\supervisor.js"` with *Start in* set to the wowgpt folder, and under *Settings* tick *If the task fails, restart every 1 minute*) and delete the Startup-folder launcher with `wowgpt service uninstall`.
- `wowgpt service install` refuses to run without a `config.json` in the home folder (the service would only loop), refuses when a bridge is already running in a terminal (on Windows only when that pid is confirmed as the supervisor, as `stop` and `start` do, so a pid Windows gave to another program does not block it), and removes a service installed by the project's old name (`io.wowai.bridge`, `wow-ai-bridge`, *WoW AI bridge.vbs*) so two bridges never start at login; `uninstall` removes that one too.

## Updating

- Route 3, the binary: it updates itself. Once a day the bridge checks the latest GitHub release; when it is newer, it downloads the binary for your machine and the release's `SHA256SUMS`, checks the hash, runs the new file once (`--version`), and renames it over the old one. The bridge then restarts on it by itself, but only when no message is running, queued or held for a deploy, no deploy is switching releases, and the game is closed or no message or reply has passed for `autoUpdateIdleSeconds` (10 minutes). `wowgpt update` does the same at once (`--check` only says whether a newer release is out). It never installs an older or equal version. `"autoUpdate": false` in `config.json` turns off the daily check ([CONFIGURATION.md](CONFIGURATION.md#updates)). Run `wowgpt setup` after an update that changes the addon (the changelog says so), then `/reload` in game (the addon asks for it when the files on disk are newer than the ones it loaded), or relaunch the game when the addon asks for a full restart (a new addon folder). A new binary writes its own capture scripts and addon out under `~/.wowgpt/assets` the first time it runs. Running the one-line installer again still works too.
- Route 3 from source (`--from-source`): run the installer again. It pulls the source and re-runs setup, which reinstalls the service. A bridge that runs from source never updates itself.
- Route 1: `brew upgrade wowgpt` (`--fetch-HEAD` for a `--HEAD` install), then `wowgpt setup`: it reinstalls the service, so the bridge restarts on the new code (your config and sessions are in `~/.wowgpt`, untouched). The bridge never replaces a binary that Homebrew installed; when a newer release is out, its daily check logs `brew upgrade wowgpt`.
- Route 2: `npm i -g wowgpt`, then `wowgpt setup`, as for route 1.
- Route 4: `git pull && node setup.js`, then restart the bridge.
- A developer machine whose service should not run the checkout you edit: build releases with `wowgpt dev deploy` and run the service from `~/.wowgpt/current/wowgpt` (`~/.wowgpt/current/wowgpt service install` once, from your normal terminal, when no chat is running; then `~/.wowgpt/current/wowgpt setup`).

## Uninstalling

```sh
wowgpt service uninstall        # if you installed the service
```

Then delete the code (the `wowgpt` binary in `~/.local/bin`, Windows `%LocalAppData%\Programs\wowgpt`; `~/.wowgpt/app` for a from-source install; the Homebrew keg via `brew uninstall wowgpt`; or your clone), the home folder `~/.wowgpt` (config, sessions, transcripts, logs, and the binary's extracted `assets`; with a from-source route 3 the code is inside it too, so one `rm -rf ~/.wowgpt` does both), and the `wowgpt` shim in `~/.local/bin` (route 3 from source), `npm uninstall -g wowgpt` (route 2) or `npm unlink -g wowgpt` (route 4). In the game folder, delete `Interface/AddOns/WoWGPT` and the `WoWGPT_S001` … `WoWGPT_S200` folders next to it. Your chats' saved data is in `WTF/Account/<account>/SavedVariables/WoWGPT.lua`; the service's logs are in the folder listed above.

## Coming from claude-wow

The project was called claude-wow until it became WoWGPT. To move an install:

1. Update the bridge: the installer again, `brew upgrade` once the tap has the `wowgpt` formula, `git pull`, or `claude-wow update` (an installed `claude-wow` binary updates itself to WoWGPT).
2. Run `wowgpt setup` (an old `claude-wow` command still works; the installer turns it into a link to `wowgpt`). Setup copies `~/.claude-wow` to `~/.wowgpt` and the `ask` data folder to its `wowgpt` name, points the paths in `config.json` and `state.json` that named `~/.claude-wow` at `~/.wowgpt` (a chat whose agent session started in the old folder starts a new session), copies the addon's saved data (the account file and each character's file) to `WoWGPT.lua` with the globals renamed, and removes the `ClaudeWoW` addon and its slot folders. The old folders and files are kept; setup says when nothing in `~/.wowgpt` names `~/.claude-wow` any more, and you can delete it then.
3. Fully quit and restart the game.
4. Setup reinstalls the background service on its own: it removes the `io.claudewow.bridge` service (Linux `claude-wow-bridge`, Windows *Claude WoW bridge.vbs*) and starts `io.wowgpt.bridge`.
5. Bind the workspace key again. For a live session, start Claude Code with `server:wowgpt` and rename `mcp__claude-wow__*` allow rules to `mcp__wowgpt__*`.

`/claude` and `/claude-wow` still work in game; `/wowgpt` is the main command. The `CLAUDE_WOW_*` environment variables still count. The full list is in the CHANGELOG.

## Coming from wow-ai

The project was called wow-ai (and wow-claude before that). Run the installer again, or `wowgpt setup` (any route): it copies your chats and settings from the old addon's saved data (`WoWAI.lua` or `WoWClaude.lua`) to `WoWGPT.lua`, removes the old addon and its slot folders, and rewrites the addon paths in `config.json`. The installer also carries `config.json`, `state.json` and `transcripts.json` over from `~/.wow-ai/bridge` to `~/.wowgpt`, uninstalls the old service and removes the old `wow-ai` command; `wowgpt service install` removes the old service on its own too. The old slash commands (`/wow-ai`, `/ai`, `/ask`, `/wowai`, `/wow-claude`) are gone: it is `/wowgpt`. Details in [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md#upgrading-from-wow-ai-or-wow-claude) and the README.

## If something goes wrong

- The installer stops with `install failed: ...` and a `->` line: do what the arrow says and run it again. Nothing is left half-done: the code and the command go in before setup runs, so `wowgpt setup --wow "<client folder>"` is always the way to finish.
- `wowgpt service status` says `running : no`: `wowgpt service logs` shows why. `Cannot read config.json` means setup has not run; `NOT INSTALLED` in the banner means setup could not write into the game folder (check `addonDir` in `config.json`; the banner's `home :` line says where that is).
- The light in the game window stays red: the bridge is not running, or cannot see the game. Platform specifics are in [INSTALL-WINDOWS.md](INSTALL-WINDOWS.md#troubleshooting), [INSTALL-LINUX.md](INSTALL-LINUX.md) and the README's Troubleshooting section; `/wowgpt diag` in game reports what the addon sees.
