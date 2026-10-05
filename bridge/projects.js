'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS_MAX = 12;
const LABEL_MAX = 40;
const GIT_DEPTH = 12;
const LABEL_TTL_MS = 60000;
const HISTORY_TAIL_BYTES = 262144;
const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

const labelCache = new Map();

function expandHome(p, home = os.homedir()) {
  const s = String(p || '').trim();
  if (s === '~') return home;
  if (/^~[\\/]/.test(s)) return path.join(home, s.slice(2));
  return s;
}

function normalize(p, home = os.homedir()) {
  const s = expandHome(p, home);
  return s ? path.resolve(s) : '';
}

function isInside(dir, root) {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function gitDirOf(dir) {
  const dotGit = path.join(dir, '.git');
  let st;
  try {
    st = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dotGit;
  const m = /^gitdir:\s*(.+)$/m.exec(readFile(dotGit));
  if (!m) return '';
  const gitDir = path.resolve(dir, m[1].trim());
  const common = readFile(path.join(gitDir, 'commondir')).trim();
  return common ? path.resolve(gitDir, common) : gitDir;
}

function remoteUrls(config) {
  const urls = {};
  let remote = null;
  for (const line of String(config || '').split(/\r?\n/)) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]\s*$/.exec(line);
    if (section) {
      remote = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      remote = null;
      continue;
    }
    const url = remote && /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url && !urls[remote]) urls[remote] = url[1];
  }
  return urls;
}

function repoNameFromUrl(url) {
  const m = /([^/:\\]+?)(?:\.git)?[/\\]*$/.exec(String(url || '').trim());
  return m ? m[1] : '';
}

function repoLabel(cwd) {
  let dir = cwd;
  for (let i = 0; i < GIT_DEPTH; i++) {
    const gitDir = gitDirOf(dir);
    if (gitDir !== null) {
      const urls = remoteUrls(gitDir ? readFile(path.join(gitDir, 'config')) : '');
      const url = urls.origin || Object.values(urls)[0] || '';
      return repoNameFromUrl(url) || path.basename(dir);
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.basename(cwd);
}

function cleanLabel(text) {
  const s = String(text || '')
    .replace(/[^\w.\- ]+/g, '')
    .trim();
  return s.length > LABEL_MAX ? s.slice(0, LABEL_MAX) : s;
}

function labelFor(cwd, now = Date.now()) {
  const hit = labelCache.get(cwd);
  if (hit && now - hit.at < LABEL_TTL_MS) return hit.label;
  let label = '';
  try {
    label = cleanLabel(repoLabel(cwd));
  } catch {}
  label = label || cleanLabel(path.basename(cwd)) || cwd;
  labelCache.set(cwd, { at: now, label });
  return label;
}

function recentClaudeProjects(claudeDir) {
  let text = '';
  let fd;
  try {
    fd = fs.openSync(path.join(claudeDir, 'history.jsonl'), 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, HISTORY_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    text = buf.toString('utf8');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  const latest = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('"project"')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev.project !== 'string' || !ev.project) continue;
    const at = Number(ev.timestamp) || 0;
    if (at >= (latest.get(ev.project) || 0)) latest.set(ev.project, at);
  }
  return [...latest.entries()].map(([cwd, at]) => ({ cwd, at }));
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function knownProjects({
  defaultCwd = '',
  chats = [],
  recent = [],
  exclude = [],
  tempRoots = [...TEMP_ROOTS, os.tmpdir()],
  home = os.homedir(),
  limit = PROJECTS_MAX,
  now = Date.now(),
} = {}) {
  const skip = [...tempRoots, ...exclude].filter(Boolean).map(p => path.resolve(p));
  const homeDir = path.resolve(home);
  const seen = new Set();
  const candidates = [];
  const add = (raw, at, pinned) => {
    const cwd = normalize(raw, home);
    if (!cwd || seen.has(cwd)) return;
    seen.add(cwd);
    if (cwd === homeDir || skip.some(root => isInside(cwd, root))) return;
    if (!isDirectory(cwd)) return;
    candidates.push({ cwd, at: Number(at) || 0, pinned });
  };
  add(defaultCwd, 0, true);
  for (const c of chats) add(c.cwd, c.at, false);
  for (const r of recent) add(r.cwd, r.at, false);
  const ordered = [...candidates.filter(c => c.pinned), ...candidates.filter(c => !c.pinned).sort((a, b) => b.at - a.at)].slice(0, limit);
  const out = ordered.map(c => ({ path: c.cwd, label: labelFor(c.cwd, now) }));
  const groups = new Map();
  for (const p of out) groups.set(p.label, [...(groups.get(p.label) || []), p]);
  for (const [label, group] of groups) {
    if (group.length < 2) continue;
    const sameName = group.filter(p => path.basename(p.path) === label);
    for (const p of group) {
      if (sameName.length === 1 && sameName[0] === p) continue;
      const folder = path.basename(p.path);
      p.label = `${label} (${folder !== label ? folder : path.basename(path.dirname(p.path))})`;
    }
  }
  return out;
}

module.exports = { PROJECTS_MAX, expandHome, normalize, remoteUrls, repoNameFromUrl, repoLabel, labelFor, recentClaudeProjects, knownProjects };
