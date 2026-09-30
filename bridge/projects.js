'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_ROOTS = ['~', '~/Projects'];
const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 6;
const MAX_DIRS = 20000;
const README_NAMES = ['README.md', 'README', 'README.txt', 'readme.md', 'Readme.md', 'README.rst'];
const README_BYTES = 8192;
const REFLOG_BYTES = 65536;
const SUMMARY_MAX = 140;
const SKIP_NAMES = new Set(['node_modules', 'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'Public', 'vendor', 'target', 'dist', 'build', '__pycache__']);

function expandHome(p, home = os.homedir()) {
  return path.resolve(String(p).replace(/^~(?=[\\/]|$)/, home));
}

function scanOptions(routerCfg = {}, home = os.homedir()) {
  const roots = Array.isArray(routerCfg.roots) && routerCfg.roots.length ? routerCfg.roots : DEFAULT_ROOTS;
  const depth = Number.isInteger(routerCfg.depth) && routerCfg.depth >= 0 ? Math.min(routerCfg.depth, MAX_DEPTH) : DEFAULT_DEPTH;
  return {
    roots: [...new Set(roots.map(r => expandHome(r, home)))],
    depth,
    includeWorktrees: routerCfg.includeWorktrees === true,
    aliases: routerCfg.aliases && typeof routerCfg.aliases === 'object' ? routerCfg.aliases : {},
  };
}

async function readHead(file, bytes) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } catch { return ''; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function readTail(file, bytes) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch { return ''; } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function originUrl(configText) {
  const lines = String(configText || '').split('\n');
  let inOrigin = false;
  let first = '';
  let current = '';
  for (const raw of lines) {
    const line = raw.trim();
    const section = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (section) { current = section[1]; inOrigin = current === 'origin'; continue; }
    if (line.startsWith('[')) { current = ''; inOrigin = false; continue; }
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (url && current) {
      if (inOrigin) return url[1].trim();
      if (!first) first = url[1].trim();
    }
  }
  return first;
}

function lastCommitFromReflog(text) {
  let last = 0;
  let lastAny = 0;
  for (const line of String(text || '').split('\n')) {
    const m = /^[0-9a-f]+ [0-9a-f]+ .*?> (\d+) [+-]\d{4}\t(.*)$/.exec(line);
    if (!m) continue;
    const at = Number(m[1]) * 1000;
    lastAny = Math.max(lastAny, at);
    if (/^commit\b/.test(m[2]) || /^merge\b/.test(m[2]) || /^pull\b/.test(m[2])) last = Math.max(last, at);
  }
  return last || lastAny;
}

function readmeLine(text) {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^(\[!\[|!\[|<|---|===|```|\|)/.test(line)) continue;
    const clean = line.replace(/^#+\s*/, '').replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
    if (clean) return clean.length > SUMMARY_MAX ? clean.slice(0, SUMMARY_MAX - 3) + '...' : clean;
  }
  return '';
}

function remoteName(url) {
  const m = /([^/:]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? m[1] : '';
}

function aliasesFor(name, remote, extra = []) {
  const out = new Set();
  const lower = name.toLowerCase();
  const spaced = lower.replace(/[-_.]+/g, ' ').trim();
  const joined = lower.replace(/[-_.\s]+/g, '');
  for (const a of [spaced, joined, remoteName(remote).toLowerCase(), ...extra.map(e => String(e).toLowerCase())]) {
    if (a && a !== lower) out.add(a);
  }
  return [...out];
}

async function gitDirOf(dir) {
  const dotGit = path.join(dir, '.git');
  let st;
  try { st = await fs.promises.stat(dotGit); } catch { return null; }
  if (st.isDirectory()) return { gitDir: dotGit, commonDir: dotGit, worktree: false };
  if (!st.isFile()) return null;
  const text = await readHead(dotGit, 4096);
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const gitDir = path.resolve(dir, m[1].trim());
  const common = (await readHead(path.join(gitDir, 'commondir'), 4096)).trim();
  return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir, worktree: true };
}

async function repoInfo(dir, git, extraAliases = []) {
  const name = path.basename(dir);
  const remote = originUrl(await readHead(path.join(git.commonDir, 'config'), 65536));
  let lastMs = lastCommitFromReflog(await readTail(path.join(git.gitDir, 'logs', 'HEAD'), REFLOG_BYTES));
  if (!lastMs) {
    try { lastMs = (await fs.promises.stat(path.join(git.gitDir, 'HEAD'))).mtimeMs; } catch { lastMs = 0; }
  }
  let readme = '';
  for (const f of README_NAMES) {
    const text = await readHead(path.join(dir, f), README_BYTES);
    if (text) { readme = readmeLine(text); if (readme) break; }
  }
  const info = {
    name,
    path: dir,
    remote,
    lastCommit: lastMs ? new Date(lastMs).toISOString() : '',
    readme,
    aliases: aliasesFor(name, remote, extraAliases),
  };
  if (git.worktree) info.worktree = true;
  return info;
}

async function scan(opts = {}) {
  const roots = opts.roots || DEFAULT_ROOTS.map(r => expandHome(r));
  const depth = Number.isInteger(opts.depth) ? opts.depth : DEFAULT_DEPTH;
  const includeWorktrees = opts.includeWorktrees === true;
  const aliases = opts.aliases || {};
  const seen = new Set();
  const found = new Map();
  let visited = 0;
  let skippedWorktrees = 0;

  async function walk(dir, level) {
    if (visited >= MAX_DIRS) return;
    let real;
    try { real = await fs.promises.realpath(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    visited++;
    const git = await gitDirOf(dir);
    if (git) {
      if (git.worktree && !includeWorktrees) { skippedWorktrees++; return; }
      if (!found.has(real)) {
        const name = path.basename(dir);
        const extra = Array.isArray(aliases[name]) ? aliases[name] : [];
        found.set(real, await repoInfo(dir, git, extra));
      }
      return;
    }
    if (level >= depth) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_NAMES.has(e.name)) continue;
      await walk(path.join(dir, e.name), level + 1);
    }
  }

  const ordered = [...roots].sort((a, b) => b.length - a.length);
  for (const root of ordered) await walk(root, 0);
  const projects = [...found.values()].sort((a, b) => String(b.lastCommit).localeCompare(String(a.lastCommit)) || a.name.localeCompare(b.name));
  return { projects, visited, skippedWorktrees, truncated: visited >= MAX_DIRS };
}

async function writeRegistry(file, result, opts, now = Date.now()) {
  const data = {
    scannedAt: new Date(now).toISOString(),
    roots: opts.roots,
    depth: opts.depth,
    includeWorktrees: !!opts.includeWorktrees,
    skippedWorktrees: result.skippedWorktrees,
    truncated: result.truncated,
    projects: result.projects,
  };
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.promises.rename(tmp, file);
  return data;
}

function readRegistry(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.projects) ? data.projects : [];
  } catch { return []; }
}

async function refresh({ file, routerCfg = {}, home = os.homedir(), now = Date.now() } = {}) {
  const opts = scanOptions(routerCfg, home);
  const result = await scan(opts);
  const data = await writeRegistry(file, result, opts, now);
  return { ...data, visited: result.visited };
}

async function main(argv = process.argv.slice(2), out = console.log) {
  const H = require('./home');
  const home = H.resolve();
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(home.config, 'utf8')); } catch {}
  const routerCfg = cfg.router && typeof cfg.router === 'object' ? cfg.router : {};
  const data = await refresh({ file: home.projects, routerCfg });
  if (argv.includes('--json')) { out(JSON.stringify(data, null, 2)); return 0; }
  out(`${data.projects.length} project(s) from ${data.roots.join(', ')} (depth ${data.depth}${data.includeWorktrees ? ', worktrees included' : ', ' + data.skippedWorktrees + ' worktree checkout(s) skipped'}${data.truncated ? ', stopped at ' + MAX_DIRS + ' folders' : ''})`);
  for (const p of data.projects.slice(0, 20)) out(`  ${p.name.padEnd(28)} ${String(p.lastCommit).slice(0, 10).padEnd(10)}  ${p.readme}`);
  if (data.projects.length > 20) out(`  ... and ${data.projects.length - 20} more`);
  out(`wrote ${home.projects}`);
  return 0;
}

if (require.main === module) main().then(code => { process.exitCode = code; }, e => { console.error(e.message); process.exitCode = 1; });

module.exports = {
  DEFAULT_ROOTS, DEFAULT_DEPTH, MAX_DIRS, SKIP_NAMES,
  expandHome, scanOptions, originUrl, lastCommitFromReflog, readmeLine, remoteName, aliasesFor, gitDirOf, repoInfo, scan, writeRegistry, readRegistry, refresh, main,
};
