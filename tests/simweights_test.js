'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SW = require('../dev/simweights');
const WEIGHTS = require('../bridge/simweights.json');

const block = (stats, pseudo) => `\n\t\t\t{\n${stats}\n\t\t\t},\n${pseudo === undefined ? '' : `\t\t\t${pseudo}\n`}\t\t`;

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

test('a set is left out when every weight kept its SoD value or hit and crit sit on a per-rating scale', () => {
  const sod = { stats: { StatAgility: 2, StatMeleeHit: 20 } };
  assert.match(
    SW.verdict({ stats: { StatAgility: 2 } }, sod, 'StatAttackPower'),
    /unchanged since the Season of Discovery fork/,
    'a dropped stat is not a re-tune',
  );
  assert.equal(SW.verdict({ stats: { StatAgility: 2.5, StatMeleeHit: 20 } }, sod, 'StatAttackPower'), null);
  assert.match(SW.verdict({ stats: { StatAgility: 2.5, StatMeleeHit: 1.96, StatMeleeCrit: 1.16 } }, sod, 'StatAttackPower'), /per-rating scale/);
  assert.match(SW.verdict({ stats: { StatAgility: 2.5 } }, sod, 'StatAttackPower'), /no hit or crit weight/);
  assert.equal(SW.percentScale({ StatStamina: 4, StatMeleeHit: 20 }, 'StatStamina'), 5, 'divided by a reference stat worth more than 1');
  assert.equal(SW.percentScale({ StatStamina: 0.5, StatMeleeHit: 2 }, 'StatStamina'), 2, 'never inflated by a reference below 1');
});

test('the pinned weights file is MIT, at a pinned commit, and holds only checked simulators', () => {
  assert.match(WEIGHTS.license, /^MIT License/);
  assert.match(WEIGHTS.commit, /^[0-9a-f]{40}$/);
  assert.match(WEIGHTS.forkCommit, /^[0-9a-f]{40}$/);
  assert.equal(WEIGHTS.level, 60);
  const kept = Object.keys(WEIGHTS.sims);
  assert.ok(kept.length > 0);
  assert.deepEqual([...kept, ...Object.keys(WEIGHTS.leftOut)].sort(), Object.keys(SW.SIMS).sort(), 'every simulator is kept or left out with a reason');
  for (const [sim, s] of Object.entries(WEIGHTS.sims)) {
    assert.deepEqual([s.class, s.trees, s.role], [SW.SIMS[sim].class, SW.SIMS[sim].trees, SW.SIMS[sim].role], sim);
    assert.ok(s.source.includes(`/${WEIGHTS.commit}/ui/${sim}/sim.ts`), sim);
    for (const v of [...Object.values(s.stats), ...Object.values(s.pseudo)]) assert.ok(Number.isFinite(v), sim);
    assert.ok(SW.percentScale(s.stats, s.reference) >= 3, `${sim} is on the per-percent scale`);
  }
  assert.ok(WEIGHTS.sims.rogue, 'the rogue simulator was re-tuned for Era');
});
