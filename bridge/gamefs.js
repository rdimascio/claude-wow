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
const WRITABLE_ENTRY_NO_LINK = O_WRONLY | O_NOFOLLOW | O_NONBLOCK;

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

const sharedFile = st => st.isFile() && st.nlink > 1;

function openEntryNoLink(target) {
  try {
    return fs.openSync(target, EXISTING_ENTRY_NO_LINK);
  } catch (unreadable) {
    if (unreadable.code !== 'EACCES') throw unreadable;
    try {
      return fs.openSync(target, WRITABLE_ENTRY_NO_LINK);
    } catch {
      throw unreadable;
    }
  }
}

function openUpEntry(target, expected) {
  const fd = openEntryNoLink(target);
  try {
    const st = fs.fstatSync(fd);
    if (expected && !sameEntry(st, expected)) throw unsafe(target, 'changed while it was opened');
    if (sharedFile(st)) throw unsafe(target, 'hard link');
    fs.fchmodSync(fd, GAME_MODE);
  } finally {
    fs.closeSync(fd);
  }
}

function openUpFolder(dir) {
  openUpEntry(dir, realFolder(dir));
}

function writeExclusive(target, content) {
  const fd = fs.openSync(target, EXCLUSIVE_NEW_FILE, OWNER_ONLY);
  try {
    try {
      if (matchesGame()) fs.fchmodSync(fd, GAME_MODE);
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    remove(target);
    throw e;
  }
}

function createIfMissing(target, content) {
  try {
    writeExclusive(target, content);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

function writeNewTemp(file, content) {
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  writeExclusive(tmp, content);
  return tmp;
}

function renameOver(file, content) {
  const tmp = writeNewTemp(file, content);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    remove(tmp);
    throw e;
  }
}

function checkFolderKept(dir, folderBefore) {
  if (matchesGame() && !sameEntry(realFolder(dir), folderBefore)) throw unsafe(dir, 'folder was replaced during the write');
}

function replaceFile(file, content) {
  const dir = path.dirname(file);
  const folderBefore = realFolder(dir);
  renameOver(file, content);
  checkFolderKept(dir, folderBefore);
}

function asBuffer(content) {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

function keepIfSame(file, wanted) {
  let fd;
  try {
    fd = fs.openSync(file, EXISTING_ENTRY_NO_LINK);
  } catch (e) {
    return e.code === 'ENOENT' ? 'missing' : 'differs';
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || sharedFile(st) || st.size !== wanted.length) return 'differs';
    if (!fs.readFileSync(fd).equals(wanted)) return 'differs';
    if (!matchesGame() || (st.mode & PERMISSION_BITS) === GAME_MODE) return 'same';
    try {
      fs.fchmodSync(fd, GAME_MODE);
      return 'same';
    } catch {
      return 'differs';
    }
  } finally {
    fs.closeSync(fd);
  }
}

function writeFile(file, content) {
  const dir = path.dirname(file);
  const folderBefore = realFolder(dir);
  const wanted = asBuffer(content);
  const found = keepIfSame(file, wanted);
  if (found === 'same') return false;
  if (found !== 'missing' || !createIfMissing(file, wanted)) renameOver(file, wanted);
  checkFolderKept(dir, folderBefore);
  return true;
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

function folderFor(file) {
  const dir = path.dirname(file);
  try {
    return realFolder(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  mkdir(dir);
  return realFolder(dir);
}

function ensureFile(file, content) {
  if (fs.existsSync(file)) return false;
  const folderBefore = folderFor(file);
  if (!createIfMissing(file, content)) return false;
  checkFolderKept(path.dirname(file), folderBefore);
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
  return writeFile(to, fs.readFileSync(from));
}

function addonFolders(addonDir) {
  let names;
  try {
    names = fs.readdirSync(addonDir);
  } catch {
    return [];
  }
  return names
    .filter(n => ADDON_FOLDER.test(n))
    .sort()
    .map(n => path.join(addonDir, n));
}

function walk(root, visit) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let st;
    try {
      st = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    visit(current, st);
    if (!st.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      continue;
    }
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
      try {
        openUpEntry(target, st);
        result.fixed++;
      } catch (e) {
        result.failed.push(`${target} (${e.code || e.message})`);
      }
    });
  }
  return result;
}

function publishFailureNote(file, label, e) {
  if (e.code === 'EUNSAFE') return `publish: refused to write ${file} in ${label}: ${e.message}`;
  return `publish: cannot write ${file} (${e.code || e.message}); addon not installed in ${label}? run: node setup.js, then restart WoW`;
}

module.exports = {
  GAME_MODE,
  PERMISSION_BITS,
  WORLD_WRITABLE,
  ADDON_FOLDER,
  matchesGame,
  mkdir,
  writeFile,
  atomicWrite: replaceFile,
  ensureFile,
  remove,
  copyFile,
  addonFolders,
  repair,
  publishFailureNote,
};
