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
STUB.codecFrames = {}
local plainEncode = ClaudeWoW_Codec.Encode
ClaudeWoW_Codec.Encode = function(id, payload, ...)
  table.insert(STUB.codecFrames, { kind = "strip", payload = payload })
  return plainEncode(id, payload, ...)
end
local plainLogLines = ClaudeWoW_Codec.LogLines
ClaudeWoW_Codec.LogLines = function(id, payload, ...)
  table.insert(STUB.codecFrames, { kind = "log", payload = payload })
  return plainLogLines(id, payload, ...)
end
STUB.copied = {}
ClaudeWoW.ShowCopy = function(text) table.insert(STUB.copied, text) end
STUB.ctrl, STUB.shift = false, false
function IsControlKeyDown() return STUB.ctrl end
function IsShiftKeyDown() return STUB.shift end
`;

function newVM({ beforeLogin = '', prelude = '' } = {}) {
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
  if (prelude) run(prelude);
  for (const f of ADDON_FILES) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run(SPIES);
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  if (beforeLogin) run(beforeLogin);
  run('STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.RunTimers()');
  return { run, evaluate, num: expr => Number(evaluate(expr)) };
}

const q = s => JSON.stringify(s);

function nextSlot(vm, { openUrl = true, replies = '', acks = '', extra = '' } = {}) {
  vm.run(
    `STUB.onLoadAddOn = function(name) STUB.slotLoads = (STUB.slotLoads or 0) + 1; ClaudeWoW_SlotData = { now = time(), cwd = "", plugin = "ask", plugins = { "ask" }, replies = { ${replies} }, acks = { ${acks} }${openUrl ? ', openUrl = true' : ''}${extra} } end`,
  );
}

function ackResult(vm, id, open, why) {
  return `{ session = ${q(vm.evaluate('ClaudeWoWDB.session'))}, id = ${id}, open = ${q(open)}${why ? `, why = ${q(why)}` : ''} }`;
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

function toasts(vm, text = 'Opening in your browser') {
  vm.run(`RESULT = 0; for _, m in ipairs(UIErrorsFrame.messages or {}) do if m.text == ${q(text)} then RESULT = RESULT + 1 end end`);
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
  assert.equal(toasts(vm, 'Still opening the last link'), 1, 'it says why nothing happens');
});

test('the bridge result comes back on the ack: ok ends the wait, refused opens the copy box with the reason', () => {
  const vm = newVM();
  askAndReply(vm, 'which PRs?', `It is ${PR} and https://github.com/o/r/pull/8.`);
  click(vm, PR);
  const [first] = urlRecords(vm);
  nextSlot(vm, { acks: ackResult(vm, first.id, 'ok') });
  tick(vm, 5);
  assert.equal(outboundUrls(vm), 0, 'the ack in the slot took it off the strip');
  assert.deepEqual(copied(vm), []);
  tick(vm, 1);
  click(vm, 'https://github.com/o/r/pull/8');
  const [second] = urlRecords(vm);
  assert.equal(second.text, 'https://github.com/o/r/pull/8', 'the next link goes once the first is answered');
  nextSlot(vm, { acks: ackResult(vm, second.id, 'refused', 'rate limit: 20 links an hour') });
  tick(vm, 5);
  assert.deepEqual(copied(vm), ['https://github.com/o/r/pull/8']);
  assert.equal(toasts(vm, 'Link not opened: rate limit: 20 links an hour. Copy it from the box.'), 1);
  tick(vm, 60);
  assert.deepEqual(copied(vm), ['https://github.com/o/r/pull/8'], 'one answer, one copy box');
});

test('a result for another session or another record is not taken', () => {
  const vm = newVM();
  askAndReply(vm, 'which PR?', `It is ${PR}.`);
  click(vm, PR);
  const [rec] = urlRecords(vm);
  nextSlot(vm, { acks: `{ session = "other", id = ${rec.id}, open = "refused", why = "x" }, ${ackResult(vm, rec.id + 50, 'refused', 'y')}` });
  tick(vm, 5);
  assert.deepEqual(copied(vm), []);
  assert.equal(toasts(vm, 'Still opening the last link'), 0);
  click(vm, PR);
  assert.equal(toasts(vm, 'Still opening the last link'), 1, 'still waiting for its own answer');
});

