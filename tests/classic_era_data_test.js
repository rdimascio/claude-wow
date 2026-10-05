'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const D = require('../bridge/datasync');
const GD = require('../bridge/gamedata');
const GR = require('../bridge/gamerefs');
const OB = require('../bridge/observed');
const OT = require('../bridge/observedtools');
const G = require('../bridge/goals');

const ERA_FIXTURES = path.join(__dirname, 'fixtures', 'wago-era');
const FOREVER_FIXTURES = path.join(__dirname, 'fixtures', 'wago');
const ERA_BUILD = '1.15.9.300';
const FOREVER_BUILD = '1.60.1.200';
const ERA_CLIENT = '1.15.9.70003';
const FOREVER_CLIENT = '1.60.1.70124';
const ERA_CONTEXT = [
  `Game: World of Warcraft Classic (client ${ERA_CLIENT}, interface 11509)`,
  'Character: Bone on Fixture Realm, level 20 Orc Rogue (Horde)',
  'Professions: Skinning 187/225',
].join('\n');
const ERA_HIDE = 511;
const FOREVER_BLADE = 501;

function scratch(name) {
  const dir = path.join(os.tmpdir(), `claude-wow-era-${name}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeWago(fixtures) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/api/builds') return new Response(fs.readFileSync(path.join(fixtures, 'builds.json'), 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
    const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
    const headers = { 'content-type': 'text/csv; charset=UTF-8', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` };
    return new Response(fs.readFileSync(path.join(fixtures, `${table}.csv`), 'utf8'), { status: 200, headers });
  };
  return { fetchImpl, calls };
}

async function syncedData(name, { era = true, forever = true } = {}) {
  const dataDir = path.join(scratch(name), 'data');
  if (era) await D.sync({ dataDir, flavor: 'classic_era', fetch: fakeWago(ERA_FIXTURES).fetchImpl });
  if (forever) await D.sync({ dataDir, build: FOREVER_BUILD, fetch: fakeWago(FOREVER_FIXTURES).fetchImpl });
  return dataDir;
}

test('a build of the other flavor is refused before any fetch or folder', async () => {
  const dataDir = path.join(scratch('cross'), 'data');
  const wago = fakeWago(ERA_FIXTURES);
  await assert.rejects(D.sync({ dataDir, flavor: 'forever', build: ERA_BUILD, fetch: wago.fetchImpl }), /1\.15\.9\.300 is a Classic Era build, not Forever; sync it with --flavor classic_era/);
  await assert.rejects(D.sync({ dataDir, flavor: 'classic_era', build: FOREVER_BUILD, fetch: wago.fetchImpl }), /is a Forever build, not Classic Era; sync it with --flavor forever/);
  assert.equal(wago.calls.length, 0);
  assert.equal(fs.existsSync(dataDir), false);
});

test('the store follows the client build: an Era client reads Classic Era data, a Forever client reads Forever data', async () => {
  const dataDir = await syncedData('both');
  const era = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  assert.deepEqual([era.flavor, era.flavorLabel, era.build, era.buildCheck, era.rowTrust], ['classic_era', 'Classic Era', ERA_BUILD, 'family', 'client-data']);
  assert.equal(era.byId('items', ERA_HIDE).name, 'Era Fixture Hide');
  assert.equal(era.byId('items', FOREVER_BLADE), null);
  const forever = GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT });
  assert.deepEqual([forever.flavor, forever.build, forever.buildCheck], ['forever', FOREVER_BUILD, 'family']);
  assert.equal(forever.byId('items', FOREVER_BLADE).name, 'Fixture Blade');
  assert.equal(forever.byId('items', ERA_HIDE), null);
  assert.equal(GR.openFor(dataDir, ERA_CONTEXT).flavor, 'classic_era');
  const unknown = GD.openStore({ dataDir });
  assert.deepEqual([unknown.flavor, unknown.build], [null, null], 'no client build: no flavor is guessed');
  assert.equal(GR.createExpander(unknown).expand(`{item:${ERA_HIDE}}`).errors[0].reason, 'buildUnknown');
  const retail = GD.openStore({ dataDir, clientBuild: '12.0.1.66220' });
  assert.deepEqual([retail.flavor, retail.build], [null, null]);
  assert.match(GR.errorsText(GR.createExpander(retail).expand(`{item:${ERA_HIDE}}`).errors, retail), /Client build 12\.0\.1\.66220 belongs to no game the bridge has data for/);
});

test('a taught spell whose name starts with "the" is not indexed as a game phrase; other taught spells are', async () => {
  const dataDir = await syncedData('taught', { forever: false });
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  const words = new Set(['it', 'was', 'the', 'era', 'fixture', 'go', 'blast']);
  const check = text => GR.checkText(text, { store, names: [], plainWords: words, charRe: /[ -~]/, maxLength: 200 });
  assert.equal(check('it was the era fixture').ok, true, '"Schematic: The Era Fixture" adds no phrase');
  const blast = check('go era blast');
  assert.equal(blast.ok, false);
  assert.deepEqual(blast.phrases.map(p => [p.run, p.source]), [['era blast', 'spell taught by an item']]);
});

test('market_price on Classic Era gives the observed auction quote with rows, n and asOf and says how Era quotes are built; Forever has no such note', async () => {
  const dataDir = await syncedData('prices');
  const dir = scratch('price-lines');
  const key = G.characterOf(ERA_CONTEXT).key;
  const at = 1790000000;
  const lines = [
    OB.lineFor('ah', { key: 'a1', at, itemID: ERA_HIDE, price: 90, quantity: 4, rows: 2, stack: 3 }),
    OB.lineFor('ah', { key: 'a2', at, itemID: FOREVER_BLADE, price: 1500, quantity: 1 }),
    OB.lineFor('vendor', { key: 'v1', at, npcID: 3100, mapID: 9102, items: [{ itemID: ERA_HIDE, price: 60, stack: 1 }] }),
  ];
  fs.mkdirSync(path.join(dir, key), { recursive: true });
  fs.writeFileSync(path.join(dir, key, 'observed.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const price = async (context, itemID) => {
    const tools = OT.createObservedTools({ observed: OB.createObserved({ dir }), context: () => ({ text: context, at: Date.now() }), gameData: text => GR.openFor(dataDir, text) });
    const r = await tools.call('market_price', { itemID });
    assert.equal(r.ok, true, r.text);
    return JSON.parse(r.text);
  };
  const era = await price(ERA_CONTEXT, ERA_HIDE);
  assert.deepEqual(era.auctionHouse.latest, { price: 90, quantity: 4, rows: 2, stack: 3 });
  assert.deepEqual([era.auctionHouse.n, era.auctionHouse.asOf, era.auctionHouse.trust], [1, at * 1000, 'observed']);
  assert.deepEqual(era.vendors.map(v => [v.price, v.stack]), [[60, 1]]);
  assert.ok(era.notes.some(n => /Classic Era\) each auction quote is one complete search result/.test(n)), era.notes.join(' | '));
  assert.ok(!era.notes.some(n => /not collected/.test(n)), 'the old "not collected on Era" text is gone');
  const forever = await price(ERA_CONTEXT.replace(`World of Warcraft Classic (client ${ERA_CLIENT}, interface 11509)`, `World of Warcraft: Forever (client ${FOREVER_CLIENT}, interface 16001)`), FOREVER_BLADE);
  assert.deepEqual(forever.auctionHouse.latest, { price: 1500, quantity: 1 });
  assert.ok(!forever.notes.some(n => /complete search result/.test(n)));
});
