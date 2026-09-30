'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const PJ = require('../bridge/projects');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const ZERO = '0'.repeat(40);
const ONE = '1'.repeat(40);

function makeRepo(dir, { remote = '', readme = null, reflog = [] } = {}) {
  fs.mkdirSync(path.join(dir, '.git', 'logs'), { recursive: true });
  write(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n${remote ? `[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ''}`);
  write(path.join(dir, '.git', 'logs', 'HEAD'), reflog.map(([secs, msg]) => `${ZERO} ${ONE} Dev <dev@example.com> ${secs} +0000\t${msg}`).join('\n') + (reflog.length ? '\n' : ''));
  if (readme !== null) write(path.join(dir, 'README.md'), readme);
}

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  const home = path.join(root, 'home');
  makeRepo(path.join(home, 'wow-ai'), {
    remote: 'https://github.com/rdimascio/wow-ai.git',
    readme: '[![CI](https://x/badge.svg)](https://x)\n\n# claude-wow\n\nMore text.\n',
    reflog: [[1790000000, 'clone: from origin'], [1790500000, 'commit: add router'], [1790600000, 'checkout: moving from a to b']],
  });
  makeRepo(path.join(home, 'Projects', 'ellie'), { readme: 'Ellie is a *desktop* assistant.\n', reflog: [[1780000000, 'commit (initial): start']] });
  makeRepo(path.join(home, 'Projects', 'group', 'deep'), { reflog: [[1770000000, 'commit: x']] });
  makeRepo(path.join(home, 'a', 'b', 'c', 'too-deep'), { reflog: [[1770000000, 'commit: x']] });
  makeRepo(path.join(home, 'wow-ai', 'nested-inside-repo'));
  makeRepo(path.join(home, 'node_modules', 'pkg'));
  makeRepo(path.join(home, '.hidden', 'secret'));
  const gitdir = path.join(home, 'wow-ai', '.git', 'worktrees', 'wt1');
  fs.mkdirSync(path.join(gitdir, 'logs'), { recursive: true });
  write(path.join(gitdir, 'commondir'), '../..\n');
  write(path.join(gitdir, 'logs', 'HEAD'), `${ZERO} ${ONE} Dev <dev@example.com> 1791000000 +0000\tcommit: on the worktree\n`);
  write(path.join(home, 'worktrees', 'wt1', '.git'), `gitdir: ${gitdir}\n`);
  return { root, home };
}

test('a scan finds git repos under the roots, newest first, with remote, last commit, README line and aliases', async () => {
  const { home } = makeTree();
  const opts = PJ.scanOptions({}, home);
  assert.deepEqual(opts.roots, [home, path.join(home, 'Projects')]);
  assert.equal(opts.depth, 3);
  const r = await PJ.scan(opts);
  const names = r.projects.map(p => p.name);
  assert.deepEqual(names, ['wow-ai', 'ellie', 'deep']);
  const wow = r.projects[0];
  assert.equal(wow.path, path.join(home, 'wow-ai'));
  assert.equal(wow.remote, 'https://github.com/rdimascio/wow-ai.git');
  assert.equal(wow.lastCommit, new Date(1790500000 * 1000).toISOString());
  assert.equal(wow.readme, 'claude-wow');
  assert.deepEqual(wow.aliases, ['wow ai', 'wowai']);
  assert.equal(r.projects[1].readme, 'Ellie is a desktop assistant.');
});

test('worktree checkouts (a .git file) are skipped by default and included on request', async () => {
  const { home } = makeTree();
  const skipped = await PJ.scan(PJ.scanOptions({}, home));
  assert.ok(!skipped.projects.some(p => p.name === 'wt1'));
  assert.equal(skipped.skippedWorktrees, 1);
  const included = await PJ.scan(PJ.scanOptions({ includeWorktrees: true }, home));
  const wt = included.projects.find(p => p.name === 'wt1');
  assert.ok(wt);
  assert.equal(wt.worktree, true);
  assert.equal(wt.remote, 'https://github.com/rdimascio/wow-ai.git');
  assert.equal(wt.lastCommit, new Date(1791000000 * 1000).toISOString());
});

