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
const L = require('../bridge/communityloot');

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
  const broken = SQL.replace("(7001,'Fixture Giver','Quest Clerk',5,7001,0,0)", "(7001,'Fixture Giver','Quest Clerk',5,7001,0)");
  assert.notEqual(broken, SQL);
  assert.throws(() => [...S.rows(broken, 'creature_template', ['Entry'])], /a row has 6 values for 7 columns/);
  assert.throws(() => [...S.rows(SQL.replace("'Fixture Rock',0)", "'Fixture Rock,0)"), 'gameobject_template', ['entry'])], S.DumpError);
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
  assert.deepEqual(r.manifest.droppedBy, { junk: 5, relationWithoutQuest: 1, lootItemNotInClient: 2, lootItemNotIn112: 1, lootRowInvalid: 2, lootConditionMissing: 1, referenceNeverRolled: 2, lootGroupNeverReached: 3 });
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
  assert.match(out.join(''), /27 rows kept, 17 dropped; current community data z2815-[0-9a-f]{7}/);
  const changed = async url => (url.includes('/QuestV2/') ? new Response('ID,UniqueBitFlag\n111,1\n112,2\n', { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="QuestV2.${new URL(url).searchParams.get('build')}.csv"` } }) : fakeWago(url));
  const again = [];
  assert.equal(await D.main(['sync', '--flavor', 'classic_era', '--force'], { env: { CLAUDE_WOW_HOME: home }, fetch: changed, out: s => again.push(s), err: s => again.push(s) }), 0, again.join(''));
  assert.match(again.join(''), /community data z2815-[0-9a-f]{7} was built with other client data, so its positions are hidden until you run "claude-wow data sync --flavor classic_era --source community"/);
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
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, client: { ...manifest.client, placementHash: 'other' } }));
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
  assert.equal(call(store, 'wow_instance', { id: 33 }).results[0].bossSets[0].bosses[0].community.trust, 'community-db-unchecked-for-this-game', 'on Forever the boss flags carry the other-game trust');
});

test('on Forever, missing or other Classic Era data hides every community position and says which sync fixes it', async () => {
  const dataDir = await eraData('forevermissing');
  const r = await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  assert.equal(GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT }).community, null, 'no Forever client data, no community data on Forever');
  foreverFromEra(dataDir);
  const manifestFile = path.join(r.dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, client: { ...manifest.client, placementHash: 'older' } }));
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

test('on Classic Era wow_instance adds client level ranges and community flags: instance in 1.12, boss named like a 1.12 NPC, boss outdoors', async () => {
  const dataDir = await eraData('instances');
  await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  const keep = call(store, 'wow_instance', { id: 33 }).results[0];
  assert.deepEqual(keep.levels, { min: 18, max: 25 });
  assert.deepEqual([keep.community.inClassic112, keep.community.trust, keep.community.source], [true, 'community-db', 'cmangos'], 'a community spawn stands in it');
  assert.equal(keep.trust, 'client-data');
  assert.deepEqual([keep.bossSets[0].bosses[0].community.npcIn112, keep.bossSets[0].bosses[0].community.outdoorSpawnIn112, keep.bossSets[0].bosses[0].community.trust], [false, false, 'community-db'], 'Fixture Gatekeeper is no 1.12 NPC');
  assert.deepEqual(D.readCurrent(path.join(dataDir, 'classic_era')).manifest.tables.LFGDungeons.droppedBy, { ambiguousInstanceName: 1, badLevelRange: 1, noInstanceWithThatName: 1 });
  const canyon = call(store, 'wow_instance', { name: 'fixture giver' }).results[0];
  assert.deepEqual([canyon.id, canyon.maxPlayers, canyon.levels, canyon.community.inClassic112], [2784, null, null, false], 'two maps share the name, so neither gets a level range');
  assert.deepEqual([canyon.bossSets[0].bosses[0].community.npcIn112, canyon.bossSets[0].bosses[0].community.outdoorSpawnIn112], [true, true]);
  assert.equal(canyon.matchedBoss.community, undefined, 'the boss flags live on the boss rows, the same on every lookup');
  assert.deepEqual(call(store, 'wow_instance', { id: 2784 }).results[0].bossSets[0].bosses[0].community.outdoorSpawnIn112, true, 'a lookup by ID says the same');
  const cs = store.community;
  const manifestFile = path.join(cs.dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, entities: { ...manifest.entities, npcs: { ...manifest.entities.npcs, rows: 99 } } }));
  const broken = call(GD.openStore({ dataDir, clientBuild: ERA_CLIENT }), 'wow_instance', { id: 33 });
  assert.equal(broken.results[0].bossSets[0].bosses[0].community, undefined, 'an unreadable NPC table says nothing about the bosses');
  assert.ok(broken.unavailable.includes('npcs'));
});

test('community data goes stale only when the client tables it was built from change', async () => {
  const dataDir = await eraData('placement');
  await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  const csv = (table, body) => async url => (url.includes(`/${table}/`) ? new Response(body, { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${new URL(url).searchParams.get('build')}.csv"` } }) : fakeWago(url));
  await D.sync({ dataDir, flavor: 'classic_era', force: true, fetch: csv('SkillLine', 'ID,DisplayName_lang,CategoryID,ParentSkillLineID\n9,Other Fixture Line,11,0\n') });
  assert.equal(GD.openStore({ dataDir, clientBuild: ERA_CLIENT }).community.stale, false, 'a change to a table the community data does not read keeps it current');
  await D.sync({ dataDir, flavor: 'classic_era', force: true, fetch: csv('QuestV2', 'ID,UniqueBitFlag\n111,1\n112,2\n') });
  assert.equal(GD.openStore({ dataDir, clientBuild: ERA_CLIENT }).community.stale, true, 'a change to the quest table does not');
});

