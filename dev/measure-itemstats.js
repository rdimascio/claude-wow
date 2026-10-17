#!/usr/bin/env node
'use strict';
const path = require('path');
const GD = require('../bridge/gamedata');
const IS = require('../bridge/itemstats');

const dataDir = process.argv[2] || path.join(require('os').homedir(), '.claude-wow', 'data');
const store = GD.openStore({ dataDir, flavor: 'classic_era' });
if (!IS.available(store)) {
  console.error(`no item stat tables in ${dataDir}; run ${store.syncCommand}`);
  process.exit(1);
}
const equippable = store.rows('items').filter(i => i.inventoryType > 0);
const tally = (items, pick) => {
  const counts = {};
  for (const it of items) for (const k of pick(it)) counts[k] = (counts[k] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
};
const decoded = equippable.map(it => ({ it, d: IS.decode(store, it.id) }));
const read = decoded.filter(x => !x.d.unread.length);
const low = decoded.filter(x => x.it.id < 200000);
console.log(
  JSON.stringify(
    {
      build: store.build,
      filter: 'items with inventoryType > 0',
      equippable: equippable.length,
      readInFull: read.length,
      idsUnder200000: low.length,
      idsUnder200000ReadInFull: low.filter(x => !x.d.unread.length).length,
      itemsByUnreadKind: tally(decoded, x => new Set(x.d.unread.map(u => u.kind))),
      itemsByUnreadAura: tally(decoded, x => new Set(x.d.unread.filter(u => u.kind === 'equip').map(u => `${u.effect}/${u.aura}`))),
      itemsWithStat: tally(read, x => Object.keys(x.d.stats)),
    },
    null,
    2,
  ),
);
