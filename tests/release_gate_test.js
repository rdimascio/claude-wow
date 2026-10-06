'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { checkRelease, githubApi, GateRefused } = require('../dev/release-gate');
const F = require('./fixtures/release-gate.json');

const REPO = 'rdimascio/claude-wow';
const PR_HEAD = 'ec3700490a5f2778322885e138454541ae79494c';
const MAIN_GREEN = '75ef027754cf9941226fe03d723d4367449bff77';
const MAIN_BEFORE_GATE = '7d86a1f159ad4dd920441bf28f023c20c406603a';
const MAIN_PENDING = '6c64766696c534bd9a01f56a3b2bb1d4c4646da2';

function fakeGitHub({ compare, runs, jobs }) {
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path.includes('/compare/')) return compare;
    if (path.includes('/actions/workflows/test.yml/runs?')) return typeof runs === 'function' ? runs() : runs;
    if (/\/actions\/runs\/\d+\/jobs\?/.test(path)) return typeof jobs === 'function' ? jobs() : jobs;
    throw new Error(`unexpected path ${path}`);
  };
  return { api, calls };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async ms => void (t += ms) };
}

test('a PR head sha on main with a green pull_request gate is refused', async () => {
  const gh = fakeGitHub({ compare: F.compareBehind, runs: F.runsPrHead, jobs: F.jobsGreen });
  await assert.rejects(
    checkRelease({ sha: PR_HEAD, repo: REPO, api: gh.api, ...clock() }),
    err => err instanceof GateRefused && /no ci push run on main for ec37004/.test(err.message),
  );
  const runsQuery = new URLSearchParams(gh.calls.find(p => p.includes('/runs?')).split('?')[1]);
  assert.equal(runsQuery.get('event'), 'push');
  assert.equal(runsQuery.get('branch'), 'main');
  assert.equal(runsQuery.get('head_sha'), PR_HEAD);
});

for (const status of ['ahead', 'diverged']) {
  test(`a sha that is ${status} of main is refused before any run is read`, async () => {
    const compare = status === 'ahead' ? F.compareAhead : F.compareDiverged;
    const gh = fakeGitHub({ compare, runs: F.runsMainGreen, jobs: F.jobsGreen });
    await assert.rejects(checkRelease({ sha: MAIN_GREEN, repo: REPO, api: gh.api, ...clock() }), /is not on main/);
    assert.equal(gh.calls.length, 1);
  });
}

test('a main sha whose push run has a failed gate is refused', async () => {
  const gh = fakeGitHub({ compare: F.compareBehind, runs: F.runsMainGreen, jobs: F.jobsGateFailed });
  await assert.rejects(checkRelease({ sha: MAIN_GREEN, repo: REPO, api: gh.api, ...clock() }), /\(run 37387403169 gate failure\); tag a later main commit/);
});

test('a main sha whose push run has no gate job is refused', async () => {
  const gh = fakeGitHub({ compare: F.compareBehind, runs: F.runsMainBeforeGate, jobs: F.jobsBeforeGate });
  await assert.rejects(checkRelease({ sha: MAIN_BEFORE_GATE, repo: REPO, api: gh.api, ...clock() }), /run 37277261806 success with no gate job/);
});

test('a main sha with no push run at all is refused', async () => {
  const gh = fakeGitHub({ compare: F.compareIdentical, runs: F.runsNone, jobs: F.jobsPending });
  await assert.rejects(checkRelease({ sha: MAIN_PENDING, repo: REPO, api: gh.api, ...clock() }), {
    message: `no ci push run on main for ${MAIN_PENDING}; tag a later main commit`,
  });
});

test('a main sha with a green push gate passes', async () => {
  const gh = fakeGitHub({ compare: F.compareBehind, runs: F.runsMainGreen, jobs: F.jobsGreen });
  const result = await checkRelease({ sha: MAIN_GREEN, repo: REPO, api: gh.api, ...clock() });
  assert.match(result, /ci run 37387403169 on main has a green gate/);
});

test('an in-progress push run is polled every 30 s and passes when its gate turns green', async () => {
  let reads = 0;
  const gh = fakeGitHub({
    compare: F.compareIdentical,
    runs: () => (++reads < 3 ? F.runsMainPending : F.runsMainDone),
    jobs: () => (reads < 3 ? F.jobsPending : F.jobsGreen),
  });
  const c = clock();
  const logs = [];
  const result = await checkRelease({ sha: MAIN_PENDING, repo: REPO, api: gh.api, log: l => logs.push(l), ...c });
  assert.match(result, /green gate/);
  assert.equal(c.now(), 2 * 30_000);
  assert.equal(logs.length, 2);
});

