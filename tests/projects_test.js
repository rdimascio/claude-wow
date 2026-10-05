'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PJ = require('../bridge/projects');

function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-projects-')));
  const home = path.join(root, 'home');
  const repo = (rel, config) => {
    const dir = path.join(home, rel);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), config);
    return dir;
  };
  const wow = repo('wow-ai', '[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/someone/wow-ai\n[remote "origin"]\n\turl = https://github.com/me/claude-wow.git\n');
  const every = repo('every-io/every', '[remote "origin"]\n\turl = git@github.com:every-io/every.git\n');
  const worktree = path.join(home, 'every-3');
  const wtGit = path.join(every, '.git', 'worktrees', 'every-3');
  fs.mkdirSync(wtGit, { recursive: true });
  fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${wtGit}\n`);
  const plain = path.join(home, 'notes');
  fs.mkdirSync(plain);
  fs.mkdirSync(path.join(root, 'tmpish'));
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch);
  return { root, home, wow, every, worktree, plain, scratch };
}

test('repo labels come from the origin remote, through a worktree to its main repo, else the folder name', () => {
  const t = tree();
  assert.equal(PJ.repoLabel(t.wow), 'claude-wow');
  assert.equal(PJ.repoLabel(path.join(t.every)), 'every');
  assert.equal(PJ.repoLabel(t.worktree), 'every');
  assert.equal(PJ.repoLabel(t.plain), 'notes');
  assert.equal(PJ.repoNameFromUrl('git@github.com:o/r.git'), 'r');
  assert.equal(PJ.repoNameFromUrl('https://github.com/o/r/'), 'r');
  assert.equal(PJ.repoNameFromUrl('C:\\src\\repo.git'), 'repo');
});

test('known projects: the default first, then by recency; ~ and trailing slashes collapse; missing, temp, home and excluded folders are left out; equal labels are told apart', () => {
  const t = tree();
  const list = PJ.knownProjects({
    defaultCwd: t.every,
    chats: [{ cwd: '~/wow-ai/', at: 300 }, { cwd: path.join(t.home, 'gone'), at: 900 }],
    recent: [{ cwd: t.wow, at: 100 }, { cwd: t.worktree, at: 200 }, { cwd: t.home, at: 999 }, { cwd: t.scratch, at: 998 }, { cwd: t.plain, at: 50 }, { cwd: path.join(t.root, 'tmpish'), at: 997 }],
    exclude: [t.scratch],
    tempRoots: [path.join(t.root, 'tmpish')],
    home: t.home,
    now: 1,
  });
  assert.deepEqual(list, [
    { path: t.every, label: 'every' },
    { path: t.wow, label: 'claude-wow' },
    { path: t.worktree, label: 'every (every-3)' },
    { path: t.plain, label: 'notes' },
  ]);
});

test('known projects: the limit holds and a label never carries Lua-breaking characters', () => {
  const t = tree();
  const odd = path.join(t.home, 'we"ird]]--');
  fs.mkdirSync(odd);
  const list = PJ.knownProjects({ recent: [{ cwd: odd, at: 2 }, { cwd: t.plain, at: 1 }], home: t.home, tempRoots: [], limit: 1, now: 2 });
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'weird--');
});

test('recent Claude projects are read from the tail of history.jsonl, latest time per folder', () => {
  const t = tree();
  const dir = path.join(t.root, 'claude');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'history.jsonl'), [
    { display: 'a', timestamp: 10, project: '/x/one' },
    'not json',
    { display: 'b', timestamp: 30, project: '/x/two' },
    { display: 'c', timestamp: 20, project: '/x/one' },
    { display: 'd', timestamp: 40 },
  ].map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n'));
  assert.deepEqual(PJ.recentClaudeProjects(dir).sort((a, b) => a.at - b.at), [{ cwd: '/x/one', at: 20 }, { cwd: '/x/two', at: 30 }]);
  assert.deepEqual(PJ.recentClaudeProjects(path.join(t.root, 'none')), []);
});
