# Plan: two-way Discord sync for coding chats, with WoW as one transport

Status: draft, revision 2 (2026-10-05). Revision 2 follows a two-seat review (fable, gpt-6-astra) of revision 1, which found 28 issues; the main changes are a step 0 for shared prerequisites, one chat id across both places, and the real Discord limits. It replaces Part A of the plan in PR #116 (`docs/plans/discord-and-project-threads.md` on branch `docs/discord-and-project-threads`) and supersedes PR #122 (one-way webhook). Code references name functions, not line numbers. **(unverified)** marks claims nobody has checked yet.

## 1. Goals and non-goals

**Goals**
- A coding chat is one thread with one chat id that lives in two places: the game and a Discord thread.
- A message typed in either place runs the same Claude session, with the same agent and settings. The reply and the progress show in both places.
- The owner can start, continue and check coding work from Discord with the game closed, and pick it up in game later.

**Non-goals**
- No iMessage, Slack or other platforms.
- No multi-user use. One owner, one private Discord server, an allowlist of Discord user IDs.
- No game chats (`ask` plugin) in Discord. Coding chats (`claude-code`) only.
- No images or attachments to or from Discord.

## 2. Library facts (checked 2026-10-05 against `@chat-adapter/discord` 4.41.1 `dist/index.js` and npm)

| Fact | Source |
|---|---|
| `chat` and `@chat-adapter/discord` 4.41.1: MIT, ESM only, Node >= 20. The adapter depends on `discord.js` ^14. `chat` has optional peer deps `ai`, `zod`, `workflow`. | `npm view` |
| A custom adapter delivers messages by calling `this.chat.processMessage(adapter, threadId, factory, options)`. | chat-sdk.dev, "Building an adapter" |
| Channel messages arrive only on the Gateway. `startGatewayListener({ waitUntil }, durationMs, abortSignal?, webhookUrl)` logs in, forwards each event to `webhookUrl` with the header `x-discord-gateway-token: <bot token>`, and destroys the client when `durationMs` ends. It does not reconnect inside the window. | adapter source |
| `DISCORD_MAX_CONTENT_LENGTH = 2000`. Longer content is truncated, not split. | adapter source |
| With a channel in `respondToChannelIds`, every message in that channel and its threads is delivered without a mention, and the adapter's own bot-author filter is skipped there. | adapter source |
| The default thread lock drops a message that arrives while a handler for the same thread still runs (`LockError`); `maxLockLifetimeMs` is 600000. | chat-sdk.dev, concurrency |

Open questions for the spike: does the compiled `bun build --compile` binary load `chat` and `discord.js` through dynamic `import()` **(unverified)**; the binary size cost **(unverified)**; Gateway identify count per day with a long `durationMs` (Discord allows 1000) **(unverified)**.

## 3. Order of work

