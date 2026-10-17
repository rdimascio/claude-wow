'use strict';

const ENTITIES = Object.freeze(['itemstats', 'itemeffects', 'spelleffects', 'spellequipreqs']);
const INVENTORY_SHIELD = 14;
const APPLY_AURA = 6;
const TRIGGER = Object.freeze({ use: 0, equip: 1, onHit: 2 });
const ALL_MAGIC = 126;
const MAGIC_BUT_HOLY = 124;
const CROSS_CHECK_FLAVOR = 'classic_era';
const MOD_DAMAGE_DONE = 13;
const MOD_HEALING_DONE = 135;
const SCHOOLS = Object.freeze([
  [1, 'physical'],
  [2, 'holy'],
  [4, 'fire'],
  [8, 'nature'],
  [16, 'frost'],
  [32, 'shadow'],
  [64, 'arcane'],
]);
const RESISTANCE_INDEX = Object.freeze(['armor', 'holy', 'fire', 'nature', 'frost', 'shadow', 'arcane']);
const ITEM_STATS = Object.freeze({ 3: 'agility', 4: 'strength', 5: 'intellect', 6: 'spirit', 7: 'stamina' });
const AURA_STATS = Object.freeze({ 0: 'strength', 1: 'agility', 2: 'stamina', 3: 'intellect', 4: 'spirit' });
const DEFENSE_SKILL = 95;
const WEAPON_SKILLS = Object.freeze({
  43: 'swords',
  44: 'axes',
  45: 'bows',
  46: 'guns',
  54: 'maces',
  55: 'twoHandedSwords',
  136: 'staves',
  160: 'twoHandedMaces',
  172: 'twoHandedAxes',
  173: 'daggers',
  176: 'thrown',
  226: 'crossbows',
  229: 'polearms',
  473: 'fistWeapons',
});
const POWER_MANA = 0;

function schoolOf(mask) {
  if (mask === ALL_MAGIC) return 'allMagic';
  const one = SCHOOLS.find(([bit]) => bit === mask);
  return one ? one[1] : null;
}

function add(stats, name, value) {
  stats[name] = (stats[name] || 0) + value;
}

const AURAS = Object.freeze({
  [MOD_DAMAGE_DONE]: (stats, e) => {
    const school = schoolOf(e.misc);
    if (school === 'allMagic') return add(stats, 'spellDamage', e.value);
    if (school && school !== 'physical') return add(stats, `${school}SpellDamage`, e.value);
    return false;
  },
  [MOD_HEALING_DONE]: (stats, e) => add(stats, 'healing', e.value),
  52: (stats, e) => add(stats, 'meleeCrit', e.value),
  54: (stats, e) => add(stats, 'meleeHit', e.value),
  55: (stats, e) => add(stats, 'spellHit', e.value),
  57: (stats, e) => add(stats, 'spellCrit', e.value),
  552: (stats, e) => (e.misc === ALL_MAGIC ? add(stats, 'spellCrit', e.value) : false),
  71: (stats, e) => (e.misc === ALL_MAGIC ? add(stats, 'spellCrit', e.value) : false),
  99: (stats, e) => add(stats, 'attackPower', e.value),
  124: (stats, e) => add(stats, 'rangedAttackPower', e.value),
  85: (stats, e) => (e.misc === POWER_MANA ? add(stats, 'mp5', e.value) : false),
  49: (stats, e) => add(stats, 'dodge', e.value),
  47: (stats, e) => add(stats, 'parry', e.value),
  51: (stats, e) => add(stats, 'block', e.value),
  564: (stats, e) => add(stats, 'blockValue', e.value),
  123: (stats, e) => (e.misc === ALL_MAGIC || e.misc === MAGIC_BUT_HOLY ? add(stats, 'spellPenetration', Math.abs(e.value)) : false),
  30: (stats, e) => {
    if (e.misc === DEFENSE_SKILL) return add(stats, 'defense', e.value);
    if (WEAPON_SKILLS[e.misc]) return add(stats, `${WEAPON_SKILLS[e.misc]}Skill`, e.value);
    return false;
  },
  29: (stats, e) => {
    const names = e.misc === -1 ? Object.values(AURA_STATS) : AURA_STATS[e.misc] ? [AURA_STATS[e.misc]] : [];
    if (!names.length) return false;
    for (const name of names) add(stats, name, e.value);
  },
  22: (stats, e) => {
    const schools = SCHOOLS.filter(([bit]) => e.misc & bit);
    if (!schools.length) return false;
    for (const [, school] of schools) add(stats, school === 'physical' ? 'bonusArmor' : `${school}Resistance`, e.value);
  },
});

