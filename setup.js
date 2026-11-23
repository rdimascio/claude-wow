#!/usr/bin/env node
'use strict';
// One-shot installer.
//
//   node setup.js [--wow "<client folder>"] [--project "<default work folder>"] [--account <name>]
//
// Finds the WoW: Forever client, copies the addon into Interface\AddOns, writes
// config.json in the home folder from the example (if missing), and builds the slot pool.
// Re-running is safe: existing config and generated files are kept, except that
// an explicit --project updates defaultCwd (that is the only way to correct it
// without editing config.json by hand).
//
// An install of this project under one of its old names (wowgpt: the
// ClaudeWoW addon, ClaudeWoW_S### slots, ClaudeWoW.lua saved data; before that
// wow-ai and WoWAI, and wow-claude and WoWClaude) is migrated: the saved data is carried over so chats survive, the
// old folders are removed so two addons don't fight over the slash commands and
// /r, and config.json is brought up to date.

require('./bridge/legacyenv').adopt(); // CLAUDE_WOW_* from before the rename count as WOWGPT_*, before anything reads them
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Literal requires: the compiled binary bundles what it can see (runtime.js).
const P = require('./bridge/protocol'); // the addon's name, and its old names
const H = require('./bridge/home'); // WOWGPT_HOME: where config.json and the state live
const R = require('./bridge/runtime'); // node, bun, or the compiled binary
const A = require('./bridge/agents'); // which agent CLIs this PC has
const AS = require('./bridge/assets'); // the addon, the config template and the capture scripts, by path
const G = require('./bridge/gamefs');
const SIG = require('./bridge/signals');
const CLI = require('./bridge/clients');
const CP = require('./bridge/clientproc'); // whether a game client is running
const PJ = require('./bridge/projects');
const SVC = require('./bridge/service');
const ASK = require('./bridge/plugins/ask'); // its data folder had the old name
const ADDON_SRC = AS.dir('addon/' + P.ADDON);
const EXAMPLE = AS.file('bridge/config.example.json');
let CONFIG = H.resolve().config; // settled in main(), after the legacy layout has been migrated

const args = {};
function parseArgs(argv) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return args;
}

// package.json says node >=22.2, but npm does not enforce engines by default, so a
// too-old node otherwise fails later with something unrelated-looking. Bun (and
// the binary, which is Bun) reports a node version of its own choosing: not checked.
const MIN_NODE = [22, 2];
function checkNode() {
  if (R.bun) return;
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1])) return;
  throw new Error(
    `Node ${MIN_NODE.join('.')} or newer is required; this is ${process.versions.node}. Install a newer Node (https://nodejs.org) and run setup again.`,
  );
}

// The default work folder. Validated, because the README's example is a Windows
// placeholder and path.resolve() would otherwise silently glue it onto the folder
// setup was run from, producing a path that exists nowhere and only fails in game.
// The project folder a fresh config gets: a folder of its own, never the
// folder setup happens to run in.
const DEFAULT_PROJECT_NAME = 'wowgpt';
const defaultProject = () => path.join(os.homedir(), DEFAULT_PROJECT_NAME);

function resolveProject(raw) {
  const p = String(raw === true ? '' : raw).trim();
  if (!p) throw new Error('--project needs a folder (e.g. --project ~/code/my-game)');
  const windowsShaped = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (windowsShaped && process.platform !== 'win32') {
    throw new Error(`--project "${p}" is a Windows path, but this is ${process.platform}. Pass a path for this machine, e.g. --project ~/code/my-game`);
  }
  const abs = path.resolve(p.replace(/^~(?=[\\/]|$)/, os.homedir()));
  if (!fs.existsSync(abs)) {
    throw new Error(
      `--project "${p}" does not exist (looked in ${abs}). ` +
        `Pass the folder you want the agents to work in, or leave --project off to use ${defaultProject()}.`,
    );
  }
  if (!fs.statSync(abs).isDirectory()) throw new Error(`--project "${p}" is not a folder (${abs})`);
  if (PJ.tooWide(abs))
    throw new Error(
      `--project "${p}" is your home folder or a disk root, and the agents may edit anything in their project. Pass a folder inside it, e.g. --project ~/code/my-game`,
    );
  return abs;
}

