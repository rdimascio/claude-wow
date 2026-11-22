# Windows notes

The install itself is in [INSTALL.md](INSTALL.md): one line in PowerShell, or by hand with git. This page keeps what is specific to Windows: the prerequisites, what the `wowgpt` command is made of here, the PowerShell execution-policy trap, moving from wow-claude, and the Windows troubleshooting.

## Prerequisites

| Need | Check | Get it |
|---|---|---|
| Windows 10/11 on NTFS | | |
| World of Warcraft: Forever or World of Warcraft Classic (Classic Era), **windowed or borderless** | Options → Graphics → Display Mode | Exclusive fullscreen blocks screen capture, so the bridge can't see your messages |
| Nothing else with the installer: it fetches the `wowgpt` binary (Windows x64), which has its runtime inside | `wowgpt --version` after installing | The by-hand route below, and the installer where there is no binary yet, run the checkout and need Node.js 22.2 or newer (`node -v`): [nodejs.org](https://nodejs.org), the LTS installer, tick "Add to PATH" (default), or `winget install OpenJS.NodeJS.LTS` |
| Git (optional; only for a from-source install, and the installer downloads the archive without it) | `git --version` | [git-scm.com](https://git-scm.com/download/win) |
| At least one agent CLI, logged in (they work side by side) | | |
| · Claude Code | `claude --version` prints a version | [claude.com/claude-code](https://claude.com/claude-code), then run `claude` once and log in |
| · Codex | `codex --version` prints a version | `npm install -g @openai/codex`, then run `codex` once and log in |
| · Grok Build | `grok --version` prints a version | `irm https://x.ai/cli/install.ps1 \| iex` in PowerShell (or `npm install -g @xai-official/grok`), then `grok login`; needs a SuperGrok or X Premium+ subscription |
| · Antigravity | `agy --version` prints a version | Google's Antigravity CLI installer (the bridge also looks in `%LocalAppData%\agy\bin`), then run `agy` once and log in |
| · Hermes Agent | `hermes --version` prints a version | Hermes Agent installer, then `hermes setup` once |

Open a new terminal after installing Node or Git so the `PATH` change is picked up. Any terminal works: Windows Terminal, PowerShell, cmd, or Git Bash.

## Install

```powershell
irm https://raw.githubusercontent.com/rdimascio/claude-wow/main/install.ps1 | iex
```

Set `$env:WOWGPT_WOW` first if the client is somewhere setup will not look (it tries `Program Files (x86)\World of Warcraft\_classic_beta_` and a few other common places), and `$env:WOWGPT_PROJECT` for the default project folder. The installer downloads the `wowgpt.exe` binary from the project's GitHub release into `%LocalAppData%\Programs\wowgpt\bin` (checked against the release's `SHA256SUMS`; with `$env:WOWGPT_SOURCE = "1"`, or where there is no release yet, it installs the source there instead and runs it with Node.js, which it then checks for), adds that `bin` folder to your user `PATH` (no administrator rights), runs setup, and offers to start the bridge at login. Everything after that, including the service and updating, is in [INSTALL.md](INSTALL.md).

By hand instead (Node.js 22.2+ or Bun): `git clone https://github.com/rdimascio/claude-wow`, `cd claude-wow`, `node setup.js --project "C:\path\to\your\project"`, then `npm start`. `bridge\start-window.cmd` is the double-click version that opens its own window; `bridge\start.ps1` runs it in the current PowerShell.

## The `wowgpt` command on Windows

The installer writes `wowgpt.cmd` into `%LocalAppData%\Programs\wowgpt\bin`, which works from cmd and PowerShell whatever the execution policy. From a git clone, `npm link` in the repo does the same job through npm's global folder (`%AppData%\npm`); it creates three launchers (`wowgpt`, `wowgpt.cmd`, `wowgpt.ps1`) and PowerShell prefers the `.ps1` one, which a *Restricted* execution policy blocks. Either allow local scripts for your user:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

or type `wowgpt.cmd` instead. Don't use `npm install -g .`: that copies the files into npm's global folder, where there is no `config.json`, and the bridge refuses to start.

Like the agent CLIs, `wowgpt` works in the folder you start it from: `cd C:\path\to\realms` then `wowgpt` makes `realms` the default folder for every chat that hasn't chosen its own with `/wowgpt cd`. Only one bridge can run at a time.

## Starting at login

`wowgpt service install` puts `WoWGPT bridge.vbs` in your Startup folder (`shell:startup`), which starts the bridge with no window at every login; the supervisor restarts the bridge after a crash, and `wowgpt service status` / `logs` / `stop` / `start` manage it. The log is `%LocalAppData%\wowgpt\logs\bridge.log`, rotated at 5 MB. For a restart-on-crash guarantee for the supervisor process itself, use Task Scheduler instead, as described in [INSTALL.md](INSTALL.md#what-the-service-is-per-platform).

## Upgrading from claude-wow

Run the installer again. It installs `wowgpt.exe` in `%LocalAppData%\Programs\wowgpt` and takes the old `%LocalAppData%\Programs\claude-wow\bin` off your PATH. Its setup step copies `~\.claude-wow` to `~\.wowgpt`, `%LocalAppData%\claude-wow` to `%LocalAppData%\wowgpt`, and your saved chats to `WoWGPT.lua`, and removes the `ClaudeWoW` addon. `wowgpt service install` removes the old *Claude WoW bridge.vbs* launcher. Then restart the game and bind the workspace key again. The old folders are kept; delete them once WoWGPT works. See [Coming from claude-wow](INSTALL.md#coming-from-claude-wow).

## Upgrading from wow-ai (or wow-claude)

The project was called wow-ai, and wow-claude before that; the addon was `WoWAI` (`WoWClaude`), the command `wow-ai` and the slash command `/wow-ai` (`/ai`, `/wow-claude`). To move an existing install, run the installer again (or `git pull` and `node setup.js` in your clone). `setup.js` copies your chats and settings from `WoWAI.lua` (or `WoWClaude.lua`) to `WoWGPT.lua` in the game's SavedVariables with the globals renamed, removes the old addon and its 200 `WoWAI_S###` slot folders (two addons would both answer `/r`), rewrites the addon paths in `config.json` (and, from a wow-claude config, moves the Claude settings under `agents.claude`), then builds the new slot pool. The installer also copies `config.json`, `state.json` and `transcripts.json` from the old `%LocalAppData%\Programs\wow-ai\bridge` to `~\.wowgpt`, removes the old *WoW AI bridge.vbs* launcher and takes the old `bin` folder off your PATH. Quit and relaunch the game, and enable *WoWGPT* on the AddOns screen. Your agent sessions carry on, since the bridge keeps them per chat.

If you had installed the command with npm: `npm unlink -g wow-ai`, and `npm link` again from the repo folder. A hotkey set with `/wow-ai bind` needs `/wowgpt config bind <key>` again. The old slash commands are gone, not aliased: macros that typed `/ai ...` need `/wowgpt ...`.

## Uninstalling

`wowgpt service uninstall` if you had the service, then delete `%LocalAppData%\Programs\wowgpt` (or `npm unlink -g wowgpt` and your clone), `Interface\AddOns\WoWGPT` and the `WoWGPT_S001` … `WoWGPT_S200` folders next to it. Your chats' saved data is in `WTF\Account\<account>\SavedVariables\WoWGPT.lua`.

## Troubleshooting

**`wowgpt` is not recognized.** Open a new terminal; the installer changed your user `PATH`, which an already-open terminal doesn't see. From `npm link`, check `npm prefix -g`: that folder must be in `$env:Path`.

**PowerShell says "running scripts is disabled on this system".** See the execution-policy note above: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or use `wowgpt.cmd`.

**"Cannot read config.json … Run node setup.js".** The command is pointing at a copy of the repo that hasn't been set up (usually `npm install -g .` was used instead of `npm link`, or the folder was moved). Run `wowgpt setup`.

**The banner says `slots : NOT INSTALLED`.** `setup.js` couldn't write into the AddOns folder, or it wrote somewhere else. Check the `dir` of each entry in `clients` in `~\.wowgpt\config.json`, then run `wowgpt setup` (or `node bridge\install-slots.js`) and relaunch the game.

**A reply says `… is not installed on the bridge PC`, or `Could not start …`.** The bridge looks for each agent in its installer's folder (`%UserProfile%\.local\bin\claude.exe`, `%UserProfile%\.grok\bin\grok.exe`), then for `<name>.exe` on the `PATH`, then behind npm's `<name>.cmd` launchers (how `npm install -g @openai/codex` installs Codex; for Codex, a `CODEX_BIN` environment variable is checked first). The banner shows what it found for each. If yours lives elsewhere, put the full path in `agents.<id>.path` in `~\.wowgpt\config.json` and restart the bridge. Under the service, re-run `wowgpt service install` after installing a new CLI so it sees the new `PATH`.

**A reply says the agent is not logged in, or the run ends in a timeout.** Run the CLI once by hand in a terminal on this PC (`claude`, `codex`, `grok login`) and finish the login; headless runs reuse it. Grok also stops for nothing else: the bridge passes `--no-auto-update`.

**The light stays red / "no sign of the bridge".** The bridge can't see the strip in the top-left corner of the game window. In order of likelihood: the game is in exclusive fullscreen (switch to windowed or borderless); the game window is minimized or on a monitor the bridge can't capture; `capture.processName` in the config doesn't match your game exe (`WowB` for Forever; `setup.js` sets it from the exe it finds). The log (`wowgpt service logs`, or `bridge\bridge.log`) prints `attached to '...'` when it finds the window and `strip #N` when it decodes a message.

**Windows Defender or another antivirus complains about the slot files.** They are 15,000 empty or 124-byte files; nothing runs from them. Exclude `Interface\AddOns` if the scanner slows the bridge's writes down.

**Everything else** is in the README's Troubleshooting section and in `/wowgpt diag` in game.