test('an in-progress push run that never finishes is refused after 20 min', async () => {
  const gh = fakeGitHub({ compare: F.compareIdentical, runs: F.runsMainPending, jobs: F.jobsPending });
  const c = clock();
  await assert.rejects(
    checkRelease({ sha: MAIN_PENDING, repo: REPO, api: gh.api, ...c }),
    /gave up after 20 min: ci run 37393705976 on main for .* is pending/,
  );
  assert.equal(c.now(), 20 * 60_000);
});

function fetchFrom(routes) {
  return async url => {
    const route = routes.find(r => url.includes(r.match));
    const answer = typeof route.answer === 'function' ? route.answer() : route.answer;
    return typeof answer === 'number' ? { status: answer, ok: false } : { status: 200, ok: true, json: async () => answer };
  };
}

test('a 5xx or 429 while polling is waited out, and another API error refuses at once', async () => {
  const runAnswers = [502, 429, F.runsMainGreen];
  const api = githubApi({
    token: 't',
    fetchImpl: fetchFrom([
      { match: '/compare/', answer: F.compareBehind },
      { match: '/workflows/test.yml/runs?', answer: () => runAnswers.shift() },
      { match: '/jobs?', answer: F.jobsGreen },
    ]),
  });
  const c = clock();
  assert.match(await checkRelease({ sha: MAIN_GREEN, repo: REPO, api, ...c }), /green gate/);
  assert.equal(c.now(), 2 * 30_000);
  const denied = githubApi({
    token: 't',
    fetchImpl: fetchFrom([
      { match: '/compare/', answer: F.compareBehind },
      { match: '/workflows/test.yml/runs?', answer: 401 },
    ]),
  });
  await assert.rejects(checkRelease({ sha: MAIN_GREEN, repo: REPO, api: denied, ...clock() }), /GitHub API answered 401/);
});

test('the GitHub client sends the token, reads a 404 as nothing and throws on other errors', async () => {
  const seen = [];
  const answers = [
    { status: 200, ok: true, json: async () => F.compareBehind },
    { status: 404, ok: false },
    { status: 502, ok: false },
  ];
  const api = githubApi({ token: 't0k', fetchImpl: async (url, init) => (seen.push({ url, init }), answers.shift()) });
  assert.deepEqual(await api('repos/a/b/compare/main...x'), F.compareBehind);
  assert.equal(await api('repos/a/b/compare/main...y'), null);
  await assert.rejects(api('repos/a/b/actions/runs/1/jobs'), /GitHub API answered 502/);
  assert.equal(seen[0].url, 'https://api.github.com/repos/a/b/compare/main...x');
  assert.equal(seen[0].init.headers.authorization, 'Bearer t0k');
});

function readJobs(text) {
  const jobs = {};
  let job = null;
  let step = null;
  let inJobs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inJobs = line.startsWith('jobs:');
    if (!inJobs) continue;
    const jobHead = line.match(/^ {2}([\w-]+):\s*$/);
    if (jobHead) {
      job = jobs[jobHead[1]] = { needs: [], if: null, steps: [] };
      step = null;
      continue;
    }
    if (!job) continue;
    const jobKey = line.match(/^ {4}(needs|if): (.+)$/);
    if (jobKey) {
      const value = jobKey[2].trim();
      if (jobKey[1] === 'if') job.if = value;
      else
        job.needs = value.startsWith('[')
          ? value
              .slice(1, -1)
              .split(',')
              .map(s => s.trim())
          : [value];
      continue;
    }
    const stepKey = line.match(/^ {6}(- | {2})(name|if|run|uses): (.+)$/);
    if (stepKey) {
      if (stepKey[1] === '- ') job.steps.push((step = {}));
      step[stepKey[2]] = stepKey[3].trim();
    }
  }
  return jobs;
}

function reaches(jobs, from, target) {
  const queue = [...jobs[from].needs];
  while (queue.length) {
    const next = queue.shift();
    if (next === target) return true;
    queue.push(...(jobs[next]?.needs || []));
  }
  return false;
}

test('release.yml runs the gate on tags and every publishing job waits for it', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const jobs = readJobs(text);
  const gate = jobs['release-gate'];
  assert.equal(gate.if, null);
  const check = gate.steps.find(s => s.run?.includes('dev/release-gate.js'));
  assert.equal(check.if, "github.ref_type == 'tag'");
  assert.match(check.run, /^node dev\/release-gate\.js /);
  assert.ok(jobs.version.needs.includes('release-gate'));
  for (const name of ['version', 'addon', 'bridge', 'github-release', 'addon-stores']) {
    assert.ok(reaches(jobs, name, 'release-gate'), `${name} must need release-gate`);
  }
});
