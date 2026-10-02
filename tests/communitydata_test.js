'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const D = require('../bridge/datasync');
const GD = require('../bridge/gamedata');
const DM = require('../bridge/datamcp');
const S = require('../bridge/sqldump');
const C = require('../bridge/communitydata');

const ERA_FIXTURES = path.join(__dirname, 'fixtures', 'wago-era');
const SQL = fs.readFileSync(path.join(__dirname, 'fixtures', 'cmangos', 'classicdb.sql'), 'utf8');
const GZ = zlib.gzipSync(Buffer.from(SQL));
const DUMP = 'ClassicDB_1_12_1_z2815.sql.gz';
const RAW_URL = `https://raw.githubusercontent.com/cmangos/classic-db/master/Full_DB/${DUMP}`;
const ERA_CLIENT = '1.15.9.70003';

function scratch(name) {
  const dir = path.join(os.tmpdir(), `claude-wow-community-${name}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeWago(url) {
  const u = new URL(url);
  if (u.pathname === '/api/builds') return new Response(fs.readFileSync(path.join(ERA_FIXTURES, 'builds.json'), 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
  const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
  return new Response(fs.readFileSync(path.join(ERA_FIXTURES, `${table}.csv`), 'utf8'), { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` } });
}

function fakeGitHub({ gz = GZ, listing, status } = {}) {
  const calls = [];
  const entry = { name: DUMP, type: 'file', size: gz.length, sha: C.gitBlobSha(gz), download_url: RAW_URL };
  const fetchImpl = async url => {
    calls.push(url);
    if (status) return new Response('{}', { status, headers: status === 403 ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' } : {} });
    if (url === C.LISTING_URL) return new Response(JSON.stringify(listing || [{ name: '.gitignore', type: 'file' }, entry]), { status: 200 });
    if (url === RAW_URL) return new Response(gz, { status: 200 });
    return new Response('', { status: 404 });
  };
  return { fetchImpl, calls, entry };
}

async function eraData(name) {
  const dataDir = path.join(scratch(name), 'data');
  await D.sync({ dataDir, flavor: 'classic_era', fetch: async url => fakeWago(url) });
  return dataDir;
}

const call = (store, tool, args) => JSON.parse(DM.callTool(store, tool, args).content[0].text);

test('sqldump reads multi-row INSERTs with escapes, NULL and numbers, by column name', () => {
  const rows = [...S.rows(SQL, 'creature_template', ['Name', 'Entry', 'SubName'])];
  assert.deepEqual(rows.map(r => r.Entry), [7001, 7002, 7003, 7004, 7005]);
  assert.equal(rows[0].SubName, 'Quest Clerk');
  assert.equal(rows[1].SubName, null);
  assert.equal(rows[3].Name, "Fixture O'Brien");
  assert.equal(rows[4].Name, 'Fixture "Twin" Smith');
  assert.deepEqual([...S.rows(SQL, 'gameobject_involvedrelation', ['id'])], []);
  assert.throws(() => [...S.rows(SQL, 'npc_vendor', ['entry'])], /table npc_vendor is missing/);
  assert.throws(() => [...S.rows(SQL, 'creature_template', ['Nope'])], /column Nope is missing/);
  const broken = SQL.replace("(7001,'Fixture Giver','Quest Clerk',5)", "(7001,'Fixture Giver','Quest Clerk')");
  assert.throws(() => [...S.rows(broken, 'creature_template', ['Entry'])], /a row has 3 values for 4 columns/);
  assert.throws(() => [...S.rows(SQL.replace("'Fixture Rock')", "'Fixture Rock)"), 'gameobject_template', ['entry'])], S.DumpError);
  assert.throws(() => [...S.rows(SQL.replace('(10,8001,1,1,100,100)', '(10,8001,1,1,100,DROP)'), 'gameobject', ['id'])], /unexpected value/);
});

test('a community sync converts NPCs, spawns, quests and givers into their own store, labeled community-db', async () => {
  const dataDir = await eraData('sync');
  const gh = fakeGitHub();
  const r = await C.syncCommunity({ dataDir, fetch: gh.fetchImpl });
  assert.equal(r.status, 'synced');
  assert.equal(r.version, `z2815-${gh.entry.sha.slice(0, 7)}`);
  assert.deepEqual(r.manifest.droppedBy, { junk: 2, relationWithoutQuest: 1 });
  assert.equal(r.manifest.trust, 'community-db');
  assert.equal(r.manifest.client.build, '1.15.9.300');
  assert.equal(path.dirname(r.dir), path.join(dataDir, 'classic_era', 'community'));
  const cs = GD.openStore({ dataDir, clientBuild: ERA_CLIENT }).community;
  assert.equal(cs.trust, 'community-db');
  const giver = cs.byId('npcs', 7001);
  assert.deepEqual([giver.name, giver.subname, giver.gives, giver.ends, giver.spawnTotal], ['Fixture Giver', 'Quest Clerk', [111], [111], 2]);
  assert.deepEqual(giver.spawns[0].maps.map(m => m.uiMapID), [9102, 9101], 'a zone spawn lists the zone, then the continent');
  assert.deepEqual(giver.spawns[1], { mapID: 33, maps: [] }, 'a dungeon spawn has no world map');
  assert.equal(giver.spawns[0].event, undefined, 'a spawn removed during an event is a normal spawn');
  const wanderer = cs.byId('npcs', 7002);
  assert.deepEqual(wanderer.spawns.map(s => [s.shared || false, s.event || false]), [[true, false], [false, true]]);
  assert.equal(cs.byId('npcs', 7004).spawns[0].shared, true, 'every entry of a random spawn gets it');
  assert.equal(cs.byId('npcs', 7003), null, 'junk rows are dropped');
  assert.deepEqual(cs.byId('questinfo', 222), { id: 222, title: 'Fixture Errand', inClientData: false, givers: [{ kind: 'npc', id: 7002 }, { kind: 'object', id: 8001 }], enders: [] });
  assert.equal(cs.byId('questinfo', 111).inClientData, true);
  assert.deepEqual(cs.rows('objects').map(o => o.name), ['Fixture Poster'], 'only objects that give or end a quest');
  assert.equal(GD.openStore({ dataDir, clientBuild: '1.60.1.70124' }).community, null, 'Forever never reads it');

  const again = await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  assert.equal(again.status, 'current');
  await D.sync({ dataDir, flavor: 'classic_era', fetch: async url => fakeWago(url), force: true });
  assert.equal(C.readCommunity(C.communityRoot(dataDir)).version, r.version, 'a client re-sync leaves the community data in place');
  const forced = await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl, force: true });
  assert.equal(forced.status, 'synced');
  assert.deepEqual(fs.readdirSync(C.communityRoot(dataDir)).filter(n => !n.startsWith('.')).sort(), [path.basename(forced.dir), 'current'].sort());
});

