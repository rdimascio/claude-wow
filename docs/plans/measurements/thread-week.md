# Phase 0 measurement: one project thread for a week

Plan: [`async-agents.md` §0](../async-agents.md). Phase 1 does not start until this week passes its go limits.

## Go limits (set before day 1)

The owner confirms or changes these numbers before day 1 and does not change them during the week. A day that breaks a limit is a no-go day. Two no-go days, or a no-go on day 7, stops the plan.

| Measure | Source | Go limit |
|---|---|---|
| Context per resumed turn | `ctx X of Y` on the bridge log `done` line | Median of day 7 at most **300k** tokens. No turn above **600k**. |
| Cost per resumed turn | the `~$Z API so far` session total, today minus yesterday, over the day's turns | Mean at most **$0.15**. |
| Thread cost per day | the same session total, end of day minus start of day | At most **$5**. |
| Worker cost per day | sum of `costUsd` in `~/.claude-wow/factory/runs.json` for runs that ended that day | Recorded, no limit (Phase 1 adds the cap). A run with `costUsd: null` is counted as unknown, never as 0. |
| Decisions lost | the daily recall checklist below | At most **1** item lost per day, and **0** on days 6 and 7. |
| Session kept | the bridge log | Every turn after day 1 says `resume <id>` with the same id. A `new session` line for the thread chat is a no-go day. |

Baseline for comparison, not a limit: the resumed turn in [`step1-ask-model.md`](step1-ask-model.md) cost $0.02 to $0.04 with a 44k prefix. Run `node dev/measure-ask.js --models <the thread's model> --only where-trainer --budget 1` on day 0 only if the thread uses a model that file does not have.

## Setup (day 0)

- [ ] Deploy the release with `plugins.claude-code.threads`. Set `"autoUpdate": false` in `~/.claude-wow/config.json` so the release stays pinned for the week.
- [ ] Add the project folder to `plugins.claude-code.threads`.
- [ ] Factory config, no Phase 1 code: `factory.skills` without `merge-train`, `babysit-prs`, `babysit-pr` or `every-ai-lead`; `factory.permissionMode: "default"`.
- [ ] Remove every `Bash` and write rule from `agents.claude.allowedTools` and `factory.allowedTools`. Workers inherit the shared list until Phase 1.
- [ ] All week, answer any roll with Greed or Pass, never Need. A chat Need writes the shared list and reaches the next worker at once.
- [ ] Open the thread chat (`/claude --project <name>`) and send `/claude n` once, so the week starts on a session made after the deploy. Its first system prompt is frozen for the week.
- [ ] Write down whether the game context was on for that first turn, and the session id from the `resume` or `new session` log line.
- [ ] Write the week's goal in one line in the log below.

## Daily record

At the end of each day, record from `~/Library/Logs/claude-wow/bridge.log` (the thread chat's `#<id>@<token>` lines) and `state.json` (`sessionUsage` for the chat):

- turns today, the context of the last turn, the highest context of the day
- the session total cost at the start and end of the day
- worker runs that ended today, their skills, status and `costUsd`
- any `new session`, `thread chat, the session is kept` or error line for the chat

## Decision log

When the thread makes a decision (a plan choice, a skill to dispatch, a result it accepts or rejects), write one line here with the day and the decision. The recall checklist tests these lines.

## Daily recall checklist

At the end of each day, ask the thread these in one message, in the thread chat. Score each answer **kept** (correct), **partial** (missing a detail that changes the next step) or **lost** (wrong, or "I do not know"). A partial counts as half a lost item.

1. What is the goal for this week, in one line?
2. Name the decision from the decision log that I pick today (a different one each day, oldest first), and say why it was made.
3. Which factory runs did you start since yesterday, and what did each one return?
4. Which `/claude wrong` items are open in this chat?
5. What is the next step, and what does it wait on?

Record the five scores and the total lost for the day.

## Results

| Day | Turns | Last ctx | Max ctx | Thread $ | Mean $ / turn | Worker $ | Lost | Go? |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| 3 | | | | | | | | |
| 4 | | | | | | | | |
| 5 | | | | | | | | |
| 6 | | | | | | | | |
| 7 | | | | | | | | |

## Verdict

Filled in after day 7: go or no-go, and which limit decided it.