function makeDefaultProject() {
  const dir = defaultProject();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A folder listing, sorted: Node's comes back alphabetical (libuv sorts it),
// Bun's in the order the OS gives, and "the first account" or "the first
// game executable" must be the same choice from a checkout and from the binary.
const listDir = dir => fs.readdirSync(dir).sort();

function isClient(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'Interface'))) return false;
    const items = listDir(dir);
    // Windows: the game exe. macOS: the .app bundle. Linux (Wine): the Wine exe.
    return items.some(f => /^Wow.*\.exe$/i.test(f) || /\.app$/i.test(f));
  } catch {
    return false;
  }
}

function namedClient() {
  if (isClient(args.wow)) return path.resolve(args.wow);
  throw new Error(`--wow "${args.wow}" does not look like a WoW client folder (needs Interface\\ and a game binary)`);
}

function detectClients() {
  let roots;
  if (process.platform === 'win32') {
    roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'D:\\', 'E:\\', 'D:\\Games', 'E:\\Games', 'C:\\Games']
      .filter(Boolean)
      .map(r => path.join(r, 'World of Warcraft'));
  } else if (process.platform === 'darwin') {
    roots = ['/Applications/World of Warcraft', path.join(os.homedir(), 'Applications', 'World of Warcraft')];
  } else {
    // Linux: the client lives inside a Wine prefix.
    roots = [process.env.WINEPREFIX, path.join(os.homedir(), '.wine'), path.join(os.homedir(), 'Games', 'battlenet')]
      .filter(Boolean)
      .flatMap(p => ['Program Files (x86)', 'Program Files'].map(pf => path.join(p, 'drive_c', pf, 'World of Warcraft')));
  }
  const found = [];
  for (const root of roots) {
    for (const flavor of ['_classic_beta_', '_forever_', '_classic_era_']) {
      const dir = path.join(root, flavor);
      if (isClient(dir) && !found.some(d => CLI.sameDir(d, dir))) found.push(dir);
    }
  }
  return found;
}

const NO_CLIENT = 'Could not find the WoW client. Pass --wow "<path to World of Warcraft/_classic_beta_, _forever_ or _classic_era_>"';

function accountsIn(client) {
  const base = path.join(client, 'WTF', 'Account');
  try {
    return listDir(base).filter(n => n !== 'SavedVariables' && fs.statSync(path.join(base, n)).isDirectory());
  } catch {
    return [];
  }
}

function findAccount(client, { wanted = '', current = '', strict = true } = {}) {
  const base = path.join(client, 'WTF', 'Account');
  const names = accountsIn(client);
  if (wanted) {
    if (names.includes(wanted)) return wanted;
    if (strict) throw new Error(`Account "${wanted}" not found under ${base}`);
    console.log(`Account "${wanted}" not found in ${CLI.labelOf(client)} (${names.join(', ') || 'no account folder'}); keeping its own.`);
  }
  if (current && names.includes(current)) return current;
  if (!names.length) return '';
  if (names.length > 1)
    console.log(`Several accounts found in ${CLI.labelOf(client)} (${names.join(', ')}); using "${names[0]}". Pass --account to choose another.`);
  return names[0];
}

// The previous names of this project. Chats live in the addon's saved data, so
// carry that over (renaming the globals inside: the game loads a SavedVariables
// file by the addon's name and keeps only the globals the .toc declares), then
// remove the old addon and its slot pool: the game only needs one of each, and
// the old one would still answer /r and the shift-click hook. The old saved
// file is left where it is; nothing here deletes saved data. Agent sessions
// are keyed by chat id in the bridge's state.json, so they follow the chats.
// The addon's SavedVariables globals are <ADDON><suffix>: DB and WidgetDB in
// the account file, MapDB and CharDB in each character's file (the .toc's
// SavedVariables and SavedVariablesPerCharacter lines).
const SAVED_GLOBAL_SUFFIXES = ['DB', 'WidgetDB', 'MapDB', 'CharDB'];