function available(store) {
  const listed = store.manifest && store.manifest.entities ? store.manifest.entities : {};
  return ENTITIES.every(e => listed[e]) && ENTITIES.every(e => store.has(e));
}

function decode(store, itemId) {
  const row = store.byId('itemstats', itemId);
  const stats = {};
  const unread = [];
  const notCounted = [];
  if (row && row.unreadable) unread.push({ kind: 'badRow', reason: row.unreadable });
  if (row && row.random) unread.push({ kind: 'randomStats' });
  const item = store.byId('items', itemId);
  if (item && item.inventoryType === INVENTORY_SHIELD) unread.push({ kind: 'shieldBlock' });
  for (const [id, amount] of (row && row.stats) || []) {
    if (ITEM_STATS[id]) add(stats, ITEM_STATS[id], amount);
    else unread.push({ kind: 'itemStat', stat: id, amount });
  }
  (row && row.resistances ? row.resistances : []).forEach((n, k) => {
    if (n) add(stats, k === 0 ? 'armor' : `${RESISTANCE_INDEX[k]}Resistance`, n);
  });
  let weapon = null;
  if (row && row.damage && row.damage.length) {
    const [[min, max], ...extra] = row.damage;
    const speed = row.delay > 0 ? row.delay / 1000 : null;
    weapon = { min, max, speed, dps: speed ? Math.round(((min + max) / 2 / speed) * 10) / 10 : null };
    if (extra.length) unread.push({ kind: 'extraDamage', damage: extra });
  }
  const effectsOf = store.group('spelleffects', 'spell', e => [e.spell]);
  const restrictedTo = store.group('spellequipreqs', 'spell', e => [e.spell]);
  const triggers = store.group('itemeffects', 'item', e => [e.item]).get(itemId) || [];
  for (const t of triggers) {
    if (t.trigger === TRIGGER.use) {
      notCounted.push({ kind: 'use', spell: t.spell });
      continue;
    }
    if (t.trigger !== TRIGGER.equip) {
      unread.push({ kind: t.trigger === TRIGGER.onHit ? 'onHit' : 'trigger', trigger: t.trigger, spell: t.spell });
      continue;
    }
    const restriction = (restrictedTo.get(t.spell) || [])[0];
    if (restriction) {
      unread.push({ kind: 'restricted', spell: t.spell, itemClass: restriction.itemClass, subclassMask: restriction.subclassMask });
      continue;
    }
    const effects = effectsOf.get(t.spell) || [];
    if (!effects.length) {
      unread.push({ kind: 'equip', spell: t.spell, effect: null });
      continue;
    }
    const damage = effects.find(e => e.effect === APPLY_AURA && e.aura === MOD_DAMAGE_DONE && e.misc === ALL_MAGIC);
    const healing = effects.find(e => e.effect === APPLY_AURA && e.aura === MOD_HEALING_DONE);
    const bothAtOnce = damage && healing && damage.value === healing.value;
    if (bothAtOnce) add(stats, 'spellPower', damage.value);
    for (const e of effects) {
      if (bothAtOnce && (e === damage || e === healing)) continue;
      const read = e.effect === APPLY_AURA && AURAS[e.aura] ? AURAS[e.aura](stats, e) !== false : false;
      if (!read) unread.push({ kind: 'equip', spell: t.spell, effect: e.effect, aura: e.aura, misc: e.misc, value: e.value });
    }
  }
  if (store.flavor === CROSS_CHECK_FLAVOR) {
    const disagree = crossCheck(itemId, stats, row && row.damage);
    if (disagree) unread.push({ kind: 'sourcesDisagree', fields: disagree });
  }
  return { stats, weapon, unread, notCounted };
}

let simItems;

function crossCheck(itemId, stats, damage) {
  if (simItems === undefined) simItems = require('./simitems.json');
  const theirs = simItems.items[itemId];
  if (!theirs) return null;
  const at = name => theirs[simItems.fields.indexOf(name)];
  const fields = [];
  for (const name of simItems.fields) {
    if (name === 'weaponMin' || name === 'weaponMax') continue;
    const client = stats[name] || 0;
    if (Math.abs(client - at(name)) > 0.01) fields.push({ name, client, wowsims: at(name) });
  }
  const [main = [0, 0], ...extra] = damage || [];
  const withExtra = extra.reduce(([a, b], [lo, hi]) => [a + lo, b + hi], main);
  const matches = range => range[0] === at('weaponMin') && range[1] === at('weaponMax');
  if (!matches(main) && !matches(withExtra)) fields.push({ name: 'weaponDamage', client: main, wowsims: [at('weaponMin'), at('weaponMax')] });
  return fields.length ? fields : null;
}

module.exports = { ENTITIES, AURAS, available, decode };
