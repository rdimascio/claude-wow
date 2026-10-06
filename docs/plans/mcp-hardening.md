# MCP hardening and release discipline

Status: draft, 2026-10-05, revised after a two-seat review. Follows `mcp-and-agent-controls.md` steps 1-4 (PRs #101, #120, #124, #129, #133).

## Why

The per-chat MCP control is only correct while Claude Code and Codex keep the behaviors below, measured once, by hand, on Claude Code 2.1.289 and Codex 0.159. CI has neither CLI, and Claude Code updates itself in the background. A CLI update can turn "off" into "on" with no test failing. Separately, 4 MCP PRs merged on 2026-10-05 without a green `gate`, 1 with an admin bypass, and nothing stops a release tag on such a commit. Some `main` merge commits (61ebb8b, 7d86a1f) have no `gate` run at all, because `ci` keeps one pending push run per concurrency group.

## The contract

Each row is probed separately and recorded as `pass`, `fail` or `unchecked`. Only rows the committed fixture can exercise are probed; the rest stay `unchecked` and are listed by `claude-wow agents check`.

| # | Agent | Behavior the bridge relies on | Probed how | Used by |
|---|---|---|---|---|
| C1 | Claude | Tool prefix = server name with every char outside `[A-Za-z0-9_-]` replaced by `_` | init `tools` of a fixture server named `a.b c` | catalog ids, deny rules |
| C2 | Claude | `--disallowedTools mcp__<prefix>` removes every tool of a `--mcp-config` server, even one in `--allowedTools` | init `tools` with and without the deny rule | per-chat off |
| C2u | Claude | same for user, plugin and claude.ai servers | not probed (needs the user's own servers); `unchecked` | per-chat off |
| C3 | Claude | `${VAR}` in `--mcp-config` `env`/`args` is expanded | fixture echoes an env value as a tool name | `mcp.servers` |
| C4 | Claude | `system/init` `mcp_servers[]` has `name`, `status`, `source` | init event shape | discovery, health |
| X1 | Codex | `exec` refuses MCP calls unless `default_tools_approval_mode="approve"` | one call to the fixture, small pinned model, timeout | Codex servers |
| X2a | Codex | `-c mcp_servers.<n>.enabled=false` overrides `config.toml` | fixture tool absent from the run | per-chat off |
| X2b | Codex | `env_vars` passes values and `shell_environment_policy.exclude` hides them from the shell | fixture sees the value; `printenv` in the shell does not | secrets |

C1, C2, C3 and C4 need no model call: the probe stops `claude` after the `system/init` event. X1, X2a and X2b need one Codex run each.

## Work, in order

PR A is independent. PR D, then PR B, then PR C run one after another: B and C change the code D moves.

### PR A: release gate (small)
- `dev/release-gate.js <sha>`: passes only when the `ci` workflow (`test.yml`) has a run with `head_sha=<sha>`, `branch=main`, `event=push` whose `gate` job concluded `success`, and `<sha>` is an ancestor of `origin/main`. Query `repos/{owner}/{repo}/actions/workflows/test.yml/runs` and that run's jobs. A run still in progress is polled every 30 s for up to 20 min; no run at all fails with "no ci push run on main for <sha>; tag a later main commit".
- `release.yml`: new job `gate`, `if: github.ref_type == 'tag'`, `permissions: { contents: read, actions: read }`, `GH_TOKEN: ${{ github.token }}`, runs the script for `$GITHUB_SHA`. `version` gets `needs: gate` with `if: always() && (needs.gate.result == 'success' || needs.gate.result == 'skipped')` so pull request and dispatch runs still work.
- Unit tests with recorded API fixtures: a PR-head SHA with a green PR `gate` is refused; a main SHA with a failed or missing `gate` is refused; a main SHA with a green push `gate` passes; an in-progress run that turns green passes. Never test with a real version tag.
- CONTRIBUTING: "merge on green only; tag only a main commit whose push run has a green `gate`; when Actions is down, wait or cut no release".
- Branch protection `enforce_admins` is **owner's call** (decision 1); not part of the PR.

### PR D: bridge MCP planning moves out of `runAgent` (small, no behavior change)
- Move the off-choice, seen-off and guard composition out of `runAgent` into `bridge/mcpconfig.js` as one `planRun({ agentId, choice, cwd, userMcp, seen, codexOwn, reserved, claudeOwn? })` returning `{ userMcp, seenOff, guard, codexMcp, seen }`. The caller passes every bridge global it needs and assigns `state.mcpSeen = plan.seen`. `codexMcp` leaves out `wowdata`, which `runAgent` still adds first. Done in PR #146.
- `noteMcpHealth` (stream callback) and `mcpSlotList` (slot writer) stay in `bridge.js`.
- Existing tests pass unchanged; add unit tests for `planRun`.
- The addon `Cli.Mcp*` block stays in `ClaudeWoW.lua`. A new Lua file would need shared locals (`Cli`, `run`, `db`), entries in `bridge/assets.js`, `build/entry.js` and both Lua test loaders, and a full restart on Forever before `ApplyMcp` exists. Not worth it for a file split.

### PR B: contract probe (medium)
- `dev/contract-mcp.js`: committed stdio MCP fixture server (one tool per name it is told to expose; echoes one env value). Added to `bridge/assets.js` and `build/entry.js` so the release binary has it.
- `bridge/agentcontract.js` plus a new supervisor subcommand `claude-wow agents check` (dispatch and help in `bridge/supervisor.js`; works from source and from the compiled binary). It runs the rows above against the binary `A.resolveCommand` returns for each agent and prints each row and the cost from the run.
- Writes `~/.claude-wow/agent-contract.json`: `{ claude: { path, realpath, version, at, rows: { C1: "pass", C2u: "unchecked", ... } }, codex: {...} }`.
- `dev/doctor.js` stays read-only: it only reads the file and warns when it is missing or older than the installed CLI.
- Per run, `runAgent` resolves the command, `realpath`s it and `stat`s it; `--version` is re-read only when realpath or mtime changed. The contract entry matches only on the same realpath and version.
- **Fail closed only on a measured `fail`.** An `unchecked` version logs one line and sets the slot field `contract: { claude: { checked: false } }`; the addon MCP menu shows "Not checked on Claude Code <v>: run claude-wow agents check". Nothing is disabled.
- When C2 (Claude) or X2a (Codex) is `fail` for the running version, the **bridge** refuses any run whose `mcp=` choice turns a server off, with the reason, before spawning. This covers saved choices and older addons; the addon menu (greyed "off" items) is only a mirror. When X2b is `fail`, the bridge refuses Codex runs that pass a secret through `env_vars`. No `--strict-mcp-config` fallback: it would drop claude.ai and plugin servers the chat left on.
- Not in CI (no CLI there).
- Tests: a contract file with C2 `fail` gives the slot field `{ claude: { off: false, reason } }` (unit); that slot field greys the menu checkboxes and "Turn all off" (addon); a run with an off choice and C2 `fail` is refused before spawn (transport); a CLI binary replaced between two turns is re-checked (unit, fake `stat`).

### PR C: allow lists for discovered servers (medium)
- New `mcp.allow.<id>`: an allow list for any discovered server by catalog id (`claude_ai_Slack: ["slack_search_public"]`). Add `allow` to `MCP_KEYS` in `bridge/mcpconfig.js`. For a config server, `mcp.servers.<id>.allow` wins and a start log names the conflict. Codex own servers get it as `enabled_tools`.
- It trims the bridge's `allowedTools` and keeps other tools out of the roll. It is **not** a security boundary: the user's own `permissions.allow` and `bypassPermissions` still allow the rest. docs/CONFIGURATION.md says so.
- `mcp.servers` with `command`/`url` stays fully supported. Deprecating it (decision 3) waits for a later plan, because native config loses `default: false`, bridge-only servers, the Codex `default_tools_approval_mode` and the secret exclusion.

## Every PR
- CHANGELOG `[Unreleased]` entry, and docs/CONFIGURATION.md / docs/AGENTS.md updated where behavior or keys change.
- `npm test` green; fresh-eyes on the PR.

## Decisions for the owner
1. `enforce_admins` on `main` (blocks the owner's own emergency merges too).
2. Settled here: fail closed only on a measured failure; warn when unchecked.
3. Deprecate adding servers through `mcp.servers`: deferred until a `mcp.default.<id>` override and a migration that keeps approval and secret exclusion exist.

## Done when
- `dev/release-gate.js` tests above pass, and the `release.yml` `gate` job runs only on tags.
- `claude-wow agents check` writes the contract file from both the source checkout and the compiled binary.
- A C2 `fail` in the contract file refuses an off-choice run in a transport test and greys the menu in an addon test.
