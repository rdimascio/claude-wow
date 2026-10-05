'use strict';
const D = require('./datasync');
const GD = require('./gamedata');
const S = require('./sqldump');

const COLUMNS = Object.freeze(['entry', 'item', 'ChanceOrQuestChance', 'groupid', 'mincountOrRef', 'maxcount', 'condition_id']);
const TABLES = Object.freeze({
  creatureloot: 'creature_loot_template',
  skinloot: 'skinning_loot_template',
  pickpocketloot: 'pickpocketing_loot_template',
  objectloot: 'gameobject_loot_template',
  fishingloot: 'fishing_loot_template',
  containerloot: 'item_loot_template',
  disenchantloot: 'disenchant_loot_template',
  referenceloot: 'reference_loot_template',
});
const TEMPLATES = Object.freeze(Object.keys(TABLES));
const OWNED = Object.freeze(TEMPLATES.filter(e => e !== 'referenceloot'));
const ENTITIES = Object.freeze([...TEMPLATES, 'lootobjects', 'lootitems']);
const NPC_LOOT = Object.freeze({
  creatureloot: ['LootId', 'lootId'],
  skinloot: ['SkinningLootId', 'skinningId'],
  pickpocketloot: ['PickpocketLootId', 'pickpocketId'],
});
const OBJECT_KINDS = Object.freeze({ 3: 'chest', 25: 'fishinghole' });
const MAX_REFERENCE_DEPTH = 2;
const MAX_ROW_COUNT = 255;
const MAX_GROUP = 127;
const MIN_CHANCE = 0.000001;
const ITEM_HAS_LOOT = 4;
const ENCOUNTER_CHESTS = Object.freeze([
  Object.freeze({ mapID: 70, encounter: 'The Lost Dwarves', chest: "Baelog's Chest" }),
  Object.freeze({ mapID: 230, encounter: 'Ring of Law', chest: 'Arena Spoils' }),
  Object.freeze({ mapID: 230, encounter: 'The Seven', chest: 'Chest of The Seven' }),
  Object.freeze({ mapID: 409, encounter: 'Majordomo Executus', chest: 'Cache of the Firelord' }),
  Object.freeze({ mapID: 533, encounter: 'The Four Horsemen', chest: 'Four Horsemen Chest' }),
]);

function mergeFlags(a, b) {
  return { questOnly: a.questOnly && b.questOnly, conditional: a.conditional && b.conditional, shared: a.shared && b.shared };
}

function flagged(id, f) {
  return { id, ...(f.questOnly ? { questOnly: true } : {}), ...(f.conditional ? { conditional: true } : {}) };
}

function addTo(map, id, f) {
  map.set(id, map.has(id) ? mergeFlags(map.get(id), f) : f);
}

function lootRow(r, ctx, drop) {
  const chance = Math.abs(r.ChanceOrQuestChance);
  const conditional = r.condition_id > 0;
  if (
    !Number.isSafeInteger(r.entry) ||
    r.entry < 0 ||
    !Number.isSafeInteger(r.mincountOrRef) ||
    r.mincountOrRef === 0 ||
    typeof r.ChanceOrQuestChance !== 'number' ||
    !Number.isSafeInteger(r.groupid) ||
    r.groupid < 0 ||
    r.groupid > MAX_GROUP ||
    !Number.isSafeInteger(r.maxcount) ||
    r.maxcount < 0 ||
    r.maxcount > MAX_ROW_COUNT
  ) {
    drop('lootRowInvalid');
    return null;
  }
  if (conditional && !ctx.conditions.has(r.condition_id)) {
    drop('lootConditionMissing');
    return null;
  }
  if (r.mincountOrRef > 0) {
    if (!ctx.items112.has(r.item)) {
      drop('lootItemNotIn112');
      return null;
    }
    if ((chance === 0 && r.groupid === 0) || (chance !== 0 && chance < MIN_CHANCE) || r.maxcount < r.mincountOrRef) {
      drop('lootRowInvalid');
      return null;
    }
    if (!ctx.client.byId('items', r.item)) {
      drop('lootItemNotInClient');
      return { rolls: true };
    }
    return { item: r.item, flags: { questOnly: r.ChanceOrQuestChance < 0, conditional, shared: false } };
  }
  if (r.ChanceOrQuestChance < 0 || (chance === 0 && r.groupid === 0)) {
    drop('lootRowInvalid');
    return null;
  }
  if (r.maxcount === 0) {
    drop('referenceNeverRolled');
    return { rolls: true };
  }
  return { ref: -r.mincountOrRef, flags: { questOnly: false, conditional, shared: true } };
}

function groupsAlwaysFilled(rows) {
  const sums = new Map();
  for (const r of rows) {
    if (r.group > 0 && r.chance > 0 && !r.conditional) sums.set(r.group, (sums.get(r.group) || 0) + r.chance);
  }
  return new Set([...sums].filter(([, sum]) => sum >= 100).map(([group]) => group));
}