0. Prerequisites in the core, each its own PR with tests:
   - a. One run per Claude session: a busy check keyed by the resolved session id (`state.sessions[sessKey(job)]`), used by `dispatchMessage` and `drainQueue` (plan #116 step B1, not built yet).
   - b. A bounded FIFO per chat (5 jobs) instead of `queued.set(key, job)`, which replaces a waiting job. Past 5, the new job is refused with a reply.
   - c. One admission function for every transport: the shutdown guard and `holdForDeploy`, which today sit in `submit()` only. `dispatchMessage` callers outside `submit()` go through it.
   - d. Slash commands (PR #117) merged, and `/stop` and `/runs` handled at admission, before the queue, so they work while the chat is busy.
1. Spike (throwaway branch, no PR): the Discord adapter inside the compiled binary, Gateway forwarding to `127.0.0.1`, one round trip, an identify count over 24 h.
2. Discord mirror: Discord messages run jobs; replies and progress post to Discord. WoW keeps its native path.
3. Game side: messages that came from Discord, and their replies and permission asks, show in the game chat.
4. WoW as a Chat SDK adapter. Starts only after steps 2 and 3 have run for a week, with its own review.

## 4. Step 2: the Discord mirror

### 4.1 Process and wiring

- New `bridge/chathub.js` loads `chat` and `@chat-adapter/discord` with dynamic `import()` and creates `new Chat({ userName, adapters: { discord }, state })` only when `discord.enabled` is true.
- The bridge serves `127.0.0.1`, a random port, a random path secret, as `webhookUrl`. The handler checks `x-discord-gateway-token` against the bot token with a constant-time compare, then calls `discord.handleWebhook`. It never logs request headers or bodies.
- `discord.respondToChannelIds = [discord.channelId]`, so every message in the channel and its threads is delivered. The bridge's own filter (4.5) decides what runs.
- The Gateway listener runs with a long `durationMs` (6 h) and an `abortSignal` the shutdown fires. When it resolves early or fails, the bridge logs once and starts it again after 5 s, 30 s, then 5 min.
- At start, the bridge calls `bot.thread(threadId).subscribe()` for each link, because the memory state forgets subscriptions on restart.
- The Chat handler only admits the job (4.3) and returns. It never waits for the run, so the thread lock is released at once and a second message is not dropped.

### 4.2 Links and chat identity

- `state.discordLinks`: `{ [chatId]: { threadId, createdAt } }`, the source of truth.
- In game, `/claude discord` on a coding chat links it. The addon sends the flag token `discord=link` only when the slot field `discord` says the bridge supports it, so an old bridge never sees it. The bridge creates a thread in `discord.channelId`, named after the chat, and posts the last 5 transcript messages as a recap.
- In Discord, a top-level message in `discord.channelId` starts a new chat: the bridge makes the chat id and links the thread the adapter opens for it. A leading `#name` picks a project, matched only against `PJ.knownProjects()` labels, never as a path, and only for a new chat. An unknown name gets "Unknown project" and starts nothing.
- One chat id everywhere: `Cli.AttachTo` creates the addon chat with the entry's `chat` id when it has one and the addon does not know it, instead of a new id. So attaching a Discord-started chat from `/claude -r` gives the game the same chat id, the same link and the same session.
- `forgetChat` deletes the link and posts "This chat was deleted in game" to the thread. A later message in that thread gets one line saying it is unlinked and runs nothing.

### 4.3 Inbound: Discord to a job

- The job: `chat`, `text`, `cwd` (the link's chat folder), `plugin: 'claude-code'`, `via: 'discord'`, `session: 'discord'`, and `id` from one global counter `state.discordSeq`. The own session token keeps Discord ids out of the game's dedup (`alreadyHandled` falls back to `state.lastId` for an empty session), signal ids and `state.lastId`.
- `client` is the client that last used the chat (transcript `client`), else `defaultClient()`. It sets the game context; a context older than 15 minutes is marked stale in the situation block. `maybeOfferRestore` skips chats whose last message came from Discord.
- Settings parity: the bridge keeps the last game job's agent, permission mode, effort and model per chat (`state.chatSettings`) and applies them to Discord jobs. A Discord job never changes them.
- The job enters through the admission function from step 0c.

### 4.4 Outbound: a job to Discord

- `finish()` and `lateReply()` post to the linked thread, whatever transport the message came from. Discord gets the full reply text, not only the summary.
- Progress: the shared point where `runAgent` publishes `working` records (not `core.progress`, which `runAgent` does not use) feeds one Discord message that is edited at most every 3 s.
- Text goes out in chunks of at most 1900 characters, split at line ends, with a hard split for a longer line. A test sends a 6000-character reply and asserts every character arrives.
- `allowed_mentions: { parse: [] }` on every post. Game tokens become plain names from the synced game data, or are stripped.
- A denied tool posts "This run needs permission for <rule>. Grant it in game (Claude window, this chat)."

### 4.5 Security

- `discord.userIds` is required and must not be empty, or the hub does not start. A message runs only when the author id is on the list, the author is not a bot, and it has no `webhook_id`. Others are dropped and logged by user id only. DMs are ignored.
- The bot token comes from `CLAUDE_WOW_DISCORD_BOT_TOKEN`, else the file `<home>/discord.token` (mode 0600). The token file is added to `homeGuardRules` next to the live token, so no agent run can read it. `config.json` never holds the token. The bridge removes the environment variable from its own environment at start (a few lines, written here; PR #122's helper is not merged). Tests assert both the environment and the Read denial.
- `claude-wow service install` does not carry shell variables, so the token file is the way for the background service; setup says so.
- What leaves the machine: reply and progress text, which can hold file contents and paths. The owner opts in with `discord.enabled`. No game context block, image or attachment is ever posted.

### 4.6 Config

```json
"discord": {
  "enabled": false,
  "applicationId": "",
  "publicKey": "",
  "channelId": "",
  "userIds": []
}
```

## 5. Step 3: the game side

- Slot field `mirror`: per linked chat, the latest messages that came from Discord or answered one, each with `seq` (a per-chat bridge counter), `role`, `text`, `source: "discord"`, and for a permission ask the structured `denied` rules, `agent` and the job id, as a normal reply carries.
- The addon appends what it has not seen, tagged `(Discord)`. When the oldest `seq` in the field is past the next one it expects, it adds one line: "N earlier messages are in Discord." A mirrored permission ask shows the existing Allow button; Allow sends the usual "Allowed:" message on the same chat id.
- The addon reads slots only when the player acts or at an idle poll (memory: addon slot reads stop when idle), so a Discord exchange can show in game late. Accepted for v1.
- Transport: one slot field, one flag token (`discord=link`), no new record kind, no reused id or flag letter (memory: transport budgets).

## 6. Step 4: WoW as an adapter

- `bridge/chat-adapter-wow.js` implements `encodeThreadId` (`wow:<chatId>`), `decodeThreadId`, `postMessage`, `editMessage` and `fetchMessages` over the existing publish path and transcripts. `submit()` hands new game messages to it, and one handler and one fan-out serve both transports.
- It changes the core message path, so it needs its own review and must keep every existing e2e test green without changing their assertions.

## 7. Tests

- Unit: link table, allowlist (empty refuses to start; bot and webhook authors run nothing), job identity (two Discord chats with the same id both run; `state.lastId` does not move), settings parity, the 1900-character split, token stripping, token removal and Read denial, `#name` against labels only.
- e2e with a fake Discord: `apiUrl` points REST calls at a local fake that records them; Gateway events are posted to the bridge's webhook URL with the gateway token header, in the format the spike records. No real Discord in CI.
- Round trips: a Discord message starts a chat and gets a reply in its thread; three messages during one run all get replies in order; a game message on a linked chat posts to the thread; a non-listed user runs nothing; a restart, then a message in an old thread, runs a job; a Discord-started chat attached in game keeps its chat id and both sides keep syncing; a denied tool is granted in game and the run goes on; a 6000-character reply arrives whole.

## 8. PR #122

Superseded by step 2. Close it unless the owner wants one-way pings before step 2 ships.

## 9. Decisions for the owner

1. Close #122 now (recommended) or keep it as a stopgap.
2. Discord-started chats in v1 (recommended) or link-from-game only.
3. Step 4 after a week of steps 2 and 3 (recommended) or right after step 3.
