# Fixing bugs from inside the game

A coding chat is a Claude Code (or Codex) session in a project folder. These commands give it the rest of a terminal: git state, diffs, logs, tests, the health check, Lua errors and feedback. They run on the bridge PC, in the chat's folder, and never start an agent run.

## Move your terminal sessions into the game

1. In a terminal, in the repository:

   ```sh
   wowgpt handoff --stop
   ```

   It lists every Claude Code session running in this repository and its worktrees (from `~/.claude/sessions/<pid>.json`), with each one's title, branch, state and last ask and answer, and saves the list to `~/.wowgpt/handoff.json`. `--stop` then ends the **idle** sessions with `SIGTERM` and waits up to 15 s; their conversations stay on disk. It leaves alone:
   - a session that is `busy` or running a shell command (`--force` ends those too, and their turn in progress is lost),
   - a session whose start time it cannot check against `ps`, so a reused pid is never signalled,
   - the session that runs the command (by `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` and the parent processes),
   - every session on Windows.

   Run it again when the busy ones are done: the new list keeps the sessions stopped earlier (same repository, last 24 hours). Without `--stop` it only lists and saves.
2. In game: `/wowgpt -r all`. You get one chat per session, named after it, in its own folder, with its last ask and answer at the top. The bridge checks each session's process every 15 s: a session still running is listed and not opened, because resuming it in two places would fork it. Running `-r all` again opens only what is new.
3. Type in a chat: the first message resumes that session headless (`claude -p --resume <id>` in its folder). `/wowgpt dev run` shows the session id and the command to take it back to a terminal.

The list is kept for 24 hours. `wowgpt handoff <folder>` names another repository; `--json` prints the saved list.

## Dev tools

| Command | What you get |
|---|---|
| `/wowgpt dev status` | branch, upstream ahead and behind, changed files, the last 3 commits, the branch's PR and its checks (`gh`, when installed and logged in) |
| `/wowgpt dev diff [path]` | `git diff HEAD --stat`, untracked files, then the diff, cut at about 6,000 characters |
| `/wowgpt dev log [lines] [text]` | the end of `bridge.log` (40 lines, at most 200), only lines with `text` when given |
| `/wowgpt dev run` | the chat's last agent run: agent, model, effort, folder, session id, how long, exit code, turns, context, cost, denied tools, the last 12 steps, the end of stderr, and the command that resumes the session in a terminal |
| `/wowgpt dev test [args]` | `plugins.dev.testCommand`, else `npm test`, with the totals, the failing tests and the end of the output when it fails. It sends a heartbeat every 30 s, so a long run does not look stuck. |
| `/wowgpt dev doctor` | `dev/doctor.js --json` from the chat's folder (a wowgpt checkout), one line per check and the fix for each problem |
| `/wowgpt dev errors` | Lua errors from the game's `Logs/General.log` (the client writes it when it exits) and the ones the addon caught this UI session |
| `/wowgpt dev globals [clear]` | runs in the addon, not the bridge: saves (or drops) the global names the UI widget allowlist admits and refuses on this client, for `npm run audit:widgets` ([UI-WIDGETS.md](UI-WIDGETS.md#audit-the-allowlist-against-the-real-client)) |
| `/wowgpt dev help` | the list |

The agent in the chat sees the output of the last dev command with your next message (once, for 30 minutes). So this works:

```
/wowgpt dev test tests/dev_test.js
fix the failing test
```

Dev commands other than `globals` need a bridge that lists the `dev` plugin. An older bridge would run `@dev status` as a prompt, so the addon refuses and says to update the bridge.

## Feedback

| Command | What it does |
|---|---|
| `/wowgpt wrong [#n] [note]` | marks the chat's last agent reply (or reply `#n`) as wrong, with the prompt, the reply, the agent session and your note |
| `/wowgpt bug <text>` | files a bug with the addon version, the client build, the mode and the caught Lua errors |
| `/wowgpt dev feedback [all]` | the open items (`all`: closed ones too) |
| `/wowgpt dev feedback fix <n>` | shows item `n` and hands it to the agent in this chat with your next message |
| `/wowgpt dev feedback close <n> [why]` | closes item `n` |

Items live in `~/.wowgpt/feedback.jsonl` (at most 500). A chat in the wowgpt checkout can work through them: `/wowgpt dev feedback`, then `fix 3`, then "fix it and open a PR".

## Lua errors

`Dev.lua` loads first and puts its own error handler in front of the one that was there. Every error still reaches the old handler (the default popup, BugSack, and so on). It keeps errors whose message or stack names a WoWGPT file: the last 20, each with a count and the top of its stack, in memory only. `/wowgpt errors` lists them in the chat; `/wowgpt dev errors` and `/wowgpt bug` send them to the bridge.

## On stream

Dev replies show paths, branch names, log lines and diffs. They appear in the chat window and the whisper tab like any reply. Do not run them on a stream you do not want them on.
