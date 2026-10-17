#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { HEAD } = require('./simweights');

const REPO = 'wowsims/classic';
const RAW = 'https://raw.githubusercontent.com';
const OUT = path.join(__dirname, '..', 'bridge', 'simitems.json');
const STAT_SLOTS = Object.freeze({
  strength: 0,
  agility: 1,
  stamina: 2,
  intellect: 3,
  spirit: 4,
  spellPower: 5,
  mp5: 12,
  spellHit: 13,
  spellCrit: 14,
  attackPower: 17,
  meleeHit: 18,
  meleeCrit: 19,
  armor: 26,
  rangedAttackPower: 27,
  defense: 28,
  healing: 41,
  spellDamage: 42,
});
const STATS_LENGTH = 44;
const FIELDS = Object.freeze([...Object.keys(STAT_SLOTS), 'weaponMin', 'weaponMax']);

function compact(db) {
  if (!db || !Array.isArray(db.items)) throw new Error('db.json has no items list');
  const items = {};
  for (const it of db.items) {
    if (!Number.isSafeInteger(it.id) || it.id <= 0) throw new Error(`an item has no valid id: ${JSON.stringify(it.id)}`);
    if (!Array.isArray(it.stats) || it.stats.length !== STATS_LENGTH || !it.stats.every(Number.isFinite))
      throw new Error(`item ${it.id}: stats is not ${STATS_LENGTH} numbers; the Stat enum changed`);
    if (String(it.id) in items) throw new Error(`item ${it.id} appears twice`);
    const weapon = [it.weaponDamageMin || 0, it.weaponDamageMax || 0];
    if (!weapon.every(Number.isFinite)) throw new Error(`item ${it.id}: weapon damage is not a number`);
    items[it.id] = [...Object.values(STAT_SLOTS).map(k => it.stats[k]), ...weapon];
  }
  return items;
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'error' });
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function build(read = fetchText) {
  const license = await read(`${RAW}/${REPO}/${HEAD}/LICENSE`);
  if (!/^MIT License/.test(license)) throw new Error('the wowsims licence is no longer MIT');
  const url = `${RAW}/${REPO}/${HEAD}/assets/database/db.json`;
  return {
    source: url,
    commit: HEAD,
    note: 'Classic Era item stats from the wowsims item database, used only to cross-check the client tables: an item whose stats differ from these is not scored. weaponMin and weaponMax include extra elemental damage.',
    license: license.trim(),
    fields: FIELDS,
    items: compact(JSON.parse(await read(url))),
  };
}

if (require.main === module) {
  build()
    .then(out => {
      fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
      console.log(`${Object.keys(out.items).length} items -> ${OUT}`);
    })
    .catch(e => {
      console.error(e.message);
      process.exit(1);
    });
}

module.exports = { FIELDS, STAT_SLOTS, compact, build };
