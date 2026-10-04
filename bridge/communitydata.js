'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const D = require('./datasync');
const GD = require('./gamedata');
const S = require('./sqldump');

const FLAVOR = 'classic_era';
const SOURCE = 'cmangos';
const REPO_URL = 'https://github.com/cmangos/classic-db';
const LISTING_URL = 'https://api.github.com/repos/cmangos/classic-db/contents/Full_DB';
const API_ORIGIN = 'https://api.github.com';
const RAW_ORIGIN = 'https://raw.githubusercontent.com';
const RAW_PATH_PREFIX = '/cmangos/classic-db/';
const DUMP_NAME = /^ClassicDB_1_12_1_(z\d{1,6})\.sql\.gz$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const POINTER = /^(z\d{1,6}-[0-9a-f]{7})(?:-\d+)?$/;
const LICENSE_NOTE = 'cMaNGOS classic-db (GPL-3.0), a community rebuild of the 1.12 world. Names and quest text are Blizzard\'s. Cached on this machine only; never committed or redistributed.';
const MAX_LISTING_BYTES = 256 * 1024;
const MAX_DUMP_BYTES = 64 * 1024 * 1024;
const MAX_SQL_BYTES = 256 * 1024 * 1024;
const MAX_SPAWNS = 25;
const ENTITIES = Object.freeze(['npcs', 'questinfo', 'objects']);
const JUNK = /^\[|<(?:NYI|UNUSED|TXT|TEST)>|\b(?:UNUSED|DEPRECATED|Trigger|Credit Marker|Only GM|zzOLD)\b|\(OLD\)/i;
const NPC_JUNK = /\bDND\b|\((?:TEST|PH)\)|<PH>|\b[Pp]laceholder\b|\bTest Dummy\b|\bTEST\b/;
const SHAPE = 2;

function communityRoot(dataDir) {
  return path.join(D.flavorDir(dataDir, FLAVOR), 'community');
}

function readCommunity(root) {
  let pointer;
  try { pointer = fs.readFileSync(path.join(root, D.CURRENT_FILE), 'utf8').trim(); } catch { return null; }
  const match = POINTER.exec(pointer);
  if (!match) return null;
  const dir = path.join(root, pointer);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, D.MANIFEST_FILE), 'utf8'));
    if (!manifest || manifest.kind !== 'community' || manifest.shape !== SHAPE || manifest.flavor !== FLAVOR || manifest.version !== match[1]) return null;
    return { version: match[1], dir, manifest };
  } catch {
    return null;
  }
}

const CROSS_GAME = Object.freeze(['forever']);

function rectangleKey(a) {
  return JSON.stringify([a.mapID, a.region, a.uiMin, a.uiMax]);
}

function sharedMaps(era, game) {
  const byMap = rows => {
    const m = new Map();
    for (const a of rows) m.set(a.uiMapID, [...(m.get(a.uiMapID) || []), rectangleKey(a)]);
    for (const keys of m.values()) keys.sort();
    return m;
  };
  const eraMaps = byMap(era.rows('uimapassignments'));
  const gameMaps = byMap(game.rows('uimapassignments'));
  const same = new Set();
  for (const [uiMapID, ours] of eraMaps) {
    const theirs = gameMaps.get(uiMapID);
    if (theirs && theirs.length === ours.length && ours.every((key, k) => key === theirs[k])) same.add(uiMapID);
  }
  return same;
}

const PLACEMENT_TABLES = Object.freeze(['UiMap', 'UiMapAssignment', 'QuestV2']);

function placementHash(manifest) {
  const tables = (manifest && manifest.tables) || {};
  if (!PLACEMENT_TABLES.every(t => tables[t] && tables[t].sha256)) return null;
  return crypto.createHash('sha256').update(PLACEMENT_TABLES.map(t => `${t}:${tables[t].sha256}`).join('\n')).digest('hex');
}

function clientIdentity(store) {
  return store && store.build ? { build: store.build, placementHash: placementHash(store.manifest) } : null;
}

