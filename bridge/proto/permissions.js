'use strict';

const path = require('path');
const { isWindowsAbsolute, baseName } = require('./util');

function withRunOnlyRules(agentCfg, rules) {
  const extra = Array.isArray(rules) ? rules.filter(Boolean) : [];
  if (!extra.length) return agentCfg;
  const current = Array.isArray(agentCfg.allowedTools) ? agentCfg.allowedTools : [];
  return { ...agentCfg, allowedTools: [...new Set([...current, ...extra])] };
}

function withRunDeniedRules(agentCfg, rules) {
  const extra = Array.isArray(rules) ? rules.filter(Boolean) : [];
  if (!extra.length) return agentCfg;
  const current = Array.isArray(agentCfg.deniedTools) ? agentCfg.deniedTools : [];
  return { ...agentCfg, deniedTools: [...new Set([...current, ...extra])] };
}

function absolutePathRule(tool, file) {
  const raw = String(file || '');
  const drive = /^([A-Za-z]):[\\/]/.exec(raw);
  const posix = drive ? `/${drive[1].toLowerCase()}/${raw.slice(3).replace(/\\/g, '/')}` : raw;
  return `${tool}(/${posix.startsWith('/') ? posix : '/' + posix})`;
}

function withoutRules(rules, banned) {
  const blocked = new Set(Array.isArray(banned) ? banned : []);
  return (Array.isArray(rules) ? rules : []).filter(r => !blocked.has(String(r)));
}

function ruleFor(d) {
  const name = d.tool_name || 'Unknown';
  if (name === 'Bash') {
    const cmd = String((d.tool_input && d.tool_input.command) || '').trim();
    const word = cmd.split(/\s+/)[0];
    if (word && /^[\w.-]+$/.test(word)) return `Bash(${word}:*)`;
    return 'Bash';
  }
  return name;
}

const FOLDER_RULE_RE = /^AddDir\(([\s\S]+)\)$/;
const OUTSIDE_FOLDERS_RE = /working director/i;
const QUOTED_PATH_RE = /\bin '([^']+)'/;
const FILE_TOOL_PATH_KEYS = ['file_path', 'notebook_path', 'path'];

function folderRule(dir) {
  return `AddDir(${dir})`;
}

function ruleFolder(rule) {
  const m = FOLDER_RULE_RE.exec(String(rule || '').trim());
  return m ? m[1] : '';
}

function splitGrants(rules) {
  const out = { rules: [], dirs: [] };
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r) continue;
    const dir = ruleFolder(r);
    if (dir) out.dirs.push(dir);
    else out.rules.push(String(r));
  }
  return out;
}

function pathApi(...paths) {
  if (paths.some(isWindowsAbsolute)) return path.win32;
  if (paths.some(p => String(p || '').startsWith('/'))) return path.posix;
  return path;
}

function insideFolder(p, dir) {
  if (!p || !dir) return false;
  const api = pathApi(p, dir);
  const fold = api === path.win32 ? s => s.toLowerCase() : s => s;
  const rel = api.relative(fold(api.resolve(String(dir))), fold(api.resolve(String(p))));
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

function nearestFolder(p, isDir) {
  const api = pathApi(p);
  let dir = api.resolve(String(p));
  if (typeof isDir !== 'function') return api.dirname(dir);
  for (;;) {
    if (isDir(dir)) return dir;
    const up = api.dirname(dir);
    if (up === dir) return dir;
    dir = up;
  }
}

function denialPath(d, message, cwd) {
  const input = (d && d.tool_input) || {};
  const quoted = QUOTED_PATH_RE.exec(String(message || ''));
  let raw = quoted ? quoted[1] : '';
  if (!raw && d && d.tool_name !== 'Bash') raw = FILE_TOOL_PATH_KEYS.map(k => input[k]).find(v => typeof v === 'string' && v) || '';
  if (!raw) return '';
  if (isWindowsAbsolute(raw) || raw.startsWith('/') || path.isAbsolute(raw)) return raw;
  return cwd ? pathApi(cwd).resolve(cwd, raw) : '';
}

function denialWhat(d) {
  const input = (d && d.tool_input) || {};
  const name = (d && d.tool_name) || 'Unknown';
  const detail = input.command || input.file_path || input.notebook_path || input.path || '';
  return name + (detail ? ': ' + String(detail).split('\n')[0].slice(0, 160) : '');
}

function firstSentence(text) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(s);
  return (m ? m[0] : s).slice(0, 200);
}

function classifyDenial(d, info = {}, opts = {}) {
  const message = String(info.message || '');
  const what = denialWhat(d);
  const outside = info.reasonType === 'workingDir' || OUTSIDE_FOLDERS_RE.test(message);
  if (outside) {
    const p = denialPath(d, message, opts.cwd);
    if (p) {
      const folder = nearestFolder(p, opts.isDir);
      return { kind: 'folder', rule: folderRule(folder), folder, path: p, what, message };
    }
  }
  return { kind: 'rule', rule: ruleFor(d || {}), what, message };
}

