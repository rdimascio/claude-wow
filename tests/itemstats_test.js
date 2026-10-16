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

function fakeStore(tables) {
  return {
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
  assert.deepEqual(item.stats.stats, { agility: 5, stamina: 3, armor: 40, fireResistance: 5, meleeHit: 1, spellDamage: 12 });
  assert.equal(item.stats.weapon, null);
  assert.deepEqual(
    item.stats.unread.map(u => [u.kind, u.spell]),
    [['onHit', 9202]],
    'an on-hit proc is listed, not read',
  );
  assert.deepEqual(item.stats.notCounted, [{ kind: 'use', spell: 9203 }]);
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
      { id: 30, spell: 102, effect: 6, aura: 123, value: -10, misc: 126 },
      { id: 31, spell: 102, effect: 42, aura: 0, value: 0, misc: 0 },
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
      ['equip', '42/0'],
      ['trigger', 7],
    ],
    'crit for one school, regen of another power, physical damage done and other effects are not read',
  );
  assert.deepEqual(
    IS.decode(store, 4).stats,
    { spellPower: 12, healing: 31, spellDamage: 5 },
    'one spell raising damage and healing by the same amount is spell power; healing alone, or a different amount, is not',
  );
  assert.deepEqual(IS.decode(store, 99), { stats: {}, weapon: null, unread: [], notCounted: [] });
});
