# Plan: Discord notifications, then coding sessions across clients

Status: draft, revision 2 (2026-10-04). Revision 2 follows a two-seat review (fable, gpt-6-astra) of revision 1: Part A is cut to two hook sites and three settings, and Part B reuses the existing `/claude -r` resume path instead of a new transport. Code references name functions, not line numbers. **(unverified)** marks claims nobody has checked yet.

## 1. Goals and non-goals

**Goals**

- The owner learns that a long coding run finished, failed or got blocked, without the game in front of them.
- A coding session started on one client (another account, or Forever vs Era) can be resumed from any other client the bridge serves, and two clients can never run one agent session at once.

**Non-goals**

- No inbound Discord (answering from a phone). Later plan.
- No live mirror of one chat on two clients, no message catch-up between clients, no chat id migration. The agent session carries the context; each client's chat keeps its own in-game history.
- No alt inventory or mats ledger. Separate plan.
- No new transport record kinds or request flags.

## 2. Order of work

1. Part A: outbound Discord webhook. Bridge only.
2. Part B1: one run per agent session (a bug fix that stands alone).
3. Part B2: label and widen the resume picker.

## 3. Part A: outbound Discord webhook

### 3.1 What exists

- In-game notice only: `ClaudeWoW.Notify` (sound, `UIErrorsFrame` line, tab flash, unread badge).
- No Discord, Slack, webhook, push or OS notification code in `bridge/` or `bridge/plugins/`.
- When presence beats work and nothing is pending, the addon reads no slot until the player acts (`Tick` in `ClaudeWoW.lua`: idle polls run only without presence, or after a presence stall). So a late reply can sit unseen.
- The bridge has no slot-read clock. `clients.<key>.heard` (`CLI.noteHeard`, `CLI.heardAt`) moves on decoded records only: messages, hello and `gs` telemetry.

### 3.2 Events and hook sites

Exactly two sites:

| Site                                         | Event                                                                                        | Rule                                                                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `finish(job, status, text, session, denied)` | `done`, `failed` (`status === 'error'`, timeouts land here), `blocked` (`denied.length > 0`) | `claude-code` chats only; run time from the `running` entry's start, read before `running.delete`; skip when under `minRunSeconds` |
| `lateReply(job, raw)`                        | `late` (factory results arrive here through `deliverFactoryRun`)                             | Always. Text says "send anything in the chat to fetch it", because a late reply raises no `sig`                                    |

No `factory` event (it would double-fire with `late`), no coalescer, no `context` event (the 300k warning is the addon setting `db.settings.contextWarn`; the bridge has no such number).

### 3.3 When to send

- v1 sends on every qualifying event. `minRunSeconds` (default 60) is the noise filter.
- An `away` mode is deferred. `heardAt` is only an approximation: `gs` telemetry keeps it fresh while the player stands in game, and it stays still while the player watches a long run without typing. Accurate away detection needs an addon signal; that is a later change.

### 3.4 Message content

- Fields: event, character (from `state.clients[key].context` at send time), run time, cost.
- Chat name and project folder are **not** sent by default. A chat name is the first prompt's words or a model title of it (`T.generateTitle({ text: job.text })`), and a folder name can be confidential.
- `notify.detail: "named"` adds chat name and project basename. No mode ever sends reply text in v1.
- Payload: one embed, `allowed_mentions: { parse: [] }`.
- `?wait=true` on every post, so success is recorded only when Discord returns the created message. Without it Discord answers 204 and can drop the message silently **(unverified)**, per Discord's Execute Webhook docs.

### 3.5 Config and the secret

```json
"notify": {
  "discord": { "webhookUrl": "" },
  "minRunSeconds": 60,
  "detail": "plain"
}
```

- `CLAUDE_WOW_DISCORD_WEBHOOK` overrides `webhookUrl`.
- **The URL never reaches a child process.** Agent runs spawn with `{ ...process.env }` (`runJob`, factory `env`, `T.generateTitle`), and the default allowlist has `Bash(node:*)`, so a run could print the env. The bridge reads the variable once at start into the notifier closure, then `delete process.env.CLAUDE_WOW_DISCORD_WEBHOOK` before any spawn. Test: the env passed to `PR.spawnChild` has no key matching `/DISCORD|WEBHOOK/`, and a `config.json` URL never appears in any spawn env or argv.
- URL check: `https://` and host `discord.com`, `discordapp.com`, `ptb.discord.com` or `canary.discord.com`, path `/api/webhooks/<digits>/<token>`. Query string dropped. Anything else is refused at start with one log line.
- The URL never goes to the log, the game or `report.js` output. Logs show `webhook …/<last 4>`.

