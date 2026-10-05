'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_NAME_RE = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/;
const MAX_SERVER_NAME = 64;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const URL_RE = /^https?:\/\/\S+$/i;
const ALL_TOOLS = '*';
const AGENT_KEYS = ['claude', 'codex'];
const STDIO_KEYS = new Set(['type', 'command', 'args', 'envVars', 'allow', 'default', 'alwaysLoad']);
const HTTP_KEYS = new Set(['type', 'url', 'bearerTokenEnvVar', 'allow', 'default', 'alwaysLoad']);
const MCP_KEYS = new Set(['servers', 'strict']);

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const envRef = name => '${' + name + '}';

function toolList(v, where) {
  const list = v === ALL_TOOLS ? [ALL_TOOLS] : v;
  if (!Array.isArray(list)) return { error: `${where} must be "*" or a list of tool names` };
  const bad = list.find(t => typeof t !== 'string' || (t !== ALL_TOOLS && !TOOL_NAME_RE.test(t)));
  if (bad !== undefined) return { error: `${where} has ${JSON.stringify(bad)}, which is not "*" or a tool name (letters, digits, - and _)` };
  return { tools: list.includes(ALL_TOOLS) ? [ALL_TOOLS] : [...new Set(list)] };
}

function parseAllow(v, where) {
  if (v === undefined) return { allow: Object.fromEntries(AGENT_KEYS.map(a => [a, []])) };
  if (!isObject(v)) {
    const r = toolList(v, where);
    return r.error ? r : { allow: Object.fromEntries(AGENT_KEYS.map(a => [a, r.tools])) };
  }
  const unknown = Object.keys(v).find(k => !AGENT_KEYS.includes(k));
  if (unknown) return { error: `${where} names "${unknown}", which is not one of ${AGENT_KEYS.join(', ')}` };
  const allow = {};
  for (const a of AGENT_KEYS) {
    const r = v[a] === undefined ? { tools: [] } : toolList(v[a], `${where}.${a}`);
    if (r.error) return r;
    allow[a] = r.tools;
  }
  return { allow };
}

function parseServer(name, s, reserved) {
  const where = `mcp.servers.${name}`;
  if (!SERVER_NAME_RE.test(name) || name.length > MAX_SERVER_NAME)
    return { error: `${where}: the name must be letters and digits, joined by single - or _, at most ${MAX_SERVER_NAME} characters` };
  if (reserved.includes(name)) return { error: `${where}: "${name}" is a bridge server name (${reserved.join(', ')})` };
  if (!isObject(s)) return { error: `${where} must be an object` };
  const http = s.type === 'http';
  if (s.type !== undefined && s.type !== 'stdio' && !http) return { error: `${where}.type must be "stdio" or "http"` };
  const keys = http ? HTTP_KEYS : STDIO_KEYS;
  const unknown = Object.keys(s).find(k => !keys.has(k));
  if (unknown) return { error: `${where}.${unknown} is not a key of a${http ? 'n http' : ' stdio'} server (${[...keys].join(', ')})` };
  if (s.default !== undefined && typeof s.default !== 'boolean') return { error: `${where}.default must be true or false` };
  if (s.alwaysLoad !== undefined && typeof s.alwaysLoad !== 'boolean') return { error: `${where}.alwaysLoad must be true or false` };
  const always = s.alwaysLoad === true ? { alwaysLoad: true } : {};
  const allow = parseAllow(s.allow, `${where}.allow`);
  if (allow.error) return allow;
  const out = { name, allow: allow.allow, default: s.default === true, envVars: [] };
  if (http) {
    if (typeof s.url !== 'string' || !URL_RE.test(s.url)) return { error: `${where}.url must be an http:// or https:// URL` };
    out.server = { type: 'http', url: s.url, ...always };
    if (s.bearerTokenEnvVar !== undefined) {
      if (typeof s.bearerTokenEnvVar !== 'string' || !ENV_NAME_RE.test(s.bearerTokenEnvVar))
        return { error: `${where}.bearerTokenEnvVar must be an environment variable name` };
      out.envVars = [s.bearerTokenEnvVar];
      out.server.headers = { Authorization: `Bearer ${envRef(s.bearerTokenEnvVar)}` };
    }
    return out;
  }
  if (typeof s.command !== 'string' || !s.command.trim()) return { error: `${where}.command must be a program name or path` };
  if (s.args !== undefined && (!Array.isArray(s.args) || s.args.some(a => typeof a !== 'string'))) return { error: `${where}.args must be a list of strings` };
  if (s.envVars !== undefined && (!Array.isArray(s.envVars) || s.envVars.some(e => typeof e !== 'string' || !ENV_NAME_RE.test(e))))
    return { error: `${where}.envVars must be a list of environment variable names` };
  out.envVars = [...new Set(s.envVars || [])];
  out.server = { type: 'stdio', command: s.command, args: [...(s.args || [])], ...always };
  if (out.envVars.length) out.server.env = Object.fromEntries(out.envVars.map(e => [e, envRef(e)]));
  return out;
}

