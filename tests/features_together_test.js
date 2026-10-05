'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const TOC_FILES = fs
  .readFileSync(path.join(ADDON, 'ClaudeWoW.toc'), 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l.endsWith('.lua'));

const SOUND_STUB = `
VOICE = { played = {} }
local playSignalFile = PlaySoundFile
PlaySoundFile = function(file, channel)
  if type(file) == "number" then
    table.insert(VOICE.played, file)
    return true, 100 + #VOICE.played
  end
  return playSignalFile(file, channel)
end
StopSound = function() end
UnitRace = function() return "Human", "Human" end
UnitSex = function() return 2 end
STUB.played = {}
SOUNDKIT = { UI_EPICLOOT_TOAST = 31578, UI_NEED_ROLL_POSITIVE = 229319, LOOT_WINDOW_COIN_SOUND = 120, UI_NEED_ROLL_NEGATIVE = 229321 }
local SOUND_NAMES = {}
for name, id in pairs(SOUNDKIT) do SOUND_NAMES[id] = name end
function PlaySound(id) if SOUND_NAMES[id] then table.insert(STUB.played, SOUND_NAMES[id]) end end
`;

function newVM(savedVariables = '') {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) {
      lua.lua_pushstring(L, to_luastring(arg));
      nargs = 1;
    }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = expr => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = expr => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(SOUND_STUB);
  if (savedVariables) run(savedVariables);
  for (const f of TOC_FILES) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.RunTimers()');
  run('STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} } end');
  run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(evaluate('ClaudeWoW.IsConnected()'), 'true');
  run('VOICE.played = {}; STUB.played = {}');
  return { run, evaluate, num };
}

test('loading every file in .toc order and logging in registers no event the client blocks, with default settings or with roast on', () => {
  const defaults = newVM();
  assert.equal(defaults.num('#STUB.actionBlocked'), 0, defaults.evaluate('table.concat(STUB.actionBlocked, "; ")'));
  defaults.run('SlashCmdList.CLAUDE("config roast on")');
  defaults.run('STUB.FireEvent("UNIT_COMBAT", "player", "WOUND", "", 40, 1); STUB.FireEvent("PLAYER_DEAD")');
  defaults.run('SlashCmdList.CLAUDE("config roast off")');
  assert.equal(defaults.num('#STUB.actionBlocked'), 0, defaults.evaluate('table.concat(STUB.actionBlocked, "; ")'));

  const roastOn = newVM('ClaudeWoWDB = { roast = { on = true } }');
  assert.equal(roastOn.evaluate('ClaudeWoWRoast.Listening()'), 'true');
  roastOn.run('STUB.FireEvent("PLAYER_ENTERING_WORLD"); STUB.FireEvent("UNIT_COMBAT", "player", "WOUND", "CRITICAL", 90, 4); STUB.FireEvent("PLAYER_DEAD")');
  assert.equal(roastOn.num('#STUB.actionBlocked'), 0, roastOn.evaluate('table.concat(STUB.actionBlocked, "; ")'));
});
