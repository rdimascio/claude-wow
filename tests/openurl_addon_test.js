'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const OU = require('../bridge/openurl');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const ADDON_FILES = ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua'];
const CELLS_PER_ROW = 200;
const STRIP_SECONDS = 40;
const PR = 'https://github.com/o/r/pull/7';

const SPIES = `
STUB.copied = {}
ClaudeWoW.ShowCopy = function(text) table.insert(STUB.copied, text) end
STUB.ctrl, STUB.shift = false, false
function IsControlKeyDown() return STUB.ctrl end
function IsShiftKeyDown() return STUB.shift end
`;

function newVM({ beforeLogin = '' } = {}) {
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
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  for (const f of ADDON_FILES) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run(SPIES);
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  if (beforeLogin) run(beforeLogin);
  run('STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.RunTimers()');
  return { run, evaluate, num: expr => Number(evaluate(expr)) };
}

const q = s => JSON.stringify(s);

function nextSlot(vm, { openUrl = true, replies = '' } = {}) {
  vm.run(
    `STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", plugin = "ask", plugins = { "ask" }, replies = { ${replies} }${openUrl ? ', openUrl = true' : ''} } end`,
  );
}

function tick(vm, seconds = 6) {
  vm.run(`STUB.now = STUB.now + ${seconds}; STUB.Tick()`);
}

function pending(vm) {
  vm.run(
    'PENDING_CHAT, PENDING_ID = nil, nil; for _, c in ipairs(ClaudeWoWDB.chats) do if c.pendingId then PENDING_CHAT, PENDING_ID = c.id, c.pendingId end end',
  );
  return { chat: vm.evaluate('PENDING_CHAT'), id: vm.evaluate('PENDING_ID') };
}

function askAndReply(vm, ask, reply, { openUrl = true } = {}) {
  nextSlot(vm, { openUrl });
  tick(vm);
  vm.run(`ClaudeWoW.Send(${q(ask)})`);
  const p = pending(vm);
  nextSlot(vm, { openUrl, replies: `{ chat = "${p.chat}", id = ${p.id}, status = "done", text = ${q(reply)}, agent = "", plugin = "ask" }` });
  tick(vm);
  tick(vm, STRIP_SECONDS + 1);
  return p.chat;
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
  const len = bytes[4] * 256 + bytes[5];
  return Buffer.from(bytes.slice(6, 6 + len)).toString('utf8');
}

function urlRecords(vm) {
  const text = decodeStrip(vm);
  if (!text) return [];
  return text
    .split('\x1E')
    .map(r => {
      const p = r.split('\x1F');
      return { session: p[0], chat: p[1], id: Number(p[2]), flags: p[4], text: p.slice(6).join('\x1F') };
    })
    .filter(r => r.flags.split(';').includes(`kind=${OU.KIND}`));
}

function outboundUrls(vm) {
  return urlRecords(vm).length;
}

function click(vm, url, button = 'LeftButton') {
  vm.run(`STUB.ClickLink(${q(`|cff71d5ff|Haddon:claudewow:url:${url}|h[link]|h|r`)}, ${q(button)})`);
}

function copied(vm) {
  return Number(vm.evaluate('#STUB.copied'))
    ? JSON.parse(
        `[${vm.evaluate('table.concat((function() local t = {} for i, s in ipairs(STUB.copied) do t[i] = string.format("%q", s) end return t end)(), ",")')}]`,
      )
    : [];
}

function toasts(vm) {
  vm.run('RESULT = 0; for _, m in ipairs(UIErrorsFrame.messages or {}) do if m.text == "Opening in your browser" then RESULT = RESULT + 1 end end');
  return vm.num('RESULT');
}

function ack(vm, id) {
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\ack\\\\${String(id).padStart(3, '0')}.wav"] = false`);
}

const ARMED = 'STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\ctl\\\\valid.wav"] = true; STUB.armed = true';

test('a left click on a link from a reply asks the bridge to open it, once, and says so', () => {
  const vm = newVM();
  const chat = askAndReply(vm, 'which PR?', `It is ${PR}.`);
  click(vm, PR);
  const recs = urlRecords(vm);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].chat, chat);
  assert.equal(recs[0].text, PR);
  assert.deepEqual(copied(vm), [], 'no copy box');
  assert.equal(toasts(vm), 1);
  click(vm, PR);
  assert.equal(outboundUrls(vm), 1, 'a second click while the first is unanswered sends nothing');
  assert.deepEqual(copied(vm), [], 'and opens no copy box');
});

test('right, ctrl and shift clicks open the copy box and send nothing', () => {
  const vm = newVM();
  askAndReply(vm, 'which PR?', `It is ${PR}.`);
  click(vm, PR, 'RightButton');
  vm.run('STUB.ctrl = true');
  click(vm, PR);
  vm.run('STUB.ctrl = false; STUB.shift = true');
  click(vm, PR);
  assert.deepEqual(copied(vm), [PR, PR, PR]);
  assert.equal(outboundUrls(vm), 0);
  assert.equal(toasts(vm), 0);
});

