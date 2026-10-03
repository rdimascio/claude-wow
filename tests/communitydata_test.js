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
const FOREVER_BUILD = '1.60.1.200';
const FOREVER_CLIENT = '1.60.1.70124';

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

function foreverFromEra(dataDir) {
  const era = D.readCurrent(path.join(dataDir, 'classic_era'));
  const root = path.join(dataDir, 'forever');
  const dir = path.join(root, FOREVER_BUILD);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(era.dir, dir, { recursive: true });
  const lines = file => fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const write = (file, rows) => fs.writeFileSync(path.join(dir, file), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const quests = lines('quests.jsonl').filter(q => q.id === 111);
  write('quests.jsonl', quests);
  write('uimapassignments.jsonl', lines('uimapassignments.jsonl').map(a => (a.uiMapID === 9101 ? { ...a, region: a.region.map(n => n * 2) } : a)));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.entities.quests.rows = quests.length;
  Object.assign(manifest, { flavor: 'forever', product: 'wow_cn_beta', build: FOREVER_BUILD, buildFamily: '1.60.1', tableHash: 'forever-fixture' });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'current'), FOREVER_BUILD + '\n');
}

const call = (store, tool, args) => JSON.parse(DM.callTool(store, tool, args).content[0].text);

test('sqldump reads multi-row INSERTs with escapes, NULL and numbers, by column name, and refuses forms it does not read', () => {
  const rows = [...S.rows(SQL, 'creature_template', ['Name', 'Entry', 'SubName'])];
  assert.deepEqual(rows.map(r => r.Entry), [7001, 7002, 7003, 7004, 7005, 7006, 7007, 7008, 7009]);
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
  const listed = SQL.replace('INSERT INTO `creature` VALUES', 'INSERT INTO `creature` (`guid`,`id`,`map`,`spawnMask`,`position_x`,`position_y`,`position_z`) VALUES');
  assert.throws(() => [...S.rows(listed, 'creature', ['id'])], /1 INSERT statement\(s\) in a form this reader does not read/);
  for (const spelling of ['INSERT INTO `creature`(`guid`) VALUES (1);', 'INSERT INTO creature VALUES (1);', 'insert  into `creature` values (1);']) {
    assert.throws(() => [...S.rows(SQL + spelling, 'creature', ['id'])], /in a form this reader does not read/, spelling);
  }
  assert.equal([...S.rows(SQL, 'creature_template', ['Entry'])].length, 9, 'a table whose name starts like another is not confused with it');
});

