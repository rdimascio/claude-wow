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
const HOGGER = 'Hogger';

const ROAST_STUB = `
STUB.names = { player = "Testchar" }
function UnitName(unit) return STUB.names[unit] end
STUB.levels = {}
function UnitLevel(unit) if STUB.levels[unit] ~= nil then return STUB.levels[unit] end return STUB.level end
STUB.SECRET = setmetatable({}, { __tostring = function() error("attempt to use a secret value") end })
function issecretvalue(v) return v == STUB.SECRET end
`;

function newVM() {
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
  run(ROAST_STUB);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Roast.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
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

function stripJobs(vm) {
  const frame = decodeStrip(vm);
  return frame ? P.jobsFromStrip(frame.id, frame.text) : [];
}

function nextSlot(vm, luaBody) {
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = ${luaBody} end`);
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
}

function connect(vm) {
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", plugin = "ask", plugins = { "ask", "claude-code", "roast" }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
}

function luaArgs(values) {
  return values.map(v => (v === null ? 'nil' : typeof v === 'string' ? JSON.stringify(v) : String(v))).join(', ');
}

function hit(vm, { amount, flag = '', school = 1, action = 'WOUND', unit = 'player' }) {
  vm.run(`STUB.FireEvent("UNIT_COMBAT", ${luaArgs([unit, action, flag, amount, school])})`);
}

function luaValue(v) {
  if (v === null || v === undefined) return 'nil';
  if (v === 'SECRET') return 'STUB.SECRET';
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

function recapEvent(e) {
  return (
    '{ ' +
    Object.entries(e)
      .map(([k, v]) => `${k} = ${luaValue(v)}`)
      .join(', ') +
    ' }'
  );
}

function deathRecap(vm, newestFirst, maxHealth = 0) {
  vm.run(`STUB.deathRecap = { ${newestFirst.map(recapEvent).join(', ')} }; STUB.deathRecapMaxHealth = ${maxHealth}`);
}

function hoggerRecap(vm, stamp = 500) {
  deathRecap(vm, [{ timestamp: stamp, event: 'SWING_DAMAGE', sourceName: HOGGER, amount: 52, overkill: 17 }]);
}

function withRoastChatHelper(vm) {
  vm.run('function ClaudeWoW_RoastChatForTest() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.roast.chat then return c end end end');
}

function ready({ on = true } = {}) {
  const vm = newVM();
  login(vm);
  connect(vm);
  withRoastChatHelper(vm);
  vm.run('STUB.prints = {}');
  if (on) vm.run('SlashCmdList.CLAUDE("config roast on")');
  return vm;
}

function registered(vm, event) {
  return vm.evaluate(
    `(function() for _, f in ipairs(STUB.frames) do local r = f.events.${event}; if r == true then return "all" end if type(r) == "table" then local u = {} for k in pairs(r) do u[#u + 1] = k end table.sort(u) return table.concat(u, ",") end end end)()`,
  );
}

test('roast: off by default, the slash command turns it on and off and says so, and nothing is registered, recorded or sent while off', () => {
  const vm = ready({ on: false });
  assert.equal(vm.evaluate('ClaudeWoWDB.roast.on'), 'false', 'off by default');
  assert.equal(registered(vm, 'PLAYER_DEAD'), null, 'no death event while off');
  assert.equal(registered(vm, 'UNIT_COMBAT'), null, 'no combat event while off');
  hit(vm, { amount: 40 });
  assert.equal(vm.num('#ClaudeWoWRoast.Hits()'), 0, 'no hits kept while off');
  hoggerRecap(vm);
  vm.run('ClaudeWoWRoast.OnDeath(STUB.now, time())');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1, 'no roast chat while off');
  assert.ok(!stripJobs(vm).some(j => j.kind), 'no roast record on the strip');

  vm.run('SlashCmdList.CLAUDE("config roast")');
  assert.ok(vm.evaluate('STUB.prints[#STUB.prints]').includes('Death roast is OFF'), vm.evaluate('STUB.prints[#STUB.prints]'));
  vm.run('SlashCmdList.CLAUDE("config roast on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.roast.on'), 'true');
  assert.ok(vm.evaluate('STUB.prints[#STUB.prints]').includes('Death roast is ON'));
  assert.equal(registered(vm, 'PLAYER_DEAD'), 'all');
  assert.equal(registered(vm, 'UNIT_COMBAT'), 'player', 'combat events for the player only');
  vm.run('SlashCmdList.CLAUDE("config roast off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.roast.on'), 'false');
  assert.equal(registered(vm, 'PLAYER_DEAD'), null, 'unregistered when turned off');
  assert.equal(registered(vm, 'UNIT_COMBAT'), null);
  assert.equal(vm.num('#STUB.actionBlocked'), 0, 'nothing the client blocks');

  vm.run('SlashCmdList.CLAUDE("roast the lich king for me please")');
  assert.ok(
    stripJobs(vm).some(j => j.text === 'roast the lich king for me please'),
    'free text starting with "roast" is a message',
  );
  vm.run('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id); SlashCmdList.CLAUDE("config")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('\nroast = off  -  on|off'));
});

