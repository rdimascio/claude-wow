# Async agents: one thread per project, work while you play

Status: draft, revision 2, 2026-10-05.

## Thesis

The game is the control room, not a chat client. Each project has one long-lived thread that plans and decides. Workers (sub-agent runs) do the work in the background, in game or with the game closed. You see results, approve risky steps and give feedback from inside the game. Claude Code is the harness for all of it, and nothing in the model is specific to code.

## What exists

| Piece | Where |
|---|---|
| Headless resumable sessions per chat, per folder | `bridge/plugins/claude-code.js`, `state.sessions` |
| Projects: a chat attached to a repo by label or path, a project picker | `/claude --project <name\|path\|none>`, `#name`, `bridge/projects.js` |
| A dispatcher that starts skill runs and reports on them | `bridge/factory.js` (`factory_dispatch`, `factory_status`, `maxRunning`, `timeoutMs`) |
| Approvals as Need/Greed rolls, mid-run for live sessions | `addon/ClaudeWoW/LootRoll.lua`, `bridge/plugins/live.js` |
| Per-message cost cap | `agents.claude.maxCostUsd` (PR #101) |
| Run traces, dev tools, feedback store | `state.lastRuns`, `bridge/plugins/dev.js`, `feedback.jsonl` (PR #114) |
| Goals and an Orders card | `bridge/goals.js`, `addon/ClaudeWoW/Orders.lua` |
| MCP servers for in-game runs | `docs/plans/mcp-and-agent-controls.md` |

## What does not hold today

Each of these breaks the model as written and has a phase below that fixes it.

| Fact | Where | Why it matters |
|---|---|---|
| One running and one queued job per chat; a different queued job replaces the first | `dispatchMessage`, `queued.set(key, job)` in `bridge/bridge.js` | Wake-ups and player messages on one thread overwrite each other |
| A session is dropped when `systemRulesHash` changes: game context present or not, or rules text edited by a release | `runJob` in `bridge/bridge.js`, `protocol.js` | A thread kept for weeks is reset by a closed game or a daily self-update |
| Need writes the rule into `agents.claude.allowedTools` for good; a headless run is denied and ends first | `allowRules` in `bridge/bridge.js`, `LootRoll.lua` | Need is a permanent grant, not a per-action approval |
| Factory runs use `acceptEdits`, `maxCostUsd: undefined`, and the default skills include `merge-train` | `bridge/factory.js` | Jobs built on the factory are not read-only and not capped |
| Factory runs are marked `lost` on restart and `killed` on stop | `bridge/factory.js` | A deploy or crash ends every job silently |
| A run result is one late reply per chat (`<chatKey>#late`); two results before a slot read keep only the newer | `bridge/bridge.js`, `docs/CONFIGURATION.md` | Mail cannot be built on late replies |
| The addon reads slots after a send or at the 10-minute idle check; 200 slots per UI session | `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md` | Nothing can be pushed live to raid frames |
| Agent runs are denied `Read(//<home>/**)` and `Edit(//<home>/goals/**)` only; `Write`, `Edit` and `Bash` elsewhere in `<home>` are allowed | `docs/LIVE-SESSION.md` | A worker could forge `jobs.jsonl` or `audit.jsonl` |
| Only `/claude cancel` (one chat) exists | `addon/ClaudeWoW/ClaudeWoW.lua`, `cancelRun` | `stop all` is new and needs a capability gate |

## The model

- **Project**: the existing project label (a folder plus a name). A repository, a notes folder for a business, a research folder, a guild. Its `CLAUDE.md` and skills say what the domain is.
- **Thread**: one Claude Code session per project, kept for weeks. It holds goals and decisions, and it delegates. Whether compaction and memory files keep its context in bounds is what Phase 0 measures; nothing in this repo shows it yet.
- **Job**: one unit of delegated work: a prompt or a skill, a folder, allowed tools, a budget in USD, a time limit, and a done-when line. States: `queued`, `running`, `needs-you`, `done`, `failed`, `stopped`. Stored per project in `<home>/projects/<id>/jobs.jsonl`, mode 0600, written only by the bridge.
- **Worker**: the headless run that executes a job, in a fresh session. It reports back through its result, never by editing the thread.
- **Wake-up**: when jobs end, the bridge starts one thread turn with their summaries. The thread decides the next step: another job, a question for you, or nothing.

## Turns on a thread

- One turn in flight per thread, enforced in the bridge.
- Waiting turns go in a per-chat FIFO, not the single `queued` slot. Player messages keep their order.
- Job results that arrive while a turn runs are coalesced into one pending "job results" turn. None is dropped; any drop is logged and audited.
- A wake-up carries the same context shape as a player turn, so it never changes `systemRulesHash`. Thread sessions are not reset by a rules change; the new rules go in the next turn's prompt instead.

## In the game

| Game object | Agent meaning |
|---|---|
| Quest log | the project's open jobs, with state and budget used |
| Mail | finished job results and the "while you were away" digest at login, from a `jobs` list record in the slot file with ids in their own namespace |
| Loot roll | an approval: `needs-you` jobs and risky tool calls |
| Raid frames | running workers as of the last slot read: elapsed time, cost from finished results only; no extra slot loads per worker step |
| Orders card | the thread's current focus |
| `/claude wrong` | feedback on a job result, read by the thread on its next turn |

## Safety rules

- Every job has a budget (`--max-budget-usd` on its fresh worker session) and a time limit.
- The project has a daily budget: per-turn `sessionUsage` deltas of the thread plus worker results, checked before each dispatch and each wake-up, never mid-run. Over budget = `stopped`, never silently continued.
- Job runs use `permissionMode: default` with read-only tools. Writes inside the project folder need a per-project grant. Skills that act outward (`merge-train`, `babysit-prs`, and the like) are off for jobs unless the project opts in.
- Outward actions (merge, send, post, pay) always become a `needs-you` roll. For job runs the roll offers only "allow once and re-dispatch this job"; Need never persists an outward rule (`neverOffered` or a run-only grant).
- Job runs get `Edit`, `Write` and `Bash` deny rules for `<home>`; the bridge checks `jobs.jsonl` and `audit.jsonl` on read.
- Wake-ups are capped: at most N thread turns per hour and none while a `needs-you` item is open for the same job.
- `/claude stop all` first blocks new dispatch and queued starts, revokes the dispatch grant of any running thread turn, then kills every worker and pauses wake-ups until `/claude resume`. It is new: the addon sends it only to a bridge that advertises it.
- On bridge start, `queued` jobs are dispatched again and `running` ones become `failed` with a wake-up.
- Every job, turn and approval is appended to `<home>/projects/<id>/audit.jsonl`, mode 0600.

## Order of work

Each phase ships alone and is measured on the real CLI.

0. **Measure.** One thread resumed headless for a week of real use, on a pinned bridge version with `autoUpdate: false` and thread sessions kept across rules changes. Go if all hold: tokens per resumed turn stay under a limit set before the run, cost per day under a set limit, and lost decisions under a set count. The limits and results go in `docs/plans/measurements/`.
1. **Project threads.** A project label pins exactly one chat; `--project X` from another chat switches to that chat. No new verb. `claude-wow handoff` stays as it is; a terminal session's recap can be sent to the thread as a job result.
2. **Jobs.** First, the job run defaults: read-only, `--max-budget-usd`, outward skills off, `<home>` deny rules, the per-chat FIFO. Then `job_dispatch`, `job_status` and `job_stop` tools for the thread, any skill or prompt, with the job file and restart recovery. Raid frames show workers.
3. **Wake-ups.** Job end starts a capped, coalesced thread turn. Login shows the digest as mail from the `jobs` record. `stop all` ships here.
4. **Approvals and feedback.** Depends on "4. Approval mid-run" in `docs/plans/mcp-and-agent-controls.md` (`--permission-prompt-tool`, not yet measured) for mid-run approval in headless runs. Until then a `needs-you` job stops and is re-dispatched after "allow once". Feedback attached to jobs.
5. **Beyond code.** Non-repository projects with MCP servers (mail, calendar, Notion, Linear) from the MCP plan, read-only first.

## Open questions

- Is one thread per project enough, or does a large project need one thread per goal?
- Should a wake-up turn run when the game is closed, or wait for login?
- How does the thread learn from `wrong` feedback beyond the next turn: a memory file it maintains, or a skill update it proposes?
