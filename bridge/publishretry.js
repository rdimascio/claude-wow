'use strict';

const SHARING_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200]);
const REPUBLISH_SOON_MS = 1500;

const isSharingError = (e, platform = process.platform) => platform === 'win32' && !!e && SHARING_CODES.has(e.code);

const systemTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t) };

function createPublishRetry({
  write,
  log,
  republish,
  platform = process.platform,
  timers = systemTimers,
  delays = RETRY_DELAYS_MS,
  republishMs = REPUBLISH_SOON_MS,
}) {
  const pending = new Map();
  const incidents = new Map();

  const isTransient = e => isSharingError(e, platform);

  function supersede(key) {
    if (!pending.has(key)) return;
    timers.clearTimeout(pending.get(key));
    pending.delete(key);
  }

  function later(key, ms, fn) {
    pending.set(
      key,
      timers.setTimeout(() => {
        pending.delete(key);
        fn();
      }, ms),
    );
  }

  function writeAgain(files) {
    const left = [];
    for (const f of files) {
      try {
        write(f.file, f.content);
      } catch (e) {
        if (isTransient(e)) left.push({ ...f, code: e.code });
      }
    }
    return left;
  }

  function exhausted(key, label, files) {
    const incident = incidents.get(key);
    const soon = !incident.republished;
    if (!incident.logged) {
      incident.logged = true;
      const codes = [...new Set(files.map(f => f.code))].join('/');
      log(
        `publish${label}: ${files.length} file(s) still locked by another program (${codes}) after ${delays.length} retries: ${files.map(f => f.file).join(', ')}; ${soon ? `writing them again in ${republishMs / 1000} s` : 'the next regular publish writes them'}`,
      );
    }
    if (!soon) return;
    incident.republished = true;
    later(key, republishMs, () => republish(key));
  }

  function retry(key, label, files, step) {
    later(key, delays[step], () => {
      const left = writeAgain(files);
      if (!left.length) incidents.delete(key);
      else if (step + 1 < delays.length) retry(key, label, left, step + 1);
      else exhausted(key, label, left);
    });
  }

  function settle(key, failed, label = '') {
    supersede(key);
    if (!failed.length) {
      incidents.delete(key);
      return;
    }
    if (!incidents.has(key)) incidents.set(key, { logged: false, republished: false });
    retry(key, label, failed, 0);
  }

  function begin(key) {
    const locked = [];
    return {
      write(file, content) {
        try {
          write(file, content);
          return null;
        } catch (e) {
          if (isTransient(e)) locked.push({ file, content, code: e.code });
          return e;
        }
      },
      locked: () => locked.length,
      end: (label = '') => settle(key, locked, label),
    };
  }

  return { isTransient, supersede, settle, begin, pendingFor: key => pending.has(key) };
}

module.exports = { createPublishRetry, isSharingError, SHARING_CODES, RETRY_DELAYS_MS, REPUBLISH_SOON_MS };