test('a community sync converts NPCs, spawns, quests and givers into their own store, labeled community-db', async () => {
  const dataDir = await eraData('sync');
  const gh = fakeGitHub();
  const r = await C.syncCommunity({ dataDir, fetch: gh.fetchImpl });
  assert.equal(r.status, 'synced');
  assert.equal(r.version, `z2815-${gh.entry.sha.slice(0, 7)}`);
  assert.deepEqual(r.manifest.droppedBy, { junk: 5, relationWithoutQuest: 1 });
  assert.equal(r.manifest.trust, 'community-db');
  assert.equal(r.manifest.client.build, '1.15.9.300');
  assert.equal(path.dirname(r.dir), path.join(dataDir, 'classic_era', 'community'));
  const cs = GD.openStore({ dataDir, clientBuild: ERA_CLIENT }).community;
  assert.equal(cs.trust, 'community-db');
  assert.equal(cs.stale, false);
  const giver = cs.byId('npcs', 7001);
  assert.deepEqual([giver.name, giver.subname, giver.gives, giver.ends, giver.spawnTotal], ['Fixture Giver', 'Quest Clerk', [111], [111], 2]);
  assert.deepEqual(giver.spawns[0].maps.map(m => m.uiMapID), [9102, 9101], 'a zone spawn lists the zone, then the continent');
  assert.deepEqual(giver.spawns[1], { mapID: 33, maps: [] }, 'a dungeon spawn has no world map');
  assert.equal(giver.spawns[0].event, undefined, 'a spawn removed during an event is a normal spawn');
  assert.deepEqual(giver.onMaps.map(m => [m.uiMapID, m.count]), [[9101, 1], [9102, 1]]);
  const wanderer = cs.byId('npcs', 7002);
  assert.deepEqual(wanderer.spawns.map(s => [s.shared || false, s.event || false]), [[true, false], [false, true]]);
  assert.equal(cs.byId('npcs', 7004).spawns[0].shared, true, 'every entry of a random spawn gets it');
  const twin = cs.byId('npcs', 7005);
  assert.equal(twin.spawnTotal, 1, 'an event entry substitution is one spawn of the substituted NPC, however many events list it');
  assert.equal(twin.spawns[0].event, true);
  assert.equal(cs.byId('npcs', 7006).name, 'Fixture Combat Dummy', 'a real NPC named Dummy is kept');
  assert.equal(cs.byId('npcs', 7003), null, 'junk rows are dropped');
  assert.equal(cs.byId('npcs', 7007), null);
  assert.equal(cs.byId('npcs', 7008), null, 'a test dummy is developer content');
  assert.equal(cs.byId('npcs', 7009), null);
  assert.deepEqual(cs.byId('questinfo', 222), { id: 222, title: 'Fixture Errand', inClientData: false, givers: [{ kind: 'npc', id: 7002 }, { kind: 'object', id: 8001 }], enders: [] });
  assert.equal(cs.byId('questinfo', 111).inClientData, true);
  assert.deepEqual(cs.rows('objects').map(o => [o.name, o.onMaps.map(m => m.uiMapID)]), [['Fixture Poster', [9101, 9102]]], 'only objects that give or end a quest');
  assert.equal(GD.openStore({ dataDir, clientBuild: '2.5.4.1' }).community, null, 'a game with neither flavor never reads it');

  const again = await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  assert.equal(again.status, 'current');
  await D.sync({ dataDir, flavor: 'classic_era', fetch: async url => fakeWago(url), force: true });
  assert.equal(C.readCommunity(C.communityRoot(dataDir)).version, r.version, 'a client re-sync leaves the community data in place');
  const forced = await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl, force: true });
  assert.equal(forced.status, 'synced');
  assert.deepEqual(fs.readdirSync(C.communityRoot(dataDir)).filter(n => !n.startsWith('.')).sort(), [path.basename(forced.dir), 'current'].sort());
});

test('an NPC with more spawns than the sample keeps every map it stands on', async () => {
  const dataDir = await eraData('many');
  const crowd = Array.from({ length: 40 }, (_, k) => `(${100 + k},7001,1,1,${-900 + k},-900,0)`).join(',');
  const sql = SQL.replace('INSERT INTO `creature` VALUES (1,7001,1,1,500,500,0),', `INSERT INTO \`creature\` VALUES ${crowd},(1,7001,1,1,500,500,0),`);
  await C.syncCommunity({ dataDir, fetch: fakeGitHub({ gz: zlib.gzipSync(Buffer.from(sql)) }).fetchImpl });
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  const giver = store.community.byId('npcs', 7001);
  assert.equal(giver.spawnTotal, 42);
  assert.equal(giver.spawns.length, C.MAX_SPAWNS);
  assert.ok(giver.spawns.some(s => s.maps.some(m => m.uiMapID === 9102)), 'the sample is spread over maps, not the first 25 rows');
  const onVale = call(store, 'wow_npc', { name: 'Fixture Giver', uiMapID: 9102 });
  assert.deepEqual(onVale.results.map(r => r.id), [7001]);
  assert.equal(onVale.results[0].onMap.count, 1);
  assert.match(onVale.results[0].spawnsShown, /^1 sampled of 1 on this map/);
  assert.match(call(store, 'wow_npc', { id: 7001 }).results[0].spawnsShown, /^25 of 42, spread over its maps/);
});