function migrateSavedData(oldName, oldSaved, newSaved) {
  let src = fs.readFileSync(oldSaved, 'utf8');
  for (const g of SAVED_GLOBAL_SUFFIXES) src = src.replace(new RegExp('^' + oldName + g + '(\\s*=)', 'gm'), P.ADDON + g + '$1');
  G.writeFile(newSaved, src);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// WTF/Account/<account>/<realm>/<character>/SavedVariables: one per character
// that has logged in on this account.
function characterSavedDirs(accountDir) {
  const dirs = [];
  for (const realm of isDir(accountDir) ? listDir(accountDir) : []) {
    if (realm === 'SavedVariables' || !isDir(path.join(accountDir, realm))) continue;
    for (const character of listDir(path.join(accountDir, realm))) {
      const saved = path.join(accountDir, realm, character, 'SavedVariables');
      if (isDir(saved)) dirs.push(saved);
    }
  }
  return dirs;
}

// One SavedVariables folder: the newest old name's file becomes the new one,
// unless the new one is already there (the game has written it since).
function migrateSavedDir(savedDir, label) {
  const newSaved = path.join(savedDir, P.ADDON + '.lua');
  for (const old of P.OLD_ADDONS) {
    const oldSaved = path.join(savedDir, old + '.lua');
    if (!fs.existsSync(oldSaved) || fs.existsSync(newSaved)) continue;
    migrateSavedData(old, oldSaved, newSaved);
    console.log(`migrate  : ${label} copied from ${path.basename(oldSaved)} to ${path.basename(newSaved)} (${path.basename(oldSaved)} is kept)`);
  }
}

function removeOldAddonFolders(addons) {
  for (const old of P.OLD_ADDONS) {
    let removed = 0;
    for (const name of fs.existsSync(addons) ? fs.readdirSync(addons) : []) {
      if (name === old || new RegExp('^' + old + '_S\\d{3}$').test(name)) {
        fs.rmSync(path.join(addons, name), { recursive: true, force: true });
        removed++;
      }
    }
    if (removed) console.log(`migrate  : removed the old ${old} addon and slot folders (${removed} folder(s))`);
  }
}

function migrateOldInstall(client, account) {
  const accountDir = path.join(client, 'WTF', 'Account', account);
  migrateSavedDir(path.join(accountDir, 'SavedVariables'), 'chats and settings');
  for (const dir of characterSavedDirs(accountDir)) {
    const character = path.relative(accountDir, path.dirname(dir)).split(path.sep).join('/');
    migrateSavedDir(dir, `map and character data of ${character}`);
  }
  removeOldAddonFolders(path.join(client, 'Interface', 'AddOns'));
}

function copyAddon(client) {
  const dest = path.join(client, 'Interface', 'AddOns', P.ADDON);
  G.mkdir(dest);
  const names = P.addonFiles(ADDON_SRC);
  const build = P.addonBuild(names.map(name => ({ name, data: fs.readFileSync(path.join(ADDON_SRC, name)) })));
  const toc = P.ADDON + '.toc';
  let copied = 0;
  for (const f of names) {
    G.mkdir(path.dirname(path.join(dest, f)));
    if (f === toc) G.writeFile(path.join(dest, f), P.tocWithBuild(fs.readFileSync(path.join(ADDON_SRC, f), 'utf8'), build));
    else G.copyFile(path.join(ADDON_SRC, f), path.join(dest, f));
    copied++;
  }
  return { dest, copied, build };
}

// A config.json from before a rename, or from before agents: fix the paths
// that named an old addon, and move Claude's settings under agents.claude next
// to the codex and grok blocks from the example. Everything else is kept.
function upgradeConfig(cfg, example) {
  const notes = [];
  if (P.OLD_ADDON_PATH.test(cfg.inboxFile || '') || P.SHIPPED_INBOX_PATH.test(cfg.inboxFile || '')) {
    cfg.inboxFile = SIG.runtimeInbox(cfg.addonDir);
    notes.push('inboxFile');
  }
  if (P.OLD_SAVED_FILE.test(cfg.savedVariablesFile || '')) {
    cfg.savedVariablesFile = cfg.savedVariablesFile.replace(P.OLD_SAVED_FILE, P.ADDON + '.lua');
    notes.push('savedVariablesFile');
  }
  if (P.OLD_TOC_INTERFACES.includes(String(cfg.tocInterface || '').trim())) {
    cfg.tocInterface = P.TOC_INTERFACE;
    notes.push('tocInterface');
  }
  for (const entry of Array.isArray(cfg.clients) ? cfg.clients : []) {
    if (entry && P.OLD_TOC_INTERFACES.includes(String(entry.tocInterface || '').trim())) {
      delete entry.tocInterface;
      if (!notes.includes('tocInterface')) notes.push('tocInterface');
    }
  }
  if (!cfg.agents) {
    const claude = { ...example.agents.claude };
    if (cfg.claudePath) claude.path = cfg.claudePath;
    if (cfg.model) claude.model = cfg.model;
    if (cfg.permissionMode) claude.permissionMode = cfg.permissionMode;
    if (Array.isArray(cfg.allowedTools)) claude.allowedTools = cfg.allowedTools;
    cfg.agent = cfg.agent || example.agent;
    cfg.agents = { claude, codex: { ...example.agents.codex }, grok: { ...example.agents.grok } };
    for (const k of ['claudePath', 'model', 'permissionMode', 'allowedTools']) delete cfg[k];
    notes.push('agents');
  }
  return notes;
}

function processNameFor(client) {
  const exe = listDir(client).find(f => /^Wow.*\.exe$/i.test(f) || /\.app$/i.test(f));
  if (!exe) return '';
  if (process.platform === 'darwin' && exe.toLowerCase().endsWith('.app')) {
    const macosDir = path.join(client, exe, 'Contents', 'MacOS');
    try {
      const bins = listDir(macosDir).filter(f => fs.statSync(path.join(macosDir, f)).isFile());
      if (bins.length) return bins[0];
    } catch {}
  }
  return exe.replace(/\.exe$/i, '');
}

function entryFor(client, account) {
  const entry = { dir: client };
  if (account) entry.account = account;
  const processName = processNameFor(client);
  if (processName) entry.processName = processName;
  return entry;
}

const SHARE_FLAG = 'share-game-state';
const SHARE_QUESTION =
  'Share your game state with the agent? This sends your character, zone, quests, money, bags and professions to the agent provider (for example Anthropic or OpenAI) with each message. [y/N] ';

function yesNo(raw) {
  const answer = String(raw === true ? 'yes' : raw || '')
    .trim()
    .toLowerCase();
  if (['y', 'yes', 'on', 'true'].includes(answer)) return true;
  if (['n', 'no', 'off', 'false', ''].includes(answer)) return false;
  return null;
}

function readLineSync() {
  const buf = Buffer.alloc(1);
  let line = '';
  while (true) {
    let n = 0;
    try {
      n = fs.readSync(0, buf, 0, 1, null);
    } catch {
      return line;
    }
    if (n === 0 || buf[0] === 0x0a) return line;
    line += String.fromCharCode(buf[0]);
  }
}

function chooseShare({ flag, interactive, ask }) {
  if (flag !== undefined) {
    const picked = yesNo(flag);
    if (picked === null) throw new Error(`--${SHARE_FLAG} takes yes or no, not "${flag}"`);
    return picked;
  }
  if (!interactive) return false;
  return yesNo(ask(SHARE_QUESTION)) === true;
}

function askOnTerminal(question) {
  process.stdout.write(question);
  return readLineSync();
}

function applyShare(cfg, share) {
  cfg.gameContext = share;
  cfg.telemetry = { ...(cfg.telemetry && typeof cfg.telemetry === 'object' ? cfg.telemetry : {}), enabled: share };
}

function sharesGameState(cfg) {
  return cfg.gameContext !== false && !(cfg.telemetry && cfg.telemetry.enabled === false);
}

function noteOnce(notes, name) {
  if (!notes.includes(name)) notes.push(name);
}

function loadConfig() {
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  if (!fs.existsSync(CONFIG)) {
    const cfg = example;
    for (const k of CLI.LEGACY_KEYS) delete cfg[k];
    cfg.clients = [];
    cfg.defaultCwd = args.project ? resolveProject(args.project) : makeDefaultProject();
    applyShare(cfg, chooseShare({ flag: args[SHARE_FLAG], interactive: !!process.stdin.isTTY, ask: askOnTerminal }));
    return { cfg, notes: [], fresh: true };
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const notes = upgradeConfig(cfg, example);
  for (const n of CLI.migrateConfig(cfg)) noteOnce(notes, n);
  if (args[SHARE_FLAG] !== undefined) {
    const before = JSON.stringify([cfg.gameContext, cfg.telemetry]);
    applyShare(cfg, chooseShare({ flag: args[SHARE_FLAG], interactive: false, ask: askOnTerminal }));
    if (JSON.stringify([cfg.gameContext, cfg.telemetry]) !== before) notes.push('gameContext, telemetry');
  }
  if (args.project) {
    const want = resolveProject(args.project);
    if (cfg.defaultCwd !== want) {
      cfg.defaultCwd = want;
      notes.push('defaultCwd');
    }
  }
  return { cfg, notes, fresh: false };
}

function chooseClients(cfg, notes) {
  if (args.wow) {
    const dir = namedClient();
    const known = CLI.allClients(cfg).find(c => CLI.sameDir(c.dir, dir));
    const account = findAccount(dir, { wanted: args.account || '', current: known ? known.account : '' });
    const how = CLI.upsertClient(cfg, { ...entryFor(dir, account), enabled: true });
    if (how !== 'same') noteOnce(notes, 'client');
    return;
  }
  for (const dir of detectClients()) {
    if (CLI.allClients(cfg).some(c => CLI.sameDir(c.dir, dir))) continue;
    CLI.upsertClient(cfg, entryFor(dir, findAccount(dir, { wanted: args.account || '', strict: false })));
    noteOnce(notes, 'client');
  }
}

function refreshClient(cfg, client, notes) {
  const account = findAccount(client.dir, { wanted: args.wow ? '' : args.account || '', current: client.account, strict: false });
  const how = CLI.upsertClient(cfg, entryFor(client.dir, account));
  if (how !== 'same') noteOnce(notes, 'client');
  return CLI.clientsOf(cfg).find(c => c.key === client.key);
}

function writePrivateConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: H.PRIVATE_DIR_MODE });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', { mode: H.PRIVATE_FILE_MODE });
}