function readTemplates(sql, ctx, drop) {
  const templates = {};
  for (const [entity, table] of Object.entries(TABLES)) {
    const kept = new Map();
    for (const r of S.rows(sql, table, COLUMNS)) {
      const row = lootRow(r, ctx, drop);
      if (!row) continue;
      if (!kept.has(r.entry)) kept.set(r.entry, []);
      kept.get(r.entry).push({ ...row, group: r.groupid, chance: Math.abs(r.ChanceOrQuestChance), conditional: r.condition_id > 0 });
    }
    const byEntry = new Map();
    for (const [entry, rows] of kept) {
      const filled = groupsAlwaysFilled(rows);
      const t = { items: new Map(), refs: new Map(), rows: 0 };
      for (const row of rows) {
        if (row.rolls) continue;
        if (row.chance === 0 && filled.has(row.group)) {
          drop('lootGroupNeverReached');
          continue;
        }
        t.rows++;
        if (row.ref) addTo(t.refs, row.ref, row.flags);
        else addTo(t.items, row.item, row.flags);
      }
      byEntry.set(entry, t);
    }
    templates[entity] = byEntry;
  }
  return templates;
}

function checkReferences(templates, count) {
  const refs = templates.referenceloot;
  for (const byEntry of Object.values(templates)) {
    for (const t of byEntry.values()) {
      for (const id of [...t.refs.keys()]) {
        if (!refs.has(id)) {
          t.refs.delete(id);
          count('unresolved', 'referenceloot');
        }
      }
    }
  }
  let depth = 1;
  for (const [id, t] of refs) {
    for (const target of t.refs.keys()) {
      if (target === id || refs.get(target).refs.size)
        throw new S.DumpError(
          `reference loot ${id} reaches reference ${target}, which references further: references nest deeper than ${MAX_REFERENCE_DEPTH} levels or loop`,
        );
      depth = MAX_REFERENCE_DEPTH;
    }
  }
  return depth;
}

function encounterChests(client, objects, spawnMaps, count) {
  const encounters = client.has('encounters') ? client.rows('encounters') : [];
  for (const c of ENCOUNTER_CHESTS) {
    const inClient = encounters.some(e => e.mapID === c.mapID && e.name === c.encounter);
    const chests = [...objects.values()].filter(o => o.kind === 'chest' && o.name === c.chest && (spawnMaps.get(o.id) || new Set()).has(c.mapID));
    if (!inClient || chests.length !== 1) {
      count('unresolved', 'encounterChest');
      continue;
    }
    chests[0].encounter = { mapID: c.mapID, name: c.encounter };
  }
}

function convert(sql, client, { npcs, nameOrDrop, drop }) {
  const loot = { unreferenced: {}, unresolved: {} };
  const count = (kind, entity, n = 1) => {
    loot[kind][entity] = (loot[kind][entity] || 0) + n;
  };
  const itemRows = [...S.rows(sql, 'item_template', ['entry', 'name', 'Flags', 'DisenchantID', 'maxMoneyLoot'])];
  const ctx = {
    client,
    conditions: new Set([...S.rows(sql, 'conditions', ['condition_entry'])].map(r => r.condition_entry)),
    items112: new Map(itemRows.filter(r => GD.isId(r.entry)).map(r => [r.entry, r])),
  };
  const templates = readTemplates(sql, ctx, drop);
  loot.referenceDepth = checkReferences(templates, count);

  const owned = Object.fromEntries(TEMPLATES.map(e => [e, new Set()]));
  const own = (entity, id) => {
    const t = templates[entity].get(id);
    if (!t || (!t.items.size && !t.refs.size)) {
      count('unresolved', entity);
      return false;
    }
    owned[entity].add(id);
    return true;
  };
  for (const r of S.rows(sql, 'creature_template', ['Entry', 'LootId', 'SkinningLootId', 'PickpocketLootId'])) {
    const npc = npcs.get(r.Entry);
    if (!npc) continue;
    for (const [entity, [column, field]] of Object.entries(NPC_LOOT)) {
      if (GD.isId(r[column]) && own(entity, r[column])) npc[field] = r[column];
    }
  }

  const objects = new Map();
  for (const r of S.rows(sql, 'gameobject_template', ['entry', 'type', 'name', 'data1'])) {
    const kind = OBJECT_KINDS[r.type];
    if (!kind || !GD.isId(r.entry) || !GD.isId(r.data1)) continue;
    const name = nameOrDrop(r.name, drop);
    if (name && own('objectloot', r.data1)) objects.set(r.entry, { id: r.entry, name, kind, lootId: r.data1 });
  }
  const spawnMaps = new Map();
  for (const r of S.rows(sql, 'gameobject', ['id', 'map'])) {
    if (!objects.has(r.id)) continue;
    if (!spawnMaps.has(r.id)) spawnMaps.set(r.id, new Set());
    spawnMaps.get(r.id).add(r.map);
  }
  encounterChests(client, objects, spawnMaps, count);

  for (const id of templates.fishingloot.keys()) {
    if (client.byId('zones', id)) own('fishingloot', id);
  }
  for (const it of ctx.items112.values()) {
    if (!(it.Flags & ITEM_HAS_LOOT) || !client.byId('items', it.entry)) continue;
    if (templates.containerloot.has(it.entry)) own('containerloot', it.entry);
    else if (!(it.maxMoneyLoot > 0)) count('unresolved', 'containerloot');
  }
  const disenchantSources = new Map();
  for (const it of ctx.items112.values()) {
    if (!GD.isId(it.DisenchantID) || !templates.disenchantloot.has(it.DisenchantID)) continue;
    if (!client.byId('items', it.entry)) {
      drop('disenchantSourceNotInClient');
      continue;
    }
    if (!disenchantSources.has(it.DisenchantID)) disenchantSources.set(it.DisenchantID, []);
    disenchantSources.get(it.DisenchantID).push(it.entry);
  }
  for (const id of disenchantSources.keys()) own('disenchantloot', id);

  const reached = new Set();
  const reach = (t, depth) => {
    for (const id of t.refs.keys()) {
      if (reached.has(id) || depth > MAX_REFERENCE_DEPTH) continue;
      reached.add(id);
      reach(templates.referenceloot.get(id), depth + 1);
    }
  };
  for (const entity of OWNED) for (const id of owned[entity]) reach(templates[entity].get(id), 1);
  owned.referenceloot = reached;

  const entities = {};
  const usedItems = new Set();
  for (const entity of TEMPLATES) {
    const rows = [];
    for (const [id, t] of templates[entity]) {
      if (!owned[entity].has(id)) {
        count('unreferenced', entity, t.rows);
        continue;
      }
      const row = { id, items: [...t.items].map(([itemID, f]) => flagged(itemID, f)) };
      if (t.refs.size) row.refs = [...t.refs].map(([refID, f]) => flagged(refID, f));
      if (entity === 'disenchantloot') row.fromItems = disenchantSources.get(id).sort((a, b) => a - b);
      for (const it of row.items) usedItems.add(it.id);
      for (const itemID of row.fromItems || []) usedItems.add(itemID);
      if (entity === 'containerloot') usedItems.add(id);
      rows.push(row);
    }
    entities[entity] = rows.sort((a, b) => a.id - b.id);
  }
  entities.lootobjects = [...objects.values()].sort((a, b) => a.id - b.id);
  entities.lootitems = [...usedItems].sort((a, b) => a - b).map(id => ({ id, name: D.toName(ctx.items112.get(id).name) }));
  if (!entities.creatureloot.length) throw new S.DumpError('no creature loot row survived conversion; the dump layout changed');
  return { entities, loot };
}

