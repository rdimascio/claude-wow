# Plan: item stats and sim stat weights

Status: revision 1 (2026-10-16). Owner decisions are recorded in §2. Steps ship as separate PRs with a two-seat review each.

## 1. Goal

Claude can say which of two items is better for the character's spec, with a number, from client item stats and wowsims stat weights.

## 2. Owner decisions (2026-10-16)

1. The score appears in `wowdata` answers only, labeled a sim estimate tuned for level 60. It never reaches orders or the stream overlay.
2. An item with an equip effect the decoder cannot read gets no score; the answer names the effect.
3. Specs whose Era weights are unchanged since the SoD fork (2024-11-21) get no score.
4. The level 60 weights are used at every level, labeled "tuned for level 60".
5. Item stats are cross-checked against the wowsims Era item database: an item whose client stats differ gets no score (2026-10-16). The Thunderfury finding that prompted it was a misread `QualityModifier` (§3), not Season of Discovery data; the cross-check stays as a guard.

## 3. Measured (Classic Era 1.15.9.70003, 2026-10-16)

Every item count here comes from `node dev/measure-itemstats.js <dataDir>` (items with an inventory type > 0); its output lists the rest.

- 15,174 items have an inventory type; 10,274 read in full, 8,041 of the 10,668 with IDs under 200000.
- Primary stats sit in `ItemSparse.StatModifier_*`, base armor in `Resistances_0`. `QualityModifier` is the green "+X Armor" bonus on armor and a damage-per-second change on weapons (damage += modifier × speed): with it, all 1,391 weapons in the wowsims Era database match (Thunderfury reads 82-153 with modifier -20 at speed 1.9, so 44-115). Hit, crit, spell power, attack power, mp5 and defense are equip spells: `ItemEffect` trigger 1, then `SpellEffect` effect 6 with `EffectAura` and an amount of `EffectBasePoints + EffectDieSides` (201 of 201 equip spells whose name states the amount match).
- wowsims/classic (MIT) at `7779ebb`: of 19 simulators, 4 have Era-tuned hit or crit weights on the per-percent scale (rogue, elemental shaman, warlock, feral druid); `bridge/simweights.json` says why each other is left out.
- 11 of the 7,552 items the wowsims Era database also has disagree (resistances, armor, one each of defense, healing, spell damage and ranged attack power); they get no score. 5,104 items read in full are not in the wowsims database, so they are not cross-checked (`crossChecked: false`); 2,871 of them have IDs under 200000.
- Not yet compared with an in-game tooltip: check a few (Green Iron Hauberk, Naglering, Thunderfury) before step 3 ships a score.

## 4. Steps

1. **Item stats (client data):** optional tables `ItemSparse` stats (entity `itemstats`), `ItemEffect` rows (`itemeffects`), `SpellEffect` rows (`spelleffects`); `bridge/itemstats.js` decodes an item into named stats and lists effects it cannot read; `wow_item` by id returns them with trust `client-data`.
2. **wowsims weights:** a sync source for the re-tuned Era `epWeights` at a pinned commit, strict parser, attribution link back to wowsims.
3. **Score:** a `wowdata` tool that scores items for a class and spec, compares them, and refuses items with unread effects and specs without Era weights.

## 5. Decoder facts (step 1)

- One equip spell with aura 13 (all magic) and aura 135 at the same value is `spellPower` (wowsims `StatSpellPower`); aura 13 alone is `spellDamage`, aura 135 alone `healing`.
- `Resistances_0` is base armor; `QualityModifier` on an item without damage and aura 22 on the physical school are `bonusArmor`; on a weapon `QualityModifier` × speed is added to its damage; a negative value on an item without damage (2 items) is listed as unread. The cross-check compares their sum with wowsims armor plus bonus armor. Aura 564 is block value; aura 123 with misc 124 (all magic but holy) is spell penetration.
- An equip spell with a `SpellEquippedItems` row (Fletcher's Gloves: crit with ranged weapons only) or a `SpellShapeshift` mask (feral attack power in Cat or Bear form) is listed, not read.
- Unread kinds, aura counts and stats read: see the script output.

## 6. Score mapping (step 3)

Each decoded stat name maps to one wowsims `Stat` or `PseudoStat`: primary stats, `spellPower`, `spellDamage`, `healing` (`StatHealingPower`), `<school>SpellDamage` (`Stat<School>Power`), `mp5`, `spellHit`, `spellCrit`, `spellPenetration`, `attackPower`, `rangedAttackPower`, `meleeHit`, `meleeCrit`, `armor`, `bonusArmor`, `defense`, `block`, `blockValue`, `dodge`, `parry`, `<school>Resistance`, `<weapon>Skill` (`PseudoStat<Weapon>Skill`), and weapon dps (`PseudoStatMainHandDps`, `PseudoStatOffHandDps` for off-hand-only items, `PseudoStatRangedDps` for ranged). A test fails when the decoder gains a stat name the mapping lacks.
