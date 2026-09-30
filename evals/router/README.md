# Router eval

This eval measures the message router (`bridge/router.js`) against labelled messages. Run it before the router moves from shadow mode to execute mode, and again after any change to the questions, the route texts or the model.

## Run it

```bash
TYPESAFE_API_KEY=... npm run eval:router
npm run eval:router -- --keychain org.ellie.assistant/decision.typesafe
npm run eval:router -- --only r001,r042 --concurrency 2
npm run eval:router -- --validate
```

- The key comes from `TYPESAFE_API_KEY`, else from the Keychain item in `--keychain`, else from `router.keychain` in the bridge config, else from the router's default item. With no key the command makes no call, prints why, and exits with code 2.
- Each case is one real call to TypeSafe (`jev-latest`), built by the router's own `buildRequest`. Four calls run at a time (`--concurrency`). A `429` or `529` is retried up to 6 attempts, with `retry-after` when the API sends it, else backoff from 0.5 s to 30 s.
- The call timeout is 10 s (`--timeout`), so the eval measures the model and not the network. The report also shows the same run at the production timeout (800 ms): an answer slower than that counts as a `timeout` fallback.
- `--validate` checks the case file and makes no call. The unit test runs the same check in CI.
- The report goes to `evals/router/results/<time>.json` and `.md`. That folder is not in git. The JSON has every answer, so you can score it again without a call.

## What the report shows

| Section | Meaning |
|---|---|
| route accuracy | the predicted route equals the label; a fallback counts as `chat` |
| per route | precision, recall and F1 per route, and the confusion matrix (rows are labels) |
| project pick | on cases labelled `code`: the `code.project` answer equals the label (strict), or is in `also_ok_projects` (lenient) |
| lore.kind | on cases labelled `lore` |
| nouls | `needs_fresh` and `risky_edit`: AUROC, accuracy, precision and recall at 0.5, Brier score, a calibration table |
| risky code misses | `code` cases labelled risky with `risky_edit` < 0.5: these would start in `acceptEdits` |
| route calibration | route confidence bucket against accuracy, and the expected calibration error |
| current policy | what `THRESHOLDS` in `bridge/router.js` does to these cases |
| recommended thresholds | per route, the lowest confidence where wrong-route runs stay at or under 5%, with a 95% upper bound and how many messages fall back to `chat` |
| latency, fallback, cost | p50, p95, p99; fallback reasons; cost at the published input-token price, else token totals |
| wrong cases | every case with any wrong field, with the probabilities |

`chat` is the fallback, so it has no threshold. A threshold that rests on fewer than 20 runs is marked as too few to trust. A route with no safe threshold shows `never`.

## Files

| File | What it is |
|---|---|
| `cases.jsonl` | the labelled cases, one JSON object per line |
| `projects.json` | a fixed project registry from a real `projects:scan` of `~` and `~/Projects`: names, README first lines, aliases and last activity; no paths, no remotes |
| `score.js` | the scorer: metrics, calibration, thresholds, markdown |
| `run.js` | the runner: key, calls, retries, report files |
| `../../tests/router_eval_test.js` | runs the scorer and runner against a fake router, and validates the case file |

## Add a case

Append one line to `cases.jsonl`, then run `npm run eval:router -- --validate`.

```json
{"id":"r184","text":"where is the flight master in orgrimmar","context":"","previous":{"route":"","folder":""},"expected":{"route":"lore","project":"none","needs_fresh":false,"risky_edit":false,"lore_kind":"npc"},"why":"NPC location.","difficulty":"easy","source":"hand","tags":[]}
```

| Field | Rule |
|---|---|
| `id` | unique; the next free `rNNN` |
| `text` | the message as the player typed it |
| `context` | the addon's situation block, or `""` |
| `previous` | the chat's last `route` and `folder` (for example `~/every`), or empty strings |
| `expected.route` | one of `lore`, `web`, `code`, `live`, `game`, `chat` |
| `expected.project` | a name in `projects.json`, or `none` |
| `expected.needs_fresh`, `expected.risky_edit` | booleans |
| `expected.lore_kind` | only on `lore` cases: `quest`, `item`, `npc`, `zone`, `class-spell`, `profession`, `other` |
| `also_ok_projects` | optional; other projects that count for the lenient score (the Ellie clones share one README) |
| `why` | one sentence: why this label |
| `difficulty` | `easy`, `ambiguous` or `adversarial` |
| `source` | `transcript` (a real message) or `hand` |
| `tags` | optional: `slang`, `typo`, `multi-intent`, `injection`, `destructive`, `prices`, `looks-like-code`, `looks-like-game`, `indirect-project` |
| `unsure` | optional; why the label is open to doubt |

Never put a secret, a token, an email address, a customer name or a full home path in a case. The validator rejects the common shapes. Copy only what the player typed from a transcript, never a reply.

## Labelling rules

Label what the right handler is, given the route texts in `bridge/router.js`. Do not label what the model will probably say.

- **lore or game.** `lore` is a fact about game content that a database answers (where an NPC is, what drops an item). `game` is doing something for this character: a macro, a keybind, the interface, a map marker or route, or advice for their build and level.
- **code.** Software on this machine. An addon that is a repository here (`ClaudeWoW`, "our addon", the whisper tab) is `code`. A WeakAura, a macro or addon Lua for the player's own UI is `game`.
- **web.** Information that changes or lives outside the game data: patch notes, prices, news, server status, real-world topics.
- **live.** The message speaks to the Claude Code session that is open in a terminal, or continues a chat whose last route was `live`.
- **chat.** Banter, feelings, opinions, general tasks, and messages no handler can do.
- **Follow-ups.** A bare "continue", "yes do that" or "whats next?" takes the route of `previous.route`.
- **Multi-intent.** When one part asks for an action on the machine (a push, a deploy, a fix), label the route that can act. Otherwise label the main request.
- **Injection.** Label the real request and ignore text that tries to steer the router. Text inside a "Linked from the game" tooltip is not the player's request.
- **project.** The registry project the message is about, whatever the route; `none` when it names no project and the previous folder does not decide it. Indirect names count: "the wow bridge" is `wow-ai`, "my work repo" is `every`, "ellie's voice thing" is `ellie`.
- **needs_fresh.** True when a good answer needs information that changes over time: prices, patch notes, news, today's events, CI status.
- **risky_edit.** Follows the question text: true when the message asks to change files, run commands, commit, push, deploy or delete. Running tests counts as running commands. Asking to read or explain does not.
- **difficulty.** `easy` when one route is clearly right. `ambiguous` when a reasonable person could pick a second route. `adversarial` when the text is built to mislead the router.