test('a map only seen past the spawn sample still finds the NPC and its position there', async () => {
  const dataDir = await eraData('pastsample');
  const dungeons = Array.from({ length: 30 }, (_, k) => `(${100 + k},7001,${200 + k},1,1,1,0)`).join(',');
  const sql = SQL.replace('INSERT INTO `creature` VALUES (1,7001,1,1,500,500,0),', `INSERT INTO \`creature\` VALUES ${dungeons},(1,7001,1,1,500,500,0),`);
  await C.syncCommunity({ dataDir, fetch: fakeGitHub({ gz: zlib.gzipSync(Buffer.from(sql)) }).fetchImpl });
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  assert.ok(!store.community.byId('npcs', 7001).spawns.some(s => s.maps.some(m => m.uiMapID === 9102)), 'precondition: the sample misses the vale');
  const onVale = call(store, 'wow_npc', { name: 'Fixture Giver', uiMapID: 9102 });
  assert.deepEqual(onVale.results.map(r => r.id), [7001]);
  assert.deepEqual([onVale.results[0].onMap.uiMapID, onVale.results[0].onMap.count, onVale.results[0].onMap.x], [9102, 1, 50]);
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
  assert.match(out.join(''), /8 rows kept, 6 dropped; current community data z2815-[0-9a-f]{7}/);
});

test('wow_npc, wow_quest and wow_sources serve community rows with their own source and trust, and say when there are none', async () => {
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
  assert.equal(npc.results[0].onMaps[1].x, 50, 'a placed spawn carries its percent position');
  assert.equal('level' in npc.results[0] || 'MinLevel' in npc.results[0], false, 'no community numbers');
  assert.match(npc.notes[0], /community data .* Classic Era renamed some/);
  const onVale = call(store, 'wow_npc', { name: 'fixture', uiMapID: 9102 });
  assert.deepEqual(onVale.results.map(r => r.id), [7001, 7002, 7005]);
  assert.deepEqual(onVale.results[0].spawns.map(s => s.maps[0].uiMapID), [9102]);
  const quest = call(store, 'wow_quest', { id: 111 });
  assert.equal(quest.trust, 'client-data');
  assert.equal(quest.results[0].title, null, 'the client part still has no title');
  assert.deepEqual(quest.results[0].community.givers, [{ kind: 'npc', id: 7001, name: 'Fixture Giver' }]);
  assert.equal(quest.results[0].community.trust, 'community-db');
  const onlyCommunity = call(store, 'wow_quest', { id: 222 });
  assert.equal(onlyCommunity.trust, 'community-db');
  assert.match(onlyCommunity.notes.join(' '), /not in the client data .* may not exist in this game/);
  assert.deepEqual(onlyCommunity.results[0].community.givers[1].onMaps.map(m => m.uiMapID), [9101, 9102], 'an object giver comes with the maps it stands on');
  assert.equal(onlyCommunity.results[0].community.givers[1].spawns[1].instanceMapID, 33, 'and its dungeon spawns');
  const byTitle = call(store, 'wow_quest', { name: 'errand' });
  assert.deepEqual(byTitle.results.map(r => r.id), [111, 222]);
  assert.match(byTitle.notes.join(' '), /2 quests are titled "Fixture Errand"/);
  const npcsFile = path.join(store.community.dir, 'npcs.jsonl');
  fs.writeFileSync(npcsFile, fs.readFileSync(npcsFile, 'utf8').split('\n').map(l => (l.startsWith('{"id":7001,') ? JSON.stringify({ ...JSON.parse(l), onMaps: JSON.parse(l).onMaps.map(m => ({ ...m, zoneAmbiguous: true })) }) : l)).join('\n'));
  const ambiguous = call(GD.openStore({ dataDir, clientBuild: ERA_CLIENT }), 'wow_npc', { id: 7001 });
  assert.deepEqual(ambiguous.results[0].onMaps.map(m => m.zoneAmbiguous), [true, true], 'an ambiguous position says so');
  const sources = call(store, 'wow_sources', {});
  const community = sources.results.find(r => r.source === 'cmangos');
  assert.equal(community.trust, 'community-db');
  assert.match(community.license, /GPL-3\.0/);
  assert.equal(community.positionsCurrent, true);
  assert.match(call(GD.openStore({ dataDir, clientBuild: '2.5.4.1' }), 'wow_npc', { id: 7001 }).notes.join(' '), /no data for NPCs/);
});

