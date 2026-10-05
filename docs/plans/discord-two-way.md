# Plan: two-way Discord sync for coding chats, with WoW as one transport

Status: draft, revision 1 (2026-10-05). It replaces Part A of `docs/plans/discord-and-project-threads.md` and supersedes PR #122 (one-way webhook). Code references name functions, not line numbers. **(unverified)** marks claims nobody has checked yet.

## 1. Goals and non-goals

**Goals**
- A coding chat is one thread that lives in two places: the game and a Discord thread.
- A message typed in either place runs the same Claude session. The reply and the progress lines show in both places.
- The owner can start, continue and check coding work from Discord with the game closed, and pick it up in game later.

**Non-goals**
- No iMessage, Slack or other platforms. Chat SDK makes them possible later; this plan does not build them.
- No multi-user use. One owner, one private Discord server, an allowlist of Discord user IDs.
- No permission grants from Discord in v1. A run that hits a denied tool says so in Discord and asks the owner to grant it in game.
- No game chats (`ask` plugin) in Discord. Coding chats (`claude-code`) only.

## 2. Library facts (checked 2026-10-05)

| Fact | Source |
|---|---|
| `chat` 4.41.1 and `@chat-adapter/discord` 4.41.1 are MIT, ESM only (`"type": "module"`), Node >= 20. The Discord adapter depends on `discord.js` ^14. | `npm view` |
| An adapter delivers incoming messages only by calling `this.chat.processMessage(adapter, threadId, factory, options)`, normally inside `handleWebhook`. A custom adapter can call it from anywhere it owns. | chat-sdk.dev, "Building an adapter" |
| Discord does not push channel messages to HTTP. The adapter's `startGatewayListener({ waitUntil }, durationMs, undefined, webhookUrl)` holds the Gateway WebSocket for `durationMs` and forwards each event to `webhookUrl`. | chat-sdk.dev, Discord adapter |
| Config: `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`; options `respondToChannelIds`, `apiUrl` (REST base URL override). Needs the Message Content intent. A top-level message gets its own Discord thread. 4000 characters per message. | chat-sdk.dev, Discord adapter |

Open questions, to answer with a spike before step 2: how a forwarded Gateway event is authenticated at `webhookUrl` **(unverified)**; whether `chat` and `discord.js` bundle into the `bun build --compile` binary **(unverified)**; the binary size cost **(unverified)**.

## 3. Order of work

1. Spike (throwaway branch): the Discord adapter in a plain Node script, Gateway forwarding to `127.0.0.1`, one round trip. Answers the three open questions. No PR.
2. Discord mirror: the bridge runs a Chat SDK instance with the Discord adapter. WoW keeps its native path. Discord messages run jobs; replies post to Discord.
3. Game side of the mirror: messages that came from Discord, and their replies, show in the game chat.
4. WoW as a Chat SDK adapter: game messages enter through `processMessage` like Discord ones, and one fan-out posts every reply. This is the "WoW is a transport" step.

Each step ships alone. Step 4 only starts after steps 2 and 3 have run for a week.

## 4. Step 2: the Discord mirror

### 4.1 Process and wiring

- New `bridge/chathub.js`. It loads `chat` and `@chat-adapter/discord` with dynamic `import()` (the bridge is CommonJS) and creates `new Chat({ userName, adapters: { discord }, state })` only when `discord.enabled` is true.
- The bridge starts an HTTP server on `127.0.0.1`, a random port, a random path secret. That URL is the `webhookUrl` for the Gateway listener. The server routes requests to `discord.handleWebhook`.
- The Gateway listener runs in a loop: when `durationMs` ends, it starts again. A failure waits 5 s, then 30 s, then 5 min, and logs each failure once.
- Shutdown stops the loop and closes the server before `process.exit`.

### 4.2 Links

- `state.discordLinks`: `{ [chatId]: { threadId, cwd, createdAt } }` in `state.json`. It is the source of truth; Chat SDK state is the memory adapter, refilled from the links at start.
- In game: `/claude discord` on a coding chat creates a Discord thread in `discord.channelId`, named after the chat, links it, and posts the last 5 messages from the transcript as a recap.
- In Discord: a message in `discord.channelId` that mentions the bot starts a new chat. The bridge makes a chat id, uses `discord.defaultCwd` (else the bridge default folder), and links it. `#name` picks a project, as in game (`bridge/projects.js`).
- A chat started in Discord has no addon record. It shows in game in the `/claude -r` list (`ownSessions` already lists every `chat:` session), and attaching it there continues the same session.

