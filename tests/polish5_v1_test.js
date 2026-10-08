'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');

const INTERNALS = `
  local function upvalue(fn, name)
    local i = 1
    while true do
      local n, v = debug.getupvalue(fn, i)
      if not n then return nil end
      if n == name then return v end
      i = i + 1
    end
  end
  Q = upvalue(ClaudeWoW.UpdateStatus, "Q")
  function RUN() return upvalue(ClaudeWoW.Connect, "run") end
`;

function newVM({ dock = false, saved = '', afterLoad = '' } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, chunk, arg) => {
    const buf = to_luastring(code);
    const loaded = chunk ? lauxlib.luaL_loadbuffer(L, buf, buf.length, to_luastring('@' + chunk)) : lauxlib.luaL_loadstring(L, buf);
    if (loaded !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    if (arg !== undefined) lua.lua_pushstring(L, to_luastring(arg));
    if (lua.lua_pcall(L, arg === undefined ? 0 : 1, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
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
  if (dock) run('STUB.ChatDock()');
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Help.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'addon/' + f, 'ClaudeWoW');
  run(INTERNALS);
  if (saved) run(saved);
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  if (afterLoad) run(afterLoad);
  run('STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate, num };
}

const prints = vm => vm.evaluate('table.concat(STUB.prints, "\\n")') || '';
const count = (text, needle) => text.split(needle).length - 1;

function hello(vm, agent) {
  vm.run('STUB.RunTimers()');
  vm.run(`STUB.onLoadAddOn = function() ClaudeWoW_SlotData = { now = time(), cwd = "", ${agent ? `agent = "${agent}", ` : ''}replies = {} } end`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
}

const WHISPER_CHOICE_ON = 'ClaudeWoWDB.settings.whisper = true; ClaudeWoWDB.settings.whisperChoice = "on"';
const USER_MESSAGE = 'table.insert(ClaudeWoWDB.chats[1].history, { role = "user", text = "earlier", t = time() })';

test('whisper tabs migration: fresh, explicit on/off, the V2 automatic default and a pre-V2 explicit on, applied once', () => {
  const migrate = settings => {
    const vm = newVM();
    vm.run(`S = ${settings}; ClaudeWoW.MigrateWhisper(S, false)`);
    const first = vm.evaluate('tostring(S.whisper) .. "|" .. tostring(S.whisperChoice) .. "|" .. tostring(S.whisperNews)');
    vm.run('ClaudeWoW.MigrateWhisper(S, false)');
    const second = vm.evaluate('tostring(S.whisper) .. "|" .. tostring(S.whisperChoice) .. "|" .. tostring(S.whisperNews)');
    assert.equal(second, first, `idempotent for ${settings}`);
    return first;
  };
  assert.equal(migrate('{ whisperChoice = "on", whisperV2 = true, whisper = false }'), 'true|on|nil', 'an explicit on stays on');
  assert.equal(migrate('{ whisperChoice = "off", whisperV2 = true, whisper = true }'), 'false|off|nil', 'an explicit off stays off');
  assert.equal(migrate('{ whisperV2 = true, whisper = true }'), 'false|nil|nil', 'the V2 automatic default is not a choice');
  assert.equal(migrate('{ whisperV2 = true, whisper = true, whisperNews = true }'), 'false|nil|nil', 'the V2 news is dropped');
  assert.equal(migrate('{ whisper = true }'), 'true|on|nil', 'a pre-V2 on was set by hand');
  assert.equal(migrate('{ whisper = false }'), 'false|nil|nil');
  assert.equal(migrate('{}'), 'false|nil|nil');

  const fresh = newVM();
  assert.equal(fresh.evaluate('ClaudeWoWDB.settings.whisper'), 'false', 'a fresh install starts with the window');
  assert.equal(fresh.evaluate('ClaudeWoWDB.settings.whisperV3'), 'true');
  const freshFlag = newVM({ saved: 'ClaudeWoWDB = {}' });
  assert.equal(freshFlag.evaluate('ClaudeWoWDB.settings.whisper'), 'false');
  freshFlag.run('S = { whisper = true }; ClaudeWoW.MigrateWhisper(S, true)');
  assert.equal(freshFlag.evaluate('tostring(S.whisper) .. "|" .. tostring(S.whisperChoice)'), 'false|nil', 'fresh data has no old choice to keep');

  const marked = newVM({ saved: 'ClaudeWoWDB = { settings = { whisperV3 = true, whisper = true } }' });
  assert.equal(marked.evaluate('ClaudeWoWDB.settings.whisper'), 'false', 'after V3 only whisperChoice turns tabs on');
  marked.run('SlashCmdList.CLAUDE("config ui whisper on")');
  assert.equal(marked.evaluate('ClaudeWoWDB.settings.whisperChoice'), 'on', 'a typed choice is recorded');
  marked.run('ClaudeWoW.MigrateWhisper(ClaudeWoWDB.settings, false)');
  assert.equal(marked.evaluate('ClaudeWoWDB.settings.whisper'), 'true');

  const news = newVM({ dock: true, saved: 'ClaudeWoWDB = { settings = { whisperV2 = true, whisper = true, whisperNews = true, whisperChoice = "on" } }' });
  news.run(USER_MESSAGE);
  hello(news, 'claude');
  assert.equal(news.num('STUB.tempWindows'), 1);
  assert.doesNotMatch(news.evaluate('STUB.Lines(ChatFrame11)') || '', /New: chats live in whisper tabs/, 'the old news line is gone');
  assert.equal(news.evaluate('ClaudeWoWDB.settings.whisperNews'), null);
  assert.equal(news.evaluate('ClaudeWoW.LastWhisperChoice'), null, 'the history scan is gone');
});

test('the Options page shows whisper tabs off by default', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('(function() for _, o in ipairs(ClaudeWoWHelp.OPTIONS) do if o.key == "whisper" then return o.default end end end)()'), 'false');
});

test('a whisper tab opens only with tabs on, a live companion app, a user message and a real agent name', () => {
  const tabs = vm => vm.num('STUB.tempWindows');
  const pulse = vm => vm.run('for i = 1, 3 do STUB.now = STUB.now + 1; STUB.Tick() end');

  const off = newVM({ dock: true, afterLoad: USER_MESSAGE });
  hello(off, 'claude');
  off.run('ClaudeWoW.Send("hi")');
  pulse(off);
  assert.equal(tabs(off), 0, 'tabs off: no tab, even with everything else ready');

  const noMessage = newVM({ dock: true, afterLoad: WHISPER_CHOICE_ON });
  hello(noMessage, 'claude');
  pulse(noMessage);
  noMessage.run('SlashCmdList.CLAUDE("config ui whisper on")');
  assert.equal(tabs(noMessage), 0, 'no user message: no tab');
  assert.match(
    noMessage.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'),
    /^Whisper tabs are ON\. A chat gets its tab in the chat dock once the companion app answers and you send that chat a message\./,
  );
  noMessage.run('ClaudeWoW.Send("first message")');
  assert.equal(tabs(noMessage), 1, 'the first message opens it');
  assert.equal(noMessage.evaluate('ChatFrame11Tab.text'), 'First message', 'titled like the chat');

  const silent = newVM({ dock: true, afterLoad: WHISPER_CHOICE_ON + '; ' + USER_MESSAGE });
  silent.run('STUB.RunTimers(); STUB.RunTimers()');
  pulse(silent);
  silent.run('SlashCmdList.CLAUDE("-c --agent claude")');
  silent.run('SlashCmdList.CLAUDE("config ui whisper on")');
  pulse(silent);
  assert.equal(tabs(silent), 0, 'no companion app heard: no tab');

  const reload = newVM({
    dock: true,
    saved: 'ClaudeWoWDB = { settings = { mode = "reload" } }',
    afterLoad: WHISPER_CHOICE_ON + '; ' + USER_MESSAGE + '; ClaudeWoWDB.chats[1].agent = "claude"',
  });
  assert.equal(reload.evaluate('ClaudeWoW.IsConnected()'), 'true', 'reload mode reports connected');
  pulse(reload);
  reload.run('SlashCmdList.CLAUDE("config ui whisper on")');
  assert.equal(tabs(reload), 0, 'but connected is not evidence the companion app is alive');

  const nameless = newVM({ dock: true, afterLoad: WHISPER_CHOICE_ON + '; ' + USER_MESSAGE });
  hello(nameless);
  pulse(nameless);
  nameless.run('SlashCmdList.CLAUDE("config ui whisper on")');
  assert.equal(tabs(nameless), 0, 'no agent name yet: no tab called "AI"');
  nameless.run('ClaudeWoW.Send("hi")');
  assert.equal(tabs(nameless), 0, 'not even for a message');
  hello(nameless, 'claude');
  pulse(nameless);
  assert.equal(tabs(nameless), 1, 'the named agent gets its tab at the next pulse');
  assert.equal(nameless.evaluate('ChatFrame11Tab.text'), 'Claude');

  const ready = newVM({ dock: true, afterLoad: WHISPER_CHOICE_ON + '; ' + USER_MESSAGE });
  hello(ready, 'claude');
  pulse(ready);
  assert.equal(tabs(ready), 1, 'all four: the active chat is a tab at login');
});

test('/r routing order is unchanged: the selected tab, then a typed agent name', () => {
  const vm = newVM({ dock: true, afterLoad: WHISPER_CHOICE_ON + '; ' + USER_MESSAGE });
  hello(vm, 'claude');
  vm.run('STUB.now = STUB.now + 1; STUB.Tick()');
  vm.run('ChatFrame1EditBox:SetText("/w Claude routed"); STUB.PressEnter(ChatFrame1EditBox)');
  assert.equal(vm.num('STUB.serverSends'), 0);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), 'routed');
});

