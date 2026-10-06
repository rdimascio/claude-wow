# Step 5 spike: `claude -p --plugin-dir`

Plan: [`router-and-game-data.md` §7.1](../router-and-game-data.md#71-plugin-contents). Measured 2026-10-05 on Claude Code 2.1.285 (`~/.local/bin/claude`), in a scratch folder with a scratch plugin, never the live home.

## Answers

| Question | Answer |
|---|---|
| Does `--plugin-dir` survive `--setting-sources`? | **Yes.** The plugin's agents and skills are in the init lists with `--setting-sources ""`, `user` and `project,local`, and with `--strict-mcp-config`. |
| Does subagent usage appear in the result's `modelUsage`? | **Yes.** The subagent's model has its own `modelUsage` entry next to the main model, and `total_cost_usd` includes it. |
| Spend | **$0.066** in all (3 paid runs: $0.0336, $0.0213, $0.0113). Init probes were stopped at the init event, before a result. One more run hit the account's session limit and cost $0. |

## Method

- Scratch plugin `claude-wow`: `.claude-plugin/plugin.json`, one skill `wow-probe-skill`, one agent `wow-probe` (`tools: Read, Grep, Glob`, `model: sonnet`).
- Argv as a bridge run: `-p --output-format stream-json --verbose --permission-mode acceptEdits`, prompt on stdin, `CLAUDECODE` removed from the env.
- Init probes (`--model haiku`, the process killed at `system/init`, so no API turn is paid).
- Paid runs: `--model haiku --setting-sources "" --strict-mcp-config --max-budget-usd 0.5`, prompt "Use the claude-wow:wow-probe agent to answer this question: what is 6 times 7? Then reply with the line the agent returned, verbatim."

## Init lists

| Flags with `--plugin-dir <abs>` | Tools | Skills | Agents | Plugins | claude-wow in lists |
|---|---|---|---|---|---|
| (default sources) | 251 | 136 | 7 | 13 | `claude-wow:wow-probe-skill`, `claude-wow:wow-probe` |
| `--setting-sources ""` | 241 | 19 | 6 | 3 | same |
| `--setting-sources user` | 276 | 136 | 7 | 13 | same |
| `--setting-sources project,local --strict-mcp-config` | 29 | 19 | 6 | 3 | same |

- The plugin shows in `plugins` as `{ name: "claude-wow", source: "claude-wow@inline", version }`. Agents are namespaced `claude-wow:<name>`; skills too, and they are also slash commands.
- `--setting-sources ""` drops the user's installed plugins and skills but not the claude.ai connector MCP servers (241 tools). Only `--strict-mcp-config` drops those.
- **A relative `--plugin-dir` resolves against the run's working folder**, not the caller's. With the wrong folder the run goes on with no plugin; the only sign is `plugin_errors: [{ type: "path-not-found" }]` in the init event. The bridge runs `ask` in its own scratch folder, so the path must be absolute. Since feat/ask-plugin-scope the bridge passes the absolute `AS.dir` path itself (`plugins.ask.claudePlugin`).
- The `haiku` alias resolved to `claude-haiku-4-5-20251001`; the `sonnet` alias in agent frontmatter resolved to `claude-sonnet-5-5`.

## Subagent runs

| Run | Subagent mode | Results | Final text | `modelUsage` | `total_cost_usd` |
|---|---|---|---|---|---|
| default | background (`is_backgrounded: true`) | **2** | 1st: "I've launched the claude-wow:wow-probe agent ... in the background"; 2nd: `PROBE-AGENT-OK 42` | haiku $0.0252, sonnet-5-5 $0.0084 | $0.0336 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | foreground | 1 | `PROBE-AGENT-OK 42` | haiku $0.0204, sonnet-5-5 $0.0008 | $0.0213 |
| default, agent frontmatter `background: false` | background | 2 | same as default | haiku $0.0105, sonnet-5-5 $0.0008 | $0.0113 |

- **Subagents run in the background by default in `-p` mode.** The main turn ends with a launch notice and a first `result` event (`result_index: 0`). When the subagent finishes, a `task_notification` starts another turn and a second `result` follows (`result_index: 1`, `origin.kind: "task-notification"`) with the real answer. The process exits after the second one.
- The bridge keeps the last `done` its parser returns before the process closes (`bridge.js`, `handleLine`), so the player gets the second result. Pinned for coding runs in `tests/e2e/plugin_dir_test.js`; with the bridge changed to keep the first `done`, the test fails with the launch notice as the answer.
- `background: false` in the agent file does not make it foreground. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` does (one result, one turn fewer). It is an env var, so it cannot go through `extraArgs`. Since feat/ask-plugin-scope the bridge sets it for Claude runs of the `ask` plugin only.
- `result.subagent_stats` counts spawned, background and completed subagents by type.
- Subagent `assistant` events carry `parent_tool_use_id`; the main session's do not.

## Bridge accounting with a subagent (not changed in this step)

Fed the default run's events through `AGENTS.claude.parser()`:

- **Window:** `claudeWindow` takes the largest `contextWindow` in `modelUsage`. With a Haiku main session (200k) and a Sonnet subagent (1M) it reported 1M. Today's `ask` models (Opus 5.5 and Sonnet 5.5) are both 1M, so it is right for now; a smaller main model with a larger subagent would show the wrong share.
- **Cost:** the parser priced the run at $0.0386 against the CLI's $0.0336 (+15%). It splits every model's cache writes by the 1h/5m share of the top-level `usage`, which here describes only the main session (1h); the subagent wrote 5m cache.

## wowdata from a plugin agent (2026-10-06)

Measured on Claude Code 2.1.290 with the real plugin (`assets/plugins/claude-wow`), a scratch Classic Era 1.15.9.70003 sync and a scratch `CLAUDE_WOW_HOME`. The argv came from the bridge's own builders (`AGENTS.claude.args`, `DM.launchConfig`, `GM.mcpConfig`, `P.systemPrompt` with the `ask` plugin's tools text, the `ask` deny rules without the live socket), default setting sources, no `--strict-mcp-config`, cwd a scratch folder:

```
-p --output-format stream-json --verbose --permission-mode acceptEdits
--allowedTools WebSearch WebFetch Bash(git:*) ... Bash(dir:*) mcp__wowdata
--disallowedTools mcp__claude-wow__goal_set ... mcp__wowgoals Read(<home>/**) Grep Glob LS NotebookRead
--mcp-config <scratch>/mcp.json --model haiku --max-budget-usd 0.3
--append-system-prompt <ask system prompt> --plugin-dir <abs>/assets/plugins/claude-wow
```

Prompt (with the situation block, Tirisfal Glades at 61.0, 51.0): "Use the claude-wow:wow-planner agent for this. Plan me a short route from here to the nearest flight path and mark it on the map. Then give me its answer."

| Run | `mcp__wowdata` in `--allowedTools` | Planner tool calls | `permission_denials` | `total_cost_usd` |
|---|---|---|---|---|
| 1 | yes (the bridge's run-only rule) | `mcp__wowdata__wow_flights {"uiMapID":1420}`: ok, `trust: client-data`, `buildCheck: exact` | `[]` | **$0.180** (haiku $0.093, opus-5-5 $0.087) |
| 2 (control) | no | `wow_flights`, `wow_where`: both "Permission to use ... has been denied" | 2 in the first result, 1 more in the second (the parent tried `wow_flights` itself) | $0.118 |

- **The subagent gets the parent's run-only allow rule.** With `mcp__wowdata` in `--allowedTools` the planner's call succeeds; without it the same call is denied. No config or bridge change is needed.
- **The contract held.** The planner called only `mcp__wowdata__wow_flights`, no `Write`, `Edit` or `Bash`. It said what it drew and ended with one `wowmap` block. The parent copied the block verbatim into the final result, and the bridge's `extractMapBlocks` and `validateMapCommand` accept it with no errors.
- Subagent denials show in the run's `permission_denials` like the main session's, so the bridge's denial handling sees them.
- The `opus` alias in agent frontmatter resolved to `claude-opus-5-5`. `CLAUDE_CODE_SUBAGENT_MODEL=haiku` in the env did not override it.
- Background flow as in the spike: two `result` events (`result_index` 0 and 1); the second, `origin.kind: "task-notification"`, holds the answer. Both carried the same `total_cost_usd`.
- Spend: **$0.298** for the two runs.

## Not measured

- The plugin with the full user setup that live `ask` runs inherit (decision 5) beyond the init lists above. The 2026-10-06 runs used the default setting sources of this PC's user, which load no `wowdata` allow rule.