test('the depth limit, hidden folders, node_modules and repos inside repos are not searched', async () => {
  const { home } = makeTree();
  const r = await PJ.scan(PJ.scanOptions({}, home));
  const names = r.projects.map(p => p.name);
  for (const n of ['too-deep', 'nested-inside-repo', 'pkg', 'secret']) assert.ok(!names.includes(n), `${n} was found`);
  const deeper = await PJ.scan(PJ.scanOptions({ depth: 4 }, home));
  assert.ok(deeper.projects.some(p => p.name === 'too-deep'));
  const shallow = await PJ.scan(PJ.scanOptions({ depth: 1, roots: ['~'] }, home));
  assert.deepEqual(shallow.projects.map(p => p.name), ['wow-ai']);
});

test('refresh writes projects.json and readRegistry reads it back', async () => {
  const { root, home } = makeTree();
  const file = path.join(root, 'claude-wow-home', 'projects.json');
  const data = await PJ.refresh({ file, routerCfg: { aliases: { ellie: ['assistant'] } }, home, now: Date.parse('2026-09-29T00:00:00Z') });
  assert.equal(data.scannedAt, '2026-09-29T00:00:00.000Z');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.projects.length, 3);
  assert.equal(saved.depth, 3);
  assert.equal(saved.skippedWorktrees, 1);
  assert.deepEqual(PJ.readRegistry(file).map(p => p.name), ['wow-ai', 'ellie', 'deep']);
  assert.ok(saved.projects.find(p => p.name === 'ellie').aliases.includes('assistant'));
  assert.deepEqual(PJ.readRegistry(path.join(root, 'missing.json')), []);
});

test('parsers: origin url, reflog commit time, README line, remote name', () => {
  assert.equal(PJ.originUrl('[remote "upstream"]\n\turl = a\n[remote "origin"]\n\turl = b\n'), 'b');
  assert.equal(PJ.originUrl('[remote "upstream"]\n\turl = a\n'), 'a');
  assert.equal(PJ.originUrl('[core]\n'), '');
  assert.equal(PJ.lastCommitFromReflog(`${ZERO} ${ONE} A <a@b> 100 +0000\tcommit: x\n${ZERO} ${ONE} A <a@b> 200 +0000\tcheckout: y\n`), 100000);
  assert.equal(PJ.lastCommitFromReflog(`${ZERO} ${ONE} A <a@b> 200 +0000\tcheckout: y\n`), 200000);
  assert.equal(PJ.lastCommitFromReflog(''), 0);
  assert.equal(PJ.readmeLine('<p align="center">\n\n## **Hello** [world](http://x)\n'), 'Hello world');
  assert.equal(PJ.readmeLine(''), '');
  assert.equal(PJ.remoteName('https://github.com/rdimascio/wow-ai.git'), 'wow-ai');
  assert.equal(PJ.remoteName('ssh://host/org/thing'), 'thing');
});

test('npm run projects:scan writes into CLAUDE_WOW_HOME, not ~/.claude-wow', () => {
  const { root, home } = makeTree();
  const clawHome = path.join(root, 'cw');
  fs.mkdirSync(clawHome, { recursive: true });
  write(path.join(clawHome, 'config.json'), JSON.stringify({ router: { roots: [path.join(home, 'Projects')] } }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bridge', 'projects.js')], { env: { ...process.env, CLAUDE_WOW_HOME: clawHome, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 project\(s\)/);
  const saved = JSON.parse(fs.readFileSync(path.join(clawHome, 'projects.json'), 'utf8'));
  assert.deepEqual(saved.projects.map(p => p.name), ['ellie', 'deep']);
});
