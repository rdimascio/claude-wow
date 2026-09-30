# Message router

The router picks the handler for an in-game message. It asks TypeSafe's Jev model (System One) a few typed questions in one call and gets back a route, probabilities and a confidence. Code, not the model, decides what to do with the answer.

**Phase 1 is shadow mode.** The router decides and logs. Every message still takes the path it took before: the chat's plugin, else the default plugin. Nothing the router says changes a reply yet. The shadow log is the evaluation set for phase 2.

## Privacy

When the router is on, **the text of each routed message goes to TypeSafe** (`https://api.typesafe.ai/v1/systemone`), with:

- the game context block the addon sent (character, zone, coordinates, quest log),
- the chat's previous route and the folder its last agent session ran in,
- the project registry: the name, the README first line, the aliases and the last activity date of the most recent 40 git repositories found under the scan roots. Their paths and remotes stay on this machine.

TypeSafe controls its own retention. Messages that skip the router (see below) are not sent. `router.mode: "off"` stops all calls. Without a key the router is off and sends nothing.

## Routes

| Route | What it is for | Handler (phase 2 and later) |
|---|---|---|
| `lore` | A factual question about game content: a quest, an item, an NPC, a zone, a class or spell, a profession | local trusted dataset |
| `web` | Current or outside information: patch notes, news, prices, guides | cached web search |
| `code` | Software on this machine: a repository, a bug, a test, a build, a commit, a deploy | `claude -p` in the project the router picked |
| `live` | The Claude Code session that is already open in a terminal | the `live` plugin |
| `game` | Doing something in the client: a macro, a keybind, the UI, a map route | today's `ask` plugin |
| `chat` | Everything else, and every fallback | the general agent |

## The call

One `POST` per message, `model: "jev-latest"`, plain `fetch` (no dependency). The questions go together, so they run in parallel and cannot see each other:

| Question | Type | Used for |
|---|---|---|
| `route` | choice over the six routes, each with a one-sentence description | the handler |
| `code.project` | choice over the project registry plus `none` (left out when the registry is empty) | the folder for `code` |
| `lore.kind` | choice: quest, item, npc, zone, class-spell, profession, other | the lookup table for `lore` |
| `needs_fresh` | noul: the answer depends on information newer than a stored database | `lore` vs `web` |
| `risky_edit` | noul: the message asks to change files, run commands, push or deploy | the code agent's permission mode |

The request shape is pinned by `tests/fixtures/router_request.json`.

The call runs next to the normal dispatch and never delays it. It never throws into the message path. Any of these gives the result `{ route: "chat", fallback: <reason> }`:

| Reason | When |
|---|---|
| `timeout` | no answer in 800 ms (`router.timeoutMs`) |
| `http-401`, `http-422`, `http-429`, `http-529`, `http-<n>` | the API answered with that status |
| `network` | the connection failed, or the body was not JSON |
| `invalid-response` | the answer is missing `route`, or names an unknown option |
| `no-key`, `no-fetch` | nothing to call with |

There is no retry. A fallback is logged like any other result.

## Explicit input skips the router

These messages make no call and write no shadow line (the bridge log says `router: skipped, explicit input (<reason>)`):

- a `/claude` line with any flag: `-c`, `-r`, `--agent`, `--model` and the rest. The addon marks such a record with a `cli` flag. The reload fallback path does not carry that flag.
- a chat attached to a session with `-r` (a `resume=` or `live=` flag, or the `live` plugin),
- a chat with its own agent, model, effort, permission mode or extra folders,
- a chat bound to a folder (`/claude cd`),
- an address at the start of the text (`@ask ...`),
- a death recap (`kind=roast`),
- text that is a `/claude config` command.

A chat that the addon bound to `claude-code` when plugins arrived, but that has no folder, is still routed.

## Policy and thresholds

The thresholds live in `bridge/router.js` (`THRESHOLDS`). They are starting points to check against the shadow log, not measured values.

| Condition | Phase 2 action | Shadow log `decision` |
|---|---|---|
| `route` confidence >= 0.85 | run the route | `run` |
| 0.60 <= confidence < 0.85 | run it and show "routed to X - /claude -r to change" | `run-notice` |
| confidence < 0.60, or any fallback | the `chat` route | `chat` |
| route `code` and `risky_edit` >= 0.5 | the code agent starts in `default` permission mode, so edits come up as the Need/Greed roll | `permissionMode: "default"` |
| route `code` otherwise | the code agent starts in `acceptEdits` (`router.codePermissionMode`); commands outside the allowlist still go to the roll | `permissionMode: "acceptEdits"` |

