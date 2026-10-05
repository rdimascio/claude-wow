'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');

const VOICE_STUB = `
VOICE = { played = {}, stopped = {}, race = "NightElf", sex = 3 }
STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\ctl\\\\valid.wav"] = true
STUB.armed = true
local playSignalFile = PlaySoundFile
PlaySoundFile = function(file, channel)
  if type(file) == "number" then
    table.insert(VOICE.played, { id = file, channel = channel })
    return true, 100 + #VOICE.played
  end
  return playSignalFile(file, channel)
end
StopSound = function(handle) table.insert(VOICE.stopped, handle) end
UnitRace = function() return VOICE.race, VOICE.race end
UnitSex = function() return VOICE.sex end
`;

function newVM(beforeLoad) {
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
  run(VOICE_STUB);
  if (beforeLoad) run(beforeLoad);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Map.lua', 'Voice.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  return { run, evaluate, num };
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
}

function nextSlot(vm, luaBody) {
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = ${luaBody} end`);
}

function connect(vm) {
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
}

function ready() {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('VOICE.played = {}; VOICE.stopped = {}');
  return vm;
}

function played(vm) {
  vm.run('local ids = {}; for i, p in ipairs(VOICE.played) do ids[i] = p.id end; RESULT = table.concat(ids, ",")');
  const s = vm.evaluate('RESULT');
  return s ? s.split(',').map(Number) : [];
}

function lineIds(vm, table, ...keys) {
  vm.run(`RESULT = table.concat(${table}${keys.map(k => `[${JSON.stringify(k)}]`).join('')}, ",")`);
  return vm.evaluate('RESULT').split(',').map(Number);
}

function sendAndReply(vm, fields) {
  vm.run('ClaudeWoW.Send("fix the bug")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, ${fields} } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
}

function slash(vm, text) {
  vm.run('STUB.prints = {}');
  vm.run(`SlashCmdList.CLAUDE(${JSON.stringify('config ' + text)})`);
  return vm.evaluate('table.concat(STUB.prints, "\\n")') || '';
}

test('the bridge picking a message up plays the started line once the sent line has had its time', () => {
  const vm = ready();
  vm.run('SlashCmdList.CLAUDE("config voice peasant")');
  vm.run('ClaudeWoW.Send("fix the bug")');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  const slot = String(id).padStart(3, '0');
  vm.run(`STUB.now = STUB.now + 3; STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\ack\\\\${slot}.wav"] = false; STUB.Tick()`);
  const ids = played(vm);
  assert.equal(ids.length, 2);
  assert.ok(lineIds(vm, 'ClaudeWoWVoice.UNIT_PACK_LINES', 'peasant', 'yes').includes(ids[0]));
  assert.deepEqual([ids[1]], lineIds(vm, 'ClaudeWoWVoice.UNIT_PACK_LINES', 'peasant', 'ready'));
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "working", text = "thinking..." } } }`);
  vm.run('STUB.now = STUB.now + 30; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].progress'), 'thinking...', 'the progress slot was read');
  assert.equal(played(vm).length, 2, 'progress on the same message does not repeat the line');
});

test('overlapping events are throttled: a quick ack is dropped, a reply cuts in, a second reply waits its turn', () => {
  const vm = ready();
  vm.run('SlashCmdList.CLAUDE("config voice peon")');
  vm.run('ClaudeWoWVoice.Event("sent")');
  vm.run('STUB.now = STUB.now + 0.5; ClaudeWoWVoice.Event("started")');
  assert.equal(played(vm).length, 1, 'started right after sent is dropped');
  vm.run('STUB.now = STUB.now + 0.5; ClaudeWoWVoice.Event("done")');
  assert.equal(played(vm).length, 2, 'done outranks sent and plays');
  assert.equal(vm.num('VOICE.stopped[1]'), 101, 'the sent line is cut off');
  assert.deepEqual([played(vm)[1]], lineIds(vm, 'ClaudeWoWVoice.UNIT_PACK_LINES', 'peon', 'workcomplete'));
  vm.run('STUB.now = STUB.now + 0.5; ClaudeWoWVoice.Event("done")');
  assert.equal(played(vm).length, 2, 'a second reply inside the gap is dropped');
  vm.run('STUB.now = STUB.now + 3; ClaudeWoWVoice.Event("done")');
  assert.equal(played(vm).length, 3, 'after the gap it plays again');
});

test('/claude config voice picks a pack, sets and resets lines per event, and previews them', () => {
  const vm = ready();
  let out = slash(vm, 'voice');
  assert.match(out, /pack: race/);
  assert.match(out, /NightElf female/);
  assert.match(out, /done -> race:cheer/);

  slash(vm, 'voice peon');
  assert.equal(vm.evaluate('ClaudeWoWDB.voice.pack'), 'peon');

  out = slash(vm, 'voice set done peasant:morework');
  assert.match(out, /done -> peasant:morework/);
  assert.equal(vm.evaluate('ClaudeWoWDB.voice.lines.done'), 'peasant:morework');
  assert.deepEqual(lineIds(vm, 'ClaudeWoWVoice.LineFor("done")'), lineIds(vm, 'ClaudeWoWVoice.UNIT_PACK_LINES', 'peasant', 'morework'));

  slash(vm, 'voice set done cheer');
  assert.equal(vm.evaluate('ClaudeWoWDB.voice.lines.done'), 'race:cheer', 'a line the pack lacks comes from the character');

  out = slash(vm, 'voice set done jobsdone');
  assert.match(out, /no line jobsdone/);
  assert.equal(vm.evaluate('ClaudeWoWDB.voice.lines.done'), 'race:cheer', 'an unknown line changes nothing');

  slash(vm, 'voice set error off');
  assert.equal(vm.evaluate('ClaudeWoWVoice.LineFor("error")'), null);
  vm.run('STUB.now = STUB.now + 10; VOICE.played = {}; ClaudeWoWVoice.Event("error")');
  assert.equal(played(vm).length, 0, 'a silenced event plays nothing');

  slash(vm, 'voice set error default');
  assert.equal(vm.evaluate('ClaudeWoWDB.voice.lines.error'), null);

  vm.run('VOICE.played = {}');
  out = slash(vm, 'voice test permission');
  assert.match(out, /peon:what \(FileDataID \d+\)/);
  assert.equal(played(vm).length, 1);
  out = slash(vm, 'voice test peasant:ready');
  assert.match(out, /peasant:ready \(FileDataID 558118\)/);

  out = slash(vm, 'voice lines peon');
  assert.match(out, /workcomplete/);

  slash(vm, 'voice reset');
  assert.equal(vm.evaluate('ClaudeWoWDB.voice.pack'), 'race');
  assert.equal(vm.evaluate('next(ClaudeWoWDB.voice.lines)'), null);
});

test('voice off silences every event, voice on brings the race pack back', () => {
  const vm = ready();
  slash(vm, 'voice off');
  sendAndReply(vm, 'status = "done", text = "fixed"');
  assert.equal(played(vm).length, 0);
  assert.match(slash(vm, 'voice test done'), /voice is off/);
  slash(vm, 'voice on');
  assert.equal(vm.evaluate('ClaudeWoWDB.voice.pack'), 'race');
});
