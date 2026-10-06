'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { INERT_OPTIONS: INERT_STREAM } = require('../bridge/plugins/stream');
const SIG = require('../bridge/signals');
const P = require('../bridge/protocol');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_ROOT = path.join(REPO, '.dev', 'sandboxes');
const ACCOUNT = 'DEV#1';
const CLIENT_INTERFACE = '16001';
const PRIMARY_FLAVOR = '_classic_beta_';
const FLAVOR_RE = /^_[a-z_]+_$/;
const WINDOWS_SYSTEM_ENV = [
  'windir',
  'SystemDrive',
  'PATHEXT',
  'PSModulePath',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ProgramData',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
];

const FAKE_AGENT = path.join(REPO, 'dev', 'fake-claude.js');

const LIVE_PLIST = 'io.claudewow.bridge.plist';

function liveCheckouts(home) {
  try {
    const plist = fs.readFileSync(path.join(home, 'Library', 'LaunchAgents', LIVE_PLIST), 'utf8');
    const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return m ? [m[1]] : [];
  } catch {
    return [];
  }
}

function forbiddenRoots(home = os.homedir(), platform = process.platform) {
  const roots = [
    path.join(home, '.claude-wow'),
    path.join(home, 'Library', 'LaunchAgents'),
    path.join(home, 'Library', 'Logs', 'claude-wow'),
    path.join(home, '.claude'),
    '/Applications/World of Warcraft',
    ...liveCheckouts(home),
  ].map(p => path.resolve(p));
  if (platform === 'win32') roots.push('C:\\Program Files (x86)\\World of Warcraft', 'C:\\Program Files\\World of Warcraft');
  return roots;
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.join(cur, ...rest.reverse());
    rest.push(path.basename(cur));
    cur = up;
  }
}

function assertSafe(p, home = os.homedir()) {
  const abs = path.resolve(p);
  for (const candidate of new Set([abs, realish(abs)])) {
    for (const bad of forbiddenRoots(home)) {
      if (isWithin(candidate, bad) || isWithin(bad, candidate)) throw new Error(`refusing to touch ${abs}: it overlaps a live install path (${bad})`);
    }
  }
  return abs;
}

function sandboxDir(root, name) {
  if (!/^[\w.-]+$/.test(String(name)) || /^\.+$/.test(String(name)))
    throw new Error(`refusing sandbox name "${name}": use letters, digits, dot, dash and underscore`);
  const dir = path.join(path.resolve(root), name);
  if (!isWithin(dir, path.resolve(root)) || dir === path.resolve(root)) throw new Error(`refusing sandbox ${dir}: it is not inside ${root}`);
  return assertSafe(dir);
}

function clientLayout(dir, flavor) {
  const client = path.join(dir, 'client', flavor);
  const addons = path.join(client, 'Interface', 'AddOns');
  return {
    flavor,
    client,
    addons,
    screenshots: path.join(client, 'Screenshots'),
    savedDir: path.join(client, 'WTF', 'Account', ACCOUNT, 'SavedVariables'),
    saved: path.join(client, 'WTF', 'Account', ACCOUNT, 'SavedVariables', 'ClaudeWoW.lua'),
  };
}

function layout(dir, extraClients = []) {
  const main = clientLayout(dir, PRIMARY_FLAVOR);
  return {
    dir,
    ...main,
    clients: [main, ...extraClients.map(flavor => clientLayout(dir, flavor))],
    home: path.join(dir, 'home'),
    user: path.join(dir, 'user'),
    project: path.join(dir, 'project'),
    agentState: path.join(dir, 'agent'),
    logs: path.join(dir, 'logs'),
    config: path.join(dir, 'home', 'config.json'),
    state: path.join(dir, 'home', 'state.json'),
    transcripts: path.join(dir, 'home', 'transcripts.json'),
    bridgeLog: path.join(dir, 'home', 'bridge.log'),
  };
}

