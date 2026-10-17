'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../bridge/datasync');
const GD = require('../bridge/gamedata');
const DM = require('../bridge/datamcp');
const IS = require('../bridge/itemstats');

const ERA_FIXTURES = path.join(__dirname, 'fixtures', 'wago-era');
const ERA_CLIENT = '1.15.9.70003';

function fakeWago(seen, missing = new Set()) {
  return async url => {
    const u = new URL(url);
    if (u.pathname === '/api/builds')
      return new Response(fs.readFileSync(path.join(ERA_FIXTURES, 'builds.json'), 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
    const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
    seen.push(table);
    if (missing.has(table)) return new Response('no such table', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(fs.readFileSync(path.join(ERA_FIXTURES, `${table}.csv`), 'utf8'), {
      status: 200,
      headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` },
    });
  };
}

async function eraStore(name, missing) {
  const dataDir = path.join(os.tmpdir(), `claude-wow-itemstats-${name}-${process.pid}-${Date.now().toString(36)}`, 'data');
  const seen = [];
  const r = await D.sync({ dataDir, flavor: 'classic_era', fetch: fakeWago(seen, missing) });
  return { store: GD.openStore({ dataDir, clientBuild: ERA_CLIENT }), seen, r };
}

const call = (store, tool, args) => JSON.parse(DM.callTool(store, tool, args).content[0].text);

function fakeStore(tables, flavor = 'forever') {
  return {
    flavor,
    has: e => e in tables,
    byId: (e, id) => (tables[e] || []).find(r => r.id === id) || null,
    group: (e, _name, keysOf) => {
      const m = new Map();
      for (const r of tables[e] || []) for (const k of keysOf(r)) m.set(k, [...(m.get(k) || []), r]);
      return m;
    },
  };
}

test('the client sync keeps item stats, equip effects and spell effects, and reads ItemSparse once', async () => {
  const { store, seen, r } = await eraStore('sync');
  assert.equal(seen.filter(t => t === 'ItemSparse').length, 1, 'one download serves both ItemSparse tables');
  assert.deepEqual(
    Object.keys(r.manifest.tables)
      .filter(k => k.startsWith('ItemSparse'))
      .sort(),
    ['ItemSparse', 'ItemSparse:stats'],
  );
  assert.equal(r.manifest.tablesVersion, 4);
  assert.deepEqual(
    store.rows('itemstats').map(row => row.id),
    [512],
    'only equippable items with stats',
  );
  assert.equal(r.manifest.tables.ItemEffect.droppedBy.badId, 1, 'an effect row with no spell is dropped and counted');
  const item = call(store, 'wow_item', { id: 512 }).results[0];
  assert.equal(item.trust, 'client-data');
  assert.deepEqual(item.stats.stats, { agility: 5, stamina: 3, bonusArmor: 10, armor: 40, fireResistance: 5, meleeHit: 1, spellDamage: 12 });
  assert.equal(item.stats.weapon, null);
  assert.deepEqual(
    item.stats.unread.map(u => [u.kind, u.spell]),
    [['onHit', 9202]],
    'an on-hit proc is listed, not read',
  );
  assert.deepEqual(item.stats.notCounted, [{ kind: 'use', spell: 9203 }]);
  assert.equal(item.stats.crossChecked, false, 'an item the wowsims data lacks says it was not cross-checked');
  assert.deepEqual(store.rows('spellequipreqs'), [{ id: 9401, spell: 9999, itemClass: 2, subclassMask: 262156, invTypeMask: 0 }]);
  assert.deepEqual(store.rows('spellforms'), [{ id: 9501, spell: 9998, masks: [3, 0] }]);
  assert.equal(call(store, 'wow_item', { name: 'Era Fixture Cap' }).results[0].stats, undefined, 'a name search stays short');
});

test('without the spell effect table there are no stats, rather than stats missing their equip effects', async () => {
  const { store, r } = await eraStore('missing', new Set(['SpellEffect']));
  assert.match(r.manifest.tables.SpellEffect.error, /404/);
  const answer = call(store, 'wow_item', { id: 512 });
  assert.equal(answer.results[0].stats, null);
  assert.deepEqual(answer.unavailable, [], 'a sync without the tables adds no unavailable note to every item answer');
});

test('the decoder reads weapons, skills, all-stat and school auras, and lists what it cannot read', () => {
  const store = fakeStore({
    itemstats: [
      {
        id: 1,
        damage: [[20, 40]],
        delay: 2600,
        stats: [
          [4, 3],
          [45, 9],
        ],
      },
      {
        id: 2,
        damage: [
          [10, 20],
          [3, 6],
        ],
        delay: 2000,
      },
      { id: 3, resistances: [0, 0, 0, 7, 0, 7, 0] },
    ],
    itemeffects: [
      { id: 11, item: 1, trigger: 1, spell: 101 },
      { id: 14, item: 4, trigger: 1, spell: 104 },
      { id: 15, item: 4, trigger: 1, spell: 105 },
      { id: 16, item: 4, trigger: 1, spell: 106 },
      { id: 12, item: 3, trigger: 1, spell: 102 },
      { id: 13, item: 3, trigger: 7, spell: 103 },
    ],
    spelleffects: [
      { id: 21, spell: 101, effect: 6, aura: 30, value: 5, misc: 95 },
      { id: 22, spell: 101, effect: 6, aura: 30, value: 3, misc: 173 },
      { id: 23, spell: 101, effect: 6, aura: 30, value: 2, misc: 762 },
      { id: 24, spell: 102, effect: 6, aura: 29, value: 2, misc: -1 },
      { id: 25, spell: 102, effect: 6, aura: 22, value: 10, misc: 4 | 16 },
      { id: 32, spell: 102, effect: 6, aura: 22, value: 4, misc: 1 },
      { id: 26, spell: 102, effect: 6, aura: 552, value: 1, misc: 4 },
      { id: 27, spell: 102, effect: 6, aura: 85, value: 4, misc: 1 },
      { id: 28, spell: 102, effect: 6, aura: 13, value: 9, misc: 4 },
      { id: 29, spell: 102, effect: 6, aura: 13, value: 9, misc: 1 },
      { id: 30, spell: 102, effect: 6, aura: 123, value: -10, misc: 124 },
      { id: 31, spell: 102, effect: 35, aura: 13, value: 7, misc: 126 },
      { id: 41, spell: 104, effect: 6, aura: 13, value: 12, misc: 126 },
      { id: 42, spell: 104, effect: 6, aura: 135, value: 12, misc: 126 },
      { id: 43, spell: 105, effect: 6, aura: 135, value: 22, misc: 126 },
      { id: 44, spell: 106, effect: 6, aura: 13, value: 5, misc: 126 },
      { id: 45, spell: 106, effect: 6, aura: 135, value: 9, misc: 126 },
    ],
  });
  const sword = IS.decode(store, 1);
  assert.deepEqual(sword.weapon, { min: 20, max: 40, speed: 2.6, dps: 11.5 });
  assert.deepEqual(sword.stats, { strength: 3, defense: 5, daggersSkill: 3 });
  assert.deepEqual(
    sword.unread.map(u => u.kind),
    ['itemStat', 'equip'],
    'an item stat id and a skill line it does not know',
  );
  assert.deepEqual(IS.decode(store, 2).unread, [{ kind: 'extraDamage', damage: [[3, 6]] }]);
  const ring = IS.decode(store, 3);
  assert.deepEqual(ring.stats, {
    natureResistance: 7,
    shadowResistance: 7,
    strength: 2,
    agility: 2,
    stamina: 2,
    intellect: 2,
    spirit: 2,
    fireResistance: 10,
    frostResistance: 10,
    bonusArmor: 4,
    fireSpellDamage: 9,
    spellPenetration: 10,
  });
  assert.deepEqual(
    ring.unread.map(u => [u.kind, u.kind === 'equip' ? `${u.effect}/${u.aura}` : u.trigger]),
    [
      ['equip', '6/552'],
      ['equip', '6/85'],
      ['equip', '6/13'],
      ['equip', '35/13'],
      ['trigger', 7],
    ],
    'crit for one school, regen of another power, physical damage done and other effects are not read',
  );
  assert.deepEqual(
    IS.decode(store, 4).stats,
    { spellPower: 12, healing: 31, spellDamage: 5 },
    'one spell raising damage and healing by the same amount is spell power; healing alone, or a different amount, is not',
  );
  assert.deepEqual(IS.decode(store, 99), { stats: {}, weapon: null, unread: [], notCounted: [], crossChecked: null });
});

const AURA_SHAPES = [
  [13, 126, 12, 'spellDamage'],
  [13, 4, 9, 'fireSpellDamage'],
  [135, 126, 22, 'healing'],
  [52, 0, 1, 'meleeCrit'],
  [54, 0, 1, 'meleeHit'],
  [55, 0, 1, 'spellHit'],
  [57, 0, 1, 'spellCrit'],
  [552, 126, 1, 'spellCrit'],
  [99, 0, 20, 'attackPower'],
  [124, 0, 20, 'rangedAttackPower'],
  [85, 0, 4, 'mp5'],
  [49, 0, 1, 'dodge'],
  [47, 0, 1, 'parry'],
  [51, 0, 1, 'block'],
  [564, 0, 30, 'blockValue'],
  [123, 124, -10, 'spellPenetration'],
  [30, 95, 7, 'defense'],
  [30, 43, 5, 'swordsSkill'],
  [29, 1, 3, 'agility'],
  [22, 1, 50, 'bonusArmor'],
];

test('every aura the decoder reads has a test with the shape the real tables use', () => {
  assert.deepEqual(
    Object.keys(IS.AURAS)
      .map(Number)
      .sort((a, b) => a - b),
    [...new Set(AURA_SHAPES.map(([aura]) => aura))].sort((a, b) => a - b),
    'an aura added to the decoder needs a row here',
  );
  for (const [aura, misc, value, name] of AURA_SHAPES) {
    const store = fakeStore({
      itemstats: [],
      itemeffects: [{ id: 1, item: 1, trigger: 1, spell: 9 }],
      spelleffects: [{ id: 2, spell: 9, effect: 6, aura, value, misc }],
    });
    const d = IS.decode(store, 1);
    assert.deepEqual([d.stats, d.unread], [{ [name]: Math.abs(value) }, []], `aura ${aura} misc ${misc}`);
  }
});

test('an equip spell with no effects is listed, and on Classic Era an item the wowsims data disagrees with is listed', () => {
  const noEffects = fakeStore({ itemstats: [], itemeffects: [{ id: 1, item: 1, trigger: 1, spell: 9 }], spelleffects: [] });
  assert.deepEqual(IS.decode(noEffects, 1).unread, [{ kind: 'equip', spell: 9, effect: null }]);
  const thunderfury = {
    itemstats: [
      {
        id: 19019,
        stats: [
          [3, 5],
          [7, 8],
        ],
        damage: [
          [82, 153],
          [16, 30],
        ],
        delay: 1900,
        resistances: [0, 0, 8, 9, 0, 0, 0],
      },
    ],
    itemeffects: [],
    spelleffects: [],
  };
  const era = IS.decode(fakeStore(thunderfury, 'classic_era'), 19019).unread.find(u => u.kind === 'sourcesDisagree');
  assert.deepEqual(era.fields, [{ name: 'weaponDamage', client: [82, 153], wowsims: [60, 145] }]);
  assert.equal(
    IS.decode(fakeStore(thunderfury, 'forever'), 19019).unread.some(u => u.kind === 'sourcesDisagree'),
    false,
    'the Era item data is not used for another game',
  );
  const matching = {
    itemstats: [
      {
        id: 19019,
        stats: [
          [3, 5],
          [7, 8],
        ],
        damage: [
          [44, 115],
          [16, 30],
        ],
        delay: 1900,
        resistances: [0, 0, 8, 9, 0, 0, 0],
      },
    ],
    itemeffects: [],
    spelleffects: [],
  };
  assert.equal(
    IS.decode(fakeStore(matching, 'classic_era'), 19019).unread.some(u => u.kind === 'sourcesDisagree'),
    false,
    'weapon damage matches with the extra damage added',
  );
});

test('random stats, shields, rows that would not convert and weapon-only equip spells are listed, never read as nothing', () => {
  const store = fakeStore({
    items: [
      { id: 1, inventoryType: 5 },
      { id: 2, inventoryType: 14 },
      { id: 3, inventoryType: 5 },
      { id: 4, inventoryType: 10 },
    ],
    itemstats: [
      { id: 1, random: true },
      { id: 2, resistances: [1500, 0, 0, 0, 0, 0, 0] },
      { id: 3, unreadable: 'badInteger' },
    ],
    itemeffects: [{ id: 1, item: 4, trigger: 1, spell: 9 }],
    spelleffects: [{ id: 2, spell: 9, effect: 6, aura: 52, value: 1, misc: 0 }],
    spellequipreqs: [{ id: 3, spell: 9, itemClass: 2, subclassMask: 262156 }],
  });
  assert.deepEqual(IS.decode(store, 1).unread, [{ kind: 'randomStats' }]);
  assert.deepEqual(IS.decode(store, 2), { stats: { armor: 1500 }, weapon: null, unread: [{ kind: 'shieldBlock' }], notCounted: [], crossChecked: null });
  assert.deepEqual(IS.decode(store, 3).unread, [{ kind: 'badRow', reason: 'badInteger' }]);
  assert.deepEqual(IS.decode(store, 4), {
    stats: {},
    weapon: null,
    unread: [{ kind: 'restricted', spell: 9, itemClass: 2, subclassMask: 262156 }],
    notCounted: [],
    crossChecked: null,
  });
});

test('the wowsims item file is compacted from the database, refuses a changed layout, and matches the pinned commit', () => {
  const SI = require('../dev/simitems');
  const stats = Array(44).fill(0);
  stats[1] = 5;
  stats[26] = 120;
  const items = SI.compact({ items: [{ id: 7, stats, weaponDamageMin: 10, weaponDamageMax: 20 }] });
  assert.deepEqual(Object.fromEntries(SI.FIELDS.map((f, i) => [f, items[7][i]]).filter(([, v]) => v)), {
    agility: 5,
    armor: 120,
    weaponMin: 10,
    weaponMax: 20,
  });
  assert.throws(() => SI.compact({ items: [{ id: 7, stats: stats.slice(1) }] }), /Stat enum changed/);
  assert.throws(
    () =>
      SI.compact({
        items: [
          { id: 7, stats },
          { id: 7, stats },
        ],
      }),
    /twice/,
  );
  assert.throws(() => SI.compact({}), /no items list/);
  const pinned = require('../bridge/simitems.json');
  assert.equal(pinned.commit, require('../dev/simweights').HEAD);
  assert.match(pinned.license, /^MIT License/);
  assert.deepEqual(pinned.fields, SI.FIELDS);
  assert.ok(Object.values(pinned.items).every(v => v.length === SI.FIELDS.length && v.every(Number.isFinite)));
  assert.deepEqual(pinned.items[19019].slice(-2), [60, 145], 'Thunderfury at its Era damage with the nature damage added');
});

test('the converters keep random stats, an unparsable stat cell and an unparsable restriction as flags, and the cross-check compares ordinary stats too', () => {
  const spec = key => D.TABLES.find(t => (t.key || t.table) === key);
  const csv = (s, rows) => [s.columns.join(','), ...rows.map(r => s.columns.map(c => (c in r ? r[c] : 0)).join(','))].join('\n');
  const stats = spec('ItemSparse:stats');
  const out = D.convertTable(
    stats,
    csv(stats, [
      { ID: 1, InventoryType: 5, RandomSelect: 12 },
      { ID: 2, InventoryType: 5, ItemRandomSuffixGroupID: 7 },
      { ID: 3, InventoryType: 5, StatModifier_bonusStat_0: 3, StatModifier_bonusAmount_0: 'x' },
      { ID: 4, InventoryType: 5 },
    ]),
    {},
  ).records;
  assert.deepEqual(out, [
    { id: 1, random: true },
    { id: 2, random: true },
    { id: 3, unreadable: 'badInteger' },
  ]);
  const reqs = spec('SpellEquippedItems');
  assert.deepEqual(
    D.convertTable(
      reqs,
      csv(reqs, [
        { ID: 1, SpellID: 9, EquippedItemClass: 2, EquippedItemSubclass: 'x' },
        { ID: 2, SpellID: 8, EquippedItemClass: -1 },
        { ID: 3, SpellID: 7, EquippedItemClass: 4, EquippedItemSubclass: 64 },
      ]),
      {},
    ).records,
    [
      { id: 1, spell: 9, unreadable: true },
      { id: 3, spell: 7, itemClass: 4, subclassMask: 64, invTypeMask: 0 },
    ],
  );
  const helm = { itemstats: [{ id: 12640, stats: [[4, 99]], resistances: [565, 0, 0, 0, 0, 0, 0] }], itemeffects: [], spelleffects: [] };
  const disagree = IS.decode(fakeStore(helm, 'classic_era'), 12640).unread.find(u => u.kind === 'sourcesDisagree');
  assert.ok(disagree && disagree.fields.some(f => f.name === 'strength' && f.client === 99), 'a primary stat that differs is listed');
});

test('equip spells that need a form are listed, and armor is compared with its bonus folded in', () => {
  const store = fakeStore({
    itemstats: [],
    itemeffects: [{ id: 1, item: 1, trigger: 1, spell: 9 }],
    spelleffects: [{ id: 2, spell: 9, effect: 6, aura: 99, value: 154, misc: 0 }],
    spellforms: [{ id: 3, spell: 9, masks: [3, 0] }],
  });
  assert.deepEqual(IS.decode(store, 1).unread, [{ kind: 'shapeshift', spell: 9, masks: [3, 0] }]);
  assert.deepEqual(IS.decode(store, 1).stats, {}, 'form-only attack power is not read');
  const pinned = require('../bridge/simitems.json');
  const at = (id, name) => pinned.items[id][pinned.fields.indexOf(name)];
  const hauberk = 3844;
  const total = at(hauberk, 'armor') + at(hauberk, 'bonusArmor');
  const era = items => fakeStore({ items: [{ id: hauberk, inventoryType: 5 }], itemstats: items, itemeffects: [], spelleffects: [] }, 'classic_era');
  const split = IS.decode(era([{ id: hauberk, resistances: [total - 120, 0, 0, 0, 0, 0, 0], bonusArmor: 120 }]), hauberk);
  assert.equal(split.crossChecked, true);
  assert.equal(
    split.unread.some(u => u.kind === 'sourcesDisagree' && u.fields.some(x => x.name === 'armor')),
    false,
    'base armor plus the green bonus matches',
  );
  const baseOnly = IS.decode(era([{ id: hauberk, resistances: [total - 120, 0, 0, 0, 0, 0, 0] }]), hauberk);
  assert.ok(
    baseOnly.unread.some(u => u.kind === 'sourcesDisagree' && u.fields.some(x => x.name === 'armor')),
    'without the bonus the armor disagrees',
  );
});
