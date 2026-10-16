'use strict';
const D = require('./datasync');

const SOURCE = 'pfquest';
const REPO_URL = 'https://github.com/shagu/pfQuest';
const LISTING_URL = 'https://api.github.com/repos/shagu/pfQuest/contents/db';
const RAW_ORIGIN = 'https://raw.githubusercontent.com';
const RAW_PATH_PREFIX = '/shagu/pfQuest/';
const GIT_SHA = /^[0-9a-f]{40}$/;
const FILES = Object.freeze({ npcs: { name: 'units.lua', table: 'units' }, objects: { name: 'objects.lua', table: 'objects' } });
const MAX_LISTING_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_COORDS = 500000;
const NEAR = 1;
const UI_MAP_TYPE_ZONE = 3;
const LICENSE_NOTE =
  'pfQuest by Shagu (MIT), a 1.12 quest database. Only which zone each spawn lies in is read, to pick the zone where zone rectangles overlap. Cached on this machine only; never committed or redistributed.';

const LINE = Object.freeze({
  entity: /^ {2}\[(\d{1,9})\] = \{$/,
  coordsOpen: /^ {4}\["coords"\] = \{$/,
  coordsEmpty: /^ {4}\["coords"\] = \{\},$/,
  coord: /^ {6}\[\d{1,6}\] = \{ (-?\d{1,3}(?:\.\d+)?), (-?\d{1,3}(?:\.\d+)?), (\d{1,9}), -?\d{1,9} \},$/,
  coordsClose: /^ {4}\},$/,
  field: /^ {4}\["[a-z]{1,16}"\] = "[^"\\\n]{0,64}",$/,
  entityClose: /^ {2}\},$/,
  end: /^\}$/,
});

class PfQuestError extends Error {}

function parseCoords(text, table) {
  const lines = String(text).split('\n');
  const head = `pfDB["${table}"]["data"] = {`;
  if (lines[0] !== head) throw new PfQuestError(`the first line is not ${head}`);
  const out = new Map();
  let entity = null;
  let inCoords = false;
  let ended = false;
  let total = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const where = `line ${i + 1}`;
    if (line === '' && i === lines.length - 1) break;
    if (ended) {
      throw new PfQuestError(`${where}: text after the closing brace`);
    }
    let m;
    if (inCoords) {
      if ((m = LINE.coord.exec(line))) {
        if (++total > MAX_COORDS) throw new PfQuestError(`more than ${MAX_COORDS} spawn points`);
        out.get(entity).push({ x: Number(m[1]), y: Number(m[2]), areaID: Number(m[3]) });
      } else if (LINE.coordsClose.test(line)) inCoords = false;
      else throw new PfQuestError(`${where}: not a spawn point`);
    } else if (entity === null) {
      if ((m = LINE.entity.exec(line))) {
        entity = Number(m[1]);
        if (out.has(entity)) throw new PfQuestError(`${where}: entry ${entity} appears twice`);
        out.set(entity, []);
      } else if (LINE.end.test(line)) ended = true;
      else throw new PfQuestError(`${where}: not an entry`);
    } else if (LINE.coordsOpen.test(line)) inCoords = true;
    else if (LINE.entityClose.test(line)) entity = null;
    else if (!LINE.coordsEmpty.test(line) && !LINE.field.test(line)) throw new PfQuestError(`${where}: unknown field`);
  }
  if (!ended) throw new PfQuestError('the table never closes');
  if (!total) throw new PfQuestError('no spawn point at all');
  return out;
}