function openCommunity({ dataDir, flavor, client = null, gameStore = null }) {
  if (!dataDir || (flavor !== FLAVOR && !CROSS_GAME.includes(flavor))) return null;
  const crossGame = flavor !== FLAVOR;
  if (crossGame && !(gameStore && gameStore.build)) return null;
  const current = readCommunity(communityRoot(dataDir));
  if (!current) return null;
  const made = current.manifest.client || {};
  const era = crossGame ? GD.openStore({ dataDir, flavor: FLAVOR }) : null;
  const madeWith = crossGame ? clientIdentity(era) : client;
  const stale = !madeWith || !made.placementHash || made.placementHash !== madeWith.placementHash;
  const reader = GD.tableReader(current.dir, current.manifest, ENTITIES);
  const mapProblems = [];
  let shared;
  return {
    source: SOURCE,
    version: current.version,
    trust: crossGame ? GD.TRUST.communityOtherGame : GD.TRUST.communityDb,
    crossGame,
    stale,
    madeWith: madeWith ? madeWith.build : null,
    sameMaps() {
      if (!crossGame) return null;
      gameStore.has('uimapassignments');
      if (shared === undefined) {
        shared = new Set();
        if (!stale && era.has('uimapassignments') && gameStore.has('uimapassignments')) shared = sharedMaps(era, gameStore);
        for (const m of era.takeMissed()) mapProblems.push({ entity: `${m.entity} (Classic Era client data)`, problem: m.problem });
      }
      return shared;
    },
    manifest: current.manifest,
    dir: current.dir,
    ...reader,
    takeMissed() {
      return [...reader.takeMissed(), ...mapProblems];
    },
  };
}

function gitBlobSha(bytes) {
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function fetchFrom(fetchImpl, url, origin, maxBytes) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'user-agent': `claude-wow/${require('../package.json').version} (data sync)` }, redirect: 'error', signal: AbortSignal.timeout(D.FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new D.SyncError(`${url}: ${e && e.message ? e.message : String(e)}`);
  }
  if (!res) throw new D.SyncError(`${url}: no response`);
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    throw new D.SyncError(`GitHub's rate limit for unauthenticated requests is used up; try again after ${Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : 'an hour'}`);
  }
  if (res.status !== 200) throw new D.SyncError(`${url}: HTTP ${res.status}`);
  if (res.url && new URL(res.url).origin !== origin) throw new D.SyncError(`${url}: the answer came from ${new URL(res.url).origin}, not ${origin}`);
  return D.readCappedBytes(res, url, maxBytes);
}

function pickDump(listing) {
  if (!Array.isArray(listing)) throw new D.SyncError(`${LISTING_URL}: not a folder listing`);
  const dumps = listing.filter(e => e && e.type === 'file' && DUMP_NAME.test(e.name));
  if (dumps.length !== 1) throw new D.SyncError(`${LISTING_URL}: expected one ClassicDB_1_12_1_z<rev>.sql.gz, found ${dumps.length}`);
  const dump = dumps[0];
  if (typeof dump.sha !== 'string' || !GIT_SHA.test(dump.sha)) throw new D.SyncError(`${dump.name}: the listing has no valid git sha`);
  if (!Number.isSafeInteger(dump.size) || dump.size <= 0 || dump.size > MAX_DUMP_BYTES) throw new D.SyncError(`${dump.name}: size ${dump.size} is outside 1..${MAX_DUMP_BYTES} bytes`);
  let url;
  try { url = new URL(dump.download_url); } catch { throw new D.SyncError(`${dump.name}: no valid download URL`); }
  if (url.origin !== RAW_ORIGIN || !url.pathname.startsWith(RAW_PATH_PREFIX) || !url.pathname.endsWith(`/Full_DB/${dump.name}`)) throw new D.SyncError(`${dump.name}: unexpected download URL ${url.href}`);
  return { name: dump.name, sha: dump.sha, size: dump.size, url: url.href, revision: DUMP_NAME.exec(dump.name)[1] };
}

function nameOrDrop(value, drop, extraJunk = null) {
  const name = D.toName(typeof value === 'string' ? value : '');
  if (!name) { drop('badName'); return null; }
  if (JUNK.test(name) || (extraJunk && extraJunk.test(name))) { drop('junk'); return null; }
  return name;
}