test('a community sync refuses a bad listing, a file that does not match its sha, a rate limit, and missing client data', async () => {
  const dataDir = await eraData('refuse');
  const good = fakeGitHub();
  const tampered = Buffer.from(GZ);
  tampered[tampered.length - 9] ^= 1;
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ gz: tampered, listing: [good.entry] }).fetchImpl }), /does not match the git sha/);
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ listing: [good.entry, { ...good.entry, name: 'ClassicDB_1_12_1_z2816.sql.gz' }] }).fetchImpl }), /expected one ClassicDB_1_12_1_z<rev>\.sql\.gz, found 2/);
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ listing: [{ ...good.entry, download_url: 'https://example.com/cmangos/classic-db/master/Full_DB/' + DUMP }] }).fetchImpl }), /unexpected download URL/);
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ listing: [{ ...good.entry, size: 65 * 1024 * 1024 }] }).fetchImpl }), /outside 1\.\./);
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ status: 403 }).fetchImpl }), /rate limit .* used up; try again after 2026-/);
  const bomb = zlib.gzipSync(Buffer.alloc(300 * 1024 * 1024));
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ gz: bomb }).fetchImpl }), /cannot be unpacked within 268435456 bytes/);
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ gz: zlib.gzipSync(Buffer.from(SQL.replace(/CREATE TABLE `quest_template`/, 'CREATE TABLE `quest_other`'))) }).fetchImpl }), /table quest_template is missing/);
  assert.equal(C.readCommunity(C.communityRoot(dataDir)), null, 'nothing became current');
  assert.deepEqual(fs.readdirSync(C.communityRoot(dataDir)).filter(n => !n.startsWith('.')), [], 'no tmp folder is left');
  await assert.rejects(C.syncCommunity({ dataDir: path.join(scratch('empty'), 'data'), fetch: good.fetchImpl }), /Classic Era client tables are needed first/);
  assert.equal(good.calls.length, 0, 'nothing is fetched without client data');
});

