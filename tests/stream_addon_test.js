'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const P = require('../bridge/protocol');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const CELLS_PER_ROW = 200;

const LEGACY_QUEST_STUB = `
STUB.questLog = {
  { title = "Elwynn Forest", header = true },
  { title = "The Fargodeep Mine", id = 62, complete = false, objectives = { "Explore the Fargodeep Mine" } },
  { title = "Wolves Across the Border", id = 33, complete = false, objectives = { "Diseased Timber Wolf slain: 3/8", "Wolf meat: 1/8" } },
}
STUB.watched = {}
function GetNumQuestLogEntries() return #STUB.questLog end
function GetQuestLogTitle(i)
  local q = STUB.questLog[i]
  if not q then return nil end
  return q.title, 5, nil, q.header and true or false, false, q.complete and 1 or nil, 0, q.id or 0
end
function GetNumQuestLeaderBoards(i) local q = STUB.questLog[i]; return q and q.objectives and #q.objectives or 0 end
function GetQuestLogLeaderBoard(j, i) local q = STUB.questLog[i]; return q and q.objectives and q.objectives[j], "monster", false end
function GetNumQuestWatches() return #STUB.watched end
function GetQuestIndexForWatch(n) return STUB.watched[n] end
`;

function newVM(extraStub = LEGACY_QUEST_STUB) {
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
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = expr => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(extraStub);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Roast.lua', 'Stream.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  return { run, evaluate, num };
}

