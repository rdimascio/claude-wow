'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const SS = require('./sessions');
const H = require('./home');

const FILE_NAME = 'handoff.json';
const FRESH_MS = 24 * 3600 * 1000;
const SESSIONS_MAX = 24;
const RECAP_MAX = 280;
const TAIL_BYTES = 512 * 1024;
const STOP_WAIT_MS = 15000;
const STOP_POLL_MS = 250;
const GIT_TIMEOUT_MS = 5000;
const PS_TIMEOUT_MS = 3000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneLine(text, max = RECAP_MAX) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function repoKey(dir, exec = execFileSync) {
  const abs = path.resolve(String(dir || '.'));
  try {
    const out = exec('git', ['-C', abs, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return fs.realpathSync(out);
  } catch {}
  try { return fs.realpathSync(abs); } catch { return abs; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

function startTimeOf(pid, exec = execFileSync) {
  if (process.platform === 'win32') return null;
  try {
    return exec('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

const squash = s => String(s || '').replace(/\s+/g, ' ').trim();

function sameProcess(info, { alive = pidAlive, startOf = startTimeOf } = {}) {
  if (!alive(info.pid)) return false;
  if (!info.procStart) return true;
  const now = startOf(info.pid);
  return now === null || now === '' ? true : squash(now) === squash(info.procStart);
}

function runningSessions(claudeDir, deps = {}) {
  const dir = path.join(claudeDir, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!info || typeof info !== 'object') continue;
    const pid = Number(info.pid || n.slice(0, -5));
    const id = String(info.sessionId || '');
    if (!Number.isInteger(pid) || pid <= 0 || !SESSION_ID_RE.test(id) || !info.cwd) continue;
    if (info.kind && info.kind !== 'interactive') continue;
    if (!sameProcess({ pid, procStart: info.procStart }, deps)) continue;
    out.push({ pid, id, cwd: String(info.cwd), name: oneLine(info.name || '', 60), startedAt: Number(info.startedAt) || 0 });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
}

function lastExchange(file) {
  let text = '';
  try { text = SS.readTail(file, TAIL_BYTES); } catch { return { asked: '', answered: '' }; }
  let asked = '';
  let answered = '';
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    if (!ev || !ev.message || ev.isMeta || ev.isSidechain) continue;
    const body = textOf(ev.message.content).trim();
    if (!body) continue;
    if (ev.type === 'user' && !body.startsWith('<')) { asked = body; answered = ''; }
    else if (ev.type === 'assistant') answered = body;
  }
  return { asked: oneLine(asked), answered: oneLine(answered) };
}

function branchOf(cwd) {
  try { return SS.gitBranch(cwd); } catch { return ''; }
}

function buildHandoff({ claudeDir, folder, selfId = '', now = Date.now(), deps = {} }) {
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
      return { id: s.id, pid: s.pid, cwd: s.cwd, branch: branchOf(s.cwd), title: oneLine(title, 60), startedAt: s.startedAt, self: !!selfId && s.id === selfId, ...recap };
    });
  return { at: now, repo: want, folder: path.resolve(folder), sessions };
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

function readHandoff(homeDir, now = Date.now()) {
  let h;
  try { h = JSON.parse(fs.readFileSync(fileIn(homeDir), 'utf8')); } catch { return null; }
  if (!h || typeof h !== 'object' || !Array.isArray(h.sessions)) return null;
  const at = Number(h.at);
  if (!Number.isFinite(at) || now - at > FRESH_MS || at - now > FRESH_MS) return null;
  const sessions = h.sessions
    .filter(s => s && typeof s === 'object' && SESSION_ID_RE.test(String(s.id || '')) && typeof s.cwd === 'string' && s.cwd)
    .slice(0, SESSIONS_MAX)
    .map(s => ({ id: String(s.id), cwd: s.cwd, branch: oneLine(s.branch, 80), title: oneLine(s.title, 60), asked: oneLine(s.asked), answered: oneLine(s.answered), startedAt: Number(s.startedAt) || 0 }));
  return { at, sessions };
}

function recapOf(s) {
  const parts = [];
  if (s.asked) parts.push(`Last ask: ${s.asked}`);
  if (s.answered) parts.push(`Last answer: ${s.answered}`);
  return parts.join('\n');
}

function slotEntries(handoff) {
  if (!handoff) return [];
  return handoff.sessions.map(s => ({
    id: s.id, name: s.title || s.id.slice(0, 8), title: s.title, cwd: s.cwd, agent: 'claude', branch: s.branch,
    at: Math.floor((s.startedAt || handoff.at) / 1000), handoff: true, recap: recapOf(s),
  }));
}

function withHandoff(merged, entries) {
  if (!entries.length) return merged;
  const byId = new Map(merged.map(s => [s.id, s]));
  const first = entries.map(e => {
    const known = byId.get(e.id);
    return known ? { ...e, ...known, handoff: true, recap: e.recap, title: known.title || e.title } : e;
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

function stopSession(pid, kill = process.kill.bind(process)) {
  try { kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

function ago(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

function describe(h, now = Date.now()) {
  if (!h.sessions.length) return `No running Claude Code session in ${h.folder} or its worktrees.`;
  const lines = [`${h.sessions.length} running Claude Code session${h.sessions.length === 1 ? '' : 's'} in this repository:`];
  h.sessions.forEach((s, i) => {
    lines.push(`${String(i + 1).padStart(2)}. ${s.title || '(untitled)'}${s.self ? '  [this session]' : ''}`);
    lines.push(`    ${s.id}  pid ${s.pid}  ${s.cwd}${s.branch ? ' @ ' + s.branch : ''}  started ${s.startedAt ? ago(now - s.startedAt) + ' ago' : '?'}`);
    if (s.answered || s.asked) lines.push(`    ${oneLine(s.answered || s.asked, 110)}`);
  });
  return lines.join('\n');
}

const USAGE = [
  'claude-wow handoff [folder] [--stop] [--json]',
  '',
  'Lists the Claude Code sessions running in the folder\'s repository (its worktrees too),',
  'with each one\'s last ask and answer, and saves the list in the home folder for the game.',
  'In game, /claude -r all then opens one chat per session, each resuming it headless.',
  '',
  '  --stop   end those sessions (SIGTERM) after saving the list, so the game can resume them.',
  '           A session still running in a terminal and resumed in game would fork it.',
  '           The session that runs this command is never stopped; quit it yourself.',
  '  --json   print the saved list as JSON',
].join('\n');

async function main(argv, { out = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n'), env = process.env, cwd = process.cwd(), home, deps = {} } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { out(USAGE); return 0; }
  const unknown = argv.filter(a => a.startsWith('-') && !['--stop', '--json'].includes(a));
  if (unknown.length) { err(`unknown option ${unknown[0]}\n\n${USAGE}`); return 2; }
  const folders = argv.filter(a => !a.startsWith('-'));
  if (folders.length > 1) { err(`one folder at most\n\n${USAGE}`); return 2; }
  const folder = path.resolve(cwd, folders[0] || '.');
  if (!fs.existsSync(folder)) { err(`no folder ${folder}`); return 2; }
  const homeDir = home || H.resolve().dir;
  const claudeDir = SS.claudeDir(env);
  const handoff = buildHandoff({ claudeDir, folder, selfId: String(env.CLAUDE_CODE_SESSION_ID || ''), deps });
  const file = writeHandoff(homeDir, handoff);
  if (argv.includes('--json')) out(JSON.stringify(handoff, null, 2));
  else out(describe(handoff));
  out(`\nSaved to ${file}.`);
  if (!handoff.sessions.length) return 0;
  const others = handoff.sessions.filter(s => !s.self);
  const self = handoff.sessions.find(s => s.self);
  if (!argv.includes('--stop')) {
    out('Quit these sessions (or run this again with --stop), then in game: /claude -r all');
    return 0;
  }
  const kill = deps.kill || process.kill.bind(process);
  const asked = others.filter(s => stopSession(s.pid, kill)).map(s => s.pid);
  const left = await waitGone(asked, { timeoutMs: deps.stopWaitMs || STOP_WAIT_MS, alive: deps.alive || pidAlive });
  out(`Stopped ${asked.length - left.length} of ${others.length} session${others.length === 1 ? '' : 's'}.`);
  if (left.length) out(`Still running (pid ${left.join(', ')}): quit them in their terminals before you resume them in game.`);
  if (self) out('This session was not stopped. Quit it when you are done here.');
  out('In game: /claude -r all');
  return left.length ? 1 : 0;
}

module.exports = {
  FILE_NAME, FRESH_MS, SESSIONS_MAX, USAGE,
  repoKey, sameProcess, runningSessions, lastExchange, buildHandoff, writeHandoff, readHandoff, slotEntries, withHandoff, recapOf, describe, waitGone, main,
};
