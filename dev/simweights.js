#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = 'wowsims/classic';
const HEAD = '7779ebbf79dc7f1341e6ab939b28a3402c9a730a';
const CUTOVER = '5634c852d47acfcc5b6b62a6472a536df64634dc';
const RAW = 'https://raw.githubusercontent.com';
const OUT = path.join(__dirname, '..', 'bridge', 'simweights.json');
const SIMS = Object.freeze({
  warrior: { class: 'WARRIOR', trees: ['Arms', 'Fury'], role: 'dps' },
  tank_warrior: { class: 'WARRIOR', trees: ['Protection'], role: 'tank' },
  holy_paladin: { class: 'PALADIN', trees: ['Holy'], role: 'healer' },
  protection_paladin: { class: 'PALADIN', trees: ['Protection'], role: 'tank' },
  retribution_paladin: { class: 'PALADIN', trees: ['Retribution'], role: 'dps' },
  hunter: { class: 'HUNTER', trees: ['Beast Mastery', 'Marksmanship', 'Survival'], role: 'dps' },
  rogue: { class: 'ROGUE', trees: ['Assassination', 'Combat', 'Subtlety'], role: 'dps' },
  healing_priest: { class: 'PRIEST', trees: ['Discipline', 'Holy'], role: 'healer' },
  shadow_priest: { class: 'PRIEST', trees: ['Shadow'], role: 'dps' },
  elemental_shaman: { class: 'SHAMAN', trees: ['Elemental'], role: 'dps' },
  enhancement_shaman: { class: 'SHAMAN', trees: ['Enhancement'], role: 'dps' },
  restoration_shaman: { class: 'SHAMAN', trees: ['Restoration'], role: 'healer' },
  mage: { class: 'MAGE', trees: ['Arcane', 'Fire', 'Frost'], role: 'dps' },
  warlock: { class: 'WARLOCK', trees: ['Affliction', 'Demonology', 'Destruction'], role: 'dps' },
  balance_druid: { class: 'DRUID', trees: ['Balance'], role: 'dps' },
  feral_druid: { class: 'DRUID', trees: ['Feral Combat'], role: 'dps' },
  feral_tank_druid: { class: 'DRUID', trees: ['Feral Combat'], role: 'tank' },
  restoration_druid: { class: 'DRUID', trees: ['Restoration'], role: 'healer' },
});
const OPEN = 'epWeights: Stats.fromMap(';
const REFERENCE = /epReferenceStat:\s*Stat\.(Stat[A-Za-z0-9]+)/;
const SCALE_STATS = Object.freeze(['StatMeleeHit', 'StatMeleeCrit', 'StatSpellHit', 'StatSpellCrit']);
const MIN_PERCENT_SCALE = 3;
const LINE = Object.freeze({
  open: /^\{$/,
  empty: /^\{\},?$/,
  close: /^\},?$/,
  entry: /^\[(Stat|PseudoStat)\.([A-Za-z][A-Za-z0-9]+)\]: (-?\d+(?:\.\d+)?),$/,
});

function epBlock(text, where) {
  const start = text.indexOf(OPEN);
  if (start < 0 || text.indexOf(OPEN, start + 1) >= 0) throw new Error(`${where}: expected one ${OPEN}`);
  let depth = 0;
  for (let i = start + OPEN.length - 1; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return text.slice(start + OPEN.length, i);
  }
  throw new Error(`${where}: ${OPEN} never closes`);
}

function percentScale(stats, reference) {
  const unit = reference && stats[reference] > 1 ? stats[reference] : 1;
  const values = SCALE_STATS.filter(k => stats[k] > 0).map(k => stats[k] / unit);
  return values.length ? Math.max(...values) : null;
}

function verdict(now, before, reference) {
  if (Object.entries(now.stats).every(([k, v]) => before.stats[k] === v)) return 'every weight is unchanged since the Season of Discovery fork';
  const scale = percentScale(now.stats, reference);
  if (scale === null) return 'no hit or crit weight to check the scale against';
  if (scale < MIN_PERCENT_SCALE) return `hit and crit are worth at most ${scale} reference points: a per-rating scale, not Classic per-percent weights`;
  return null;
}

function parseWeights(block, where) {
  const groups = [];
  let current = null;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s*\/\/.*$/, '').trim();
    if (!line) continue;
    if (LINE.empty.test(line)) {
      if (current) throw new Error(`${where}: nested map`);
      groups.push({ enums: new Set(), weights: {} });
      continue;
    }
    if (LINE.open.test(line)) {
      if (current) throw new Error(`${where}: nested map`);
      current = { enums: new Set(), weights: {} };
      continue;
    }
    if (LINE.close.test(line)) {
      if (!current) throw new Error(`${where}: close without open`);
      groups.push(current);
      current = null;
      continue;
    }
    const m = LINE.entry.exec(line);
    if (!m || !current) throw new Error(`${where}: not a weight line: ${line}`);
    if (m[2] in current.weights) throw new Error(`${where}: ${m[2]} twice`);
    current.enums.add(m[1]);
    current.weights[m[2]] = Number(m[3]);
  }
  if (current || groups.length < 1 || groups.length > 2) throw new Error(`${where}: expected a stat map and an optional pseudo-stat map`);
  const [stats, pseudo = { enums: new Set(['PseudoStat']), weights: {} }] = groups;
  if ([...stats.enums].some(e => e !== 'Stat') || [...pseudo.enums].some(e => e !== 'PseudoStat'))
    throw new Error(`${where}: stat and pseudo-stat maps are mixed up`);
  return { stats: stats.weights, pseudo: pseudo.weights };
}

async function simFile(commit, sim) {
  const url = `${RAW}/${REPO}/${commit}/ui/${sim}/sim.ts`;
  const res = await fetch(url, { redirect: 'error' });
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  return { url, text: await res.text() };
}

async function build() {
  const license = await (await fetch(`${RAW}/${REPO}/${HEAD}/LICENSE`, { redirect: 'error' })).text();
  if (!/^MIT License/.test(license)) throw new Error('the wowsims licence is no longer MIT');
  const sims = {};
  const leftOut = {};
  for (const [sim, info] of Object.entries(SIMS)) {
    const [now, before] = await Promise.all([simFile(HEAD, sim), simFile(CUTOVER, sim)]);
    const weights = parseWeights(epBlock(now.text, now.url), now.url);
    const reference = (REFERENCE.exec(now.text) || [])[1] || null;
    const why = verdict(weights, parseWeights(epBlock(before.text, before.url), before.url), reference);
    if (why) {
      leftOut[sim] = why;
      continue;
    }
    sims[sim] = { ...info, source: now.url, reference, ...weights };
  }
  return {
    source: `https://github.com/${REPO}`,
    commit: HEAD,
    forkCommit: CUTOVER,
    level: 60,
    note: 'Stat weights (EP) from the wowsims Classic Era simulators, one per simulator, relative to the stat each simulator scales by. Only simulators whose weights changed since the Season of Discovery fork are kept.',
    license: license.trim(),
    sims,
    leftOut,
  };
}

if (require.main === module) {
  build()
    .then(out => {
      fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
      console.log(`${Object.keys(out.sims).length} simulators kept, ${Object.keys(out.leftOut).length} left out -> ${OUT}`);
    })
    .catch(e => {
      console.error(e.message);
      process.exit(1);
    });
}

module.exports = { SIMS, epBlock, parseWeights, percentScale, verdict };
