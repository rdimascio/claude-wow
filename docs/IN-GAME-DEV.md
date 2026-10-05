# Fixing bugs from inside the game

A coding chat is a Claude Code (or Codex) session in a project folder. These commands give it the rest of a terminal: git state, diffs, logs, tests, the health check, Lua errors and feedback. They run on the bridge PC, in the chat's folder, and never start an agent run.

## Move your terminal sessions into the game

1. In a terminal, in the repository:

   ```sh
   claude-wow handoff --stop
   ```

   It lists every Claude Code session running in this repository and its worktrees (from `~/.claude/sessions/<pid>.json`), with each one's title, branch, state and last ask and answer, and saves the list to `~/.claude-wow/handoff.json`. `--stop` then ends the **idle** sessions with `SIGTERM` and waits up to 15 s; their conversations stay on disk. It leaves alone:
   - a session that is `busy` or running a shell command (`--force` ends those too, and their turn in progress is lost),
   - a session whose start time it cannot check against `ps`, so a reused pid is never signalled,
   - the session that runs the command (by `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` and the parent processes),
   - every session on Windows.

   Run it again when the busy ones are done: the new list keeps the sessions stopped earlier (same repository, last 24 hours). Without `--stop` it only lists and saves.
2. In game: `/claude -r all`. You get one chat per session, named after it, in its own folder, with its last ask and answer at the top. The bridge checks each session's process every 15 s: a session still running is listed and not opened, because resuming it in two places would fork it. Running `-r all` again opens only what is new.
3. Type in a chat: the first message resumes that session headless (`claude -p --resume <id>` in its folder). `/claude dev run` shows the session id and the command to take it back to a terminal.

The list is kept for 24 hours. `claude-wow handoff <folder>` names another repository; `--json` prints the saved list.

## Dev tools

| Command | What you get |
|---|---|
| `/claude dev status` | branch, upstream ahead and behind, changed files, the last 3 commits, the branch's PR and its checks (`gh`, when installed and logged in) |
| `/claude dev diff [path]` | `git diff HEAD --stat`, untracked files, then the diff, cut at about 6,000 characters |
| `/claude dev log [lines] [text]` | the end of `bridge.log` (40 lines, at most 200), only lines with `text` when given |
| `/claude dev run` | the chat's last agent run: agent, model, effort, folder, session id, how long, exit code, turns, context, cost, denied tools, the last 12 steps, the end of stderr, and the command that resumes the session in a terminal |
| `/claude dev test [args]` | `plugins.dev.testCommand`, else `npm test`, with the totals, the failing tests and the end of the output when it fails. It sends a heartbeat every 30 s, so a long run does not look stuck. |
| `/claude dev doctor` | `dev/doctor.js --json` from the chat's folder (a claude-wow checkout), one line per check and the fix for each problem |
| `/claude dev errors` | Lua errors from the game's `Logs/General.log` (the client writes it when it exits) and the ones the addon caught this UI session |
| `/claude dev help` | the list |

The agent in the chat sees the output of the last dev command with your next message (once, for 30 minutes). So this works:

```
/claude dev test tests/dev_test.js
fix the failing test
```

Dev commands need a bridge that lists the `dev` plugin. An older bridge would run `@dev status` as a prompt, so the addon refuses and says to update the bridge.

## Feedback

| Command | What it does |
|---|---|
| `/claude wrong [#n] [note]` | marks the chat's last agent reply (or reply `#n`) as wrong, with the prompt, the reply, the agent session and your note |
| `/claude bug <text>` | files a bug with the addon version, the client build, the mode and the caught Lua errors |
| `/claude dev feedback [all]` | the open items (`all`: closed ones too) |
| `/claude dev feedback fix <n>` | shows item `n` and hands it to the agent in this chat with your next message |
| `/claude dev feedback close <n> [why]` | closes item `n` |

Items live in `~/.claude-wow/feedback.jsonl` (at most 500). A chat in the claude-wow checkout can work through them: `/claude dev feedback`, then `fix 3`, then "fix it and open a PR".

## Lua errors

`Dev.lua` loads first and puts its own error handler in front of the one that was there. Every error still reaches the old handler (the default popup, BugSack, and so on). It keeps errors whose message or stack names a Claude WoW file: the last 20, each with a count and the top of its stack, in memory only. `/claude errors` lists them in the chat; `/claude dev errors` and `/claude bug` send them to the bridge.

## On stream

Dev replies show paths, branch names, log lines and diffs. They appear in the chat window and the whisper tab like any reply. Do not run them on a stream you do not want them on.
