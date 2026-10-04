# Plan: the game data we do not have yet

Status: revision 2 (2026-10-02). Revision 1 was reviewed by fresh-eyes (fable and gpt-6-astra, 29 findings); this revision answers every one. Scope: every gap in the `wowdata` answers for Classic Era and Forever, except pet battles (owner's decision). Builds on `vmangos-era-data.md` (community data, PR #68, merged) and its Forever use (PR #75, open: the Forever rules below assume it merges).

## 1. Rules (unchanged, and what they mean here)

- **No community numbers, in fields or in prose.** Drop chances, costs, levels, counts and quantities from cMaNGOS are not shown. Quest objective text carries counts ("Kill 10 Kobold Vermin"), so community quest prose is not shown either; objectives come back as typed relations without quantities.
- **Client numbers are fine** when the client table says what they are (`BuyPrice` with `VendorStackCount`, `TaxiPath.Cost`), labeled as base values.
- **Every community relation joins through the right column** and is asserted after conversion (counts of unreferenced and unresolved rows recorded in the manifest).
- **Conditions are carried, not evaluated:** `questOnly` (negative loot chance) and `conditional` (`condition_id` > 0) are booleans on every relation; conditional rows are listed after unconditioned ones and labeled.
- **New client tables are optional** in the sync, and their absence never weakens an existing check (the phrase index keeps working without them).
- **Upgrades are explicit:** a new table or a new community field bumps a converter version (client manifest `tablesVersion`, community `SHAPE`), so a sync on an unchanged build is not skipped; readers pin the folder they opened and report the whole store unavailable when it is swept, never a half-old answer.
- **On Forever** (after PR #75): only IDs Forever's own client has; positions only on shared maps; trust `community-db-unchecked-for-this-game`. Measured: 2,347 creature loot rows and 28,917 of 33,360 reference loot rows name items Forever lacks; 133 shared item IDs have another name in Forever (those relations are dropped on Forever).

## 2. Coverage matrix

Counts measured 2026-10-02 (client: wago.tools CSV for Era `1.15.9.70003` and Forever `1.60.1.70094`; community: cMaNGOS `z2815`). "Step" refers to §3.

| Category | Source | Trust | Decision |
|---|---|---|---|
| Spell names | client `SpellName` (Era 31,249; Forever 31,716) | client | step 1 |
| Spell rank text ("Rank 3") | client `Spell.NameSubtext_lang` (35,312) | client | step 1 (same spell named "Blizzard" three times otherwise) |
| Faction names, `{faction:ID}` | client `Faction` (209; 253) | client | step 1 |
| Reputation rewards (what a faction sells) | community vendor rows with reputation conditions | community | step 4, as `conditional` |
| Instances (dungeon or raid) | client `Map` (`InstanceType` 1 or 2) limited to maps in `DungeonEncounter` | client | step 2 |
| Bosses per instance, world bosses | client `DungeonEncounter` (307; 342): name, `MapID`, order; MapID 0 for world bosses | client | step 2 |
| Instance level ranges | client `LFGDungeons` on Era only (21 dungeons + 5 raids, `MapID` is 0, names differ): a hand-checked name map, rows with Min > Max rejected; none on Forever (no level columns) | client | step 2, Era only |
| Attunements and keys | community entrance requirements (`areatrigger_teleport`: Onyxia needs Drakefire Amulet, Blackwing Lair quest 7761, Molten Core quest 7848) and client `Item` class 13 keys (133 on Era) | community + client | step 6 |
| Who drops what (gear, mounts) | community `creature_loot_template` via `creature_template.LootId`, `reference_loot_template` (measured 2026-10-04: depth 2 in 6 rows, no cycles; deeper nests and loops refuse the conversion), boss names joined to `DungeonEncounter` by exact name; encounter chests via `gameobject_loot_template` keyed by the chest's `data1` | community | step 3 |
| Skinning, pick pocket, fishing, containers, disenchant | `skinning_` via `SkinningLootId`, `pickpocketing_` via `PickpocketLootId`, `fishing_` by zone, `item_loot_template` (containers), `disenchant_loot_template` | community | step 3 |
| Mail and spell loot | `mail_loot_template`, `spell_loot_template` | community | not planned: rare questions; revisit on request |
| Mounts | client `ItemEffect` (16,965) joined to `SpellEffect` with aura 78 (mounted); the item class does not mark mounts on Era (all 1.12 mounts are class 15 subclass 0) | client | step 5 |
| Class mounts (Felsteed, Dreadsteed, Warhorse) | community quest reward spells (`RewSpell`, `RewSpellCast`) on quests 4490, 7631, 1661, typed, not assumed to teach | community | step 5 |
| Trainers (what you learn where) | community `npc_trainer` and `npc_trainer_template` via `TrainerTemplateId`, each teaching spell mapped to the learned spell through client `SpellEffect` effect 36; unmapped rows dropped and counted | community + client | step 4 |
| Recipe sources | client `ItemEffect` on recipe items to the teaching spell, then `SpellEffect` 36 to the craft spell; vendors and drops of the recipe item from steps 3 and 4 | client + community | step 4 |
| Vendors | community `npc_vendor` and `npc_vendor_template` via `VendorTemplateId`; 283 conditional rows labeled; base price `BuyPrice` per `VendorStackCount` from the client; the player's real price stays the observed one | community + client | step 4 |
| Services (innkeepers, bankers, flight masters, mailboxes) | community `creature_template.NpcFlags` bits; mailboxes from `gameobject` type 19 (77 templates) | community | step 7 |
| Flight path costs | client `TaxiPath` (294 rows on Era, `Cost` in copper, 28 free) | client | step 7 |
| Quest objectives (what to kill or collect) | community `ReqItemId`, `ReqCreatureOrGOId` (negative = object, 31 rows), `ReqSpellCast`, as relations without counts; objective prose not shown | community | step 6 |
| Quest rewards | community `RewItemId`, `RewChoiceItemId`, `RewSpell`; items checked against the client | community | step 6 |
| Quest chains | community `PrevQuestId` (negative = must be active, 42 rows), `NextQuestId`, `ExclusiveGroup` (shared prerequisite groups, e.g. 188, 193, 197 lead to 208); a typed relation, references to IDs the client lacks dropped and counted (17) | community | step 6 |
| Item sets and set bonuses | client `ItemSet` (481; 536), `ItemSetSpell` (1,276) with spell names | client | step 5 |
| Talents | client `Talent`, `TalentTab`, `ChrClasses` (432, 27, 9 on both games) | client | step 5 |
| Points of interest | client `AreaPOI` (359; 372) | client | step 7 |
| Gathering nodes (herbs, ore) | community `gameobject` spawns, skill from client `Lock` (258 rows; `gameobject_template.data0` is the lock ID); pooled spawns (20,853 of 47,827) marked `pooled` | community + client | step 7 |
| Rare spawns | community `creature_template.Rank` 2 or 4 | community | step 7 |
| World events | client `Holidays` has no names on Era (`HolidayNames` absent); community schedules differ from the real calendar | - | not planned: no trustworthy source |
| Honor ranks and titles | client `CharTitles` absent on Era | - | not planned: no source |
| Drop rates | the player's own observed loot (`farm_spot_lookup`) | observed | already built; community chances never shown |
| NPC levels, health, damage | community | - | not planned: community numbers |
| Pet battles | - | - | out of scope (owner) |

## 3. Order of work (one PR each, fresh-eyes per PR)

1. **Spell names and factions:** `SpellName`, `Spell` (rank text only), `Faction`; `wow_spell {id | name}`; `{faction:ID}` expands. The phrase index does not gain spell names in this step.
2. **Instances and bosses:** `Map`, `DungeonEncounter`, Era `LFGDungeons` levels; `wow_instance {id | name}`.
3. **Who drops what** (built 2026-10-04, PR "feat(data): who drops what"): the loot joins above, stored grouped by loot template (not expanded per NPC: the full expansion is 1,312,485 NPC-item pairs (1,313,686 in revision 2's count), 55 MB as flat JSONL), with a reverse index built on first use and its memory and latency measured; `wow_item.droppedBy`, `wow_npc.drops`, boss drops in `wow_instance`.
4. **Vendors, trainers, recipes:** `SpellEffect` (effect 36 only), `ItemEffect`; `soldBy`, `sells`, `teaches`, `taughtBy`, recipe sources.
5. **Mounts, item sets, talents:** `ItemEffect` + `SpellEffect` aura 78, quest reward spells, `ItemSet`, `ItemSetSpell`, `Talent*`.
6. **Quest details and attunements:** objectives as relations, rewards, typed chains, entrance requirements, keys.
7. **Places and services:** `AreaPOI`, `TaxiPath` costs, service NPCs and mailboxes, gathering nodes, rare spawns.
8. **Spell names in the phrase check:** after a verified spell-token path exists, measured on real data, with an optional source that never disables the rest of the index.

## 4. Open questions for the owner

1. Client base prices and flight costs are client numbers: fine to show, labeled as base values?
2. Conditional rows (reputation, quest, event gated): list them labeled "conditional", or leave them out until conditions are decoded?
3. World events and honor ranks have no trustworthy source: leave them out as planned?
