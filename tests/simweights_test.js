'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SW = require('../dev/simweights');
const WEIGHTS = require('../bridge/simweights.json');

const block = (stats, pseudo) => `\n\t\t\t{\n${stats}\n\t\t\t},\n${pseudo === undefined ? '' : `\t\t\t${pseudo}\n`}\t\t`;
const allFolders = async () => [...Object.keys(SW.SIMS), ...SW.NOT_SIMS, ...Object.keys(SW.NOT_ERA)];

test('weights parse from the epWeights block, with source comments and an empty pseudo-stat map', () => {
  const text = `const x = { epWeights: Stats.fromMap(${block('\t[Stat.StatAgility]: 2.38,\n\t[Stat.StatMP5]: 0.05, // mana matters\n\t[Stat.StatMeleeHit]: 29.44,', '{\n[PseudoStat.PseudoStatMainHandDps]: 10.49,\n[PseudoStat.BonusPhysicalDamage]: 1,\n},')}), other: 1 };`;
  assert.deepEqual(SW.parseWeights(SW.epBlock(text, 't'), 't'), {
    stats: { StatAgility: 2.38, StatMP5: 0.05, StatMeleeHit: 29.44 },
    pseudo: { PseudoStatMainHandDps: 10.49, BonusPhysicalDamage: 1 },
  });
  assert.deepEqual(SW.parseWeights(block('[Stat.StatIntellect]: 1,', '{},'), 't'), { stats: { StatIntellect: 1 }, pseudo: {} });
  assert.deepEqual(SW.parseWeights(block('[Stat.StatIntellect]: 1,'), 't'), { stats: { StatIntellect: 1 }, pseudo: {} });
});

test('anything but plain weight lines is refused, so a layout change never yields wrong weights', () => {
  const refuse = (b, re) => assert.throws(() => SW.parseWeights(b, 't'), re);
  refuse(block('[Stat.StatAgility]: 2 * 3,'), /not a weight line/);
  refuse(block('[Stat.StatAgility]: 2,\n[Stat.StatAgility]: 3,'), /twice/);
  refuse(block('[PseudoStat.PseudoStatMainHandDps]: 2,'), /mixed up/);
  refuse(block('[Stat.StatAgility]: 2,', '{\n[Stat.StatStrength]: 1,\n},'), /mixed up/);
  refuse('[Stat.StatAgility]: 2,', /not a weight line/);
  refuse(`${block('[Stat.StatAgility]: 2,', '{},')}{},`, /expected a stat map/);
  assert.throws(() => SW.epBlock('epWeights: Stats.fromMap({}) epWeights: Stats.fromMap({})', 't'), /expected one/);
  assert.throws(() => SW.epBlock('epWeights: Stats.fromMap({', 't'), /never closes/);
});

test('a comment with a parenthesis keeps the second map, and a reference that is not one plain Stat.X fails', () => {
  const text = `epWeights: Stats.fromMap(\n{\n[Stat.StatAgility]: 2,\n}, // base weights :)\n{\n[PseudoStat.PseudoStatMainHandDps]: 10.49,\n},\n),`;
  assert.deepEqual(SW.parseWeights(SW.epBlock(text, 't'), 't').pseudo, { PseudoStatMainHandDps: 10.49 });
  assert.equal(SW.referenceOf('no reference here', 't'), null);
  assert.equal(SW.referenceOf('epReferenceStat: Stat.StatSpellPower,', 't'), 'StatSpellPower');
  assert.throws(() => SW.referenceOf('epReferenceStat: Stat.\nStatStamina,', 't'), /not one plain Stat\.X/);
  assert.throws(() => SW.referenceOf('epReferenceStat: Stat.StatStamina, epReferenceStat: Stat.StatArmor,', 't'), /not one plain Stat\.X/);
});

test('a set is left out when no hit or crit weight changed since the fork, or they sit on a per-rating scale', () => {
  const sod = { stats: { StatAgility: 2, StatMeleeHit: 20, StatFireResistance: 0.5 } };
  assert.match(
    SW.verdict({ stats: { StatAgility: 2, StatMeleeHit: 20 } }, sod, null),
    /no hit or crit weight changed value/,
    'a dropped stat is not a re-tune',
  );
  assert.match(
    SW.verdict({ stats: { StatAgility: 2 } }, sod, null),
    /no hit or crit weight to check/,
    'a set that dropped every hit and crit weight cannot be checked',
  );
  assert.match(
    SW.verdict({ stats: { StatAgility: 3, StatMeleeHit: 20, StatFireResistance: 0.01 } }, sod, null),
    /no hit or crit weight changed value/,
    'other weights changing is not a re-tune',
  );
  assert.equal(SW.verdict({ stats: { StatAgility: 2, StatMeleeHit: 29 } }, sod, null), null);
  assert.match(SW.verdict({ stats: { StatAgility: 2.5, StatMeleeHit: 1.96, StatMeleeCrit: 1.16 } }, sod, null), /per-rating scale/);
  assert.match(
    SW.verdict({ stats: { StatAgility: 2.5, StatSpellPower: 1 } }, { stats: { StatSpellPower: 1, StatSpellHit: 3 } }, null),
    /no hit or crit weight to check/,
  );
  assert.equal(SW.percentScale({ StatStamina: 4, StatMeleeHit: 20 }, 'StatStamina'), 5, 'divided by a reference stat worth more than 1');
  assert.equal(SW.percentScale({ StatStamina: 0.5, StatMeleeHit: 2 }, 'StatStamina'), 2, 'never inflated by a reference below 1');
});