test('a community sync converts again when the client item, zone or encounter table changes, and only then', async () => {
  const dataDir = await eraData('lootHash');
  await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  const csv = (table, body) => async url => (url.includes(`/${table}/`) ? new Response(body, { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${new URL(url).searchParams.get('build')}.csv"` } }) : fakeWago(url));
  await D.sync({ dataDir, flavor: 'classic_era', force: true, fetch: csv('SkillLine', 'ID,DisplayName_lang,CategoryID,ParentSkillLineID\n9,Other Fixture Line,11,0\n') });
  assert.equal((await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl })).status, 'current', 'a table the conversion does not read changes nothing');
  const areas = fs.readFileSync(path.join(ERA_FIXTURES, 'AreaTable.csv'), 'utf8').replace('"Era Fixture Vale"', '"Era Fixture Valley"');
  await D.sync({ dataDir, flavor: 'classic_era', force: true, fetch: csv('AreaTable', areas) });
  assert.equal(GD.openStore({ dataDir, clientBuild: ERA_CLIENT }).community.stale, false, 'positions stay current');
  assert.equal((await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl })).status, 'synced', 'but the loot joins are redone');
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

function addEraEncounter(dataDir, row) {
  const era = D.readCurrent(path.join(dataDir, 'classic_era'));
  fs.appendFileSync(path.join(era.dir, 'encounters.jsonl'), JSON.stringify(row) + '\n');
  const manifestFile = path.join(era.dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.entities.encounters.rows++;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}

const MAJORDOMO = { id: 230, name: 'Majordomo Executus', mapID: 409, difficultyID: 0, orderIndex: 0 };
const ids = list => list.map(r => r.id);

test('community loot keeps the rows the server keeps, groups them by template and records unreferenced and unresolved rows', async () => {
  const dataDir = await eraData('loot');
  addEraEncounter(dataDir, MAJORDOMO);
  const r = await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  assert.deepEqual(r.manifest.loot, {
    unreferenced: { creatureloot: 2, fishingloot: 1, containerloot: 2, disenchantloot: 1, referenceloot: 2 },
    unresolved: { referenceloot: 1, creatureloot: 1, objectloot: 1, containerloot: 1, encounterChest: 4 },
    referenceDepth: 2,
  });
  const cs = GD.openStore({ dataDir, clientBuild: ERA_CLIENT }).community;
  assert.deepEqual(cs.byId('creatureloot', 7001), { id: 7001, items: [{ id: 512 }, { id: 513, questOnly: true, conditional: true }], refs: [{ id: 700 }, { id: 702 }] });
  assert.deepEqual(cs.byId('creatureloot', 7002), { id: 7002, items: [{ id: 512 }], refs: [{ id: 701, conditional: true }] }, 'a row with a missing condition, a zero chance outside a group, an item the client lacks, a reference that never rolls and a missing reference are all gone');
  assert.equal(cs.byId('creatureloot', 7003), null, 'the loot of a dropped NPC is not kept');
  assert.deepEqual(cs.byId('referenceloot', 701), { id: 701, items: [], refs: [{ id: 702 }] });
  assert.equal(cs.byId('referenceloot', 703), null, 'a reference reached only through a row that never rolls is unreferenced');
  const giver = cs.byId('npcs', 7001);
  const wanderer = cs.byId('npcs', 7002);
  assert.deepEqual([giver.lootId, giver.skinningId, giver.pickpocketId], [7001, undefined, undefined]);
  assert.deepEqual([wanderer.lootId, wanderer.skinningId, wanderer.pickpocketId], [7002, 7002, 7002]);
  assert.equal(cs.byId('npcs', 7004).lootId, undefined, 'a LootId with no template is unresolved, not kept');
  assert.deepEqual(cs.rows('lootobjects'), [
    { id: 8003, name: 'Cache of the Firelord', kind: 'chest', lootId: 8100, encounter: { mapID: 409, name: 'Majordomo Executus' } },
    { id: 8004, name: 'Fixture School', kind: 'fishinghole', lootId: 8101 },
    { id: 8006, name: 'Cache of the Firelord', kind: 'chest', lootId: 8100 },
  ], 'only chests and fishing holes carry loot in data1, and only the chest spawned on the encounter map belongs to it');
  assert.deepEqual(ids(cs.rows('fishingloot')), [7101], 'fishing loot is kept only for a zone the client has');
  assert.deepEqual(ids(cs.rows('containerloot')), [514], 'item loot is kept only for an item with the has-loot flag the client has');
  assert.deepEqual(cs.byId('disenchantloot', 61).fromItems, [512]);
  assert.equal(cs.byId('lootitems', 511).name, 'Era Fixture Hide (1.12)', 'the 1.12 name is kept to compare on Forever');
  const raw = fs.readFileSync(path.join(cs.dir, 'creatureloot.jsonl'), 'utf8') + fs.readFileSync(path.join(cs.dir, 'referenceloot.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /chance|count|group|condition_id/i, 'no community number is stored');
});

test('wow_npc, wow_item and wow_instance answer who drops what with flags, unconditioned first, and never a number', async () => {
  const dataDir = await eraData('lootTools');
  addEraEncounter(dataDir, MAJORDOMO);
  await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  const giver = call(store, 'wow_npc', { id: 7001 });
  assert.deepEqual(giver.results[0].drops, { total: 4, items: [
    { id: 512, name: 'Era Fixture Cap', quality: 2 },
    { id: 511, name: 'Era Fixture Hide', quality: 1, viaReference: true },
    { id: 514, name: 'Recipe: Era Blast', quality: 1, viaReference: true },
    { id: 513, name: 'Schematic: The Era Fixture', quality: 1, questOnly: true, conditional: true },
  ] }, 'a direct drop that a shared table also holds is direct; an item one path gives without a condition is unconditioned; client names; conditional rows after every unconditioned one');
  assert.deepEqual([giver.results[0].skinning, giver.results[0].pickpocket], [null, null]);
  assert.match(giver.notes.join(' '), /Drop sources come from community loot tables .* No chance, count or rate/);
  const wanderer = call(store, 'wow_npc', { id: 7002 }).results[0];
  assert.deepEqual(wanderer.drops.items.map(i => [i.id, !!i.conditional, !!i.viaReference]), [[512, false, false], [514, true, true]], 'a nested reference behind a conditional row is conditional');
  assert.deepEqual(ids(wanderer.skinning.items), [511, 513, 512], 'a conditional 100% row does not always fill its group');
  assert.deepEqual(ids(wanderer.pickpocket.items), [512, 513], 'an equal-chance row in a group a 100% row always fills never drops');
  const item = id => call(store, 'wow_item', { id }).results[0].community;
  const cap = item(512);
  assert.deepEqual(cap.droppedBy, { total: 2, npcs: [{ kind: 'npc', id: 7001, name: 'Fixture Giver' }, { kind: 'npc', id: 7002, name: 'Fixture Wanderer' }] });
  assert.deepEqual(ids(cap.pickpocketedFrom.npcs), [7002]);
  assert.deepEqual(cap.objects.objects, [{ kind: 'object', id: 8003, name: 'Cache of the Firelord', objectKind: 'chest', encounter: { mapID: 409, name: 'Majordomo Executus' } }, { kind: 'object', id: 8006, name: 'Cache of the Firelord', objectKind: 'chest' }]);
  assert.deepEqual(ids(cap.inContainers.items), [514]);
  assert.deepEqual(ids(cap.disenchantsInto.items), [511]);
  assert.equal(cap.trust, 'community-db');
  const hide = item(511);
  assert.deepEqual(hide.droppedBy.npcs, [{ kind: 'npc', id: 7001, name: 'Fixture Giver', viaReference: true }]);
  assert.deepEqual(ids(hide.skinnedFrom.npcs), [7002]);
  assert.deepEqual(hide.fishedIn.zones, [{ id: 7101, name: 'Era Fixture Vale' }]);
  assert.deepEqual(ids(hide.disenchantedFrom.items), [512]);
  assert.deepEqual(item(513).droppedBy.npcs, [{ kind: 'npc', id: 7001, name: 'Fixture Giver', questOnly: true, conditional: true }]);
  const recipe = item(514);
  assert.deepEqual(recipe.droppedBy.npcs.map(n => [n.id, n.conditional, n.viaReference]), [[7001, undefined, true], [7002, true, true]]);
  assert.deepEqual(recipe.objects.objects.map(o => [o.id, o.objectKind]), [[8004, 'fishinghole']]);
  assert.deepEqual(ids(recipe.contains.items), [512]);
  const LOOT_KEYS = new Set(['total', 'items', 'npcs', 'objects', 'zones', 'id', 'name', 'quality', 'kind', 'objectKind', 'encounter', 'mapID', 'questOnly', 'conditional', 'viaReference', 'droppedBy', 'skinnedFrom', 'pickpocketedFrom', 'fishedIn', 'inContainers', 'disenchantedFrom', 'contains', 'disenchantsInto', 'source', 'version', 'trust']);
  const keys = (v, out = new Set()) => {
    if (Array.isArray(v)) v.forEach(x => keys(x, out));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); }
    return out;
  };
  const lootParts = [giver.results[0].drops, wanderer.drops, wanderer.skinning, wanderer.pickpocket, cap, hide, recipe];
  assert.deepEqual([...keys(lootParts)].filter(k => !LOOT_KEYS.has(k)), [], 'no community number reaches an answer');
  const core = call(store, 'wow_instance', { id: 409 }).results[0].bossSets[0].bosses[0].community;
  assert.deepEqual([core.drops, core.chest.name, ids(core.chest.items)], [[], 'Cache of the Firelord', [512]], 'an encounter whose loot is in a chest names the chest');
  const canyon = call(store, 'wow_instance', { name: 'fixture giver' });
  assert.deepEqual(canyon.results[0].bossSets[0].bosses[0].community.drops.map(d => [d.npc.id, d.total]), [[7001, 4]], 'one match is detailed');
  assert.equal(canyon.results[0].bossSets[0].bosses[0].community.chest, undefined, 'another encounter\'s chest is not this boss\'s');
  const both = call(store, 'wow_instance', { name: 'fixture' });
  assert.ok(both.results.length > 1);
  assert.ok(both.results.every(r => r.bossSets.every(s => s.bosses.every(b => !b.community || b.community.drops === undefined))), 'several matches list no drops');
  assert.match(both.notes.join(' '), /look one up by its ID/);
  const paged = call(store, 'wow_npc', { id: 7001, offset: 2 }).results[0].drops;
  assert.deepEqual([paged.total, paged.offset, ids(paged.items)], [4, 2, [514, 513]], 'offset pages through a loot list');
  assert.equal(DM.callTool(store, 'wow_npc', { id: 7001, offset: -1 }).isError, true);
  assert.match(DM.callTool(store, 'wow_npc', { name: 'fixture', offset: 2 }).content[0].text, /offset needs id/, 'a search never pretends to page');
  const search = call(store, 'wow_npc', { name: 'fixture' });
  assert.match(search.notes.join(' '), /at most 10 items per loot list/);
  assert.equal(call(store, 'wow_sources', {}).results.find(r => r.source === 'cmangos').loot.referenceDepth, 2, 'wow_sources carries the loot counts');
});

test('loot answers leave out an item the client tables no longer have', async () => {
  const dataDir = await eraData('lootClient');
  await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  const era = D.readCurrent(path.join(dataDir, 'classic_era'));
  const itemsFile = path.join(era.dir, 'items.jsonl');
  const kept = fs.readFileSync(itemsFile, 'utf8').trim().split('\n').filter(l => !l.startsWith('{"id":513,'));
  fs.writeFileSync(itemsFile, kept.join('\n') + '\n');
  const manifestFile = path.join(era.dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.entities.items.rows = kept.length;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  assert.ok(store.community.byId('lootitems', 513), 'precondition: the community data has it');
  assert.deepEqual(ids(call(store, 'wow_npc', { id: 7001 }).results[0].drops.items), [512, 511, 514]);
  assert.equal(store.community.byId('lootobjects', 8003).encounter, undefined, 'a chest is tied to no encounter the client does not have');
});

test('the reverse loot index is built once per store and only on first use', async () => {
  const dataDir = await eraData('lootIndex');
  await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  const store = GD.openStore({ dataDir, clientBuild: ERA_CLIENT });
  call(store, 'wow_npc', { id: 7001 });
  assert.equal(store.community.loaded().includes('lootitems'), true);
  assert.equal(L.hasIndex(store.community), false, 'an NPC lookup does not build the reverse index');
  call(store, 'wow_item', { id: 512 });
  assert.equal(L.hasIndex(store.community), true, 'the first item lookup builds it');
  const first = L.lootIndex(store.community);
  call(store, 'wow_item', { id: 514 });
  assert.equal(L.lootIndex(store.community), first);
  assert.notEqual(L.lootIndex(GD.openStore({ dataDir, clientBuild: ERA_CLIENT }).community), first, 'a new store builds its own');
});

test('a dump whose references nest deeper than two levels or loop, or whose creature loot converts to nothing, is refused', async () => {
  const dataDir = await eraData('lootRefuse');
  const deeper = SQL.replace("(702,514,1,0,1,1,0,'item')", "(702,514,1,0,1,1,0,'item'),(702,705,100,0,-705,1,0,'too deep')");
  assert.notEqual(deeper, SQL);
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ gz: zlib.gzipSync(Buffer.from(deeper)) }).fetchImpl }), /reference loot 701 reaches reference 702, which references further/);
  const loop = SQL.replace("(705,512,1,0,1,1,0,'unreferenced')", "(705,512,1,0,1,1,0,'unreferenced'),(705,705,100,0,-705,1,0,'loop')");
  assert.notEqual(loop, SQL);
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ gz: zlib.gzipSync(Buffer.from(loop)) }).fetchImpl }), /references nest deeper than 2 levels or loop/);
  const noLoot = SQL.replace(/INSERT INTO `creature_loot_template` VALUES [^\n]*\n/, '');
  assert.notEqual(noLoot, SQL);
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ gz: zlib.gzipSync(Buffer.from(noLoot)) }).fetchImpl }), /no creature loot row survived conversion/);
  const noTable = SQL.replace('CREATE TABLE `skinning_loot_template`', 'CREATE TABLE `skinning_other`');
  await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub({ gz: zlib.gzipSync(Buffer.from(noTable)) }).fetchImpl }), /table skinning_loot_template is missing/);
  assert.equal(C.readCommunity(C.communityRoot(dataDir)), null);
  for (const entity of ['items', 'zones', 'encounters']) {
    const era = D.readCurrent(path.join(dataDir, 'classic_era'));
    const manifestFile = path.join(era.dir, 'manifest.json');
    const good = fs.readFileSync(manifestFile, 'utf8');
    const m = JSON.parse(good);
    m.entities[entity].rows += 1;
    fs.writeFileSync(manifestFile, JSON.stringify(m));
    await assert.rejects(C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl }), /client tables are needed first/, `an unreadable ${entity} table refuses the sync`);
    fs.writeFileSync(manifestFile, good);
  }
});

