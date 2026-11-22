'use strict';
// WOWGPT_HOME: where the bridge keeps what is not code. config.json,
// state.json (the agents' sessions, keyed by chat), transcripts.json, bridge.log,
// tmp/ (prompt files and vision PNGs for a run) and mapjobs/ live there, so the
// code can be replaced (git pull, brew upgrade, the installer run again) without
// touching any of it. Resolution, first match wins:
//
//   1. $WOWGPT_HOME, when set (a leading ~ expands; the old CLAUDE_WOW_HOME
//      counts when it is not set)
//   2. ~/.wowgpt, once it holds a config.json
//   3. ~/.claude-wow, the home from before the rename to WoWGPT, while it
//      holds a config.json. setup.js copies it to 2 on its next run.
//   4. this checkout's bridge/ folder, while it holds a config.json: the layout
//      from before there was a home folder. setup.js copies it to 2 on its next
//      run (never into an explicit WOWGPT_HOME: that one is the user's call)
//   5. ~/.wowgpt: a fresh install; setup.js writes the config there
//
// Pure apart from the existence checks, so tests/home_test.js can hand it an
// environment, a home folder and a legacy folder of its own.

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./runtime');
const LE = require('./legacyenv');

// Inside the compiled binary __dirname is the folder the sources were built
// from: a config.json that happens to be there (the build machine's own
// checkout) must not be picked up. There is no legacy layout for a binary.
const LEGACY_DIR = R.compiled ? '' : __dirname;
const FILES = ['config.json', 'state.json', 'transcripts.json']; // what setup.js carries over
const DIR_NAME = '.wowgpt';
const OLD_DIR_NAMES = Object.freeze(['.claude-wow']); // newest first
// What an old home holds that belongs to the process that runs from it, not
// to the user: its releases and their links, locks, the live socket and its
// token, and the per-run scratch folder.
const OLD_HOME_SKIP = Object.freeze(['releases', 'current', 'previous', 'deploy.lock', 'bridge.lock', 'live.sock', 'live.token', 'tmp']);
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function expand(p, home) {
  return path.resolve(String(p).replace(/^~(?=[\\/]|$)/, home));
}

function defaultDir(home = os.homedir()) {
  return path.join(home, DIR_NAME);
}

function hasConfig(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(path.join(dir, 'config.json')).isFile();
  } catch {
    return false;
  }
}

function paths(dir, source) {
  return {
    dir,
    source,
    config: path.join(dir, 'config.json'),
    state: path.join(dir, 'state.json'),
    transcripts: path.join(dir, 'transcripts.json'),
    log: path.join(dir, 'bridge.log'),
    tmp: path.join(dir, 'tmp'),
    mapjobs: path.join(dir, 'mapjobs'),
    uijobs: path.join(dir, 'uijobs'),
    goals: path.join(dir, 'goals'),
    data: path.join(dir, 'data'),
  };
}

function namedHome(env) {
  return LE.read(env, 'HOME') || '';
}

function oldHomeDir(home = os.homedir()) {
  return OLD_DIR_NAMES.map(name => path.join(home, name)).find(hasConfig) || '';
}

function resolve(env = process.env, home = os.homedir(), legacy = LEGACY_DIR) {
  if (namedHome(env)) return paths(expand(namedHome(env), home), 'WOWGPT_HOME');
  const dflt = defaultDir(home);
  if (hasConfig(dflt)) return paths(dflt, 'default');
  const old = oldHomeDir(home);
  if (old) return paths(old, 'old-name');
  if (hasConfig(legacy)) return paths(legacy, 'legacy');
  return paths(dflt, 'default');
}

// The first setup after the upgrade: bring config, state and transcripts over
// from bridge/ to ~/.wowgpt. Copies, not moves: an older checkout of this
// repo still reads bridge/, and nothing here may be able to lose a session.
// Returns the names of the files copied (none when there was nothing to do).
function migrateLegacy(env = process.env, home = os.homedir(), legacy = LEGACY_DIR) {
  if (namedHome(env)) return [];
  const dflt = defaultDir(home);
  if (path.resolve(dflt) === path.resolve(legacy) || hasConfig(dflt) || !hasConfig(legacy)) return [];
  fs.mkdirSync(dflt, { recursive: true, mode: PRIVATE_DIR_MODE });
  const copied = [];
  for (const f of FILES) {
    const from = path.join(legacy, f);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dflt, f));
    if (process.platform !== 'win32') fs.chmodSync(path.join(dflt, f), PRIVATE_FILE_MODE);
    copied.push(f);
  }
  return copied;
}

function realOrSelf(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// The folders an agent run must not read: the home in use, and every old home
// still on disk. setup.js copies an old home but keeps it, and it still holds
// config.json, the live token and any MCP or webhook secret. Each folder also
// by its real path, so a symlinked home is covered both ways.
function guardedDirs(dir, home = os.homedir()) {
  const old = OLD_DIR_NAMES.map(name => path.join(home, name)).filter(isDirectory);
  return [...new Set([dir, ...old].flatMap(d => [d, realOrSelf(d)]))];
}

function copyable(src, oldDir) {
  const rel = path.relative(oldDir, src);
  if (rel && !rel.includes(path.sep) && OLD_HOME_SKIP.includes(rel)) return false;
  const st = fs.lstatSync(src);
  return st.isFile() || st.isDirectory() || st.isSymbolicLink();
}

// The first setup after the rename to WoWGPT: copy ~/.claude-wow to
// ~/.wowgpt, all but OLD_HOME_SKIP and sockets. Copies, not moves: a bridge
// or checkout from before the rename still reads the old home. Nothing is
// done when a home is named in the environment or the new home has a config.
// Returns { from, copied } with the top-level names copied, or null.
function migrateOldHome(env = process.env, home = os.homedir()) {
  if (namedHome(env)) return null;
  const dflt = defaultDir(home);
  const old = oldHomeDir(home);
  if (!old || hasConfig(dflt)) return null;
  fs.mkdirSync(dflt, { recursive: true, mode: PRIVATE_DIR_MODE });
  const copied = [];
  for (const name of fs.readdirSync(old).sort()) {
    const src = path.join(old, name);
    if (!copyable(src, old)) continue;
    fs.cpSync(src, path.join(dflt, name), { recursive: true, verbatimSymlinks: true, filter: from => copyable(from, old) });
    copied.push(name);
  }
  if (process.platform !== 'win32') {
    fs.chmodSync(dflt, PRIVATE_DIR_MODE);
    for (const f of FILES) if (copied.includes(f)) fs.chmodSync(path.join(dflt, f), PRIVATE_FILE_MODE);
  }
  return { from: old, copied };
}

module.exports = {
  LEGACY_DIR,
  FILES,
  DIR_NAME,
  OLD_DIR_NAMES,
  OLD_HOME_SKIP,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  defaultDir,
  hasConfig,
  oldHomeDir,
  guardedDirs,
  resolve,
  migrateLegacy,
  migrateOldHome,
};