test('a window left open stays open at the next login now that tabs are off by default', () => {
  const vm = newVM({ saved: 'ClaudeWoWDB = { settings = { shown = true, miniBarV2 = true } }' });
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shown'), 'true');
  const autoDefault = newVM({ dock: true, saved: 'ClaudeWoWDB = { settings = { shown = true, miniBarV2 = true, whisper = true, whisperV2 = true } }' });
  assert.equal(autoDefault.evaluate('ClaudeWoWFrame.shown'), 'true', 'the old automatic whisper default no longer hides it');
});

test('first run: one empty-state message, one first-login line naming the minimap button and /claude, one unreachable line', () => {
  const vm = newVM();
  const out = prints(vm);
  assert.equal(count(out, 'Loaded. Click the minimap button or type /claude to open it.'), 1);
  vm.run('STUB.RunTimers(); STUB.RunTimers(); STUB.RunTimers(); STUB.RunTimers()');
  assert.equal(count(prints(vm), "Can't reach the companion app. Start it, then type /claude and click Connect."), 1, 'one unreachable line');
  vm.run('STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers(); STUB.RunTimers()');
  const later = prints(vm);
  assert.equal(count(later, 'Loaded. Click'), 1, 'the login line is said once: ' + later);
  assert.doesNotMatch(later, /bridge/i);

  vm.run('ClaudeWoW.IsConnected = function() return true end; RUN().restoring = nil');
  const state = () => vm.evaluate('(function() local e = Q.EmptyState(ClaudeWoWDB.chats[1]) return e and table.concat(e.lines, "\\n") end)()');
  assert.equal(count(state(), vm.evaluate('Q.FIRST_RUN_TEXT')), 1, 'the first-run line is in the empty state');
  vm.run('ClaudeWoW.NewChat()');
  vm.run(USER_MESSAGE);
  assert.equal(
    vm.evaluate(`(function() local e = Q.EmptyState(ClaudeWoWDB.chats[2]) return table.concat(e.lines, "\\n") end)()`),
    'Shift-click an item, spell or quest to link it.',
    'gone once anything was sent',
  );
});