test('community positions computed with other client data are left out, and a damaged community table is reported in the same answer', async () => {
  const dataDir = await eraData('stale');
  const r = await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  const manifestFile = path.join(r.dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, client: { ...manifest.client, tableHash: 'other' } }));
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  assert.equal(store.community.stale, true);
  const npc = call(store, 'wow_npc', { id: 7001 });
  assert.equal(npc.results[0].onMaps[0].x, undefined, 'no stale coordinates');
  assert.equal(npc.results[0].spawns[0].maps[0].x, undefined);
  assert.equal(npc.results[0].name, 'Fixture Giver', 'names still answer');
  assert.match(npc.notes.join(' '), /computed with client data 1\.15\.9\.300, not the client data synced now \(1\.15\.9\.300\)/);
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, entities: { ...manifest.entities, questinfo: { ...manifest.entities.questinfo, rows: 99 } } }));
  const damaged = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  const quest = call(damaged, 'wow_quest', { id: 111 });
  assert.equal(quest.results[0].community, undefined);
  assert.deepEqual(quest.unavailable, ['questinfo']);
  assert.match(quest.notes.join(' '), /Table questinfo is unavailable/);
  assert.deepEqual(call(damaged, 'wow_npc', { id: 7006 }).unavailable, [], 'the failure is not carried into the next answer');
});

test('onMaps keeps an ordinary position over an event-only one, and the ambiguity of the position it shows', () => {
  const mapped = (x, extra = {}) => ({ maps: [{ uiMapID: 5, x, y: x }], ...extra });
  const npc = C.finishSpawns({ id: 1, all: [mapped(1, { event: true }), mapped(2, { zoneAmbiguous: true }), mapped(3)] });
  assert.deepEqual(npc.onMaps, [{ uiMapID: 5, count: 3, x: 2, y: 2, zoneAmbiguous: true }]);
  const eventOnly = C.finishSpawns({ id: 2, all: [mapped(7, { event: true }), mapped(8, { event: true })] });
  assert.deepEqual(eventOnly.onMaps, [{ uiMapID: 5, count: 2, x: 7, y: 7, event: true }]);
});

test('on Forever the Classic community data shows only quests the Forever client has and maps the same in both games, labeled unchecked for Forever', async () => {
  const dataDir = await eraData('forever');
  await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  foreverFromEra(dataDir);
  const store = GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT });
  assert.equal(store.flavor, 'forever');
  const cs = store.community;
  assert.deepEqual([cs.crossGame, cs.trust, cs.stale], [true, 'community-db-unchecked-for-this-game', false]);
  assert.deepEqual([...cs.sameMaps()], [9102], 'the continent rectangle changed, the vale did not');
  const npc = call(store, 'wow_npc', { id: 7001 });
  assert.equal(npc.trust, 'community-db-unchecked-for-this-game');
  assert.equal(npc.results[0].trust, 'community-db-unchecked-for-this-game');
  assert.deepEqual(npc.results[0].onMaps.map(m => m.uiMapID), [9102], 'no position on a map Forever draws differently');
  assert.deepEqual(npc.results[0].spawns.map(s => s.maps.map(m => m.uiMapID)), [[9102]], 'and no dungeon spawn');
  assert.match(npc.notes[0], /Classic community data .* not checked for this game/);
  const wanderer = call(store, 'wow_npc', { id: 7002 });
  assert.deepEqual(wanderer.results[0].gives, [], 'a quest the Forever client does not have is left out');
  assert.equal(call(store, 'wow_quest', { id: 222 }).found, false);
  assert.deepEqual(call(store, 'wow_quest', { name: 'errand' }).results.map(r => r.id), [111]);
  const quest = call(store, 'wow_quest', { id: 111 });
  assert.equal(quest.results[0].community.trust, 'community-db-unchecked-for-this-game');
  assert.equal(quest.results[0].inClientData, true);
  assert.equal(call(store, 'wow_npc', { name: 'fixture', uiMapID: 9101 }).found, false, 'a map filter on a map Forever draws differently finds nothing');
  const era = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  assert.deepEqual([era.community.crossGame, era.community.trust], [false, 'community-db'], 'Classic Era is unchanged');  assert.equal(npc.results[0].spawnTotal, null, 'no Classic total on Forever');
  assert.match(npc.results[0].spawnsShown, /^1 of a 2-spawn sample; dungeon spawns .* left out/);
  assert.equal(call(store, 'wow_npc', { id: 7004 }).found, false, 'an NPC with no shared map and no Forever quest is not shown');
  assert.equal(call(store, 'wow_npc', { name: "O'Brien" }).found, false);
  assert.equal(C.openCommunity({ dataDir, flavor: 'tbc' }), null);
});

