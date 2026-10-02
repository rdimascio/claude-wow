# Plan: Classic Era NPC and quest data from VMaNGOS

Status: draft, revision 1 (2026-10-02). Replaces the blocked QuestieDB source (`router-and-game-data.md` §4.1, decision 3) for Classic Era only.

## 1. Problem

The synced client tables (wago.tools DB2) hold item, zone, flight path, skill line and quest IDs. They have no NPC names or spawns, no quest titles, givers, enders or objectives, and no spell names. So Claude cannot answer "where is the quest giver for X" from data, `{npc:ID}` and `{quest:ID}` have no name source in orders, and the NPC part of the accuracy rule is unenforced.

QuestieDB has this data, but the repository has no license (checked 2026-10-02: the GitHub API reports none, and the root has no LICENSE file), so we may not copy or reuse it.

## 2. Source

VMaNGOS (`github.com/vmangos/core`, GPL-2.0, a 1.12.1 server emulator). The `db_latest` release (2026-09-28) has `db-sqlite-4641790.zip` (40 MB zipped). It holds `mangos.sqlite`, the world database, plus `characters`, `logon` and `logs` databases that we never open.

Measured from that file:

| Table | Rows | Used for |
|---|---|---|
| `creature_template` | 15,217 (rows per `patch` 0..10) | NPC name, subname, level, faction, npc flags |
| `creature` | 66,243 | NPC spawns: `map`, `position_x/y/z`, `patch_min/max` |
| `quest_template` | 4,727 (4,433 distinct entries) | quest title, level, objectives text |
| `creature_questrelation` / `creature_involvedrelation` | 3,908 / 4,069 | quest givers and enders |
| `gameobject_template` / `gameobject` | 9,530 / 56,639 | objects and their spawns |
| `gameobject_questrelation` / `gameobject_involvedrelation` | 262 / 209 | object quest givers and enders |
| `creature_loot_template`, `npc_vendor`, `npc_trainer` | 232,486 / 13,269 / 4,676 | not imported in v1 (see §6) |

Coverage against the Era client (`QuestV2`, build 1.15.9.70003): 4,807 Era quest IDs, 4,433 VMaNGOS quest IDs, 3,659 in both. 1,148 Era IDs have no VMaNGOS row (likely Season of Discovery and later content that shares the client), and 774 VMaNGOS IDs are not in the Era client.

Spot checks: quest 364 (The Mindless Ones) has giver 1569; NPC 1568 (Undertaker Mordo) spawns on map 0 at 1678.99, 1667.86.

## 3. Design

### 3.1 Sync

- New source in `bridge/datasync.js`, flavor `classic_era` only: `claude-wow data sync --flavor classic_era --source vmangos`. It never runs for Forever.
- Download the release asset from `github.com/vmangos/core/releases/download/db_latest/` with the same rules as the wago fetch: fixed origin (GitHub plus its release CDN host, both named), size cap, timeout, no redirects to other hosts, user agent.
- Record the asset name (it carries the commit, `4641790`), its SHA-256 and `fetchedAt` in the manifest. Unzip only `mangos.sqlite` into a temporary folder; delete it after conversion.
- Convert to JSONL entities next to the client data, in the same build folder: `npcs`, `npcspawns`, `questinfo`, `questgivers`, `objects`, `objectspawns`. The client data and the community data stay separate entities with separate `source` fields.
- Patch rows: take, per entry, the row with the highest `patch` (10 is 1.12). Spawns: keep rows whose `patch_max` is 10.
- Positions: convert `map` plus world x, y to uiMap percent with the existing `placeOnMap` (UiMapAssignment), the same code as flight paths. Map 0 and 1 are the continents; instance maps get no uiMap position in v1.
- Text: names and titles through the existing `toName` (no control or format characters, length cap). Quest objective text through a stricter cleaner, length-capped, never shown in game in v1.

### 3.2 Reading SQLite

