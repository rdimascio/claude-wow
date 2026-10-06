'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const CELLS_PER_ROW = 200;

const SOUND_STUB = `
STUB.played = {}
SOUNDKIT = { UI_EPICLOOT_TOAST = 31578, UI_NEED_ROLL_POSITIVE = 229319, LOOT_WINDOW_COIN_SOUND = 120, UI_NEED_ROLL_NEGATIVE = 229321 }
local SOUND_NAMES = {}
for name, id in pairs(SOUNDKIT) do SOUND_NAMES[id] = name end
function PlaySound(id) if SOUND_NAMES[id] then table.insert(STUB.played, SOUND_NAMES[id]) end end
function PlaySoundFile(path) if STUB.sounds[path] then return true, 1 end return false end
`;

const POPUP_STUB = `
function StaticPopup_Show(which, a, b, data)
  if STUB.popupFails then return nil end
  local d = { which = which, text = a, data = data, shown = true }
  STUB.popup = d
  return d
end
`;

function newVM({ withRollModule = true, prelude = '' } = {}) {
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
  run(POPUP_STUB);
  if (prelude) run(prelude);
  const files = ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua'].concat(withRollModule ? ['LootRoll.lua'] : []);
  for (const f of files) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.RunTimers()');
  run('STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} } end');
  run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(evaluate('ClaudeWoW.IsConnected()'), 'true');
  return { run, evaluate, num };
}

function stripFlags(vm) {
  if (vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown') !== 'true') return [];
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
  const payload = Buffer.from(bytes.slice(6, 6 + len)).toString('utf8');
  return payload.split('\x1E').map(r => ({ flags: r.split('\x1F')[4], text: r.split('\x1F').slice(-1)[0] }));
}

function deliverDenial(vm, rules, agent = 'claude', chatIndex = 1, extra = '') {
  vm.run('ClaudeWoW.Send("clean the build folder")');
  const chatId = vm.evaluate(`ClaudeWoWDB.chats[${chatIndex}].id`);
  const id = vm.num(`ClaudeWoWDB.chats[${chatIndex}].pendingId`);
  const luaRules = rules.map(r => JSON.stringify(r)).join(', ');
  vm.run(
    `STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "I need permission", agent = "${agent}", denied = { ${luaRules} }${extra ? ', ' + extra : ''} } } } end`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate(`ClaudeWoWDB.chats[${chatIndex}].pendingId`), null);
  return { chatId, id };
}

const lastHistory = 'ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history]';

test('Greed grants the rules for this retry only: a once= flag, never allow=', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('STUB.played = {}; ClaudeWoWRollFrame.GreedButton.scripts.OnClick(ClaudeWoWRollFrame.GreedButton)');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'LOOT_WINDOW_COIN_SOUND');
  const records = stripFlags(vm);
  const rec = records.find(r => r.flags.includes('once='));
  assert.ok(rec, 'a once record on the strip');
  assert.equal(rec.flags, 'once=Bash(rm:*)');
  assert.ok(!records.some(r => r.flags.includes('allow=')));
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.allow'), null);
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.allowOnce').toLowerCase(), Buffer.from('Bash(rm:*)').toString('hex'));
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history - 1].text').includes('this retry only'));
});

test('the countdown runs out after 60 seconds and counts as Pass', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  vm.run('STUB.now = STUB.now + 30; ClaudeWoWRollFrame.scripts.OnUpdate(ClaudeWoWRollFrame, 30)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true');
  vm.run('STUB.played = {}; STUB.now = STUB.now + 31; ClaudeWoWRollFrame.scripts.OnUpdate(ClaudeWoWRollFrame, 31)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'false');
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_NEED_ROLL_NEGATIVE');
  assert.equal(vm.evaluate(`${lastHistory}.text`), 'Passed on: Bash(git:*) (the roll timed out)');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox and ClaudeWoWDB.outbox.allow'), null);
});