test('on Forever loot answers drop items Forever lacks or names differently, NPCs it cannot back, and chests of encounters it does not have', async () => {
  const dataDir = await eraData('lootForever');
  addEraEncounter(dataDir, MAJORDOMO);
  await C.syncCommunity({ dataDir, fetch: fakeGitHub().fetchImpl });
  foreverFromEra(dataDir);
  const store = GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT });
  const giver = call(store, 'wow_npc', { id: 7001 });
  assert.equal(giver.results[0].trust, 'community-db-unchecked-for-this-game');
  assert.deepEqual(ids(giver.results[0].drops.items), [512, 514, 513], 'the hide has another name in 1.12, so it is left out');
  assert.match(giver.notes.join(' '), /Classic community loot tables .* not checked for this game/);
  const hide = call(store, 'wow_item', { id: 511 });
  assert.equal(hide.results[0].community, undefined);
  assert.match(hide.notes.join(' '), /Item 511 has another name in the 1.12 community data/);
  const cap = call(store, 'wow_item', { id: 512 }).results[0].community;
  assert.equal(cap.trust, 'community-db-unchecked-for-this-game');
  assert.deepEqual(ids(cap.droppedBy.npcs), [7001, 7002]);
  assert.deepEqual(ids(cap.objects.objects), [8003], 'the chest of an encounter Forever has');
  assert.deepEqual(call(store, 'wow_item', { id: 514 }).results[0].community.objects.objects, [], 'a fishing hole has no Forever data behind it');
  const forever = D.readCurrent(path.join(dataDir, 'forever'));
  const encFile = path.join(forever.dir, 'encounters.jsonl');
  const encounters = fs.readFileSync(encFile, 'utf8').trim().split('\n').filter(l => !l.includes('Majordomo'));
  fs.writeFileSync(encFile, encounters.join('\n') + '\n');
  const manifestFile = path.join(forever.dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.entities.encounters.rows = encounters.length;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const without = GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT });
  assert.deepEqual(call(without, 'wow_item', { id: 512 }).results[0].community.objects.objects, [], 'no chest when Forever lacks the encounter');
  assert.deepEqual(ids(call(without, 'wow_item', { id: 513 }).results[0].community.droppedBy.npcs), [7001]);
  const npcsFile = path.join(store.community.dir, 'npcs.jsonl');
  const original = fs.readFileSync(npcsFile, 'utf8');
  const giverAs = extra => original.split('\n').map(l => (l.startsWith('{"id":7001,') ? JSON.stringify({ ...JSON.parse(l), onMaps: [], spawns: [], gives: [], ends: [], ...extra }) : l)).join('\n');
  fs.writeFileSync(npcsFile, giverAs({}));
  const named = GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT });
  assert.deepEqual(ids(call(named, 'wow_item', { id: 513 }).results[0].community.droppedBy.npcs), [7001], 'an NPC named exactly like a Forever encounter is kept');
  assert.deepEqual(ids(call(named, 'wow_npc', { id: 7001 }).results), [7001], 'and wow_npc finds it, so the full loot list is reachable');
  assert.deepEqual(ids(call(named, 'wow_npc', { name: 'Fixture Giver' }).results), [7001]);
  fs.writeFileSync(npcsFile, giverAs({ name: 'Fixture Muted' }));
  const muted = GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT });
  assert.deepEqual(ids(call(muted, 'wow_item', { id: 513 }).results[0].community.droppedBy.npcs), [], 'an NPC with no shared map, no Forever quest and no Forever encounter is left out');
  assert.equal(call(muted, 'wow_npc', { id: 7001 }).found, false);
  const lootItemsFile = path.join(store.community.dir, 'lootitems.jsonl');
  const lootItems = fs.readFileSync(lootItemsFile, 'utf8').trim().split('\n').filter(l => !l.startsWith('{"id":513,'));
  fs.writeFileSync(lootItemsFile, lootItems.join('\n') + '\n');
  const cmf = path.join(store.community.dir, 'manifest.json');
  const cm = JSON.parse(fs.readFileSync(cmf, 'utf8'));
  cm.entities.lootitems.rows = lootItems.length;
  fs.writeFileSync(cmf, JSON.stringify(cm));
  const unlisted = call(GD.openStore({ dataDir, clientBuild: FOREVER_CLIENT }), 'wow_item', { id: 513 });
  assert.ok(unlisted.results[0].community, 'an item no loot list names is answered, not called renamed');
  assert.doesNotMatch(unlisted.notes.join(' '), /another name/);
});
