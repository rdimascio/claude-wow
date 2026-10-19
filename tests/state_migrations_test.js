'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SHAPES, migrateShape } = require('./lua/state');

const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'state_migrations.json');
const WRITE = process.env.STATE_MIGRATIONS_WRITE;

const canonical = value => JSON.stringify(value);

function expected() {
  return JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
}

test('state migrations: the fixture lists every shape', () => {
  if (WRITE) {
    const out = {};
    for (const [name, shape] of Object.entries(SHAPES)) out[name] = { saved: shape.saved, own: shape.own || null, ...migrateShape(shape) };
    fs.writeFileSync(WRITE, JSON.stringify(out, null, 2) + '\n');
    return;
  }
  const fixture = expected();
  assert.deepEqual(Object.keys(fixture), Object.keys(SHAPES), 'the fixture and the shape table list the same shapes in the same order');
  assert.ok(Object.keys(SHAPES).length >= 25, 'at least 25 historical shapes');
  for (const [name, shape] of Object.entries(SHAPES)) {
    assert.equal(fixture[name].saved, shape.saved, `${name}: the fixture was made from this saved shape`);
    assert.equal(fixture[name].own, shape.own || null, `${name}: the fixture was made from this per-character shape`);
  }
});

for (const [name, shape] of Object.entries(SHAPES)) {
  test(`state migrations: ${name}`, { skip: Boolean(WRITE) }, () => {
    const fixture = expected()[name];
    const { after, again } = migrateShape(shape);
    assert.equal(canonical(after), canonical(fixture.after), `${name}: InitDB reproduces the fixture byte for byte`);
    assert.equal(canonical(again), canonical(fixture.again), `${name}: a second InitDB reproduces the fixture byte for byte`);
    assert.equal(canonical(again), canonical(after), `${name}: a second InitDB changes nothing`);
  });
}
