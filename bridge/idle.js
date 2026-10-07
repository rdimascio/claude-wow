'use strict';

const fs = require('fs');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_SETTLE_MS = 3000;

function idleStatus(state, { bridgeRunning = true } = {}) {
  if (!bridgeRunning) return { idle: true, reason: 'no bridge is running' };
  if (!state || typeof state !== 'object') return { idle: false, reason: 'state.json cannot be read, so the bridge may be busy' };
  const inflight = Object.values(state.inflight || {});
  if (inflight.length) {
    const ids = inflight.map(r => `#${r && r.id}`).join(', ');
    return { idle: false, reason: `${inflight.length} agent run(s) in flight (${ids})` };
  }
  const queued = Array.isArray(state.queued) ? state.queued : [];
  if (queued.length) {
    const ids = queued.map(j => `#${j && j.id}`).join(', ');
    return { idle: false, reason: `${queued.length} message(s) waiting in the queue (${ids})` };
  }
  const handling = Object.values(state.handling && typeof state.handling === 'object' ? state.handling : {});
  if (handling.length) {
    const ids = handling.map(h => `#${h && h.id}${h && h.plugin ? ' ' + h.plugin : ''}`).join(', ');
    return { idle: false, reason: `${handling.length} message(s) being handled by a plugin (${ids})` };
  }
  return { idle: true, reason: 'no agent run in flight, no plugin at work and nothing queued' };
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return e.code === 'ENOENT' ? {} : null;
  }
}

function readBridgeLock(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function bridgeRunning({ lock, pidInfo }, alive) {
  if (lock && alive(Number(lock.pid))) return true;
  return !!(pidInfo && alive(Number(pidInfo.bridgePid)));
}

function factoryRunsGoing(runsFile, alive) {
  const data = runsFile ? readState(runsFile) : {};
  if (!data) return ['runs.json cannot be read'];
  const runs = Array.isArray(data.runs) ? data.runs : [];
  return runs.filter(r => r && r.status === 'running' && alive(Number(r.pid))).map(r => String(r.id));
}

function probeFor({ stateFile, bridgeLockFile = '', runsFile = '', readPid = () => null, alive }) {
  return () => {
    const running = bridgeRunning({ lock: bridgeLockFile ? readBridgeLock(bridgeLockFile) : null, pidInfo: readPid() }, alive);
    const status = idleStatus(readState(stateFile), { bridgeRunning: running });
    if (!status.idle || !running) return status;
    const runs = factoryRunsGoing(runsFile, alive);
    return runs.length ? { idle: false, reason: `${runs.length} factory run(s) going (${runs.join(', ')})` } : status;
  };
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function formatSeconds(ms) {
  return `${Math.round(ms / 1000)} s`;
}

async function waitForIdle({
  probe,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  settleMs = DEFAULT_SETTLE_MS,
  now = Date.now,
  sleep = realSleep,
  onWait = () => {},
}) {
  const start = now();
  let idleSince = null;
  let lastReason = '';
  for (;;) {
    const s = probe();
    if (s.idle) {
      if (idleSince === null) idleSince = now();
      if (now() - idleSince >= settleMs) return { ...s, waitedMs: now() - start };
    } else {
      idleSince = null;
      if (s.reason !== lastReason) onWait(s);
    }
    lastReason = s.reason;
    if (now() - start >= timeoutMs) {
      const why = s.idle ? `it was idle for less than ${formatSeconds(settleMs)}` : s.reason;
      throw new Error(
        `the bridge did not go idle within ${formatSeconds(timeoutMs)} (${why}). Nothing was switched. Run this again when the runs finish, or pass --timeout <seconds>.`,
      );
    }
    await sleep(pollMs);
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, DEFAULT_POLL_MS, DEFAULT_SETTLE_MS, idleStatus, readState, readBridgeLock, bridgeRunning, probeFor, waitForIdle };
