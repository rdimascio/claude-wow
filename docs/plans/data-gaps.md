# Plan: the game data we do not have yet

Status: draft, revision 1 (2026-10-02). Scope: every gap in the `wowdata` answers for Classic Era and Forever, except pet battles (owner's decision; the Classic clients have none). Builds on `vmangos-era-data.md` (community data, PR #68) and the Forever use of it (PR #69).

## 1. What we have today

| Data | Source | Trust |
|---|---|---|
| Items (name, quality, levels, prices), quest IDs, zones, maps, flight paths, skill lines, recipe spells and reagents | client tables (wago.tools) | `client-data` |
| NPC names and titles, spawns, quest titles, quest givers and enders | cMaNGOS `classic-db` | `community-db` (Era), `community-db-unchecked-for-this-game` (Forever) |
| Vendor prices, auction prices, loot the player saw | the addon (observed) | `observed` |

## 2. The gaps, and where each one can come from

Every count below was measured on 2026-10-02: client tables with a GET of `https://wago.tools/db2/<Table>/csv?build=<build>` for Era `1.15.9.70003` and Forever `1.60.1.70094`, and cMaNGOS tables by parsing `ClassicDB_1_12_1_z2815.sql.gz` with `bridge/sqldump.js`.

### 2.1 From the client (trust `client-data`, both games)

| Gap | Table | Era rows | Forever rows | What it unlocks |
|---|---|---|---|---|
| Spell names | `SpellName` | 31,249 | 31,716 | `wow_spell`; names for recipes, trainer spells and talents; spell names in the phrase check (the gap the docs name today) |
| Dungeons and raids | `Map`, `LFGDungeons` | 59, 67 | 74, 71 | instance names, type (dungeon or raid), level range, entrance map |
| Factions | `Faction` | 209 | 253 | faction names; `{faction:ID}` tokens stop being refused |
| Item sets | `ItemSet` | 481 | 536 | set name and members (tier sets) |
| Talents | `Talent`, `TalentTab`, `ChrClasses` | 432, 27, 9 | 432, 27, - | talent trees per class, with spell names from `SpellName` |
| Points of interest | `AreaPOI` | 359 | 372 | named places with positions |
| Item classes | `Item` | 24,973 | - | class and subclass (mounts, bags, recipes, quest items) |

`Creature` has 1 row on Era: the client does not ship NPC names, so NPCs stay community data.

### 2.2 From cMaNGOS (trust `community-db`; on Forever the PR #69 rules)

| Gap | Tables | Rows | What it unlocks |
|---|---|---|---|
| Who drops what | `creature_loot_template`, `reference_loot_template`, `gameobject_loot_template` | 169,994, 33,366, 12,548 | "dropped by" for gear and mounts, bosses with their instance (from the boss's spawn map and the client `Map` name) |
| Skinning, pick pocket, fishing, containers | `skinning_`, `pickpocketing_`, `fishing_`, `item_loot_template` | 2,802, 6,910, 155, 3,791 | gather and container sources |
| Vendors | `npc_vendor`, `npc_vendor_template` | 11,890, 164 | "sold by"; the price comes from the client `BuyPrice` |
| Trainers | `npc_trainer`, `npc_trainer_template` | 27,309, 1,239 | "taught by", with spell names from `SpellName` |
| Quest details | `quest_template` (objectives text, required items and kills, reward items, previous and next quest) | 4,245 | what a quest asks for and gives, quest chains |
| Gathering nodes | `gameobject` + `gameobject_template` (to measure: the node types and their `Lock` skill) | to measure | herb and ore spawn points per zone |

## 3. Rules that carry over

- **No community numbers.** Drop chances, trainer costs, required levels, quest levels, stack counts and stock limits from cMaNGOS are emulator values: they are not shown. A number shown comes from the client (`BuyPrice`, `LFGDungeons` levels) or from what the player observed (`observed.jsonl`).
- **Names through tokens or labeled tool rows.** Client names (spells, factions, instances) can back tokens. Community names never reach the stream overlay.
- **Every new client table is optional in the sync** (like `SkillLineAbility`): a missing table marks its tools unavailable, never fails the sync.
- **Every community relation is checked against client IDs**: an item in a loot or vendor row must be in `ItemSparse`, a spell in `SpellName`, a quest in `QuestV2`; anything else is dropped and counted.
- **Measure before indexing names** in the phrase check (spell names include ordinary phrases), the same way item names were measured and left out.
- **On Forever**, community rows follow PR #69: only IDs Forever's own client has, positions only on shared maps.

## 4. Tools

- `wow_spell {id | name}`: client name and rank text, the skill line or talent tree it belongs to, and (community) the trainers that teach it.
- `wow_instance {id | name}`: name, type, level range (client), and (community) its bosses and their notable drops.
- `wow_item` gains: `set`, `droppedBy` (NPC or object, with its instance or zones), `soldBy`, `rewardFrom` (quests), `class` and `subclass`. Lists are capped with totals.
- `wow_npc` gains `drops`, `sells`, `teaches`.
- `wow_quest` gains `objectives` text, `requires` (items, kills, objects by ID and name), `rewards` (item IDs and names), `chain` (previous and next quest IDs that the client has).
- `wow_where` gains AreaPOI places and instances.
- `{faction:ID}` tokens expand from `Faction`.

## 5. Order of work (one PR each, fresh-eyes per PR)

1. **Client tables**: `SpellName`, `Map`, `LFGDungeons`, `Faction`, `ItemSet`, `Talent`, `TalentTab`, `ChrClasses`, `AreaPOI`, `Item` in the sync; `wow_spell`, `wow_instance`, item sets and classes; `{faction:ID}` tokens.
2. **Who drops what**: the loot tables with reference resolution (nested, cycle-safe, depth-capped), bosses mapped to instances, `droppedBy` and `drops`.
3. **Vendors and trainers**: `soldBy`, `sells`, `teaches`.
4. **Quest details**: objectives, requirements, rewards, chains.
5. **Gathering nodes**: herb and ore spawns by skill.
6. **Spell names in the phrase check**, measured on real data first.

## 6. Open questions

1. Quest objective text is Blizzard's prose: show it in `wowdata` answers only (labeled), never in game chat or on the overlay?
2. Are client numbers that describe content (instance level range, item set bonuses) fine to show? They pass the "never a community number" rule.
3. World events (`game_event`, 67 rows) have emulator schedules that differ from the real calendar: leave them out?

## 7. Not in this plan

- Pet battles (owner's decision).
- Drop rates, until the player's own observed loot has enough samples (`farm_spot_lookup` already does this per source).
- NPC levels, health, damage and factions from cMaNGOS (community numbers).