test('roast: the same death recap is never sent twice, and hidden or secret fields read as unknown', () => {
  const vm = ready();
  hoggerRecap(vm, 600);
  assert.ok(vm.evaluate('ClaudeWoWRoast.ReadRecap(STUB.now)'), 'first read');
  assert.equal(vm.evaluate('ClaudeWoWRoast.ReadRecap(STUB.now)'), null, 'a recap already used is stale');
  deathRecap(vm, [
    { timestamp: 700, event: 'SPELL_DAMAGE', spellName: 'Shadow Bolt', sourceName: 'SECRET', amount: 'SECRET' },
    { timestamp: 699, event: 'ENVIRONMENTAL_DAMAGE', environmentalType: 'FALLING', amount: 180, overkill: 60 },
    { timestamp: 698, event: 'SPELL_DAMAGE', spellName: 'Backstab', sourceName: 'Defias Pathstalker', hideCaster: true, amount: 20 },
  ]);
  const recap = vm.evaluate('ClaudeWoWRoast.BuildRecap(STUB.now, ClaudeWoWRoast.ReadRecap(STUB.now))');
  assert.ok(recap.includes('something unseen: Backstab 20'), recap);
  assert.ok(recap.includes('the environment: Falling 180, overkill 60'), recap);
  assert.ok(recap.includes('something unseen: Shadow Bolt 0 <- killing blow'), recap);
  vm.run('STUB.deathRecap = { { timestamp = STUB.SECRET, amount = 3 } }');
  assert.equal(vm.evaluate('ClaudeWoWRoast.ReadRecap(STUB.now)'), null, 'a recap with no readable time is not used');
});

test('roast: without a death recap, the last 10 s of UNIT_COMBAT hits on the player plus the target at death', () => {
  const vm = ready();
  vm.run(`STUB.names.target = "${HOGGER}"; STUB.levels.target = 11; STUB.names.mouseover = "Kobold Vermin"; STUB.levels.mouseover = 3`);
  hit(vm, { amount: 3 });
  vm.run('STUB.now = STUB.now + 5');
  hit(vm, { amount: 45 });
  vm.run('STUB.now = STUB.now + 3');
  hit(vm, { amount: 38, flag: 'CRITICAL', school: 4 });
  hit(vm, { amount: 99, unit: 'target' });
  hit(vm, { action: 'HEAL', amount: 20 });
  hit(vm, { action: 'DODGE', amount: 0 });
  vm.run('STUB.now = STUB.now + 2.5');
  hit(vm, { amount: 52, school: 36 });
  vm.run('STUB.now = STUB.now + 0.2');
  assert.equal(vm.num('#ClaudeWoWRoast.Hits()'), 3, 'the first hit fell out of the window; heals, misses and hits on others never count');
  const recap = vm.evaluate('ClaudeWoWRoast.BuildRecap(STUB.now, ClaudeWoWRoast.ReadRecap(STUB.now))');
  const lines = recap.split('\n');
  assert.equal(lines[1], 'Hits taken in the last 10 s, oldest first (the game does not say who dealt them):');
  assert.equal(lines[2], '-5.7s Physical 45');
  assert.equal(lines[3], '-2.7s Fire 38 crit');
  assert.equal(lines[4], '-0.2s Mixed 52 <- last hit');
  assert.equal(lines[5], 'Damage taken: 135. Last hit: Mixed 52.');
  assert.equal(lines[6], 'At death your target was Hogger (level 11) and the mouse was over Kobold Vermin (level 3).');
});

test('roast: a long recap is capped to the budget and keeps the killing blow; a death with nothing seen still gets a recap', () => {
  const vm = ready();
  vm.run('ClaudeWoWRoast.MAX_BYTES = 420');
  const events = [{ timestamp: 1003.1, event: 'SWING_DAMAGE', sourceName: 'Edwin VanCleef', amount: 300, overkill: 250 }];
  for (let i = 29; i >= 0; i--)
    events.push({
      timestamp: 1000 + i * 0.1,
      event: 'SPELL_DAMAGE',
      spellName: 'An Extremely Long Fireball Name',
      sourceName: `Defias Pillager Number ${i}`,
      amount: 10 + i,
    });
  deathRecap(vm, events);
  const recap = vm.evaluate('ClaudeWoWRoast.BuildRecap(STUB.now, ClaudeWoWRoast.ReadRecap(STUB.now))');
  assert.ok(Buffer.byteLength(recap) <= 420, `${Buffer.byteLength(recap)} bytes`);
  assert.ok(/\(\d+ earlier hits left out\)/.test(recap), recap);
  assert.ok(recap.includes('Edwin VanCleef: Melee 300, overkill 250 <- killing blow'), recap);
  assert.ok(recap.includes('from 31 sources'), 'the total still counts every hit in the recap');
  vm.run('ClaudeWoWRoast.MAX_BYTES = 900; ClaudeWoWRoast.Reset(); STUB.deathRecap = nil');
  const empty = vm.evaluate('ClaudeWoWRoast.BuildRecap(STUB.now, ClaudeWoWRoast.ReadRecap(STUB.now))');
  assert.ok(empty.startsWith('Death recap: a level 23'), empty);
  assert.ok(empty.includes('No damage seen in the last 10 s'), empty);
  assert.ok(empty.endsWith('At death you had no target.'), empty);
});
