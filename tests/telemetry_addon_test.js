'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');
const TL = require('../bridge/telemetry');
const G = require('../bridge/goals');
const CL = require('../bridge/chatlog');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const CELLS_PER_ROW = 200;
const MAX_PAYLOAD = 3200;

const GAME_STUB = `
C_SkillInfo = {
  GetNumSkillLines = function() return 4 end,
  GetSkillLineInfo = function(i)
    return ({
      { name = "Professions", isHeader = true, parentSkillLineID = 0 },
      { name = "Skinning", isHeader = false, rank = STUB.skinning or 75, maxRank = 75, skillID = 393, parentSkillLineID = 0 },
      { name = "Secondary Skills", isHeader = true, parentSkillLineID = 0 },
      { name = "First Aid", isHeader = false, rank = 40, maxRank = 75, skillID = 129, parentSkillLineID = 0 },
    })[i]
  end,
}
STUB.bagFree = { [0] = 3, [1] = 2, [2] = 0, [3] = 0, [4] = 0 }
C_Container = { GetContainerNumFreeSlots = function(bag) return STUB.bagFree[bag] or 0, 0 end }
STUB.itemCounts = { [2589] = 12 }
C_Item.GetItemCount = function(id) return STUB.itemCounts[id] or 0 end
STUB.equipped = { [1] = 16707, [16] = 2140 }
function GetInventoryItemID(unit, slot) return STUB.equipped[slot] end
STUB.factions = { [530] = { factionID = 530, reaction = 5, currentStanding = 3000 } }
GetCurrentKeyBoardFocus = function() return STUB.focus end
C_Reputation = {
  GetFactionDataByID = function(id) return STUB.factions[id] end,
  GetWatchedFactionData = function() return nil end,
}
`;

function newVM({ extra = GAME_STUB, saved = '' } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); nargs = 1; }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = (expr) => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(extra);
  if (saved) run(saved);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Telemetry.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('ARMED = 0; local arm = ClaudeWoW.ArmAutoRefresh; ClaudeWoW.ArmAutoRefresh = function(...) ARMED = ARMED + 1; return arm(...) end');
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
  for (const p of vm.evaluate('RESULT').split(',')) { const [i, v] = p.split(':').map(Number); cells[i] = v; }
  const bytes = [];
  let acc = 0, nbits = 0;
  for (let i = 0; i < cells.length; i++) {
    acc = (acc << 3) | (cells[i] || 0); nbits += 3;
    while (nbits >= 8) { bytes.push((acc >> (nbits - 8)) & 0xff); nbits -= 8; acc &= (1 << nbits) - 1; }
  }
  assert.equal(bytes[0], 0xc7);
  assert.equal(bytes[1], 0x1a);
  const len = bytes[4] * 256 + bytes[5];
  return { id: bytes[2] * 256 + bytes[3], text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8'), len };
}

