'use strict';

const WOWDATA_TOOL = /^mcp__wowdata__(wow_[a-z]+)$/;
const MAX_LINE = 80;
const MAX_NAME = 40;
const VERIFIED = new Set(['client-data', 'client-data-build-unchecked']);
const LOADING = Object.freeze({
  wow_item: 'Looking up an item',
  wow_spell: 'Looking up a spell',
  wow_instance: 'Looking up a dungeon or raid',
  wow_faction: 'Looking up a faction',
  wow_quest: 'Looking up a quest',
  wow_npc: 'Looking up an NPC',
  wow_flights: 'Looking up flight paths',
  wow_where: 'Looking up a place',
  wow_sources: 'Checking the game data',
});
const SOURCE_PARTS = Object.freeze([
  ['droppedBy', 'dropped by', 'NPC'],
  ['skinnedFrom', 'skinned from', 'NPC'],
  ['pickpocketedFrom', 'pick pocketed from', 'NPC'],
  ['objects', 'in', 'chest or node', 'chests or nodes'],
  ['fishedIn', 'fished in', 'zone'],
  ['inContainers', 'in', 'container'],
  ['disenchantedFrom', 'disenchanted from', 'item'],
]);

function wowdataTool(name) {
  const m = WOWDATA_TOOL.exec(String(name || ''));
  return m && Object.prototype.hasOwnProperty.call(LOADING, m[1]) ? m[1] : null;
}

function loadingLine(tool) {
  return LOADING[tool] || null;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function placeName(row) {
  if (!row || !VERIFIED.has(row.trust) || typeof row.name !== 'string') return null;
  const name = row.name.replace(/[\p{Cc}\p{Cf}{}|]/gu, '').trim();
  return name && name.length <= MAX_NAME ? name : null;
}

function itemToken(row) {
  return row && Number.isSafeInteger(row.id) && row.id > 0 && VERIFIED.has(row.trust) ? `{item:${row.id}}` : null;
}

function join(head, parts) {
  let line = head;
  for (const part of parts) {
    const next = line ? `${line}${line === head && head ? ': ' : ', '}${part}` : part;
    if (next.length > MAX_LINE) break;
    line = next;
  }
  return line;
}

function andMore(head, n) {
  return n > 0 ? `${head} and ${n} more` : head;
}

function itemLine(result) {
  const rows = result.results;
  if (result.query && result.query.id === undefined) {
    const token = itemToken(rows[0]);
    return token ? andMore(token, (result.total || rows.length) - 1) : plural(result.total || rows.length, 'item');
  }
  const row = rows[0];
  const token = itemToken(row);
  if (!token) return null;
  const c = row.community;
  if (!c) return token;
  const parts = [];
  for (const [key, verb, one, many] of SOURCE_PARTS) {
    const total = c[key] && Number.isSafeInteger(c[key].total) ? c[key].total : 0;
    if (total) parts.push(`${verb} ${plural(total, one, many)}`);
  }
  return parts.length ? join(`${token} in 1.12 data`, parts) : `${token}: no 1.12 source`;
}

function instanceLine(result) {
  const row = result.results[0];
  const name = placeName(row);
  if (!name) return null;
  const bosses = new Set();
  let chests = 0;
  for (const set of Array.isArray(row.bossSets) ? row.bossSets : []) {
    for (const boss of Array.isArray(set.bosses) ? set.bosses : []) {
      if (!bosses.has(boss.name) && boss.community && boss.community.chest) chests++;
      bosses.add(boss.name);
    }
  }
  const parts = [plural(bosses.size, 'boss', 'bosses')];
  if (chests) parts.push(plural(chests, 'chest'));
  if (result.results.length > 1) parts.push(`${result.results.length - 1} more`);
  return join(name, parts);
}

function npcLine(result) {
  const row = result.results[0];
  const drops = row && row.drops;
  if (!drops || !drops.total) return result.results.length > 1 ? plural(result.total || result.results.length, 'NPC') + ' in 1.12 data' : 'NPC found in 1.12 data';
  const best = drops.items && drops.items[0] && Number.isSafeInteger(drops.items[0].id) ? `{item:${drops.items[0].id}}` : null;
  return join('NPC in 1.12 data', [`${plural(drops.total, 'drop')}`, ...(best ? [`best ${best}`] : [])]);
}

function namedLine(result, noun, many) {
  const first = placeName(result.results[0]);
  const total = result.total || result.results.length;
  if (!first) return plural(total, noun, many);
  return andMore(first, total - 1);
}

function resultLine(tool, text) {
  let result;
  try { result = JSON.parse(text); } catch { return null; }
  if (!result || typeof result !== 'object' || result.error || !Array.isArray(result.results)) return null;
  if (!result.found || !result.results.length) return 'Nothing found';
  switch (tool) {
    case 'wow_item': return itemLine(result);
    case 'wow_instance': return instanceLine(result);
    case 'wow_npc': return npcLine(result);
    case 'wow_where': return namedLine(result, 'place');
    case 'wow_flights': return namedLine(result, 'flight path');
    case 'wow_faction': return namedLine(result, 'faction');
    case 'wow_spell': return plural(result.total || result.results.length, 'spell');
    case 'wow_quest': return plural(result.total || result.results.length, 'quest');
    case 'wow_sources': return 'Game data checked';
    default: return null;
  }
}

module.exports = { MAX_LINE, LOADING, wowdataTool, loadingLine, resultLine };
