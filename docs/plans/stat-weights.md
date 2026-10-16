# Plan: item stats and sim stat weights

Status: revision 1 (2026-10-16). Owner decisions are recorded in §2. Steps ship as separate PRs with a two-seat review each.

## 1. Goal

Claude can say which of two items is better for the character's spec, with a number, from client item stats and wowsims stat weights.

## 2. Owner decisions (2026-10-16)

1. The score appears in `wowdata` answers only, labeled a sim estimate tuned for level 60. It never reaches orders or the stream overlay.
2. An item with an equip effect the decoder cannot read gets no score; the answer names the effect.
3. Specs whose Era weights are unchanged since the SoD fork (2024-11-21) get no score.
4. The level 60 weights are used at every level, labeled "tuned for level 60".

## 3. Measured (Classic Era 1.15.9.70003, 2026-10-16)

- 13,952 equippable items. 9,287 have primary stats in `ItemSparse.StatModifier_bonusStat_*` (stat ids 3 Agility, 4 Strength, 5 Intellect, 6 Spirit, 7 Stamina; 38 and 51 once each). 9,926 have armor in `Resistances_0`. 2,543 weapons have `MinDamage_0`, `MaxDamage_0` and `ItemDelay`.
- Hit, crit, spell power, attack power, mp5, defense and similar are equip spells: `ItemEffect` rows with `TriggerType` 1 on 6,526 items, whose `SpellEffect` rows with `Effect` 6 carry `EffectAura`, `EffectBasePoints`, `EffectDieSides` and `EffectMiscValue_0`. The amount is `EffectBasePoints + EffectDieSides`: 201 of 201 equip spells whose name states the amount ("Attack Power 20", "Increase Spell Dam 12", "Increased Hit Chance 1") match.
- Aura 552 (spell crit by school mask, 1,651 effects) is common; aura 593 (expertise, 424 effects) is only on Season of Discovery items (ids 233xxx).
- wowsims/classic (MIT) at `7779ebb` has 18 Era sims, level 60 only. Against the fork commit `5634c85`, 10 have re-tuned `epWeights` (prot and ret paladin, hunter, rogue, ele and enh shaman, warlock, feral, feral tank and resto druid), 8 are unchanged SoD weights.

## 4. Steps

1. **Item stats (client data):** optional tables `ItemSparse` stats (entity `itemstats`), `ItemEffect` rows (`itemeffects`), `SpellEffect` rows (`spelleffects`); `bridge/itemstats.js` decodes an item into named stats and lists effects it cannot read; `wow_item` by id returns them with trust `client-data`.
2. **wowsims weights:** a sync source for the re-tuned Era `epWeights` at a pinned commit, strict parser, attribution link back to wowsims.
3. **Score:** a `wowdata` tool that scores items for a class and spec, compares them, and refuses items with unread effects and specs without Era weights.

## 5. Decoder facts (step 1, measured on the real 1.15.9.70003 tables)

- 11,072 of 13,952 equippable items read in full (79%); 8,828 of 9,486 with IDs under 200000 (93%). The rest carry procs (aura 42), dummy auras (4), haste (138, 140), run speed (31), effects against one creature type (102, 131, 180) or SoD-only stats (stat id -1, aura 593).
- One equip spell with aura 13 (all magic) and aura 135 at the same value is `spellPower` (damage and healing), which is wowsims `StatSpellPower`: 1,887 items. Aura 13 alone is `spellDamage` (`StatSpellDamage`, 373 items); aura 135 alone is `healing` (`StatHealingPower`, 969 items).
- `Resistances_0` is base armor (`StatArmor`); aura 22 on the physical school is `bonusArmor` (`StatBonusArmor`).
- Not yet checked against an in-game tooltip: compare a few items with the client before step 3 ships a score.

## 6. Score mapping (step 3)

Each decoded stat name maps to one wowsims `Stat` or `PseudoStat`: primary stats, `spellPower`, `spellDamage`, `healing` (`StatHealingPower`), `<school>SpellDamage` (`Stat<School>Power`), `mp5`, `spellHit`, `spellCrit`, `spellPenetration`, `attackPower`, `rangedAttackPower`, `meleeHit`, `meleeCrit`, `armor`, `bonusArmor`, `defense`, `block`, `blockValue`, `dodge`, `parry`, `<school>Resistance`, `<weapon>Skill` (`PseudoStat<Weapon>Skill`), and weapon dps (`PseudoStatMainHandDps`, `PseudoStatOffHandDps` for off-hand-only items, `PseudoStatRangedDps` for ranged). A test fails when the decoder gains a stat name the mapping lacks.
