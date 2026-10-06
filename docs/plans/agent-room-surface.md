# WoW as an agent-room surface: run and answer the factory from inside the game

Status: draft, revision 1, 2026-10-06. Owner decision so far: agent-room is the agent runtime (memory `agent-room-decided`); the goal is to trigger and interact with the factory from inside WoW.

## Thesis

agent-room already has one runtime, one SQLite file and two surfaces: Slack (Socket Mode) and its own web client, the room. WoW becomes a third surface. The claude-wow bridge stops being an agent runtime for factory work and becomes a transport adapter: addon records go to agent-room as room client messages, and agent-room events come back to the game as chats, progress lines and Loot rolls.

Then one place holds every thread, approval and effect, whether you are in Slack, in the room or in the game, and the factory (claude-wow's own and the every-io/every one in `~/.claude/plans/factory-architecture-v3.md`) is driven the same way from all three.

## What already exists

| Need | agent-room (MacBook `~/agent-room`, `@rdimascio/room`) | claude-wow |
|---|---|---|
| A client protocol | `src/web/protocol.ts`, `PROTOCOL_VERSION` 2, WebSocket: client `send`, `approve`, `approve_other`, `cancel`, `run_workflow`, `cancel_run`; server `message`, `chunk`, `status`, `approval`, `thread`, `run`, `notice` | the slot/strip transport, chats, `lateReply`, the Loot roll |
| Durable approvals | `approvals.ts`: a row, a card, a conditional `UPDATE … WHERE status = 'pending'`, buttons only, typed answers never count | Loot roll Need/Greed/Pass, no durable row |
| Effects | `effects.ts`: claim before act, `ambiguous` on crash, never retried | none (factory `runs.json` only) |
| Background work | `workflows.ts`: a run is a thread; steps may run a `SKILL.md` | `factory.js`: `factory_dispatch` runs a skill as `claude -p` |
| Shipping claude-wow | none | `autoDeploy` (PR #166): a merge to main deploys itself, the game asks for `/reload` |
| Auth | a loopback-only server and one bearer token (`web_token` in its `meta` table); one owner | none: bridge records are unauthenticated (memory `bridge-records-are-unauthenticated`) |

## The constraint that sets the scope

Factory v3 (§3, §5) counts Ryan's merge "yes" (`ryan_yes`) only as an agent-room card clicked in Slack by his Slack `user_id`, and says the room web client cannot answer factory cards, by design. A Loot roll click in game reaches the bridge as a screenshot or SavedVariables record. Any process on the Mac mini that can write a file in the game folder can forge one. So:

- **A game click never answers `ryan_yes` or any every-io/every factory card.** The game shows the card, its payload and its state, and says "answer in Slack". Slack on the phone is one tap away.
- **A game click may answer kinds whose worst case is bounded:** claude-wow's own work (a dev-repo merge that auto-deploy ships to Ryan's own game), worker permission rolls for claude-wow runs, `alert_ack`. These need a new per-kind rule in agent-room's settle path: which surface may answer which kind. That is agent-room code; nothing is written there without Ryan's go.

## Work

### 0. Decisions before code

1. Where agent-room runs. Factory v3 moves it to the Mac mini, where the game and the bridge run. This plan assumes that; a MacBook agent-room would need the WebSocket over Tailscale, which its loopback-only rule refuses.
2. The kinds a game click may answer (the list above), and whether claude-wow merges get a card at all or keep merging through `merge-train`.
3. Whether the async-agents plan (`docs/plans/async-agents.md`, revision 4) stops here. agent-room threads and workflows cover its wake-ups and worker approvals; this plan proposes to supersede its Phases 1 to 3 and keep only Phase 0 (`threads`, merged) and `autoDeploy`.

### 1. Read-only mirror

- The bridge connects to agent-room's WebSocket on loopback with the room token (read from agent-room's config, never written into claude-wow's config or argv).
- One agent-room channel per mapped game chat: `plugins.room.channels` maps a channel slug to a game chat. Server `message` and `chunk` events become late replies and progress lines in that chat; `approval` events become a read-only card line ("Factory asks: merge PR #18765 at 1a2b3c? Answer in Slack").
- Reconnect with backoff; the slot data says when the room is unreachable, so the game never shows a stale state as live.
- No game action reaches agent-room yet.

### 2. Talk and trigger

- A message in a mapped chat becomes a room `send` to that thread. A new thread when the chat has none.
- `/claude factory <workflow> <args>` becomes `run_workflow`; the run's thread becomes a game chat.
- `cancel` and `cancel_run` from `/claude cancel`.
- A message waits in the bridge's queue while the room is down, and the chat says so.

### 3. Answer what the game may answer

- After decision 0.2 and agent-room's per-kind surface rule: an `approval` event for an allowed kind becomes a Loot roll; Need/Greed/Pass map to the card's choices by index (`approve`, never the choice text).
- Every other kind stays read-only in game.

### 4. Retire the bridge's own factory

- claude-wow's `factory_dispatch`, `runs.json` and the dispatcher rules move to agent-room workflows once Phase 2 runs them. `autoDeploy` stays: it is the delivery leg on the Mac mini, and agent-room does not deploy.
- `autoDeploy` failures become a room `notice` in the claude-wow channel instead of a note in the next coding-chat message.

## What stays in claude-wow

- The transport (strip, slots, chat log, presence), the addon UI and the Loot roll.
- `ask` and the other in-game plugins that are not factory work.
- `autoDeploy`, setup and the reload notice.

## Open questions

- One room token gives full owner access. Should the bridge get a narrower token (one channel, no workflow edits) from agent-room?
- Does the game need the live checklist (`task_update` chunks), or is one progress line per thread enough in a whisper tab?
- How many factory threads can a game chat list show before it needs its own view?
