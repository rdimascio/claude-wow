'use strict';
// The general plugin, and the default: in-game AI chat for someone who does not
// code. Game questions, quest research, routes on the map, macros. There is no
// folder to work in, no repository and no project: the chat's agent runs in a
// scratch folder of its own (stable, so its session can be resumed; outside
// any repository, so nothing of the player's is read or written), with the
// same game context, map and macro instructions every plugin gets from the
// core, plus a few lines saying what it is for.
//
//   plugins.ask.cwd in config.json    another scratch folder (default below)

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_NAME = 'wowgpt';
const OLD_DATA_NAMES = Object.freeze(['claude-wow']); // the folder's name before the rename to WoWGPT
const SCRATCH = 'ask';

// Per-user application data, the usual place on each platform.
function dataDir(name = DATA_NAME, env = process.env, home = os.homedir(), platform = process.platform) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), name);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', name);
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), name);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// setup.js: the data folder by its old name is copied to the new one, once.
// The old one is kept. Returns the folder copied from, or ''.
function migrateOldData(env = process.env, home = os.homedir(), platform = process.platform) {
  const dest = dataDir(DATA_NAME, env, home, platform);
  if (fs.existsSync(dest)) return '';
  const from = OLD_DATA_NAMES.map(name => dataDir(name, env, home, platform)).find(isDir);
  if (!from) return '';
  fs.cpSync(from, dest, { recursive: true, verbatimSymlinks: true });
  return from;
}

// Where this plugin's runs happen: the configured folder, else <data>/ask.
function scratchFolder(options) {
  const own = options && typeof options.cwd === 'string' ? options.cwd.trim() : '';
  return own ? path.resolve(own) : path.join(dataDir(), SCRATCH);
}

// An agent resumes a session only from the folder it started in, so a chat
// whose session started in the old default scratch folder starts a new one in
// the new folder. Returns the reason the bridge logs, or ''.
function oldFolderSession(sessionFolder, old = OLD_DATA_NAMES.map(name => path.join(dataDir(name), SCRATCH))) {
  if (!sessionFolder || !old.includes(path.resolve(sessionFolder))) return '';
  return `the session lives in the old scratch folder ${sessionFolder}`;
}

function usesClaudePlugin(options) {
  return !!options && options.claudePlugin === true;
}

function configNote(options) {
  const v = options && options.claudePlugin;
  if (v === undefined || typeof v === 'boolean') return '';
  return `plugins.ask.claudePlugin must be true or false; ${JSON.stringify(v)} is ignored, so ask runs do not load the wowgpt Claude Code plugin.`;
}

const TOOLS = [
  "This chat is the player's in-game assistant, not a coding session. Answer questions about the game, research quests, items, NPCs, drops, dungeons and reputations, plan routes and mark them on the map when asked, and write macros when asked. Use web search when you need current game data and say when you are unsure.",
  'There is no project or repository behind this chat. The folder you run in is scratch space: do not create, read or edit files unless the player explicitly asks you to keep something, and do not talk about files, code or the folder unless they do.',
  "Grep, Glob, LS and NotebookRead are off in this chat, and the bridge's own folder cannot be read; do not try them. While the wowgoals tools are in your tool list, Bash is off too: mark the map and hand over widgets with the fenced wowmap and wowui blocks, not by writing files.",
  'When the wowgoals tools are in your tool list, you can set and list goals (goal_set, goal_list), issue or clear the current order (order_issue), run a campaign (campaign_start, campaign_end, beat_add, beat_trigger, narrate) and draw a route (route_draw), for this message only. Use them when the player asks for a goal, an order or a campaign. Name every zone, NPC, item or quest in their text only with a reference token such as {item:ID}, {skill:ID}, {faction:ID} or {map:ID,x,y}, with the ID from the wowdata tools; the bridge refuses any other game name and says which word. Twitch votes are not available here. Without the wowgoals tools, say that goals and orders need the Claude agent, the live socket on, and a game context that names the character.',
].join('\n');

const plugin = {
  id: 'ask',
  label: 'Ask',
  tools: TOOLS,
  surfaces: ['map', 'macro', 'ui'],
  voice: 'player',
  scratchFolder,
  oldFolderSession,
  dataDir,
  migrateOldData,
  OLD_DATA_NAMES,
  usesClaudePlugin,
  configNote,
  banner: options => `runs the chat's agent in ${scratchFolder(options)} (plugins.ask.cwd), no project`,
  handle(job, core) {
    const options = core.options('ask');
    const cwd = scratchFolder(options);
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch (e) {
      core.log(`${core.tag(job)} ask: cannot create ${cwd} (${e.message})`);
      core.fail(
        job,
        `The ask plugin needs a scratch folder and could not create ${cwd}: ${e.message}\nSet plugins.ask.cwd in config.json to a folder that works.`,
      );
      return;
    }
    // The chat's own folder, if it ever had one, is left alone: it is the coding
    // plugin's, and comes back with the chat if it is switched there.
    core.runAgent(job, {
      cwd,
      gameData: true,
      runTools: true,
      claudePlugin: usesClaudePlugin(options),
      freshSession: () => oldFolderSession(core.sessionFolder(job)),
    });
  },
};

module.exports = plugin;
