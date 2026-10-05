# Plan: Discord notifications, then project threads across clients

Status: draft, revision 1 (2026-10-04). Code references name functions, not line numbers. **(unverified)** marks claims nobody has checked yet.

## 1. Goals and non-goals

**Goals**
- The owner learns that a long coding run finished, failed or got blocked, without the game in front of them.
- A coding chat belongs to a project folder, and any character on any client the bridge serves can open it and resume the same agent session.

**Non-goals**
- No inbound Discord (answering from a phone). That needs a bot, an auth model and a reply path into the game. It is a later plan.
- No live mirror of one chat on two clients at once. v1 is open-on-demand (§4.4).
- No alt inventory or mats ledger. That is a separate plan.
- No new transport record kinds for Part A. Part B adds one capability-gated record (§4.5).

## 2. Order of work

1. Part A: outbound Discord webhook. Bridge only, no addon change, no slot cost.
2. Part B: project threads. Bridge and addon.

Part A ships and gets used before Part B starts.

## 3. Part A: outbound Discord webhook

### 3.1 What exists

- In-game notice only: `ClaudeWoW.Notify` (sound, `UIErrorsFrame` line, tab flash, unread badge). Late replies use the same path.
- No Discord, Slack, webhook, push or OS notification code in `bridge/` or `bridge/plugins/`.
- Addon slot reads stop when the addon goes idle, so a late reply can sit unseen until the next game action (memory: addon slot reads stop when idle).

### 3.2 Events

| Event | Source in the bridge | Default |
|---|---|---|
| `done` | A run's final reply for a `claude-code` chat that ran longer than `minRunSeconds` | on |
| `late` | `lateReply` | on |
| `factory` | `deliverFactoryRun` (factory run ended, any outcome) | on |
| `blocked` | `permission_denials` in the result event (`agents.js`, Claude stream parser) | on |
| `failed` | Run error or `timeoutMs` reached | on |
| `context` | Session usage crosses the 300k warning threshold | off |

`ask` (game chat) runs never notify unless `notify.plugins` names `ask`.

### 3.3 When to send

- `notify.when`: `away` (default) or `always`.
- `away` means: the client that owns the job has not loaded a slot for `awaySeconds` (default 120), or `clientproc.js` reports the game is not running. **(unverified)** that `clientproc.js` gives a reliable "not running" on macOS and Windows; check before relying on it, else use the slot-read clock alone.

### 3.4 Message content

- Default `detail: "title"`: event, chat name, character, project folder basename, run time, cost. No reply text.
- `detail: "summary"` adds the reply `summary` (the `TL;DR` line), cut to 300 characters.
- Never the full reply. Replies can hold code, paths and secrets from the repo.
- Reply text passes through the same token expansion the game uses (`replytokens.js`), or tokens are stripped. A raw `{item:123}` must not reach Discord.
- Payload sets `allowed_mentions: { parse: [] }` so text in a reply cannot ping `@everyone`.
- Content goes in an embed `description`, never `content`, so Discord markdown in a reply cannot break the layout.

### 3.5 Config

```json
"notify": {
  "discord": { "webhookUrl": "" },
  "events": ["done", "late", "factory", "blocked", "failed"],
  "when": "away",
  "awaySeconds": 120,
  "minRunSeconds": 60,
  "detail": "title",
  "plugins": ["claude-code"]
}
```

- `CLAUDE_WOW_DISCORD_WEBHOOK` overrides `webhookUrl`, so the URL can stay out of `config.json`.
- The URL must match `^https://(discord\.com|discordapp\.com)/api/webhooks/\d+/[\w-]+$`. Anything else is refused at start with one log line.
- The URL is a secret. It never goes to the log, the game, `report.js` output or a crash dump. Logs show `webhook …/<last 4>`.

### 3.6 Module

- New `bridge/notify.js`: `createNotifier({ config, fetch, now, log })` returns `notify(event, fields)`.
- `fetch` is injected. Tests use a fake; no test reaches the network.
- Coalescing: events for the same chat inside 10 s merge into one message.
- Rate: at most 20 messages a minute (Discord allows 30 a minute per webhook **(unverified)**, current docs). On 429, wait `retry_after` once, then drop and log.
- A send never blocks or fails a run. Errors are logged and dropped.
- Wired from `lateReply`, `deliverFactoryRun`, the run-end path in `runJob`, and the permission-denial branch in `agents.js` (passed up as a run field, not sent from `agents.js`).

