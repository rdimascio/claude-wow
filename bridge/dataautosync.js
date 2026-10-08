'use strict';
const D = require('./datasync');
const GD = require('./gamedata');
const PR = require('./procs');
const R = require('./runtime');

const RETRY_MS = 6 * 60 * 60 * 1000;
const LOCKED_RETRY_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = D.LOCK_STALE_MS - 5 * 60 * 1000;
const STATE_KEY = 'dataSync';
const MESSAGE_MAX = 300;
const OUTPUT_TAIL_MAX = 8192;
const SHOWN_VALUE_MAX = 40;
const AUTO_BUILD = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,7}$/;
const FAILED_PREFIX = /^data sync failed:\s*/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function settings(cfg) {
  const data = cfg && cfg.data;
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data.autoSync : undefined;
  if (value === undefined || typeof value === 'boolean') return { enabled: value !== false, note: '' };
  const shown = String(JSON.stringify(value)).slice(0, SHOWN_VALUE_MAX);
  return { enabled: true, note: `data.autoSync: ${shown} is not true or false, so it is ignored and game data sync stays on` };
}

function isAutoBuild(build) {
  return typeof build === 'string' && AUTO_BUILD.test(build);
}

function isFlavor(name) {
  return Object.prototype.hasOwnProperty.call(D.FLAVORS, name);
}

function validAttempt(attempt) {
  return !!attempt && typeof attempt === 'object' && !Array.isArray(attempt) && Number.isFinite(attempt.at);
}

function waitFor(attempt) {
  if (attempt.result === 'ok') return 0;
  if (attempt.result === 'locked') return LOCKED_RETRY_MS;
  return RETRY_MS;
}

function waiting(attempt, now) {
  return validAttempt(attempt) && now >= attempt.at && now - attempt.at < waitFor(attempt);
}

function decide({ clientBuild, dataDir, attempts = {}, busy = new Set(), now = Date.now() }) {
  const flavor = isAutoBuild(clientBuild) ? D.flavorForBuild(clientBuild) : null;
  if (!flavor || !dataDir) return { sync: false, reason: 'no-flavor' };
  const current = D.readCurrent(D.flavorDir(dataDir, flavor));
  const dataBuild = current ? current.build : null;
  const check = GD.buildCheckFor(clientBuild, dataBuild);
  const base = { flavor, build: clientBuild, dataBuild, check };
  if (dataBuild && D.compareBuilds(clientBuild, dataBuild) <= 0)
    return { ...base, sync: false, reason: check === GD.BUILD_CHECK.exact ? 'exact' : 'not-newer' };
  if (busy.has(flavor)) return { ...base, sync: false, reason: 'busy' };
  const last = Object.prototype.hasOwnProperty.call(attempts, flavor) ? attempts[flavor] : null;
  if (waiting(last, now)) return { ...base, sync: false, reason: 'backoff', retryAt: last.at + waitFor(last) };
  return { ...base, sync: true, reason: check };
}

function prune(attempts) {
  for (const k of Object.keys(attempts)) if (!isFlavor(k) || !validAttempt(attempts[k])) delete attempts[k];
}

function lastLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.replace(UNSAFE_TEXT, ' ').trim())
    .filter(Boolean);
  const line = lines.length ? lines[lines.length - 1].replace(FAILED_PREFIX, '') : '';
  return line.slice(0, MESSAGE_MAX);
}

function syncCommand(flavor, runtime) {
  if (!isFlavor(flavor)) throw new D.SyncError(`unknown flavor ${JSON.stringify(flavor)}`);
  return R.scriptCommand('data', ['sync', '--flavor', flavor], runtime);
}

function runSync({ flavor, home, onChild = () => {}, env = process.env, timeoutMs = RUN_TIMEOUT_MS, command, runtime, killTree = PR.killTree }) {
  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    const settle = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      const [file, args] = command || syncCommand(flavor, runtime);
      child = PR.spawnChild(file, args, { env: { ...env, CLAUDE_WOW_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      settle({ ok: false, message: e && e.message ? e.message : String(e) });
      return;
    }
    onChild(child);
    let output = '';
    const take = chunk => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_MAX);
    };
    if (child.stdout) child.stdout.on('data', take);
    if (child.stderr) child.stderr.on('data', take);
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child, {});
    }, timeoutMs);
    child.on('error', e => settle({ ok: false, message: e && e.message ? e.message : String(e) }));
    child.on('close', code => {
      if (timedOut) settle({ ok: false, code, message: `no result after ${Math.round(timeoutMs / 60000)} minutes, so it was stopped` });
      else if (code === 0) settle({ ok: true, code, message: lastLine(output) });
      else settle({ ok: false, code, message: lastLine(output) || `exit code ${code}` });
    });
  });
}