test('status: Connecting... while connecting, then "No answer from the companion app. Is it running?" in the status and the empty state', () => {
  const vm = newVM();
  const status = () => vm.evaluate('ClaudeWoW.UI.status:GetText()');
  const empty = () => vm.evaluate('(function() local e = Q.EmptyState(ClaudeWoWDB.chats[1]) return e.title .. "|" .. table.concat(e.lines, "\\n") end)()');
  vm.run('ClaudeWoW.UpdateStatus()');
  assert.equal(status(), '|cffffd100Connecting...|r', 'the login hello is a connect');
  assert.match(empty(), /^Connecting\.\.\.\|/);
  vm.run('STUB.RunTimers(); STUB.RunTimers(); STUB.now = STUB.now + 30; STUB.Tick(); ClaudeWoW.UpdateStatus()');
  assert.equal(status(), '|cffff5050No answer from the companion app. Is it running?|r');
  assert.equal(empty(), 'Not connected|No answer from the companion app. Is it running?');

  vm.run('ClaudeWoW.Connect(true); ClaudeWoW.UpdateStatus()');
  assert.equal(status(), '|cffffd100Connecting...|r', 'a Connect click');
  vm.run('STUB.now = STUB.now + 20; STUB.Tick(); ClaudeWoW.UpdateStatus()');
  assert.equal(status(), '|cffff5050No answer from the companion app. Is it running?|r', 'after the attempt fails');
  assert.equal(vm.evaluate('Q.PlainStatus(ClaudeWoWDB.chats[1])'), 'No answer from the companion app. Is it running?');

  vm.run('STUB.onLoadAddOn = function() ClaudeWoW_SlotData = { now = time(), cwd = "", agent = "claude", replies = {} } end');
  vm.run('ClaudeWoW.Connect(true); STUB.now = STUB.now + 6; STUB.Tick(); STUB.Tick(); ClaudeWoW.UpdateStatus()');
  assert.equal(status(), 'Ready');
  vm.run('STUB.onLoadAddOn = nil; STUB.now = STUB.now + 3000; ClaudeWoW.UpdateStatus()');
  assert.equal(status(), "|cffff5050Can't reach the companion app. Start it, then click Connect.|r", 'seen before, then silent');
  assert.match(vm.evaluate('select(5, ClaudeWoW.BridgeState())'), /^Companion app: not seen for .*\. Is it running\?$/);
});

