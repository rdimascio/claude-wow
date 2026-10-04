'use strict';

const WOWDATA_TOOL = /^mcp__wowdata__(wow_[a-z]+)$/;
const MAX_LINE = 80;
const MAX_NAME = 40;
const VERIFIED = new Set(['client-data', 'client-data-build-unchecked']);
const UNMATCHED_BUILD = new Set(['build-mismatch', 'no-data']);
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
  ['objects', 'in', 'chest, node or pool', 'chests, nodes or pools'],
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

function totalOf(result) {
  return Number.isSafeInteger(result.total) && result.total > 0 ? result.total : result.results.length;
}

function placeName(row) {
  if (!row || !VERIFIED.has(row.trust) || typeof row.name !== 'string') return null;
  const name = row.name.replace(/[\p{Cc}\p{Cf}{}|]/gu, '').trim();
  return name && name.length <= MAX_NAME ? name : null;
}

function token(id) {
  return Number.isSafeInteger(id) && id > 0 ? `{item:${id}}` : null;
}

function fit(parts, tail = '', head = '') {
  const kept = [];
  for (const part of parts) {
    if (head.length + [...kept, part].join(', ').length + tail.length > MAX_LINE) break;
    kept.push(part);
  }
  return head + kept.join(', ') + tail;
}

function sentence(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function itemLine(result) {
  const row = result.results[0];
  const link = VERIFIED.has(row.trust) ? token(row.id) : null;
  if (result.query && result.query.id === undefined) {
    const count = plural(totalOf(result), 'item');
    return link ? `${count}, first ${link}` : count;
  }
  if (!link) return null;
  const c = row.community;
  if (!c) return `Found ${link}`;
  const parts = [];
  for (const [key, verb, one, many] of SOURCE_PARTS) {
    const total = c[key] && Number.isSafeInteger(c[key].total) ? c[key].total : 0;
    if (total) parts.push(`${verb} ${plural(total, one, many)}`);
  }
  if (!parts.length) return `No source shown in 1.12 data: ${link}`;
  return sentence(fit(parts, ` in 1.12 data: ${link}`));
}

function instanceLine(result) {
  const row = result.results[0];
  const name = placeName(row);
  if (!name) return null;
  const encounters = new Set();
  let chests = 0;
  for (const set of Array.isArray(row.bossSets) ? row.bossSets : []) {
    for (const boss of Array.isArray(set.bosses) ? set.bosses : []) {
      if (!encounters.has(boss.name) && boss.community && boss.community.chest) chests++;
      encounters.add(boss.name);
    }
  }
  const parts = [plural(encounters.size, 'encounter')];
  if (chests) parts.push(`${plural(chests, 'chest')} in 1.12 data`);
  const more = totalOf(result) - 1;
  if (more > 0) parts.push(`${more} more`);
  return fit(parts, '', `${name}: `);
}

function npcLine(result) {
  const total = totalOf(result);
  if (total > 1) return `${plural(total, 'NPC')} in 1.12 data`;
  const drops = result.results[0].drops;
  if (!drops || !drops.total) return 'NPC found in 1.12 data';
  const head = `NPC in 1.12 data: ${plural(drops.total, 'drop')}`;
  if (UNMATCHED_BUILD.has(result.buildCheck)) return head;
  const shown = (Array.isArray(drops.items) ? drops.items : []).filter(it => token(it.id));
  const top = shown.reduce((best, it) => ((it.quality || 0) > (best ? best.quality || 0 : -1) ? it : best), null);
  return top ? `${head}, including ${token(top.id)}` : head;
}

function namedLine(result, noun, many) {
  const first = placeName(result.results[0]);
  const total = totalOf(result);
  if (!first) return plural(total, noun, many);
  return total > 1 ? `${first} and ${total - 1} more` : first;
}

function resultLine(tool, text) {
  let result;
  try { result = JSON.parse(text); } catch { return null; }
  if (!result || typeof result !== 'object' || result.error || !Array.isArray(result.results)) return null;
  if (!result.found || !result.results.length) return 'Nothing found';
  if (!result.results[0] || typeof result.results[0] !== 'object') return null;
  switch (tool) {
    case 'wow_item': return itemLine(result);
    case 'wow_instance': return instanceLine(result);
    case 'wow_npc': return npcLine(result);
    case 'wow_where': return namedLine(result, 'place');
    case 'wow_flights': return namedLine(result, 'flight path');
    case 'wow_faction': return plural(totalOf(result), 'faction');
    case 'wow_spell': return plural(totalOf(result), 'spell');
    case 'wow_quest': return plural(totalOf(result), 'quest');
    case 'wow_sources': return 'Game data checked';
    default: return null;
  }
}

module.exports = { MAX_LINE, LOADING, wowdataTool, loadingLine, resultLine };