function readExample() {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'bridge', 'config.example.json'), 'utf8'));
}

function withInertStream(cfg) {
  cfg.plugins = Object.assign({}, cfg.plugins, { stream: { ...INERT_STREAM } });
  return cfg;
}

function buildConfig(L, opts = {}) {
  const cfg = readExample();
  const scale = opts.speed && opts.speed > 1 ? opts.speed : 1;
  Object.assign(cfg, {
    addonDir: L.addons,
    savedVariablesFile: L.saved,
    inboxFile: SIG.runtimeInbox(L.addons),
    defaultCwd: L.project,
    tocInterface: opts.tocInterface || CLIENT_INTERFACE,
    slots: opts.slots || 200,
    presenceIntervalMs: Math.max(250, Math.round((opts.presenceIntervalMs || 30000) / scale)),
    pollMs: opts.pollMs || 250,
    timeoutMs: opts.timeoutMs || cfg.timeoutMs || 1800000,
  });
  if (L.clients.length > 1) {
    for (const k of ['addonDir', 'savedVariablesFile', 'inboxFile']) delete cfg[k];
    cfg.clients = L.clients.map(c => ({ dir: c.client, account: ACCOUNT }));
  }
  cfg.capture = Object.assign({}, cfg.capture, { enabled: true, mode: 'screenshot', processName: 'World of Warcraft' }, opts.capture || {});
  cfg.plugins = Object.assign({}, cfg.plugins, { default: opts.plugin || 'claude-code', ask: { cwd: path.join(L.dir, 'ask') } });
  const claude = Object.assign({}, cfg.agents.claude, { path: opts.agentPath ?? FAKE_AGENT });
  cfg.agents = Object.assign({}, cfg.agents, { claude });
  cfg.agent = 'claude';
  if (opts.primerFile !== undefined) cfg.primerFile = opts.primerFile;
  return withInertStream(Object.assign(cfg, opts.config || {}));
}

function copyAddon(L) {
  for (const c of L.clients || [L]) copyAddonTo(c.addons);
}

function copyAddonTo(addons) {
  const src = path.join(REPO, 'addon', 'ClaudeWoW');
  const dest = path.join(addons, 'ClaudeWoW');
  fs.mkdirSync(dest, { recursive: true });
  const names = fs.readdirSync(src);
  for (const stale of fs.readdirSync(dest)) if (!names.includes(stale)) fs.rmSync(assertSafe(path.join(dest, stale)), { recursive: true, force: true });
  const build = P.addonBuild(names.map(name => ({ name, data: fs.readFileSync(path.join(src, name)) })));
  for (const f of names) {
    if (f === 'ClaudeWoW.toc') fs.writeFileSync(path.join(dest, f), P.tocWithBuild(fs.readFileSync(path.join(src, f), 'utf8'), build));
    else fs.copyFileSync(path.join(src, f), path.join(dest, f));
  }
}