test('Resend lifecycle: an ack hides it for good, retries never push it back, a manual resend starts the wait again', () => {
  const pending = vm => vm.num('ClaudeWoWDB.chats[1].pendingId');
  const show = vm => vm.evaluate('Q.ShouldShowResend(ClaudeWoWDB.chats[1])');
  const button = vm => vm.evaluate('ClaudeWoW.UI.resend:IsShown()');
  const wait = (vm, seconds) => vm.run(`STUB.now = STUB.now + ${seconds}; STUB.Tick()`);

  const acked = newVM();
  hello(acked, 'claude');
  acked.run('ClaudeWoW.Send("are you there")');
  assert.equal(show(acked), 'false', 'not at once');
  acked.run(`ClaudeWoW.ApplyAcks({ { id = ${pending(acked)}, session = ClaudeWoWDB.session } })`);
  wait(acked, 2);
  assert.equal(acked.evaluate(`RUN().outbound[${pending(acked)}]`), null, 'the transport drops the acknowledged record');
  wait(acked, 60);
  wait(acked, 60);
  assert.equal(show(acked), 'false', 'acknowledged, then silent: still no resend');
  assert.equal(button(acked), 'false');

  const unacked = newVM();
  hello(unacked, 'claude');
  unacked.run('ClaudeWoW.Send("hello?")');
  wait(unacked, 39);
  assert.equal(show(unacked), 'false');
  assert.equal(button(unacked), 'false');
  wait(unacked, 2);
  assert.equal(unacked.evaluate(`RUN().outbound[${pending(unacked)}].tries`), '2', 'the transport retried on its own');
  assert.equal(show(unacked), 'true', 'its retry does not restart the wait');
  assert.equal(button(unacked), 'true', 'the tick shows the button');
  wait(unacked, 41);
  assert.equal(show(unacked), 'true', 'still offered through the next retry');

  unacked.run('ClaudeWoW.Resend()');
  assert.equal(show(unacked), 'false', 'a manual resend starts the wait again');
  wait(unacked, 39);
  assert.equal(show(unacked), 'false');
  wait(unacked, 2);
  assert.equal(show(unacked), 'true');
  unacked.run('ClaudeWoWDB.chats[1].progress = "Reading files"');
  assert.equal(show(unacked), 'false', 'progress is an acknowledgement too');
  unacked.run(`ClaudeWoWDB.chats[1].progress = nil; ClaudeWoW.ApplyAcks({ { id = ${pending(unacked)}, session = ClaudeWoWDB.session } })`);
  assert.equal(show(unacked), 'false', 'so is a late ack');

  const relogged = newVM({
    saved:
      'ClaudeWoWDB = { settings = { pluginsV1 = true, chatsPerCharacterV1 = true }, lastSeq = 5, session = "s1", forget = {}, activeChat = "c1", chats = { { id = "c1", name = "Chat 1", cwd = "", agent = "", plugin = "", unread = 0, pendingId = 5, history = { { role = "user", text = "question", id = 5, t = time() } } } } }',
  });
  hello(relogged, 'claude');
  wait(relogged, 30);
  assert.equal(button(relogged), 'false', 'a request from before the reload has no outbound record');
  wait(relogged, 15);
  assert.equal(button(relogged), 'true', 'the tick still shows the button once the wait is over');

  assert.equal(unacked.evaluate('Q.ShouldShowResend(nil)'), 'false');
  assert.equal(unacked.evaluate('Q.ResendVisible(ClaudeWoWDB.chats[1], "reload")'), 'false');
  assert.match(unacked.evaluate('Q.RESEND_TIP'), /companion app/);
  assert.doesNotMatch(unacked.evaluate('Q.RESEND_TIP'), /bridge/i);
});

