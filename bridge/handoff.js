'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SS = require('./sessions');
const H = require('./home');

const FILE_NAME = 'handoff.json';
const FRESH_MS = 24 * 3600 * 1000;
const SESSIONS_MAX = 24;
const ASKED_MAX = 120;
const ANSWERED_MAX = 200;
const TITLE_MAX = 60;
const TAIL_BYTES = 512 * 1024;
const STOP_WAIT_MS = 15000;
const STOP_POLL_MS = 250;
const GIT_TIMEOUT_MS = 5000;
const PS_TIMEOUT_MS = 3000;
const START_TOLERANCE_MS = 2000;
const ANCESTORS_MAX = 12;
const IDLE = 'idle';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneLine(text, max) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function repoKey(dir, exec = execFileSync) {
  const abs = path.resolve(String(dir || '.'));
  try {
    const out = exec('git', ['-C', abs, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return fs.realpathSync(out);
  } catch {}
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

function psField(pid, field, exec = execFileSync) {
  if (process.platform === 'win32') return null;
  try {
    return exec('ps', ['-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const startTimeOf = (pid, exec) => psField(pid, 'lstart', exec);

const squash = s =>
  String(s || '')
    .replace(/\s+/g, ' ')
    .trim();

function sameStart(a, b) {
  if (squash(a) === squash(b)) return true;
  const ta = Date.parse(`${squash(a)} UTC`);
  const tb = Date.parse(`${squash(b)} UTC`);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= START_TOLERANCE_MS;
}

function processState(info, { alive = pidAlive, startOf = startTimeOf } = {}) {
  if (!alive(info.pid)) return 'gone';
  if (!info.procStart) return 'unverified';
  const now = startOf(info.pid);
  if (now === null || now === '') return 'unverified';
  return sameStart(now, info.procStart) ? 'same' : 'gone';
}

function ancestorsOf(pid, { parentOf = p => Number(psField(p, 'ppid')) } = {}) {
  const out = [];
  let cur = Number(pid);
  for (let i = 0; i < ANCESTORS_MAX && Number.isInteger(cur) && cur > 1; i++) {
    out.push(cur);
    const next = parentOf(cur);
    if (!Number.isInteger(next) || next === cur) break;
    cur = next;
  }
  return out;
}

function runningSessions(claudeDir, deps = {}) {
  const dir = path.join(claudeDir, 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    } catch {
      continue;
    }
    if (!info || typeof info !== 'object') continue;
    const pid = Number(info.pid || n.slice(0, -5));
    const id = String(info.sessionId || '');
    if (!Number.isInteger(pid) || pid <= 0 || !SESSION_ID_RE.test(id) || !info.cwd) continue;
    if (info.kind && info.kind !== 'interactive') continue;
    const proc = processState({ pid, procStart: info.procStart }, deps);
    if (proc === 'gone') continue;
    out.push({
      pid,
      id,
      cwd: String(info.cwd),
      name: oneLine(info.name || '', TITLE_MAX),
      startedAt: Number(info.startedAt) || 0,
      procStart: String(info.procStart || ''),
      status: String(info.status || ''),
      verified: proc === 'same',
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(p => p && p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text)
    .join('\n');
}

function lastExchange(file) {
  let text = '';
  try {
    text = SS.readTail(file, TAIL_BYTES);
  } catch {
    return { asked: '', answered: '' };
  }
  let asked = '';
  let answered = '';
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (!ev || !ev.message || ev.isMeta || ev.isSidechain) continue;
    const body = textOf(ev.message.content).trim();
    if (!body) continue;
    if (ev.type === 'user' && !body.startsWith('<')) {
      asked = body;
      answered = '';
    } else if (ev.type === 'assistant') answered = body;
  }
  return { asked: oneLine(asked, ASKED_MAX), answered: oneLine(answered, ANSWERED_MAX) };
}

function branchOf(cwd) {
  try {
    return SS.gitBranch(cwd);
  } catch {
    return '';
  }
}

function selfPids(env, deps = {}) {
  const pids = new Set();
  const claudePid = Number(env.CLAUDE_PID);
  if (Number.isInteger(claudePid) && claudePid > 0) pids.add(claudePid);
  const ancestors = deps.ancestors || (pid => ancestorsOf(pid));
  for (const p of ancestors(process.ppid)) pids.add(p);
  return pids;
}

function buildHandoff({ claudeDir, folder, selfId = '', selfPidSet = new Set(), now = Date.now(), deps = {} }) {
  const want = repoKey(folder, deps.exec);
  const keys = new Map();
  const keyOf = cwd => {
    if (!keys.has(cwd)) keys.set(cwd, repoKey(cwd, deps.exec));
    return keys.get(cwd);
  };
  const sessions = runningSessions(claudeDir, deps)
    .filter(s => keyOf(s.cwd) === want)
    .slice(0, SESSIONS_MAX)
    .map(s => {
      const file = SS.sessionFileFor(claudeDir, s.id, s.cwd);
      const title = (file && SS.sessionTitle(file)) || s.name || (file && SS.firstPrompt(file)) || '';
      const recap = file ? lastExchange(file) : { asked: '', answered: '' };
      const self = (!!selfId && s.id === selfId) || selfPidSet.has(s.pid);
      return {
        id: s.id,
        pid: s.pid,
        procStart: s.procStart,
        status: s.status,
        verified: s.verified,
        cwd: s.cwd,
        branch: branchOf(s.cwd),
        title: oneLine(title, TITLE_MAX),
        startedAt: s.startedAt,
        self,
        ...recap,
      };
    });
  return { at: now, repo: want, folder: path.resolve(folder), claudeDir: path.resolve(claudeDir), sessions };
}

function fileIn(homeDir) {
  return path.join(homeDir, FILE_NAME);
}

function writeHandoff(homeDir, handoff) {
  fs.mkdirSync(homeDir, { recursive: true });
  const file = fileIn(homeDir);
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(handoff, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

function cleanEntry(s) {
  return {
    id: String(s.id),
    cwd: s.cwd,
    branch: oneLine(s.branch, 80),
    title: oneLine(s.title, TITLE_MAX),
    asked: oneLine(s.asked, ASKED_MAX),
    answered: oneLine(s.answered, ANSWERED_MAX),
    startedAt: Number(s.startedAt) || 0,
    pid: Number.isInteger(s.pid) && s.pid > 0 ? s.pid : 0,
    procStart: typeof s.procStart === 'string' ? s.procStart : '',
  };
}

function readHandoff(homeDir, now = Date.now()) {
  let h;
  try {
    h = JSON.parse(fs.readFileSync(fileIn(homeDir), 'utf8'));
  } catch {
    return null;
  }
  if (!h || typeof h !== 'object' || !Array.isArray(h.sessions)) return null;
  const at = Number(h.at);
  if (!Number.isFinite(at) || now - at > FRESH_MS || at - now > FRESH_MS) return null;
  const sessions = h.sessions
    .filter(s => s && typeof s === 'object' && SESSION_ID_RE.test(String(s.id || '')) && typeof s.cwd === 'string' && s.cwd)
    .slice(0, SESSIONS_MAX)
    .map(cleanEntry);
  return { at, repo: typeof h.repo === 'string' ? h.repo : '', claudeDir: typeof h.claudeDir === 'string' ? h.claudeDir : '', sessions };
}

function mergeEarlier(fresh, earlier) {
  if (!earlier || earlier.repo !== fresh.repo) return fresh;
  const ids = new Set(fresh.sessions.map(s => s.id));
  const kept = earlier.sessions.filter(s => !ids.has(s.id)).map(s => ({ ...s, pid: 0, procStart: '' }));
  return { ...fresh, sessions: [...fresh.sessions, ...kept].slice(0, SESSIONS_MAX) };
}

function recapOf(s) {
  const parts = [];
  if (s.asked) parts.push(`Last ask: ${s.asked}`);
  if (s.answered) parts.push(`Last answer: ${s.answered}`);
  return parts.join('\n');
}

function stillRunning(s, deps = {}) {
  if (!s.pid) return false;
  return processState({ pid: s.pid, procStart: s.procStart }, deps) !== 'gone';
}

function slotEntries(handoff, { running = () => false } = {}) {
  if (!handoff) return [];
  return handoff.sessions.map(s => {
    const e = {
      id: s.id,
      name: s.title || s.id.slice(0, 8),
      title: s.title,
      cwd: s.cwd,
      agent: 'claude',
      branch: s.branch,
      at: Math.floor((s.startedAt || handoff.at) / 1000),
      handoff: true,
      recap: recapOf(s),
    };
    if (running(s)) e.running = true;
    return e;
  });
}

function withHandoff(merged, entries) {
  if (!entries.length) return merged;
  const byId = new Map(merged.map(s => [s.id, s]));
  const first = entries.map(e => {
    const known = byId.get(e.id);
    return known ? { ...e, ...known, handoff: true, recap: e.recap, title: known.title || e.title, running: !!(known.running || e.running) } : e;
  });
  const ids = new Set(entries.map(e => e.id));
  return [...first, ...merged.filter(s => !ids.has(s.id))];
}

function waitGone(pids, { timeoutMs = STOP_WAIT_MS, alive = pidAlive } = {}) {
  const until = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const tick = () => {
      const left = pids.filter(p => alive(p));
      if (!left.length || Date.now() >= until) return resolve(left);
      setTimeout(tick, STOP_POLL_MS);
    };
    tick();
  });
}

function ago(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

function describe(h, now = Date.now()) {
  if (!h.sessions.length) return `No running Claude Code session in ${h.folder} or its worktrees.`;
  const lines = [`${h.sessions.length} Claude Code session${h.sessions.length === 1 ? '' : 's'} in this repository:`];
  h.sessions.forEach((s, i) => {
    const notes = [s.self && 'this session', s.status && s.status !== IDLE && s.status, s.pid && s.verified === false && 'start time not verified'].filter(
      Boolean,
    );
    lines.push(`${String(i + 1).padStart(2)}. ${s.title || '(untitled)'}${notes.length ? `  [${notes.join(', ')}]` : ''}`);
    lines.push(
      `    ${s.id}${s.pid ? `  pid ${s.pid}` : '  (stopped earlier)'}  ${s.cwd}${s.branch ? ' @ ' + s.branch : ''}  started ${s.startedAt ? ago(now - s.startedAt) + ' ago' : '?'}`,
    );
    if (s.answered || s.asked) lines.push(`    ${oneLine(s.answered || s.asked, 110)}`);
  });
  return lines.join('\n');
}

function stoppable(s, { force = false, platform = process.platform } = {}) {
  if (s.self || !s.pid) return { ok: false, why: '' };
  if (platform === 'win32') return { ok: false, why: 'Windows: quit it in its terminal' };
  if (!s.verified) return { ok: false, why: 'its start time could not be checked, so the pid may belong to another program' };
  if (s.status !== IDLE && !force) return { ok: false, why: `it is ${s.status || 'in an unknown state'}; let it finish or use --force` };
  return { ok: true, why: '' };
}

function configuredClaudeDir(homeDir, env) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')) || {};
  } catch {}
  return SS.claudeDir(env, typeof cfg.claudeDir === 'string' ? cfg.claudeDir : '');
}

const OPTIONS = ['--stop', '--force', '--json'];

const USAGE = [
  'claude-wow handoff [folder] [--stop [--force]] [--json]',
  '',
  "Lists the Claude Code sessions running in the folder's repository (its worktrees too),",
  "with each one's last ask and answer, and saves the list in the home folder for the game.",
  'In game, /claude -r all then opens one chat per session that is no longer running.',
  'Running it again adds to the list saved in the last 24 hours.',
  '',
  '  --stop   end the idle sessions (SIGTERM) after saving the list. A busy session, one whose',
  '           start time cannot be checked, and the session that runs this command are left alone.',
  '  --force  with --stop, also end busy sessions (their turn in progress is lost).',
  '  --json   print the saved list as JSON',
].join('\n');

async function main(
  argv,
  {
    out = s => process.stdout.write(s + '\n'),
    err = s => process.stderr.write(s + '\n'),
    env = process.env,
    cwd = process.cwd(),
    home,
    deps = {},
    platform = process.platform,
  } = {},
) {
  if (argv.includes('--help') || argv.includes('-h')) {
    out(USAGE);
    return 0;
  }
  const unknown = argv.filter(a => a.startsWith('-') && !OPTIONS.includes(a));
  if (unknown.length) {
    err(`unknown option ${unknown[0]}\n\n${USAGE}`);
    return 2;
  }
  const folders = argv.filter(a => !a.startsWith('-'));
  if (folders.length > 1) {
    err(`one folder at most\n\n${USAGE}`);
    return 2;
  }
  const folder = path.resolve(cwd, folders[0] || '.');
  if (!fs.existsSync(folder)) {
    err(`no folder ${folder}`);
    return 2;
  }
  const homeDir = home || H.resolve().dir;
  const claudeDir = configuredClaudeDir(homeDir, env);
  const selfPidSet = deps.selfPids ? deps.selfPids : selfPids(env, deps);
  const fresh = buildHandoff({ claudeDir, folder, selfId: String(env.CLAUDE_CODE_SESSION_ID || ''), selfPidSet, deps });
  const handoff = mergeEarlier(fresh, readHandoff(homeDir));
  const file = writeHandoff(homeDir, handoff);
  if (argv.includes('--json')) out(JSON.stringify(handoff, null, 2));
  else out(describe(handoff));
  out(`\nSaved to ${file}.`);
  const live = handoff.sessions.filter(s => s.pid && fresh.sessions.some(f => f.id === s.id));
  if (!live.length) {
    if (handoff.sessions.length) out('In game: /claude -r all');
    return 0;
  }
  if (!argv.includes('--stop')) {
    out('Quit these sessions (or run this again with --stop), then in game: /claude -r all. A session still running is not opened in game.');
    return 0;
  }
  const force = argv.includes('--force');
  const kill = deps.kill || process.kill.bind(process);
  const asked = [];
  const skipped = [];
  for (const s of live) {
    const can = stoppable(s, { force, platform });
    if (!can.ok) {
      if (can.why) skipped.push(`${s.title || s.id} (pid ${s.pid}): ${can.why}`);
      continue;
    }
    try {
      kill(s.pid, 'SIGTERM');
      asked.push(s.pid);
    } catch (e) {
      skipped.push(`${s.title || s.id} (pid ${s.pid}): ${e.message}`);
    }
  }
  const left = await waitGone(asked, { timeoutMs: deps.stopWaitMs || STOP_WAIT_MS, alive: deps.alive || pidAlive });
  out(`Stopped ${asked.length - left.length} of ${live.filter(s => !s.self).length} session${live.length === 1 ? '' : 's'}.`);
  for (const line of skipped) out(`Not stopped: ${line}`);
  if (left.length) out(`Still running after SIGTERM (pid ${left.join(', ')}): quit them in their terminals.`);
  if (live.some(s => s.self)) out('This session was not stopped. Quit it when you are done here.');
  out('In game: /claude -r all. Sessions still running are not opened there until they end.');
  return left.length || skipped.length ? 1 : 0;
}

module.exports = {
  FILE_NAME,
  FRESH_MS,
  SESSIONS_MAX,
  USAGE,
  repoKey,
  sameStart,
  processState,
  ancestorsOf,
  runningSessions,
  lastExchange,
  buildHandoff,
  writeHandoff,
  readHandoff,
  mergeEarlier,
  slotEntries,
  withHandoff,
  recapOf,
  stillRunning,
  stoppable,
  describe,
  waitGone,
  main,
};
