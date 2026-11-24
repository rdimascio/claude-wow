# WoWGPT

> Renamed from claude-wow. Your chats, settings and sessions come across: update, run `wowgpt setup`, restart the game. See [Coming from claude-wow](docs/INSTALL.md#coming-from-claude-wow).

<p align="center">
  <img src="docs/screenshot.jpg" alt="The WoWGPT chat window open in Goldshire, with a message on its way to a coding agent" width="900">
</p>

Chat with your local coding agents from inside **World of Warcraft: Forever** or **World of Warcraft Classic** (Classic Era): [Claude Code](https://claude.com/claude-code), [OpenAI Codex](https://developers.openai.com/codex), [xAI's Grok Build](https://docs.x.ai/build/overview), Google's Antigravity CLI and Hermes Agent. Send a task, go back to questing, get pinged in-game when the answer lands. No alt-tabbing, no `/reload` per message.

- Multiple chats, each its own persistent agent session (like separate terminals), running in parallel. Each chat picks its agent and its folder
- Live progress while the agent works: action count, elapsed time, the files it's editing and commands it's running
- Replies in the workspace window and echoed into the game chat, or, if you turn whisper tabs on, into the chat's own whisper tab; `/r` replies to the chat that answered last
- The agent knows your character, level, zone, talents, professions and quest log (optional), and you can shift-click items, spells and quests into a message
- The agent can draw on your world map: numbered routes, quest stops and marks, with a navigator arrow that walks you from stop to stop
- Herb and ore spawns on the world map, filtered by your gathering skill (`/wowgpt config map ore`, `/wowgpt config map herb`)
- Ready-made macros: ask for one and the reply carries a **Create Macro** button that saves it and puts it on your cursor, ready to drop on an action bar (`/wowgpt config macro undo` reverts it)
- Live UI widgets: ask for *"a DPS meter"* or *"a timer bar for my buffs"* and the agent's Lua loads in the game once you click **Show**, no `/reload`; off until `/wowgpt config ui widgets on` (see [the risk](#live-ui-widgets)); display-only, listed and removed with `/wowgpt config ui` or the **Widgets** page in the game's AddOns settings
- **Need / Greed / Pass** on permissions: when Claude or Grok needs a command outside your allowlist, an **WoWGPT asks** frame offers it as an epic item. It waits while you are in combat or a real loot roll is open
- A status light for the companion app, automatic retries, and recovery of your chats (and map layers) if the beta client wipes addon data
- Runs on Windows, on Linux with the game under Wine, and on macOS with a native client

Nothing here injects code, reads game memory, or generates input. The addon uses documented addon APIs only; the companion reads your screen and writes ordinary files.

## How it works, in one paragraph

WoW addons are sandboxed: no network, no file reads at runtime. Two doors remain. **Out:** the addon draws your message as a strip of colored 4-pixel squares in the top-left corner of the screen and calls `Screenshot()`; the bridge decodes the file the game writes to its `Screenshots` folder, deletes it, and runs the chat's agent headless in the chat's folder. (The deprecated `pixel` mode screen-captured that corner four times a second instead; see [Transports](#transports).) **In:** a load-on-demand addon reads its files from disk at the moment it is loaded, so the bridge writes the reply into a pool of 200 pre-made slot addons and the game loads a fresh one from a timer. Cheap "is it ready yet" checks ride on a third trick: an empty `.wav` won't play and a valid one will. Map layers travel the same way: the agent's tools hand them to the bridge, which keeps them versioned and ships them inside the slot files. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/MAP.md](docs/MAP.md).

## What a chat is

What a chat *does* with your message depends on how you started it; the window, the whisper tabs, the game-chat echo, the map, macros, your character context and the transcripts are the same either way ([docs/PLATFORM.md](docs/PLATFORM.md) has the design).

| Chat | What it is |
|---|---|
| no folder (the default) | General in-game AI chat: game questions, quest research, routes on the map, macros. No project: the agent runs in a scratch folder of its own and is told it is your in-game assistant, not a coding session. |
| a folder (`/wowgpt cd realms`) | An agent session in that folder, like `claude` in a terminal there: the agent edits and runs things in the project. |
| a running terminal session (`/wowgpt -r <name>`) | A Claude Code session you already have open in a terminal: the chat talks straight into it through a Claude Code channel, its answers come back here, and its permission prompts come up as a Greed/Pass roll (allow once or deny; nothing is saved). Start the session with `claude --dangerously-load-development-channels server:wowgpt` from this repo; see [docs/LIVE-SESSION.md](docs/LIVE-SESSION.md). |

A message that starts with `@ask ` or `@claude ` (in the window or a whisper tab) goes to general chat or to the coding session whatever the chat is. Both run whichever agent the chat picked. `/wowgpt config plugin <name>` pins a chat to one of these by hand (`ask`, `claude-code`, `live`); you should not need it.

## Agents

The bridge drives whichever of these you have installed; each chat can use a different one.

| Agent | CLI the bridge runs | Permissions | Greed / Need roll (Allow & retry) |
|---|---|---|---|
| **Claude Code** (`claude`) | `claude -p --output-format stream-json`, resumed with `--resume` | `permissionMode` + `allowedTools` rules | yes |
| **Codex** (`codex`) | `codex exec --json`, resumed with `codex exec resume` | a sandbox chosen from `permissionMode` (read-only, workspace-write, or none) | no: a command the sandbox declined is reported in the reply |
| **Grok Build** (`grok`) | `grok --prompt-file … --output-format streaming-json`, resumed with `-r` | `permissionMode` + the same `allowedTools` rules, translated to Grok's globs | yes, when Grok reports a refused tool |
| **Antigravity** (`agy`) | `agy -p=<prompt> --output-format stream-json`, resumed with `--conversation` | Antigravity permission switches | no |
| **Hermes** (`hermes`) | `hermes chat --query-file -`, resumed with `--resume` | default only; the bridge never uses `--yolo` | no |
| **Local** (`local`) | the bridge's own `bridge/localagent.js`, which calls an OpenAI-compatible server such as `llama-server` on your PC; costs nothing | no file or shell tools; ask chats get the read-only `wowdata` tools | no |

`agent` in `~/.wowgpt/config.json` is the default (`claude`). `/wowgpt -c --agent codex` switches the current chat, or right-click a chat in the chat list on the right of the window and pick one under **Agent**; the reply bubbles and the game-chat echo are labelled with whoever answered. A session belongs to the agent that made it, so a chat that changes agent starts a fresh session there (its transcript stays). Install notes, the exact command lines, what each permission mode means per agent, and known limits are in [docs/AGENTS.md](docs/AGENTS.md).

## Install

WoWGPT (this project, wowgpt) has two parts, and you need both:

- **The addon** (`WoWGPT`), which runs inside the game.
- **The companion app** (`wowgpt`), a small program on the same computer. It reads your messages from the game, runs your agent, and writes the replies back. The addon cannot do anything without it. Logs and the developer docs call it the bridge.

You also need one agent CLI, installed and logged in on that computer. For Claude Code, `claude --version` must work and you must have logged in once by running `claude`. The other agents are listed under [Requirements](#requirements).

### 1. Get the addon

You can skip this step. `wowgpt setup` (step 3) copies the addon that ships inside the bridge into `Interface/AddOns/WoWGPT`. To install it by hand instead, download the addon zip (its name starts with `WoWGPT`) from the project's GitHub release and unzip it into `Interface/AddOns`, so that `Interface/AddOns/WoWGPT/WoWGPT.toc` exists.

Setup always writes its own copy of the addon into `Interface/AddOns/WoWGPT`, so the addon and the bridge come from the same release. When they differ, the addon says once which side is older; update that side (see [Troubleshooting](#troubleshooting)).

### 2. Install the bridge and run setup

```sh
brew install rdimascio/wowgpt/wowgpt     # macOS (Homebrew)
npm i -g wowgpt                              # or: macOS, Linux or Windows with Node.js 22.2+
wowgpt setup
```

Setup does the rest. It finds the game and stops with "Quit World of Warcraft, then run setup again" while a client runs. It installs the addon, picks the agent you have installed (or says "not ready: install one agent"), asks whether to share your game state, and installs the background service (Enter means yes; a service from an earlier install is reinstalled without asking). The agents get a project folder of their own, `~/wowgpt`; your home folder is never a project.

Until the first stable release, Homebrew needs `--HEAD` (`brew install --HEAD rdimascio/wowgpt/wowgpt`), the npm package is not published, and the one-line installer below does not exist yet: it is a file of the release. Once a release is out, the one-line installer is the third route:

macOS and Linux:

```sh
curl -fsSL https://github.com/rdimascio/wowgpt/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/rdimascio/wowgpt/releases/latest/download/install.ps1 | iex
```

The one-line installer scripts are files of the latest stable release (`releases/latest`), not of `main`, so what runs is the script that shipped with that release, and they download its binary. While no stable release has a binary, they fall back to the newest release, betas included. A pinned release is used as-is, with no fallback. To pin one release, name it: `sh -s -- --release v0.5.0-beta.1` after the `curl` command on macOS and Linux, or `$env:WOWGPT_RELEASE = "v0.5.0-beta.1"` before the PowerShell command.

The installer downloads the `wowgpt` binary for your computer (macOS arm64 and x64, Linux x64, Windows x64), checks it against the release's `SHA256SUMS`, and runs `wowgpt setup` for you. When there is no binary for your computer, or the download or its check fails, it stops and installs nothing. `--from-source` installs the release's source instead, and that needs Node.js 22.2 or newer. It never uses sudo, and you run it again to update.

### 3. Point it at your game

```sh
wowgpt setup --wow "<client folder>"
```

Setup has already run once in step 2. Run it again with `--wow` when it could not find the game or picked the wrong game. It reinstalls the background service when there is one, which restarts the bridge, so the new `config.json` is read. The client folder is the one that holds the game for one version:

| Game | macOS | Windows |
|---|---|---|
| Classic Era | `/Applications/World of Warcraft/_classic_era_` | `C:\Program Files (x86)\World of Warcraft\_classic_era_` |
| Forever | `/Applications/World of Warcraft/_classic_beta_` or `/Applications/World of Warcraft/_forever_` | `C:\Program Files (x86)\World of Warcraft\_classic_beta_` or `...\_forever_` |

On Linux the game is inside your Wine prefix; see [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md).

Without `--wow`, setup looks for `_classic_beta_`, then `_forever_`, then `_classic_era_`, and uses the first one it finds. **If you play Classic Era and also have Forever installed, pass `--wow`.** Log in to the game once before setup: setup reads your account folder under `WTF/Account`. Setup copies the addon, writes `~/.wowgpt/config.json`, and creates the 200 reply-slot addons and about 16,400 small signal files. That count is normal. It is safe to run setup again; it keeps your config and chats.

Optional: fetch the game data that lets the agent check item, quest and zone IDs. Run `wowgpt data sync --flavor classic_era` for Classic Era, or `wowgpt data sync` for Forever.

### 4. Quit and start the game once

**Fully quit World of Warcraft and start it again.** A `/reload` is not enough the first time: the game builds its addon list when it starts, and setup has just made new addon folders (`WoWGPT_Runtime` and the slot folders). On the character-select screen, open **AddOns** and enable *WoWGPT*. Leave the *WoWGPT slot* entries enabled.

### 5. Start the bridge and say hello

Setup's last lines say whether the bridge runs in the background. If it does, check it with `wowgpt service status` and skip to the next paragraph. Only one bridge can run at a time, so do not start a second one in a terminal. Otherwise pick one:

```
wowgpt                    # the bridge in this terminal; Ctrl+C stops it
wowgpt service install    # or: in the background, now and at every login
wowgpt service status     # is it running? pid, uptime, versions, last log lines
```

In game, type `/wowgpt hello`. This starts a new chat and sends "hello" to your agent; the reply comes back as a whisper in a **Claude** tab in the chat dock. The default agent is Claude Code. If you have only another agent, type `/wowgpt --agent <id> hello` instead, where `<id>` is `codex`, `grok`, `agy` or `hermes`, or set `agent` in `~/.wowgpt/config.json` and restart the bridge. Bare `/wowgpt` opens the window on the current chat, and `/wowgpt new` starts an empty chat. The bridge's start-up banner lists each agent CLI it found, and what to install for the ones it did not find.

### Updating

- **Addon:** `wowgpt setup --wow "<client folder>"` installs the addon that ships with the bridge. Always repeat `--wow`: without it, setup searches again and picks `_classic_beta_` first, even if you play Classic Era.
- **Bridge:** `brew upgrade wowgpt` or `npm i -g wowgpt`, then `wowgpt setup`; or run the installer again. Setup reinstalls the background service, so the bridge restarts on the new version (restart a bridge in a terminal by hand).
- **In game:** if the update made a new addon folder, quit and start the game again. Otherwise `/reload` is usually enough. If setup or the addon asks for a full restart, do that.

### Other ways to install, and installing for development

[docs/INSTALL.md](docs/INSTALL.md) has every route in detail: Homebrew, npm, all the installer options (`--project`, `--service`, `--from-source`, `--release`), Homebrew `--HEAD`, the background service on each platform, and uninstalling. To run from a git checkout:

```sh
git clone https://github.com/rdimascio/wowgpt
cd wowgpt
node setup.js --wow "<client folder>"
npm start
```

This needs Node.js 22.2 or newer, or Bun. Platform notes: [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md), [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md), and the macOS section below. For tests and conventions, see [Development](#development) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Requirements

- Windows (NTFS), or Linux with the game under Wine (see [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md)), or macOS with a native client. python3 only if you use the deprecated pixel-capture fallback off Windows; the default screenshot transport needs nothing
- World of Warcraft: Forever (tested on 1.60.1.69913 and 1.60.1.69977, TOC 16001) or World of Warcraft Classic Era (1.15.9.70003, TOC 11509), **windowed or borderless** (exclusive fullscreen blocks screen capture). Game data for reference tokens is synced per game: `wowgpt data sync` for Forever, `wowgpt data sync --flavor classic_era` for Classic Era; the bridge uses the one that matches the client
- Nothing else for the installer and the Homebrew route (npm needs Node.js 22.2 or newer): the bridge ships as one self-contained binary (macOS arm64 and x64, Linux x64, Windows x64). From a checkout it runs on [Node.js](https://nodejs.org) 22.2 or newer, or on [Bun](https://bun.sh)
- At least one agent CLI, installed and logged in:
  - [Claude Code](https://claude.com/claude-code): `claude --version` works, and you ran `claude` once to log in
  - [Codex](https://developers.openai.com/codex): `npm install -g @openai/codex`, then `codex` once to log in
  - [Grok Build](https://docs.x.ai/build/overview): `irm https://x.ai/cli/install.ps1 | iex`, then `grok login`
  - Antigravity (`agy`): install Google's Antigravity CLI, then run `agy` once to log in
  - Hermes Agent (`hermes`): install it, then run `hermes setup` once

## Platform notes

### macOS (native client)

Setup looks for the client under `/Applications/World of Warcraft` and `~/Applications/World of Warcraft` (pass `--wow "<client folder>"` otherwise). The default screenshot transport is all a Mac needs: the addon takes a screenshot with the strip up and the bridge reads the file from the client's `Screenshots` folder; no screen capture, no Screen Recording or Automation permission, no python, works on Retina displays, and the right configuration for the background service (a background process cannot ask for a permission). The deprecated `pixel` transport (`"mode": "pixel"` under `capture` in `~/.wowgpt/config.json`) captures the game window with `bridge/capture_mac.py` (python3) and needs **Automation** (System Events) and **Screen & System Audio Recording** for the terminal the bridge runs in; macOS does not always prompt, so on that transport `setup.js` checks both and names whichever is missing (`npm run check:mac` re-runs that check; `npm run probe:mac` saves what the capture sees to `bridge/probe.png`). Grant a permission, then quit and reopen the terminal. The pixel decoder reads one image pixel per addon pixel, so on a Retina display it never decodes. See [Transports](#transports).

### Renamed from wow-ai

This project was called wow-ai (and wow-claude before that): the addon was `WoWAI`, the command `wow-ai`, the slash command `/wow-ai` with `/ai`, `/ask`, `/wowai` and `/wow-claude` as aliases. It is wowgpt now, and the old names are gone rather than aliased: the addon is `WoWGPT`, the command `wowgpt`, the slash command `/wowgpt`, the service `io.wowgpt.bridge`, the environment variables `WOWGPT_*`. Nothing of yours is lost:

- **Chats.** Run the installer again, or `git pull` and `node setup.js`. Setup copies your chats and settings from the old addon's saved data (`WoWAI.lua`, or `WoWClaude.lua`) to `WoWGPT.lua` with the globals renamed, removes the old addon and its 200 slot folders so two addons do not fight over `/r` and the shift-click hook, and rewrites the paths in `config.json`. The old saved file is left where it was. Then **fully quit and relaunch WoW** and enable *WoWGPT* on the AddOns screen (the old *WoW AI* entry is gone).
- **Agent sessions.** The bridge keys them by chat id in `state.json`, so they follow the chats. Config, state and transcripts move from `bridge/` in the checkout to `~/.wowgpt` (`WOWGPT_HOME`, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md#where-the-bridge-keeps-its-files)); setup and the installer copy them there once and leave the originals.
- **The service and the command.** `wowgpt service install` (and `uninstall`) remove the old `io.wowai.bridge` / `wow-ai-bridge` / *WoW AI bridge.vbs* service first, so two bridges do not start at login. The installer removes the old `wow-ai` shim; `npm unlink -g wow-ai` if you had linked it by hand. A hotkey set with `/wow-ai bind` needs `/wowgpt config bind <key>` again, and macros that typed `/ai ...` need `/wowgpt ...`.

### `wowgpt`: start it from the project folder

Like the agent CLIs themselves, the bridge works in the folder you start it from (but never in your home folder or a disk root: started there, it uses `defaultCwd`):

```
cd ~/code/realms
wowgpt
```

Every chat that hasn't picked its own folder now works in `realms`, and the panel's cwd line shows it. `wowgpt --project <dir>` names the folder explicitly; the background service and `npm start` inside the repo fall back to `defaultCwd` in the config (`wowgpt setup --project <dir>` sets it). Only one bridge can run at a time (two would fight over the screen and the slot files), so this sets the default folder rather than giving you one bridge per project.

## Use

In game, the workspace window is the way in. Bare `/wowgpt`, the minimap button or the **WoWGPT: open or close the workspace** key binding opens it. Type in the box at the bottom and press Enter: the message goes to the agent and never to the server. The transcript shows the progress while the agent works (`Claude is working... 45s · 12 actions - Editing Map.lua`) and then the reply. A denied command brings up the permission roll, a macro comes as a **Create Macro** button, and a route as a **show route** button that opens the map. The minimap button carries the status: a small light at its lower right (green, yellow or red; grey before the companion app is seen) and a pulse while a reply waits with the window closed. Nothing else sits on the screen.

Whisper tabs are off by default; `/wowgpt config whisper on` or the Options page turns them on (an install where you had turned them on keeps them on). Then each chat gets a tab in the chat dock, next to General, like a whisper from a friend, once the companion app answers and the chat has a message. Click it, type, press Enter: the message goes to the agent and never to the server. You see `To Claude: ...`, then one progress line that updates in place (`Claude is working... 45s · 12 actions - Editing Map.lua  [cancel]`), then the reply as a whisper. A short reply shows whole; a long one shows its TL;DR and a **[full reply]** link. `/wowgpt` commands typed in the tab answer there, a denied command offers **[Greed] [Need] [Pass]** links, a macro comes as a **[Create Macro: Name]** link, a route as a **[show route]** link, and the companion app status says itself in one line with a **[connect]** link when the companion app goes quiet.

The big window is the workspace: full transcripts, the chat list on the right and settings. It opens when you ask: bare `/wowgpt`, the **WoWGPT: open or close the workspace** key binding (Key Bindings > AddOns), the minimap button, or a click on **[full reply]**. The minimap button, the orange Claude spark on the minimap's edge, is always there: left-click opens or closes the window, right-click opens the Options page, and dragging it moves it around the minimap (square minimaps too); its tooltip shows the status, the new replies and working agents, and the estimated API cost. `/wowgpt config minimap off` or the Options page hides it; a reply to a closed window then prints one chat line that says to type `/wowgpt`. The X button and Esc close it (Esc in the message box closes it too and keeps your draft). Closed is the only state besides open: there is no minimize and no floating bar. A window that was closed at logout stays closed at login, with nothing on screen. When a reload is needed to read a reply, the game asks first (**Reload** / **Later**) and never reloads on a keypress or in combat. With `/wowgpt config auto` on it asks again after the interval when you pick Later; off, it asks once per waiting reply. While it is open it keeps out of the way: it steps aside when bags, the character sheet, the spellbook, a vendor, the bank, the mail, the loot window or another Blizzard panel opens and goes back when they close (it never moves a Blizzard window; beside the small world map it takes the map's top and height, so the edges line up), it steps away while the maximized map or the game menu is up, and it dims to 35% while you move or fight (full again under the mouse or while you type). It opens in the left panel slot like a Blizzard panel, and it cannot be dragged. It remembers its size per character. Until the companion app has answered, a **Connect** button sits where Send would be. The header band at the top of the window holds the chat title and, at its right, the **Project** and **MCP** buttons: click one for its menu, hover it for the full value. In a narrow window the labels go first, then long names are cut; the full value stays in the tooltip. Right above Send, the **Effort** meter shows five bars, gold up to the chat's effort, and its value: the chat's own choice, else what the companion app passes for that agent, else `auto` when the agent picks for itself. Click it for the menu; hover it to see where the value comes from. For an agent with no effort option (Grok, Antigravity, Hermes, Local) it is grey and does nothing.

Right-clicking a chat in the chat list opens a small menu with **Rename...**, **Project...**, **Agent**, **Clear Messages** and **Delete** (right-click again to close it); the trash can on the row deletes the chat too. Delete and Clear Messages ask first, in a dialog with **Delete** (or **Clear**) and **Cancel**. **Project...** sets the project folder this chat's agent works in (same as `/wowgpt cd` below), **Agent** lists the agents the companion app has, with the chat's own checked (same as `/wowgpt -c --agent`; before the companion app has listed them it is **Agent...**, a text prompt). The advanced plugin binding is `/wowgpt config plugin`; each chat keeps its own, so you can have a general chat next to chats on different projects, with different agents, side by side. The window's header shows the chat's project.

`/wowgpt` works like the `claude` command in a terminal: a message starts a new chat, `-c` continues the current one, `-r` resumes a session, and the same flags set the model, the effort and the rest for that chat.

| In game | Like | What it does |
|---|---|---|
| `/wowgpt <text>` | `claude "<text>"` | start a new chat and send `<text>` there, straight from the normal chat box; the new chat gets a tab of its own. There is no chat limit. Bare `/wowgpt` opens the workspace window on the current chat; `/wowgpt new` starts an empty chat |
| `/wowgpt -c <text>` | `claude -c` | continue the current chat (`--continue`); alone it opens the window on it |
| `/wowgpt -r <id\|name\|n> [text]` | `claude -r` | resume a session (`--resume`). A Claude Code session that is running in a terminal with the wowgpt channel gets the chat live; any other session (one of your chats, or a Claude Code session from its history) is resumed headless with `claude -p --resume <id>` in its own folder. Names match chat and session names, ids match by prefix; a prefix two sessions share lists both |
| `/wowgpt -r` | `/resume` | list the running and recent sessions (id, name, folder, age) in the window and the game chat; click one, or `/wowgpt -r <n>` |
| `/wowgpt -n <name> [text]` | `claude -n` | name the new chat; with `-c` it renames the current one |
| `/wowgpt --model <model> [text]` | `claude --model` | the model for the chat (`opus`, `sonnet`, a full model name) |
| `/wowgpt --effort <level> [text]` | `claude --effort` | `low`, `medium`, `high`, `xhigh` or `max` |
| `/wowgpt --permission-mode <mode> [text]` | `claude --permission-mode` | `acceptEdits`, `plan`, `manual` or `default`; `auto`, `dontAsk` and `bypassPermissions` only when `gamePermissionModes` in `config.json` lists them ([CONFIGURATION.md](docs/CONFIGURATION.md#permission-grants-from-the-game)) |
| `/wowgpt --add-dir <path> [text]` | `claude --add-dir` | one more folder the agent may use; repeat it for more |
| `/wowgpt --agent <name> [text]` | | which CLI runs the chat: `claude`, `codex`, `grok`, `agy`, `hermes` or `local` (a model on your own PC, see [docs/CONFIGURATION.md](docs/CONFIGURATION.md#the-local-agent)). A chat that changes agent starts a fresh session with it |
| `/wowgpt config [key] [value]` | `claude config` | the addon's settings (below); alone it lists them with their values, `/wowgpt config all` adds the troubleshooting keys |

Flags come before the text and combine: `/wowgpt --model opus fix the build` starts a new chat on Opus with that message, and `/wowgpt -c --effort high` changes the current chat. `--flag=value` and `"quoted values"` work, a value of `-` (or `default`) clears a setting, and a flag with no value shows it. The settings stay with the chat and go to the agent on every message; each agent gets them in its own spelling (Codex `-m`, `-c model_reasoning_effort=`, `--add-dir`; Grok `-m`), and when an agent has no such option the reply says so and the run goes on without it. A message that starts with something that only looks like a flag (`/wowgpt --verbose output is too long, why?`) is a message.

The client's own commands, with the same rule: a command word followed by something it does not take is a message for a new chat, so `/wowgpt delete the unused imports` is a message.

| Command | What it does |
|---|---|
| `/wowgpt cd <folder>` | the project this chat's agent works in, which makes it a coding session there (**Project...** after right-clicking the chat opens the same thing as a dialog). Relative to the companion app's folder (`/wowgpt cd realms`, `/wowgpt cd ../other`), `~` works, a full path too; `/wowgpt cd` alone goes back to general chat in the companion app's default. A chat that changes folder starts a fresh session there |
| `/wowgpt look <question>` | one message to the current chat with a picture of your screen, whatever the vision setting |
| `/wowgpt rename [name]`, `/wowgpt delete`, `/wowgpt clear` | manage the current chat |
| `/wowgpt reset` | wipe this chat's agent memory, keep the transcript |
| `/wowgpt cancel` | stop waiting on this chat's reply |
| `/wowgpt mcp [on\|off <name>\|none\|default]` | the MCP servers this chat's Claude or Codex runs get: your own Claude servers, plugins and claude.ai connectors, your Codex servers, and `mcp.servers`, each with its health. All are on unless the chat turns them off; the **MCP** button in the chat header does the same with checkboxes |
| `/wowgpt -r all` | one chat per session handed off with `wowgpt handoff --stop` in a terminal, each resuming its session headless ([docs/IN-GAME-DEV.md](docs/IN-GAME-DEV.md)) |
| `/wowgpt dev <command>` | dev tools for the chat's folder, run by the bridge without an agent: `status`, `diff`, `log`, `run`, `test`, `doctor`, `errors`, `feedback` ([docs/IN-GAME-DEV.md](docs/IN-GAME-DEV.md)) |
| `/wowgpt wrong [#n] [note]`, `/wowgpt bug <text>`, `/wowgpt errors` | mark a reply as wrong, file a bug with the addon's Lua errors, list the Lua errors the addon caught |
| `/wowgpt resend` | show the strip again if the bridge missed it |
| `/wowgpt reload` | reload the UI now (also frees the slot pool) |
| `/wowgpt diag`, `/wowgpt slots` | transport diagnostics |
| `/wowgpt hide`, `/wowgpt mini` | close the window (the X button, Esc and the key binding do the same); `mini` is kept as another name for it |
| `/wowgpt dm [next]`, `/wowgpt map [command]`, `/wowgpt stream [command]` | the same as `/dm`, `/aimap` and `/stream`; only their own words are commands (`/wowgpt dm next`, `/wowgpt map ore on`, `/wowgpt stream brb`), so `/wowgpt map out a route` is a message |
| `/wowgpt help` | opens the Commands and tips page, under WoWGPT in the game's AddOns settings (the gear menu in the window opens it too) |
| `/r <text>` | replies to the chat that answered last, with the game's own `To Claude [chat]:` header; once a real player whispers you, `/r` answers them, until the next reply |
| `/w <agent> <text>` | sends to that agent's chat when whisper tabs are on |

Settings, with `/wowgpt config <key> [value]`. The everyday ones are also on the **WoWGPT** page in the game's settings (AddOns, WoWGPT; **Commands and tips** sits under it): whisper tabs, window dimming, dodge and auto-hide, the minimap button, game chat echo, voice lines, death roasts, the roll window, achievement toasts, the Orders card, sharing game state, and ore and herb nodes. Each control calls the same handler as its `/wowgpt config` key, so both always agree. The troubleshooting keys (`signal`, `mode`, `auto`, `longchat`, `plugin`, `probe`, `diag`) are left off that page and out of the plain `/wowgpt config` list; `/wowgpt config all` shows them.

| Key | What it does |
|---|---|
| `ui [setting]` | the tabs and the window, alone it lists them: `ui whisper on\|off` (off by default; the same as `whisper on\|off`), `ui dim <10-100>\|off` (how far the window dims while you move or fight, 35 by default), `ui dodge on\|off` (step aside for Blizzard panels, on), `ui autohide on\|off` (step away while the maximized map, the game menu or the settings are up, on), `ui reset` (this character's window size back to the default). `ui list`, `ui remove <name>` and `ui run <name>` manage [Live UI widgets](#live-ui-widgets) |
| `whisper on\|off` | each chat as a native whisper tab in the chat dock (off by default; an install where you had turned it on keeps it on): replies arrive there as whispers and flash the tab, what you type there goes to the agent, never to the server, and slash commands typed there (`/wowgpt ...`, `/cast ...`) run as usual, so `/wowgpt -c ...` in a tab continues that tab's chat. Off, replies go to the window and the game chat |
| `minimap on\|off` | the minimap button (on by default): left-click opens or closes the window, right-click opens the Options page, drag it to move it around the minimap. Its place is saved for every character. Off hides it until you turn it on again |
| `context [on\|off]` | show what the agent is told about your character and location, or turn it on/off. Bare, it first prints this chat's context growth: the tokens your next message re-reads, the turns in the session, how long it has run and what it comes to at API list prices |
| `context <n>` | warn once, with a **New chat** button, when a chat's context passes `n` tokens (`300k` by default, `0` = never). Every message resumes the chat's agent session, so its context only grows and each reply costs more than the last; bare `/wowgpt config context` prints it like Claude Code's own status line (`11m 58s · ↓ 106.9k tokens · ≈$2.41 API`: time since the session started, the context, the session at API list prices, a comparison and not a bill), `/wowgpt diag` lists it per chat, and the minimap button's tooltip shows the estimated API cost |
| `vision [on\|off]` | send a picture of your screen with each message, so the agent sees what you see: "what is this item?", "why is this boss killing me?", "read this quest" (off by default; needs the screenshot transport) |
| `roast [on\|off]` | when you die, the agent gets a recap of what killed you and writes a short roast in the **Death roasts** chat (off by default; at most one every 2 minutes). See [Death roast](#death-roast) |
| `achievements [on\|off\|test]` | list the achievements your agents earned; `on`/`off` turns the toasts on or off, `test` shows a sample (see [Achievement toasts](#achievement-toasts)) |
| `orders [on\|off]` | the Orders card under the quest tracker: the current order from a live Claude Code session and up to 3 goal bars (on by default; also `/wowgpt orders` and the chat list's gear menu). It hides when there is no order |
| `telemetry [on\|off]` | share game state with the agent: money, level, zone, professions, watched items, gear and reputation, plus prices and loot from windows you open (on by default; see [docs/CONFIGURATION.md](docs/CONFIGURATION.md)) |
| `echo summary\|full\|short\|off\|<chars>` | how much of each reply to print into the game chat. `summary` (the default) prints only the agent's closing TL;DR lines, the full reply is in the window behind `[open]`; `full` prints up to 4000 chars, `short` one preview line |
| `voice ...`, `map ...`, `macro undo`, `roll on\|off` | see [Voice lines](#voice-lines), [Map](#map-routes-and-gathering-nodes), [Macros](#macros-ready-to-use) and [Need, Greed or Pass](#need-greed-or-pass) |
| `longchat on` | let the game chat box take 4000 characters, for long `/wowgpt` messages |
| `bind <key>` | hotkey: checks for a reply while waiting, otherwise toggles the window (the **WoWGPT: open or close the workspace** binding in Key Bindings > AddOns does the toggle alone) |
| `mode reload` | fallback transport that costs a `/reload` per step, if pixels or slots can't work |
| `signal on\|off`, `auto on\|off\|<seconds>` | the sound-file readiness check, and the reload-mode auto refresh |
| `plugin <name>\|default` | advanced: pin the chat to `ask`, `claude-code` or `live` by hand |

Click any message, or `/wowgpt copy` for the last reply, to open it in a selectable box for Ctrl+C. Click a web link in a reply to open it in your browser (the bridge opens only links the agent wrote in that chat, and a link it refuses opens the copy box with the reason); right-click, Ctrl-click or Shift-click it to copy it instead.

### Short in the chat, full in the window

Every run tells the agent that only a short summary of its reply is printed in the game chat, and asks it to end each reply with a `TL;DR:` block of one or two lines. The bridge splits that block off. In the chat's tab, a reply of up to 8 lines and 700 characters shows whole; a longer one shows just those TL;DR lines with a **[full reply]** link to the workspace window. The window hides the last line that starts with a TL;DR marker and everything after it, because that block repeats the reply. It does so only when that block is at most 3 lines and 400 characters and is not inside a code fence (``` or ~~~). When the addon knows the summary the bridge split off, the block must also match it; chats restored from the bridge and older messages have no stored summary and use the marker rule alone. Clicking the message opens the copy box with the whole text, TL;DR included. With the tabs off, the addon prints the TL;DR under `[Claude · chat]` with `[open]`. When an agent forgets the block, the first two lines of the reply are shown instead, with a hint to open the rest. `/wowgpt config echo full` goes back to showing the whole reply in both places.

### The agent knows where you are

The addon tells the agent which game and client you are on, your character (name, realm, level, race, class, faction, guild), where you are (zone, subzone and the map coordinates the minimap shows), your money, talents, professions with their skill, and your quest log (quest ids, marking the ones ready to turn in). With the Polestar guide addon on Forever, it also sends the guide you follow, its live step and that step's open goals as ids. A few lines, sent with the addon's hello and again whenever they change, and put at the top of every message by the bridge as a marked situation block (the rules for reading it, and the addon primer, go in the agent's system prompt, which stays the same for the life of a chat so it is cached and, with Claude Code, recorded once), so you can ask "what should I be doing at my level around here?" or "write me a macro for my class" without explaining yourself first. It is only a hint: for a chat about an unrelated project it changes nothing. `/wowgpt config context` shows exactly what is sent; `/wowgpt config context off` stops sending it (the bridge forgets it too), and `"gameContext": false` in `~/.wowgpt/config.json` turns it off for good. It is on only when you agreed at setup: see [Privacy](#privacy-what-leaves-your-machine).

Along with it, every run gets [docs/WOW-ADDON-PRIMER.md](docs/WOW-ADDON-PRIMER.md): a short reference on writing addons and macros for this client (TOC layout, sandbox rules, common frames and events, where to verify an API), so "write me an addon that..." works from any folder, not just this repo. Edit the file to suit your setup; the bridge re-reads it on every run. `"primerFile": ""` in the config drops it, and `/wowgpt config context off` turns it off together with the character context.

### Link items, spells and quests

Click the input box, then **shift-click** an item in your bags, a spell in the spellbook, a quest in the log, or a link in the chat: it lands in your message the way it would in the game chat. When you send, each link becomes `[Name]` in the text and its tooltip (an item's stats, a spell's description) is attached below, so the agent sees what you see when hovering it. This works from the game chat box too (`/wowgpt is this an upgrade? [Fine Longsword]`). Without a box focused, shift-click keeps its normal meaning.

### The agent sees your screen

On the screenshot transport (`capture.mode: "screenshot"`) the game already takes a screenshot of the whole screen for every message you send; the strip is only its top-left corner. `/wowgpt config vision on` tells the bridge to keep the rest: it crops the strip's rows off, scales the frame down (1280 pixels wide by default, 1-2 MB as PNG) and attaches it to the agent's message as an image, with a paragraph at the top of the message saying an image of your screen is attached and what it is (only when one is). So "what is this item, should I equip it?", "why does this boss keep killing me?" or "read me this quest text" are answered from what is actually on your screen, tooltips and open windows included. `/wowgpt look <question>` does it for one message with the setting off. Off by default; the window's footer and `/wowgpt diag` show the state. Claude Code gets the pixels inline (an `image` block in a stream-json user message, no tool call); Codex, Grok and Hermes get the PNG's path in `~/.wowgpt/tmp`, where it is deleted after the run. With it off nothing changes, and the pixel transport never sees more than the strip.

### Death roast

`/wowgpt config roast on` (off by default) turns your deaths into content. When you die, the addon reads the game's own death recap (the list behind the **Death Recap** button: who hit you, with what, how much, overkill, absorbs, the killing blow), adds your level, zone and the attackers' levels when it can see them, and sends that recap to the agent in a **Death roasts** chat of its own. The reply is a two or three sentence roast, affectionate and aimed at the play, never the person, and it lands in the window and the game chat like any other reply. With vision on, the agent also sees your screen at the moment of death.

- At most one roast every 2 minutes, so a wipe does not spam the agent. A death while the last roast is still being written, or while the bridge is not connected, is skipped.
- The recap stays under 900 bytes, so it fits the strip with the game context next to it.
- Addons may not read the combat log in this client (registering it pops "blocked from an action only available to the Blizzard UI"), so the roast never touches it. When the game has no death recap to share, the addon falls back to the hits you took in the last 10 seconds as `UNIT_COMBAT` reports them: amount, school and crit, but not who dealt them. It then names your target and mouseover at death instead. The death recap itself holds only the last few hits, not the whole fight.
- The roast listens for deaths and hits only while it is on: `on` registers `PLAYER_DEAD` and the player's `UNIT_COMBAT`, `off` unregisters them.
- The chat is bound to the bridge's `roast` plugin and runs in the same scratch folder as `ask` (`plugins.roast.cwd` to change it). Type in that chat to talk back.
- `/wowgpt config roast` shows the state, the cooldown, and why the last death was not roasted.
- Streaming: each roast is also sent to the stream overlay (`plugins.stream.url`, `/control`, action `roast`) with the TL;DR line and, when the death recap names them, the killer, the ability, the overkill and the zone. The bridge shows the TL;DR line only when every word, in any letter case, is a number, a word from the recap or a plain word from `bridge/order-words.json` or `bridge/roast-words.json` (about 3,600 everyday English words with game words left out), using only `A-Z a-z 0-9`, space and `, . ' ’ ‘ - : ! ? % ( ) " ;`; braces are refused, so the line carries no reference tokens. A run of 2 to 4 words within one clause that is an area, map, flight path or skill name in the synced game data, a spell a spell-book item teaches, or in `bridge/game-phrases.json` is refused unless the recap has it; ability and NPC names missing from that list can still get through, because the phrase check does not use spell names yet and the client data has no NPC names. A typed line that does not start with `Death recap:` makes no card; one that does is treated as a recap, so its words count as recap names. A dropped line is logged with the reason, and the card goes out without it. `plugins.stream.enabled: false` turns it off with the rest of stream control.

### Transports

How a message leaves the game. The bridge listens on one of two, named in `capture.mode` in `~/.wowgpt/config.json` and told to the addon in every slot file:

- **`screenshot`, the default.** The addon draws the strip, waits two frames and calls `Screenshot()`; the bridge decodes the PNG the client writes to its `Screenshots` folder and deletes it. No screen capture, no Screen Recording or Automation permission, no window discovery, no python; works on Retina displays, under Wayland, and from a background service. Verified end to end on macOS.
- **Chat log, optional, on top of `screenshot`** (`capture.chatLog.enabled`, off by default). The addon writes the message into the client's own `Logs/WoWChatLog.txt` as hidden local system lines, and the bridge reads the file: no strip and no screenshot on the first try. If no ack comes in 8 s the message goes again by screenshot, so nothing is lost when it cannot work. It pads each message with about 50 KB so the client's write buffer reaches disk, keeps chat logging on while you play, and removes its own lines from the log when the game is closed (macOS). Verified end to end on macOS with the Forever client. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-chat-log-transport-experimental).
- **`pixel`, deprecated.** `capture.ps1` (Windows), `capture_mac.py` (macOS) or `capture_x11.py` (Linux) screen-captures the strip four times a second. It exists only until `Screenshot()` is confirmed on Windows and on Linux under Wine, and will be removed then. It needs python3 off Windows, the two permissions on macOS, and an X11 session on Linux.

A new install starts on `screenshot`; an existing `config.json` with an explicit `mode` keeps it. **If the screenshot transport cannot work on your client, the bridge falls back on its own:** when the addon reports that the client has no `Screenshot()` function, or that every shot failed (`SCREENSHOT_FAILED`), the bridge switches to the pixel capture, says so in its log and terminal (`TRANSPORT FALLBACK: ...`), remembers it in `state.json` so the next start goes straight to pixels, and names the reason in its slot files, where `/wowgpt diag` in game shows it as `transport: pixel (bridge: pixel transport, fallen back to since ... because ...)`. The addon says once in the game chat that the report is on its way; the first time, that report reaches the bridge through the reload fallback (a couple of minutes), because a bridge waiting for screenshots is not watching the screen. To settle it for good, set `capture.mode` to `"pixel"` (no more note) or `"screenshot"` (try again; an explicit value always wins over the memory). Nobody is left without a transport.

### Achievement toasts

Dev milestones pop an achievement-style toast in game: a gold banner with an icon, a title, points and the achievement sound. The bridge watches the shell commands the agent runs and their results (Claude Code and Codex), so every award is a fact, not a guess:

| Achievement | When |
|---|---|
| Hello, World / Questing Buddy / Loremaster of the Repo | 1, 10 and 100 finished tasks |
| Back From the Dead | the tests pass after failing (npm, yarn, pnpm, bun, jest, vitest, pytest, go, cargo, `node --test` and more); every time it happens |
| Signed and Sealed / Commit Streak / Centurion | 1, 10 and 100 git commits by the agent |
| Ship It / Frequent Flyer | 1 and 10 pushes |
| Merged on a Friday | a commit or push on a Friday |
| Night Owl | a task finished after midnight (before 5 a.m.) |
| It Works On My Machine | a push in a run that never ran the tests |
| Rubber Duck | 50 messages in one chat |
| Leeroy Jenkins | the agent ran a command with `--force` (or `git push -f`) |

Each one-time award is given once and kept in the bridge's `state.json`, so it survives restarts and the beta's saved-data wipes. `/wowgpt config achievements` lists what you earned; `/wowgpt config achievements off` (or `toasts off`) keeps them quiet; `/wowgpt config achievements test` shows a sample toast. `"achievements": false` in `~/.wowgpt/config.json` turns the detection off. The banner uses client textures and plays the sound by its FileDataID; no Blizzard asset ships with the addon.

### Macros, ready to use

Ask for a macro (*"a Charge macro that uses Intercept in combat"*, *"a mouseover heal"*) and the reply comes with a **Create Macro: <name>** button under it. A click saves it (an account macro, or a character one if the agent says so) and puts it on your cursor: click an action bar slot to place it. It is also in `/macro` as usual.

- A macro with that name already there? The button says **Update**, and it asks before replacing a different one of yours. `/wowgpt config macro undo` brings back what was there (or removes the macro the button created).
- Macros that run code (`/run`, `/script`, `/click`) are marked on the button and ask before being saved.
- Nothing is saved in combat, and the addon never runs a macro: only your own click on the bar does.

The agent writes each macro in a ```` ```wowmacro <Name> ```` block (optional `icon=` and `scope=character` after the name); the bridge checks the game's limits (name up to 16 characters, text up to 255 bytes) and keeps a readable copy in the reply. The buttons live with the message in the addon's saved data, so they don't come back after the beta wipes it (the macro text does).

### Map, routes and gathering nodes

The agent can draw on your world map. Ask *"route me through copper and tin around here"*, *"plan the quests I can do in Westfall"* or *"where is the nearest mining trainer?"*, and the answer arrives with:

- **Layers on the world map:** numbered pins joined by lines for routes, and pins for quest givers, objectives, turn-ins, trainers, dungeon entrances or any mark. They show on the zone map and on the continent map; hover a pin for its label, click it to navigate there.
- **A navigator:** a small frame with an arrow and the distance in yards to the current stop. It starts as soon as a route on your continent arrives (unless you are already following one), advances when you get within 12 yards, and loops on farming circuits. Drag it to move it; right-click skips a stop.
- **Herb and ore spawns:** with an optional `WoWGPT_Nodes` data addon installed, every gathering spawn point of the zone you are looking at, filtered to what your skill can gather.

The system prompt tells every agent how to hand marks to the bridge: append commands to the file named in `WOWGPT_MAP_FILE` (set for every run), or end the reply with a small ```` ```wowmap ```` block. The bridge validates the marks, keeps them in `state.json` and ships them to the game, so they survive a UI reload and the beta's saved-data wipes. Where the agent gets its coordinates from is up to the folder the chat works in: [docs/MAP.md](docs/MAP.md) describes the command format and how to feed it game data.

| Command | What it does |
|---|---|
| `/wowgpt config map` | list the layers, navigation and node settings |
| `/wowgpt config map ore [on\|off]`, `/wowgpt config map herb [on\|off]` | show or hide mining / herbalism spawns on the world map |
| `/wowgpt config map filter all\|skill` | every spawn, or only what your skill can gather (default) |
| `/wowgpt config map hide <layer>`, `/wowgpt config map show <layer>` | hide or show one of the agent's layers |
| `/wowgpt config map nav <layer> [n]`, `next`, `prev`, `stop` | drive the navigator |

`/aimap` and `/wowgpt map` do the same. To remove layers for good, ask the agent ("clear the map", "remove the mining route").

### Voice lines

Your character talks back when the agent answers. By default the lines are your own race and gender's emote and error voices: a *cheer* when the reply lands, the "can't use that item" error voice when a run fails, and the "ability not ready yet" error voice when a reply waits on **Allow & retry**. Sending a message and the companion app picking it up play nothing by default; `/wowgpt config voice set sent yes` or `set started hello` turns one on. Two other packs swap in the Warcraft III workers: `peasant` (*"More work?"*) and `peon` (*"Work complete"*). Lines closer than 2 seconds apart are dropped, except that a reply cuts off an ack.

Nothing is shipped: the addon plays sounds the game client already has, by FileDataID. The WoW client has no *"Job's done!"* recording, so the peasant's done line is *"More work?"*.

| Command | What it does |
|---|---|
| `/wowgpt config voice` | show the pack and the line for each event (`sent`, `started`, `done`, `error`, `permission`) |
| `/wowgpt config voice race\|peasant\|peon\|off` | pick the pack; `race` follows the character you are logged in on |
| `/wowgpt config voice set <event> <line>` | override one event: a line of the current pack (`cheer`), of a named pack (`peon:workcomplete`), `off`, or `default` |
| `/wowgpt config voice lines [pack]` | the line names a pack has |
| `/wowgpt config voice test <event\|line>` | play it now |
| `/wowgpt config voice reset` | back to the race pack with no overrides |

The settings are saved with the addon's other settings (`WoWGPTDB.voice`).

### Live UI widgets

Ask for a small UI element (*"give me a DPS meter"*, *"a timer bar for my buffs"*) and, once you turned widgets on, it shows up in the game a moment later, without `/reload`. The agent writes addon Lua in a ```` ```wowui <name> ```` block (or appends it to the file in `WOWGPT_UI_FILE`). The bridge refuses anything that names a protected or outward action (casting, targeting, movement, chat, macros, bindings, secure templates), keeps the rest versioned in `state.json` and ships it in the slot files, like map layers. The addon runs each widget in its own sandbox inside a `pcall`: the widget sees only an allowlist of display APIs, through wrapped frames, and no Blizzard frame. An error stops the widget and shows up in the chat window.

| Command | What it does |
|---|---|
| `/wowgpt config ui` | list the widgets and their state (running, waiting for your OK, removed, failed) |
| `/wowgpt config ui remove <name>` | stop a widget and keep it off after login, until the agent sends a new version |
| `/wowgpt config ui run <name>` | start a widget again, or say yes to one that waits |
| `/wowgpt config ui widgets on\|off` | let widgets run at all; they are off until you turn them on |

**Widgets are off by default, and turning them on is a risk you choose.** A widget is Lua code that the agent writes and your game runs. The sandbox blocks the dangerous game functions it knows about, but a sandbox can have holes, and the code comes from an AI model that can be wrong or can be tricked by text it read (a web page, a file, a message). A widget could show you false information, slow the game down or spam errors. Turn widgets on only if you accept that, and read a widget's code (in the agent's reply, or in `~/.wowgpt/state.json`) before you say yes to it. A player who said yes to a widget before this switch existed keeps widgets on.

A widget runs only after you say yes. Each new widget, and each new version of one, opens a popup, one at a time: "Show the agent's '<title>' widget?" with **Show** and **Not Now**. **Show** runs it and remembers that version; **Not Now** keeps it off until the agent sends a new version; Escape asks again at the next login. The **Widgets** page in the game's AddOns settings lists them with **Remove** and **Show** buttons. Widgets you said yes to start again at login. The contract, the allowlist, what a widget cannot do and the limits are in [docs/UI-WIDGETS.md](docs/UI-WIDGETS.md). `/wowgpt dev globals` and `npm run audit:widgets` check the allowlist against your client.

### Permissions

The agents run headless, so they can't ask you to approve a tool. Each agent's block in `~/.wowgpt/config.json` has a `permissionMode`, `acceptEdits` by default: file edits inside the project are auto-approved, `allowedTools` lists the commands it may run (`Bash(git:*)` is any command starting with `git`; the same rule syntax for every agent, translated for Grok), and `deniedTools` the ones it never may. What happens to anything else differs. Claude denies it. Codex has no allowlist: it runs commands in a sandbox that can write the project folder but not reach the network (unless `networkAccess` is on), and explains a blocked command in its reply. Grok's headless mode runs ordinary commands on its own and blocks the dangerous ones (deleting a project file, pushing) unless a rule allows them. With Claude and Grok the reply then grows an **Allow WebSearch, Bash(cargo:*) & retry** button: click it and a dialog shows the rules and what they cover; **Always Allow** keeps them for that agent in the bridge's `state.json` (never in `config.json`) and the agent resumes where it stopped, **Cancel** changes nothing. The rule is a prefix (`Bash(rm:*)` allows any `rm`), so read the dialog before you accept. `bypassPermissions` gives any agent full autonomy; you decide. The mapping per agent, as measured against the real CLIs, is in [docs/AGENTS.md](docs/AGENTS.md).

#### Need, Greed or Pass

By default a denial does not show that button. It pops a frame in the style of the group loot roll instead, headed **WoWGPT asks**. The denied command is the item, in epic purple: a scroll for a shell command, a gear for any other tool. Under the item the frame lists each rule, the command the agent tried (when the companion app quoted it) and what each choice grants. Hover it for the full text.

| Button | What it does |
|---|---|
| **Greed** (coin, the first button) | Allow for this one retry only: the companion app passes the rules to that run and saves nothing |
| **Need** (dice) | Always allow: a dialog asks first, then the bridge keeps the rules for that agent (in `state.json`) and the agent retries. Cancel puts the roll back |
| **Pass** (X) | Deny: nothing is sent, the agent is not retried |

Only a mouse click answers the roll; no key does. The buttons wake up half a second after the frame shows, so a click meant for something else does not answer it. In a chat attached to a running terminal session the roll shows Greed and Pass only, since nothing is saved there.

The roll never shows while you are in combat or while a real group loot roll is open. It waits, and one chat line says so ("A permission request is waiting until combat ends." or "... until the loot roll closes."). A roll that is up when combat starts or a loot roll opens hides and waits the same way. It comes back about a second after both are over, with a full timer. If the chat's agent, plugin or rules changed while it waited, it comes back with the new ones, and Greed never allows what the frame no longer shows.

Claude Code also blocks a command that touches a path outside the chat's folder, and no allow rule can change that. That denial rolls for the folder instead, as **Scroll of /tmp**: Need adds the folder to the chat for good (what `/wowgpt --add-dir /tmp` does), Greed adds it for the retry only. When a retry is blocked again for something it was just granted, the reply says so in one line and no new roll comes up.

The bar under the item counts down 60 seconds from when the frame shows. When it runs out, that is a Pass; it never allows. The count stops while the Need dialog is open or the roll waits. Each choice plays the game's own loot sounds. `/wowgpt config roll off` brings back the **Allow & retry** button (it asks first, like Need), and `/wowgpt config roll on` returns to the roll frame.

## Privacy: what leaves your machine

Your messages and the agent's replies go to the agent you picked (for example Claude Code to Anthropic, Codex to OpenAI), as with any use of that agent. Beyond that, the companion app talks to the internet only here:

| What | Where it goes | When |
|---|---|---|
| Your game state: character, realm, zone and position, quests, money, bags, professions, equipped items, deaths, and vendor, auction and loot windows you opened | The agent provider, inside each message and through the goal tools | **Only when you agreed.** Setup asks once: "Share your game state with the agent?" The answer is no unless you type yes, and a setup with no terminal (a script, CI) answers no. |
| The update check | `api.github.com` (and `github.com` for the download) | Once a day. `"autoUpdate": false` turns it off. |
| Game data sync: the client's map, item, spell and quest tables | `wago.tools` and `raw.githubusercontent.com` | When the game reports a client build the app has no data for. `"data": { "autoSync": false }` turns it off. |
| Discord sync | `discord.com` | Only when you set it up. Off by default. |

To change your answer later, run `wowgpt setup --share-game-state yes` (or `no`), or set `"gameContext"` and `"telemetry": { "enabled": ... }` in `~/.wowgpt/config.json`, then restart the companion app. A `config.json` made before this question existed keeps sharing, as it did before.

With sharing off, the addon still sends its game context to the companion app on your computer, which keeps it in `state.json` there. The companion app does not put it in any message, and the goal, order and campaign features see no character, so they stay idle. It does not ask the addon for the rest of the game state at all. `/wowgpt config context off` in game also stops the addon from sending the context.

## Configuration (`~/.wowgpt/config.json`)

The keys you are most likely to touch. Every key, flag and environment variable is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

| Key | Meaning |
|---|---|
| `defaultCwd` | folder for chats that haven't been given one with `/wowgpt cd` |
| `agent` | the agent for chats that haven't picked one with `/wowgpt -c --agent` (`claude`, `codex`, `grok`, `agy`, `hermes` or `local`) |
| `claudeDir`, `claudeSessions` | where Claude Code keeps its sessions for `/wowgpt -r` (default `$CLAUDE_CONFIG_DIR`, else `~/.claude`), and `false` to list only the bridge's own chats and the running sessions |
| `agents.<id>.permissionMode`, `.allowedTools`, `.deniedTools`, `.model` | that agent's permissions, allowlist, denylist and model; `.path` where its executable is if the bridge can't find it, `.extraArgs` anything else to pass it |
| `mcp` | your own MCP servers for Claude chat runs, each with an `allow` list of tools, `allow` lists for the servers the bridge discovers, and `strict` (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md#your-own-mcp-servers)); absent = Claude's own servers as before |
| `agents.codex.networkAccess` | let Codex's sandbox reach the network (default `false`) |
| `maxParallel` | how many chats may run an agent at once (default 3) |
| `gameContext` | `false` never tells the agent about your character, whatever the addon sends (default `true`) |
| `primerFile` | the addon/macro primer appended with the context (default `docs/WOW-ADDON-PRIMER.md`; `""` = none) |
| `capture.processName` | the game exe without `.exe`, or the app name on macOS (`WowB` for Forever, `World of Warcraft Classic` for Classic Era on macOS); `setup.js` sets it on each entry of `clients` (`clients[].processName`), and this key is the default for an entry without one |
| `capture.mode` | `screenshot` (default: the addon calls `Screenshot()`; the bridge reads the file from the client's `Screenshots` folder) or `pixel` (deprecated screen capture; see [Transports](#transports)) |
| `vision.maxWidth`, `vision.keep` | screenshot mode: how wide the picture of your screen is scaled to before it goes to the agent (default 1280), and how many may wait in `~/.wowgpt/tmp` at once (default 6) |
| `capture.keepComposited`, `capture.windowName` | Linux: keep the compositor drawing the game window (if the probe sees black), or find the window by title |
| `slots`, `actMax`, `presenceMax` | pool sizes; must match the constants at the top of `Transport/Signals.lua` if you change them |
| `timeoutMs` | kill a run that takes longer than this (default 30 min) |
| `killGraceMs` | how long a run's process group gets after `SIGTERM` before `SIGKILL`, on a timeout or when the bridge stops (default 5 s) |

## Troubleshooting

### Install and update problems

- **Battle.net says the game is not playable: "Permissions check failure (2113)" (macOS, Linux).** Battle.net checks the file modes in the game folder. The game installs every file and folder as `0777`, and a file with another mode (for example `0644`) under `Interface/AddOns` makes the check fail. Run `wowgpt setup --wow "<client folder>"` again: it sets every file and folder under `WoWGPT`, `WoWGPT_Runtime` and `WoWGPT_S001` … `WoWGPT_S200` to `0777` and prints how many it changed (`permissions: N of M file(s) and folder(s) ...`). The bridge writes its own files as `0777` already. Other addon folders are not changed; if the error stays, look for another addon whose files are not `0777`. From a checkout, `npm run doctor` warns about a file that is not world-writable.
- **The addon is not in the AddOns list, or `/wowgpt diag` says `no presence file existed when the game started: run setup, then restart WoW`.** The game builds its addon list when it starts. A new addon folder (the first install, `WoWGPT_Runtime`, the slot folders) appears only after you fully quit and start the game again; `/reload` does not add a folder. Measured on Classic Era 1.15.9, in an addon folder the game already knows, `/reload` picks up a changed Lua file, a Lua file that was missing at launch, a new file added to the `.toc`, and a changed `## Version` (1 to 2). Textures and sounds added after launch are not checked, so restart for those. Forever is not checked. If setup or the addon says to restart, quit and start the game.
- **"This addon (…) is too old for the bridge (…)" or "The bridge (…) is too old for this addon (…)".** The addon and the bridge speak different protocol versions, so the bridge refuses every message until you update the side that the message names. The full text says how: for the addon, run `wowgpt setup --wow "<client folder>"`; for the bridge, run `brew upgrade wowgpt` or the installer again, then `wowgpt service restart`. Then reload or restart the game as the message says.
- **"This addon (…) is older than the bridge (…). They still work together; update the addon when you can."** Only the release numbers differ. Nothing is refused, and the addon says it once per session. The reverse message names the bridge. `/wowgpt diag` and `wowgpt service status` show both versions.
- **Classic Era: progress and replies arrive in steps, not at once.** On Classic Era a signal file that the bridge deletes still reads as present in the game, so the instant signals (the ack, "reply ready" and the 30-second heartbeat) do not work. The addon gets the ack, the progress text and the reply from its scheduled slot reads instead: 5, 10, 16, 24, 34, 46 and 60 s after you send, then further apart (every 60 s after 5 minutes). The action count comes only from the heartbeat files the bridge deletes, so on Classic Era the progress line shows the elapsed time and the agent's current step, but no action count. The bridge's ack reaches the game at the first read (about 5 s), the progress text changes at each read, and a reply can appear up to a minute after the agent finished on a long run. `/wowgpt diag` shows `presence: slot polls only (self-test failed: …)`. This is expected and nothing is broken; the status light then allows 12 minutes without news before it turns yellow.

### Connection and replies

- **The status says "Can't reach the bridge" / light stays red** — is the bridge running (`wowgpt service status`, or the terminal it runs in)? Is the game window on screen and not minimized? Exclusive fullscreen blocks capture. `bridge.log` shows `strip #N` when a message is decoded and `strip seen but rejected: ...` when one is misread.
- **Linux: `bridge.log` keeps saying `waiting for WowB window`** — the game isn't running or its window has another name: set `capture.processName` to the exe name, or `capture.windowName` to part of the window title. On Wayland the capture can't see other windows; use an X11 session.
- **Linux: `npm run probe` shows a black or stale picture** — the compositor is letting the game present on its own. Try `"keepComposited": true` under `capture`, then windowed mode, then `nvidia-settings -a AllowFlipping=0` on NVIDIA; `/wowgpt config mode reload` works without any capture.
- **No herb/ore pins after `/wowgpt config map ore`** — `/wowgpt config map` says whether the `WoWGPT_Nodes` data addon is installed; pins show on zone maps only, and with `filter skill` only what your skill can gather.
- **The reply says "X is not installed on the bridge PC"** — the bridge's banner shows where it looked for each agent. Install the CLI, or put the full path of its executable in `agents.<id>.path` in `~/.wowgpt/config.json` and restart the bridge.
- **A reply says the agent is not logged in, or asks for a login** — run the CLI once by hand on the bridge PC (`claude`, `codex`, or `grok login`) and log in; the bridge reuses that.
- **Reply never appears but `bridge.log` says `done`** — `/wowgpt slots`; if the pool is empty, `/wowgpt reload` frees it and picks the reply up via the fallback path.
- **"Reply slots not installed (run install-slots.js, restart WoW)"** or **"Reply slots do not load (…)"** — run `wowgpt setup --wow "<client folder>"` (or `wowgpt install-slots` for the slots alone; from a checkout, `node bridge/install-slots.js`), then fully quit and start WoW: the slot folders are new addon folders.
- **Chats vanished after a reload** — the beta client sometimes wipes addon saved data. The bridge keeps `transcripts.json` and sends your chats back automatically on the next message.
- **`/wowgpt diag` says the sound channel is unusable** — the cheap readiness checks and heartbeat are off; everything still works through slot polls, just with coarser progress. If it says a valid file reports as unplayable, WoW hasn't been restarted since the files were created.

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md): every install route (one-line installer, Homebrew, git), the background service, updating and uninstalling
- [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md): Windows notes and troubleshooting
- [docs/AGENTS.md](docs/AGENTS.md): each agent's install, how the bridge drives it, permissions per agent, limits, and how to add another
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every config key, command-line flag and environment variable
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pixel strip, slot pool and signal files work, and why
- [docs/INSTALL-LINUX.md](docs/INSTALL-LINUX.md): Linux + Wine notes, systemd, and how to check the screen capture
- [docs/MAP.md](docs/MAP.md): map layers, the navigator and herb/ore nodes
- [docs/UI-WIDGETS.md](docs/UI-WIDGETS.md): live UI widgets the agent writes, their contract, the display-only allowlist and how to audit it
- [CONTRIBUTING.md](CONTRIBUTING.md): repo layout, running the tests, conventions
- [CHANGELOG.md](CHANGELOG.md): release notes

## Development

```
npm install
npm test          # everything except the live test; CI runs it on Windows (.github/workflows/test.yml), and it runs on Linux and macOS too
npm run test:live # runs the bridge in a sandbox with a real agent call (add -- --agent codex or grok)
```

Layout: `addon/WoWGPT` is the addon (`Core/` the shared namespace and helpers every file reads first, `Transport/` the strip, screenshot, chat log, signal, slot and tick code, `Chat/` the game context, sending, replies and permission grants, `Whisper/` the whisper tabs, `UI/` the window, transcript, chat list, menus, minimap button, dialogs and markdown, `Chat/Options.lua` and `Chat/Sessions.lua` the chat options and the session picker, `Commands/` the command registry and the slash entry points, `WoWGPT.lua` the chats, macros and links, `Boot.lua` the login sequence, `Map.lua` the map layers, navigator and nodes), `bridge/` the companion (`bridge.js` does I/O and processes, `protocol.js` is the pure part, `agents.js` knows how to launch and read each agent, `capture.ps1` / `capture_x11.py` the screen capture per platform), `docs/` the design and reference, `tests/` the checks (`map_test.js` and `map_addon_test.js` cover the map protocol and `Map.lua` in a Lua VM). After editing the addon, copy it into the game folder (`node setup.js` does that too) and `/reload`. What each test covers, and the conventions for changes, are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

- [0xInuarashi's wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) measured the client's file-loading rules on a live Forever build (files must exist at launch; a not-yet-loaded file is read fresh on first use) and pioneered the pixel-out channel for Codex, with a font-metrics return channel. This project uses the same rules with load-on-demand addons instead of fonts.
- [Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source) — Blizzard's UI code, `forever` branch, used to verify every API this addon calls.
- [Questie](https://github.com/Questie/Questie) and [QuestieDB](https://github.com/Questie/QuestieDB) documented how Forever's maps work (Classic uiMapIDs, re-projected zones), which the map layer relies on.
- [wowsims](https://github.com/wowsims/classic) (MIT, Copyright (c) 2024 wowsims team): the Classic Era stat weights in `bridge/simweights.json`, generated by `dev/simweights.js` at a pinned commit, with the licence inside the file.
- [pfQuest](https://github.com/shagu/pfQuest) by Shagu (MIT): which zone each Classic Era spawn lies in, read by the community data sync on your machine.
- [Polestar](https://github.com/fitzforge/polestar) showed which open data sources work for these guides (pfQuest, wowsims) and how to check wowsims weights (the Season of Discovery carry-over and per-rating scale tests). No Polestar code or text is used.

## License

MIT — see [LICENSE](LICENSE).