test('build keeps a re-tuned per-percent set, leaves out the rest with reasons, and refuses a simulator it does not know', async () => {
  const sim = (stats, extra = '') =>
    `x = { ${extra} epWeights: Stats.fromMap(\n{\n${Object.entries(stats)
      .map(([k, v]) => `[Stat.${k}]: ${v},`)
      .join('\n')}\n},\n{\n[PseudoStat.PseudoStatMainHandDps]: 10.49,\n},\n), };`;
  const sod = sim({ StatAgility: 2, StatMeleeHit: 20, StatFireResistance: 0.5 });
  const files = {
    [`${SW.HEAD}:ui/rogue/sim.ts`]: sim({ StatAgility: 2.38, StatMeleeHit: 29.44 }, 'epReferenceStat: Stat.StatAttackPower,'),
    [`${SW.HEAD}:ui/mage/sim.ts`]: sim({ StatIntellect: 0.5, StatSpellHit: 1.2 }),
    [`${SW.HEAD}:ui/hunter/sim.ts`]: sim({ StatAgility: 3, StatMeleeHit: 20, StatFireResistance: 0.01 }),
  };
  const read = async (commit, file) => ({
    url: `https://raw.githubusercontent.com/wowsims/classic/${commit}/${file}`,
    text: file === 'LICENSE' ? 'MIT License\n\nCopyright (c) 2024 wowsims team' : files[`${commit}:${file}`] || sod,
  });
  const out = await SW.build(read, allFolders);
  assert.deepEqual(Object.keys(out.sims), ['rogue']);
  assert.deepEqual(out.sims.rogue.stats, { StatAgility: 2.38, StatMeleeHit: 29.44 });
  assert.deepEqual(out.sims.rogue.pseudo, { PseudoStatMainHandDps: 10.49 });
  assert.equal(out.sims.rogue.reference, 'StatAttackPower');
  assert.match(out.leftOut.mage, /per-rating scale/);
  assert.match(out.leftOut.warrior, /no hit or crit weight changed value/);
  assert.match(out.leftOut.hunter, /no hit or crit weight changed value/);
  assert.match(out.leftOut.warden_shaman, /Season of Discovery rune spec/);
  assert.equal(Object.keys(out.leftOut).length, Object.keys(SW.SIMS).length);
  await assert.rejects(
    SW.build(async (commit, file) => ({ url: file, text: file === 'LICENSE' ? 'GPL' : sod }), allFolders),
    /no longer MIT/,
  );
  await assert.rejects(
    SW.build(read, async () => [...(await allFolders()), 'paladin_tank_2']),
    /does not know: paladin_tank_2/,
  );
});

test('the pinned weights file is MIT, at a pinned commit, and holds only checked simulators', () => {
  assert.match(WEIGHTS.license, /^MIT License/);
  assert.match(WEIGHTS.commit, /^[0-9a-f]{40}$/);
  assert.match(WEIGHTS.baselineCommit, /^[0-9a-f]{40}$/);
  assert.equal(WEIGHTS.level, 60);
  assert.deepEqual(
    [...Object.keys(WEIGHTS.sims), ...Object.keys(WEIGHTS.leftOut)].sort(),
    [...Object.keys(SW.SIMS), ...Object.keys(SW.NOT_ERA)].sort(),
    'every simulator is kept or left out with a reason',
  );
  for (const [sim, s] of Object.entries(WEIGHTS.sims)) {
    assert.deepEqual([s.class, s.trees, s.role], [SW.SIMS[sim].class, SW.SIMS[sim].trees, SW.SIMS[sim].role], sim);
    assert.ok(s.source.includes(`/${WEIGHTS.commit}/ui/${sim}/sim.ts`), sim);
    assert.ok(s.reference === null || s.reference in s.stats, `${sim} has a weight for its reference stat`);
  }
  assert.ok(WEIGHTS.sims.rogue, 'the rogue simulator was re-tuned for Era');
});

test('the pinned file is exactly what the generator builds from the saved wowsims sources', async () => {
  const read = async (commit, file) => {
    const local = file === 'LICENSE' ? path.join(SW.SOURCES, 'LICENSE') : path.join(SW.SOURCES, commit, `${file.split('/')[1]}.ts`);
    return { url: `https://raw.githubusercontent.com/wowsims/classic/${commit}/${file}`, text: fs.readFileSync(local, 'utf8') };
  };
  const { sources, ...out } = await SW.build(read, allFolders);
  assert.deepEqual(out, WEIGHTS);
  assert.equal(Object.keys(sources).length, 2 * Object.keys(SW.SIMS).length);
});