function installAddon(L, env) {
  copyAddon(L);
  const r = spawnSync(process.execPath, [path.join(REPO, 'bridge', 'install-slots.js')], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`install-slots failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const HOME_OVERRIDES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GROK_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

function homeEnv(user, platform = process.platform) {
  const env = { HOME: user, USERPROFILE: user };
  if (platform === 'win32') Object.assign(env, { LOCALAPPDATA: path.join(user, 'AppData', 'Local'), APPDATA: path.join(user, 'AppData', 'Roaming') });
  return env;
}

function isolatedEnv(user, extra = {}, base = process.env) {
  const abs = assertSafe(user);
  fs.mkdirSync(abs, { recursive: true });
  const env = { ...base };
  for (const k of Object.keys(env)) if (HOME_OVERRIDES.includes(k.toUpperCase())) delete env[k];
  return Object.assign(env, homeEnv(abs), extra);
}

function envFor(L, extra = {}) {
  const keep = ['PATH', 'LANG', 'TMPDIR', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC', ...WINDOWS_SYSTEM_ENV];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return Object.assign(
    env,
    homeEnv(L.user),
    {
      CLAUDE_WOW_HOME: L.home,
      CLAUDE_WOW_FAKE_STATE: L.agentState,
      CLAUDE_WOW_SANDBOX: L.dir,
    },
    extra,
  );
}

function create(name = 'default', opts = {}) {
  const dir = sandboxDir(opts.root || DEFAULT_ROOT, name);
  if (opts.fresh !== false && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  const extra = opts.extraClients || [];
  for (const flavor of extra)
    if (!FLAVOR_RE.test(String(flavor)) || flavor === PRIMARY_FLAVOR)
      throw new Error(`refusing extra client "${flavor}": use a flavor folder name like _classic_era_`);
  const L = layout(dir, extra);
  for (const c of L.clients) for (const d of [c.addons, c.screenshots, c.savedDir]) fs.mkdirSync(assertSafe(d), { recursive: true });
  for (const d of [L.home, L.user, L.project, L.agentState, L.logs]) fs.mkdirSync(assertSafe(d), { recursive: true });
  fs.writeFileSync(path.join(L.project, 'README.md'), '# sandbox project\n');
  const cfg = buildConfig(L, opts);
  fs.writeFileSync(L.config, JSON.stringify(cfg, null, 2) + '\n');
  const env = envFor(L, opts.env);
  const installed = installAddon(L, env);
  fs.writeFileSync(
    path.join(dir, 'sandbox.json'),
    JSON.stringify({ name, created: new Date().toISOString(), repo: REPO, opts: { ...opts, root: undefined } }, null, 2) + '\n',
  );
  return { ...L, name, cfg, env, installed };
}

function open(name = 'default', opts = {}) {
  const dir = sandboxDir(opts.root || DEFAULT_ROOT, name);
  if (!fs.existsSync(path.join(dir, 'sandbox.json'))) throw new Error(`no sandbox at ${dir}; run: npm run dev -- --fresh`);
  const recorded = JSON.parse(fs.readFileSync(path.join(dir, 'sandbox.json'), 'utf8'));
  const L = layout(dir, (recorded.opts && recorded.opts.extraClients) || []);
  const cfg = withInertStream(JSON.parse(fs.readFileSync(L.config, 'utf8')));
  const claude = cfg.agents && cfg.agents.claude;
  const madeForRealAgent = recorded.opts && recorded.opts.agentPath === '';
  if (claude && claude.path === '' && madeForRealAgent && opts.agentPath === undefined) claude.path = FAKE_AGENT;
  fs.writeFileSync(assertSafe(L.config), JSON.stringify(cfg, null, 2) + '\n');
  const env = envFor(L, opts.env);
  const installed = opts.keepAddon ? null : installAddon(L, env);
  return { ...L, name, cfg, env, installed };
}

function writeConfig(sb, patch) {
  const cfg = withInertStream(Object.assign(JSON.parse(fs.readFileSync(sb.config, 'utf8')), patch));
  fs.writeFileSync(assertSafe(sb.config), JSON.stringify(cfg, null, 2) + '\n');
  sb.cfg = cfg;
  return cfg;
}

function signalFile(sb, kind, slot) {
  return SIG.signalFile(sb.addons, kind, slot);
}

function spendSignals(sb, kinds, slots) {
  for (const kind of kinds) for (const s of slots) fs.rmSync(assertSafe(signalFile(sb, kind, s)), { force: true });
}

module.exports = {
  REPO,
  DEFAULT_ROOT,
  FAKE_AGENT,
  ACCOUNT,
  CLIENT_INTERFACE,
  PRIMARY_FLAVOR,
  assertSafe,
  sandboxDir,
  liveCheckouts,
  isWithin,
  forbiddenRoots,
  layout,
  clientLayout,
  buildConfig,
  create,
  open,
  writeConfig,
  envFor,
  isolatedEnv,
  signalFile,
  spendSignals,
};
