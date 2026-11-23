// setup.js from a new user's side: the project folder a fresh config gets, the
// refusal while the game runs, the agent it picks, the background service it
// installs or reinstalls, and the command its last lines name. Every run is a
// real setup.js child; tests/fixtures/fake-setup-os.js stands in for the
// process list and the service backend, so nothing reaches launchctl,
// systemctl or the Startup folder.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SB = require('../dev/sandbox');
const S = require('../setup.js');
const SVC = require('../bridge/service');

const SETUP = path.join(__dirname, '..', 'setup.js');
const FAKE_OS = path.join(__dirname, 'fixtures', 'fake-setup-os.js');
const PRELOAD = typeof Bun !== 'undefined' ? '--preload' : '--require';
const POSIX = process.platform !== 'win32';
const SMALL_POOL = 5;

function scratch(name) {
  const dir = path.join(os.tmpdir(), `wowgpt-setupflow-${name}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function fakeClient(dir) {
  const client = path.join(dir, 'client');
  fs.mkdirSync(path.join(client, 'Interface', 'AddOns'), { recursive: true });
  fs.writeFileSync(path.join(client, 'World of Warcraft.app'), '');
  const saved = path.join(client, 'WTF', 'Account', 'ACCT', 'SavedVariables');
  fs.mkdirSync(saved, { recursive: true });
  fs.writeFileSync(path.join(saved, 'ClaudeWoW.lua'), 'ClaudeWoWDB = {\n["token"] = "t",\n}\n');
  return { client, saved, addons: path.join(client, 'Interface', 'AddOns') };
}

// An existing config with a small slot pool, so a run takes a second.
function existingConfig(dir, client, patch = {}) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const project = path.join(dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bridge', 'config.example.json'), 'utf8'));
  const cfg = { ...example, slots: SMALL_POOL, defaultCwd: project, clients: [{ dir: client, account: 'ACCT' }], ...patch };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
  return { home, project };
}

// A folder of programs that only need to exist: agent lookups and the PATH
// check look for a file of that name (with .exe on Windows).
function fakeBin(dir, names) {
  const bin = path.join(dir, `bin-${names.join('-') || 'none'}`);
  fs.mkdirSync(bin, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(bin, POSIX ? n : `${n}.exe`), '#!/bin/sh\necho "fake 1.0.0"\nexit 0\n', { mode: 0o755 });
  return bin;
}

// Always with --wow: without it setup also adds every client it finds in the
// usual places, and a test must never write into a real game folder.
function runSetup(dir, args, { state = 'closed', env = {}, cwd } = {}) {
  const named = args.includes('--wow') ? args : ['--wow', path.join(dir, 'client'), ...args];
  const log = path.join(dir, 'os.log');
  fs.writeFileSync(log, '');
  const user = path.join(dir, 'user');
  // PATH holds only a fake Claude unless a test names its own, so no run sees
  // the agents of the machine the tests run on.
  const full = SB.isolatedEnv(user, {
    WOWGPT_HOME: path.join(dir, 'home'),
    WOWGPT_FAKE_CLIENT_STATE: state,
    WOWGPT_FAKE_SERVICE_LOG: log,
    PATH: fakeBin(dir, ['claude']),
    ...env,
  });
  const r = spawnSync(process.execPath, [PRELOAD, FAKE_OS, SETUP, ...named], { encoding: 'utf8', env: full, cwd: cwd || dir, timeout: 120000 });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.deepEqual(
    out.split('\n').filter(l => l.startsWith('client   : ')),
    r.status === 0 ? [`client   : ${path.join(dir, 'client')}`] : [],
    'only the fake client is touched',
  );
  return { status: r.status, out, log: fs.readFileSync(log, 'utf8'), user };
}

const readCfg = dir => JSON.parse(fs.readFileSync(path.join(dir, 'home', 'config.json'), 'utf8'));

test('a fresh config gets ~/wowgpt as its project, never the folder setup runs in, and --project refuses the home folder and the disk root', () => {
  const dir = scratch('project');
  const { addons } = fakeClient(dir);
  const user = path.join(dir, 'user');
  fs.mkdirSync(user, { recursive: true });

  for (const bad of [user, '~', path.parse(dir).root]) {
    const r = runSetup(dir, ['--project', bad, '--no-service'], { cwd: user });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /setup failed: --project ".*" is your home folder or a disk root/);
    assert.equal(r.log, '', `${bad}: refused before anything else ran`);
    assert.ok(!fs.existsSync(path.join(addons, 'WoWGPT')), 'nothing installed');
    assert.ok(!fs.existsSync(path.join(dir, 'home', 'config.json')));
  }

  const r = runSetup(dir, ['--no-service'], { cwd: user });
  assert.equal(r.status, 0, r.out);
  assert.match(r.log, /^clientState /m, 'the fake process list was loaded');
  const project = path.join(user, 'wowgpt');
  assert.equal(readCfg(dir).defaultCwd, project, 'not the folder setup ran in');
  assert.ok(fs.statSync(project).isDirectory(), 'made for it');
  assert.ok(!/default project folder is your home folder/.test(r.out));
});

test('an existing config keeps a home-folder project, and setup warns about it', () => {
  const dir = scratch('homeproject');
  const { client } = fakeClient(dir);
  const user = path.join(dir, 'user');
  fs.mkdirSync(user, { recursive: true });
  existingConfig(dir, client, { defaultCwd: user });
  const r = runSetup(dir, ['--no-service']);
  assert.equal(r.status, 0, r.out);
  assert.equal(readCfg(dir).defaultCwd, user, 'kept');
  assert.match(r.out, /^warning {2}: the default project folder is your home folder or a disk root \(.*\), so an agent may edit any file there$/m);
  assert.match(r.out, /-> Give the agents a folder of their own: .* setup --project .*wowgpt/);
});

test('setup refuses to run while the client runs, before it copies saved chats or removes old signal folders; "cannot tell" warns and goes on', () => {
  const dir = scratch('running');
  const { client, saved, addons } = fakeClient(dir);
  existingConfig(dir, client);
  const legacySignal = path.join(addons, 'WoWGPT', 'ack', '001.wav');
  fs.mkdirSync(path.dirname(legacySignal), { recursive: true });
  fs.writeFileSync(legacySignal, 'RIFF');

  const running = runSetup(dir, ['--no-service'], { state: 'running' });
  assert.equal(running.status, 1, running.out);
  assert.match(running.out, /^setup failed: .* is running\. Quit World of Warcraft, then run setup again\.$/m);
  assert.match(running.log, new RegExp('^clientState ' + client.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'));
  assert.ok(!fs.existsSync(path.join(saved, 'WoWGPT.lua')), 'the saved chats were not copied');
  assert.ok(fs.existsSync(legacySignal), 'the old signal folder is still there');
  assert.ok(!fs.existsSync(path.join(addons, 'WoWGPT_Runtime')), 'no slot pool built');

  const unknown = runSetup(dir, ['--no-service'], { state: 'unknown' });
  assert.equal(unknown.status, 0, unknown.out);
  assert.match(unknown.out, /^warning {2}: could not tell whether .* is running \(the process list failed \(fake\)\)$/m);
  assert.ok(fs.existsSync(path.join(saved, 'WoWGPT.lua')), 'it went on');
  assert.ok(!fs.existsSync(legacySignal));
});

test('the default agent must be installed: the only installed one takes over, none at all is "not ready" and installs no service', () => {
  const dir = scratch('agents');
  const { client } = fakeClient(dir);
  existingConfig(dir, client, { agent: 'claude' });

  const onlyCodex = runSetup(dir, ['--no-service'], { env: { PATH: fakeBin(dir, ['codex']) } });
  assert.equal(onlyCodex.status, 0, onlyCodex.out);
  assert.match(onlyCodex.out, /^agent {4}: Claude is not installed and Codex is, so codex is the default agent now$/m);
  assert.equal(readCfg(dir).agent, 'codex');
  assert.doesNotMatch(onlyCodex.out, /^claude {3}: run `claude` once/m, 'no Claude login hint for Codex');

  const none = runSetup(dir, ['--service'], { env: { PATH: fakeBin(dir, []) } });
  assert.equal(none.status, 0, none.out);
  assert.match(none.out, /^agent {4}: not ready: install one agent/m);
  assert.match(none.out, /^warning {2}: the background service was not installed, because no agent is installed$/m);
  assert.ok(!/^install /m.test(none.log), 'no service');
  assert.match(none.out, /^Not ready yet\. Next:$/m);
  assert.match(none.out, /^ {2}3\. Install one agent/m);

  const claude = runSetup(dir, ['--no-service'], { env: { PATH: fakeBin(dir, ['claude', 'codex']) } });
  assert.equal(claude.status, 0, claude.out);
  assert.equal(readCfg(dir).agent, 'codex', 'an installed default is kept');
  fs.writeFileSync(path.join(dir, 'home', 'config.json'), JSON.stringify({ ...readCfg(dir), agent: 'claude' }));
  const login = runSetup(dir, ['--no-service'], { env: { PATH: fakeBin(dir, ['claude']) } });
  assert.match(login.out, /^claude {3}: run `claude` once in a terminal and log in/m);
});

test('chooseService: an existing service is reinstalled without asking; only a fresh install asks, and Enter is yes', () => {
  const never = () => assert.fail('nobody is asked');
  const old = ['/x/io.claudewow.bridge.plist'];
  assert.equal(S.chooseService({ existing: old, interactive: false, ask: never }), 'reinstall');
  assert.equal(S.chooseService({ existing: old, interactive: true, ask: never }), 'reinstall');
  assert.equal(S.chooseService({ said: true, existing: old, interactive: false, ask: never }), 'reinstall');
  assert.equal(S.chooseService({ skip: true, existing: old, interactive: true, ask: never }), 'skip', '--no-service');
  assert.equal(S.chooseService({ said: false, existing: old, interactive: true, ask: never }), 'skip', '--service no');
  assert.equal(S.chooseService({ said: true, existing: [], interactive: false, ask: never }), 'install');
  assert.equal(S.chooseService({ existing: [], interactive: false, ask: never }), 'skip', 'nobody to ask');
  const asked = [];
  const answer = reply => q => (asked.push(q), reply);
  assert.equal(S.chooseService({ existing: [], interactive: true, ask: answer('') }), 'install', 'Enter alone is yes');
  assert.equal(S.chooseService({ existing: [], interactive: true, ask: answer('Y') }), 'install');
  assert.equal(S.chooseService({ existing: [], interactive: true, ask: answer('n') }), 'skip');
  assert.ok(asked.length === 3 && asked.every(q => q === S.SERVICE_QUESTION));
  assert.match(S.SERVICE_QUESTION, /\[Y\/n\] $/);
});

test('setup reinstalls a service left by an old name without asking, installs one with --service, and its last lines say what it did', () => {
  const dir = scratch('service');
  const { client } = fakeClient(dir);
  existingConfig(dir, client);
  const user = path.join(dir, 'user');
  const env = SB.isolatedEnv(user);
  const [oldService] = SVC.oldDirs(process.platform, env, user);
  const agentPath = { PATH: fakeBin(dir, ['claude']) };

  const fresh = runSetup(dir, [], { env: agentPath });
  assert.equal(fresh.status, 0, fresh.out);
  assert.ok(!/^install /m.test(fresh.log), 'a fresh, non-interactive install asks nobody and installs nothing');
  assert.match(fresh.out, /^service {2}: not installed \(install it later with: .* service install\)$/m);
  assert.match(fresh.out, /^ {2}3\. Start the bridge: {2}/m);

  fs.mkdirSync(path.dirname(oldService.definition), { recursive: true });
  fs.writeFileSync(oldService.definition, 'old');
  const upgrade = runSetup(dir, [], { env: agentPath });
  assert.equal(upgrade.status, 0, upgrade.out);
  assert.match(upgrade.out, /^service {2}: reinstalling the background service, so it runs this version$/m);
  assert.match(upgrade.log, /^install /m);
  assert.match(upgrade.out, /^ {2}3\. The bridge runs in the background\. Check it with: {2}.* service status$/m);

  const skipped = runSetup(dir, ['--no-service'], { env: agentPath });
  assert.ok(!/^install /m.test(skipped.log), '--no-service leaves it alone');
  fs.unlinkSync(oldService.definition);
  const asked = runSetup(dir, ['--service'], { env: agentPath });
  assert.match(asked.log, /^install /m);
  assert.match(asked.out, /^service {2}: installing the background service$/m);

  const bad = runSetup(dir, ['--service', 'maybe']);
  assert.equal(bad.status, 1, bad.out);
  assert.match(bad.out, /setup failed: --service takes yes or no, not "maybe"/);
  assert.equal(bad.log, '', 'refused before anything else ran');
});

test('the last lines name npm start only for node setup.js in a git checkout; otherwise wowgpt, or its full path when it is not on the PATH', () => {
  const dir = scratch('command');
  const { client } = fakeClient(dir);
  existingConfig(dir, client);
  const startLine = r => {
    const m = /^ {2}3\. Start the bridge: {2}(.*?) {3}\(/m.exec(r.out);
    assert.ok(m, r.out);
    return m[1];
  };

  assert.ok(fs.existsSync(path.join(__dirname, '..', '.git')), 'this suite runs from a checkout');
  assert.equal(startLine(runSetup(dir, ['--no-service'])), 'npm start');

  const withCommand = runSetup(dir, ['--no-service'], {
    env: { WOWGPT_FROM_COMMAND: '1', PATH: [fakeBin(dir, ['wowgpt']), fakeBin(dir, ['claude'])].join(path.delimiter) },
  });
  assert.equal(startLine(withCommand), 'wowgpt');

  const agentOnly = fakeBin(dir, ['claude']);
  const offPath = runSetup(dir, ['--no-service'], {
    env: { WOWGPT_FROM_COMMAND: '1', PATH: [agentOnly, path.dirname(process.execPath)].join(path.delimiter) },
  });
  assert.equal(startLine(offPath), `"${process.execPath}" "${path.join(__dirname, '..', 'bridge', 'supervisor.js')}"`);
  assert.match(offPath.out, new RegExp(`service install\\)$`, 'm'));
});