test('a reply replayed from an hour-old inbox at login is not evidence the companion app is alive', () => {
  const saved = `ClaudeWoWDB = { settings = { whisperV3 = true, whisperChoice = "on", pluginsV1 = true, chatsPerCharacterV1 = true, echoV2 = true }, lastSeq = 5, session = "s1", forget = {}, activeChat = "c1",
    chats = { { id = "c1", name = "Chat 1", cwd = "", agent = "claude", plugin = "", unread = 0, pendingId = 5, history = { { role = "user", text = "question", id = 5, t = time() - 3700 } } } } }
    ClaudeWoW_Inbox = { now = time() - 3600, cwd = "", agent = "claude", replies = { { chat = "c1", id = 5, status = "done", text = "old answer", agent = "claude" } } }`;
  const vm = newVM({ dock: true, saved });
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), 'old answer', 'the saved reply is replayed');
  vm.run('for i = 1, 3 do STUB.now = STUB.now + 1; STUB.Tick() end');
  assert.notEqual(vm.evaluate('ClaudeWoW.BridgeState()'), 'ok', 'the replay counts at the inbox time');
  assert.equal(vm.num('STUB.tempWindows'), 0, 'no tab while the companion app is stopped');
  hello(vm, 'claude');
  vm.run('for i = 1, 2 do STUB.now = STUB.now + 1; STUB.Tick() end');
  assert.equal(vm.num('STUB.tempWindows'), 1, 'a fresh answer opens it');

  const fresh = newVM({ dock: true, saved: saved.replace('now = time() - 3600', 'now = time()') });
  fresh.run('STUB.now = STUB.now + 1; STUB.Tick()');
  assert.equal(fresh.evaluate('ClaudeWoW.BridgeState()'), 'ok', 'a fresh inbox is evidence');
});

