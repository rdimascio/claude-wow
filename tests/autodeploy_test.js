'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn: realSpawn } = require('child_process');
const AD = require('../bridge/autodeploy');
const REL = require('../bridge/releases');

const WINDOWS = process.platform === 'win32';

function scratch(name) {
  const dir = path.join(__dirname, 'tmp', 'autodeploy', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function repos(root) {
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(root, 'clone', '-q', origin, work);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'one');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  git(root, 'clone', '-q', origin, repo);
  const push = text => {
    fs.writeFileSync(path.join(work, 'a.txt'), text);
    git(work, 'commit', '-q', '-am', text);
    git(work, 'push', '-q', 'origin', 'HEAD:main');
    return git(work, 'rev-parse', 'HEAD');
  };
  return { repo, push, head: () => git(work, 'rev-parse', 'HEAD') };
}

function rig(name, { spawn } = {}) {
  const root = scratch(name);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const r = repos(root);
  const spawned = [];
  const logs = [];
  const state = { busy: false };
  const ad = AD.createAutoDeploy({
    conf: { enabled: true, repo: r.repo, ref: 'origin/main' },
    home,
    log: line => logs.push(line),
    idle: () => (state.busy ? { idle: false, reason: 'busy' } : { idle: true }),
    spawn:
      spawn ||
      ((file, args, opts) => {
        spawned.push({ file, args, opts });
        return { on() {}, unref() {} };
      }),
  });
  const saved = () => JSON.parse(fs.readFileSync(path.join(home, AD.STATE_FILE), 'utf8'));
  return { ...r, home, spawned, logs, state, ad, saved };
}

function devRelease(home, name, info) {
  const l = REL.layout(home);
  fs.mkdirSync(REL.releaseDir(l, name), { recursive: true });
  fs.writeFileSync(REL.releaseBinary(l, name), '');
  fs.writeFileSync(path.join(REL.releaseDir(l, name), 'release.json'), JSON.stringify({ name, complete: true, ...info }));
  fs.rmSync(l.current, { force: true });
  fs.symlinkSync(path.join('releases', name), l.current);
}

test('settings: off unless autoDeploy names a repo, origin/<branch> refs only, folders resolve like chat folders', () => {
  const base = path.join(os.tmpdir(), 'ad-base');
  assert.deepEqual(AD.settings({}, base), { enabled: false });
  assert.deepEqual(AD.settings({ autoDeploy: null }, base), { enabled: false });
  assert.deepEqual(AD.settings({ autoDeploy: false }, base), { enabled: false });
  assert.deepEqual(AD.settings({ autoDeploy: { repo: 'wow-ai' } }, base), { enabled: true, repo: path.join(base, 'wow-ai'), ref: 'origin/main' });
  assert.equal(AD.settings({ autoDeploy: { repo: '~/wow-ai' } }, base).repo, path.join(os.homedir(), 'wow-ai'));
  assert.equal(AD.settings({ autoDeploy: { repo: 'r', ref: 'origin/release/1.x' } }, base).ref, 'origin/release/1.x');
  for (const bad of ['~/wow-ai', true, [], {}, { repo: '' }, { repo: 3 }]) {
    const s = AD.settings({ autoDeploy: bad }, base);
    assert.equal(s.enabled, false, JSON.stringify(bad));
    assert.match(s.error, /autoDeploy needs/, JSON.stringify(bad));
  }
  for (const ref of ['main', 'upstream/main', 'origin/', 'origin/a..b', 'origin/-x', 'origin/$(x)']) {
    const s = AD.settings({ autoDeploy: { repo: 'r', ref } }, base);
    assert.equal(s.enabled, false, ref);
    assert.match(s.error, /is not origin\/<branch>/, ref);
  }
});

test('eligible: only the macOS service that runs a complete dev-deploy release through current', { skip: WINDOWS }, () => {
  const home = scratch('eligible');
  const plist = path.join(home, 'io.claudewow.bridge.plist');
  fs.writeFileSync(plist, `<string>${REL.currentBinary(REL.layout(home))}</string>`);
  const service = { CLAUDE_WOW_SERVICE: '1', CLAUDE_WOW_SUPERVISED: '1' };
  const ok = (over = {}) => AD.eligible({ home, platform: 'darwin', compiled: true, env: service, definitionFile: plist, ...over });
  assert.match(ok().why, /does not run a release made by claude-wow dev deploy/, 'no current release');
  devRelease(home, '0.5.0-aaaaaaaaaaaa', { source: 'dev-deploy', sha: 'a'.repeat(40) });
  assert.deepEqual(ok(), { ok: true });
  assert.match(ok({ platform: 'linux' }).why, /macOS only/);
  assert.match(ok({ compiled: false }).why, /background service/);
  assert.match(ok({ env: { CLAUDE_WOW_SUPERVISED: '1' } }).why, /background service/, 'a terminal supervisor is not the service');
  fs.writeFileSync(plist, '<string>/usr/local/bin/claude-wow</string>');
  assert.match(ok().why, /service definition does not run/, 'a service that runs another binary would not be restarted');
  fs.writeFileSync(plist, `<string>${REL.currentBinary(REL.layout(home))}</string>`);
  devRelease(home, '0.5.0', { source: 'self-update', version: '0.5.0' });
  assert.match(ok().why, /does not run a release made by claude-wow dev deploy/, 'a published release is never turned into a dev deploy');
  devRelease(home, '0.5.1-bbbbbbbbbbbb', { source: 'dev-deploy', sha: 'b'.repeat(40) });
  fs.rmSync(REL.releaseBinary(REL.layout(home), '0.5.1-bbbbbbbbbbbb'));
  assert.match(ok().why, /does not run a release made by claude-wow dev deploy/, 'a release without its binary');
});

test('the first check records origin/main; each later commit starts one detached deploy of that exact commit, remembered across restarts', async () => {
  const t = rig('starts');
  const first = t.head();
  assert.equal(await t.ad.check(), 'recorded', 'turning auto-deploy on deploys nothing by itself');
  assert.deepEqual(t.saved(), { sha: first, exit: 0 });
  assert.equal(t.spawned.length, 0);

  const sha = t.push('two');
  assert.equal(await t.ad.check(), 'started');
  assert.equal(git(t.repo, 'rev-parse', 'origin/main'), sha, 'the check fetched origin');
  assert.ok(!fs.existsSync(path.join(t.repo, '.git', 'FETCH_HEAD')), 'the check leaves FETCH_HEAD alone');
  assert.equal(t.spawned.length, 1);
  const [call] = t.spawned;
  assert.equal(call.file, '/bin/sh');
  assert.deepEqual(
    call.args.slice(3),
    [REL.currentBinary(REL.layout(t.home)), sha, t.repo, path.join(t.home, AD.STATE_FILE)],
    'the deploy builds the commit the check saw',
  );
  assert.match(call.args[1], /--timeout 7200/, 'it waits as long as a factory run may last');
  assert.equal(call.opts.detached, true, 'the deploy outlives the service restart it causes');
  assert.equal(call.opts.stdio[0], 'ignore');
  assert.deepEqual(t.saved(), { sha });
  if (!WINDOWS) assert.equal(fs.statSync(path.join(t.home, AD.LOG_FILE)).mode & 0o777, 0o600);
  assert.ok(t.logs.some(l => l.includes('started claude-wow dev deploy') && l.includes(sha.slice(0, 12))));

  assert.equal(await t.ad.check(), 'seen', 'a commit is deployed at most once');
  const again = AD.createAutoDeploy({
    conf: { repo: t.repo, ref: 'origin/main' },
    home: t.home,
    log() {},
    idle: () => ({ idle: true }),
    spawn: () => assert.fail('no second deploy after a restart'),
  });
  assert.equal(await again.check(), 'seen', 'and the bridge restart the deploy causes does not start it again');

  t.push('three');
  assert.equal(await t.ad.check(), 'started', 'a newer commit is deployed');
  assert.equal(t.spawned.length, 2);
});

test('a check waits while the bridge is busy or a live deploy holds the lock; a stale lock does not block', async () => {
  const t = rig('waits');
  assert.equal(await t.ad.check(), 'recorded');
  t.push('two');
  t.state.busy = true;
  assert.equal(await t.ad.check(), 'busy');
  assert.notEqual(git(t.repo, 'rev-parse', 'origin/main'), t.head(), 'a busy bridge does not even fetch');
  t.state.busy = false;
  const lock = REL.layout(t.home).lock;
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now(), command: 'dev deploy', token: 'x' }));
  assert.equal(await t.ad.check(), 'locked');
  assert.equal(t.spawned.length, 0);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, host: os.hostname(), started: Date.now(), command: 'dev deploy', token: 'x' }));
  assert.equal(await t.ad.check(), 'started', 'a lock left by a dead deploy does not stop auto-deploy for good');
});

