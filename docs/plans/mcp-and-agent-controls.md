# MCP integrations and agent controls

Status: draft, 2026-10-04. Fresh-eyes round 1 done (fable + gpt-6-astra); findings folded in.

## Goal

Any MCP server the player configures works from in-game chats, on Claude and on Codex, with the same controls. Agent and effort switching already exist; this plan makes MCP first-class and adds a cost cap and an approval path for headless runs.

## What exists today

- Agent switch per chat: `agent=<id>` token (`bridge/protocol.js`), in-game agent popup (`addon/ClaudeWoW/ClaudeWoW.lua` `CLAUDEWOW_AGENT`).
- Effort per chat: `/claude --effort …`. Claude gets `--effort`; Codex gets `-c model_reasoning_effort=` (`bridge/agents.js`).
- Bridge-owned MCP servers (`wowdata`, `wowgoals`, `wowfactory`) go into a per-run 0600 JSON file passed with `--mcp-config` and deleted on close (`bridge/bridge.js` ~1712, 1857). Their tools are run-only allow rules. The `--mcp-config` content already varies between resumed turns with no session reset.
- `wowgoals` write tools are safe only because `inGameDeniedTools` puts them on `--disallowedTools` (`bridge.js` ~1530, 1621).
- Codex gets no bridge MCP servers: `runToolsSocket` and `factoryToolSocket` are gated on `claudeRun`, `dataServer` on `claudeRun || agent.mcp` (`bridge.js` ~1620-1633).
- Claude runs load the user's own servers (`~/.claude.json`, project `.mcp.json`, plugins). Their tools work when listed in `agents.claude.allowedTools`; a denial in an `ask` chat becomes a Need roll that persists the rule to `config.json` (`allowRules`, `bridge.js` ~1030).
- In-game permission relay exists for live sessions: `channel.js` forwards `permission_request`, `plugins/live.js` turns it into a roll (Need / Allow once / Pass), timeout `plugins.live.permissionTimeoutMs` = 120000.
- `mcpDown` reports only non-connected servers from Claude's `system/init` (`agents.js` ~174). Codex reports no MCP health.
- `dev/measure-ask.js` already uses Claude's native `--max-budget-usd`.

## Gaps

1. Codex chats have no game-data, goals or user MCP servers.
2. No single place to declare servers for both agents with a per-tool allow list.
3. No in-game view of servers or their health; no per-chat on/off.
4. Headless runs can only allow or deny (roll after the fact), not approve mid-run.
5. No cost cap per run.

## Design

### 1. One server list in config (opt-in)

```json
"mcp": {
  "servers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "envVars": ["GITHUB_TOKEN"], "allow": ["*"], "default": false },
    "notion": { "type": "http", "url": "https://mcp.notion.com/mcp", "allow": { "claude": ["notion-search", "notion-fetch"], "codex": ["search", "fetch"] }, "default": true }
  }
}
```

- `envVars`: names only. Values are never written to argv, `config.json`, SavedVariables or the transport.
- `allow`: tool names or `*`, optionally per agent (tool names differ across clients, e.g. Notion). Every tool of the server not in `allow` is denied for the run.
- HTTP auth: `bearerTokenEnvVar` (env name) or OAuth done once in each CLI (`claude mcp` / `codex mcp login`). The bridge reports `needs-auth` from the init status; it never stores tokens.
- `default`: on for new chats.
- Absent `mcp` key = today's behaviour exactly (no `--strict-mcp-config`, no import).

### 2. Per-agent translation

Claude:
- Merge enabled servers into the existing per-run JSON. Env and headers use Claude's own `${VAR}` expansion, written verbatim.
- Allow rules `mcp__<server>__<tool>` via `P.withRunOnlyRules`; tools not in `allow` via `P.withRunDeniedRules`, so `neverOffered` keeps them out of the roll and a Need can never persist them.
- `--strict-mcp-config` only when `mcp.strict: true`. On startup with strict on, log the servers in `~/.claude.json` / `.mcp.json` / plugins that will stop loading.