### 4.3 Inbound: Discord to a job

- `onNewMention` and `onSubscribedMessage` on a linked thread build a job shaped like an inject job: `chat`, `id` (a per-chat counter in `state.discordSeq`), `text`, `cwd`, `plugin: 'claude-code'`, `via: 'discord'`, no `client`.
- The job goes through `dispatchMessage`, so the queue, `maxParallel` and the one-run-per-session rule (plan #116 B1) apply.
- Slash commands (`/runs`, `/stop`, `/<skill>` from PR #117) work the same, because they are handled in the coding plugin.
- Game context: a Discord job uses the last context the game reported, and says it may be stale in the situation block.

### 4.4 Outbound: a job to Discord

- `finish()` and `lateReply()` post the reply to the linked thread when the chat has a link, whatever transport the message came from.
- `core.progress` lines become one Discord message that is edited, at most once every 3 s.
- Long replies are split at 4000 characters on line ends.
- Game tokens (`{item:...}`) are expanded to plain names from the synced game data, or stripped when there is none, before they reach Discord.
- A denied tool posts "This run needs permission for <rule>. Grant it in game." with no button.

### 4.5 Security

- `discord.userIds` is required and must not be empty, or the hub does not start. Messages from any other user, from bots, and from webhooks are dropped and logged by user id only.
- `discord.channelId` is required. DMs are ignored in v1.
- The bot token comes from `CLAUDE_WOW_DISCORD_BOT_TOKEN` (or `discord.botToken`). The bridge reads it once at start and removes it from its environment, like `notify.takeSecret`, so no agent run inherits it. Tests assert this.
- A Discord job runs with the same permission mode and allowlist as a game job. A Discord message is remote input to a local agent with file edits on; this is the reason for the user allowlist.

### 4.6 Config

```json
"discord": {
  "enabled": false,
  "applicationId": "",
  "publicKey": "",
  "channelId": "",
  "userIds": [],
  "defaultCwd": ""
}
```

## 5. Step 3: the game side

- A new slot field `mirror`: per chat, the last 20 messages that came from Discord or answered one, each with a bridge sequence number `seq`, `role`, `text` and `source: "discord"`.
- The addon appends the messages it has not seen (by `seq`, stored per chat) to the chat history, tagged `(Discord)`. An old addon ignores the field.
- The game shows them on its next slot read. While the addon is idle with working presence it reads nothing (memory: addon slot reads stop when idle), so a Discord exchange can wait until the player acts. This is accepted for v1.
- Transport budget: one slot field, no new record kind, no new message id or flag letter (memory: transport budgets).

## 6. Step 4: WoW as an adapter

- New `bridge/chat-adapter-wow.js` implements the Chat SDK `Adapter` interface: `encodeThreadId` (`wow:<chatId>`), `decodeThreadId`, `postMessage` (the existing publish path to the client that holds the chat), `editMessage` (progress records), `fetchMessages` (the transcript).
- `submit()` hands each new game message to the adapter, which calls `this.chat.processMessage`. One handler then runs the job and one fan-out posts the reply to every linked thread.
- `finish()` and `lateReply()` stop calling each transport directly.
- This step changes the core message path, so it needs its own fresh-eyes review and must keep every existing e2e test green with no edits to their assertions.

## 7. Tests

- Unit: link table, allowlist (empty list refuses to start), job shape, reply split at 4000, token stripping, secret removal.
- e2e with a fake Discord: the adapter's `apiUrl` points REST calls at a local fake server that records them. Gateway events are posted straight to the bridge's local webhook URL in the forwarded format the spike records. No real Discord in CI.
- Round trips: a Discord mention starts a chat and gets a reply in the thread; a game message on a linked chat posts to the thread; a Discord message from a user not on the list runs nothing; a denied tool posts the grant-in-game line; the game shows the mirrored messages (step 3).

## 8. What happens to PR #122

PR #122 (one-way webhook) is superseded: step 2 posts the same events with a reply. Close it unless the owner wants pings before step 2 ships.

## 9. Decisions for the owner

1. Close #122 now (recommended) or keep it as a stopgap.
2. Discord-started chats: allowed in v1 (recommended) or link-from-game only.
3. Step 4: after a week of steps 2 and 3 (recommended) or right after step 3.
