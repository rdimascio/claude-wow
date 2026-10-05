# MCP hardening and release discipline

Status: draft, 2026-10-05. Follows `mcp-and-agent-controls.md` steps 1-4 (PRs #101, #120, #124, #129, #133).

## Why

The per-chat MCP control is only correct while Claude Code and Codex keep six behaviors that were measured once, by hand, on Claude Code 2.1.289 and Codex 0.159. CI has neither CLI. A CLI update can turn "off" into "on" with no test failing. The `mcp.servers` block also became a second server registry next to Claude's and Codex's own. Separately, 4 MCP PRs merged on 2026-10-05 without a green `gate`, 1 with an admin bypass, and nothing stops a release tag on such a commit.

## The contract

| # | Agent | Behavior the bridge relies on | Used by |
|---|---|---|---|
| C1 | Claude | Tool prefix = init server name with every char outside `[A-Za-z0-9_-]` replaced by `_` | catalog ids, deny rules |
| C2 | Claude | `--disallowedTools mcp__<prefix>` removes every tool of a user, plugin, claude.ai and `--mcp-config` server, even one in `--allowedTools` | per-chat off |
| C3 | Claude | `${VAR}` in `--mcp-config` `env`/`args`/`headers` is expanded; an OAuth login is reused by server name | `mcp.servers` |
| C4 | Claude | `system/init` `mcp_servers[]` has `name`, `status`, `source` | discovery, health |
| X1 | Codex | `exec` refuses MCP calls unless `default_tools_approval_mode="approve"` | Codex servers |
| X2 | Codex | `-c mcp_servers.<n>.enabled=false|true` overrides `config.toml`; `env_vars` passes values; `shell_environment_policy.exclude` hides them from the shell | per-chat off, secrets |

## Work, in order

### PR A: release gate (small)
- `release.yml`: first job checks that the tagged commit has a successful `gate` check run on `main` (`gh api repos/:o/:r/commits/<sha>/check-runs`), else fails before building.
- Branch protection: turn on `enforce_admins` so `--admin` cannot skip `gate`. **Owner's call** (it also blocks the owner's own emergency merges).
- CONTRIBUTING: "merge on green only; when Actions is down, wait or cut no release".

### PR B: contract probe (medium)
- `claude-wow doctor --agents` (new section in `dev/doctor.js`, also `bridge/agentcontract.js`): runs C1-C4 and X1-X2 against the installed CLIs with a scratch stdio server (the one from the step 2 measurement) and `--model haiku` / the Codex default. One run each, about $0.05.
- Writes `~/.claude-wow/agent-contract.json`: `{ claude: { version, at, pass: { C1: true, ... } }, codex: {...} }`.
- The bridge reads each CLI's `--version` at start (cached per binary mtime). Version newer than the last passing contract: one log line, a `contract` slot field, and the addon's MCP menu shows "Not checked on Claude Code <v>: run claude-wow doctor --agents".
- **Fail closed** when C2 (or X2 for Codex) failed on this version: per-chat off is not offered (menu items disabled, `/claude mcp off` refuses with the reason), and a chat with off choices gets `--strict-mcp-config` plus only its on servers, which does not depend on C2.
- Not in CI (no CLI there). A local weekly `/schedule` routine may run it; out of scope here.

### PR C: shrink `mcp.servers` (medium)
- New `mcp.allow.<id>`: an allow list for any discovered server by catalog id (`claude_ai_Slack: ["slack_search_public"]`), enforced like today's `allow` (run-only rules plus never offered). Codex own servers get it as `enabled_tools`.
- `mcp.servers` entries with `command`/`url` keep working one release, with a start log: "add it with `claude mcp add` / `codex mcp add`; mcp.servers will stop adding servers in 0.6". Docs lead with the native commands.
- Removes the OAuth workarounds from the docs (Slack client id, Datadog headers): the native CLIs handle them.

### PR D: file split (small)
- Move the `Cli.Mcp*` block (about 260 lines) into `addon/ClaudeWoW/Mcp.lua`, loaded after `ClaudeWoW.lua` in the toc. New file: Forever needs one full restart; Era picks it up on `/reload` (measured 2026-10-02).
- Move `noteMcpHealth`, `mcpSlotList`, the seen-off and guard composition out of `runAgent` into `bridge/mcpconfig.js` as one `planRun({ agent, choice, cwd })`.

## Decisions for the owner
1. `enforce_admins` on `main` (PR A).
2. Fail closed (disable "off") versus warn only, on an unchecked CLI version (PR B).
3. Deprecate adding servers through `mcp.servers` in 0.6 (PR C).

## Done when
- A tag on a commit without a green `gate` fails the release job (tested with a throwaway tag on a branch commit).
- Changing C2's expectation in the probe's fixture makes the menu disable "off" in an addon test and the run use `--strict-mcp-config` in a transport test.
- `npm test` green; fresh-eyes on each PR.
