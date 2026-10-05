# Async agents: one thread per project, work while you play

Status: draft, revision 4, 2026-10-05. Revision 3 dropped the new job system and the new game screens and extends the factory instead. Revision 4 fixes what the third review found in the wake-up and approval paths: about 380 lines of bridge code, no addon or protocol change.

## Thesis

The game is the control room, not a chat client. Each project has one long-lived thread that plans and decides. Workers do the work in the background. When a worker ends, the thread wakes, reads the result and decides the next step. You see results, approve risky steps and give feedback from inside the game.

## What already does the job

| Need | Existing piece |
|---|---|
| One thread per project | A chat with `/claude --project <name>` (or `#name`); its session resumes per chat |
| Start background work, see its state | The factory: `factory_dispatch`, `factory_status`, `runs.json` (last 50 runs), `logs/`, `maxRunning`, `timeoutMs` |
| A result reaches the game | `deliverFactoryRun` sends `FACTORY.describe(run)` to the dispatching chat as a late reply |
| Worker settings, apart from chat settings | `plugins.claude-code.factory`: `model`, `effort`, per-skill `models`, `permissionMode`, `allowedTools`, `skills`, `maxRunning`, `timeoutMs` |
| Allow one retry without a lasting grant | Greed on the Loot roll (`job.allowOnce`, run-only rules) |
| Always allow | Need on the Loot roll (`allowRules`), today into the shared `agents.claude.allowedTools` |
| Feedback on a result | `/claude wrong` writes `feedback.jsonl` with the chat and reply id |
| A per-call cost cap | `--max-budget-usd`, already emitted from `maxCostUsd` |

## Limits we accept

- Results reach the game on the next slot read: the player's next message, login, or the addon's 600 s idle read. The idle read runs only while the presence channel is not working (either transport); with a working presence channel a result waits for the next message or login.
- One late reply per player message id. The addon shows a late reply only when its id is above the last late id it showed for that chat (`lateSeen`), and every late reply carries the id of the chat's latest message. So after one result or wake reply is shown, later replies on the same message wait for the player's next message (see 2). `factory_status` lists the last 5 runs, or any of the 50 in `runs.json` by id.
- A thread's system prompt is the one from its first turn (`--system-prompt-snapshot`). A rule change reaches it only through a new session (`/claude n`).
- After Phase 1: grants are per tool rule, not per call. Greed covers the whole re-dispatched run; Need covers every later worker. Outward tools (merge, send, post, pay) are not in the default worker list, so a worker stops and proposes. Need on one of them is the player's explicit choice to let workers do it unattended, and the reply text says so.
- After Phase 1: a worker with `Bash` runs as the same user as the bridge and can write `~/.claude-wow`. Workers get no `Bash` by default. A project that grants it accepts that, as `docs/LIVE-SESSION.md` already says for in-game runs.
- Cost is the CLI's list-price estimate per run. `maxRunning` and the wake caps bound concurrency and wake frequency, not daily spend. A run killed by its timeout has no recorded cost (no result event), so its spend is in no total. Wake turns are chat turns: they are capped only when `agents.claude.maxCostUsd` is set, and Phase 2 requires it.

## Work

### 0. Measure (gate for the rest)

- Code: a `threads` config list of project folders. For chats in those folders, `runAgent` does not drop the session when `systemRulesHash` changes. The factory skill list (`dispatcherRules`) moves from the system prompt to the turn prompt for thread chats only, so the thread's system prompt stays stable. About 40 lines plus tests.
- The week starts from one fresh session made after this change, and keeps it. The snapshot freezes whatever the first turn had (game open or closed, the primer); the measurement records which.
- Run one thread for a week on a pinned bridge with `autoUpdate: false`. Config only, no Phase 1 code: `factory.skills` without outward skills, `factory.permissionMode: "default"`, and no `Bash` or write rules in `agents.claude.allowedTools` or `factory.allowedTools` (workers inherit the shared list until Phase 1, so in-game coding chats ask more that week). Answer those rolls with Greed or Pass, never Need, that week: a chat Need writes to the shared list and reaches the next worker at once. Workers have no cost cap that week.
- Record from the bridge log's per-turn `turn N, ctx X of Y, ~$Z` line and `state.sessionUsage`: tokens per resumed turn, cost per day. Record decisions lost with a fixed recall checklist each day, by hand. `dev/measure-ask.js` gives a fresh-session baseline to compare against.
- Set the go limits before the week starts and record limits and results in `docs/plans/measurements/`. No go = stop here.

### 1. Factory hardening

