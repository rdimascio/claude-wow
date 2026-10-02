'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const D = require('../bridge/deploy');
const REL = require('../bridge/releases');
const S = require('../bridge/service');

const NO_SYMLINKS = process.platform === 'win32';
const UID = 501;
const KICKSTART = ['launchctl', 'kickstart', '-k', `gui/${UID}/${S.LABEL}`];

function scratch(name) {
  const dir = path.join(__dirname, 'tmp', 'deploy', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(root, version = '0.5.0') {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(repo, 'marker.txt'), 'one');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

function commit(repo, marker) {
  fs.writeFileSync(path.join(repo, 'marker.txt'), marker);
  git(repo, 'commit', '-q', '-am', marker);
  return git(repo, 'rev-parse', 'HEAD');
}

function harness(root, { runsCurrent = true, platform = 'darwin', probe, setupOut = 'addon    : 18 file(s)\nDone. Next:\n  1. Fully quit and relaunch World of Warcraft (it only discovers new addon folders at launch).\n  4. In game:  /claude', failRestart = false } = {}) {
  const base = path.join(root, 'home');
  fs.mkdirSync(base, { recursive: true });
  const l = REL.layout(base);
  const client = path.join(root, 'World of Warcraft', '_classic_era_');
  fs.writeFileSync(l.config, JSON.stringify({ addonDir: path.join(client, 'Interface', 'AddOns') }));
  const definitionFile = path.join(root, 'io.claudewow.bridge.plist');
  fs.writeFileSync(definitionFile, runsCurrent
    ? S.launchdPlist({ node: REL.currentBinary(l), script: '', cwd: base, logFile: '/l' })
    : S.launchdPlist({ node: '/Users/p/.nvm/versions/node/v24/bin/node', script: '/Users/p/wow-ai/bridge/supervisor.js', cwd: '/Users/p/wow-ai', logFile: '/l' }));
  const events = [];
  const builds = [];
  const out = [];
  const err = [];
  let clock = 0;
  const ctx = {
    base, platform, uid: UID, definitionFile, tmpRoot: root,
    now: () => clock, sleep: async ms => { clock += ms; }, pollMs: 1000, settleMs: 0,
    out: line => out.push(line), err: line => err.push(line),
    probe: probe ? () => { const s = probe(); events.push(['probe', s.idle, REL.currentName(l)]); return s; } : () => ({ idle: true, reason: 'idle' }),
    run: (cmd, args, opts) => {
      if (cmd === 'git') return D.runCommand(cmd, args, opts);
      events.push([cmd, ...args]);
      if ((cmd === 'launchctl' || cmd === 'systemctl') && failRestart) return { ok: false, status: 1, out: 'Could not find service' };
      if (cmd === REL.currentBinary(l)) return { ok: true, status: 0, out: setupOut };
      return { ok: true, status: 0, out: '' };
    },
    build: (src, outDir) => {
      builds.push(src);
      assert.ok(fs.existsSync(path.join(src, 'marker.txt')), 'the build sees the source tree');
      const file = path.join(outDir, 'claude-wow-darwin-arm64');
      fs.writeFileSync(file, `binary of ${fs.readFileSync(path.join(src, 'marker.txt'), 'utf8')}`);
      return file;
    },
  };
  return { ctx, l, client, events, builds, out, err };
}

function worktrees(repo) {
  return git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(x => x.startsWith('worktree ')).length;
}

test('argument parsing: deploy takes one target and its options, rollback and status take none, anything else is an error', () => {
  assert.equal(D.parseArgs([]).cmd, 'help');
  const d = D.parseArgs(['deploy', 'origin/main', '--repo', '/r', '--timeout', '90', '--keep', '3']);
  assert.deepEqual({ cmd: d.cmd, target: d.target, repo: d.repo, timeoutMs: d.timeoutMs, keep: d.keep }, { cmd: 'deploy', target: 'origin/main', repo: '/r', timeoutMs: 90000, keep: 3 });
  assert.equal(D.parseArgs(['deploy']).target, '');
  assert.match(D.parseArgs(['deploy', 'a', 'b']).error, /unexpected argument "b"/);
  assert.match(D.parseArgs(['deploy', '--repo']).error, /--repo needs a folder/);
  assert.match(D.parseArgs(['deploy', '--keep', '0']).error, /--keep needs a whole number/);
  assert.match(D.parseArgs(['rollback', 'x']).error, /unexpected argument/);
  assert.match(D.parseArgs(['frob']).error, /unknown dev command/);
  assert.match(D.parseArgs(['deploy', '--force']).error, /unknown option "--force"/);
});

test('deploy of a ref: built in a temporary worktree that is removed, installed as <version>-<sha>, current flipped, service kickstarted, setup run for the client, the game line printed', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('ref');
  const repo = makeRepo(root);
  const sha = git(repo, 'rev-parse', 'HEAD');
  const h = harness(root);
  const code = await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx);
  assert.equal(code, 0, h.err.join('\n'));
  const name = `0.5.0-${sha.slice(0, 12)}`;
  assert.equal(REL.currentName(h.l), name);
  assert.equal(fs.readFileSync(REL.currentBinary(h.l), 'utf8'), 'binary of one');
  assert.equal(h.builds.length, 1);
  assert.ok(h.builds[0].startsWith(root) && !h.builds[0].startsWith(repo), 'built outside the checkout');
  assert.ok(!fs.existsSync(h.builds[0]), 'the temporary worktree is gone');
  assert.equal(worktrees(repo), 1, 'git no longer lists it');
  assert.deepEqual(h.events, [KICKSTART, [REL.currentBinary(h.l), 'setup', '--wow', h.client]]);
  assert.ok(h.out.includes('in game : 1. Fully quit and relaunch World of Warcraft (it only discovers new addon folders at launch).'), h.out.join('\n'));
  assert.ok(!fs.existsSync(h.l.lock), 'the lock is released');
  assert.deepEqual(fs.readdirSync(root).filter(f => f.startsWith('claude-wow-')), [], 'no temporary build or source folder is left');

  const again = harness(root);
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], again.ctx), 0);
  assert.equal(again.builds.length, 0, 'an already built release is not built again');
  assert.ok(again.out.includes(`current : ${name} was already current`));
});

