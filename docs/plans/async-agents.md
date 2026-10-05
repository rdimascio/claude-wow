# Async agents: one thread per project, work while you play

Status: draft, 2026-10-05.

## Thesis

The game is the control room, not a chat client. Each project has one long-lived thread that plans and decides. Workers (sub-agent runs) do the work in the background, in game or with the game closed. You see results, approve risky steps and give feedback from inside the game. Claude Code is the harness for all of it, and nothing in the model is specific to code.

## What exists

| Piece | Where |
|---|---|
| Headless resumable sessions per chat, per folder | `bridge/plugins/claude-code.js`, `state.sessions` |
| A dispatcher that starts skill runs and reports on them | `bridge/factory.js` (`factory_dispatch`, `factory_status`, `maxRunning`, `timeoutMs`) |
| Approvals as Need/Greed rolls, mid-run for live sessions | `addon/ClaudeWoW/LootRoll.lua`, `bridge/plugins/live.js` |
| Per-message cost cap | `agents.claude.maxCostUsd` (PR #101) |
| Run traces, dev tools, feedback store | `state.lastRuns`, `bridge/plugins/dev.js`, `feedback.jsonl` (PR #114) |
| Goals and an Orders card | `bridge/goals.js`, `addon/ClaudeWoW/Orders.lua` |
| MCP servers for in-game runs | `docs/plans/mcp-and-agent-controls.md` |

## The model

- **Project**: a folder plus a name. A repository, a notes folder for a business, a research folder, a guild. Its `CLAUDE.md` and skills say what the domain is.
- **Thread**: one Claude Code session per project, kept for weeks. It holds goals and decisions, and it delegates. Claude Code compaction and the project's memory files keep its context in bounds.
- **Job**: one unit of delegated work: a prompt or a skill, a folder, allowed tools, a budget in USD, a time limit, and a done-when line. States: `queued`, `running`, `needs-you`, `done`, `failed`, `stopped`. Stored per project in `<home>/projects/<id>/jobs.jsonl`, written only by the bridge.
- **Worker**: the headless run that executes a job. It reports back through its result, never by editing the thread.
- **Wake-up**: when a job ends, the bridge starts one thread turn with the job's summary. The thread decides the next step: another job, a question for you, or nothing.

## In the game

| Game object | Agent meaning |
|---|---|
| Quest log | the project's open jobs, with state and budget used |
| Mail | finished job results and the "while you were away" digest at login |
| Loot roll | an approval: `needs-you` jobs and risky tool calls |
| Raid frames | running workers: elapsed time, cost, last step |
| Orders card | the thread's current focus |
| `/claude wrong` | feedback on a job result, read by the thread on its next turn |

## Safety rules

- Every job has a budget and a time limit; the project has a daily budget. Over budget = `stopped`, never silently continued.
- Unattended jobs get read-only tools by default. Writes inside the project folder are allowed per project. Outward actions (merge, send, post, pay) always become a `needs-you` roll.
- Wake-ups are capped: at most N thread turns per hour and none while a `needs-you` item is open for the same job.
- `/claude stop all` stops every worker and pauses wake-ups.
- Every job, turn and approval is appended to `<home>/projects/<id>/audit.jsonl`.

## Order of work

Each phase ships alone and is measured on the real CLI.

0. **Measure.** One thread resumed headless for a week of real use: context size after compaction, cost per day, how often it loses a decision. Go or no-go for the model.
1. **Project threads.** `/claude project <name> [folder]` binds one chat per project; the project list replaces the per-folder chat sprawl. `claude-wow handoff` becomes "attach the latest session to its project thread".
2. **Jobs.** Generalize the factory into `job_dispatch`, `job_status` and `job_stop` tools for the thread, any skill or prompt, with budgets and the job file. Raid frames show workers.
3. **Wake-ups.** Job end starts a capped thread turn. Login shows the digest as mail.
4. **Approvals and feedback.** `needs-you` jobs and outward actions as rolls; feedback attached to jobs.
5. **Beyond code.** Non-repository projects with MCP servers (mail, calendar, Notion, Linear) from the MCP plan, read-only first.

## Open questions

- Is one thread per project enough, or does a large project need one thread per goal?
- Should a wake-up turn run when the game is closed, or wait for login?
- How does the thread learn from `wrong` feedback beyond the next turn: a memory file it maintains, or a skill update it proposes?
