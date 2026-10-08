# Step 5b: the claude-wow plugin on Classic Era

Plan: [`router-and-game-data.md` §7.1.1 and §7.2](../router-and-game-data.md#711-step-5-status-plugin-built-opt-in-router-not-started). Raw results: [`step5b-era-plugin.json`](step5b-era-plugin.json): every run's argv (system prompt replaced by its size and SHA-256), cost, wall time, tool calls with their input, `modelUsage`, init plugin agents and the full answer. Measured 2026-10-08 (ranAt 14:34Z) on Claude Code 2.1.286 (`~/.local/bin/claude`), Opus 5.5 (`claude-opus-5-5`) in both arms.

## Verdict

- **The plugin did nothing.** In 20 runs with the plugin (10 first turns, 10 resumed), the `ask` session never called `claude-wow:wow-code` or `claude-wow:wow-planner`. Both agents were in every init list of arm B, with no plugin error. `modelUsage` held only `claude-opus-5-5` on all 40 runs.
- **It costs nothing either.** Mean first turn $0.1548 without the plugin, $0.1544 with it. Resumed turn $0.0297 vs $0.0318.
- **Keep `plugins.ask.claudePlugin` off (the default).** It adds no answer quality on Era and a little latency (median first turn 9.7 s vs 11.2 s, within run-to-run spread).
- **The §7.2 router is not warranted.** The main Opus session already calls `wowdata` itself where data exists: 13 calls for the turn-in route in both arms, with every stop from a data row. The errors seen are memory facts (spell levels, talents, zones, a zeppelin point) and miscounts that no plugin agent has data for. A router would add a turn and a subagent context and fix none of them.

## Totals

| Arm | Phase | Runs (errors) | Total cost | Mean cost | Median cost | Median wall time | `wowdata` calls | Plugin agent runs |
|---|---|---|---|---|---|---|---|---|
| A, no plugin | first | 10 (0) | $1.548 | $0.155 | $0.131 | 9.7 s | 16 | n/a |
| A, no plugin | resumed | 10 (0) | $0.297 | $0.030 | $0.019 | 6.3 s | 0 | n/a |
| B, plugin | first | 10 (0) | $1.545 | $0.154 | $0.131 | 11.2 s | 19 | 0 |
| B, plugin | resumed | 10 (0) | $0.318 | $0.032 | $0.019 | 7.5 s | 0 | 0 |

Spend: **$3.707** of the $4.00 cap, all 40 runs. No run hit its `--max-budget-usd` cap, and no run had a permission denial.

## Per prompt

Cost and wall time per run. Verdict is B against A: same, correct (B better), wrong (B worse), vaguer.

| Prompt | A first | B first | A resumed | B resumed | `wowdata` A / B | Verdict |
|---|---|---|---|---|---|---|
| where-trainer | $0.251 / 7.5 s | $0.198 / 7.2 s | $0.131 / 4.5 s | $0.144 / 6.4 s | 1 / 2 | correct (A has a wrong claim) |
| where-skinning | $0.148 / 13.9 s | $0.157 / 18.2 s | $0.021 / 6.6 s | $0.020 / 7.5 s | 1 / 1 | same |
| where-fishing | $0.142 / 8.2 s | $0.174 / 10.6 s | $0.020 / 6.1 s | $0.019 / 8.1 s | 1 / 3 | same first; A resumed off-topic |
| macro-opener | $0.128 / 7.3 s | $0.131 / 8.1 s | $0.020 / 8.4 s | $0.019 / 9.6 s | 0 / 0 | same |
| macro-pickpocket | $0.131 / 9.3 s | $0.131 / 13.8 s | $0.019 / 10.8 s | $0.020 / 7.5 s | 0 / 0 | same |
| route-turnins | $0.236 / 24.8 s | $0.240 / 24.2 s | $0.015 / 11.5 s | $0.023 / 9.6 s | 13 / 13 | correct (A has a wrong map point) |
| route-next-zone | $0.131 / 11.0 s | $0.131 / 11.7 s | $0.018 / 5.0 s | $0.018 / 5.2 s | 0 / 0 | same |
| advice-talents | $0.126 / 18.9 s | $0.127 / 9.9 s | $0.018 / 4.5 s | $0.018 / 6.3 s | 0 / 0 | same |
| advice-money | $0.129 / 10.1 s | $0.131 / 21.5 s | $0.017 / 4.2 s | $0.017 / 8.5 s | 0 / 0 | wrong (B miscounts) |
| lore-city | $0.125 / 6.9 s | $0.125 / 10.3 s | $0.018 / 7.0 s | $0.018 / 5.7 s | 0 / 0 | same first; B resumed miscounts |

No plugin agent ran in arm B, so every difference between the arms is run-to-run variance of the same Opus session, not an effect of the plugin.

### Notes

Checked against the prompt, the situation block and the synced Era data. "Memory" marks a game noun or number that came from no `wowdata` row (the accuracy rule).

- **where-trainer.** Both name Shenthul at 43.05, 53.74 on 1454 from `wow_npc` (community 1.12 data, labeled). B also names Ormok from a second `wow_npc` row. **A is wrong:** it says the ready quest 2479 turns in to Shenthul, and repeats it in the resumed turn. The data has Shenthul as the giver; the ender is NPC 2391, Serge Hinott. A made no `wow_quest` or `wow_npc` call for the quest. Subzone "cleft of shadow": situation block.
- **where-skinning.** Both say Artisan needs level 35 (B: and skill 200) and name Thuwd at 63.36, 45.42 from `wow_npc`. B says it is not sure he trains Artisan. The level 35 rule and "the drag" are memory. Both resumed turns note Skinning is 187/225, not capped. A also says "turn in your 7 finished quests", which is right.
- **where-fishing.** Both name Shankys at 69.99, 29.77 from `wow_npc`. B also gives `{item:6256}` from a `wow_item` row with its 23c price, and Lumak from `wow_npc`. "valley of honor" is memory. A's resumed turn answers the wrong question (train at the rogue trainer); B's says to buy the pole.
- **macro-opener.** Same macro in both: `/cast [stealth] Cheap Shot; Sinister Strike`. Both say Cheap Shot is trained at 26 and suggest Garrote until then. Spell names and levels are memory; no `wow_spell` call.
- **macro-pickpocket.** Same macro in both (`/cast Pick Pocket`, `/startattack`). Spell names are memory.
- **route-turnins.** Both list the 7 ready quests (235, 1060, 1483, 264, 1130, 1489, 2479, matching the `*` marks), look up each quest's ender with `wow_quest` and `wow_npc`, and draw the same 7 turn-in points in the same order (Ashenvale, Stonetalon twice, Thunder Bluff twice, Silverpine, Hillsbrad), all from data rows. **A adds an eighth point**, "Zeppelin to Undercity" at 50.8, 12.6 on uiMap 1454. That point is memory and on the wrong map: the zeppelin towers are outside the city, in Durotar. B mentions the zeppelin in text only. B's resumed turn names a flight master "on the west side of org" and a road through Azshara: memory, and doubtful.
- **route-next-zone.** A: Stonetalon and Ashenvale, then Hillsbrad at 22, with Wailing Caverns or Razorfen Kraul groups. B: Ashenvale or Hillsbrad, then Thousand Needles at 25. Both say to turn in the 7 ready quests first. All zones and level ranges are memory; no `wowdata` call.
- **advice-talents.** Both say stay Combat. A: Precision and Dual Wield Specialization next, then Blade Flurry and Sword Specialization. B: Combat to 31 for Blade Flurry and Sword Specialization, then Assassination. Talent names are memory; the data has no talent tables.
- **advice-money.** Both say train first, get the level 20 poison quest, skip gear. **B says "8 ready quests"**; the log has 7. A says 7. All advice is memory.
- **lore-city.** Same story in both: Thrall, the internment camps, the blood curse, the move to Kalimdor, named for Orgrim Doomhammer. Memory; lore is not in the data. B's resumed turn again says "8 quests that are ready".

## Method

- Two arms, both `claude-opus-5-5`, one stable scratch folder per arm (`ask-A`, `ask-B`), as live `ask` runs use. A = no plugin. B = `--plugin-dir <abs>/assets/plugins/claude-wow`. Both arms get `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, because the bridge sets it for every Claude `ask` run.
- The argv came from the bridge's own builders, as in the step 5 `wowdata` run: config from `dev/sandbox.js` `buildConfig` (the `config.example.json` `agents.claude` block), `P.withRunOnlyRules` with `DM.launchConfig(...).rules` (`mcp__wowdata`), `P.withRunDeniedRules` with the `ask` deny rules without the live socket (goal write tools, `mcp__wowgoals`, `Read(<home>/**)`, `Grep`, `Glob`, `LS`, `NotebookRead`), `--mcp-config` from `GM.mcpConfig`, `AGENTS.claude.args`, `.input` and `.env`. System prompt from `P.systemPrompt(ctx, primer, { tools, surfaces, voice })` of the `ask` plugin, message from `P.messagePrompt`. Default setting sources, no `--strict-mcp-config`, so the runs inherit this PC's `~/.claude` setup like live runs.
- Game data: a scratch `CLAUDE_WOW_HOME` with a read-only copy of the live Classic Era sync (client tables 1.15.9.70003 and community store `z2815-0a77f52-1`). `wowdata` was `connected` in every init and answered `buildCheck` `exact`.
- Situation block (not from a live report; built to fit an Era character):

```text
Game: World of Warcraft Classic (client 1.15.9.70003, interface 11509)
Character: Bone on Whitemane, level 20 Orc Rogue (Horde)
Location: Orgrimmar - Cleft of Shadow
Position: 44.1, 51.2 (map 1454)
Money: 21s 29c; XP: 91/23200
Talents: Assassination 0 / Combat 11 / Subtlety 0
Professions: Leatherworking 107/150, Skinning 187/225, Cooking 11/75, First Aid 97/150, Fishing 4/75
Quest log (id, * = ready to turn in): 6563,235*,5728,5761,896,863,852,882,899,1069,1060*,4921,878,1483*,868,264*,1130*,1489*,1491,959,2479*
```

- The quest log is step 1's log without the Forever-only 9xxxx IDs; every ID is in the Era `QuestV2` and community quest data. The 10 prompts are step 1's, word for word (`dev/measure-ask.js` `PROMPTS`); they fit an Era character as written. Follow-up: "thanks. in one sentence, what is the first thing I should do?", resumed with `--resume <session_id>`.
- Order: all first turns, then all follow-ups, so a budget stop would drop follow-ups before prompts. Arm order alternated per prompt. Each run had `--max-budget-usd` at most $0.60 (the first two at $0.80), and the script stopped before any run that could take the total past $3.85.
- Cost is `total_cost_usd`; a resumed turn's cost is the session total minus the first turn's. "Plugin agent ran" counts `Agent`/`Task` tool calls in the stream; `wowdata` calls count every `mcp__wowdata__*` tool call, main session or subagent.

## Limits

- n = 1 per prompt, phase and arm. The where-trainer first turns were the first runs in each new folder (cold); A's cost $0.251, B's $0.198.
- Both where-trainer resumed turns cost about $0.13, not $0.02, 7 minutes after the first turn. They missed the cache; I did not find why.
- Effort was the CLI default. The owner's live config sets `effort: max` and `model: opus[1m]`, so live turns cost more and may call tools more often.
- The prompts never name a plugin agent. A player who asks "use the planner" may get a delegation; that path was measured in step 5 ($0.18 for one planner run on Haiku plus Opus).
- Every init reported one `plugin_errors` entry for a user skill folder (`artifact-retention@skills-dir`, a malformed `hooks.json`) in both arms. It is in this PC's `~/.claude` setup, not in the claude-wow plugin.
- Correctness is judged against the synced data and the prompt. Facts marked memory are not checked against the live game.
