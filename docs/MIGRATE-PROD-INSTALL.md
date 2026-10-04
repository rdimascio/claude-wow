# Running the service from a release, not the dev checkout

This page is for a developer machine where the background service runs the bridge straight from a git checkout. On such a machine, the LaunchAgent runs `node <checkout>/bridge/supervisor.js` through a pinned node path, so every branch switch or edit in the checkout goes live at the next restart.

After the migration, the service runs one built binary:

```
~/.claude-wow/current/claude-wow          the service runs this path, and only this path
~/.claude-wow/current -> releases/<name>  a symlink; a deploy or a rollback moves it
~/.claude-wow/releases/<name>/claude-wow  one folder per build, <version>-<sha12>[-dirty-<time>]
~/.claude-wow/previous                    the release that was current before the last switch
~/.claude-wow/deploy.lock                 held while a deploy or a rollback runs
```

`<name>` is the `package.json` version and the first 12 characters of the commit. A build of a worktree with uncommitted changes adds `-dirty-<UTC time>`. The last 5 releases are kept (`--keep <n>`); the current and the previous release are never removed.

`~/.claude-wow` is the home folder (`CLAUDE_WOW_HOME` moves it). Config, state and chats stay where they are; the migration changes only which program the service starts.

## Commands

| Command | What it does |
|---|---|
| `claude-wow dev deploy [ref]` | Takes `deploy.lock`, adds a temporary `git worktree` of the ref (default `origin/main`; run `git fetch origin` first), builds it with `bun build.js --host`, copies the binary into `releases/<name>/`, waits until the bridge is idle, points `current` at the new release, restarts the service, runs `claude-wow setup` once with the new binary (setup installs the addon into every enabled client in `config.json`, and also adds a client folder it finds that the config does not list yet), and prints the setup lines about `/reload` or a full restart. It removes the temporary worktree, the build folder and the lock at the end, also after an error, Ctrl+C or SIGTERM. After a SIGKILL or a power loss they stay: the next deploy takes over the lock of the dead process, and `git worktree prune` in the checkout removes the worktree entry once its `claude-wow-deploy-*` folder in the temp folder is gone. |
| `claude-wow dev deploy <folder>` | The same, but it builds the checkout in that folder as it is, with no temporary worktree. Write the folder as a path (`/abs/path`, `./name` or `../name`); a bare name is always read as a ref. |
| `claude-wow dev rollback` | Takes the lock, waits until the bridge is idle, points `current` at the previous release, restarts the service and runs setup. A second rollback goes forward again. |
| `claude-wow dev status` | The current and the previous release, the releases on disk, whether the service runs `current`, and whether the bridge is idle. |

Options: `--repo <checkout>` (where a ref is read; the default is the checkout the command runs from, and the binary needs it), `--timeout <seconds>` (the idle wait, default 1800, more than 0 and at most 7200, so the lock cannot go stale while a deploy waits), `--keep <n>`.

**Idle** means: no agent run in `state.json` `inflight`, no message in `state.json` `queued`, and no message a plugin is still handling in `state.json` `handling` (a live-session chat waiting for its answer, a `/stream` command waiting for the overlay, a roast being sent to the overlay), for 3 s in a row. It also means idle when no bridge process is alive: the pid in `~/.claude-wow/bridge.lock`, or the bridge pid in the supervisor pid file. A bridge that stops cleanly (`service stop`) clears `queued` and `handling`. If the wait times out, nothing is switched: the new release stays on disk and the next deploy uses it without a new build.

**The switch.** After the first idle wait, the deploy marks `deploy.lock` as `switching`. While a live deploy on this machine holds that mark, the bridge holds every new chat message: it does not run it and does not acknowledge it, and it starts it when the lock goes. The bridge also writes each held message to `state.json` (`held`, at most 20, kept for up to an hour), and a stop does not clear it, so the bridge that the deploy's restart starts holds the same messages again and runs them when the lock goes. `/claude cancel` on a held message drops it from both; if a retried strip already started it after the lock went, the cancel stops that run. More than 20 held messages are logged by id: the ones past 20 still run when the lock goes, but a restart loses them. A vision screenshot a held message needs is kept through the bridge's startup sweep. The bridge also keeps its last 10 finished replies in `state.json` (`replies`) and publishes them again when it starts, so a reply that finished just before the restart reaches the game even when the game had not read it yet. Each kept reply belongs to one addon session: the first message from a new session (the game reset its saved data, so message ids start at 1 again) drops the replies of other sessions, and the addon ignores a reply tagged with another session's token. The deploy then checks idle a second time, so a message that started just before the mark is waited for too. Only then does it move `current`, restart and run setup. What is left: a plugin run that started less than 3 s before the mark and has not written `state.json` yet. The settle time of the second check covers that in practice.

**The restart and setup run only when the service runs `~/.claude-wow/current/claude-wow`.** Before the migration, a deploy only builds the release and moves `current`. It does not wait for idle, restart the service, or run setup. It says so. A deploy of the release that is already current does nothing after the build check: no wait, no restart, no setup.

The restart is `claude-wow service restart`: on macOS it bootstraps the LaunchAgent if it is not loaded (after `service stop`), else `launchctl kickstart -k gui/<uid>/io.claudewow.bridge`; on Linux `systemctl --user restart claude-wow-bridge`. `dev` does not run on Windows.