function restrictConfig() {
  if (process.platform === 'win32') return;
  if (path.dirname(CONFIG) !== H.LEGACY_DIR) fs.chmodSync(path.dirname(CONFIG), H.PRIVATE_DIR_MODE);
  fs.chmodSync(CONFIG, H.PRIVATE_FILE_MODE);
}

function saveConfig(cfg, notes, fresh) {
  if (fresh) {
    writePrivateConfig(cfg);
    console.log(`config   : wrote ${CONFIG}`);
  } else if (notes.length) {
    writePrivateConfig(cfg);
    console.log(`config   : ${CONFIG} updated (${notes.join(', ')}); everything else kept`);
  } else {
    console.log(`config   : ${CONFIG} already exists, keeping it`);
  }
  restrictConfig();
}

// Warnings collected as we go, repeated at the end so they are not scrolled past.
const warnings = [];
function warn(line, hint) {
  warnings.push(hint ? `${line}\n           -> ${hint}` : line);
  console.log(`warning  : ${line}${hint ? `\n           -> ${hint}` : ''}`);
}

// Which outbound transport this config starts the bridge on (protocol.chooseTransport):
// the screenshot transport unless capture.mode says "pixel". The deprecated
// pixel capture is the only part of the install that needs python3 (off
// Windows) and, on macOS, the Screen Recording and Automation permissions.
function transportReport(cfg) {
  const t = P.chooseTransport(cfg.capture);
  if (t.transport === 'screenshot') {
    console.log('transport: screenshot (the default): the addon calls Screenshot(), the bridge reads the file; no screen capture, no permissions, no python');
  } else if (t.transport === 'pixel') {
    console.log(
      'transport: pixel (capture.mode in config.json): DEPRECATED screen capture, kept only until Screenshot() is confirmed on Windows and on Linux under Wine; remove capture.mode (or set it to "screenshot") to use the screenshot transport',
    );
  }
  return t.transport;
}