test('a failed fetch is logged once while it keeps failing, and starts nothing', async () => {
  const t = rig('fails');
  fs.rmSync(t.repo, { recursive: true, force: true });
  assert.equal(await t.ad.check(), 'failed');
  assert.equal(await t.ad.check(), 'failed');
  assert.equal(t.spawned.length, 0);
  assert.equal(t.logs.filter(l => l.startsWith('auto-deploy: check failed (')).length, 1, t.logs.join('\n'));
});

test('a deploy that cannot even start is recorded as failed and told like any other failure', async () => {
  const t = rig('nolaunch', {
    spawn: () => {
      throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
    },
  });
  assert.equal(await t.ad.check(), 'recorded');
  const sha = t.push('two');
  assert.equal(await t.ad.check(), 'failed');
  assert.deepEqual(t.saved(), { sha, exit: 127 });
  assert.match(t.ad.failureNote(t.repo), /did not complete \(exit 127\)/);
});

test('the deploy script records its exit code, and a failure is told once in the next coding chat message of that repo', { skip: WINDOWS }, async () => {
  const t = rig('exit', { spawn: realSpawn });
  const bin = REL.currentBinary(REL.layout(t.home));
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\necho "deploy $*"\nexit 3\n', { mode: 0o755 });
  assert.equal(await t.ad.check(), 'recorded');
  const sha = t.push('two');
  assert.equal(await t.ad.check(), 'started');
  const deadline = Date.now() + 10000;
  while (t.saved().exit === undefined && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(t.saved(), { sha, exit: 3 });
  assert.match(fs.readFileSync(path.join(t.home, AD.LOG_FILE), 'utf8'), new RegExp(`deploy dev deploy ${sha} --repo .* --timeout 7200`));
  assert.equal(t.ad.failureNote(t.home), '', 'another folder gets no note');
  const note = t.ad.failureNote(t.repo);
  assert.match(note, new RegExp(`^\\[claude-wow bridge\\] The automatic deploy of origin/main at ${sha.slice(0, 12)} did not complete \\(exit 3\\)`));
  assert.equal(t.ad.failureNote(t.repo), '', 'told once');
});

test('start runs a check soon and then every few minutes', async () => {
  const t = rig('start');
  const timers = [];
  t.ad.start({ setTimeout: (fn, ms) => timers.push({ fn, ms }), setInterval: (fn, ms) => timers.push({ fn, ms }) });
  assert.deepEqual(
    timers.map(x => x.ms),
    [AD.FIRST_CHECK_MS, AD.CHECK_MS],
  );
  assert.match(t.logs[0], /^auto-deploy: on, deploys origin\/main from /);
  assert.equal(await timers[0].fn(), 'recorded');
  t.push('two');
  assert.equal(await timers[1].fn(), 'started');
  assert.equal(t.spawned.length, 1);
});