test('a bubble click passes the mouse button through: right click copies', () => {
  const vm = newVM();
  askAndReply(vm, 'which PR?', `It is ${PR}.`);
  vm.run(
    `ClaudeWoW.Toggle(true); ClaudeWoW.Render(); STUB.bubble = (function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b end end end)()`,
  );
  vm.run(`STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, ${q('addon:claudewow:url:' + PR)}, "[PR #7]", "RightButton")`);
  assert.deepEqual(copied(vm), [PR]);
  assert.equal(outboundUrls(vm), 0);
  vm.run(`STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, ${q('addon:claudewow:url:' + PR)}, "[PR #7]", "LeftButton")`);
  assert.equal(outboundUrls(vm), 1);
});

test('without the capability, the copy box stays: an older bridge, a later slot without it, reload mode, a bridge that is down', () => {
  const old = newVM();
  askAndReply(old, 'which PR?', `It is ${PR}.`, { openUrl: false });
  click(old, PR);
  assert.deepEqual(copied(old), [PR], 'a bridge that does not offer it');
  assert.equal(outboundUrls(old), 0);

  const dropped = newVM();
  askAndReply(dropped, 'which PR?', `It is ${PR}.`);
  askAndReply(dropped, 'and now?', 'nothing new', { openUrl: false });
  click(dropped, PR);
  assert.deepEqual(copied(dropped), [PR], 'a bridge that stopped offering it');
  assert.equal(outboundUrls(dropped), 0);

  const reload = newVM();
  askAndReply(reload, 'which PR?', `It is ${PR}.`);
  reload.run('ClaudeWoWDB.settings.mode = "reload"');
  click(reload, PR);
  assert.deepEqual(copied(reload), [PR], 'reload mode has no strip to carry it');
  assert.equal(outboundUrls(reload), 0);

  const down = newVM();
  askAndReply(down, 'which PR?', `It is ${PR}.`);
  down.run('STUB.onLoadAddOn = function() ClaudeWoW_SlotData = nil end');
  tick(down, 30 * 60);
  assert.equal(down.evaluate('ClaudeWoW.BridgeState()'), 'down');
  click(down, PR);
  assert.deepEqual(copied(down), [PR], 'a bridge that is down');
  assert.equal(outboundUrls(down), 0);
});

test('a link that no reply holds, or a hostile one, goes to the copy box and never to the bridge', () => {
  const vm = newVM();
  askAndReply(vm, 'look at https://evil.example/x please', `It is ${PR}.`);
  const refused = [
    'https://evil.example/x',
    'https://github.com/o/r',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'steam://run/440',
    '-https://example.com',
    'https://example.com/a b',
    'https://example.com/"x',
    'https://example.com/' + 'a'.repeat(2100),
  ];
  for (const url of refused) click(vm, url);
  assert.deepEqual(copied(vm), refused);
  assert.equal(outboundUrls(vm), 0);
  assert.equal(urlRecords(vm).length, 0);
});

test('the record leaves the strip on its ack and is never sent again; unanswered, it is dropped after one try', () => {
  const vm = newVM({ beforeLogin: ARMED });
  askAndReply(vm, 'which PR?', `It is ${PR}.`);
  click(vm, PR);
  const [rec] = urlRecords(vm);
  ack(vm, rec.id);
  tick(vm, 1);
  assert.equal(outboundUrls(vm), 0, 'acked');
  tick(vm, 3);
  click(vm, PR);
  assert.equal(outboundUrls(vm), 1);
  tick(vm, STRIP_SECONDS + 1);
  assert.equal(outboundUrls(vm), 0, 'a late open is worse than none: no retry');
  tick(vm, STRIP_SECONDS * 3);
  assert.equal(outboundUrls(vm), 0, 'and it never comes back');
});

test('the capability from Inbox.lua counts only when the file is fresh', () => {
  const seeded = vm => vm.run(`ClaudeWoWDB.chats[1].history = { { role = "assistant", t = 1, text = ${q('see ' + PR)} } }`);
  const fresh = newVM({ beforeLogin: 'ClaudeWoW_Inbox = { now = time(), openUrl = true, replies = {} }' });
  seeded(fresh);
  click(fresh, PR);
  assert.equal(outboundUrls(fresh), 1);
  assert.deepEqual(copied(fresh), []);
  const stale = newVM({ beforeLogin: 'ClaudeWoW_Inbox = { now = time() - 3600, openUrl = true, replies = {} }' });
  seeded(stale);
  click(stale, PR);
  assert.equal(outboundUrls(stale), 0);
  assert.deepEqual(copied(stale), [PR]);
});