test('a roll whose denial went stale closes without acting, and the next queued roll shows', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('ClaudeWoW.NewChat("second")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].name'), 'second');
  const second = deliverDenial(vm, ['WebFetch'], 'grok', 2);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().rules[1]'), 'Bash(rm:*)', 'the first roll keeps the frame');
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1, 'the second waits its turn');
  const seqBefore = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].denied = nil');
  vm.run('ClaudeWoWRollFrame.scripts.OnUpdate(ClaudeWoWRollFrame, 0)');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seqBefore, 'a stale roll sends nothing');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().chatId'), second.chatId);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.Name.text'), 'WebFetch');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.IconFrame.Icon.texture'), 'Interface\\Icons\\Trade_Engineering');
  vm.run('ClaudeWoWRollFrame.PassButton.scripts.OnClick(ClaudeWoWRollFrame.PassButton)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current()'), null);
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 0);
});

test('a context warning right after a denied reply leaves the denial open for the roll frame and the Allow & retry button', () => {
  const vm = newVM();
  vm.run('ClaudeWoWDB.settings.contextWarn = 1000');
  const { chatId, id } = deliverDenial(vm, ['WebSearch'], 'claude', 1, 'ctx = 5000, turns = 3');
  assert.equal(vm.evaluate(`${lastHistory}.role`), 'system');
  assert.equal(vm.evaluate(`${lastHistory}.newChat`), 'true', 'the context warning is the newest message');
  assert.equal(vm.evaluate(`(ClaudeWoW.OpenDenial("${chatId}"))[1]`), 'WebSearch');
  assert.equal(vm.num(`select(2, ClaudeWoW.OpenDenial("${chatId}"))`), id);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true', 'the roll frame still offers the denial');
  vm.run('SlashCmdList.CLAUDE("config roll off")');
  vm.run('RESULT = "none"; for _, f in ipairs(STUB.frames) do if f.template == "UIPanelButtonTemplate" and f.rules and f.shown then RESULT = f.text end end');
  assert.equal(vm.evaluate('RESULT'), 'Allow WebSearch & retry', 'the button sits on the denied reply, not on the warning');
  vm.run('table.insert(ClaudeWoWDB.chats[1].history, { role = "user", text = "never mind", t = time() })');
  assert.equal(vm.evaluate(`ClaudeWoW.OpenDenial("${chatId}")`), null, 'a newer player message closes it');
});

const hexDirs = (...dirs) => Buffer.from(dirs.join('\x1F')).toString('hex');
const chatDirs = vm => {
  vm.run('RESULT = table.concat(ClaudeWoWDB.chats[1].addDirs or {}, "|")');
  return vm.evaluate('RESULT');
};

test('a folder outside the chat is a scroll named after the folder, with folder hints on the buttons', () => {
  const vm = newVM();
  const { chatId } = deliverDenial(vm, ['AddDir(/tmp)']);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.Name.text'), 'Scroll of /tmp');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.IconFrame.Icon.texture'), 'Interface\\Icons\\INV_Scroll_03');
  assert.equal(vm.evaluate('ClaudeWoWRoll.CommandOf("AddDir(/Users/me/My Stuff (old))")'), '/Users/me/My Stuff (old)');
  assert.equal(vm.evaluate('ClaudeWoWRoll.ItemName({ "AddDir(/tmp)", "Bash(curl:*)" })'), 'Scroll of /tmp +1');
  assert.match(vm.evaluate(`ClaudeWoWRoll.Hint("need", { "AddDir(/tmp)" }, "${chatId}")`), /always, for this chat, like \/claude --add-dir/);
  assert.match(vm.evaluate(`ClaudeWoWRoll.Hint("greed", { "AddDir(/tmp)" }, "${chatId}")`), /this retry only/);
  assert.match(vm.evaluate(`ClaudeWoWRoll.Hint("need", { "Bash(curl:*)" }, "${chatId}", "claude")`), /^Allow it always, for Claude\. It is saved/);
  assert.match(vm.evaluate(`ClaudeWoWRoll.Hint("greed", { "Bash(curl:*)" }, "${chatId}")`), /^Allow it for this retry only\. Nothing is saved\.$/);
  assert.doesNotMatch(vm.evaluate(`ClaudeWoWRoll.Hint("need", { "Bash(curl:*)" }, "${chatId}")`), /config\.json/);
  assert.equal(vm.evaluate('ClaudeWoW.GrantsLabel({ "AddDir(/tmp)", "WebSearch" })'), 'folder /tmp, WebSearch');
});