function spawnKey(spot) {
  return spot.maps.length ? `m${spot.maps[0].uiMapID}` : `i${spot.mapID}`;
}

function finishSpawns(owner) {
  const { all, ...rest } = owner;
  const onMaps = new Map();
  const pick = (m, spot) => ({ x: m.x, y: m.y, ...(spot.zoneAmbiguous ? { zoneAmbiguous: true } : {}), ...(spot.event ? { event: true } : {}) });
  for (const spot of all) {
    for (const m of spot.maps) {
      const seen = onMaps.get(m.uiMapID);
      if (!seen) onMaps.set(m.uiMapID, { uiMapID: m.uiMapID, count: 1, ...pick(m, spot) });
      else {
        seen.count++;
        if (seen.event && !spot.event) {
          delete seen.zoneAmbiguous;
          delete seen.event;
          Object.assign(seen, pick(m, spot));
        }
      }
    }
  }
  const queues = new Map();
  for (const spot of all) {
    const key = spawnKey(spot);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(spot);
  }
  const spawns = [];
  while (spawns.length < MAX_SPAWNS && queues.size) {
    for (const [key, queue] of queues) {
      if (spawns.length >= MAX_SPAWNS) break;
      spawns.push(queue.shift());
      if (!queue.length) queues.delete(key);
    }
  }
  return { ...rest, spawnTotal: all.length, onMaps: [...onMaps.values()].sort((a, b) => a.uiMapID - b.uiMapID), spawns };
}