test('a second link within 5 s of the last one waits, with a line saying so', () => {
  const vm = newVM();
  askAndReply(vm, 'which PRs?', `It is ${PR} and https://github.com/o/r/pull/8.`);
  click(vm, PR);
  const [rec] = urlRecords(vm);
  nextSlot(vm, { acks: ackResult(vm, rec.id, 'ok') });
  tick(vm, 4.5);
  click(vm, 'https://github.com/o/r/pull/8');
  assert.equal(toasts(vm, 'Wait a moment before the next link'), 1);
  assert.equal(outboundUrls(vm), 0);
  assert.deepEqual(copied(vm), []);
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

test('a link that no reply holds goes to the copy box and never to the bridge', () => {
  const vm = newVM();
  askAndReply(vm, 'look at https://evil.example/x please', `It is ${PR}.`);
  const unknown = ['https://evil.example/x', 'https://github.com/o/r', PR + '/files'];
  for (const url of unknown) click(vm, url);
  assert.deepEqual(copied(vm), unknown);
  assert.equal(outboundUrls(vm), 0);
});

test('a hostile link is refused before the reply check, even when a reply holds it', () => {
  const long = 'https://example.com/' + 'a'.repeat(2100);
  const hostile = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'steam://run/440',
    '-https://example.com',
    'https://example.com/a b',
    'https://example.com/"x',
    long,
  ];
  const vm = newVM();
  askAndReply(vm, 'list them', hostile.join('\n'));
  for (const url of hostile) assert.equal(vm.evaluate(`ClaudeWoW.OpenUrl(${q(url)})`), 'refused', JSON.stringify(url).slice(0, 60));
  click(vm, long);
  assert.deepEqual(copied(vm), [long], 'a reply link over 2048 characters goes to the copy box');
  assert.equal(outboundUrls(vm), 0);
});

test('an ack file arms one slot read for the result', () => {
  const vm = newVM({ beforeLogin: ARMED });
  vm.run('ClaudeWoW.PresenceWorks = function() return true end');
  askAndReply(vm, 'which PR?', `It is ${PR}.`);
  click(vm, PR);
  const [rec] = urlRecords(vm);
  nextSlot(vm, { acks: ackResult(vm, rec.id, 'refused', 'not a link from a reply in this chat') });
  vm.run('STUB.slotLoads = 0');
  ack(vm, rec.id);
  tick(vm, 0.5);
  assert.equal(outboundUrls(vm), 0, 'acked');
  assert.equal(vm.num('STUB.slotLoads'), 0);
  click(vm, PR);
  assert.equal(toasts(vm, 'Still opening the last link'), 1, 'acked but not answered is still busy');
  assert.equal(outboundUrls(vm), 0);
  tick(vm, 1);
  assert.equal(vm.num('STUB.slotLoads'), 1, 'one slot read a second after the ack');
  assert.deepEqual(copied(vm), [PR]);
});

function loadsPerSecond(vm, seconds, onSecond = () => {}) {
  const loads = {};
  for (let t = 1; t <= seconds; t++) {
    const before = vm.num('STUB.slotLoads');
    onSecond(t);
    tick(vm, 1);
    const n = vm.num('STUB.slotLoads') - before;
    if (n) loads[t] = n;
  }
  return loads;
}

test('without presence signals the result is polled at 4, 12 and 25 s, one slot each, three in all', () => {
  const vm = newVM();
  vm.run('ClaudeWoW.PresenceWorks = function() return false end');
  askAndReply(vm, 'which PR?', `It is ${PR}.`);
  tick(vm, 120);
  click(vm, PR);
  vm.run('STUB.slotLoads = 0');
  assert.deepEqual(loadsPerSecond(vm, 39), { 4: 1, 12: 1, 25: 1 });
  tick(vm, 1);
  assert.equal(vm.num('STUB.slotLoads'), 3);
  assert.deepEqual(copied(vm), [PR]);
  assert.deepEqual(loadsPerSecond(vm, 30), {}, 'nothing after the 40 s');
});

test('one click costs at most four slot reads: the ack read and the three timed ones', () => {
  const vm = newVM({ beforeLogin: ARMED });
  vm.run('ClaudeWoW.PresenceWorks = function() return true end');
  askAndReply(vm, 'which PR?', `It is ${PR}.`);
  tick(vm, 120);
  click(vm, PR);
  const [rec] = urlRecords(vm);
  vm.run('STUB.slotLoads = 0');
  const loads = loadsPerSecond(vm, 39, t => {
    if (t === 2) ack(vm, rec.id);
  });
  assert.deepEqual(loads, { 3: 1, 4: 1, 12: 1, 25: 1 });
  tick(vm, 1);
  assert.equal(vm.num('STUB.slotLoads'), 4);
});

test('unanswered for 40 s after the click, the record is dropped, never sent again, and the link goes to the copy box', () => {
  const vm = newVM();
  askAndReply(vm, 'which PR?', `It is ${PR}.`);
  click(vm, PR);
  assert.equal(outboundUrls(vm), 1);
  tick(vm, STRIP_SECONDS - 1);
  assert.equal(outboundUrls(vm), 1);
  assert.deepEqual(copied(vm), []);
  tick(vm, 1);
  assert.equal(outboundUrls(vm), 0, 'a late open is worse than none: no retry');
  assert.deepEqual(copied(vm), [PR]);
  assert.equal(toasts(vm, 'Link not opened: no answer from the bridge. Copy it from the box.'), 1);
  tick(vm, STRIP_SECONDS * 3);
  assert.equal(outboundUrls(vm), 0, 'and it never comes back');
});

const KEY = '0123456789abcdef0123456789abcdef';
const CLIENT_LOG_API = `
SENT, LOGGING = {}, false
function SendSystemMessage(text) SENT[#SENT + 1] = text end
function LoggingChat(on) if on ~= nil then LOGGING = on end return LOGGING end
`;

test('on the chat log transport a url record is written once, never retried by screenshot, and expires 40 s after the click', () => {
  const vm = newVM({ prelude: CLIENT_LOG_API, beforeLogin: ARMED });
  const chatlog = `, transport = "screenshot", chatlog = { line = 200, filler = 400, key = "${KEY}" }`;
  nextSlot(vm, { extra: chatlog });
  tick(vm);
  ack(vm, vm.num('ClaudeWoWDB.lastSeq'));
  tick(vm, 2);
  vm.run(`ClaudeWoWDB.chats[1].history = { { role = "assistant", t = 1, text = ${q('see ' + PR)} } }`);
  const shotsBefore = vm.num('STUB.screenshots');
  const sentBefore = vm.num('#SENT');
  click(vm, PR);
  const id = vm.num('ClaudeWoWDB.lastSeq');
  const frameLines = () => {
    vm.run(`RESULT = 0; for i = ${sentBefore + 1}, #SENT do if SENT[i]:find("^CWX1 ${KEY} ${id} ") then RESULT = RESULT + 1 end end`);
    return vm.num('RESULT');
  };
  const written = frameLines();
  assert.ok(written > 0, 'the record went out on the chat log');
  const step = () => {
    tick(vm, 1);
    for (let i = 0; i < 3; i++) vm.run('local f = ClaudeWoWStrip; if f and f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end');
  };
  for (let t = 0; t < 39; t++) step();
  assert.equal(frameLines(), written, 'never written again');
  assert.equal(vm.num('STUB.screenshots'), shotsBefore, 'and never shot after the chat log retry window');
  step();
  assert.deepEqual(copied(vm), [PR], 'expired 40 s after the click');
  for (let t = 0; t < 60; t++) step();
  assert.equal(frameLines(), written);
  assert.equal(vm.num('STUB.screenshots'), shotsBefore);
});

function framesSince(vm, from) {
  const n = vm.num('#STUB.codecFrames');
  const out = [];
  for (let i = from + 1; i <= n; i++) {
    const payload = vm.evaluate(`STUB.codecFrames[${i}].payload`);
    const records = payload.split('\x1E').map(r => {
      const p = r.split('\x1F');
      return { id: Number(p[2]), flags: p[4] || '' };
    });
    out.push({ kind: vm.evaluate(`STUB.codecFrames[${i}].kind`), records });
  }
  return out;
}

const carriesUrl = (frame, id) => frame.records.some(r => r.id === id && r.flags.split(';').includes(`kind=${OU.KIND}`));

function drive(vm, n = 3) {
  for (let i = 0; i < n; i++) vm.run('local f = ClaudeWoWStrip; if f and f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end');
}

function screenshotVM() {
  const vm = newVM({ beforeLogin: ARMED });
  nextSlot(vm, { extra: ', transport = "screenshot"' });
  tick(vm);
  drive(vm);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  ack(vm, vm.num('ClaudeWoWDB.lastSeq'));
  tick(vm, 2);
  vm.run(`ClaudeWoWDB.chats[1].history = { { role = "assistant", t = 1, text = ${q('see ' + PR)} } }`);
  return vm;
}

test('screenshot transport: a url record rides in one shot only; a later message and its retry shoot frames without it', () => {
  const vm = screenshotVM();
  const from = vm.num('#STUB.codecFrames');
  const settle = () => {
    drive(vm);
    vm.run('if STUB.screenshots > (STUB.lastShots or 0) then STUB.lastShots = STUB.screenshots; STUB.FireEvent("SCREENSHOT_SUCCEEDED") end');
  };
  vm.run('STUB.lastShots = STUB.screenshots; ClaudeWoW.Send("hello there")');
  const message = vm.num('ClaudeWoWDB.lastSeq');
  settle();
  tick(vm, 20);
  click(vm, PR);
  const id = vm.num('ClaudeWoWDB.lastSeq');
  settle();
  for (let t = 0; t < 30; t++) {
    tick(vm, 1);
    settle();
  }
  const frames = framesSince(vm, from);
  assert.ok(frames.filter(f => f.records.some(r => r.id === message)).length >= 2, 'the message went out and was retried');
  assert.equal(frames.filter(f => carriesUrl(f, id)).length, 1, 'the url record is in exactly one frame');
});

test('screenshot transport: only a shot the game reported failed is taken again with the url record', () => {
  const vm = screenshotVM();
  const from = vm.num('#STUB.codecFrames');
  click(vm, PR);
  const id = vm.num('ClaudeWoWDB.lastSeq');
  drive(vm);
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  drive(vm);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('ClaudeWoW.Send("hello there")');
  drive(vm);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  const frames = framesSince(vm, from);
  assert.equal(frames.filter(f => carriesUrl(f, id)).length, 2, 'the failed shot and its retake');
  assert.ok(
    frames.some(f => f.records.some(r => r.id === id + 1) && !carriesUrl(f, id)),
    'the message after it goes alone',
  );
});

test('a transport change while a url record waits does not draw, shoot or log it again', () => {
  const shot = screenshotVM();
  click(shot, PR);
  const id = shot.num('ClaudeWoWDB.lastSeq');
  drive(shot);
  shot.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  const from = shot.num('#STUB.codecFrames');
  const shotsBefore = shot.num('STUB.screenshots');
  nextSlot(shot, { extra: ', transport = "pixel"' });
  shot.run('ClaudeWoW.Connect(true)');
  tick(shot, 6);
  drive(shot);
  assert.equal(shot.evaluate('ClaudeWoWDB.settings.transport'), 'pixel');
  assert.equal(framesSince(shot, from).filter(f => carriesUrl(f, id)).length, 0, 'not drawn again on the pixel strip');
  assert.equal(shot.num('STUB.screenshots'), shotsBefore);

  const logged = newVM({ prelude: CLIENT_LOG_API, beforeLogin: ARMED });
  nextSlot(logged, { extra: `, transport = "screenshot", chatlog = { line = 200, filler = 400, key = "${KEY}" }` });
  tick(logged);
  ack(logged, logged.num('ClaudeWoWDB.lastSeq'));
  tick(logged, 2);
  logged.run(`ClaudeWoWDB.chats[1].history = { { role = "assistant", t = 1, text = ${q('see ' + PR)} } }`);
  click(logged, PR);
  const logId = logged.num('ClaudeWoWDB.lastSeq');
  const logFrom = logged.num('#STUB.codecFrames');
  nextSlot(logged, { extra: `, transport = "screenshot", chatlog = { line = 200, filler = 400, key = "${'f'.repeat(32)}" }` });
  logged.run('ClaudeWoW.Connect(true)');
  tick(logged, 6);
  drive(logged);
  assert.equal(framesSince(logged, logFrom).filter(f => carriesUrl(f, logId)).length, 0, 'not logged or shot again under the new key');
});

test('chat log transport: a message sent while a url record waits, and its screenshot retry, go without it', () => {
  const vm = newVM({ prelude: CLIENT_LOG_API, beforeLogin: ARMED });
  nextSlot(vm, { extra: `, transport = "screenshot", chatlog = { line = 200, filler = 400, key = "${KEY}" }` });
  tick(vm);
  ack(vm, vm.num('ClaudeWoWDB.lastSeq'));
  tick(vm, 2);
  vm.run(`ClaudeWoWDB.chats[1].history = { { role = "assistant", t = 1, text = ${q('see ' + PR)} } }`);
  const from = vm.num('#STUB.codecFrames');
  click(vm, PR);
  const id = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('ClaudeWoW.Send("hello there")');
  for (let t = 0; t < 39; t++) {
    tick(vm, 1);
    drive(vm);
  }
  const frames = framesSince(vm, from);
  assert.ok(
    frames.some(f => f.kind === 'log' && f.records.some(r => r.id === id + 1)),
    'the message went on the chat log',
  );
  assert.ok(
    frames.some(f => f.kind === 'strip' && f.records.some(r => r.id === id + 1)),
    'and was retried by screenshot',
  );
  assert.deepEqual(
    frames.filter(f => carriesUrl(f, id)).map(f => f.kind),
    ['log'],
    'the url record went once, on the chat log',
  );
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