- Workers use only the worker settings. Today a factory run's allow list is the shared `agents.claude.allowedTools` plus `factory.allowedTools`; it becomes `factory.allowedTools` alone, so a chat's Need rules never reach unattended runs.
- Config defaults for workers: `permissionMode: "default"`, read-only tools, no `Bash`, a skill list without outward skills (`merge-train`, `babysit-prs` and the like).
- New worker settings: `maxCostUsd` (today forced `undefined`) and `deniedTools`, merged with the in-game deny list and the home guard rules. Today workers get `agents.claude.deniedTools` but not the in-game deny list or the home guard; the `agents.claude.deniedTools` rules stay.
- One writing worker per checkout: refuse a second dispatch with write tools in the same folder while one runs.
- Free prompts, not only skills: a user skill `job` whose body is "do what the args say, then report".
- Each run saves its dispatching chat (client, addon session token, chat id) in `runs.json`. Today it saves only a display label, and the job lives in memory.
- `factory_stop` tool: kill one run by id (`killTree`), marked `stopped`.
- `claude-wow factory stop` in the terminal: stop all runs and pause wake-ups. The pause is saved and survives a restart.
- Restart: a run left `running` is not re-dispatched blind. If its pid is still alive and is the same process, adopt or kill it; if its log has a result, keep it; otherwise mark it `lost`. Either way the result goes to the deferred list of its chat (see 2), not to a wake.

About 130 lines plus tests.

### 2. Wake-ups

- A wake job is bridge-internal. It is built from the chat's latest job (same chat, session token, folder, `id`) with `via: 'wake'` and text = the run summary. It never enters `state.handled`, `state.inflight` or `lastId`, never acks or signals, and is not written to the transcript as a player line. It enters below `submit` and `dispatchMessage` (which dedup by id). For `via: 'wake'`, `runJob` skips its ack, signal and `noteHandling`, `runAgent` skips `noteInflight`, and the turn ends by freeing the chat's `running` slot and calling `lateReply` (or holding the text, see below) instead of `finish`. A job with the addon's next id would make `submit` drop the player's next message as already handled.
- In `deliverFactoryRun`: when a wake may run, queue it and skip the `describe` late reply (the wake reply replaces it). When wakes are paused or over a cap, send the `describe` late reply as today if the latest id has not carried one, and mark the result deferred.
- Deferred results: `woken: false` on the run in `runs.json`. The next turn on that chat, player or wake, gets them prepended to its prompt and marks them `woken: true`. No TTL; `devNotes` is not the carrier. `save()` never prunes a run that is still `woken: false` or has an unanswered `offered` roll.
- One wake slot per chat (`pendingWake`), separate from `queued`. A second result while one waits is appended to its text. A queued player message runs before a waiting wake. A player message that arrives while a wake runs waits for it, as it waits for any running turn of that chat.
- Wake turns have their own parallel limit (1). Only player turns count against `MAX_PARALLEL`.
- Caps: N wake turns per chat per hour and M across the bridge, in memory. Over the cap, the result is deferred and the log says so.
- At most once: `woken` is set `true` when the wake turn starts. A bridge crash during the turn loses that wake (no replay, so a wake that dispatched work never dispatches it twice); the result stays in `factory_status`. At start nothing wakes: unwoken results stay deferred, so a restart replays nothing and the saved pause holds. The hourly counters start again at zero.
- Running a wake and showing its reply are separate. A wake runs whenever the pause and caps allow, so a chain of workers goes on while the player is away. Its reply goes out with `lateReply` under the chat's latest message id when no late reply used that id yet (the `describe` reply was skipped). Otherwise the reply is held and put in front of the next reply the player gets in that chat. If the wake turn ends in an error, the `describe` text goes out the same way.
- The wake text lists the chat's open `/claude wrong` items since the dispatch.

About 120 lines plus tests.

### 3. Approvals

- When a worker ends, read `permission_denials` from the result event the factory already parses, classified with the `agents.js` denial code. Save them on the run in `runs.json`.
- The wake text tells the thread about the denial. The roll is offered with the reply to the player's next message in that chat: the run's rules are added to that reply's `denied` after the `deniedAgain` filter in `runAgent`'s close handler (the chat's grants do not apply to workers), so `finish` publishes them as it publishes chat denials today. The run is marked `offered`. One offered worker roll per chat: a later denial waits until it is answered or the player sends a message without a grant. The reply text says it is a worker roll and that Need lets every future worker do it unattended; the roll's hint stays the addon's.
- A Need or Greed click is a new message ("Continue from where you left off") with `allow=` or `allowOnce=`. When those rules match the chat's `offered` run in `runs.json`, the bridge skips `allowRules` and the agent turn: Greed re-dispatches the run with the rules run-only, Need writes them into `factory.allowedTools` and re-dispatches, and `finish` answers the message with the new run id. Rules that do not match follow the chat path.
- Pass sends nothing for a coding chat. The run stays `failed`; the thread already knows from its wake.
- Rules in the worker `deniedTools` are never offered (`neverOffered`).
- Mid-run approval for headless runs waits for "4. Approval mid-run" in `docs/plans/mcp-and-agent-controls.md`.

About 90 lines plus tests.

### Later, only if use shows the need

- A `workers: n` field on the Orders card.
- Quest log, Mail and Raid frame views.
- Non-code projects: a notes folder with a `CLAUDE.md` works today; MCP servers come from the MCP plan.

## Open questions

- Should wake turns run when the game is closed, or wait for login? Revision 4 runs them; the caps and `agents.claude.maxCostUsd` bound the cost.
- Is one thread per project enough, or does a large project need one per goal?
- How does the thread keep `wrong` feedback beyond the next turn: a memory file it maintains, or a skill update it proposes?