test('rollback goes back to the release before the last deploy and kickstarts; a second deploy records the first as previous', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('rollback');
  const repo = makeRepo(root);
  const first = `0.5.0-${git(repo, 'rev-parse', 'HEAD').slice(0, 12)}`;
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], harness(root).ctx), 0);
  const second = `0.5.0-${commit(repo, 'two').slice(0, 12)}`;
  const h = harness(root);
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 0);
  assert.equal(REL.currentName(h.l), second);
  assert.equal(REL.previousName(h.l), first);
  assert.ok(h.out.some(l => l.includes(`previous ${first}`)));

  const r = harness(root);
  assert.equal(await D.main(['rollback'], r.ctx), 0, r.err.join('\n'));
  assert.equal(REL.currentName(r.l), first);
  assert.equal(fs.readFileSync(REL.currentBinary(r.l), 'utf8'), 'binary of one');
  assert.equal(REL.previousName(r.l), second);
  assert.deepEqual(r.events[0], KICKSTART);
  assert.ok(!fs.existsSync(r.l.lock));

  const s = harness(root, { probe: () => ({ idle: false, reason: '1 agent run(s) in flight (#2)' }) });
  assert.equal(await D.main(['status'], s.ctx), 0);
  const text = s.out.join('\n');
  assert.match(text, new RegExp(`current  : ${first}\\n`));
  assert.match(text, new RegExp(`previous : ${second}\\n`));
  assert.match(text, new RegExp(`release  : ${first}  \\(current\\)`));
  assert.match(text, /service  : runs .*current.claude-wow/);
  assert.match(text, /bridge   : busy \(1 agent run\(s\) in flight \(#2\)\)/);
});

test('before the migration the service does not run current: the release is staged and current flipped, but nothing restarts and setup does not run', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('premigration');
  const repo = makeRepo(root);
  const h = harness(root, { runsCurrent: false });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 0);
  assert.ok(REL.currentName(h.l));
  assert.deepEqual(h.events, [], 'no launchctl, no setup');
  assert.ok(h.out.some(l => /does not run .*current.*nothing was restarted and setup was not run/.test(l)), h.out.join('\n'));
  assert.ok(h.out.some(l => l.includes('MIGRATE-PROD-INSTALL.md')));
});