const POPUP = 'StaticPopupDialogs.CLAUDEWOW_ALLOW_ALWAYS';
const accept = vm => vm.run(`local d = STUB.popup; ${POPUP}.OnAccept(d, d.data); d.shown = false; ${POPUP}.OnHide(d)`);
const cancel = vm => vm.run(`local d = STUB.popup; ${POPUP}.OnCancel(d, d.data, "clicked"); d.shown = false; ${POPUP}.OnHide(d)`);
const clickNeed = vm => vm.run('ClaudeWoWRollFrame.NeedButton.scripts.OnClick(ClaudeWoWRollFrame.NeedButton)');
const sentAllow = vm => stripFlags(vm).some(r => /(^|;)(allow|dirs)=/.test(r.flags)) || vm.evaluate('ClaudeWoWDB.outbox and ClaudeWoWDB.outbox.allow') !== null;

test('Need on a folder asks first; after Always Allow it joins the chat for good, like /claude --add-dir, and nothing goes to the allowlist', () => {
  const vm = newVM();
  const { id } = deliverDenial(vm, ['AddDir(/tmp)']);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.played = {}');
  clickNeed(vm);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_ALLOW_ALWAYS', 'Need opens the confirm');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, 'nothing is sent before the confirm');
  assert.equal(chatDirs(vm), '', 'and nothing is added');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'false', 'the roll is parked while the confirm is open');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Parked().msgId'), String(id));
  accept(vm);
  assert.equal(vm.evaluate('table.concat(STUB.played, ",")'), 'UI_NEED_ROLL_POSITIVE');
  assert.equal(chatDirs(vm), '/tmp');
  assert.equal(vm.num('ClaudeWoWDB.chats[1].pendingId'), id + 1);
  const rec = stripFlags(vm).find(r => r.flags.includes('dirs='));
  assert.ok(rec, 'the retry carries the folder');
  assert.equal(rec.flags, `dirs=${hexDirs('/tmp')}`);
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.allow'), null);
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.allowOnce'), null);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Parked()'), null);
  assert.match(
    vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history - 1].text'),
    /^Allowed: folder \/tmp\. Extra folders for this chat: \/tmp$/,
  );
});

test('Pass on a folder denies it; the Allow & retry button names the folder', () => {
  const vm = newVM();
  deliverDenial(vm, ['AddDir(/tmp)']);
  vm.run('SlashCmdList.CLAUDE("config roll off")');
  vm.run('RESULT = "none"; for _, f in ipairs(STUB.frames) do if f.template == "UIPanelButtonTemplate" and f.rules and f.shown then RESULT = f.text end end');
  assert.equal(vm.evaluate('RESULT'), 'Allow folder /tmp & retry');
  vm.run('SlashCmdList.CLAUDE("config roll on")');
  const seqBefore = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('ClaudeWoWRollFrame.PassButton.scripts.OnClick(ClaudeWoWRollFrame.PassButton)');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seqBefore);
  assert.equal(vm.evaluate(`${lastHistory}.text`), 'Passed on: folder /tmp');
  assert.equal(chatDirs(vm), '');
});

