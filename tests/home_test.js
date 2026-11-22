// bridge/home.js: where config.json, state.json, transcripts.json and the log
// live. WOWGPT_HOME wins, then ~/.wowgpt once it has a config, then the
// old layout (bridge/ in the checkout) while that has one, else ~/.wowgpt.
// setup.js copies the old layout into ~/.wowgpt once, never into an
// explicit WOWGPT_HOME.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../bridge/home');

function scratch(name) {
  const dir = path.join(os.tmpdir(), `wowgpt-home-${name}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('resolution order: WOWGPT_HOME, ~/.wowgpt with a config, the legacy bridge/ with a config, ~/.wowgpt', () => {
  const home = scratch('res');
  const legacy = path.join(home, 'checkout', 'bridge');
  fs.mkdirSync(legacy, { recursive: true });
  const dflt = path.join(home, '.wowgpt');

  // Nothing anywhere: the default, and every file under it.
  let r = H.resolve({}, home, legacy);
  assert.equal(r.dir, dflt);
  assert.equal(r.source, 'default');
  assert.equal(r.config, path.join(dflt, 'config.json'));
  assert.equal(r.state, path.join(dflt, 'state.json'));
  assert.equal(r.transcripts, path.join(dflt, 'transcripts.json'));
  assert.equal(r.log, path.join(dflt, 'bridge.log'));
  assert.equal(r.tmp, path.join(dflt, 'tmp'));
  assert.equal(r.mapjobs, path.join(dflt, 'mapjobs'));
  assert.equal(r.uijobs, path.join(dflt, 'uijobs'));
  assert.equal(r.goals, path.join(dflt, 'goals'));
  assert.equal(r.data, path.join(dflt, 'data'));

  // The old layout: a config next to the code is used as long as the default has none.
  fs.writeFileSync(path.join(legacy, 'config.json'), '{}');
  r = H.resolve({}, home, legacy);
  assert.equal(r.dir, legacy);
  assert.equal(r.source, 'legacy');

  // Once ~/.wowgpt has a config it wins over the old layout.
  fs.mkdirSync(dflt, { recursive: true });
  fs.writeFileSync(path.join(dflt, 'config.json'), '{}');
  r = H.resolve({}, home, legacy);
  assert.equal(r.dir, dflt);
  assert.equal(r.source, 'default');

  // The variable beats both, with or without a config there, and ~ expands.
  const custom = path.join(home, 'elsewhere');
  r = H.resolve({ WOWGPT_HOME: custom }, home, legacy);
  assert.equal(r.dir, custom);
  assert.equal(r.source, 'WOWGPT_HOME');
  assert.equal(H.resolve({ WOWGPT_HOME: '~/cw' }, home, legacy).dir, path.join(home, 'cw'));
  assert.equal(H.resolve({ WOWGPT_HOME: '' }, home, legacy).dir, dflt, 'empty means unset');

  // A config.json that is a folder does not count.
  fs.rmSync(path.join(dflt, 'config.json'));
  fs.mkdirSync(path.join(dflt, 'config.json'));
  assert.equal(H.resolve({}, home, legacy).source, 'legacy');
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrateLegacy copies config, state and transcripts into ~/.wowgpt once, and leaves the originals', () => {
  const home = scratch('mig');
  const legacy = path.join(home, 'checkout', 'bridge');
  fs.mkdirSync(legacy, { recursive: true });
  const dflt = path.join(home, '.wowgpt');

  assert.deepEqual(H.migrateLegacy({}, home, legacy), [], 'nothing to migrate');
  assert.ok(!fs.existsSync(dflt), 'and nothing is created for it');

  fs.writeFileSync(path.join(legacy, 'config.json'), '{"addonDir":"/x"}');
  fs.writeFileSync(path.join(legacy, 'state.json'), '{"sessions":{"c1":{"id":"s1"}}}');
  fs.writeFileSync(path.join(legacy, 'bridge.log'), 'old log\n'); // not carried
  // No transcripts.json: only what exists is copied.
  assert.deepEqual(H.migrateLegacy({}, home, legacy), ['config.json', 'state.json']);
  assert.equal(fs.readFileSync(path.join(dflt, 'config.json'), 'utf8'), '{"addonDir":"/x"}');
  assert.equal(fs.readFileSync(path.join(dflt, 'state.json'), 'utf8'), '{"sessions":{"c1":{"id":"s1"}}}', 'the sessions came across');
  assert.ok(!fs.existsSync(path.join(dflt, 'bridge.log')));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dflt).mode & 0o777, 0o700, 'the new home is private');
    for (const f of ['config.json', 'state.json']) assert.equal(fs.statSync(path.join(dflt, f)).mode & 0o777, 0o600, `${f} is private`);
  }
  assert.ok(fs.existsSync(path.join(legacy, 'config.json')) && fs.existsSync(path.join(legacy, 'state.json')), 'originals stay');
  assert.equal(H.resolve({}, home, legacy).dir, dflt, 'from now on the default is the home');

  // A second run does nothing: the home's files are not overwritten.
  fs.writeFileSync(path.join(dflt, 'state.json'), '{"sessions":{"c1":{"id":"s2"}}}');
  assert.deepEqual(H.migrateLegacy({}, home, legacy), []);
  assert.equal(fs.readFileSync(path.join(dflt, 'state.json'), 'utf8'), '{"sessions":{"c1":{"id":"s2"}}}');

  // An explicit WOWGPT_HOME is never filled from the old layout.
  const custom = path.join(home, 'custom');
  assert.deepEqual(H.migrateLegacy({ WOWGPT_HOME: custom }, home, legacy), []);
  assert.ok(!fs.existsSync(custom));
  fs.rmSync(home, { recursive: true, force: true });
});

// The rename to WoWGPT: CLAUDE_WOW_HOME still names a home, and ~/.claude-wow
// (the old home) is used until setup has copied it to ~/.wowgpt.
test('the old names: CLAUDE_WOW_HOME when WOWGPT_HOME is unset, then ~/.claude-wow with a config before the legacy bridge/', () => {
  const home = scratch('oldnames');
  const legacy = path.join(home, 'checkout', 'bridge');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'config.json'), '{}');
  const old = path.join(home, '.claude-wow');
  const dflt = path.join(home, '.wowgpt');

  const named = path.join(home, 'named');
  const byOld = H.resolve({ CLAUDE_WOW_HOME: named }, home, legacy);
  assert.deepEqual([byOld.dir, byOld.source], [named, 'WOWGPT_HOME']);
  assert.equal(H.resolve({ WOWGPT_HOME: dflt, CLAUDE_WOW_HOME: named }, home, legacy).dir, dflt, 'the new name wins');

  fs.mkdirSync(old, { recursive: true });
  assert.equal(H.resolve({}, home, legacy).source, 'legacy', 'an old home without a config does not count');
  fs.writeFileSync(path.join(old, 'config.json'), '{}');
  const r = H.resolve({}, home, legacy);
  assert.deepEqual([r.dir, r.source], [old, 'old-name']);
  fs.mkdirSync(dflt, { recursive: true });
  fs.writeFileSync(path.join(dflt, 'config.json'), '{}');
  assert.equal(H.resolve({}, home, legacy).dir, dflt, 'the new home wins once it has a config');
  fs.rmSync(home, { recursive: true, force: true });
});

test('migrateOldHome copies ~/.claude-wow to ~/.wowgpt once, without releases, locks, the live socket or tmp, and keeps the original', () => {
  const home = scratch('oldhome');
  const old = path.join(home, '.claude-wow');
  const dflt = path.join(home, '.wowgpt');
  assert.equal(H.migrateOldHome({}, home), null, 'no old home: nothing to do');
  const files = {
    'config.json': '{"agent":"claude"}',
    'state.json': '{"sessions":{"c1":"s1"}}',
    'transcripts.json': '{}',
    'agent-contract.json': '{}',
    'goals/Thrall-Realm/goals.json': '[]',
    'data/classic_era/1.15.9/Map.csv': 'ID\n1\n',
    'releases/0.5.0-abc/claude-wow': 'bin',
    'tmp/prompt.txt': 'x',
    'bridge.lock': '1',
    'live.token': 't',
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(old, rel)), { recursive: true });
    fs.writeFileSync(path.join(old, rel), body);
  }
  if (process.platform !== 'win32') fs.symlinkSync(path.join('releases', '0.5.0-abc'), path.join(old, 'current'));

  const r = H.migrateOldHome({}, home);
  assert.equal(r.from, old);
  assert.deepEqual(r.copied, ['agent-contract.json', 'config.json', 'data', 'goals', 'state.json', 'transcripts.json']);
  for (const rel of [
    'config.json',
    'state.json',
    'transcripts.json',
    'agent-contract.json',
    'goals/Thrall-Realm/goals.json',
    'data/classic_era/1.15.9/Map.csv',
  ])
    assert.equal(fs.readFileSync(path.join(dflt, rel), 'utf8'), files[rel], rel);
  for (const rel of ['releases', 'current', 'tmp', 'bridge.lock', 'live.token']) assert.ok(!fs.existsSync(path.join(dflt, rel)), `${rel} is not copied`);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dflt).mode & 0o777, H.PRIVATE_DIR_MODE);
    assert.equal(fs.statSync(path.join(dflt, 'state.json')).mode & 0o777, H.PRIVATE_FILE_MODE);
  }
  assert.equal(fs.readFileSync(path.join(old, 'config.json'), 'utf8'), files['config.json'], 'the old home is kept');
  assert.equal(H.resolve({}, home, '').dir, dflt);

  fs.writeFileSync(path.join(old, 'state.json'), '{"sessions":{}}');
  assert.equal(H.migrateOldHome({}, home), null, 'once the new home has a config, never again');
  assert.equal(fs.readFileSync(path.join(dflt, 'state.json'), 'utf8'), files['state.json']);
  fs.rmSync(dflt, { recursive: true, force: true });
  assert.equal(H.migrateOldHome({ WOWGPT_HOME: path.join(home, 'x') }, home), null, 'never into a home named in the environment');
  assert.equal(H.migrateOldHome({ CLAUDE_WOW_HOME: path.join(home, 'x') }, home), null, 'nor one named by the old variable');
  fs.rmSync(home, { recursive: true, force: true });
});

test('guardedDirs: the home in use and every old home still on disk, each by its real path too', () => {
  const home = scratch('guard');
  const current = path.join(home, '.wowgpt');
  fs.mkdirSync(current, { recursive: true });
  assert.deepEqual(
    H.guardedDirs(current, home),
    [current, fs.realpathSync(current)].filter((d, i, a) => a.indexOf(d) === i),
    'no old home: only the current one',
  );
  const old = path.join(home, '.claude-wow');
  fs.mkdirSync(old, { recursive: true });
  const dirs = H.guardedDirs(current, home);
  assert.ok(dirs.includes(old) && dirs.includes(fs.realpathSync(old)), 'an old home without a config is still guarded');
  if (process.platform !== 'win32') {
    const linked = path.join(home, 'linked-home');
    fs.symlinkSync(current, linked);
    assert.ok(H.guardedDirs(linked, home).includes(fs.realpathSync(current)), 'a symlinked home by its real path');
  }
  fs.rmSync(home, { recursive: true, force: true });
});