// Off Windows the pixel capture is a python3 script. On the screenshot transport
// that is only the fallback the bridge makes when the addon reports it cannot
// shoot, so a missing interpreter is worth a line, not a warning; on the pixel
// transport it means no messages ever reach the bridge. Reported next to the agent CLIs.
function pythonReport(cfg, transport) {
  if (process.platform === 'win32') return; // capture.ps1 needs no python
  const py = (cfg.capture && cfg.capture.python) || 'python3';
  const r = spawnSync(py, ['--version'], { encoding: 'utf8' });
  const os = process.platform === 'darwin' ? 'macOS' : 'Linux';
  if (r.error || r.status !== 0) {
    const how =
      process.platform === 'darwin'
        ? 'Install it with: xcode-select --install (or brew install python3), then run setup again.'
        : 'Install python3 from your package manager, then run setup again.';
    if (transport === 'screenshot') {
      console.log(
        `python   : not found ("${py}"); only the deprecated pixel-capture fallback needs it (the ${os} screen capture is a python script), the screenshot transport does not. ${how.replace('Install it', 'If you want that fallback, install it')}`,
      );
    } else {
      warn(`python3 not found ("${py}"), and the ${os} screen capture is a python script`, how);
    }
    return;
  }
  console.log(
    `python   : ${(r.stdout || r.stderr).trim()} (${py})${transport === 'screenshot' ? '; only the deprecated pixel-capture fallback needs it' : ''}`,
  );
}