test('the idle wait: the flip waits while a run is in flight, proceeds once idle, and a timeout switches nothing', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('idle');
  const repo = makeRepo(root);
  let busy = 3;
  const h = harness(root, { probe: () => (busy-- > 0 ? { idle: false, reason: '1 agent run(s) in flight (#4)' } : { idle: true, reason: 'idle' }) });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 0);
  const probes = h.events.filter(e => e[0] === 'probe');
  assert.deepEqual(probes.map(p => p[1]), [false, false, false, true]);
  assert.ok(probes.every(p => p[2] === ''), 'current did not move while waiting');
  assert.deepEqual(h.events[probes.length], KICKSTART, 'the restart comes after the wait');
  assert.ok(h.out.includes('waiting : 1 agent run(s) in flight (#4)'));

  const before = REL.currentName(h.l);
  commit(repo, 'three');
  const stuck = harness(root, { probe: () => ({ idle: false, reason: '1 message(s) waiting in the queue (#9)' }) });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo, '--timeout', '5'], stuck.ctx), 1);
  assert.match(stuck.err.join('\n'), /did not go idle within 5 s \(1 message\(s\) waiting in the queue \(#9\)\)\. Nothing was switched/);
  assert.equal(REL.currentName(stuck.l), before, 'current is unchanged');
  assert.deepEqual(stuck.events.filter(e => e[0] !== 'probe'), [], 'no restart, no setup');
  assert.ok(!fs.existsSync(stuck.l.lock), 'the lock is released on failure');
  assert.equal(worktrees(repo), 1, 'the temporary worktree is removed on failure');
});

test('lock contention: a deploy while another holds the lock builds nothing and says who holds it; a dead holder\'s lock is taken over', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('contention');
  const repo = makeRepo(root);
  const h = harness(root);
  const other = REL.acquireLock(h.l.lock, { pid: process.pid, command: 'dev deploy' });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 1);
  assert.match(h.err.join('\n'), new RegExp(`another deploy holds .*pid ${process.pid} \\(dev deploy\\)`));
  assert.equal(h.builds.length, 0);
  assert.equal(REL.currentName(h.l), '');
  assert.equal(worktrees(repo), 1);
  assert.equal(await D.main(['rollback'], h.ctx), 1, 'rollback takes the same lock');
  assert.ok(fs.existsSync(h.l.lock), 'the holder keeps its lock');
  other.release();

  fs.writeFileSync(h.l.lock, JSON.stringify({ pid: 2147483000, host: require('os').hostname(), started: 0 }));
  const after = harness(root);
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], after.ctx), 0, after.err.join('\n'));
  assert.ok(!fs.existsSync(after.l.lock));
});

test('deploy of a worktree folder builds it in place under a -dirty-<time> name when it has changes; linux restarts the systemd unit', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('worktree');
  const repo = makeRepo(root);
  const sha = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'marker.txt'), 'edited');
  const h = harness(root, { platform: 'linux' });
  fs.writeFileSync(h.ctx.definitionFile, S.systemdUnit({ node: REL.currentBinary(h.l), script: '', cwd: h.l.base }));
  assert.equal(await D.main(['deploy', repo], h.ctx), 0, h.err.join('\n'));
  assert.deepEqual(h.builds, [repo]);
  assert.match(REL.currentName(h.l), new RegExp(`^0\\.5\\.0-${sha.slice(0, 12)}-dirty-\\d{8}-\\d{6}Z$`));
  assert.equal(fs.readFileSync(REL.currentBinary(h.l), 'utf8'), 'binary of edited');
  assert.deepEqual(h.events[0], ['systemctl', '--user', 'restart', S.UNIT]);
  assert.ok(fs.existsSync(path.join(repo, 'marker.txt')), 'the worktree is left alone');
  assert.equal(worktrees(repo), 1);
});

test('a failed restart is an error that names how to restart, and setup is not run against a bridge that did not restart', { skip: NO_SYMLINKS }, async () => {
  const root = scratch('restart-fails');
  const repo = makeRepo(root);
  const h = harness(root, { failRestart: true });
  assert.equal(await D.main(['deploy', 'HEAD', '--repo', repo], h.ctx), 1);
  assert.match(h.err.join('\n'), /did not restart: Could not find service/);
  assert.deepEqual(h.events, [KICKSTART]);
});

test('helpers: the configured client from addonDir, the game lines from setup output, the release name, bad refs and Windows', async () => {
  const dir = scratch('helpers');
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ addonDir: path.join('/W', '_classic_era_', 'Interface', 'AddOns') }));
  assert.deepEqual(D.configuredClients(cfg), [path.join('/W', '_classic_era_')]);
  fs.writeFileSync(cfg, JSON.stringify({ addonDir: '/somewhere/else' }));
  assert.deepEqual(D.configuredClients(cfg), []);
  assert.deepEqual(D.configuredClients(path.join(dir, 'missing.json')), []);
  assert.deepEqual(D.gameLines('a\nwarning  : the signal files moved: fully quit and relaunch WoW once\nx\n  1. /reload is enough\n  1. /reload is enough'), [
    'warning  : the signal files moved: fully quit and relaunch WoW once', '1. /reload is enough',
  ]);
  assert.equal(D.releaseNameFor('0.5.0-beta.1', 'abcdef0123456789', false, 0), '0.5.0-beta.1-abcdef012345');
  assert.ok(REL.validName(D.releaseNameFor('0.5.0', 'abcdef0123456789', true, Date.UTC(2026, 9, 2, 13, 4, 5))));
  assert.equal(D.releaseNameFor('0.5.0', 'abcdef0123456789', true, Date.UTC(2026, 9, 2, 13, 4, 5)), '0.5.0-abcdef012345-dirty-20261002-130405Z');
  const repo = makeRepo(dir);
  const h = harness(dir);
  assert.equal(await D.main(['deploy', 'no-such-ref', '--repo', repo], h.ctx), 1);
  assert.match(h.err.join('\n'), /"no-such-ref" is not a commit/);
  const w = harness(dir, { platform: 'win32' });
  assert.equal(await D.main(['deploy'], w.ctx), 2);
  assert.match(w.err.join('\n'), /macOS and Linux only/);
});