test('unread follows where the reply went: a tab the gate refused leaves the reply unread in the window', () => {
  const reply = vm => {
    const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
    vm.run(
      `STUB.onLoadAddOn = function() ClaudeWoW_SlotData = { now = time(), cwd = "", replies = { { chat = ClaudeWoWDB.chats[1].id, id = ${id}, status = "done", text = "answer" } } } end`,
    );
    for (let i = 0; i < 8; i++) vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
    assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'the reply landed');
  };
  const refused = newVM({ dock: true, afterLoad: WHISPER_CHOICE_ON + '; ' + USER_MESSAGE });
  hello(refused);
  refused.run('ClaudeWoW.Send("q"); ClaudeWoWFrame:Hide()');
  reply(refused);
  assert.equal(refused.num('STUB.tempWindows'), 0, 'no agent name: the gate refused the tab');
  assert.equal(refused.num('ClaudeWoWDB.chats[1].unread'), 1, 'so the reply is unread');

  const tabbed = newVM({ dock: true, afterLoad: WHISPER_CHOICE_ON + '; ' + USER_MESSAGE });
  hello(tabbed, 'claude');
  tabbed.run('ClaudeWoW.Send("q"); ClaudeWoWFrame:Hide()');
  reply(tabbed);
  assert.equal(tabbed.num('STUB.tempWindows'), 1);
  assert.equal(tabbed.num('ClaudeWoWDB.chats[1].unread'), 0, 'a reply shown in its tab is read there');
});