// macOS: the two permissions the pixel capture cannot work without, checked for
// real rather than discovered later as a screencapture error repeating once a
// second. On the screenshot transport neither is needed, so the check is skipped
// and named, for anyone who wants the deprecated fallback ready.
function macCaptureReport(cfg, transport) {
  if (process.platform !== 'darwin') return;
  if (transport === 'screenshot') {
    console.log(
      'capture  : screenshot transport, so no Screen Recording or Automation permission is needed (npm run check:mac checks them for the deprecated pixel fallback)',
    );
    return;
  }
  const py = (cfg.capture && cfg.capture.python) || 'python3';
  const r = spawnSync(py, [AS.file('bridge/capture_mac.py'), '--check', '--process-name', (CLI.clientsOf(cfg)[0] || { processName: 'WowB' }).processName], {
    encoding: 'utf8',
  });
  if (r.error) return; // python already reported missing
  const rows = String(r.stdout || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!rows.length) {
    warn('could not check the macOS screen-capture permissions', `Run it yourself: ${py} bridge/capture_mac.py --check`);
    return;
  }
  const label = { 'screen-recording': 'Screen Recording', window: 'window access', scale: 'display scale' };
  for (const row of rows) {
    const name = label[row.check] || row.check;
    if (row.ok) console.log(`capture  : ${name} OK${row.detail ? ' - ' + row.detail : ''}`);
    else warn(`${name}: ${row.detail || 'not available'}`, row.hint);
  }
}

// Which agent CLIs this PC has, so the last lines of setup can say what is missing.
function agentReport(cfg) {
  const lines = [];
  for (const id of A.agentIds()) {
    const r = A.resolveCommand(id, A.agentConfig(cfg, id));
    lines.push(
      `  ${A.AGENTS[id].name.padEnd(7)}: ${r.found ? r.file + (r.args.length ? ' ' + r.args.join(' ') : '') : 'not found (' + A.AGENTS[id].install + ')'}`,
    );
  }
  return lines.join('\n');
}

// Setup copies saved chats and removes old signal folders under the client
// folder: never while that client runs. When the check cannot tell, setup goes
// on and says so.
async function refuseRunningClients(clients) {
  for (const c of clients) {
    const state = await CP.clientState(c.dir);
    if (state.running === true) throw new Error(`${c.label} is running. Quit World of Warcraft, then run setup again.`);
    if (state.running === null)
      warn(
        `could not tell whether ${c.label} is running (${state.why})`,
        'If it is, quit it and run setup again: setup changes its saved chats and addon files.',
      );
  }
}

// The agents that are a program on this PC. The local agent is part of this
// one, so it is always "found" and says nothing about what the user installed.
const isAgentProgram = id => typeof A.AGENTS[id].resolve !== 'function';

function installedAgents(cfg) {
  return A.agentIds().filter(id => isAgentProgram(id) && A.resolveCommand(id, A.agentConfig(cfg, id)).found);
}

// The default agent must be one this PC has: with exactly one other installed
// it becomes the default. Returns false when no agent is installed at all.
function chooseAgent(cfg, notes) {
  const wanted = A.normalizeAgent(cfg.agent) || A.DEFAULT_AGENT;
  const installed = installedAgents(cfg);
  if (!isAgentProgram(wanted) || installed.includes(wanted)) return true;
  if (installed.length === 1) {
    cfg.agent = installed[0];
    noteOnce(notes, 'agent');
    console.log(`agent    : ${A.displayName(wanted)} is not installed and ${A.displayName(installed[0])} is, so ${installed[0]} is the default agent now`);
    return true;
  }
  if (installed.length > 1) {
    warn(`${A.displayName(wanted)}, the default agent, is not installed`, `Set "agent" in config.json to one that is: ${installed.join(', ')}.`);
    return true;
  }
  return false;
}

const SERVICE_QUESTION = 'Run the bridge in the background and start it at login? [Y/n] ';

// An empty answer takes the default, yes.
function yesByDefault(raw) {
  return String(raw || '').trim() === '' || yesNo(raw) === true;
}

// What to do about the background service. An existing one (under this name or
// an old one) is reinstalled without asking, so an upgrade runs the new
// program; only a fresh install asks.
function serviceFlag(flag) {
  if (flag === undefined) return undefined;
  const said = yesNo(flag);
  if (said === null) throw new Error(`--service takes yes or no, not "${flag}"`);
  return said;
}

function chooseService({ said, skip, existing, interactive, ask }) {
  if (skip || said === false) return 'skip';
  if (existing.length) return 'reinstall';
  if (said === true) return 'install';
  if (!interactive) return 'skip';
  return yesByDefault(ask(SERVICE_QUESTION)) ? 'install' : 'skip';
}