function nextSlot(vm, luaBody) {
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = ${luaBody} end`);
}

const GS = '{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = {} }';
const CHARACTER = 'Testchar-TestRealm';

function slotBody(gs = GS, extra = '') {
  return `{ now = time(), cwd = "", transport = "screenshot", strip = { on = 255, off = 0 }, ${gs ? `gs = ${gs},` : ''} replies = {} ${extra} }`;
}

function shoot(vm, outcome = 'SCREENSHOT_SUCCEEDED') {
  if (vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown') !== 'true') return null;
  for (let i = 0; i < 2; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end');
  const frame = decodeStrip(vm);
  vm.run(`STUB.FireEvent("${outcome}")`);
  return { frame, jobs: P.jobsFromStrip(frame.id, frame.text) };
}

function tick(vm, seconds) {
  vm.run(`STUB.now = STUB.now + ${seconds}; STUB.Tick()`);
}

function gsJobs(shot) {
  return shot ? shot.jobs.filter(j => j.kind === 'gs') : [];
}

function sectionsOf(job) {
  return TL.parseRecord(job.text);
}

function ready({ gs = GS, saved = '', extra } = {}) {
  const vm = newVM({ saved, extra });
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  nextSlot(vm, slotBody(gs));
  tick(vm, 6);
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  const hello = shoot(vm);
  assert.ok(hello && hello.jobs.some(j => j.hello), 'the hello went out on a screenshot');
  assert.deepEqual(gsJobs(hello), [], 'the capability arrived after that shot was drawn');
  tick(vm, 21);
  return vm;
}

const LOG_KEY = '0123456789abcdef0123456789abcdef';
const CHAT_LOG_API = `
SENT, LOGGING = {}, false
function SendSystemMessage(text) SENT[#SENT + 1] = text end
function LoggingChat(on) if on ~= nil then LOGGING = on end return LOGGING end
`;

function logFrames(vm, first = 1) {
  const lines = [];
  for (let i = first; i <= vm.num('#SENT'); i++) lines.push(vm.evaluate(`SENT[${i}]`));
  const frames = [];
  const assembler = CL.createAssembler(f => frames.push(f), { key: LOG_KEY });
  assembler.feed(lines.map(l => `9/30 19:00:00.000  ${l}\n`).join(''));
  return frames.map(f => ({ id: f.id, jobs: P.jobsFromStrip(f.id, f.text) }));
}

function readyChatLog() {
  const vm = newVM({ extra: GAME_STUB + CHAT_LOG_API });
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  nextSlot(vm, slotBody(GS, `, chatlog = { line = 200, filler = 4096, key = "${LOG_KEY}" }, acks = { { session = ClaudeWoWDB.session, id = ClaudeWoWDB.lastSeq } }`));
  tick(vm, 6);
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  return vm;
}

test('chat log transport: game state rides on a message frame, after the message', () => {
  const vm = readyChatLog();
  tick(vm, 6);
  vm.run('STUB.money = STUB.money + 100; STUB.FireEvent("PLAYER_MONEY")');
  tick(vm, 31);
  const before = vm.num('#SENT');
  vm.run('ClaudeWoW.Send("what should I do next")');
  const [frame] = logFrames(vm, before + 1);
  assert.equal(frame.jobs[0].text, 'what should I do next');
  assert.deepEqual(Object.keys(sectionsOf(gsJobs(frame)[0]).sections), ['money']);
  assert.equal(vm.num('STUB.screenshots'), 0);
});

test('chat log transport: a failed chat log write sends the message by screenshot with one game state record, not the lost one and a new one', () => {
  const vm = readyChatLog();
  tick(vm, 6);
  tick(vm, 31);
  vm.run('STUB.level = (STUB.level or 23) + 1; STUB.FireEvent("PLAYER_LEVEL_UP")');
  vm.run('SendSystemMessage = function() error("chat log write failed") end');
  vm.run('ClaudeWoW.Send("after a failed write")');
  const shot = shoot(vm);
  assert.ok(shot, 'the message went out by screenshot');
  assert.ok(shot.jobs.some(j => j.text === 'after a failed write'));
  assert.equal(gsJobs(shot).length, 1, 'one game state record on the strip');
  assert.ok(shot.frame.len <= MAX_PAYLOAD);
});

test('saved telemetry state is per character and bounded: the last 8 recipes, 20 characters, junk dropped at login', () => {
  const junk = Array.from({ length: 20 }, (_, i) => `{ id = ${i + 1}, t = 5 }`).join(', ');
  const others = Array.from({ length: 25 }, (_, i) => `["Alt${i}-TestRealm"] = { deaths = 1, lastDeath = 1, learned = {}, seen = ${i} }`).join(', ');
  const vm = ready({ saved: `ClaudeWoWDB = { telemetry = { seq = "x", junk = string.rep("y", 100), chars = { ${others}, ["${CHARACTER}"] = { deaths = -3, learned = { ${junk}, { id = "bad" } }, seen = 1000 }, [5] = {} } } }` });
  const mine = `ClaudeWoWDB.telemetry.chars["${CHARACTER}"]`;
  assert.equal(vm.evaluate('ClaudeWoWDB.telemetry.junk'), null);
  assert.equal(vm.num('ClaudeWoWDB.telemetry.seq') > 0, true);
  assert.equal(vm.num(`#${mine}.learned`), 8);
  assert.equal(vm.num(`${mine}.learned[1].id`), 13);
  assert.equal(vm.num(`${mine}.deaths`), 0);
  vm.run('N = 0; for k in pairs(ClaudeWoWDB.telemetry.chars) do N = N + 1 end');
  assert.equal(vm.num('N'), 20, 'the 20 most recently seen characters are kept');
  assert.equal(vm.evaluate('ClaudeWoWDB.telemetry.chars["Alt0-TestRealm"]'), null, 'the oldest go first');
  for (let i = 0; i < 12; i++) vm.run(`STUB.FireEvent("NEW_RECIPE_LEARNED", ${100 + i})`);
  assert.equal(vm.num(`#${mine}.learned`), 8);
  assert.equal(vm.num(`${mine}.learned[8].id`), 111);
});

