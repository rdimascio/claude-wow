#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = 'wowsims/classic';
const HEAD = '7779ebbf79dc7f1341e6ab939b28a3402c9a730a';
const CUTOVER = '5634c852d47acfcc5b6b62a6472a536df64634dc';
const RAW = 'https://raw.githubusercontent.com';
const OUT = path.join(__dirname, '..', 'bridge', 'simweights.json');
const SOURCES = path.join(__dirname, '..', 'tests', 'fixtures', 'wowsims');
const LISTING = `https://api.github.com/repos/${REPO}/contents/ui?ref=${HEAD}`;
const NOT_SIMS = Object.freeze(['core', 'detailed_results', 'raid', 'scss', 'shared', 'worker']);
const NOT_ERA = Object.freeze({ warden_shaman: 'a Season of Discovery rune spec, not a Classic Era spec' });
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
  const body = text.slice(start).replace(/\/\/[^\n]*/g, '');
  let depth = 0;
  for (let i = OPEN.length - 1; i < body.length; i++) {
    if (body[i] === '(') depth++;
    if (body[i] === ')' && --depth === 0) return body.slice(OPEN.length, i);
  }
  throw new Error(`${where}: ${OPEN} never closes`);
}

function referenceOf(text, where) {
  const mentions = text.split('epReferenceStat').length - 1;
  if (mentions === 0) return null;
  const m = REFERENCE.exec(text);
  if (mentions !== 1 || !m) throw new Error(`${where}: epReferenceStat is not one plain Stat.X`);
  return m[1];
}

function percentScale(stats, reference) {
  const unit = reference && stats[reference] > 1 ? stats[reference] : 1;
  const values = SCALE_STATS.filter(k => stats[k] > 0).map(k => stats[k] / unit);
  return values.length ? Math.max(...values) : null;
}

function verdict(now, before, reference) {
  if (SCALE_STATS.every(k => now.stats[k] === before.stats[k])) return 'no hit or crit weight changed value since the Season of Discovery fork';
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

async function fetchFile(commit, file) {
  const url = `${RAW}/${REPO}/${commit}/${file}`;
  const res = await fetch(url, { redirect: 'error' });
  if (res.status !== 200) throw new Error(`${url}: HTTP ${res.status}`);
  return { url, text: await res.text() };
}

async function listSims() {
  const res = await fetch(LISTING, { redirect: 'error' });
  if (res.status !== 200) throw new Error(`${LISTING}: HTTP ${res.status}`);
  return (await res.json()).filter(e => e.type === 'dir').map(e => e.name);
}

async function build(read = fetchFile, list = listSims) {
  const unknown = (await list()).filter(d => !NOT_SIMS.includes(d) && !(d in SIMS) && !(d in NOT_ERA));
  if (unknown.length) throw new Error(`wowsims has simulators this script does not know: ${unknown.join(', ')}; add them to SIMS or NOT_ERA`);
  const license = (await read(HEAD, 'LICENSE')).text;
  if (!/^MIT License/.test(license)) throw new Error('the wowsims licence is no longer MIT');
  const sims = {};
  const leftOut = { ...NOT_ERA };
  const sources = {};
  for (const [sim, info] of Object.entries(SIMS)) {
    const [now, before] = await Promise.all([read(HEAD, `ui/${sim}/sim.ts`), read(CUTOVER, `ui/${sim}/sim.ts`)]);
    sources[`${HEAD}/${sim}`] = minimal(now.text, now.url);
    sources[`${CUTOVER}/${sim}`] = minimal(before.text, before.url);
    const weights = parseWeights(epBlock(now.text, now.url), now.url);
    const reference = referenceOf(now.text, now.url);
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
    baselineCommit: CUTOVER,
    level: 60,
    note: 'Stat weights (EP) from the wowsims Classic Era simulators, one per simulator, relative to the stat each simulator scales by (reference). A simulator is kept when a hit or crit weight changed value since the baseline commit, which holds the weights the Season of Discovery fork carried over, and its largest hit or crit weight is at least 3 reference points (the per-percent scale). class is the UnitClass token (ROGUE), trees are the talent tree names of an English client.',
    license: license.trim(),
    sims,
    leftOut,
    sources,
  };
}

function minimal(text, where) {
  const reference = referenceOf(text, where);
  return `${reference ? `epReferenceStat: Stat.${reference},\n` : ''}${OPEN}${epBlock(text, where)}),\n`;
}

if (require.main === module) {
  build()
    .then(({ sources, ...out }) => {
      fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
      fs.rmSync(SOURCES, { recursive: true, force: true });
      for (const [key, text] of Object.entries(sources)) {
        fs.mkdirSync(path.join(SOURCES, path.dirname(key)), { recursive: true });
        fs.writeFileSync(path.join(SOURCES, `${key}.ts`), text);
      }
      fs.writeFileSync(path.join(SOURCES, 'LICENSE'), out.license + '\n');
      console.log(`${Object.keys(out.sims).length} simulators kept, ${Object.keys(out.leftOut).length} left out -> ${OUT}`);
    })
    .catch(e => {
      console.error(e.message);
      process.exit(1);
    });
}

module.exports = { SIMS, NOT_SIMS, NOT_ERA, HEAD, CUTOVER, SOURCES, epBlock, parseWeights, referenceOf, percentScale, verdict, build };