function pickFiles(listing) {
  if (!Array.isArray(listing)) throw new PfQuestError('not a folder listing');
  const files = {};
  for (const [kind, want] of Object.entries(FILES)) {
    const hits = listing.filter(e => e && e.type === 'file' && e.name === want.name);
    if (hits.length !== 1) throw new PfQuestError(`expected one db/${want.name}, found ${hits.length}`);
    const f = hits[0];
    if (typeof f.sha !== 'string' || !GIT_SHA.test(f.sha)) throw new PfQuestError(`${want.name}: the listing has no valid git sha`);
    if (!Number.isSafeInteger(f.size) || f.size <= 0 || f.size > MAX_FILE_BYTES)
      throw new PfQuestError(`${want.name}: size ${f.size} is outside 1..${MAX_FILE_BYTES} bytes`);
    let url;
    try {
      url = new URL(f.download_url);
    } catch {
      throw new PfQuestError(`${want.name}: no valid download URL`);
    }
    if (url.origin !== RAW_ORIGIN || !url.pathname.startsWith(RAW_PATH_PREFIX) || !url.pathname.endsWith(`/db/${want.name}`))
      throw new PfQuestError(`${want.name}: unexpected download URL ${url.href}`);
    files[kind] = { name: want.name, table: want.table, sha: f.sha, size: f.size, url: url.href };
  }
  return files;
}

async function listFiles(get) {
  let listing;
  try {
    listing = JSON.parse((await get(LISTING_URL, new URL(LISTING_URL).origin, MAX_LISTING_BYTES)).toString('utf8'));
  } catch (e) {
    if (e instanceof D.SyncError) throw e;
    throw new PfQuestError(`${LISTING_URL}: not JSON`);
  }
  return pickFiles(listing);
}

async function fetchCoords(get, files, blobSha, log = () => {}) {
  const coords = {};
  for (const [kind, f] of Object.entries(files)) {
    log(`fetch ${f.url}`);
    const bytes = await get(f.url, RAW_ORIGIN, MAX_FILE_BYTES);
    if (bytes.length !== f.size) throw new PfQuestError(`${f.name}: got ${bytes.length} bytes, the listing says ${f.size}`);
    if (blobSha(bytes) !== f.sha) throw new PfQuestError(`${f.name}: the file does not match the git sha ${f.sha} the listing gives`);
    try {
      coords[kind] = parseCoords(bytes.toString('utf8'), f.table);
    } catch (e) {
      if (e instanceof PfQuestError) throw new PfQuestError(`${f.name}: ${e.message}`);
      throw e;
    }
  }
  return coords;
}

function filesKey(files) {
  return files ? Object.keys(FILES).map(kind => `${kind}:${files[kind] && files[kind].sha}`) : null;
}

function zoneResolver(client, coords) {
  const uiMaps = new Map(client.rows('uimaps').map(m => [m.id, m]));
  const zonesOfArea = new Map();
  for (const a of client.rows('uimapassignments')) {
    const map = uiMaps.get(a.uiMapID);
    if (!map || map.type !== UI_MAP_TYPE_ZONE || !Number.isSafeInteger(a.areaID)) continue;
    if (!zonesOfArea.has(a.areaID)) zonesOfArea.set(a.areaID, new Set());
    zonesOfArea.get(a.areaID).add(a.uiMapID);
  }
  const counts = { resolved: 0, stillAmbiguous: 0 };
  const resolve = (kind, id, spot) => {
    if (!spot || !spot.zoneAmbiguous) return spot;
    const points = (coords[kind] && coords[kind].get(id)) || [];
    const isZone = m => (uiMaps.get(m.uiMapID) || {}).type === UI_MAP_TYPE_ZONE;
    const near = spot.maps.filter(
      m => isZone(m) && points.some(p => (zonesOfArea.get(p.areaID) || new Set()).has(m.uiMapID) && Math.hypot(p.x - m.x, p.y - m.y) <= NEAR),
    );
    if (near.length !== 1) {
      counts.stillAmbiguous++;
      return spot;
    }
    counts.resolved++;
    const placed = { ...spot, maps: [near[0], ...spot.maps.filter(m => !isZone(m))], zoneFrom: SOURCE };
    delete placed.zoneAmbiguous;
    return placed;
  };
  return { resolve, counts };
}

module.exports = {
  SOURCE,
  REPO_URL,
  LISTING_URL,
  FILES,
  NEAR,
  LICENSE_NOTE,
  PfQuestError,
  parseCoords,
  pickFiles,
  listFiles,
  fetchCoords,
  filesKey,
  zoneResolver,
};
