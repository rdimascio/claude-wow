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
- **A relative `--plugin-dir` resolves against the run's working folder**, not the caller's. With the wrong folder the run goes on with no plugin; the only sign is `plugin_errors: [{ type: "path-not-found" }]` in the init event. The bridge runs `ask` in its own scratch folder, so the path in `extraArgs` must be absolute.
- The `haiku` alias resolved to `claude-haiku-4-5-20251001`; the `sonnet` alias in agent frontmatter resolved to `claude-sonnet-5-5`.

## Subagent runs

| Run | Subagent mode | Results | Final text | `modelUsage` | `total_cost_usd` |
|---|---|---|---|---|---|
| default | background (`is_backgrounded: true`) | **2** | 1st: "I've launched the claude-wow:wow-probe agent ... in the background"; 2nd: `PROBE-AGENT-OK 42` | haiku $0.0252, sonnet-5-5 $0.0084 | $0.0336 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | foreground | 1 | `PROBE-AGENT-OK 42` | haiku $0.0204, sonnet-5-5 $0.0008 | $0.0213 |
| default, agent frontmatter `background: false` | background | 2 | same as default | haiku $0.0105, sonnet-5-5 $0.0008 | $0.0113 |

- **Subagents run in the background by default in `-p` mode.** The main turn ends with a launch notice and a first `result` event (`result_index: 0`). When the subagent finishes, a `task_notification` starts another turn and a second `result` follows (`result_index: 1`, `origin.kind: "task-notification"`) with the real answer. The process exits after the second one.
- The bridge keeps the last `done` its parser returns before the process closes (`bridge.js`, `handleLine`), so the player gets the second result. Pinned in `tests/e2e/plugin_dir_test.js`; with the bridge changed to keep the first `done`, the test fails with the launch notice as the answer.
- `background: false` in the agent file does not make it foreground. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` does (one result, one turn fewer). It is an env var, so it cannot go through `extraArgs`.
- `result.subagent_stats` counts spawned, background and completed subagents by type.
- Subagent `assistant` events carry `parent_tool_use_id`; the main session's do not.

## Bridge accounting with a subagent (not changed in this step)

Fed the default run's events through `AGENTS.claude.parser()`:

- **Window:** `claudeWindow` takes the largest `contextWindow` in `modelUsage`. With a Haiku main session (200k) and a Sonnet subagent (1M) it reported 1M. Today's `ask` models (Opus 5.5 and Sonnet 5.5) are both 1M, so it is right for now; a smaller main model with a larger subagent would show the wrong share.
- **Cost:** the parser priced the run at $0.0386 against the CLI's $0.0336 (+15%). It splits every model's cache writes by the 1h/5m share of the top-level `usage`, which here describes only the main session (1h); the subagent wrote 5m cache.

## Not measured

- A plugin agent calling `mcp__wowdata__*` under the bridge's `--allowedTools mcp__wowdata`: whether a subagent gets the parent's run-only allow rule. The run (`wow-planner` with a Haiku model override, a scratch Classic Era sync, `--disallowedTools Grep Glob LS NotebookRead`) stopped at the account's session limit before its first turn. Run it before the plugin is turned on for players.
- The `opus` alias in agent frontmatter (only `sonnet` and `haiku` were seen resolving).
- The plugin with the full user setup that live `ask` runs inherit (decision 5) beyond the init lists above.