### 3.7 Setup

- `claude-wow setup --discord <url>` writes the URL to `CLAUDE_WOW_HOME` config and sends one test message.
- `claude-wow doctor` reports `notify: discord on (…/abcd), last send ok 2m ago` or the last error.

### 3.8 Tests

- Each event fires once with the right fields; `away` suppresses when a slot load is recent.
- Negative tests by mutation: remove the `allowed_mentions` line, the URL check, the secret redaction and the `away` check; each must fail a test (memory: mutation-check negative tests).
- A thrown `fetch` and a 429 do not change the run result.

## 4. Part B: project threads across clients

### 4.1 What exists

- Chats live in `ClaudeWoWDB.chats`, account-wide SavedVariables. Alts on one account already share every chat.
- Chat ids come from `NewId`: `time() % 0xFFFFFF` plus 16 random bits. Unique per account in practice; not unique across clients by construction.
- Agent sessions are keyed by `sessKey` = `chat:<id>`, so the same chat id resumes the same agent session from any client.
- `transcripts.chats[id]` keeps the last 200 messages per chat, with `cwd`, `plugin` and the last `client`.
- `maybeOfferRestore` already sends up to 16 chats to a fresh addon session, but filters them to `c.client === job.client`.
- The run queue (`running`, `queued`) is keyed by `chatKey` = `<addon session token>:<chat id>`. Two clients have two tokens.

### 4.2 The gap

- A chat started on one client (another account, or Forever vs Era) cannot be opened on the other.
- **If it could, two clients could run the same agent session at once**, because the queue key includes the addon token. Two `claude --resume` runs on one session fork it **(unverified)**; either way the transcript order breaks. This must be fixed first (§4.3).

### 4.3 Step B1: one run per agent session

- Key `running` and `queued` by `sessKey`, not `chatKey`. A second client's message waits behind the first.
- `inFlight` still compares message ids, now scoped by `(session token, id)` because ids restart per addon session.
- Test: two clients, same chat id, two messages; the second starts only after the first ends.

### 4.4 Step B2: project chat list and open-on-demand

- A project is a `cwd`. The bridge builds the list from `transcripts.chats`: chats with `plugin` `claude-code` and a non-empty `cwd`, any client.
- The addon asks for the list when the player opens the project picker (`Cli.KnownProjects`). The bridge answers with up to 16 entries: `id`, `name`, `cwd`, `updated`, last character, last client label. Metadata only, no messages.
- The player picks one. The bridge sends that chat through the existing restore record shape (last 40 messages, 2000 characters each), tagged for this client.
- The addon adds it with the same id. If this client already has a different chat with that id, the addon refuses and logs it; the bridge then mints a fresh id on both sides and moves the transcript and session keys (`state.sessions`, `sessionCwd`, `sessionAgent`, `sessionPlugin`, `sessionRules`, `sessionUsage`).
- Replies go only to the client that sent the message (`recordsFor` is unchanged). When the other client opens the chat again, it asks for messages newer than its last id ("catch up on open").

### 4.5 Transport

- One new request flag and one new record kind for the list. Both need a capability gate in `runJob` and a slot-load trigger, and must not reuse an existing message id or flag letter (memory: addon-bridge round-trip rules, transport budgets).
- Cost: one slot to fetch the list, one to open a chat. No cost while idle.
- Old addon builds without the capability never see the list and keep today's behavior.

### 4.6 Tests

- Tick-driven test: client A starts a chat, client B lists it, opens it, sends a message, and the reply resumes A's session id.
- Id collision path moves every `state.session*` key.
- Mutation checks: drop the `sessKey` queue change and the B1 test must fail; drop the capability gate and the old-addon test must fail.

## 5. Decisions for the owner

1. Part A default `detail`: `title` (recommended, no repo text leaves the machine) or `summary`.
2. Part A default `when`: `away` (recommended) or `always`.
3. Part B v1 scope: open-on-demand with catch-up (recommended) or live mirror to every client that holds the chat (more slots, more code).

## 6. PR checklist

- CHANGELOG entry per PR.
- `docs/CONFIGURATION.md` gains a `notify` section (Part A) and a project-threads note (Part B).
- `docs/OPERATING-NOTES.md` "Multiple clients" section is stale (it says nothing tells clients apart); fix it in the Part B PR.
