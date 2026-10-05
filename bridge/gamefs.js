'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ADDON, RUNTIME_ADDON } = require('./protocol');

const GAME_MODE = 0o777;
const PERMISSION_BITS = 0o777;
const WORLD_WRITABLE = 0o002;
const ADDON_FOLDER = new RegExp(`^(${ADDON}(_S\\d{3})?|${RUNTIME_ADDON})$`);

const OWNER_ONLY = 0o600;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
const EXCLUSIVE_NEW_FILE = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
const EXISTING_ENTRY_NO_LINK = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;

const matchesGame = (platform = process.platform) => platform !== 'win32';

const sameEntry = (a, b) => a.dev === b.dev && a.ino === b.ino;

function unsafe(target, reason) {
  return Object.assign(new Error(`${target}: ${reason}`), { code: 'EUNSAFE' });
}

function realFolder(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw unsafe(dir, 'not a real folder');
  return st;
}

function openUpEntry(target, expected) {
  const fd = fs.openSync(target, EXISTING_ENTRY_NO_LINK);
  try {
    if (expected && !sameEntry(fs.fstatSync(fd), expected)) throw unsafe(target, 'changed while it was opened');
    fs.fchmodSync(fd, GAME_MODE);
  } finally {
    fs.closeSync(fd);
  }
}

function openUpFolder(dir) {
  openUpEntry(dir, realFolder(dir));
}

function writeNewTemp(file, content) {
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, EXCLUSIVE_NEW_FILE, OWNER_ONLY);
  try {
    try {
      if (matchesGame()) fs.fchmodSync(fd, GAME_MODE);
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    remove(tmp);
    throw e;
  }
  return tmp;
}

function replaceFile(file, content) {
  const dir = path.dirname(file);
  const folderBefore = realFolder(dir);
  const tmp = writeNewTemp(file, content);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    remove(tmp);
    throw e;
  }
  if (matchesGame() && !sameEntry(realFolder(dir), folderBefore)) throw unsafe(dir, 'folder was replaced during the write');
}

function missingAncestors(dir) {
  const missing = [];
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing;
}

function mkdir(dir) {
  const created = missingAncestors(dir);
  fs.mkdirSync(dir, { recursive: true });
  if (!matchesGame()) return;
  for (const d of created.reverse()) openUpFolder(d);
}

function ensureFile(file, content) {
  if (fs.existsSync(file)) return false;
  mkdir(path.dirname(file));
  replaceFile(file, content);
  return true;
}

function remove(file) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function copyFile(from, to) {
  replaceFile(to, fs.readFileSync(from));
}

function addonFolders(addonDir) {
  let names;
  try { names = fs.readdirSync(addonDir); } catch { return []; }
  return names.filter(n => ADDON_FOLDER.test(n)).sort().map(n => path.join(addonDir, n));
}

function walk(root, visit) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let st;
    try { st = fs.lstatSync(current); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    visit(current, st);
    if (!st.isDirectory()) continue;
    let entries;
    try { entries = fs.readdirSync(current); } catch { continue; }
    for (const name of entries) pending.push(path.join(current, name));
  }
}

function repair(addonDir) {
  const result = { checked: 0, fixed: 0, failed: [] };
  if (!matchesGame()) return result;
  for (const folder of addonFolders(addonDir)) {
    walk(folder, (target, st) => {
      result.checked++;
      if ((st.mode & PERMISSION_BITS) === GAME_MODE) return;
      try { openUpEntry(target, st); result.fixed++; } catch (e) { result.failed.push(`${target} (${e.code || e.message})`); }
    });
  }
  return result;
}

module.exports = { GAME_MODE, PERMISSION_BITS, WORLD_WRITABLE, ADDON_FOLDER, matchesGame, mkdir, writeFile: replaceFile, atomicWrite: replaceFile, ensureFile, remove, copyFile, addonFolders, repair };
