'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SIG = require('../bridge/signals');
const P = require('../bridge/protocol');
const CLI = require('../bridge/clients');

function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `claude-wow-signals-${name}-`));
  const addons = path.join(dir, 'Interface', 'AddOns');
  fs.mkdirSync(path.join(addons, 'ClaudeWoW'), { recursive: true });
  return { dir, addons };
}

const present = (addons, ring, k) => fs.existsSync(SIG.ringFile(addons, ring, k));
const presentRange = (addons, ring, from, to) => {
  const out = [];
  for (let k = from; k <= to; k++) out.push(present(addons, ring, k));
  return out;
};

test('preparePresence arms both rings, keeps the spent prefix of the current ring missing, and clears the old flat files', () => {
  const { dir, addons } = scratch('prepare');
  const flat = path.join(SIG.presenceDir(addons), '1981.wav');
  fs.mkdirSync(path.dirname(flat), { recursive: true });
  fs.writeFileSync(flat, 'RIFF');
  const first = SIG.preparePresence(addons, 1981, 10);
  assert.deepEqual(first.state, { ring: 'a', at: 0, switches: 0, probe: '' }, 'an old numeric counter starts a fresh ring');
  assert.equal(first.made, 20);
  assert.equal(first.removed, 1);
  assert.ok(!fs.existsSync(flat));
  const again = SIG.preparePresence(addons, { ring: 'b', at: 3 }, 10);
  assert.deepEqual(presentRange(addons, 'b', 1, 10), [false, false, false, true, true, true, true, true, true, true]);
  assert.deepEqual(presentRange(addons, 'a', 1, 10), Array(10).fill(true));
  assert.equal(again.removed, 3);
  assert.equal(again.made, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a beat deletes the next file of the current ring; a spent ring is armed again and the other ring takes over', () => {
  const { dir, addons } = scratch('beat');
  const st = SIG.preparePresence(addons, null, 3).state;
  assert.deepEqual(SIG.beat(addons, st, 3), { ring: 'a', k: 1, switched: '' });
  SIG.beat(addons, st, 3);
  SIG.beat(addons, st, 3);
  assert.deepEqual(presentRange(addons, 'a', 1, 3), [false, false, false]);
  assert.deepEqual(SIG.beat(addons, st, 3), { ring: 'b', k: 1, switched: 'a' });
  assert.deepEqual(presentRange(addons, 'a', 1, 3), [true, true, true], 'ring a is armed for the next game launch');
  assert.deepEqual(presentRange(addons, 'b', 1, 3), [false, true, true]);
  assert.equal(st.switches, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the news ring has its own folder and rings: armed like presence, fired one file per news, never touching presence', () => {
  const { dir, addons } = scratch('news');
  const newsAt = (ring, from, to) => {
    const out = [];
    for (let k = from; k <= to; k++) out.push(fs.existsSync(SIG.newsFile(addons, ring, k)));
    return out;
  };
  SIG.preparePresence(addons, null, 3);
  const st = SIG.prepareNews(addons, null, 3).state;
  assert.ok(SIG.newsFile(addons, 'a', 1).startsWith(SIG.newsDir(addons) + path.sep));
  assert.deepEqual(newsAt('a', 1, 3), [true, true, true]);
  assert.deepEqual(newsAt('b', 1, 3), [true, true, true]);
  assert.deepEqual(SIG.news(addons, st, 3), { ring: 'a', k: 1, switched: '' });
  assert.deepEqual(newsAt('a', 1, 3), [false, true, true]);
  assert.deepEqual(presentRange(addons, 'a', 1, 3), [true, true, true], 'news does not beat presence');
  SIG.news(addons, st, 3);
  SIG.news(addons, st, 3);
  assert.deepEqual(SIG.news(addons, st, 3), { ring: 'b', k: 1, switched: 'a' });
  assert.deepEqual(newsAt('a', 1, 3), [true, true, true], 'a spent news ring is armed again for the next launch');
  const again = SIG.prepareNews(addons, st, 3);
  assert.deepEqual(again.state.ring, 'b');
  assert.deepEqual(newsAt('b', 1, 3), [false, true, true], 'a bridge restart keeps the fired prefix missing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('prepareRuntime arms the news ring and carries its saved state', () => {
  const { dir, addons } = scratch('runtime-news');
  const r = SIG.prepareRuntime(addons, { slots: 1, actMax: 1, presenceMax: 2, newsMax: 2, news: { ring: 'b', at: 1 } });
  assert.deepEqual(r.news.state, { ring: 'b', at: 1, switches: 0, probe: '' });
  assert.ok(!fs.existsSync(SIG.newsFile(addons, 'b', 1)));
  assert.ok(fs.existsSync(SIG.newsFile(addons, 'b', 2)));
  assert.ok(fs.existsSync(SIG.newsFile(addons, 'a', 2)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('placeProbe keeps exactly one late-created probe file and refuses odd tokens', () => {
  const { dir, addons } = scratch('probe');
  assert.equal(SIG.placeProbe(addons, 'abc123'), true);
  assert.equal(SIG.placeProbe(addons, 'def456'), true);
  assert.ok(!fs.existsSync(SIG.probeFile(addons, 'abc123')));
  assert.ok(fs.existsSync(SIG.probeFile(addons, 'def456')));
  assert.equal(SIG.placeProbe(addons, '../x'), false);
  assert.equal(SIG.clearProbes(addons), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

function runInstallSlots(home) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bridge', 'install-slots.js')], {
    env: { ...process.env, CLAUDE_WOW_HOME: home },
    encoding: 'utf8',
  });
}

function installWorld(name, { state = {}, config = {} } = {}) {
  const { dir, addons } = scratch(name);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.toc'), '## Interface: 16001\n');
  fs.writeFileSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.lua'), 'ClaudeWoW = {}\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ addonDir: addons, slots: 3, actMax: 2, presenceMax: 5, ...config }));
  fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify(state));
  return { dir, addons, home };
}

function writeLegacySignals(addons) {
  const legacy = rel => path.join(addons, 'ClaudeWoW', ...rel.split('/'));
  for (const rel of ['ack/001.wav', 'sig/002.wav', 'act/001/01.wav', 'ctl/valid.wav', 'presence/a/0003.wav', 'presence/b/0001.wav']) {
    fs.mkdirSync(path.dirname(legacy(rel)), { recursive: true });
    fs.writeFileSync(legacy(rel), 'RIFF');
  }
}

test('prepareRuntime without removeLegacy (the bridge start) builds the runtime folder and leaves the old folders alone', () => {
  const { dir, addons } = installWorld('bridge-start');
  writeLegacySignals(addons);
  assert.equal(SIG.needsMigration(addons), true);
  const r = SIG.prepareRuntime(addons, { slots: 2, actMax: 1, presence: { ring: 'b', at: 1 }, presenceMax: 3 });
  assert.equal(r.legacy, 5);
  assert.equal(r.legacyRemoved, 0);
  assert.deepEqual(r.presence.state, { ring: 'b', at: 1, switches: 0, probe: '' });
  assert.deepEqual(presentRange(addons, 'b', 1, 3), [false, true, true]);
  assert.ok(fs.existsSync(path.join(addons, 'ClaudeWoW', 'ack', '001.wav')), 'a running game may still read the old files');
  assert.equal(SIG.needsMigration(addons), false, 'done once: the runtime folder has its valid.wav');
  assert.equal(SIG.removeLegacySignalFolders(addons), 5);
  assert.deepEqual(SIG.legacySignalFolders(addons), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the strip flags carry the self-test and the probe token; the slot file names the scheme and the ring', () => {
  const f = P.parseFlags('h;probe=0a1b2c3d;pt=failed;lc=unseen');
  assert.equal(f.hello, true);
  assert.equal(f.probe, '0a1b2c3d');
  assert.equal(f.presenceTest, 'failed');
  assert.equal(f.lateCreate, 'unseen');
  const bad = P.parseFlags('pt=maybe;lc=x;probe=../../x');
  assert.equal(bad.presenceTest, undefined);
  assert.equal(bad.lateCreate, undefined);
  assert.equal(bad.probe, undefined);
  const lua = P.luaTable('ClaudeWoW_SlotData', [], { presence: { scheme: SIG.SCHEME, ring: 'b', at: 12, n: 2000, probe: 'abcd' } });
  assert.match(lua, /\tsignals = "armed",/);
  assert.match(lua, /\tpresence = \{ ring = "b", at = 12, n = 2000, probe = "abcd" \},/);
  assert.doesNotMatch(P.luaTable('X', [], {}), /presence =/);
});

test("install-slots arms each client from its own ring: the old top-level ring is the first client's only", () => {
  const { dir } = scratch('two-clients');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dirs = ['_classic_beta_', '_classic_era_'].map(f => path.join(dir, f));
  const addonsOf = d => path.join(d, 'Interface', 'AddOns');
  for (const d of dirs) {
    fs.mkdirSync(path.join(addonsOf(d), 'ClaudeWoW'), { recursive: true });
    fs.writeFileSync(path.join(addonsOf(d), 'ClaudeWoW', 'ClaudeWoW.toc'), '## Interface: 16001\n');
  }
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ clients: dirs.map(d => ({ dir: d })), slots: 3, actMax: 2, presenceMax: 5 }));
  fs.writeFileSync(
    path.join(home, 'state.json'),
    JSON.stringify({ presence: { ring: 'b', at: 2 }, clients: { [CLI.keyOf(dirs[1])]: { presence: { ring: 'a', at: 4 } } } }),
  );
  const r = runInstallSlots(home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^_classic_beta_: presence: ring b at 2 of 5/m);
  assert.match(r.stdout, /^_classic_era_: presence: ring a at 4 of 5/m);
  assert.deepEqual(presentRange(addonsOf(dirs[0]), 'b', 1, 5), [false, false, true, true, true]);
  assert.deepEqual(presentRange(addonsOf(dirs[1]), 'a', 1, 5), [false, false, false, false, true]);
  assert.deepEqual(presentRange(addonsOf(dirs[1]), 'b', 1, 5), Array(5).fill(true), "the second client never takes the first one's ring");
  for (const d of dirs) assert.ok(fs.existsSync(SIG.signalFile(addonsOf(d), 'ack', 3)));
  fs.rmSync(dir, { recursive: true, force: true });
});