function createAutoSync({ enabled = true, dataDir, home, state, save = () => {}, log = () => {}, run = runSync, now = Date.now } = {}) {
  const busy = new Map();
  const kids = new Set();

  function attempts() {
    const s = state();
    const held = s[STATE_KEY];
    if (!held || typeof held !== 'object' || Array.isArray(held)) s[STATE_KEY] = {};
    return s[STATE_KEY];
  }

  function record(flavor, entry) {
    const all = attempts();
    all[flavor] = entry;
    prune(all);
    try {
      save();
    } catch (e) {
      log(`data sync: could not save the attempt (${e && e.message ? e.message : e})`);
    }
  }

  function onChild(child) {
    kids.add(child);
    child.once('close', () => kids.delete(child));
  }

  function currentBuild(flavor) {
    const current = D.readCurrent(D.flavorDir(dataDir, flavor));
    return current ? current.build : null;
  }

  function finish(d, at, result) {
    busy.delete(d.flavor);
    const ended = !!(result && result.ok);
    const dataBuild = currentBuild(d.flavor);
    const caughtUp = ended && !!dataBuild && D.compareBuilds(dataBuild, d.build) >= 0;
    const locked = !ended && !!result && result.code === D.LOCKED_EXIT;
    const outcome = caughtUp ? 'ok' : ended ? 'behind' : locked ? 'locked' : 'failed';
    const message =
      outcome === 'behind'
        ? `wago.tools lists no ${d.flavor} ${D.FLAVORS[d.flavor].family} build as new as the client's ${d.build}; the data in use stays at ${dataBuild || 'none'}`
        : (result && result.message) || '';
    const entry = { build: d.build, at, result: outcome, endedAt: now() };
    if (dataBuild) entry.dataBuild = dataBuild;
    if (!caughtUp) entry.error = message.slice(0, MESSAGE_MAX);
    record(d.flavor, entry);
    const next = new Date(at + waitFor(entry)).toISOString();
    if (outcome === 'ok') log(`data sync: ${d.flavor} ${dataBuild} is current; the next game data lookup uses it`);
    else if (outcome === 'behind') log(`data sync: ${message}, next try after ${next}`);
    else if (locked) log(`data sync: ${d.flavor} waits, another data sync holds the lock (${message || 'no reason given'}); next try after ${next}`);
    else log(`data sync: ${d.flavor} failed (${message || 'no reason given'}); the data in use stays, next try after ${next}`);
    return { ok: caughtUp, build: dataBuild, message };
  }

  function observe(clientBuild, where = '') {
    if (!enabled || !dataDir || !isAutoBuild(clientBuild)) return null;
    const d = decide({ clientBuild, dataDir, attempts: attempts(), busy, now: now() });
    if (!d.sync) return d;
    const at = now();
    busy.set(d.flavor, d.build);
    record(d.flavor, { build: d.build, at, result: 'running' });
    const have = d.dataBuild ? `${d.flavor} data ${d.dataBuild} (${d.check})` : `no ${d.flavor} data`;
    log(`data sync: client ${d.build}${where} has ${have}; syncing the newest ${d.flavor} build from wago.tools in the background`);
    const done = Promise.resolve()
      .then(() => run({ flavor: d.flavor, home, onChild }))
      .then(
        result => finish(d, at, result),
        e => finish(d, at, { ok: false, message: e && e.message ? e.message : String(e) }),
      );
    return { ...d, done };
  }

  return { observe, children: () => [...kids], busy: () => new Map(busy) };
}

module.exports = {
  RETRY_MS,
  LOCKED_RETRY_MS,
  RUN_TIMEOUT_MS,
  STATE_KEY,
  settings,
  isAutoBuild,
  decide,
  prune,
  lastLine,
  syncCommand,
  runSync,
  createAutoSync,
};