function installService(how) {
  console.log(`service  : ${how === 'reinstall' ? 'reinstalling the background service, so it runs this version' : 'installing the background service'}`);
  const code = SVC.main(['install'], { b: SVC.backend(process.platform) });
  const installed = code === 0 || code === SVC.NOT_RUNNING;
  if (!installed) warn('the background service did not install (see above)', 'Start the bridge by hand instead, or fix the problem and run setup again.');
  return installed;
}

function onPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some(dir => exts.some(ext => fs.existsSync(path.join(dir, name + ext))));
}

// How the user starts this program: npm start in a git checkout run as
// node setup.js, else wowgpt, or its full path while it is not on the PATH.
function startCommand() {
  const fromCheckout = !R.compiled && process.env.WOWGPT_FROM_COMMAND !== '1' && fs.existsSync(path.join(R.ROOT, '.git'));
  if (fromCheckout) return 'npm start';
  if (onPath('wowgpt')) return 'wowgpt';
  if (R.compiled) return `"${process.execPath}"`;
  return `"${process.execPath}" "${path.join(R.ROOT, 'bridge', 'supervisor.js')}"`;
}

const CLAUDE_LOGIN_HINT = 'claude   : run `claude` once in a terminal and log in, or every chat fails with "not logged in"';

function nextSteps({ command, agentReady, service, transport }) {
  const steps = [
    'Fully quit and relaunch each World of Warcraft client above that is running (it only discovers new addon folders at launch).',
    'Enable "WoWGPT" at the character select AddOns screen (the WoWGPT slot ### entries stay enabled).',
  ];
  const runner = command === 'npm start' ? 'wowgpt' : command;
  if (!agentReady) {
    steps.push(`Install one agent (see the list above), then run setup again:  ${runner} setup`);
  } else if (service) {
    steps.push(`The bridge runs in the background. Check it with:  ${runner} service status`);
  } else {
    const where =
      process.platform === 'win32'
        ? '; bridge\\start-window.cmd opens its own window'
        : transport === 'screenshot'
          ? ''
          : process.platform === 'darwin'
            ? '; keep the game windowed or borderless, and check the capture with: npm run probe:mac'
            : '; keep the game borderless/windowed and check the capture with: npm run probe';
    steps.push(`Start the bridge:  ${command}   (in this terminal${where})`);
  }
  steps.push('In game:  /wowgpt');
  return `\n${agentReady ? 'Done' : 'Not ready yet'}. Next:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n`;
}