function decodeStrip(vm) {
  if (vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown') !== 'true') return null;
  vm.run(`
    local parts = {}
    for _, t in ipairs(ClaudeWoWStrip.textures) do
      if t.shown and t.color then
        local c, r = math.floor(t.x / 4), math.floor(-t.y / 4)
        local v = (t.color[1] >= 0.5 and 4 or 0) + (t.color[2] >= 0.5 and 2 or 0) + (t.color[3] >= 0.5 and 1 or 0)
        parts[#parts + 1] = (r * ${CELLS_PER_ROW} + c) .. ":" .. v
      end
    end
    RESULT = table.concat(parts, ",")`);
  const cells = [];
  for (const p of vm.evaluate('RESULT').split(',')) {
    const [i, v] = p.split(':').map(Number);
    cells[i] = v;
  }
  const bytes = [];
  let acc = 0,
    nbits = 0;
  for (let i = 0; i < cells.length; i++) {
    acc = (acc << 3) | (cells[i] || 0);
    nbits += 3;
    while (nbits >= 8) {
      bytes.push((acc >> (nbits - 8)) & 0xff);
      nbits -= 8;
      acc &= (1 << nbits) - 1;
    }
  }
  assert.equal(bytes[0], 0xc7);
  assert.equal(bytes[1], 0x1a);
  const len = bytes[4] * 256 + bytes[5];
  return { id: bytes[2] * 256 + bytes[3], text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8') };
}

function streamJobs(vm) {
  const frame = decodeStrip(vm);
  return frame ? P.jobsFromStrip(frame.id, frame.text).filter(j => j.kind === 'stream') : [];
}

function nextSlot(vm, luaBody) {
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = ${luaBody} end`);
}

function ready({ follow = false } = {}) {
  const vm = newVM();
  vm.run(`ClaudeWoWDB = { stream = { follow = ${follow} } }`);
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", plugin = "ask", plugins = { "ask", "claude-code", "roast", "stream" }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  vm.run('function StreamChatForTest() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.stream.chat then return c end end end');
  vm.run('STUB.prints = {}');
  return vm;
}

function slash(vm, msg) {
  vm.run(`SlashCmdList.CLAUDEWOWSTREAM(${JSON.stringify(msg)})`);
}

function pendingPayload(vm) {
  const id = vm.evaluate('StreamChatForTest() and StreamChatForTest().pendingId');
  if (!id) return null;
  const job = streamJobs(vm).find(j => String(j.id) === id);
  assert.ok(job, `the stream record #${id} is on the strip`);
  return job;
}

function answer(vm, text = '') {
  const id = vm.num('StreamChatForTest().pendingId');
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = { { chat = StreamChatForTest().id, id = ${id}, status = "done", text = ${JSON.stringify(text)}, agent = "", plugin = "stream" } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.notEqual(vm.evaluate('StreamChatForTest().pendingId'), String(id), 'the stream reply arrived');
}

function settleTracks(vm) {
  for (let job = pendingPayload(vm); job && JSON.parse(job.text).action === 'track'; job = pendingPayload(vm)) answer(vm, '');
}

function printed(vm) {
  return vm.evaluate('table.concat(STUB.prints, "\\n")') || '';
}

test('stream: /stream and /stream help print usage and send nothing', () => {
  const vm = ready();
  slash(vm, '');
  assert.ok(printed(vm).includes('/stream quest auto'), printed(vm));
  slash(vm, 'help');
  assert.equal(vm.evaluate('StreamChatForTest()'), null, 'no stream chat is made for help');
  assert.equal(streamJobs(vm).length, 0);
});

test('stream: an unknown scene is a local error and nothing is sent', () => {
  const vm = ready();
  slash(vm, 'lobby');
  assert.ok(printed(vm).includes('Unknown scene or command "lobby"'), printed(vm));
  assert.equal(vm.evaluate('StreamChatForTest()'), null);
  slash(vm, 'pane middle');
  assert.ok(printed(vm).includes('Pane must be left, right or full.'));
  assert.equal(vm.evaluate('StreamChatForTest()'), null);
});

test('stream: pane, quest text and follow commands build the right payloads, and quest text turns follow off', () => {
  const vm = ready({ follow: true });
  vm.run('STUB.watched = {}');
  slash(vm, 'pane Right');
  assert.deepEqual(JSON.parse(pendingPayload(vm).text), { action: 'pane', pane: 'right' });
  answer(vm, 'Pane: right');
  settleTracks(vm);

  slash(vm, 'quest Kill "Hogger" \\ bring back his claw');
  assert.deepEqual(JSON.parse(pendingPayload(vm).text), { action: 'quest', text: 'Kill "Hogger" \\ bring back his claw' });
  assert.equal(vm.evaluate('ClaudeWoWDB.stream.follow'), 'false', 'a manual quest turns follow off');
  answer(vm, 'Quest set');

  slash(vm, 'follow on');
  assert.deepEqual(JSON.parse(pendingPayload(vm).text), { action: 'follow', on: true });
  assert.equal(vm.evaluate('ClaudeWoWDB.stream.follow'), 'true');
  answer(vm, 'Follow: on');
  const track = JSON.parse(pendingPayload(vm).text);
  assert.equal(track.action, 'track', 'follow on sends the current state right after');
  answer(vm, '');

  slash(vm, 'follow off');
  assert.deepEqual(JSON.parse(pendingPayload(vm).text), { action: 'follow', on: false });
  assert.equal(vm.evaluate('ClaudeWoWDB.stream.follow'), 'false');
  answer(vm, '');

  slash(vm, 'quest auto');
  assert.deepEqual(JSON.parse(pendingPayload(vm).text), { action: 'follow', on: true });
  answer(vm, '');
  assert.equal(JSON.parse(pendingPayload(vm).text).action, 'track', 'quest auto sends a track update at once');
});

test('stream: the track payload has the first watched quest, capped objectives and title, and the open chat title', () => {
  const vm = ready();
  vm.run(
    `STUB.watched = { 3 }; STUB.questLog[3].title = string.rep("W", 100); STUB.questLog[3].objectives = { string.rep("o", 90), "b", "c", "d", "e", "f", "g" }; STUB.questLog[3].complete = true`,
  );
  vm.run('ClaudeWoWDB.chats[1].name = "Raid prep"');
  const track = JSON.parse(vm.evaluate('ClaudeWoWStream.TrackPayload()'));
  assert.equal(track.action, 'track');
  assert.equal(track.quest.id, 33);
  assert.equal(track.quest.title, 'W'.repeat(80));
  assert.equal(track.quest.objectives.length, 5);
  assert.equal(track.quest.objectives[0], 'o'.repeat(60));
  assert.equal(track.quest.complete, true);
  assert.deepEqual(track.chat, { title: 'Raid prep' });

  vm.run('STUB.watched = {}');
  assert.equal(JSON.parse(vm.evaluate('ClaudeWoWStream.TrackPayload()')).quest, null, 'no watched quest: null');
  slash(vm, 'raid');
  vm.run('ClaudeWoW.SwitchChat(StreamChatForTest().id)');
  assert.equal(JSON.parse(vm.evaluate('ClaudeWoWStream.TrackPayload()')).chat, null, 'the stream chat itself never counts as the open chat');
});

test('stream: the super-tracked quest wins over the watch list when the client has C_SuperTrack and C_QuestLog', () => {
  const vm = newVM(`
    STUB.super = 0
    C_SuperTrack = { GetSuperTrackedQuestID = function() return STUB.super end }
    C_QuestLog = {
      GetNumQuestLogEntries = function() return 2 end,
      GetInfo = function(i) return ({ { title = "Beware of Pips", questID = 7 }, { title = "A Swift Message", questID = 9 } })[i] end,
      IsComplete = function(id) return id == 9 end,
      GetLogIndexForQuestID = function(id) return id == 7 and 1 or id == 9 and 2 or nil end,
      GetQuestObjectives = function(id) return { { text = "Pips found: 0/1" } } end,
      GetNumQuestWatches = function() return 1 end,
      GetQuestIDForQuestWatchIndex = function(n) return 7 end,
    }
  `);
  assert.equal(JSON.parse(vm.evaluate('ClaudeWoWStream.TrackPayload()')).quest.title, 'Beware of Pips', 'the watch list without a super-tracked quest');
  vm.run('STUB.super = 9');
  const q = JSON.parse(vm.evaluate('ClaudeWoWStream.TrackPayload()')).quest;
  assert.deepEqual(q, { id: 9, title: 'A Swift Message', objectives: ['Pips found: 0/1'], complete: true });
});

test('stream: follow sends a changed state once, drops duplicates, and throttles to one track every 8 s with a trailing send', () => {
  const vm = ready({ follow: true });
  vm.run('STUB.watched = { 2 }');
  vm.run('STUB.FireEvent("QUEST_LOG_UPDATE")');
  const first = JSON.parse(pendingPayload(vm).text);
  assert.equal(first.quest.title, 'The Fargodeep Mine');
  answer(vm, '');

  vm.run('STUB.FireEvent("QUEST_LOG_UPDATE"); STUB.FireEvent("QUEST_WATCH_UPDATE")');
  assert.equal(vm.evaluate('StreamChatForTest().pendingId'), null, 'the same state is not sent again');
  assert.equal(vm.evaluate('ClaudeWoWStream.PendingTrack()'), null);

  vm.run('STUB.watched = { 3 }; STUB.FireEvent("QUEST_WATCH_LIST_CHANGED")');
  assert.equal(vm.evaluate('StreamChatForTest().pendingId'), null, 'inside the 8 s window nothing goes out');
  vm.run('STUB.questLog[3].objectives[1] = "Diseased Timber Wolf slain: 4/8"; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.ok(vm.evaluate('ClaudeWoWStream.PendingTrack()').includes('4/8'), 'the latest state waits');

  vm.run('STUB.now = STUB.now + 8; STUB.RunTimers()');
  const trailing = JSON.parse(pendingPayload(vm).text);
  assert.equal(trailing.quest.title, 'Wolves Across the Border');
  assert.equal(trailing.quest.objectives[0], 'Diseased Timber Wolf slain: 4/8', 'the trailing send carries the latest state');
  vm.run('STUB.FireEvent("QUEST_LOG_UPDATE")');
  answer(vm, '');
  assert.equal(vm.evaluate('StreamChatForTest().pendingId'), null, 'the trailing send was not repeated');
});

test('stream: follow off sends no track updates, and a disconnected bridge is a local note', () => {
  const vm = ready({ follow: false });
  vm.run('STUB.watched = { 2 }; STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.equal(vm.evaluate('StreamChatForTest()'), null);
  vm.run('ClaudeWoW.IsConnected = function() return false end');
  slash(vm, 'code');
  assert.ok(printed(vm).includes('Not sent: the bridge is not connected.'));
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].draft'), null, 'nothing lands in an input box');
});