test('the always-allow action has one entry point: ClaudeWoW.Allow is gone and every caller opens the confirm', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('ClaudeWoW.Allow'), null);
  assert.equal(vm.evaluate('type(ClaudeWoW.ConfirmAllow)'), 'function');
  const { chatId, id } = deliverDenial(vm, ['Bash(git:*)']);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('ClaudeWoWRoll.CloseAll(); ClaudeWoWDB.settings.lootRoll = false; ClaudeWoW.Render()');
  vm.run('BTN = nil; for _, f in ipairs(STUB.frames) do if f.template == "UIPanelButtonTemplate" and f.rules and f.shown then BTN = f end end');
  assert.equal(vm.evaluate('BTN.msgId'), String(id), 'the transcript button knows which reply it answers');
  vm.run('STUB.popup = nil; BTN.scripts.OnClick(BTN)');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_ALLOW_ALWAYS', 'the transcript Allow & retry button asks first');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  cancel(vm);
  vm.run(`STUB.popup = nil; ClaudeWoW.ConfirmAllow("${chatId}", ${id - 1}, { "Bash(git:*)" })`);
  assert.equal(vm.evaluate('STUB.popup'), null, 'a confirm for an older reply never opens');
  vm.run(`ClaudeWoW.ConfirmAllow("${chatId}", ${id}, { "Bash(rm:*)" })`);
  assert.equal(vm.evaluate('STUB.popup'), null, 'nor one for rules the reply did not ask for');
  vm.run(`STUB.popup = nil; STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:need|h[Allow & retry]|h")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_ALLOW_ALWAYS', 'the whisper link asks first');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.match(vm.evaluate('STUB.popup.text'), /^Always allow this, for Claude\?\n\nBash\(git:\*\)\n/);
  assert.match(vm.evaluate('STUB.popup.text'), /This covers every command that starts with git\./);
  accept(vm);
  const rec = stripFlags(vm).find(r => r.flags.includes('allow='));
  assert.ok(rec, 'the accepted confirm grants it');
  assert.equal(vm.evaluate(`${POPUP}.button1`), 'Always Allow');
  assert.equal(vm.evaluate(`${POPUP}.timeout`), '0', 'the confirm never answers itself');
  assert.equal(vm.evaluate(`${POPUP}.enterClicksFirstButton`), null, 'Enter does not grant');
});

test('the roll timer does not run while the confirm is open, and its expiry never allows', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  clickNeed(vm);
  vm.run('STUB.now = STUB.now + 120; ClaudeWoWRoll.Update(); STUB.RunFrames(120)');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, 'nothing sent after the timer would have run out');
  assert.equal(vm.evaluate(`${lastHistory}.text`), 'I need permission', 'and the roll was not passed');
  assert.equal(vm.evaluate(`${lastHistory}.denied[1]`), 'Bash(git:*)');
  cancel(vm);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true', 'Cancel puts the roll back');
  assert.ok(vm.num('ClaudeWoWRoll.Current().expiresAt - GetTime()') >= 59, 'with a full timer');
  vm.run('STUB.now = STUB.now + 61; ClaudeWoWRoll.Update()');
  assert.equal(vm.evaluate(`${lastHistory}.text`), 'Passed on: Bash(git:*) (the roll timed out)');
  assert.ok(!sentAllow(vm), 'the timeout passed; it did not allow');
});

test('a confirm left open while the chat moved on does nothing: queue advance, clear, delete', () => {
  const advance = newVM();
  deliverDenial(advance, ['Bash(git:*)']);
  clickNeed(advance);
  advance.run('STUB.SAVED = STUB.popup');
  deliverDenial(advance, ['Bash(git:*)']);
  assert.equal(advance.evaluate('select(2, ClaudeWoW.OpenDenial(ClaudeWoWDB.chats[1].id)) ~= STUB.SAVED.data.msgId'), 'true', 'a newer denial is open');
  const seq = advance.num('ClaudeWoWDB.lastSeq');
  advance.run('STUB.popup = STUB.SAVED');
  accept(advance);
  assert.equal(advance.num('ClaudeWoWDB.lastSeq'), seq, 'the old confirm does not grant the new denial');
  assert.equal(advance.evaluate('ClaudeWoWDB.outbox and ClaudeWoWDB.outbox.allow'), null);

  for (const step of ['ClaudeWoW.ClearChat(ClaudeWoWDB.chats[1].id)', 'ClaudeWoW.NewChat("other"); ClaudeWoW.DeleteChat(ClaudeWoWDB.chats[1].id)']) {
    const vm = newVM();
    deliverDenial(vm, ['Bash(git:*)']);
    clickNeed(vm);
    vm.run(step);
    const before = vm.num('ClaudeWoWDB.lastSeq');
    accept(vm);
    assert.equal(vm.num('ClaudeWoWDB.lastSeq'), before, `${step}: nothing sent`);
    assert.equal(vm.evaluate('ClaudeWoWDB.outbox and ClaudeWoWDB.outbox.allow'), null, step);
  }
});

test('the confirm grants only the rules it showed, and only while it is the open one', () => {
  const swapped = newVM();
  deliverDenial(swapped, ['Bash(git:*)']);
  clickNeed(swapped);
  swapped.run(`${lastHistory}.denied = { "Bash(rm:*)" }`);
  const seq = swapped.num('ClaudeWoWDB.lastSeq');
  accept(swapped);
  assert.equal(swapped.num('ClaudeWoWDB.lastSeq'), seq, 'changed rules under the same reply are not granted');

  const replaced = newVM();
  deliverDenial(replaced, ['Bash(git:*)']);
  clickNeed(replaced);
  replaced.run('STUB.FIRST = STUB.popup');
  replaced.run('ClaudeWoW.NewChat("second")');
  const second = deliverDenial(replaced, ['WebFetch'], 'claude', 2);
  replaced.run('STUB.played = {}');
  replaced.run(`ClaudeWoW.ConfirmAllow("${second.chatId}", ${second.id}, { "WebFetch" })`);
  assert.equal(replaced.evaluate('ClaudeWoWRollFrame.shown'), 'false', 'the replaced roll does not flash back');
  assert.equal(replaced.evaluate('#STUB.played'), '0', 'and plays no sound');
  assert.equal(replaced.evaluate('ClaudeWoWRoll.Current()'), null);
  const before = replaced.num('ClaudeWoWDB.lastSeq');
  replaced.run(`${POPUP}.OnAccept(STUB.FIRST, STUB.FIRST.data)`);
  assert.equal(replaced.num('ClaudeWoWDB.lastSeq'), before, 'a confirm another one replaced cannot grant');
  assert.equal(replaced.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  cancel(replaced);
  assert.equal(
    replaced.evaluate('ClaudeWoWRoll.Current().chatId'),
    replaced.evaluate('ClaudeWoWDB.chats[1].id'),
    'its roll comes back when the new confirm closes',
  );
});

test('when a newer confirm is accepted, the roll it replaced comes back', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  clickNeed(vm);
  vm.run('ClaudeWoW.NewChat("second")');
  const second = deliverDenial(vm, ['WebFetch'], 'claude', 2);
  vm.run(`ClaudeWoW.ConfirmAllow("${second.chatId}", ${second.id}, { "WebFetch" })`);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current()'), null);
  accept(vm);
  assert.ok(stripFlags(vm).some(r => r.flags.includes('allow=WebFetch')));
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().chatId'), vm.evaluate('ClaudeWoWDB.chats[1].id'));
});

test('opening the same confirm again changes nothing', () => {
  const vm = newVM();
  const { chatId, id } = deliverDenial(vm, ['Bash(git:*)']);
  clickNeed(vm);
  vm.run('STUB.FIRST = STUB.popup; STUB.played = {}');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:need|h[Need]|h")`);
  assert.equal(vm.evaluate('STUB.popup == STUB.FIRST'), 'true', 'no second dialog');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'false', 'the roll stays parked');
  assert.equal(vm.evaluate('#STUB.played'), '0');
  accept(vm);
  assert.ok(
    stripFlags(vm).some(r => r.flags.includes('allow=')),
    'the first dialog still grants',
  );
});

