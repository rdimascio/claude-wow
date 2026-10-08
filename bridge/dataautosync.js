'use strict';
const D = require('./datasync');
const GD = require('./gamedata');
const PR = require('./procs');
const R = require('./runtime');

const RETRY_MS = 6 * 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 45 * 60 * 1000;
const STATE_KEY = 'dataSync';
const ATTEMPTS_KEPT = 16;
const MESSAGE_MAX = 300;
const OUTPUT_TAIL_MAX = 8192;
const SHOWN_VALUE_MAX = 40;
const FAILED_PREFIX = /^data sync failed:\s*/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function settings(cfg) {
  const data = cfg && cfg.data;
  const value = data && typeof data === 'object' && !Array.isArray(data) ? data.autoSync : undefined;
  if (value === undefined || typeof value === 'boolean') return { enabled: value !== false, note: '' };
  const shown = String(JSON.stringify(value)).slice(0, SHOWN_VALUE_MAX);
  return { enabled: true, note: `data.autoSync: ${shown} is not true or false, so it is ignored and game data sync stays on` };
}

function attemptKey(flavor, build) {
  return `${flavor}@${build}`;
}

function waiting(attempt, now) {
  return !!attempt && Number.isFinite(attempt.at) && now >= attempt.at && now - attempt.at < RETRY_MS;
}

function decide({ clientBuild, dataDir, attempts = {}, busy = new Set(), now = Date.now() }) {
  const flavor = D.flavorForBuild(clientBuild);
  if (!flavor || !dataDir) return { sync: false, reason: 'no-flavor' };
  const current = D.readCurrent(D.flavorDir(dataDir, flavor));
  const dataBuild = current ? current.build : null;
  const check = GD.buildCheckFor(clientBuild, dataBuild);
  const base = { flavor, build: clientBuild, dataBuild, check };
  if (check === GD.BUILD_CHECK.exact) return { ...base, sync: false, reason: 'exact' };
  if (busy.has(flavor)) return { ...base, sync: false, reason: 'busy' };
  const last = attempts[attemptKey(flavor, clientBuild)];
  if (waiting(last, now)) return { ...base, sync: false, reason: 'backoff', retryAt: last.at + RETRY_MS };
  return { ...base, sync: true, reason: check };
}

function prune(attempts) {
  const valid = Object.entries(attempts).filter(([, a]) => a && typeof a === 'object' && Number.isFinite(a.at));
  const kept = new Set(
    valid
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, ATTEMPTS_KEPT)
      .map(([k]) => k),
  );
  for (const k of Object.keys(attempts)) if (!kept.has(k)) delete attempts[k];
}

function lastLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(l => l.replace(UNSAFE_TEXT, ' ').trim())
    .filter(Boolean);
  const line = lines.length ? lines[lines.length - 1].replace(FAILED_PREFIX, '') : '';
  return line.slice(0, MESSAGE_MAX);
}

function syncCommand(flavor, build, runtime) {
  return R.scriptCommand('data', ['sync', '--flavor', flavor, '--build', D.assertBuild(build)], runtime);
}

function runSync({ flavor, build, home, onChild = () => {}, env = process.env, timeoutMs = RUN_TIMEOUT_MS, command, runtime, killTree = PR.killTree }) {
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
      const [file, args] = command || syncCommand(flavor, build, runtime);
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

  function record(key, entry) {
    const all = attempts();
    all[key] = entry;
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

  function switched(d) {
    const current = D.readCurrent(D.flavorDir(dataDir, d.flavor));
    return !!current && current.build === d.build;
  }

  function finish(d, key, at, result) {
    busy.delete(d.flavor);
    const claimed = !!(result && result.ok);
    const ok = claimed && switched(d);
    const message = claimed && !ok ? `the sync ended, but ${d.build} is not the current ${d.flavor} data` : (result && result.message) || '';
    record(key, ok ? { at, result: 'ok', endedAt: now() } : { at, result: 'failed', endedAt: now(), error: message.slice(0, MESSAGE_MAX) });
    if (ok) log(`data sync: ${d.flavor} ${d.build} is current; the next game data lookup uses it`);
    else
      log(
        `data sync: ${d.flavor} ${d.build} failed (${message || 'no reason given'}); the data in use stays, next try after ${new Date(at + RETRY_MS).toISOString()}`,
      );
    return { ok, message };
  }

  function observe(clientBuild, where = '') {
    if (!enabled || !dataDir || !D.isBuild(clientBuild)) return null;
    const d = decide({ clientBuild, dataDir, attempts: attempts(), busy, now: now() });
    if (!d.sync) return d;
    const key = attemptKey(d.flavor, d.build);
    const at = now();
    busy.set(d.flavor, d.build);
    record(key, { at, result: 'running' });
    const have = d.dataBuild ? `${d.flavor} data ${d.dataBuild} (${d.check})` : `no ${d.flavor} data`;
    log(`data sync: client ${d.build}${where} has ${have}; syncing ${d.flavor} ${d.build} from wago.tools in the background`);
    const done = Promise.resolve()
      .then(() => run({ flavor: d.flavor, build: d.build, home, onChild }))
      .then(
        result => finish(d, key, at, result),
        e => finish(d, key, at, { ok: false, message: e && e.message ? e.message : String(e) }),
      );
    return { ...d, done };
  }

  return { observe, children: () => [...kids], busy: () => new Map(busy) };
}

module.exports = {
  RETRY_MS,
  RUN_TIMEOUT_MS,
  STATE_KEY,
  ATTEMPTS_KEPT,
  settings,
  attemptKey,
  decide,
  prune,
  lastLine,
  syncCommand,
  runSync,
  createAutoSync,
};