function convert(sql, client) {
  const droppedBy = {};
  const drop = reason => { droppedBy[reason] = (droppedBy[reason] || 0) + 1; };
  const ctx = {
    uiMaps: new Map(client.rows('uimaps').map(m => [m.id, { type: m.type, system: m.system }])),
    assignments: client.rows('uimapassignments'),
  };
  const place = (map, x, y) => {
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isSafeInteger(map)) return null;
    const p = D.placeOnMap({ x, y, z: 0 }, map, ctx);
    return p.map ? { maps: p.maps, ...(p.zoneAmbiguous ? { zoneAmbiguous: true } : {}) } : { mapID: map, maps: [] };
  };
  const eventGuids = table => new Set([...S.rows(sql, table, ['guid', 'event'])].filter(r => r.event > 0).map(r => r.guid));
  const addSpawn = (owner, spot) => {
    if (!spot) { drop('badSpawn'); return; }
    owner.all.push(spot);
  };

  const npcs = new Map();
  for (const r of S.rows(sql, 'creature_template', ['Entry', 'Name', 'SubName'])) {
    if (!GD.isId(r.Entry)) { drop('badId'); continue; }
    const name = nameOrDrop(r.Name, drop, NPC_JUNK);
    if (!name) continue;
    npcs.set(r.Entry, { id: r.Entry, name, subname: r.SubName ? D.toName(r.SubName) : null, gives: [], ends: [], all: [] });
  }
  const spawnEntries = new Map();
  for (const r of S.rows(sql, 'creature_spawn_entry', ['guid', 'entry'])) {
    if (!spawnEntries.has(r.guid)) spawnEntries.set(r.guid, []);
    spawnEntries.get(r.guid).push(r.entry);
  }
  const npcEvents = eventGuids('game_event_creature');
  const eventEntries = new Map();
  for (const r of S.rows(sql, 'game_event_creature_data', ['guid', 'entry_id'])) {
    if (!GD.isId(r.entry_id)) continue;
    if (!eventEntries.has(r.guid)) eventEntries.set(r.guid, new Set());
    eventEntries.get(r.guid).add(r.entry_id);
  }
  for (const r of S.rows(sql, 'creature', ['guid', 'id', 'map', 'position_x', 'position_y'])) {
    const spot = place(r.map, r.position_x, r.position_y);
    const shared = !r.id;
    const entries = shared ? spawnEntries.get(r.guid) || [] : [r.id];
    for (const entry of entries) {
      const npc = npcs.get(entry);
      if (npc) addSpawn(npc, spot && { ...spot, ...(npcEvents.has(r.guid) ? { event: true } : {}), ...(shared ? { shared: true } : {}) });
    }
    for (const entry of eventEntries.get(r.guid) || []) {
      const npc = npcs.get(entry);
      if (npc && !entries.includes(entry)) addSpawn(npc, spot && { ...spot, event: true });
    }
  }

  const objects = new Map();
  const objectNames = new Map([...S.rows(sql, 'gameobject_template', ['entry', 'name'])].map(r => [r.entry, r.name]));
  const quests = new Map();
  for (const r of S.rows(sql, 'quest_template', ['entry', 'Title'])) {
    if (!GD.isId(r.entry)) { drop('badId'); continue; }
    const title = nameOrDrop(r.Title, drop);
    if (!title) continue;
    quests.set(r.entry, { id: r.entry, title, inClientData: !!client.byId('quests', r.entry), givers: [], enders: [] });
  }
  const relate = (table, kind, list, back) => {
    for (const r of S.rows(sql, table, ['id', 'quest'])) {
      const quest = quests.get(r.quest);
      if (!quest) { drop('relationWithoutQuest'); continue; }
      let owner = kind === 'npc' ? npcs.get(r.id) : objects.get(r.id);
      if (!owner && kind === 'object') {
        const name = objectNames.has(r.id) ? nameOrDrop(objectNames.get(r.id), drop) : null;
        if (name) { owner = { id: r.id, name, gives: [], ends: [], all: [] }; objects.set(r.id, owner); }
      }
      if (!owner) { drop('relationWithoutOwner'); continue; }
      quest[list].push({ kind, id: r.id });
      owner[back].push(r.quest);
    }
  };
  relate('creature_questrelation', 'npc', 'givers', 'gives');
  relate('creature_involvedrelation', 'npc', 'enders', 'ends');
  relate('gameobject_questrelation', 'object', 'givers', 'gives');
  relate('gameobject_involvedrelation', 'object', 'enders', 'ends');
  const objectEvents = eventGuids('game_event_gameobject');
  for (const r of S.rows(sql, 'gameobject', ['guid', 'id', 'map', 'position_x', 'position_y'])) {
    const object = objects.get(r.id);
    if (!object) continue;
    const spot = place(r.map, r.position_x, r.position_y);
    addSpawn(object, spot && { ...spot, ...(objectEvents.has(r.guid) ? { event: true } : {}) });
  }
  const sorted = m => [...m.values()].map(finishSpawns).sort((a, b) => a.id - b.id);
  const entities = { npcs: sorted(npcs), questinfo: [...quests.values()].sort((a, b) => a.id - b.id), objects: sorted(objects) };
  for (const required of ['npcs', 'questinfo']) if (!entities[required].length) throw new S.DumpError(`no ${required} row survived conversion; the dump layout changed`);
  return { entities, droppedBy };
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, records.length ? records.map(r => JSON.stringify(r)).join('\n') + '\n' : '');
}

function swap(root, version, tmpDir, log) {
  let name = version;
  for (let k = 1; fs.existsSync(path.join(root, name)); k++) name = `${version}-${k}`;
  fs.renameSync(tmpDir, path.join(root, name));
  const pointerTmp = path.join(root, `${D.CURRENT_FILE}.tmp`);
  fs.writeFileSync(pointerTmp, name + '\n');
  fs.renameSync(pointerTmp, path.join(root, D.CURRENT_FILE));
  for (const old of fs.readdirSync(root)) {
    if (old === name || !(POINTER.test(old) || old.endsWith('.tmp'))) continue;
    try { fs.rmSync(path.join(root, old), { recursive: true, force: true }); } catch (e) { log(`could not remove ${path.join(root, old)}: ${e.message}`); }
  }
  return path.join(root, name);
}