function parse(raw, { reserved = [], log = () => {}, env = {} } = {}) {
  if (raw === undefined) return null;
  if (!isObject(raw)) {
    log(`mcp in config.json must be an object; it is ignored`);
    return { servers: [], strict: false };
  }
  for (const k of Object.keys(raw)) if (!MCP_KEYS.has(k)) log(`mcp.${k} in config.json is not a key of mcp (${[...MCP_KEYS].join(', ')}); it is ignored`);
  let strict = false;
  if (raw.strict !== undefined) {
    if (typeof raw.strict === 'boolean') strict = raw.strict;
    else log(`mcp.strict in config.json must be true or false; ${JSON.stringify(raw.strict)} is ignored, so Claude still loads its own MCP servers`);
  }
  const servers = [];
  if (raw.servers !== undefined && !isObject(raw.servers)) log(`mcp.servers in config.json must be an object of named servers; it is ignored`);
  for (const [name, s] of Object.entries(isObject(raw.servers) ? raw.servers : {})) {
    const r = parseServer(name, s, reserved);
    if (r.error) {
      log(`${r.error}; this server is skipped`);
      continue;
    }
    for (const e of r.envVars)
      if (env[e] === undefined || env[e] === '')
        log(`mcp.servers.${name}: ${e} is not set in the bridge's environment, so the server gets the literal text ${envRef(e)}`);
    servers.push(r);
  }
  return { servers, strict };
}

function toolRule(server, tool) {
  return tool === ALL_TOOLS ? `mcp__${server}` : `mcp__${server}__${tool}`;
}

function serverOf(rule) {
  const m = /^mcp__(.+?)(?:__(.*))?$/.exec(String(rule || '').trim());
  return m ? { server: m[1], tool: m[2] === undefined ? '' : m[2] } : null;
}

function forClaude(mcp) {
  if (!mcp) return null;
  const loaded = mcp.servers.filter(s => s.default);
  const allowed = new Map(mcp.servers.map(s => [s.name, s.allow.claude]));
  const allowRules = loaded.flatMap(s => s.allow.claude.map(t => toolRule(s.name, t)));
  const blocks = rule => {
    const r = serverOf(rule);
    if (!r || !allowed.has(r.server)) return false;
    const tools = allowed.get(r.server);
    return !tools.includes(ALL_TOOLS) && !tools.includes(r.tool);
  };
  return {
    servers: Object.fromEntries(loaded.map(s => [s.name, s.server])),
    names: loaded.map(s => s.name),
    allowRules,
    strict: mcp.strict,
    blocks,
  };
}

function scopeAllowed(agentCfg, plan) {
  const current = Array.isArray(agentCfg && agentCfg.allowedTools) ? agentCfg.allowedTools : [];
  if (!plan) return { agentCfg, denied: [] };
  const blocked = current.filter(r => plan.blocks(r));
  if (!blocked.length) return { agentCfg, denied: [] };
  const exact = blocked.filter(r => {
    const s = serverOf(r);
    return s && s.tool && !s.tool.includes('*');
  });
  return { agentCfg: { ...agentCfg, allowedTools: current.filter(r => !plan.blocks(r)) }, denied: exact, dropped: blocked };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function serverNames(json) {
  if (!isObject(json)) return [];
  const servers = isObject(json.mcpServers) ? json.mcpServers : json;
  return Object.keys(servers).filter(k => isObject(servers[k]));
}

function claudeOwnServers({ home = os.homedir(), configDir = process.env.CLAUDE_CONFIG_DIR || '', cwd = process.cwd(), read = readJson } = {}) {
  const dir = configDir || path.join(home, '.claude');
  const userFile = configDir ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json');
  const out = [];
  const user = read(userFile) || {};
  for (const n of serverNames({ mcpServers: user.mcpServers })) out.push(`user:${n}`);
  const local = isObject(user.projects) && isObject(user.projects[cwd]) ? user.projects[cwd].mcpServers : null;
  for (const n of serverNames({ mcpServers: local })) out.push(`local:${n}`);
  for (const n of serverNames(read(path.join(cwd, '.mcp.json')))) out.push(`project:${n}`);
  const enabled = {};
  for (const f of [path.join(dir, 'settings.json'), path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json')]) {
    const plugins = (read(f) || {}).enabledPlugins;
    if (isObject(plugins)) Object.assign(enabled, plugins);
  }
  const installed = (read(path.join(dir, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  for (const [id, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const plugin = id.split('@')[0];
    for (const inst of Array.isArray(installed[id]) ? installed[id] : []) {
      if (!inst || typeof inst.installPath !== 'string') continue;
      const manifest = read(path.join(inst.installPath, '.claude-plugin', 'plugin.json')) || {};
      const declared = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers];
      const fromManifest = declared.flatMap(d =>
        typeof d === 'string' ? serverNames(read(path.resolve(inst.installPath, d))) : serverNames({ mcpServers: d }),
      );
      const names = new Set([...serverNames(read(path.join(inst.installPath, '.mcp.json'))), ...fromManifest]);
      for (const n of names) out.push(`plugin:${plugin}:${n}`);
      break;
    }
  }
  return [...new Set(out)];
}

function summary(mcp) {
  if (!mcp) return '';
  const names = mcp.servers.map(s => `${s.name} (${s.default ? 'on' : 'off'} by default)`);
  return `${names.length ? names.join(', ') : 'no servers'}${mcp.strict ? '; strict: Claude runs load only these and the bridge servers' : ''}`;
}

module.exports = { parse, forClaude, scopeAllowed, claudeOwnServers, summary, serverOf, ALL_TOOLS };
