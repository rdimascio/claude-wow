# In-game dev loop

Status: in progress, 2026-10-05.

## Goal

Fix bugs in this repository from inside the game, with no terminal open. In the morning, every Claude Code session for this repository moves into the game in one step, and each chat has the tools a terminal gives: git state, diffs, logs, test runs, health checks, Lua errors, and a way to say "this reply was wrong".

## What exists

- Coding chats per project folder, headless `claude -p --resume`, live channel sessions, `/claude -r` for one session at a time.
- Permission asks as the Need/Greed roll, `/claude cancel`, cost and context in the footer.
- `npm run doctor` and `bridge.log`, terminal only.

## Design

All new commands are bridge plugins or addon-only features. A plugin reply flows through the existing reply path, so there is no new record kind, no new slot reader and no new flag.

### 1. The `dev` plugin (`bridge/plugins/dev.js`)

Addressed as `@dev <command>` in any chat. It never runs an agent. It runs one fixed command in the chat's folder and replies with plain text (code fences for raw output).

| Command | Does |
|---|---|
| `status` | branch, upstream ahead/behind, changed files, last 3 commits, open PR for the branch (`gh`, if present) |
| `diff [path]` | `git diff --stat` and the diff, capped |
| `log [n] [filter]` | the last `n` lines of `bridge.log`, optionally only lines with `filter` |
| `run` | the last agent run in this chat: agent, model, session id, folder, duration, exit, cost, tools used, stderr tail, the terminal command to resume it |
| `test [args]` | `plugins.dev.testCommand` (default `npm test` when `package.json` exists) with a timeout, summary of pass/fail and the failing tails |
| `doctor` | `node dev/doctor.js --json` from the checkout, summarised |
| `errors` | Lua errors from the game's `Logs/` folder for this client |
| `feedback` | the open feedback items (section 3) |
| `help` | the list |

The output of the last `@dev` command in a chat is kept per chat. The next agent run in that chat gets it as one context block, so `@dev test` then "fix it" works without the agent re-running the tests blind.

The addon gates `/claude dev ...` on `dev` being in the slot's `plugins` list. An older bridge would run `@dev status` as a prompt, so the addon refuses and says the bridge is too old.

### 2. Addon commands

- `/claude dev <command>` sends `@dev <command>` in the active chat.
- `/claude errors` lists Lua errors the addon captured this UI session (a bounded `seterrorhandler` chain that keeps the previous handler).
- Buttons in the workspace window under each finished reply: `Wrong` (section 3).

### 3. Feedback ("mark as wrong")

- `/claude wrong [note]` (or the `Wrong` button) marks the last reply in the chat as wrong. The addon sends `@dev wrong <reply id> <note>`. The `dev` plugin stores `{at, chat, replyId, session, agent, model, plugin, cwd, prompt, reply, note, status: "open"}` in `<home>/feedback.jsonl` (bounded, 500 items).
- `/claude bug <text>` stores a bug with the addon diag summary and recent Lua errors.
- `@dev feedback` lists open items; `@dev feedback close <n>` closes one; `@dev feedback fix <n>` replies with the item and the agent in a coding chat for this repository picks it up as its next prompt.
- `claude-wow feedback [--json]` prints them in a terminal.

### 4. Morning handoff

- `claude-wow handoff [folder]` (terminal): lists Claude Code sessions for the folder, running and recent, with ids, titles, branches and whether each process is still running. It writes `<home>/handoff.json`. Each session still running is named so the player can quit it first (two processes on one session id fork it).
- In game, `/claude -r all` creates one chat per session in the handoff list (else per session the resume picker shows for the current project folder), each bound to resume its session headless in its folder, titled with the session title. No agent turn runs until the player types in a chat.
- `@dev run` in a handed-off chat shows the session id and the exact terminal command to go back.

## Order of work

1. `dev` plugin with `status`, `diff`, `log`, `run`, `test`, `doctor`, `errors`, `help`; the addon `/claude dev`; context carry-over.
2. Feedback store, `wrong`, `bug`, `feedback`, CLI.
3. Addon Lua error capture and `/claude errors`.
4. Handoff CLI and `/claude -r all`.

Each step: unit tests, an e2e scenario through `dev/harness.js`, CHANGELOG entry, docs.
