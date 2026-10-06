'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn: nodeSpawn } = require('child_process');
const P = require('./protocol');
const REL = require('./releases');

const DEFAULT_REF = 'origin/main';
const REF_RE = /^origin\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const CHECK_MS = 5 * 60 * 1000;
const FIRST_CHECK_MS = 60 * 1000;
const GIT_TIMEOUT_MS = 60 * 1000;
const LOG_FILE = 'autodeploy.log';

function settings(cfg, defaultCwd) {
  const a = cfg && cfg.autoDeploy;
  if (a === undefined || a === null || a === false) return { enabled: false };
  if (typeof a !== 'object' || Array.isArray(a) || typeof a.repo !== 'string' || !a.repo.trim())
    return { enabled: false, error: 'autoDeploy needs { "repo": "<path to the claude-wow checkout>" }' };
  const ref = a.ref === undefined ? DEFAULT_REF : String(a.ref).trim();
  if (!REF_RE.test(ref) || ref.includes('..')) return { enabled: false, error: `autoDeploy.ref "${ref.slice(0, 80)}" is not origin/<branch>` };
  return { enabled: true, repo: P.resolveCwd(a.repo.trim(), defaultCwd), ref };
}

function git(repo, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err)
        reject(
          new Error(
            String(stderr || err.message)
              .trim()
              .split('\n')
              .pop(),
          ),
        );
      else resolve(String(stdout).trim());
    });
  });
}

function deployedSha(home) {
  const l = REL.layout(home);
  const name = REL.currentName(l);
  const info = name ? REL.releaseInfo(l, name) : null;
  return info && typeof info.sha === 'string' ? info.sha : '';
}

function createAutoDeploy({ conf, home, log, idle, run = git, spawn = nodeSpawn, deployed = () => deployedSha(home), env = process.env }) {
  const l = REL.layout(home);
  const branch = conf.ref.slice('origin/'.length);
  const tried = new Set();
  let checking = false;

  function startDeploy(sha) {
    const logFile = path.join(home, LOG_FILE);
    const fd = fs.openSync(logFile, 'a', 0o600);
    try {
      const child = spawn(REL.currentBinary(l), ['dev', 'deploy', conf.ref, '--repo', conf.repo], {
        cwd: home,
        env: { ...env },
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      });
      if (child.unref) child.unref();
    } finally {
      fs.closeSync(fd);
    }
    log(`auto-deploy: ${conf.ref} is at ${sha.slice(0, 12)}; started claude-wow dev deploy (output in ${logFile})`);
  }

  async function check() {
    if (checking) return 'checking';
    const quiet = idle();
    if (!quiet.idle) return 'busy';
    if (fs.existsSync(l.lock)) return 'locked';
    checking = true;
    try {
      await run(conf.repo, ['fetch', '--quiet', 'origin', branch]);
      const sha = await run(conf.repo, ['rev-parse', '--verify', `${conf.ref}^{commit}`]);
      if (sha === deployed()) return 'current';
      if (tried.has(sha)) return 'tried';
      tried.add(sha);
      startDeploy(sha);
      return 'started';
    } catch (e) {
      log(`auto-deploy: check failed (${e && e.message ? e.message : e})`);
      return 'failed';
    } finally {
      checking = false;
    }
  }

  function start(timers = { setTimeout, setInterval }) {
    log(`auto-deploy: on, deploys ${conf.ref} from ${conf.repo} when it moves and the bridge is idle`);
    const first = timers.setTimeout(check, FIRST_CHECK_MS);
    const every = timers.setInterval(check, CHECK_MS);
    if (first && first.unref) first.unref();
    if (every && every.unref) every.unref();
  }

  return { check, start };
}

module.exports = { DEFAULT_REF, CHECK_MS, FIRST_CHECK_MS, LOG_FILE, settings, deployedSha, createAutoDeploy };
