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
const STATE_FILE = 'autodeploy.json';
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
const DEPLOY_SCRIPT = '"$1" dev deploy "$2" --repo "$3"; code=$?; printf \'{"sha":"%s","exit":%d}\\n\' "$5" "$code" > "$4.tmp" && mv "$4.tmp" "$4"';

function settings(cfg, defaultCwd) {
  const a = cfg && cfg.autoDeploy;
  if (a === undefined || a === null || a === false) return { enabled: false };
  if (typeof a !== 'object' || Array.isArray(a) || typeof a.repo !== 'string' || !a.repo.trim())
    return { enabled: false, error: 'autoDeploy needs { "repo": "<path to the claude-wow checkout>" }' };
  const ref = a.ref === undefined ? DEFAULT_REF : String(a.ref).trim();
  if (!REF_RE.test(ref) || ref.includes('..')) return { enabled: false, error: `autoDeploy.ref "${ref.slice(0, 80)}" is not origin/<branch>` };
  return { enabled: true, repo: P.resolveCwd(a.repo.trim(), defaultCwd), ref };
}

function eligible({ home, platform = process.platform, compiled, env = process.env }) {
  if (platform !== 'darwin') return { ok: false, why: 'macOS only: on Linux systemd would stop the deploy with the service before setup runs' };
  if (!compiled || env.CLAUDE_WOW_SERVICE !== '1') return { ok: false, why: 'it runs only in the background service (claude-wow service)' };
  const l = REL.layout(home);
  const name = REL.currentName(l);
  const info = name && REL.hasRelease(l, name) ? REL.releaseInfo(l, name) : null;
  if (!info || info.source !== REL.SOURCE_DEV_DEPLOY) return { ok: false, why: 'the service does not run a release made by claude-wow dev deploy' };
  return { ok: true };
}

function git(repo, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, ...GIT_ENV } }, (err, stdout, stderr) => {
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

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function createAutoDeploy({ conf, home, log, idle, run = git, spawn = nodeSpawn, deployed = () => deployedSha(home), lockHolder = REL.liveLockHolder }) {
  const l = REL.layout(home);
  const stateFile = path.join(home, STATE_FILE);
  const logFile = path.join(home, LOG_FILE);
  const branch = conf.ref.slice('origin/'.length);
  const repoReal = realFolder(conf.repo);
  let checking = false;
  let lastError = '';

  function startDeploy(sha) {
    writeJson(stateFile, { sha });
    const fd = fs.openSync(logFile, 'a', 0o600);
    try {
      const child = spawn('/bin/sh', ['-c', DEPLOY_SCRIPT, 'claude-wow-autodeploy', REL.currentBinary(l), conf.ref, conf.repo, stateFile, sha], {
        cwd: home,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      child.on('error', e => log(`auto-deploy: could not start the deploy (${e.message})`));
      child.unref();
    } finally {
      fs.closeSync(fd);
    }
    log(`auto-deploy: ${conf.ref} is at ${sha.slice(0, 12)}; started claude-wow dev deploy (output in ${logFile})`);
  }

  async function check() {
    if (checking) return 'checking';
    if (!idle().idle) return 'busy';
    if (lockHolder(l.lock)) return 'locked';
    checking = true;
    try {
      await run(conf.repo, ['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      const sha = await run(conf.repo, ['rev-parse', '--verify', `${conf.ref}^{commit}`]);
      lastError = '';
      const last = readJson(stateFile);
      if (last.sha === sha) return 'seen';

      if (!last.sha && sha === deployed()) {
        writeJson(stateFile, { sha, exit: 0 });
        return 'current';
      }
      startDeploy(sha);
      return 'started';
    } catch (e) {
      const why = e && e.message ? e.message : String(e);
      if (why !== lastError) log(`auto-deploy: check failed (${why})`);
      lastError = why;
      return 'failed';
    } finally {
      checking = false;
    }
  }

  function failureNote(cwd) {
    if (!cwd || realFolder(cwd) !== repoReal) return '';
    const last = readJson(stateFile);
    if (!last.sha || !Number.isInteger(last.exit) || last.exit === 0 || last.reported) return '';
    writeJson(stateFile, { ...last, reported: true });
    return `[claude-wow bridge] The automatic deploy of ${conf.ref} at ${String(last.sha).slice(0, 12)} failed (exit ${last.exit}), so that merge is not live in the game. Tell the player in one line. The deploy output is in ${logFile}. The next merge to ${conf.ref} deploys again.`;
  }

  function start(timers = { setTimeout, setInterval }) {
    log(`auto-deploy: on, deploys ${conf.ref} from ${conf.repo} when it moves and the bridge is idle`);
    const first = timers.setTimeout(check, FIRST_CHECK_MS);
    const every = timers.setInterval(check, CHECK_MS);
    if (first && first.unref) first.unref();
    if (every && every.unref) every.unref();
  }

  return { check, failureNote, start };
}

function realFolder(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

module.exports = { DEFAULT_REF, CHECK_MS, FIRST_CHECK_MS, LOG_FILE, STATE_FILE, settings, eligible, deployedSha, createAutoDeploy };