test('the grant goes only to the agent and plugin the confirm named', () => {
  for (const change of ['ClaudeWoWDB.chats[1].agent = "grok"', 'ClaudeWoWDB.chats[1].plugin = "ask"']) {
    const vm = newVM();
    vm.run('ClaudeWoWDB.chats[1].agent = "claude"');
    deliverDenial(vm, ['Bash(git:*)']);
    clickNeed(vm);
    assert.match(vm.evaluate('STUB.popup.text'), /^Always allow this, for Claude\?/);
    vm.run(change);
    const seq = vm.num('ClaudeWoWDB.lastSeq');
    accept(vm);
    assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, `${change}: nothing is granted`);
    assert.ok(!stripFlags(vm).some(r => /(^|;)allow=/.test(r.flags)), change);
  }
});

test('an agent name with a pipe cannot rewrite the confirm or the roll text', () => {
  const vm = newVM();
  vm.run('ClaudeWoWDB.chats[1].agent = "x|cffff0000y|Hevil|h"');
  deliverDenial(vm, ['Bash(git:*)'], 'x|cffff0000y');
  assert.doesNotMatch(vm.evaluate('ClaudeWoWRollFrame.Details.Text.text'), /\|cffff0000|\|H/);
  clickNeed(vm);
  assert.doesNotMatch(vm.evaluate('STUB.popup.text'), /\|/);
});