test('waiting, stop and give-up text: "Click Stop", "Stopped.", and no message ids', () => {
  const vm = newVM();
  hello(vm, 'claude');
  vm.run('ClaudeWoW.Send("long job")');
  vm.run('ClaudeWoW.Send("meanwhile")');
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  assert.match(last(), /is still working\. .*Click Stop to cancel\.$/);
  assert.doesNotMatch(last(), /#\d/);
  vm.run('ClaudeWoW.Cancel(ClaudeWoWDB.chats[1])');
  assert.match(last(), /^Stopped\./);
  assert.doesNotMatch(last(), /#\d|bridge/i);
  vm.run('ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("other job"); ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id); ClaudeWoW.Cancel(ClaudeWoWDB.chats[1])');
  assert.match(last(), /^Nothing to cancel: .* Waiting: \d+\. Two\. Pick one/);
  assert.doesNotMatch(last(), /#\d/);
  vm.run('Q.GiveUp(ClaudeWoWDB.chats[2])');
  const gaveUp = vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text');
  assert.match(gaveUp, /^No reply arrived and nothing was heard about it for \d+ minutes/);
  assert.doesNotMatch(gaveUp, /#\d|bridge/i);
});

test('the whisper progress line offers [stop], and the companion app status lines never say bridge', () => {
  const vm = newVM({ dock: true, afterLoad: WHISPER_CHOICE_ON + '; ' + USER_MESSAGE });
  hello(vm, 'claude');
  vm.run('STUB.now = STUB.now + 1; STUB.Tick(); ClaudeWoW.Send("work")');
  const lines = vm.evaluate('STUB.Lines(ChatFrame11)');
  assert.match(lines, /is working\.\.\. .*\|Haddon:claudewow:cancel:\w+\|h\|cff888888\[stop\]/);
  vm.run('STUB.onLoadAddOn = nil; STUB.now = STUB.now + 800; STUB.Tick()');
  vm.run('STUB.now = STUB.now + 600; STUB.Tick()');
  assert.doesNotMatch(vm.evaluate('STUB.Lines(ChatFrame11)'), /bridge/i);
});

test('reload in combat: never reloads on its own after combat; asks again, and counts as asked only when the dialog opened', () => {
  const vm = newVM({ saved: 'ClaudeWoWDB = { settings = { mode = "reload", autoRefresh = false, autoRefreshV2 = true } }' });
  vm.run('STUB.timers = {}; STUB.popup = nil; ClaudeWoWDB.chats[1].pendingId = 9');
  vm.run('STUB.combat = true; ClaudeWoW.Send("still there?")');
  assert.equal(vm.evaluate('STUB.reloaded'), 'false', 'send-while-pending in combat does not reload');
  assert.equal(vm.evaluate('ClaudeWoW.UI.status:GetText()'), vm.evaluate('Q.RELOAD_COMBAT_STATUS'));
  vm.run('STUB.popupBusy = true; STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('STUB.reloaded'), 'false', 'leaving combat never reloads');
  assert.equal(vm.evaluate('STUB.popup'), null, 'the dialog could not open');
  assert.equal(vm.evaluate('RUN().reloadAsked'), null, 'so it is not marked asked');
  vm.run('STUB.popupBusy = false; STUB.RunTimers()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_RELOAD', 'the next interval asks');
  assert.equal(vm.evaluate('RUN().reloadAsked'), vm.evaluate('Q.PendingKey()'));
  assert.equal(vm.evaluate('RUN().reloadAfterCombat'), null, 'the request is done once the dialog opened');
  assert.equal(vm.evaluate('StaticPopupDialogs.CLAUDEWOW_RELOAD.text'), vm.evaluate('Q.RELOAD_TEXT_REPLY'));
  assert.equal(vm.evaluate('STUB.reloaded'), 'false');

  const again = newVM({ saved: 'ClaudeWoWDB = { settings = { mode = "reload", autoRefresh = false, autoRefreshV2 = true } }' });
  again.run('STUB.timers = {}; STUB.popup = nil; ClaudeWoWDB.chats[1].pendingId = 9; STUB.combat = true; ClaudeWoW.Send("x")');
  again.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(again.evaluate('STUB.popup.which'), 'CLAUDEWOW_RELOAD', 'the Reload dialog is shown again at once');
  assert.equal(again.evaluate('RUN().reloadAsked'), again.evaluate('Q.PendingKey()'));
  assert.equal(again.evaluate('STUB.reloaded'), 'false');
  again.run('StaticPopupDialogs.CLAUDEWOW_RELOAD.OnAccept()');
  assert.equal(again.evaluate('STUB.reloaded'), 'true', 'the click reloads');

  const manual = newVM();
  manual.run('STUB.popup = nil; STUB.combat = true; SlashCmdList.CLAUDE("reload")');
  assert.equal(manual.evaluate('STUB.reloaded'), 'false');
  manual.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(manual.evaluate('STUB.reloaded'), 'false', 'a reload asked for in combat waits for a click');
  assert.equal(manual.evaluate('STUB.popup.which'), 'CLAUDEWOW_RELOAD');
  assert.equal(manual.evaluate('StaticPopupDialogs.CLAUDEWOW_RELOAD.text'), manual.evaluate('Q.RELOAD_TEXT_AFTER_COMBAT'));
  manual.run('STUB.popup = nil; STUB.combat = true; STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(manual.evaluate('STUB.popup'), null, 'asked once per request');

  const busy = newVM();
  busy.run('STUB.timers = {}; STUB.popup = nil; STUB.combat = true; SlashCmdList.CLAUDE("reload")');
  busy.run('STUB.popupBusy = true; STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(busy.evaluate('STUB.popup'), null, 'every dialog slot was taken');
  assert.equal(busy.evaluate('RUN().reloadAfterCombat'), 'true', 'the request is kept');
  assert.equal(busy.evaluate('Q.PendingKey()'), '', 'with nothing pending');
  busy.run('STUB.popupBusy = false; STUB.RunTimers()');
  assert.equal(busy.evaluate('STUB.popup.which'), 'CLAUDEWOW_RELOAD', 'the watcher asks again');
  assert.equal(busy.evaluate('StaticPopupDialogs.CLAUDEWOW_RELOAD.text'), busy.evaluate('Q.RELOAD_TEXT_AFTER_COMBAT'));
  assert.equal(busy.evaluate('RUN().reloadAfterCombat'), null);
  assert.equal(busy.evaluate('STUB.reloaded'), 'false', 'never on its own');
  busy.run('STUB.popup = nil; STUB.RunTimers()');
  assert.equal(busy.evaluate('STUB.popup'), null, 'and only once');
});
