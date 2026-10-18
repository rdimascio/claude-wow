'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function tempNameFor(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

function removeQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch {}
}

function atomicWrite(file, content, { mode, fsync = false } = {}) {
  const tmp = tempNameFor(file);
  try {
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      if (mode !== undefined && process.platform !== 'win32') fs.fchmodSync(fd, mode);
      fs.writeSync(fd, content);
      if (fsync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    removeQuiet(tmp);
    throw e;
  }
}

function readJson(file, fallback, { log = null, moveAside = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (log && e.code !== 'ENOENT') log(`${path.basename(file)}: cannot read it (${e.code || e.message}); starting from empty`);
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    if (!moveAside) {
      if (log) log(`${path.basename(file)} is not JSON (${e.message}); starting from empty`);
      return fallback;
    }
    const aside = `${file}.corrupt-${Date.now()}`;
    let kept = true;
    try {
      fs.renameSync(file, aside);
    } catch {
      kept = false;
    }
    if (log)
      log(
        `${path.basename(file)} is corrupt (${e.message}); ${kept ? `kept it as ${path.basename(aside)}` : 'could not move it aside'} and started from empty. To recover, stop the bridge, repair that copy, and put it back as ${path.basename(file)}.`,
      );
    return fallback;
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { atomicWrite, readJson, pidAlive, isDirectory };
