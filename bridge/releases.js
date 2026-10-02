'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const H = require('./home');

const BINARY = process.platform === 'win32' ? 'claude-wow.exe' : 'claude-wow';
const RELEASES_DIR = 'releases';
const KEEP_RELEASES = 5;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const LOCK_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const UNREADABLE_LOCK_GRACE_MS = 60 * 1000;
const RELEASE_INFO = 'release.json';

function layout(base = H.resolve().dir) {
  return {
    base,
    releases: path.join(base, RELEASES_DIR),
    current: path.join(base, 'current'),
    previous: path.join(base, 'previous'),
    lock: path.join(base, 'deploy.lock'),
    state: path.join(base, 'state.json'),
    config: path.join(base, 'config.json'),
  };
}

const releaseDir = (l, name) => path.join(l.releases, name);
const releaseBinary = (l, name) => path.join(releaseDir(l, name), BINARY);
const currentBinary = l => path.join(l.current, BINARY);

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function validName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

function checkName(name) {
  if (!validName(name)) throw new Error(`"${name}" is not a usable release name (letters, digits, dot, dash, plus, underscore; it must start with a letter or digit)`);
  return name;
}

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isInsideReleases(l, file) {
  if (!file) return false;
  const rel = path.relative(realOrResolved(l.releases), realOrResolved(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function currentName(l) {
  let target;
  try { target = fs.readlinkSync(l.current); } catch { return ''; }
  const resolved = path.resolve(l.base, target);
  if (path.dirname(resolved) !== path.resolve(l.releases)) return '';
  const name = path.basename(resolved);
  return validName(name) ? name : '';
}

function previousName(l) {
  let text;
  try { text = fs.readFileSync(l.previous, 'utf8').trim(); } catch { return ''; }
  return validName(text) ? text : '';
}

function hasRelease(l, name) {
  return validName(name) && isFile(releaseBinary(l, name));
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

function installRelease(l, { name, binaryFile, meta = {}, now = Date.now }) {
  checkName(name);
  if (hasRelease(l, name) && !binaryFile) return { name, dir: releaseDir(l, name), reused: true };
  if (!binaryFile || !isFile(binaryFile)) throw new Error(`no binary to install for release ${name}${binaryFile ? ` (${binaryFile} is missing)` : ''}`);
  fs.mkdirSync(l.releases, { recursive: true });
  const staging = path.join(l.releases, `.staging-${name}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(staging);
  try {
    const staged = path.join(staging, BINARY);
    fs.copyFileSync(binaryFile, staged);
    fs.chmodSync(staged, 0o755);
    fs.writeFileSync(path.join(staging, RELEASE_INFO), JSON.stringify({ ...meta, name, installedAt: now() }, null, 2) + '\n');
    const dir = releaseDir(l, name);
    if (fs.existsSync(dir)) {
      if (name === currentName(l)) throw new Error(`release ${name} is the current release; it is not replaced in place`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.renameSync(staging, dir);
    return { name, dir, reused: false };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

function pointCurrentAt(l, name) {
  checkName(name);
  if (!hasRelease(l, name)) throw new Error(`release ${name} has no ${BINARY} in ${releaseDir(l, name)}`);
  const tmp = `${l.current}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.symlinkSync(path.join(RELEASES_DIR, name), tmp);
  try { fs.renameSync(tmp, l.current); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

function activate(l, name) {
  checkName(name);
  const was = currentName(l);
  if (was === name) return { name, previous: previousName(l), changed: false };
  pointCurrentAt(l, name);
  if (was) writeAtomic(l.previous, was + '\n');
  return { name, previous: was, changed: true };
}

function rollback(l) {
  const prev = previousName(l);
  if (!prev) throw new Error(`no previous release is recorded in ${l.previous}`);
  if (!hasRelease(l, prev)) throw new Error(`the previous release ${prev} is gone from ${l.releases}`);
  const was = currentName(l);
  if (was === prev) throw new Error(`the previous release ${prev} is already current`);
  return activate(l, prev);
}

function releaseTime(l, name) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(releaseDir(l, name), RELEASE_INFO), 'utf8'));
    if (Number.isFinite(info.installedAt)) return info.installedAt;
  } catch {}
  try { return fs.statSync(releaseDir(l, name)).mtimeMs; } catch { return 0; }
}

function listReleases(l) {
  let names;
  try { names = fs.readdirSync(l.releases); } catch { return []; }
  return names
    .filter(n => validName(n) && fs.statSync(releaseDir(l, n)).isDirectory())
    .map(n => ({ name: n, installedAt: releaseTime(l, n) }))
    .sort((a, b) => b.installedAt - a.installedAt || (a.name < b.name ? 1 : -1));
}

function prune(l, keep = KEEP_RELEASES) {
  const current = currentName(l);
  if (!current) return { removed: [], skipped: 'current does not point at a release' };
  const protectedNames = new Set([current, previousName(l)].filter(Boolean));
  const all = listReleases(l);
  const kept = new Set(all.slice(0, Math.max(0, keep)).map(r => r.name));
  const removed = [];
  for (const r of all) {
    if (kept.has(r.name) || protectedNames.has(r.name)) continue;
    fs.rmSync(releaseDir(l, r.name), { recursive: true, force: true });
    removed.push(r.name);
  }
  return { removed, skipped: '' };
}

async function installAndActivate(l, { name, binaryFile, meta, keep = KEEP_RELEASES, now }, { waitIdle } = {}) {
  const installed = installRelease(l, { name, binaryFile, meta, now });
  if (waitIdle) await waitIdle();
  const flip = activate(l, name);
  const pruned = prune(l, keep);
  return { ...installed, ...flip, pruned: pruned.removed };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readLock(file) {
  let text = '', mtimeMs = 0;
  try { text = fs.readFileSync(file, 'utf8'); mtimeMs = fs.statSync(file).mtimeMs; } catch { return null; }
  try {
    const v = JSON.parse(text);
    return { pid: Number(v.pid) || 0, host: String(v.host || ''), started: Number(v.started) || 0, command: String(v.command || ''), mtimeMs };
  } catch { return { pid: 0, host: '', started: 0, command: '', mtimeMs }; }
}

function lockIsStale(held, { alive, now, host, maxAgeMs }) {
  if (!held) return true;
  if (!held.pid) return now() - held.mtimeMs > UNREADABLE_LOCK_GRACE_MS;
  if (held.host && held.host !== host) return now() - held.started > maxAgeMs;
  if (!alive(held.pid)) return true;
  return now() - held.started > maxAgeMs;
}

function heldMessage(file, held) {
  const since = held && held.started ? new Date(held.started).toISOString() : 'an unknown time';
  const who = held && held.pid ? `pid ${held.pid}${held.command ? ` (${held.command})` : ''}` : 'a process that has not written its pid yet';
  return `another deploy holds ${file}: ${who}, since ${since}. Wait for it to finish; if that process is gone, delete ${file} and run this again.`;
}

function acquireLock(file, { pid = process.pid, command = '', alive = pidAlive, now = Date.now, host = os.hostname(), maxAgeMs = LOCK_MAX_AGE_MS } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ pid, host, started: now(), command });
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readLock(file);
      if (!held) continue;
      if (!lockIsStale(held, { alive, now, host, maxAgeMs })) throw new Error(heldMessage(file, held));
      const aside = `${file}.stale-${pid}-${crypto.randomBytes(4).toString('hex')}`;
      try { fs.renameSync(file, aside); } catch (re) { if (re.code === 'ENOENT') continue; throw re; }
      const moved = readLock(aside);
      if (!moved || moved.pid !== held.pid || moved.started !== held.started) {
        try { fs.linkSync(aside, file); } catch {}
        try { fs.unlinkSync(aside); } catch {}
        throw new Error(heldMessage(file, moved));
      }
      fs.unlinkSync(aside);
      continue;
    }
    try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
    return { file, pid, staleRemoved: attempt > 0, release: () => releaseLock(file, pid) };
  }
  throw new Error(`could not take ${file}; run this again`);
}

function releaseLock(file, pid = process.pid) {
  const held = readLock(file);
  if (!held || held.pid !== pid) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

module.exports = {
  BINARY, RELEASES_DIR, KEEP_RELEASES, LOCK_MAX_AGE_MS, RELEASE_INFO,
  layout, releaseDir, releaseBinary, currentBinary, validName, checkName, isInsideReleases,
  currentName, previousName, hasRelease, installRelease, pointCurrentAt, activate, rollback,
  listReleases, prune, installAndActivate,
  pidAlive, readLock, acquireLock, releaseLock,
};