test('on Forever, missing or other Classic Era data hides every community position and says which sync fixes it', async () => {
  const dataDir = await eraData('forevermissing');
  const r = await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  assert.equal(GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT }).community, null, 'no Forever client data, no community data on Forever');
  foreverFromEra(dataDir);
  const manifestFile = path.join(r.dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, client: { ...manifest.client, tableHash: 'older' } }));
  const stale = GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT });
  assert.deepEqual([...stale.community.sameMaps()], []);
  const staleNpc = call(stale, 'wow_npc', { id: 7001 });
  assert.deepEqual(staleNpc.results[0].onMaps, [], 'no map membership from rectangles that no longer match');
  assert.match(staleNpc.notes.join(' '), /built with Classic Era client data 1\.15\.9\.300, not the Classic Era data synced now \(1\.15\.9\.300\)/);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  fs.renameSync(path.join(dataDir, 'classic_era', 'current'), path.join(dataDir, 'classic_era', 'current.off'));
  const noEra = GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT });
  assert.match(call(noEra, 'wow_npc', { id: 7001 }).notes.join(' '), /Classic Era client tables are not synced, .*"claude-wow data sync --flavor classic_era"/);
  fs.renameSync(path.join(dataDir, 'classic_era', 'current.off'), path.join(dataDir, 'classic_era', 'current'));
  const era = D.readCurrent(path.join(dataDir, 'classic_era'));
  const eraManifest = path.join(era.dir, 'manifest.json');
  const em = JSON.parse(fs.readFileSync(eraManifest, 'utf8'));
  fs.writeFileSync(eraManifest, JSON.stringify({ ...em, entities: { ...em.entities, uimapassignments: { ...em.entities.uimapassignments, rows: 99 } } }));
  const broken = GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT });
  for (let k = 0; k < 2; k++) {
    const answer = call(broken, 'wow_npc', { id: 7001 });
    assert.ok(answer.unavailable.includes('uimapassignments (Classic Era client data)'), `a broken Era table is named in every answer (${k})`);
  }
});

test('sharedMaps needs every rectangle of a map to be identical, counted pairwise', () => {
  const rect = (id, uiMapID, n) => ({ id, uiMapID, mapID: 1, region: [0, 0, 0, n, n, 0], uiMin: [0, 0], uiMax: [1, 1] });
  const fake = rows => ({ rows: () => rows });
  assert.deepEqual([...C.sharedMaps(fake([rect(1, 5, 10)]), fake([rect(9, 5, 10)]))], [5], 'the assignment ID does not matter');
  assert.deepEqual([...C.sharedMaps(fake([rect(1, 5, 10)]), fake([{ ...rect(1, 5, 10), uiMin: [0.009, 0] }]))], [], 'a small change is a change');
  assert.deepEqual([...C.sharedMaps(fake([rect(1, 5, 10), rect(2, 5, 10)]), fake([rect(1, 5, 10), rect(2, 5, 20)]))], [], 'two rectangles are not matched by one');
});

test('a store written by another converter shape is not read, and the next sync converts again', async () => {
  const dataDir = await eraData('shape');
  const r = await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  const manifestFile = path.join(r.dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')), shape: C.SHAPE - 1 }));
  assert.equal(GD.openStore({ dataDir, clientBuild: ERA_CLIENT }).community, null);
  assert.equal((await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl })).status, 'synced');
});

test('a dump whose NPC or quest table converts to nothing never replaces the current data', async () => {
  const dataDir = await eraData('empty');
  const r = await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  const empty = SQL.replace(/INSERT INTO `quest_template` VALUES [^\n]*\n/, '');
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ gz: zlib.gzipSync(Buffer.from(empty)) }).fetchImpl, force: true }), /no questinfo row survived conversion/);
  assert.equal(C.readCommunity(C.communityRoot(dataDir)).version, r.version);
});