test('data sync --source community is Classic Era only and goes through the CLI', async () => {
  assert.throws(() => D.parseArgs(['--source', 'community']), /for --flavor classic_era only/);
  assert.throws(() => D.parseArgs(['--flavor', 'classic_era', '--source', 'community', '--build', '1.15.9.1']), /--build is for the client tables/);
  assert.throws(() => D.parseArgs(['--source', 'questie']), /unknown source/);
  const home = scratch('cli');
  await D.sync({ dataDir: path.join(home, 'data'), flavor: 'classic_era', fetch: async url => fakeWago(url) });
  const out = [];
  const code = await D.main(['sync', '--flavor', 'classic_era', '--source', 'community'], { env: { CLAUDE_WOW_HOME: home }, fetch: fakeGitHub().fetchImpl, out: s => out.push(s), err: s => out.push(s) });
  assert.equal(code, 0, out.join(''));
  assert.match(out.join(''), /7 rows kept, 3 dropped; current community data z2815-[0-9a-f]{7}/);
});

test('wow_npc and wow_quest serve community rows with their own source and trust, and say when there are none', async () => {
  const dataDir = await eraData('tools');
  const before = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  const none = call(before, 'wow_npc', { name: 'Fixture' });
  assert.equal(none.found, false);
  assert.match(none.notes.join(' '), /--source community/);
  await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  const npc = call(store, 'wow_npc', { id: 7001 });
  assert.equal(npc.trust, 'community-db');
  assert.equal(npc.source, 'cmangos');
  assert.deepEqual(npc.results[0].gives, [{ id: 111, title: 'Fixture Errand' }]);
  assert.equal(npc.results[0].trust, 'community-db');
  assert.equal(npc.results[0].spawns[1].instanceMapID, 33);
  assert.equal('level' in npc.results[0] || 'MinLevel' in npc.results[0], false, 'no community numbers');
  assert.match(npc.notes[0], /community data .* Classic Era renamed some/);
  const onVale = call(store, 'wow_npc', { name: 'fixture', uiMapID: 9102 });
  assert.deepEqual(onVale.results.map(r => r.id), [7001, 7002]);
  assert.deepEqual(onVale.results[0].spawns.map(s => s.onMap.uiMapID), [9102]);
  const quest = call(store, 'wow_quest', { id: 111 });
  assert.equal(quest.trust, 'client-data');
  assert.equal(quest.results[0].title, null, 'the client part still has no title');
  assert.deepEqual(quest.results[0].community.givers, [{ kind: 'npc', id: 7001, name: 'Fixture Giver' }]);
  assert.equal(quest.results[0].community.trust, 'community-db');
  const onlyCommunity = call(store, 'wow_quest', { id: 222 });
  assert.equal(onlyCommunity.trust, 'community-db');
  assert.match(onlyCommunity.notes.join(' '), /not in the client data .* may not exist in this game/);
  const byTitle = call(store, 'wow_quest', { name: 'errand' });
  assert.deepEqual(byTitle.results.map(r => r.id), [111, 222]);
  assert.match(byTitle.notes.join(' '), /2 quests are titled "Fixture Errand"/);
  const forever = GD.openStore({ dataDir, clientBuild: '1.60.1.70124' });
  assert.match(call(forever, 'wow_npc', { id: 7001 }).notes.join(' '), /no data for NPCs/);
});