async function main() {
  try {
    parseArgs(process.argv);
    const command = startCommand();
    checkNode();
    // Validate arguments before copying anything, so a bad --project costs nothing.
    if (args.project) args.project = resolveProject(args.project);
    serviceFlag(args.service);
    // Config, state and transcripts from a checkout that kept them in bridge/ move
    // to the home folder first, so the config written below lands in one place.
    const renamed = H.migrateOldHome();
    const askData = ASK.migrateOldData();
    if (askData) console.log(`migrate  : ${askData} copied to ${ASK.dataDir()} (the old folder is kept)`);
    const carried = H.migrateLegacy();
    const home = H.resolve();
    CONFIG = home.config;
    console.log(`home     : ${home.dir}${home.source === 'WOWGPT_HOME' ? '  (WOWGPT_HOME)' : ''}`);
    if (renamed)
      console.log(
        `migrate  : ${renamed.from} copied to ${home.dir} (${renamed.copied.length} item(s); ${renamed.from} is kept, and its releases are not copied)`,
      );
    const oldHome = H.oldHomeDir();
    if (oldHome && oldHome !== home.dir && home.source === 'default') {
      const rebased = H.rebaseOldHome(home.dir, oldHome);
      if (rebased.length) console.log(`migrate  : ${rebased.join(', ')}: paths under ${oldHome} now point to ${home.dir}`);
      const still = H.oldHomeReferences(home.dir, oldHome);
      if (still.length) console.log(`old home : ${oldHome} is still named in ${still.join(', ')}; keep it until nothing there names it`);
      else console.log(`old home : ${oldHome} is no longer used; you can remove it once this install works (it still holds your old config and tokens)`);
    }
    if (carried.length)
      console.log(
        `migrate  : ${carried.join(', ')} copied from ${H.LEGACY_DIR} to ${home.dir}; the bridge reads them there from now on (the copies in bridge/ are no longer used)`,
      );
    const { cfg, notes, fresh } = loadConfig();
    chooseClients(cfg, notes);
    const targets = CLI.clientsOf(cfg);
    if (!targets.length) throw new Error(NO_CLIENT);
    await refuseRunningClients(targets);
    const several = targets.length > 1;
    for (const listed of targets) {
      const client = refreshClient(cfg, listed, notes);
      const tag = several ? `${client.label}: ` : '';
      console.log(`client   : ${client.dir}`);
      if (client.account) {
        console.log(`account  : ${tag}${client.account}`);
        migrateOldInstall(client.dir, client.account);
      } else {
        warn(
          `${client.label} has no account folder under ${path.join(client.dir, 'WTF', 'Account')}, so the bridge cannot read its /reload outbox`,
          'Log into that game once, then run setup again.',
        );
      }
      const { dest, copied, build } = copyAddon(client.dir);
      console.log(`addon    : ${tag}${copied} file(s) -> ${dest} (build ${build}, /wowgpt diag shows it)`);
    }
    const skipped = CLI.allClients(cfg).filter(c => !c.enabled);
    for (const c of skipped) console.log(`client   : ${c.dir} skipped ("enabled": false in config.json)`);
    const agentReady = chooseAgent(cfg, notes);
    saveConfig(cfg, notes, fresh);
    console.log(
      `privacy  : game state ${sharesGameState(cfg) ? 'is shared with the agent' : 'is not shared with the agent'} (change with --${SHARE_FLAG} yes|no, or gameContext and telemetry.enabled in config.json)`,
    );
    console.log(`project  : ${cfg.defaultCwd}  (change with /wowgpt cd in game, or defaultCwd in config.json)`);
    // A defaultCwd that no longer exists (moved folder, or a bad --project from an
    // earlier run) makes every chat fail with "Folder does not exist" in game.
    if (!fs.existsSync(cfg.defaultCwd)) {
      warn(
        `the default project folder does not exist: ${cfg.defaultCwd}`,
        'Every chat that has not picked its own folder will fail. Fix it with: node setup.js --project "<folder>"',
      );
    } else if (PJ.tooWide(cfg.defaultCwd)) {
      warn(
        `the default project folder is your home folder or a disk root (${cfg.defaultCwd}), so an agent may edit any file there`,
        `Give the agents a folder of their own: ${command} setup --project ${defaultProject()}`,
      );
    }
    if (agentReady) console.log(`agent    : ${cfg.agent} by default (per chat with /wowgpt --agent <id> in game, or "agent" in config.json)`);
    else console.log('agent    : not ready: install one agent (the list below), then run setup again');
    console.log(agentReport(cfg));
    if ((A.normalizeAgent(cfg.agent) || A.DEFAULT_AGENT) === 'claude') console.log(CLAUDE_LOGIN_HINT);
    const transport = transportReport(cfg);
    pythonReport(cfg, transport);
    macCaptureReport(cfg, transport);
    console.log('slots    : building the reply-slot pool and signal files...');
    const movesSignals = CLI.clientsOf(cfg).some(c => SIG.legacySignalFolders(c.addonDir).length > 0);
    const r = spawnSync(...R.scriptCommand('install-slots'), { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('install-slots.js failed');
    if (movesSignals) warn(SIG.RESTART_NOTE, 'A /reload is not enough: the game only sees files that existed when it started.');
    const plan = chooseService({
      said: serviceFlag(args.service),
      skip: !!args['no-service'],
      existing: SVC.installedDefinitions(),
      interactive: !!process.stdin.isTTY,
      ask: askOnTerminal,
    });
    let service = false;
    if (plan === 'skip') console.log(`service  : not installed (install it later with: ${command === 'npm start' ? 'wowgpt' : command} service install)`);
    else if (!agentReady) warn('the background service was not installed, because no agent is installed');
    else service = installService(plan);
    if (warnings.length) {
      console.log(`\n${warnings.length} warning(s) to deal with first:`);
      for (const w of warnings) console.log(`  - ${w}`);
    }
    console.log(nextSteps({ command, agentReady, service, transport }));
  } catch (e) {
    console.error('setup failed:', e.message);
    process.exit(1);
  }
}

// Run as a script this is the installer; required (tests/setup_test.js) it only
// lends out the pieces, the migration above all.
if (require.main === module) main();
module.exports = {
  migrateOldInstall,
  migrateSavedData,
  characterSavedDirs,
  copyAddon,
  upgradeConfig,
  entryFor,
  isClient,
  detectClients,
  findAccount,
  parseArgs,
  chooseShare,
  applyShare,
  sharesGameState,
  SHARE_QUESTION,
  SERVICE_QUESTION,
  chooseService,
  transportReport,
  main,
};