### 3.6 Module

- New `bridge/notify.js`: `createNotifier({ url, fetch, log })` returns `{ notify(event, fields), flush(ms) }`.
- `fetch` is injected; no test reaches the network.
- One `fetch` per event. Any error or non-2xx is logged with its status and dropped. A send never blocks or fails a run.
- `flush(2000)` runs before graceful exit (shutdown path and `--once`/`--inject`), so a final notice is not lost.

### 3.7 Setup and test

- `claude-wow notify test` sends one message and prints the result. It does not touch the addon or the signal files.
- Docs: `docs/CONFIGURATION.md` gains a `notify` section.

### 3.8 Tests

- `finish` with `done`, `error` and `denied` each sends once with the right event; `lateReply` sends `late`; a run under `minRunSeconds` sends nothing.
- `detail: "plain"` payload has no chat name and no project.
- Mutation checks (memory: mutation-check negative tests): remove `allowed_mentions`, the URL check, the env scrub, the `minRunSeconds` check and `wait=true`; each must fail a test.
- A thrown `fetch` and a 429 leave the run result unchanged.

## 4. Part B: coding sessions across clients

### 4.1 What exists

- Chats live in `ClaudeWoWDB.chats`, account-wide SavedVariables. Alts on one account already share every chat.
- **Cross-client resume already works.** `/claude -r` lists `ownSessions(state, transcripts)` (every `chat:<id>` session in bridge state, from any client, with `agent`, `plugin`, `cwd`) merged by `mergeSessions` (limit 12). Picking one runs `Cli.AttachTo`: a new chat with `resumeId` and the stored agent, and the next message resumes that agent session.
- After an attach, two chat ids map to one agent session (`adoptSession` writes `state.sessions['chat:<new>']`; `chat:<old>` keeps the same id).
- `running` and `queued` are `Map`s keyed by `chatKey` = `<addon session token>:<chat id>`, one entry per key.

### 4.2 Step B1: one run per agent session

The bug: client A's chat and client B's attached chat have different `chatKey`s and the same agent session. Both can run at once, so two `--resume` calls hit one session.

- Keep `running` and `queued` keyed by `chatKey`. Do not re-key: `queued` holds one job per key, and `finish`, `cancelRun`, `inFlight` and `dispatchMessage` all assume `chatKey` and bare message ids.
- Add `sessionBusy(job)`: true when any `running` entry resolves to the same agent session, where the resolved id is `state.sessions[sessKey(r.job)] || sessKey(r.job)`.
- `dispatchMessage` queues the job when `sessionBusy(job)`. `drainQueue` skips a queued job while `sessionBusy(job)`.
- Tests: two clients, two chat ids, one agent session; the second run starts only after the first ends. Mutation: remove the `drainQueue` check and the test must fail.

### 4.3 Step B2: label and widen the picker

- `ownSessions` adds `client` (the transcript's last `client`) and the picker shows its label, so the owner can tell sessions from another client apart.
- `mergeSessions` limit 12 → the picker pages, or the limit rises within the slot size budget. Measure the slot bytes per entry before picking a number.
- No new record kind; the session list already rides the existing `/claude -r` reply.

### 4.4 Delete and attach

- Deleting the attached chat on client B runs `forgetChat` for B's chat id only. A's `chat:<old>` key and transcript stay. Test this.

## 5. Decisions for the owner

1. Part A `detail` default: `plain` (recommended; no chat name or folder leaves the machine) or `named`.
2. Part A away mode: defer (recommended) or ship the `heardAt` approximation now.

## 6. PR checklist

- CHANGELOG entry per PR.
- `docs/OPERATING-NOTES.md` "Multiple clients" section is stale (it says nothing tells clients apart); fix it in the B2 PR.
