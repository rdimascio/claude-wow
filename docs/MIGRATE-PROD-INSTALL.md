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
| `claude-wow dev deploy [ref]` | Takes `deploy.lock`, adds a temporary `git worktree` of the ref (default `origin/main`; run `git fetch origin` first), builds it with `bun build.js --host`, copies the binary into `releases/<name>/`, waits until the bridge is idle, points `current` at the new release, restarts the service, runs `claude-wow setup --wow <client>` with the new binary for the client in `config.json`, and prints the setup lines about `/reload` or a full restart. It removes the temporary worktree and the lock at the end, also after an error. |
| `claude-wow dev deploy <folder>` | The same, but it builds the checkout in that folder as it is, with no temporary worktree. |
| `claude-wow dev rollback` | Takes the lock, waits until the bridge is idle, points `current` at the previous release, restarts the service and runs setup. A second rollback goes forward again. |
| `claude-wow dev status` | The current and the previous release, the releases on disk, whether the service runs `current`, and whether the bridge is idle. |

Options: `--repo <checkout>` (where a ref is read; the default is the checkout the command runs from, and the binary needs it), `--timeout <seconds>` (the idle wait, default 1800), `--keep <n>`.

**Idle** means: no agent run in `state.json` `inflight` and no message in `state.json` `queued`, for 3 s in a row, or no bridge process alive (from the supervisor pid file). If the wait times out, nothing is switched: the new release stays on disk and the next deploy uses it without a new build.

**The restart and setup run only when the service runs `~/.claude-wow/current/claude-wow`.** Before the migration, a deploy only builds the release and moves `current`. It does not restart the service, and it does not run setup. It says so.

The restart is `launchctl kickstart -k gui/<uid>/io.claudewow.bridge` on macOS and `systemctl --user restart claude-wow-bridge` on Linux. `dev` does not run on Windows.

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

The same steps work with the systemd user unit: `service install` from the release writes `~/.config/systemd/user/claude-wow-bridge.service` with `ExecStart="/home/<you>/.claude-wow/current/claude-wow"`. Check it with `systemctl --user cat claude-wow-bridge`.