The doctor warns when more than 20% of the last 24 h fell back, or when p95 latency is over 800 ms.

## Project registry

`npm run projects:scan` writes `projects.json` in the home folder (`~/.claude-wow`, or `CLAUDE_WOW_HOME`). The bridge refreshes it in the background at start when the router is on.

- Roots: `router.roots`, default `~` and `~/Projects`. `~` is your home folder.
- Depth: `router.depth`, default 3 folders below each root.
- Git repositories only. The scan does not look inside a repository, a hidden folder, `node_modules`, `Library` and a few other build or media folders. It stops after 20000 folders.
- A git worktree checkout (a `.git` file, not a folder) is skipped unless `router.includeWorktrees` is `true`.
- Per project: `name`, `path`, `remote` (origin, else the first remote), `lastCommit` (the newest commit, merge or pull in the HEAD reflog, else the newest reflog entry), `readme` (the first plain line of the README), `aliases` (the name with spaces, without separators, the remote's repository name, and any from `router.aliases`).

The scan reads files only. It runs no `git` command.

## Shadow log

`router.jsonl` in the home folder, one JSON line per routed message:

| Field | Meaning |
|---|---|
| `t`, `chat`, `id` | time, chat id, message id |
| `msg.hash`, `msg.head` | the first 16 hex characters of the SHA-256 of the text, and its first 80 characters |
| `route`, `probabilities`, `confidence` | the `route` answer |
| `project`, `projectProbability` | the `code.project` pick and its probability |
| `loreKind`, `needsFresh`, `riskyEdit` | the other answers |
| `latencyMs`, `fallback` | the call time, and the fallback reason or `null` |
| `decision`, `wouldRoute`, `permissionMode` | what the policy above would do |
| `taken` | the path the message actually took: `{ plugin, why }` |
| `mode`, `note` | `shadow`; the note says when `execute` was asked for |

`npm run router:report` prints the route mix, a confidence histogram, latency p50 and p95, the fallback rate with reasons, and how many messages the router would have sent down another path. `-- --since 24h` (or `7d`) limits it; `-- --json` prints the numbers.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `router.mode` | `"shadow"` | `off`: no Keychain read, no calls. `shadow`: decide and log. `execute`: reserved for phase 2; phase 1 runs it as shadow and says so in the bridge log and in every shadow line. |
| `router.keychain` | `org.ellie.assistant` / `decision.typesafe` | The Keychain item that holds the key: `"service/account"`, a bare `"account"` (service `org.ellie.assistant`), or `{ "service": "...", "account": "..." }`. |
| `router.roots` | `["~", "~/Projects"]` | Where the project scan looks. |
| `router.depth` | `3` | How many folders below a root the scan goes (at most 6). |
| `router.includeWorktrees` | `false` | Count git worktree checkouts as projects. |
| `router.aliases` | `{}` | Extra names per project: `{ "wow-ai": ["claude wow"] }`. |
| `router.timeoutMs` | `800` | The call's deadline. |
| `router.codePermissionMode` | `"acceptEdits"` | The code agent's mode when `risky_edit` is under 0.5. |
| `router.url` | the TypeSafe endpoint | For tests only (the e2e suite points it at a local fake). |

The key comes from `TYPESAFE_API_KEY` when it is set, else from the Keychain item (`security find-generic-password -s <service> -a <account> -w`, macOS only). The bridge reads it once at start and keeps it in memory. It is never written to `config.json`, `state.json`, a log or the shadow log. With no key the bridge logs one line (`router: off, no TypeSafe key ...`) and the doctor warns.

The Keychain can hold an item that only its creating program may read. Then `security` shows a prompt or fails, and the router stays off; set `TYPESAFE_API_KEY` for the bridge, or point `router.keychain` at an item `security` can read.

## Phases

1. Shadow mode, project registry, shadow log, report, doctor check. (This.)
2. Execute mode for `code` and `live`, with thresholds from the shadow log.
3. Lore store and ingest; `lore` route live.
4. Web cache on misses; `web` route live.