test('the details are laid out after the frame is shown, so the first roll has its height', () => {
  const vm = newVM({
    prelude: `do
      local probe = CreateFrame("Frame")
      local mt = getmetatable(probe)
      local base = mt.__index
      mt.__index = function(t, k)
        if k == "GetStringHeight" then
          return function(self)
            local f = self
            while f do if f.shown == false then return 0 end f = f.parent end
            return 28
          end
        end
        return base(t, k)
      end
    end`,
  });
  deliverDenial(vm, ['Bash(git:*)']);
  assert.equal(vm.num('ClaudeWoWRollFrame.Details.height'), 28 + 12);
});

test('a confirm that cannot open puts the roll back and grants nothing', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.popupFails = true');
  clickNeed(vm);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Parked()'), null);
});

const KEYBOARD_STUB = `
do
  local probe = CreateFrame("Frame")
  local mt = getmetatable(probe)
  local base = mt.__index
  mt.__index = function(t, k)
    if k == "EnableKeyboard" then return function(self, on) self.keyboardOn = on and true or false end end
    if k == "LockHighlight" then return function(self) self.highlightLocked = true end end
    if k == "UnlockHighlight" then return function(self) self.highlightLocked = false end end
    return base(t, k)
  end
end
`;

test('Greed is the first, highlighted button, and no key press grants anything', () => {
  const vm = newVM({ prelude: KEYBOARD_STUB });
  deliverDenial(vm, ['Bash(rm:*)']);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.GreedButton.point'), 'TOPLEFT');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.PassButton.rel == ClaudeWoWRollFrame.GreedButton'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.NeedButton.rel == ClaudeWoWRollFrame.GreedButton'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.GreedButton.highlightLocked'), 'true');
  assert.notEqual(vm.evaluate('ClaudeWoWRollFrame.keyboardOn'), 'true', 'the roll frame never takes the keyboard');
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  for (const key of ['ENTER', 'SPACE', 'ESCAPE', '1', 'W']) {
    vm.run(`for _, f in ipairs(STUB.frames) do
      local cur = f
      while cur and cur ~= ClaudeWoWRollFrame do cur = cur.parent end
      if cur then
        for _, name in ipairs({ "OnKeyDown", "OnKeyUp", "OnChar" }) do
          if f.scripts[name] then f.scripts[name](f, "${key}") end
        end
      end
    end`);
  }
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, 'no key sends anything');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'true', 'the roll still waits for a click');
  assert.ok(!stripFlags(vm).some(r => /(^|;)(once|allow|dirs)=/.test(r.flags)));
  vm.run('ClaudeWoWRollFrame.GreedButton.scripts.OnClick(ClaudeWoWRollFrame.GreedButton)');
  assert.ok(
    stripFlags(vm).some(r => r.flags.includes('once=')),
    'a click on Greed allows once',
  );
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.GreedButton.highlightLocked'), 'false');
});

test('the roll frame shows the rules, the command the bridge quoted, and the scope in words', () => {
  const vm = newVM();
  const note = '[bridge] Claude needed 1 action that is not allowed yet:\\n  Bash: git push origin main\\nAllow it from this chat to let it continue.';
  deliverDenial(vm, ['Bash(git:*)'], 'claude', 1, `text = "ok\\n\\n${note}"`);
  const details = vm.evaluate('ClaudeWoWRollFrame.Details.Text.text');
  assert.match(details, /Bash\(git:\*\)/);
  assert.match(details, /Bash: git push origin main/);
  assert.match(details, /Greed: for this retry only\. Need: always, for Claude\./);
  assert.doesNotMatch(details, /config\.json/);
  vm.run('ClaudeWoWRollFrame.IconFrame.scripts.OnEnter(ClaudeWoWRollFrame.IconFrame)');
  assert.ok(vm.evaluate('table.concat(GameTooltip.lines, "\\n")').includes('Bash: git push origin main'));
  assert.equal(vm.evaluate('ClaudeWoW.DenialDetails(ClaudeWoWDB.chats[1].id)[1]'), 'Bash: git push origin main');
  const long = 'x'.repeat(200);
  vm.run(`${lastHistory}.text = "Grok was not allowed to: ${long}"`);
  assert.equal(vm.evaluate('ClaudeWoW.DenialDetails(ClaudeWoWDB.chats[1].id)[1]'), long.slice(0, 160));
});