- Node: `node:sqlite` (`DatabaseSync`, read-only). It exists from Node 22.5; `package.json` says `>=22.2`, so the minimum becomes 22.5. CI runs `node-version: 22` (latest 22.x).
- The release binary is built with Bun 1.4.2, which has `bun:sqlite` and not `node:sqlite`. One small adapter picks the runtime's module; both are read-only and run the same fixed queries.
- No new npm dependency.

### 3.3 Trust and the accuracy rule

- Every row from this source carries `source: "vmangos"`, the asset commit, and `trust: "community-db"`. It is never `client-data`.
- An NPC or quest name is shown in game only through a token the bridge expands (`{npc:ID}`, `{quest:ID}`), never typed by the model.
- A `{quest:ID}` expands only when the ID is also in the Era client's `QuestV2` (the 3,659 overlap), so a quest the client does not have never gets a name.
- `{npc:ID}` has no client table to cross-check. It expands from `community-db`, and the order or reply text says the name is from community data only where the surface allows a note (wowdata answers). Open question 1.
- Positions from spawns are `community-db` and labeled so on the map ("community data") the same way model estimates are labeled today.
- The phrase index (refused multi-word game names in orders and the roast card) gains NPC names and quest titles, which closes the "no NPC names" gap the docs name today. It must be measured against real data for false refusals first (2,359 shared item names taught us names are not unique, and quest titles hold plain phrases).

### 3.4 Tools

- `wow_npc {id | name}`: name, subname, level range, spawns per uiMap with percent positions, quests it gives and ends.
- `wow_quest {id}`: adds title, level, givers and enders (NPC or object, with positions). Still says the client data holds IDs only, and marks the extra fields `community-db`.
- `wow_where`: unchanged in v1.
- Shared-name notes as `wow_item` has (NPC names repeat: guards, vendors).

## 4. What it changes elsewhere

- `game-data-accuracy-rule`: NPCs and quest titles move from "no source" to "community-db". Docs (CONFIGURATION, LIVE-SESSION, the order_issue description, the LINK_HINT) change their wording.
- `gamerefs.js`: `{npc:ID}` and `{quest:ID}` stop being refused kinds for Era.
- System prompt change, so each Claude chat gets one new session (the rules hash).
- Disk: about 40 MB download, under 200 MB unzipped, deleted after conversion; the JSONL output is estimated at 10 to 20 MB (to measure).
- Sync time: one more download and a SQLite read; measure.

## 5. Risks

- Emulator data is a reconstruction of 1.12. Era 1.15.x has changed some spawns, quests and NPCs, and Era has content (SoD, Anniversary) VMaNGOS does not have. Wrong positions or givers are possible; `community-db` must be visible wherever it backs an answer.
- GPL-2.0: we download and use the data on the user's machine; nothing is committed or shipped. The GPL governs distribution, so local use is fine. Committing any converted rows (for example as test fixtures) would be distribution: fixtures must be hand-written, not copied.
- The release asset name changes with each build; the sync must find it through the release API, not a fixed URL. GitHub API rate limits apply without a token (60 requests an hour).
- A malformed or hostile database file: open read-only, run fixed queries only, cap row counts and text lengths, never execute SQL from the file.

## 6. Not in v1

- Loot tables (`creature_loot_template` drop chances are emulator guesses; the rule says unverified data never backs a number).
- Vendors and trainers (useful, but they need the same "never a number from community data" rule decided first).
- Forever (no licensed source).

## 7. Open questions

1. Is an NPC name from `community-db` acceptable in an order on the stream overlay, where there is no room for a label?
2. Should `{quest:ID}` in chat replies get a title from this data, or stay quest-log-only as the addon does today?
3. Is `--source vmangos` a separate command, or part of the default `--flavor classic_era` sync?

## 8. Steps

1. SQLite adapter (Node and Bun) and the Node 22.5 minimum, with tests.
2. Sync and convert to JSONL, with the manifest fields; measure rows, size and time on the real file.
3. `wow_npc` and the `wow_quest` fields.
4. Token expansion for `{npc:ID}` and `{quest:ID}` with the QuestV2 cross-check; phrase index measured on real data.
5. Docs, CHANGELOG, fresh-eyes per PR.
