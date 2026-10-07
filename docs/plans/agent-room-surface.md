# WoW as an agent-room surface: run and answer the factory from inside the game

Status: draft, revision 3, 2026-10-06. Owner decisions: agent-room is the agent runtime and moves to the Mac mini; the game answers every card; every review card needs a presence signature (no Touch ID reader, so `.userPresence`). Revision 3 adds the push channel (1a) the mirror needs; agent-room was installed on the Mac mini on 2026-10-06.

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

## Any surface answers any card: the yes is proven by presence, not by the surface

Factory v3 (§3, §5) counts Ryan's merge "yes" (`ryan_yes`) only as a Slack click by his Slack `user_id`, because a click elsewhere can be forged: a Loot roll reaches the bridge as a screenshot or SavedVariables record that any process on the Mac mini can write. We own every layer, so we fix the proof instead of fencing off the surface.

- **A presence signature.** `~/.claude/tools/factory-control/enclave-signer.swift` already holds a Secure Enclave P-256 key whose access control is `.biometryCurrentSet`: it signs only after a Touch ID match on that Mac, and `LAContext.localizedReason` shows the human what is being signed. No process can produce that signature, and a copied key blob is useless off the enclave.
- **The flow.** Need on a factory Loot roll → the bridge sends `approve` for that approval id and choice → agent-room's settle builds the canonical payload from its own row (`{kind, approvalId, choice, pr, head_sha}`, never from the game) → the signer asks for Touch ID with the reason "Merge PR #18765 at 1a2b3c (T2)" → the system dialog shows over the game → the signature is stored on the approval row as its proof.
- **The rule, per kind.** A card that needs Ryan (`ryan_yes`, money or auth writes) resolves only with a valid presence signature over its exact payload, verified against the public key agent-room stores at setup. Where the click came from (Slack, room, game) is recorded but no longer decides anything. A Slack click by Ryan's `user_id` stays a second valid proof, so his phone still works away from the desk. Low-risk kinds (`alert_ack`, a claude-wow worker roll) resolve on the click alone.
- **What this changes elsewhere.** Factory v3's merge station reads "an approved row with a presence signature or a Slack `user_id` proof for this head", not "a Slack click". That is a change to the every-io/every factory plan, owned with that plan, and to agent-room's settle path (`settleFactoryApproval`). Both are ours.
- **On the mini (decided 2026-10-06: no Touch ID reader).** The key is created on the Mac mini with `.userPresence` instead of `.biometryCurrentSet`: each signature asks for the Mac login password or an Apple Watch double-click, in a system dialog that shows over the game. The secure input dialog keeps the password out of reach of other processes. It proves a person who knows the password (or wears the paired watch) was at the Mac, not a fingerprint; a Touch ID keyboard later only changes the key's access flag.

## Work

### 0. Decisions

1. **Decided 2026-10-06:** agent-room is installed on the Mac mini, where the game and the bridge run, so the bridge reaches its room server on loopback.
2. **Decided 2026-10-06:** every card that asks for Ryan's review needs a presence signature (merges, money, auth, discoveries); no Touch ID reader, so the key uses `.userPresence`. Only machine acknowledgements without a decision (`alert_ack`) resolve on the click alone.
3. Open: whether the async-agents plan (`docs/plans/async-agents.md`, revision 4) stops here. agent-room threads and workflows cover its wake-ups and worker approvals; this plan proposes to supersede its Phases 1 to 3 and keep only Phase 0 (`threads`, merged) and `autoDeploy`.

### 1a. A push channel from the bridge to the game

The bridge can only answer today. Three facts (memories `addon-slot-reads-stop-when-idle`, `claudewow-transport-budgets`): the addon reads slot data only on a send, at login, or at the 600 s idle read when the presence channel does not work; it shows one late reply per message id (`lateSeen`); and each slot read spends one of the 200 slot loads a `/reload` gives. A factory event that arrives while you play would wait for your next message, and a second one would be dropped.

- **News ring.** A third presence-style ring of launch-time files (`ClaudeWoW_Runtime/news/NNNN.wav`, armed by setup and at bridge start like the presence rings). The bridge deletes the next file when it has pushes; the addon checks the next file every tick (no slot cost) and loads one slot when it reads missing. Several pushes between two reads share one slot load. The ring re-arms at each launch, like presence.
- **Push records.** A new slot and `Inbox.lua` field `pushes`: `{ seq, chat, title, text, kind }` with a bridge-wide increasing `seq` kept in `state.json`, separate from message ids, so `lateSeen` and `alreadyHandled` never see it. The addon shows each push whose `seq` is above its saved `pushSeen` and ignores the rest.
- **Push chats.** `chat` is a stable bridge-chosen id (`room:<channel slug>`). The addon makes that chat the first time a push names it, bound to the `room` plugin, the way it keeps the hidden "Stream control" chat.
- **Gates.** The bridge advertises `push` in the slot data (memory `addon-bridge-roundtrip-rules`); an older addon ignores the field, an older bridge sends none. Reload mode reads pushes from `Inbox.lua` at each reload; it has no ring.

### 1b. Read-only mirror

- The bridge connects to `ws://127.0.0.1:4319/ws` with the room token in the query string (the room server allows a client with no `Origin`). The token is read at connect time from `meta.web_token` in `~/.agent-room/bot.sqlite` with `/usr/bin/sqlite3 -readonly`, held in memory only, never written into claude-wow's config, env, argv or logs.
- One game chat per followed agent-room channel (`plugins.room.channels`, slugs; default: every channel of the `wow-ai` workspace). Server `message` events (final messages only, not `chunk` deltas) become pushes in that channel's chat; `approval` events become a card line ("Factory asks: merge PR #18765 at 1a2b3c?"), answerable from Phase 3.
- Reconnect with backoff; the slot data says when the room is unreachable, so the game never shows a stale state as live.
- No game action reaches agent-room yet.

### 2. Talk and trigger

- A message in a mapped chat becomes a room `send` to that thread. A new thread when the chat has none.
- `/claude factory <workflow> <args>` becomes `run_workflow`; the run's thread becomes a game chat.
- `cancel` and `cancel_run` from `/claude cancel`.
- A message waits in the bridge's queue while the room is down, and the chat says so.

### 3. Answer every card from the game

- Every `approval` event becomes a Loot roll; its buttons map to the card's choices by index (`approve`, never the choice text), and "Something else…" opens the reply box for `approve_other`.
- agent-room: the per-kind presence policy and the signature check in the settle path, the signer called with a reason built from the row, and the public key stored at setup. A kind that needs presence shows "Touch ID to confirm" on the roll; a failed or cancelled Touch ID leaves the card pending and says so in the chat.
- The every-io/every factory: the merge station accepts a presence-signed row as Ryan's yes.

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