A release counts only after its binary and `release.json` are flushed to disk and its folder is renamed into place; a folder in `releases/` without a finished `release.json` is never reused, and the next deploy of that commit builds it again. If moving `current` fails, `previous` is put back as it was, so `dev rollback` still goes where it went before. If the process dies between writing `previous` and moving `current`, both name the same release: `dev status` warns, and `dev rollback` refuses and says to run the deploy again (it writes the right `previous`) or to deploy the ref you want (a release already on disk is not built again). A deploy or rollback checks that it still holds `deploy.lock` right before it moves `current`; if another deploy took the lock over, it stops and switches nothing.

Old releases are pruned after the restart and setup. A prune failure is printed and does not fail the deploy. Staging folders (`releases/.staging-*`) left by an install whose process is gone are removed at the same time.

`deploy.lock` is for one machine. A lock written on another host (a home folder on a shared drive) is never taken over until it is 3 hours old, and the bridge ignores its `switching` mark. Do not deploy into one home folder from two machines.

## Migrate (macOS)

Do this when no chat is running in the game. Use your normal terminal: `service install` copies that terminal's `PATH` into the LaunchAgent, and the bridge finds `claude`, `codex` and the rest through it.

1. Update the checkout to a `main` that has this change:

   ```sh
   git -C ~/wow-ai fetch origin
   git -C ~/wow-ai status --short --branch
   ```

2. Build the first release. The service still runs the checkout, so this step changes nothing that is running:

   ```sh
   ~/.nvm/versions/node/v24.21.0/bin/node ~/wow-ai/bridge/supervisor.js dev deploy origin/main
   ```

   The output ends with `service : ... does not run ~/.claude-wow/current/claude-wow, so nothing was restarted and setup was not run.`

3. Check the release:

   ```sh
   ~/.claude-wow/current/claude-wow --version
   ~/.claude-wow/current/claude-wow dev status
   ```

   `--version` prints the version and `claude-wow binary (bun ...)`. `dev status` shows the release as current and `bridge   : idle`. If it says `busy`, wait for the run to finish.

4. Point the service at the release. This rewrites `~/Library/LaunchAgents/io.claudewow.bridge.plist` and restarts the bridge:

   ```sh
   ~/.claude-wow/current/claude-wow service install
   ```

5. Put this release's addon into the game, so the addon and the bridge come from the same build:

   ```sh
   ~/.claude-wow/current/claude-wow setup --wow "/Applications/World of Warcraft/_classic_era_"
   ```

   Do what its last lines say: `/reload` in the game, or a full quit and relaunch when setup made a new addon folder.

## Verify

```sh
plutil -p ~/Library/LaunchAgents/io.claudewow.bridge.plist
~/.claude-wow/current/claude-wow service status
~/.claude-wow/current/claude-wow dev status
```

- `ProgramArguments` has one entry, `/Users/<you>/.claude-wow/current/claude-wow`. There is no `node` and no `supervisor.js`. `WorkingDirectory` is `~/.claude-wow`.
- `service status` says `running   : yes, as the service`, and its `versions` line shows the bridge version of the release.
- `dev status` says `service  : runs /Users/<you>/.claude-wow/current/claude-wow`.
- In the game, `/claude diag` shows the same bridge version, and a message gets a reply.

From now on, deploy with:

```sh
git -C ~/wow-ai fetch origin
~/.claude-wow/current/claude-wow dev deploy origin/main --repo ~/wow-ai
```

and go back one release with `~/.claude-wow/current/claude-wow dev rollback`. A branch switch or an edit in `~/wow-ai` no longer changes what the service runs.

## Go back to the checkout

1. Point the service at the checkout again. Run it with the node the old plist used, from your normal terminal:

   ```sh
   ~/.nvm/versions/node/v24.21.0/bin/node ~/wow-ai/bridge/supervisor.js service install
   ```

2. Check that `ProgramArguments` is the node path and `/Users/<you>/wow-ai/bridge/supervisor.js`, and that `WorkingDirectory` is `/Users/<you>/wow-ai`:

   ```sh
   plutil -p ~/Library/LaunchAgents/io.claudewow.bridge.plist
   ~/.nvm/versions/node/v24.21.0/bin/node ~/wow-ai/bridge/supervisor.js service status
   ```

3. Put the checkout's addon back into the game:

   ```sh
   ~/.nvm/versions/node/v24.21.0/bin/node ~/wow-ai/setup.js --wow "/Applications/World of Warcraft/_classic_era_"
   ```

The releases stay in `~/.claude-wow/releases`. To remove them too: `rm -rf ~/.claude-wow/releases ~/.claude-wow/current ~/.claude-wow/previous`.

## Linux

The same steps work with the systemd user unit, with one more step. `service install` from the release writes `~/.config/systemd/user/claude-wow-bridge.service` with `ExecStart="/home/<you>/.claude-wow/current/claude-wow"` and runs `systemctl --user enable --now`. That does not restart a unit that is already active, so the old bridge keeps running. Restart it after step 4:

```sh
~/.claude-wow/current/claude-wow service restart
```

Check it with `systemctl --user cat claude-wow-bridge` and `systemctl --user status claude-wow-bridge` (the main process must be `/home/<you>/.claude-wow/current/claude-wow`).
