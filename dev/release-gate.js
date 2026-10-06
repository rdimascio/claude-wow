#!/usr/bin/env node
'use strict';

const WORKFLOW = 'test.yml';
const BRANCH = 'main';
const EVENT = 'push';
const GATE_JOB = 'gate';
const POLL_MS = 30_000;
const WAIT_MS = 20 * 60_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

class GateRefused extends Error {}

function githubApi({ token, fetchImpl = fetch, base = 'https://api.github.com' }) {
  return async path => {
    const res = await fetchImpl(`${base}/${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'claude-wow-release-gate',
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API answered ${res.status} for ${path}`);
    return res.json();
  };
}

async function isOnMain(api, repo, sha) {
  const comparison = await api(`repos/${repo}/compare/${BRANCH}...${sha}`);
  return comparison?.status === 'behind' || comparison?.status === 'identical';
}

async function mainPushRuns(api, repo, sha) {
  const query = new URLSearchParams({ head_sha: sha, branch: BRANCH, event: EVENT, per_page: '100' });
  const body = await api(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?${query}`);
  const runs = body?.workflow_runs || [];
  return runs.filter(run => run.head_sha === sha && run.head_branch === BRANCH && run.event === EVENT);
}

async function gateJobOf(api, repo, run) {
  const body = await api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
  return (body?.jobs || []).find(job => job.name === GATE_JOB) || null;
}

async function readVerdict(api, repo, sha) {
  const runs = await mainPushRuns(api, repo, sha);
  if (runs.length === 0) return { state: 'fail', reason: `no ci push run on main for ${sha}; tag a later main commit` };
  const finished = [];
  let pending = null;
  for (const run of runs) {
    const job = await gateJobOf(api, repo, run);
    const jobDone = job?.status === 'completed';
    if (jobDone && job.conclusion === 'success') return { state: 'pass', reason: `ci run ${run.id} on main has a green gate for ${sha}` };
    if (run.status !== 'completed' || (job && !jobDone)) pending = run;
    else finished.push(`run ${run.id} ${job ? `gate ${job.conclusion}` : `${run.conclusion} with no gate job`}`);
  }
  if (pending) return { state: 'wait', reason: `ci run ${pending.id} on main for ${sha} is ${pending.status}` };
  return { state: 'fail', reason: `no green gate in the ci push runs on main for ${sha} (${finished.join(', ')}); tag a later main commit` };
}

async function checkRelease({ sha, repo, api, sleep, now = Date.now, log = () => {}, pollMs = POLL_MS, waitMs = WAIT_MS }) {
  if (!SHA_PATTERN.test(sha || '')) throw new GateRefused(`not a full commit sha: ${sha}`);
  if (!REPO_PATTERN.test(repo || '')) throw new GateRefused(`not an owner/name repository: ${repo}`);
  if (!(await isOnMain(api, repo, sha))) throw new GateRefused(`${sha} is not on main; tag only a main commit`);
  const deadline = now() + waitMs;
  for (;;) {
    const verdict = await readVerdict(api, repo, sha);
    if (verdict.state === 'pass') return verdict.reason;
    if (verdict.state === 'fail') throw new GateRefused(verdict.reason);
    if (now() >= deadline) throw new GateRefused(`gave up after ${Math.round(waitMs / 60_000)} min: ${verdict.reason}`);
    log(`${verdict.reason}; checking again in ${Math.round(pollMs / 1000)} s`);
    await sleep(pollMs);
  }
}

async function main() {
  const sha = process.argv[2] || process.env.GITHUB_SHA;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new GateRefused('GH_TOKEN is not set');
  const api = githubApi({ token });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const result = await checkRelease({ sha, repo, api, sleep, log: line => console.log(line) });
  console.log(`release gate passed: ${result}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`::error::release gate refused: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { checkRelease, githubApi, GateRefused, WORKFLOW, POLL_MS, WAIT_MS };