test('Inbox.lua at login brings the bridge\'s hashes, so only what changed goes out', () => {
  const probe = ready({ saved: 'ClaudeWoWDB = { session = "fixedsession" }' });
  const [first] = gsJobs(shoot(probe));
  const hashes = Object.entries(Object.fromEntries(first.text.split('\n').slice(1).map(l => l.split(':').slice(0, 2)))).map(([n, h]) => `${n} = "${h}"`).join(', ');
  const vm = newVM({ saved: 'ClaudeWoWDB = { session = "fixedsession", settings = { transport = "screenshot", stripLevels = { on = 255, off = 0, codec = 1 } } }' });
  vm.run(`ClaudeWoW_Inbox = { now = time(), cwd = "", transport = "screenshot", strip = { on = 255, off = 0 }, gs = { v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = { { character = "${CHARACTER}", session = "fixedsession", seq = ${first.id}, hashes = { ${hashes} } } } }, replies = {} }`);
  vm.run('STUB.money = STUB.money + 21');
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  vm.run('STUB.RunTimers()');
  const hello = shoot(vm);
  assert.ok(hello.jobs.some(j => j.hello));
  const [rider] = gsJobs(hello);
  assert.ok(rider, 'the capability came from Inbox.lua, before any slot');
  assert.deepEqual(Object.keys(sectionsOf(rider).sections), ['money'], 'only the section that changed since the bridge last heard');
});

test('the Lua character key equals goals.js characterOf on the same game context, case by case', () => {
  const cases = [
    ['Bone', 'Forever'],
    ['Bone', 'Forever Realm'],
    ['Bone', "Forever's Realm"],
    ['Bone', 'Forever (PvP)'],
    ['Bone', 'A, B'],
    ['Bone', ''],
    ['Bone', null],
    ['Боне', 'Вечность'],
    ['Bóne', 'Éternité'],
    ['Bone', '  Spaced   Out  '],
  ];
  const vm = newVM();
  for (const [name, realm] of cases) {
    vm.run(`function UnitName(unit) return ${JSON.stringify(name)} end; function GetRealmName() return ${realm === null ? 'nil' : JSON.stringify(realm)} end`);
    const who = G.characterOf(vm.evaluate('ClaudeWoW.GameContext()'));
    assert.equal(vm.evaluate('ClaudeWoWTelemetry.CharacterKey()'), who ? who.key : null, `${name} / ${realm}`);
  }
  vm.run(`function UnitName(unit) return ${JSON.stringify('B'.repeat(70))} end; function GetRealmName() return "Forever" end`);
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.CharacterKey()'), null, 'over 64 characters the addon sends no key');
  vm.run(`function UnitName(unit) return ${JSON.stringify('Б'.repeat(60))} end`);
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.CharacterKey()'), null, 'the cap counts characters, not bytes');
  vm.run(`function UnitName(unit) return ${JSON.stringify('Б'.repeat(50))} end`);
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.CharacterKey()'), `${'Б'.repeat(50)}-Forever`);
});