test('a live chat offers Greed and Pass only, and Need there is a once-only allow with no confirm', () => {
  const vm = newVM();
  vm.run('ClaudeWoWDB.chats[1].liveTarget = "abc123"');
  const { chatId, id } = deliverDenial(vm, ['Bash(git:*)']);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.NeedButton.shown'), 'false');
  assert.match(vm.evaluate('ClaudeWoWRollFrame.Details.Text.text'), /Greed: for this retry only\. Nothing is saved\./);
  assert.doesNotMatch(vm.evaluate('ClaudeWoWRollFrame.Details.Text.text'), /always/);
  vm.run('ClaudeWoWRoll.CloseAll(); STUB.popup = nil');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:need|h[Need]|h")`);
  assert.equal(vm.evaluate('STUB.popup'), null, 'no confirm');
  const rec = stripFlags(vm).find(r => r.flags.includes('once='));
  assert.ok(rec, 'a once-only allow');
  assert.ok(!stripFlags(vm).some(r => /(^|;)allow=/.test(r.flags)));
});

test('the roll frame sits on the group loot frames when the game has them, else at its own spot', () => {
  const vm = newVM({
    prelude:
      'GroupLootContainer = CreateFrame("Frame", "GroupLootContainer", UIParent); GroupLootContainer:SetSize(200, 40); GroupLootContainer:SetPoint("BOTTOM", UIParent, "BOTTOM", 0, 150)',
  });
  deliverDenial(vm, ['Bash(git:*)']);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.point'), 'BOTTOM');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.rel == GroupLootContainer'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.relPoint'), 'TOP');
  const plain = newVM();
  deliverDenial(plain, ['Bash(git:*)']);
  assert.equal(plain.evaluate('ClaudeWoWRollFrame.point'), 'BOTTOM');
  assert.equal(plain.evaluate('ClaudeWoWRollFrame.rel == UIParent'), 'true');
  assert.equal(plain.num('ClaudeWoWRollFrame.y'), 240);

  for (const prelude of [
    'GroupLootContainer = CreateFrame("Frame", "GroupLootContainer", UIParent)',
    'GroupLootContainer = CreateFrame("Frame", "GroupLootContainer", UIParent); GroupLootContainer:SetPoint("BOTTOM", UIParent, "BOTTOM", 0, 150); GroupLootContainer:Hide()',
  ]) {
    const idle = newVM({ prelude });
    deliverDenial(idle, ['Bash(git:*)']);
    assert.equal(idle.evaluate('ClaudeWoWRollFrame.rel == UIParent'), 'true', `${prelude}: an unplaced or hidden container is not used`);
    assert.equal(idle.num('ClaudeWoWRollFrame.y'), 240);
  }

  const later = newVM({ prelude: 'GroupLootContainer = CreateFrame("Frame", "GroupLootContainer", UIParent)' });
  deliverDenial(later, ['Bash(git:*)']);
  assert.equal(later.evaluate('ClaudeWoWRollFrame.rel == UIParent'), 'true');
  later.run('ClaudeWoWRollFrame.PassButton.scripts.OnClick(ClaudeWoWRollFrame.PassButton)');
  later.run('GroupLootContainer:SetSize(200, 40); GroupLootContainer:SetPoint("BOTTOM", UIParent, "BOTTOM", 0, 150)');
  deliverDenial(later, ['Bash(git:*)']);
  assert.equal(later.evaluate('ClaudeWoWRollFrame.rel == GroupLootContainer'), 'true', 'each roll is placed again');
});

test('a queued roll whose confirm is already open from a link stays parked, so its timer never runs', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('ClaudeWoW.NewChat("second")');
  const second = deliverDenial(vm, ['WebFetch'], 'grok', 2);
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1);
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${second.chatId}:${second.id}:need|h[Need]|h")`);
  assert.equal(vm.evaluate('STUB.popup.data.chatId'), second.chatId);
  vm.run('ClaudeWoWRollFrame.PassButton.scripts.OnClick(ClaudeWoWRollFrame.PassButton)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.shown'), 'false', 'the second roll does not show under its own confirm');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Parked().chatId'), second.chatId);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.now = STUB.now + 120; ClaudeWoWRoll.Update()');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, 'no timeout Pass');
  accept(vm);
  assert.ok(stripFlags(vm).some(r => r.flags.includes('allow=WebFetch')));
  assert.equal(vm.evaluate('ClaudeWoWRoll.Parked()'), null);
});