async function syncCommunity(opts = {}) {
  const fetchImpl = opts.fetch;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  if (!opts.dataDir) throw new D.SyncError('no data folder given');
  if (typeof fetchImpl !== 'function') throw new D.SyncError('no fetch function given');
  const client = GD.openStore({ dataDir: opts.dataDir, flavor: FLAVOR });
  if (!client.build || !['uimaps', 'uimapassignments', 'quests'].every(e => client.has(e))) {
    throw new D.SyncError(`the Classic Era client tables are needed first (map positions and quest IDs come from them): run "${D.syncCommand(FLAVOR)}"`);
  }
  const root = communityRoot(opts.dataDir);
  const lock = D.acquireLock(root, now, opts.pidAlive);
  try {
    log(`fetch ${LISTING_URL}`);
    let listing;
    try { listing = JSON.parse((await fetchFrom(fetchImpl, LISTING_URL, API_ORIGIN, MAX_LISTING_BYTES)).toString('utf8')); } catch (e) {
      if (e instanceof D.SyncError) throw e;
      throw new D.SyncError(`${LISTING_URL}: not JSON`);
    }
    const dump = pickDump(listing);
    const version = `${dump.revision}-${dump.sha.slice(0, 7)}`;
    const before = readCommunity(root);
    const identity = clientIdentity(client);
    if (!opts.force && before && before.manifest.sha === dump.sha && before.manifest.client && before.manifest.client.placementHash && before.manifest.client.placementHash === identity.placementHash) {
      log(`community data is already at ${version} for client data ${client.build}; nothing to do (--force syncs it again)`);
      return { status: 'current', version, dir: before.dir, manifest: before.manifest };
    }
    log(`fetch ${dump.url}`);
    const gz = await fetchFrom(fetchImpl, dump.url, RAW_ORIGIN, MAX_DUMP_BYTES);
    if (gz.length !== dump.size) throw new D.SyncError(`${dump.name}: got ${gz.length} bytes, the listing says ${dump.size}`);
    if (gitBlobSha(gz) !== dump.sha) throw new D.SyncError(`${dump.name}: the file does not match the git sha ${dump.sha} the listing gives`);
    let sql;
    try { sql = zlib.gunzipSync(gz, { maxOutputLength: MAX_SQL_BYTES }).toString('utf8'); } catch (e) {
      throw new D.SyncError(`${dump.name}: cannot be unpacked within ${MAX_SQL_BYTES} bytes (${e.code || e.message})`);
    }
    let converted;
    try { converted = convert(sql, client); } catch (e) {
      if (e instanceof S.DumpError) throw new D.SyncError(`${dump.name}: ${e.message}`);
      throw e;
    }
    const tmpDir = path.join(root, `${version}.tmp`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      const entities = {};
      for (const [entity, records] of Object.entries(converted.entities)) {
        writeJsonl(path.join(tmpDir, `${entity}.jsonl`), records);
        entities[entity] = { file: `${entity}.jsonl`, rows: records.length };
        log(`${entity}: ${records.length} rows`);
      }
      const manifest = {
        schema: D.MANIFEST_SCHEMA,
        kind: 'community',
        shape: SHAPE,
        flavor: FLAVOR,
        source: SOURCE,
        trust: GD.TRUST.communityDb,
        url: REPO_URL,
        file: dump.name,
        sha: dump.sha,
        sha256: D.sha256(gz),
        version,
        fetchedAt: new Date(now()).toISOString(),
        license: LICENSE_NOTE,
        client: identity,
        rows: Object.values(entities).reduce((s, e) => s + e.rows, 0),
        dropped: Object.values(converted.droppedBy).reduce((s, n) => s + n, 0),
        droppedBy: converted.droppedBy,
        entities,
      };
      fs.writeFileSync(path.join(tmpDir, D.MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
      const dir = swap(root, version, tmpDir, log);
      return { status: 'synced', version, dir, manifest };
    } catch (e) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw e;
    }
  } finally {
    lock.release();
  }
}

module.exports = { FLAVOR, SOURCE, SHAPE, placementHash, clientIdentity, finishSpawns, sharedMaps, LISTING_URL, ENTITIES, MAX_SPAWNS, LICENSE_NOTE, communityRoot, readCommunity, openCommunity, gitBlobSha, pickDump, convert, syncCommunity };
