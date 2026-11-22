'use strict';
// The files the bridge and setup hand to other programs by path: the capture
// scripts (spawned with python3 or PowerShell), the addon (copied into the
// game folder), config.example.json (setup's template) and the primer (read
// into the system prompt). From a checkout they are read where they are. The
// compiled binary carries them inside itself (build/entry.js embeds them,
// runtime.js says when that is the case), where python and the game cannot
// see them, so on first use it writes them out under <home>/assets/ and hands
// out those paths. A file there that differs from the embedded copy (an older
// binary wrote it, or someone edited it) is written again, so a binary always
// runs its own scripts and installs its own addon.
//
//   AS.file('bridge/capture_mac.py') -> an absolute path that exists
//   AS.dir('addon/WoWGPT')        -> the folder holding the addon's files
//
// Pure apart from the writes; tests/assets_test.js hands it a table and a
// folder of its own.

const fs = require('fs');
const path = require('path');
const R = require('./runtime');
const H = require('./home');

// Every file the binary needs that is not JavaScript. build/entry.js embeds
// exactly this list; tests/assets_test.js keeps the two, and the addon
// folder, in step.
const FILES = [
  'addon/WoWGPT/Core/Namespace.lua',
  'addon/WoWGPT/Core/Log.lua',
  'addon/WoWGPT/Core/State.lua',
  'addon/WoWGPT/Transport/Strip.lua',
  'addon/WoWGPT/Transport/Screenshot.lua',
  'addon/WoWGPT/Transport/ChatLog.lua',
  'addon/WoWGPT/Transport/Signals.lua',
  'addon/WoWGPT/Transport/Slots.lua',
  'addon/WoWGPT/Transport/Tick.lua',
  'addon/WoWGPT/Chat/Context.lua',
  'addon/WoWGPT/Chat/Send.lua',
  'addon/WoWGPT/Chat/Replies.lua',
  'addon/WoWGPT/Chat/Grants.lua',
  'addon/WoWGPT/Whisper/Tabs.lua',
  'addon/WoWGPT/Whisper/Reply.lua',
  'addon/WoWGPT/Whisper/Intercept.lua',
  'addon/WoWGPT/Chat/Options.lua',
  'addon/WoWGPT/Chat/Sessions.lua',
  'addon/WoWGPT/UI/Markdown.lua',
  'addon/WoWGPT/UI/Menu.lua',
  'addon/WoWGPT/UI/Minimap.lua',
  'addon/WoWGPT/UI/Popups.lua',
  'addon/WoWGPT/UI/Copy.lua',
  'addon/WoWGPT/UI/Transcript.lua',
  'addon/WoWGPT/UI/ChatList.lua',
  'addon/WoWGPT/UI/Frame.lua',
  'addon/WoWGPT/Commands/Diag.lua',
  'addon/WoWGPT/Commands/Registry.lua',
  'addon/WoWGPT/Commands/Claude.lua',
  'addon/WoWGPT/Commands/Config.lua',
  'addon/WoWGPT/WoWGPT.lua',
  'addon/WoWGPT/WoWGPT.toc',
  'addon/WoWGPT/Codec.lua',
  'addon/WoWGPT/Inbox.lua',
  'addon/WoWGPT/Map.lua',
  'addon/WoWGPT/Roast.lua',
  'addon/WoWGPT/Stream.lua',
  'addon/WoWGPT/Voice.lua',
  'addon/WoWGPT/LootRoll.lua',
  'addon/WoWGPT/Achievements.lua',
  'addon/WoWGPT/Orders.lua',
  'addon/WoWGPT/DM.lua',
  'addon/WoWGPT/Widgets.lua',
  'addon/WoWGPT/UI/Window.lua',
  'addon/WoWGPT/Telemetry.lua',
  'addon/WoWGPT/Observed.lua',
  'addon/WoWGPT/Dev.lua',
  'addon/WoWGPT/Help.lua',
  'addon/WoWGPT/Boot.lua',
  'addon/WoWGPT/Bindings.xml',
  'addon/WoWGPT/Portrait.tga',
  'addon/WoWGPT/MinimapIcon.tga',
  'bridge/capture.ps1',
  'bridge/capture_mac.py',
  'bridge/capture_x11.py',
  'bridge/config.example.json',
  'docs/WOW-ADDON-PRIMER.md',
  'assets/plugins/wowgpt/.claude-plugin/plugin.json',
  'assets/plugins/wowgpt/agents/wow-code.md',
  'assets/plugins/wowgpt/agents/wow-planner.md',
];
const DIR_NAME = 'assets';

let embedded = null; // rel -> where the embedded copy can be read (set by build/entry.js)
let checked = ''; // the folder the embedded set was last written to, this process

function embed(table) {
  for (const rel of FILES) if (!table || !table[rel]) throw new Error(`${rel} is not embedded`);
  embedded = table;
  checked = '';
}

// Write every file in `table` that is missing from `dir` or differs; return
// the names written.
function extract(dir, table = embedded) {
  const out = [];
  for (const rel of FILES) {
    const want = fs.readFileSync(table[rel]);
    const dest = path.join(dir, rel);
    let have = null;
    try {
      have = fs.readFileSync(dest);
    } catch {}
    if (have && have.equals(want)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, want);
    out.push(rel);
  }
  return out;
}

// The folder the repo-relative names resolve against: the checkout, or the
// extracted set in the home folder (checked once per process).
function root(home) {
  if (!embedded) return R.ROOT;
  const dir = path.join(home || H.resolve().dir, DIR_NAME);
  if (checked !== dir) {
    extract(dir);
    checked = dir;
  }
  return dir;
}

function file(rel, home) {
  return path.join(root(home), rel);
}
const dir = file;
const isEmbedded = () => !!embedded;
function unembed() {
  embedded = null;
  checked = '';
}

module.exports = { FILES, DIR_NAME, embed, unembed, extract, root, file, dir, isEmbedded };
