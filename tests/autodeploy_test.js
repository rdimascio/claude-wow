'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AD = require('../bridge/autodeploy');
const REL = require('../bridge/releases');

const NO_SYMLINKS = process.platform === 'win32';

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

function rig(name, { deployed = '', busy = false } = {}) {
  const root = scratch(name);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const r = repos(root);
  const spawned = [];
  const logs = [];
  const state = { deployed, busy };
  const real = AD.createAutoDeploy({
    conf: { enabled: true, repo: r.repo, ref: 'origin/main' },
    home,
    log: line => logs.push(line),
    idle: () => (state.busy ? { idle: false, reason: '1 message(s) running or queued' } : { idle: true }),
    deployed: () => state.deployed,
    spawn: (file, args, opts) => {
      spawned.push({ file, args, opts });
      return { unref() {} };
    },
  });
  return { ...r, home, spawned, logs, state, ad: real };
}

test('settings: off unless autoDeploy names a repo, origin/<branch> refs only, folders resolve like chat folders', () => {
  const base = path.join(os.tmpdir(), 'ad-base');
  assert.deepEqual(AD.settings({}, base), { enabled: false });
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

test('a check fetches origin and starts one detached dev deploy for a commit that is not deployed', async () => {
  const t = rig('starts');
  t.state.deployed = t.head();
  assert.equal(await t.ad.check(), 'current');
  assert.equal(t.spawned.length, 0, 'the deployed commit starts nothing');

  const sha = t.push('two');
  assert.notEqual(git(t.repo, 'rev-parse', 'origin/main'), sha, 'the checkout has not fetched it yet');
  assert.equal(await t.ad.check(), 'started');
  assert.equal(git(t.repo, 'rev-parse', 'origin/main'), sha, 'the check fetched origin');
  assert.equal(t.spawned.length, 1);
  const [call] = t.spawned;
  assert.equal(call.file, REL.currentBinary(REL.layout(t.home)));
  assert.deepEqual(call.args, ['dev', 'deploy', 'origin/main', '--repo', t.repo]);
  assert.equal(call.opts.detached, true, 'the deploy outlives the bridge restart it causes');
  assert.equal(call.opts.stdio[0], 'ignore');
  assert.ok(fs.existsSync(path.join(t.home, AD.LOG_FILE)), 'its output goes to autodeploy.log');
  if (!NO_SYMLINKS) assert.equal(fs.statSync(path.join(t.home, AD.LOG_FILE)).mode & 0o777, 0o600);
  assert.ok(t.logs.some(l => l.includes(`started claude-wow dev deploy`) && l.includes(sha.slice(0, 12))));

  assert.equal(await t.ad.check(), 'tried', 'a commit is deployed at most once per bridge start');
  assert.equal(t.spawned.length, 1);
  const next = t.push('three');
  assert.equal(await t.ad.check(), 'started', 'a newer commit is deployed');
  assert.equal(t.spawned.length, 2);
  assert.ok(t.logs.some(l => l.includes(next.slice(0, 12))));
});

test('a check waits while the bridge is busy or another deploy holds the lock, and tries again later', async () => {
  const t = rig('waits');
  t.push('two');
  t.state.busy = true;
  assert.equal(await t.ad.check(), 'busy');
  assert.notEqual(git(t.repo, 'rev-parse', 'origin/main'), t.head(), 'a busy bridge does not even fetch');
  t.state.busy = false;
  fs.writeFileSync(REL.layout(t.home).lock, '{}');
  assert.equal(await t.ad.check(), 'locked');
  assert.equal(t.spawned.length, 0);
  fs.rmSync(REL.layout(t.home).lock);
  assert.equal(await t.ad.check(), 'started', 'neither wait marks the commit as tried');
  assert.equal(t.spawned.length, 1);
});

test('a failed fetch is logged and starts nothing', async () => {
  const t = rig('fails');
  fs.rmSync(t.repo, { recursive: true, force: true });
  assert.equal(await t.ad.check(), 'failed');
  assert.equal(t.spawned.length, 0);
  assert.ok(
    t.logs.some(l => l.startsWith('auto-deploy: check failed (')),
    t.logs.join('\n'),
  );
});

test('deployedSha reads the sha the current release was built from', { skip: NO_SYMLINKS }, () => {
  const home = scratch('sha');
  const l = REL.layout(home);
  const name = '0.5.0-abcdef123456';
  fs.mkdirSync(REL.releaseDir(l, name), { recursive: true });
  fs.writeFileSync(path.join(REL.releaseDir(l, name), 'release.json'), JSON.stringify({ source: 'dev-deploy', sha: 'f'.repeat(40), name }));
  assert.equal(AD.deployedSha(home), '', 'no current release');
  fs.symlinkSync(path.join('releases', name), l.current);
  assert.equal(AD.deployedSha(home), 'f'.repeat(40));
});

test('start schedules the first check soon and then a regular one, and says it is on', () => {
  const t = rig('start');
  const timers = [];
  t.ad.start({ setTimeout: (fn, ms) => timers.push(['once', ms]), setInterval: (fn, ms) => timers.push(['every', ms]) });
  assert.deepEqual(timers, [
    ['once', AD.FIRST_CHECK_MS],
    ['every', AD.CHECK_MS],
  ]);
  assert.match(t.logs[0], /^auto-deploy: on, deploys origin\/main from /);
});