function buildIndex(cs) {
  const itemIn = new Map();
  const refIn = new Map();
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  for (const entity of TEMPLATES) {
    for (const t of cs.rows(entity)) {
      for (const it of t.items) push(itemIn, it.id, { entity, id: t.id, questOnly: !!it.questOnly, conditional: !!it.conditional });
      for (const ref of t.refs || []) push(refIn, ref.id, { entity, id: t.id, conditional: !!ref.conditional });
    }
  }
  return { itemIn, refIn };
}

const indexes = new WeakMap();

function lootIndex(cs) {
  if (!indexes.has(cs)) indexes.set(cs, buildIndex(cs));
  return indexes.get(cs);
}

function hasIndex(cs) {
  return indexes.has(cs);
}

function hasLoot(cs) {
  return !!cs && ENTITIES.every(e => cs.has(e));
}

function sourcesOf(cs, itemID) {
  const { itemIn, refIn } = lootIndex(cs);
  const out = new Map(OWNED.map(e => [e, new Map()]));
  const climb = (refID, f, depth) => {
    for (const up of refIn.get(refID) || []) {
      const g = { questOnly: f.questOnly, conditional: f.conditional || up.conditional, shared: true };
      if (up.entity === 'referenceloot') {
        if (depth < MAX_REFERENCE_DEPTH) climb(up.id, g, depth + 1);
      } else addTo(out.get(up.entity), up.id, g);
    }
  };
  for (const hit of itemIn.get(itemID) || []) {
    const f = { questOnly: hit.questOnly, conditional: hit.conditional, shared: false };
    if (hit.entity === 'referenceloot') climb(hit.id, f, 1);
    else addTo(out.get(hit.entity), hit.id, f);
  }
  return out;
}

function itemsOf(cs, entity, templateID) {
  const out = new Map();
  const walk = (t, f, depth) => {
    if (!t) return;
    for (const it of t.items) addTo(out, it.id, { questOnly: !!it.questOnly, conditional: f.conditional || !!it.conditional, shared: f.shared });
    if (depth >= MAX_REFERENCE_DEPTH) return;
    for (const ref of t.refs || []) walk(cs.byId('referenceloot', ref.id), { conditional: f.conditional || !!ref.conditional, shared: true }, depth + 1);
  };
  walk(cs.byId(entity, templateID), { conditional: false, shared: false }, 0);
  return out;
}

module.exports = {
  TABLES,
  TEMPLATES,
  OWNED,
  ENTITIES,
  NPC_LOOT,
  ENCOUNTER_CHESTS,
  MAX_REFERENCE_DEPTH,
  convert,
  hasLoot,
  hasIndex,
  lootIndex,
  sourcesOf,
  itemsOf,
};