function grantsFor(agentCfg, cwd) {
  const rules = Array.isArray(agentCfg && agentCfg.allowedTools) ? agentCfg.allowedTools.filter(Boolean).map(String) : [];
  const dirs = Array.isArray(agentCfg && agentCfg.addDirs) ? agentCfg.addDirs.filter(Boolean).map(String) : [];
  return { rules, dirs: cwd ? [cwd, ...dirs] : dirs };
}

function deniedAgain(entry, granted) {
  if (!entry || !granted) return false;
  if (entry.kind === 'folder') {
    const target = entry.path || entry.folder;
    return (granted.dirs || []).some(dir => insideFolder(target, dir));
  }
  return (granted.rules || []).some(rule => rule === entry.rule || coversMcpTool(rule, entry.rule));
}

const MCP_SERVER_RULE_RE = /^mcp__[^_]+(?:_[^_]+)*$/;

function coversMcpTool(rule, toolRule) {
  return MCP_SERVER_RULE_RE.test(rule) && String(toolRule || '').startsWith(`${rule}__`);
}

function denialNotes(agentName, fresh, again) {
  const who = agentName || 'The agent';
  const notes = [];
  const rules = (fresh || []).filter(e => e.kind !== 'folder');
  const folders = (fresh || []).filter(e => e.kind === 'folder');
  if (rules.length) {
    const actions = rules.length === 1 ? '1 action that is' : `${rules.length} actions that are`;
    notes.push(
      `${who} needed ${actions} not allowed yet:\n  ${rules.map(e => e.what).join('\n  ')}\nAllow ${rules.length === 1 ? 'it' : 'them'} from this chat to let it continue.`,
    );
  }
  if (folders.length) {
    notes.push(
      `${who} was blocked outside this chat's folders:\n  ${folders.map(e => `${e.what} (folder ${e.folder})`).join('\n  ')}\nAn allowlist rule cannot open a folder. Allow it from this chat to add the folder (like /claude --add-dir) and let it continue.`,
    );
  }
  const seen = new Set();
  for (const e of again || []) {
    if (seen.has(e.rule)) continue;
    seen.add(e.rule);
    const why = firstSentence(e.message);
    const granted = e.kind === 'folder' ? `${e.folder} is already one of this chat's folders` : `${e.rule} is already allowed`;
    notes.push(`${who} was blocked again on ${e.what} although ${granted}, so allowing it again would not help${why ? ': ' + why : '.'}`);
  }
  return notes;
}

const STEP_CHARS = 80;
const MCP_PREFIXES = /^(?:claude_ai_|plugin_[^_]+_)/;

function clip(text, max = STEP_CHARS) {
  const s = String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 3).trimEnd() + '...' : s;
}

function shortCommand(cmd) {
  const first = String(cmd || '')
    .split('\n')[0]
    .replace(/^\s*cd\s+\S+\s*&&\s*/, '')
    .trim();
  const words = [];
  for (const w of first.split(/\s+/)) {
    if (!w || /^[-|&;<>'"$(]/.test(w) || words.length === 4) break;
    words.push(w);
  }
  return words.join(' ') || first.split(/\s+/)[0] || '';
}

function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return clip(url, 40);
  }
}

function humanTool(name) {
  return String(name || '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function describeMcp(name) {
  const [, server = '', tool = ''] = /^mcp__(.*?)__(.*)$/.exec(name) || [];
  const who = humanTool(server.replace(MCP_PREFIXES, ''));
  const what = humanTool(tool.replace(/^[^_]*-/, ''));
  return clip(who ? `${who}: ${what}` : what);
}

function describeToolUse(block) {
  const inp = block.input || {};
  const name = String(block.name || '');
  switch (name) {
    case 'Bash':
      return clip(inp.description) || clip(`Run ${shortCommand(inp.command)}`);
    case 'Read':
      return `Read ${baseName(inp.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${baseName(inp.file_path)}`;
    case 'Write':
      return `Write ${baseName(inp.file_path)}`;
    case 'NotebookEdit':
      return `Edit ${baseName(inp.notebook_path)}`;
    case 'Grep':
      return clip(`Search for "${inp.pattern || ''}"`);
    case 'Glob':
      return clip(`Find ${inp.pattern || 'files'}`);
    case 'Agent':
    case 'Task':
      return clip(`Agent: ${inp.description || 'subtask'}`);
    case 'WebSearch':
      return clip(`Web search: ${inp.query || ''}`);
    case 'WebFetch':
      return `Fetch ${hostOf(inp.url)}`;
    case 'TodoWrite':
      return 'Update the plan';
    case 'ToolSearch':
      return 'Load tools';
    case 'Skill':
      return clip(`Use skill ${inp.skill || inp.command || ''}`);
    default:
      return name.startsWith('mcp__') ? describeMcp(name) : name;
  }
}

module.exports = {
  withRunOnlyRules,
  withRunDeniedRules,
  absolutePathRule,
  withoutRules,
  ruleFor,
  folderRule,
  ruleFolder,
  splitGrants,
  insideFolder,
  nearestFolder,
  denialPath,
  classifyDenial,
  grantsFor,
  deniedAgain,
  denialNotes,
  describeToolUse,
};
