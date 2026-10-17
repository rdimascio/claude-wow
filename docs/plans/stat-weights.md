# Plan: item stats and sim stat weights

Status: revision 1 (2026-10-16). Owner decisions are recorded in §2. Steps ship as separate PRs with a two-seat review each.

## 1. Goal

Claude can say which of two items is better for the character's spec, with a number, from client item stats and wowsims stat weights.

## 2. Owner decisions (2026-10-16)

1. The score appears in `wowdata` answers only, labeled a sim estimate tuned for level 60. It never reaches orders or the stream overlay.
2. An item with an equip effect the decoder cannot read gets no score; the answer names the effect.
3. Specs whose Era weights are unchanged since the SoD fork (2024-11-21) get no score.
4. The level 60 weights are used at every level, labeled "tuned for level 60".
5. Item stats are cross-checked against the wowsims Era item database: an item whose client stats differ gets no score (2026-10-16, after the Thunderfury finding in §3).

## 3. Measured (Classic Era 1.15.9.70003, 2026-10-16)

- 13,952 equippable items. 9,287 have primary stats in `ItemSparse.StatModifier_bonusStat_*` (stat ids 3 Agility, 4 Strength, 5 Intellect, 6 Spirit, 7 Stamina; 38 and 51 once each). 9,926 have armor in `Resistances_0`. 2,543 weapons have `MinDamage_0`, `MaxDamage_0` and `ItemDelay`.
- Hit, crit, spell power, attack power, mp5, defense and similar are equip spells: `ItemEffect` rows with `TriggerType` 1 on 6,526 items, whose `SpellEffect` rows with `Effect` 6 carry `EffectAura`, `EffectBasePoints`, `EffectDieSides` and `EffectMiscValue_0`. The amount is `EffectBasePoints + EffectDieSides`: 201 of 201 equip spells whose name states the amount ("Attack Power 20", "Increase Spell Dam 12", "Increased Hit Chance 1") match.
- Aura 552 (spell crit by school mask) is on 1,651 items; aura 593 (expertise) on 424 items, all Season of Discovery items (ids 233xxx).
- wowsims/classic (MIT) at `7779ebb`: of 19 simulators, 4 have Era-tuned hit or crit weights on the per-percent scale (rogue, elemental shaman, warlock, feral druid); see `bridge/simweights.json` for why each other is left out.
- The Era client's `ItemSparse` carries Season of Discovery values for some shared items: Thunderfury 19019 reads 82-153 plus 16-30 nature, the Era item is 44-115 plus 16-30 (wowsims 60-145, nature folded in). Against the 7,553 items of the wowsims Era database, 258 of 6,749 fully read items differed on stats and 57 of 1,113 weapons on damage.

## 4. Steps

1. **Item stats (client data):** optional tables `ItemSparse` stats (entity `itemstats`), `ItemEffect` rows (`itemeffects`), `SpellEffect` rows (`spelleffects`); `bridge/itemstats.js` decodes an item into named stats and lists effects it cannot read; `wow_item` by id returns them with trust `client-data`.
2. **wowsims weights:** a sync source for the re-tuned Era `epWeights` at a pinned commit, strict parser, attribution link back to wowsims.
3. **Score:** a `wowdata` tool that scores items for a class and spec, compares them, and refuses items with unread effects and specs without Era weights.

## 5. Decoder facts (step 1)

`node dev/measure-itemstats.js` prints the current numbers from the synced data (items with an inventory type, unread kinds, unread auras, stats read). On 1.15.9.70003: 9,995 of 15,174 read in full; 7,739 of 10,668 with IDs under 200000. Items by unread kind: randomStats 1,745, equip 1,374, itemStat 1,290 (stat id -1, SoD only), shieldBlock 416, sourcesDisagree 383, onHit 366, restricted 29, trigger 28, extraDamage 22.

- One equip spell with aura 13 (all magic) and aura 135 at the same value is `spellPower` (wowsims `StatSpellPower`); aura 13 alone is `spellDamage`, aura 135 alone `healing`.
- `Resistances_0` is base armor (`StatArmor`); aura 22 on the physical school is `bonusArmor`. Aura 564 is block value; aura 123 with misc 124 (all magic but holy) is spell penetration.
- An equip spell with a `SpellEquippedItems` row (Fletcher's Gloves: crit with ranged weapons only) is listed, not read.

## 6. Score mapping (step 3)

Each decoded stat name maps to one wowsims `Stat` or `PseudoStat`: primary stats, `spellPower`, `spellDamage`, `healing` (`StatHealingPower`), `<school>SpellDamage` (`Stat<School>Power`), `mp5`, `spellHit`, `spellCrit`, `spellPenetration`, `attackPower`, `rangedAttackPower`, `meleeHit`, `meleeCrit`, `armor`, `bonusArmor`, `defense`, `block`, `blockValue`, `dodge`, `parry`, `<school>Resistance`, `<weapon>Skill` (`PseudoStat<Weapon>Skill`), and weapon dps (`PseudoStatMainHandDps`, `PseudoStatOffHandDps` for off-hand-only items, `PseudoStatRangedDps` for ranged). A test fails when the decoder gains a stat name the mapping lacks.
