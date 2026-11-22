'use strict';
// The environment variables were named CLAUDE_WOW_* before the rename to
// WoWGPT. adopt() gives each old name's value to its WOWGPT_* name when that
// one is not set, so a shell profile, a service definition or a script from
// before the rename keeps working. The entry points (supervisor.js, setup.js,
// bridge.js, channel.js) call it before anything reads the environment; child
// processes then inherit both names.

const PREFIX = 'WOWGPT_';
const OLD_PREFIXES = Object.freeze(['CLAUDE_WOW_']);

function newName(key) {
  const old = OLD_PREFIXES.find(p => key.startsWith(p));
  return old ? PREFIX + key.slice(old.length) : '';
}

// The value of WOWGPT_<name>, else of an old name for it.
function read(env, name) {
  if (env[PREFIX + name] !== undefined) return env[PREFIX + name];
  for (const p of OLD_PREFIXES) if (env[p + name] !== undefined) return env[p + name];
  return undefined;
}

// Returns the WOWGPT_* names it set.
function adopt(env = process.env) {
  const adopted = [];
  for (const key of Object.keys(env)) {
    const name = newName(key);
    if (!name || env[name] !== undefined) continue;
    env[name] = env[key];
    adopted.push(name);
  }
  return adopted;
}

module.exports = { PREFIX, OLD_PREFIXES, newName, read, adopt };