Codex:
- Flip the three gates (`runToolsSocket`, `factoryToolSocket`, `dataServer`) to also accept `agentId === 'codex'`.
- Each enabled server: `-c mcp_servers.<name>.command="…"`, `.args=[…]`, `.env_vars=[…]`, `.url="…"`, `.bearer_token_env_var="…"`, `.enabled_tools=[…]`, `.disabled_tools=[…]`. All values emitted as TOML string literals (escape `"` and `\`); no shell is involved (`procs.js` spawns without one).
- `wowgoals`: `disabled_tools` = every rule from `LP.GOAL_WRITE_TOOLS` and `GM.DENIED_WITH_TOOLS`. `CLAUDE_WOW_RUN_TOKEN` goes into the spawned env and is listed in `env_vars`, never on argv.
- Servers the player turned off that also exist in `~/.codex/config.toml`: emit `-c mcp_servers.<name>.enabled=false`, because `-c` merges and omission does not remove.
- Sandbox mode is unchanged; it governs shell commands, not MCP calls.
- Grok, agy, hermes: no MCP; the chat gets the existing unsupported-setting note.

Wiring for the `mcp` setting (all four, or reload mode silently drops it):
- `SETTING_FLAGS.mcp`, and `mcp` in `settings` only for `claude`, `codex`, `local`.
- `chatSettings(job).mcp` (`bridge.js` ~1929).
- `parseOutbox` key list (`protocol.js` ~436).
- `parseFlags` `mcp=` token.

### 3. In-game controls

- The bridge advertises `mcp = [{ name, on, health, checkedAt }]` in the slot data (capability gate, like `run.bridgeCancel`). No list = older bridge; the command says so.
- `/claude mcp` lists servers with on/off for this chat and health: `connected`, `failed`, `needs-auth`, or `unknown` when not yet observed.
- `/claude mcp on|off <name>` validates the name against the advertised list in Lua, stores it in `c.mcp`, and sends `mcp=<hex of US-joined names>` (the `dirs=` pattern), max 8 names. The complete serialized record is checked against `Codec.MAX_PAYLOAD` before the message is marked pending.
- No session reset on change: the per-run MCP config already varies across resumed turns.
- Health: replace `mcpDown` with a full status snapshot per run (`mcpStatus`), stored per agent with a timestamp so a recovered server clears. Codex: `unknown` until a status source is found.

### 4. Approval mid-run (reuse the roll)

- Claude only. Pass `--permission-prompts host --permission-prompt-tool mcp__wowapprove__ask` with a small bridge MCP server in the same per-run JSON.
- The server sends the request to the bridge over the existing live socket in the `channel.js` `permission_request` shape; `runAgent` uses the same roll and `LP.isVerdictJob` path as live sessions, timeout `permissionTimeoutMs`.
- `--disallowedTools` entries must never reach the prompt tool; a test asserts it.
- Step 0: measure the real CLI (flag names, the `{behavior, updatedInput}` reply contract) and record it in `docs/AGENTS.md`. Not scheduled until measured.

### 5. Cost cap

- `agents.claude.maxCostUsd` -> `--max-budget-usd <n>` in `AGENTS.claude.args`. It applies per invocation, so resumed-session totals do not count. The reply notes a budget stop from the result event.
- Add `maxCostUsd` to `SETTING_FLAGS` so other agents report it as unsupported. Codex has no equivalent.

### Dropped

- Profiles. `agent=` + `effort=` + `model=` already exist; a bridge-side profile would fight the per-chat tokens the addon re-sends on every message. Revisit as an addon-side macro if players ask.
- Bridge-side cost kill: `claudeCost` runs only on the final `result` event and reads session totals on resume.

## Order of work

Each step is done only when measured on the real CLI, not just `dev/fake-claude.js`.

1. Cost cap (`--max-budget-usd`). Smallest, independent.
2. Config schema + Claude translation (allow, deny, `${VAR}`, opt-in strict). Test: a denied `mcp__notion__create_page` is never offered in a roll.
3. Codex translation + gate flips. Tests: `wowgoals` write tools appear in `disabled_tools`; a numeric-looking value stays a TOML string; no secret value appears in argv.
4. Slot advertisement, `mcp=` token through strip and reload outbox, `/claude mcp`, health snapshots.
5. Mid-run approval (after step 0 measurement).