test('when a record head does not fit the room left, the change still waits for a shot of its own', () => {
  const vm = ready();
  const [first] = gsJobs(shoot(vm));
  const luaHashes = first.text.split('\n').slice(1).map(l => l.split(':')).map(([n, h]) => `${n} = "${h}"`).join(', ');
  tick(vm, 31);
  vm.run('STUB.money = STUB.money + 29; STUB.FireEvent("PLAYER_MONEY")');
  vm.run('local take = ClaudeWoWTelemetry.Take; ClaudeWoWTelemetry.Take = function(room, solo) if not solo then return take(10, solo) end return take(room, solo) end');
  vm.run('ClaudeWoW.Send("tight frame")');
  assert.deepEqual(gsJobs(shoot(vm)), [], 'no room for even the head');
  const chat = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(vm, slotBody(`{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = { { character = "${CHARACTER}", session = ClaudeWoWDB.session, seq = ${first.id}, hashes = { ${luaHashes} } } } }`, `, replies = { { chat = "${chat}", id = ${id}, status = "done", text = "ok" } }`));
  tick(vm, 6);
  tick(vm, 2);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'inside the 2-minute window nothing goes yet');
  tick(vm, 90);
  const [solo] = gsJobs(shoot(vm));
  assert.ok(solo, 'the pending change still has a hint and goes on its own shot');
  assert.deepEqual(Object.keys(sectionsOf(solo).sections), ['money']);
});

test('the addon stops sending when the slot lists its own character key as refused', () => {
  const vm = ready({ gs: `{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = {}, refused = { "${CHARACTER}" } }` });
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'no telemetry-only shot for a refused key');
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  tick(vm, 130);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.Active()'), 'false');
  const other = ready({ gs: '{ v = 1, watch = { items = { 2589 }, factions = { 530 } }, chars = {}, refused = { "Someone-Else" } }' });
  assert.ok(gsJobs(shoot(other)).length, 'another character\'s refused key does not stop this one');
});

test('/claude config telemetry off stops telemetry and on starts it again', () => {
  const vm = ready();
  shoot(vm);
  vm.run('SlashCmdList.CLAUDE("config telemetry off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.telemetry'), 'false');
  vm.run('STUB.FireEvent("PLAYER_DEAD")');
  tick(vm, 130);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'off: no shot even for a death');
  vm.run('ClaudeWoW.Send("still talking")');
  assert.deepEqual(gsJobs(shoot(vm)), [], 'off: nothing rides on messages');
  vm.run('SlashCmdList.CLAUDE("config telemetry on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.telemetry'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.Status()'), 'on');
});

test('a message waits behind a fired telemetry-only shot, then is shot at once after its own failure', () => {
  const vm = ready();
  const frames = () => { for (let i = 0; i < 2; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end'); };
  frames();
  const shots = vm.num('STUB.screenshots');
  vm.run('ClaudeWoW.Send("queued behind")');
  frames();
  assert.equal(vm.num('STUB.screenshots'), shots, 'no second screenshot while the first is being written');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the message is up again at once after its failure');
  const frame = decodeStrip(vm);
  assert.ok(P.jobsFromStrip(frame.id, frame.text).some(j => j.text === 'queued behind'));
  frames();
  assert.equal(vm.num('STUB.screenshots'), shots + 1, 'and shot');
});

test('a late screenshot event from a timed-out shot never completes the next shot: a message drawn after the timeout is still shot', () => {
  const vm = ready();
  const frames = () => { for (let i = 0; i < 2; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end'); };
  frames();
  const fired = vm.num('STUB.screenshots');
  vm.run('STUB.RunTimers()');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'the telemetry-only shot timed out');
  vm.run('ClaudeWoW.Send("after a slow shot")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames();
  assert.equal(vm.num('STUB.screenshots'), fired, 'no second shot while the late event may still come');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the late event belongs to the old shot, not to the message');
  const frame = decodeStrip(vm);
  assert.ok(P.jobsFromStrip(frame.id, frame.text).some(j => j.text === 'after a slow shot'));
  frames();
  assert.equal(vm.num('STUB.screenshots'), fired + 1, 'the message is shot once the late event is in');
});
