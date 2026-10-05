# Async agents: one thread per project, work while you play

Status: draft, revision 3, 2026-10-05. Revision 3 drops the new job system and the new game screens. It extends the factory instead: about 300 lines of bridge code, no addon or protocol change.

## Thesis

The game is the control room, not a chat client. Each project has one long-lived thread that plans and decides. Workers do the work in the background. When a worker ends, the thread wakes, reads the result and decides the next step. You see results, approve risky steps and give feedback from inside the game.

## What already does the job

| Need | Existing piece |
|---|---|
| One thread per project | A chat with `/claude --project <name>` (or `#name`); its session resumes per chat |
| Start background work, see its state | The factory: `factory_dispatch`, `factory_status`, `runs.json`, `logs/`, `maxRunning`, `timeoutMs` |
| A result reaches the game | `deliverFactoryRun` sends `FACTORY.describe(run)` to the dispatching chat as a late reply |
| Read-only workers | `plugins.claude-code.factory.permissionMode` (config) |
| Which skills a worker may run | `factory.skills` (config) |
| Allow one retry without a lasting grant | Greed on the Loot roll (`job.allowOnce`, run-only rules) |
| Feedback on a result | `/claude wrong` writes `feedback.jsonl` with the chat |
| A per-call cost cap | `--max-budget-usd`, already emitted from `maxCostUsd` |

## Limits we accept

- Results reach the game on the next slot read: when the player sends a message, at login, or at the idle check in `pixel` mode only. The default `screenshot` mode has no idle read.
- One late reply per chat: two results before a slot read show only the newer one. `factory_status` and the thread have all of them.
- Run-only grants cover the whole run, not one call. So a worker never gets an outward tool (merge, send, post, pay); it stops and proposes, and the thread or the player does the outward step in a normal turn with the normal roll.
- A worker with `Bash` runs as the same user as the bridge and can write `~/.claude-wow`. Workers get no `Bash` by default. A project that grants it accepts that, as `docs/LIVE-SESSION.md` already says for in-game runs.
- Cost is the CLI's list-price estimate per run. The day is bounded by `maxRunning` x the per-run cap x the wake-up cap, not by an exact daily budget.

## Work

### 0. Measure (gate for the rest)

- Code: a `threads` config list of project folders. For chats in those folders, `runJob` does not drop the session when `systemRulesHash` changes. The thread's system prompt must then stay stable: no factory skill list or other mutable text in it; those go in the turn prompt. About 10 lines.
- Run one thread for a week on a pinned bridge with `autoUpdate: false`. Record with `dev/measure-ask.js`: tokens per resumed turn, cost per day, decisions lost (a fixed recall checklist each day).
- Set the go limits before the week starts and record limits and results in `docs/plans/measurements/`. No go = stop here.

### 1. Factory hardening

- Config defaults for factory runs: `permissionMode: "default"`, read-only tools, no `Bash`, a skill list without outward skills (`merge-train`, `babysit-prs` and the like).
- `maxCostUsd` from factory config into the run (today `undefined`).
- A `deniedTools` option on `createFactory`, fed from the in-game deny list and the home guard rules. Factory runs get no deny rules today.
- One writing worker per checkout: refuse a second dispatch with write tools in the same folder while one runs.
- Free prompts, not only skills: a user skill `job` whose body is "do what the args say, then report".
- `factory_stop` tool: kill one run by id (`killTree`), marked `stopped`.
- `claude-wow factory stop` in the terminal: stop all runs and pause wake-ups. The pause is saved and survives a restart.
- Restart: a run left `running` is not re-dispatched blind. If its pid is still alive and is the same process, adopt or kill it; if its log has a result, deliver it; otherwise mark it `lost` and wake the thread with that fact.

About 120 lines plus tests.

### 2. Wake-ups

- In `deliverFactoryRun`, after the late reply, queue a wake turn on the dispatching chat: a synthetic job built the way `--inject` builds one (`via: 'wake'`, text = the run summary, the chat's session and folder).
- One wake slot per chat (`pendingWake`), separate from `queued`. A second result while one waits is appended to its text. The player's own message always runs first.
- Wake turns have their own parallel limit (1) and never take a player turn's place in `MAX_PARALLEL`.
- Caps: N wake turns per chat per hour and M across the bridge. Over the cap, the result waits for the player's next turn and the log says so.
- Delivery: the completion is saved with the run (`woken: false`) before the turn, and set `true` after the turn ends. At start, unwoken results are woken once. A wake turn that dispatches work is still bound by the factory caps.
- The thread's reply goes out as a late reply. Check before building: the addon dedups late replies by message id; the wake reply needs an id the addon does not drop.
- The wake text lists the chat's open `/claude wrong` items for that run.

About 100 lines plus tests.

### 3. Approvals

- When a worker ends denied, offer the existing roll on the dispatching chat with Greed only (Need hidden through `neverOffered`). Greed re-dispatches the run with `allowOnce`.
- Never offered for outward tools: those are not in a worker's tools at all.
- Mid-run approval for headless runs waits for "4. Approval mid-run" in `docs/plans/mcp-and-agent-controls.md`.

About 60 lines plus tests.

### Later, only if use shows the need

- A `workers: n` field on the Orders card.
- Quest log, Mail and Raid frame views.
- Non-code projects: a notes folder with a `CLAUDE.md` works today; MCP servers come from the MCP plan.

## Open questions

- Should wake turns run when the game is closed, or wait for login? Revision 3 runs them; the caps bound the cost.
- Is one thread per project enough, or does a large project need one per goal?
- How does the thread keep `wrong` feedback beyond the next turn: a memory file it maintains, or a skill update it proposes?
