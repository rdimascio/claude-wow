'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const COMBAT_LINE = 'A permission request is waiting until combat ends.';
const LOOT_LINE = 'A permission request is waiting until the loot roll closes.';
const NOT_NOW_LINE = 'Not allowed during combat or a loot roll. Click it again afterwards.';
const TOO_SOON_LINE = 'Click again in a moment.';

const PRELUDE = `
function StaticPopup_Show(which, a, b, data)
  local d = { which = which, text = a, data = data, shown = true }
  STUB.popup = d
  return d
end
for i = 1, 4 do
  local f = CreateFrame("Frame", "GroupLootFrame" .. i, UIParent)
  f:Hide()
end
GroupLootContainer = CreateFrame("Frame", "GroupLootContainer", UIParent)
BonusRollFrame = CreateFrame("Frame", "BonusRollFrame", UIParent)
BonusRollFrame:Hide()
C_Timer.NewTicker = function(delay, fn)
  table.insert(STUB.tickers, fn)
  return { Cancel = function()
    for i = #STUB.tickers, 1, -1 do
      if STUB.tickers[i] == fn then table.remove(STUB.tickers, i) end
    end
  end }
end
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
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = expr => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(PRELUDE);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'LootRoll.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.told = {}; local print0 = ClaudeWoW.Print; ClaudeWoW.Print = function(m) table.insert(STUB.told, m); return print0(m) end');
  run(
    'STUB.said = {}; local say0 = ClaudeWoW.SayAboutDenial; ClaudeWoW.SayAboutDenial = function(chatId, text) table.insert(STUB.said, { chat = chatId, text = text }); return say0(chatId, text) end',
  );
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.RunTimers()');
  run('STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} } end');
  run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(evaluate('ClaudeWoW.IsConnected()'), 'true');
  return { run, evaluate, num };
}

function deliverDenial(vm, rules, chatIndex = 1) {
  vm.run('ClaudeWoW.Send("clean the build folder")');
  const chatId = vm.evaluate(`ClaudeWoWDB.chats[${chatIndex}].id`);
  const id = vm.num(`ClaudeWoWDB.chats[${chatIndex}].pendingId`);
  const luaRules = rules.map(r => JSON.stringify(r)).join(', ');
  vm.run(
    `STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "I need permission", agent = "claude", denied = { ${luaRules} } } } } end`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate(`ClaudeWoWDB.chats[${chatIndex}].pendingId`), null);
  return { chatId, id };
}

const shown = vm => vm.evaluate('ClaudeWoWRollFrame ~= nil and ClaudeWoWRollFrame.shown') === 'true';
const told = (vm, line) => {
  vm.run(`STUB.found = 0; for _, m in ipairs(STUB.told) do if m == ${JSON.stringify(line)} then STUB.found = STUB.found + 1 end end`);
  return vm.num('STUB.found');
};
const wait = (vm, seconds) => vm.run(`STUB.now = STUB.now + ${seconds}; STUB.Tick(); STUB.RunFrames(${seconds})`);
const click = (vm, name) => vm.run(`ClaudeWoWRollFrame.${name}.scripts.OnClick(ClaudeWoWRollFrame.${name})`);
const arm = vm => vm.run('STUB.now = STUB.now + 0.5; ClaudeWoWRoll.Update()');
const grantedOnce = vm => vm.evaluate('ClaudeWoWDB.outbox and ClaudeWoWDB.outbox.allowOnce') !== null;
const timeLeft = vm => vm.num('ClaudeWoWRoll.Current().expiresAt - GetTime()');
const POPUP = 'StaticPopupDialogs.CLAUDEWOW_ALLOW_ALWAYS';
const cancel = vm => vm.run(`local d = STUB.popup; ${POPUP}.OnCancel(d, d.data, "clicked"); d.shown = false; ${POPUP}.OnHide(d)`);
const accept = vm => vm.run(`local d = STUB.popup; ${POPUP}.OnAccept(d, d.data); d.shown = false; ${POPUP}.OnHide(d)`);

test('R.Blocked: combat or any of GroupLootFrame1..4 shown; the container and bonus roll frames alone never block', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('ClaudeWoWRoll.Blocked()'), null);
  vm.run('STUB.combat = true');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Blocked()'), 'combat');
  vm.run('STUB.combat = false');
  for (let i = 1; i <= 4; i++) {
    vm.run(`GroupLootFrame${i}:Show()`);
    assert.equal(vm.evaluate('ClaudeWoWRoll.Blocked()'), 'loot', `GroupLootFrame${i}`);
    vm.run(`GroupLootFrame${i}:Hide()`);
  }
  vm.run('GroupLootContainer:Show(); BonusRollFrame:Show(); NUM_GROUP_LOOT_FRAMES = 0');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Blocked()'), null);
  vm.run('GroupLootFrame4:Show()');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Blocked()'), 'loot', 'NUM_GROUP_LOOT_FRAMES is not read');
});

test('a denial that arrives in combat waits, says so once, and shows with a full timer 1 s after combat ends', () => {
  const vm = newVM();
  vm.run('STUB.combat = true');
  deliverDenial(vm, ['Bash(rm:*)']);
  assert.equal(shown(vm), false);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Held()'), 'true');
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1);
  assert.equal(told(vm, COMBAT_LINE), 1);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  wait(vm, 120);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, 'no timer runs while it waits');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), 'I need permission');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(shown(vm), false, 'not at the moment combat ends');
  wait(vm, 0.5);
  assert.equal(shown(vm), false, 'not 0.5 s later');
  wait(vm, 0.5);
  assert.equal(shown(vm), true, '1 s later');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Held()'), 'false');
  assert.equal(timeLeft(vm), 60);
  assert.equal(told(vm, COMBAT_LINE), 1);
});

test('the combat release also comes from the event and its 1 s timer, without the ticker', () => {
  const vm = newVM();
  vm.run('STUB.combat = true');
  deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('STUB.combat = false; STUB.timers = {}; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(shown(vm), false);
  vm.run('STUB.now = STUB.now + 1; STUB.RunTimers()');
  assert.equal(shown(vm), true);
});

test('a release re-checks the blocker: combat again inside the 1 s wait restarts the wait', () => {
  const vm = newVM();
  vm.run('STUB.combat = true');
  deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('STUB.combat = false');
  wait(vm, 0.75);
  vm.run('STUB.combat = true');
  wait(vm, 0.5);
  vm.run('STUB.combat = false');
  wait(vm, 0.25);
  assert.equal(shown(vm), false, 'the wait restarted when combat came back');
  wait(vm, 0.5);
  assert.equal(shown(vm), false);
  wait(vm, 0.5);
  assert.equal(shown(vm), true);
  assert.equal(told(vm, COMBAT_LINE), 1, 'one line for the whole hold');
});

test('a group loot roll that opens while the request shows hides it; it comes back with a fresh timer after the roll closes', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  assert.equal(shown(vm), true);
  wait(vm, 30);
  assert.ok(timeLeft(vm) <= 30);
  vm.run('GroupLootFrame2:Show()');
  vm.run('STUB.RunFrames(0.05)');
  assert.equal(shown(vm), false);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current()'), null);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Parked()'), null, 'the hold does not use the confirm slot');
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1);
  assert.equal(told(vm, LOOT_LINE), 1);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  wait(vm, 90);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, 'the hidden timer does not pass it');
  vm.run('GroupLootFrame2:Hide()');
  wait(vm, 0);
  wait(vm, 0.5);
  assert.equal(shown(vm), false);
  wait(vm, 0.5);
  assert.equal(shown(vm), true);
  assert.equal(timeLeft(vm), 60);
});

test('combat and a loot roll overlap: the request waits until both end, with one line', () => {
  const vm = newVM();
  vm.run('STUB.combat = true; GroupLootFrame1:Show()');
  deliverDenial(vm, ['Bash(git:*)']);
  assert.equal(told(vm, COMBAT_LINE), 1);
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  wait(vm, 1);
  wait(vm, 1);
  assert.equal(shown(vm), false, 'the loot roll is still open');
  vm.run('GroupLootFrame1:Hide()');
  wait(vm, 0);
  wait(vm, 1);
  assert.equal(shown(vm), true);
  assert.equal(told(vm, COMBAT_LINE) + told(vm, LOOT_LINE), 1);
});

test('a Need confirm cancelled while blocked puts the request back in the queue, not on screen', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  arm(vm);
  click(vm, 'NeedButton');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_ALLOW_ALWAYS');
  assert.ok(vm.evaluate('ClaudeWoWRoll.Parked()') !== null);
  vm.run('STUB.combat = true');
  cancel(vm);
  assert.equal(shown(vm), false);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Parked()'), null);
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1);
  assert.equal(told(vm, COMBAT_LINE), 1);
  vm.run('STUB.combat = false');
  wait(vm, 0);
  wait(vm, 1);
  assert.equal(shown(vm), true);
  assert.equal(timeLeft(vm), 60);
});

test('a confirm left open when a hold starts: Cancel puts its request at the head of the queue, with no second line', () => {
  const vm = newVM();
  const first = deliverDenial(vm, ['Bash(git:*)']);
  arm(vm);
  click(vm, 'NeedButton');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_ALLOW_ALWAYS');
  vm.run('STUB.combat = true; ClaudeWoW.NewChat("second")');
  deliverDenial(vm, ['WebFetch'], 2);
  vm.run('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id)');
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1);
  cancel(vm);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Held()'), 'true');
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 2);
  assert.equal(told(vm, COMBAT_LINE), 1);
  vm.run('STUB.combat = false');
  wait(vm, 0);
  wait(vm, 1);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().chatId'), first.chatId);
});

test('a confirm for a queued request, cancelled inside the 1 s wait, does not show anything early or repeat the line', () => {
  const vm = newVM();
  const first = deliverDenial(vm, ['Bash(git:*)']);
  vm.run('ClaudeWoW.NewChat("second")');
  const second = deliverDenial(vm, ['WebFetch'], 2);
  arm(vm);
  vm.run(`STUB.popup = nil; STUB.ClickLink("|Haddon:claudewow:roll:${second.chatId}:${second.id}:need|h[Need]|h")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_ALLOW_ALWAYS');
  vm.run('STUB.combat = true; STUB.RunFrames(0.05)');
  assert.equal(shown(vm), false);
  assert.equal(told(vm, COMBAT_LINE), 1);
  vm.run('STUB.combat = false');
  wait(vm, 0);
  wait(vm, 0.5);
  cancel(vm);
  assert.equal(shown(vm), false, 'not inside the 1 s wait');
  assert.equal(told(vm, COMBAT_LINE), 1, 'one line for the whole hold');
  wait(vm, 0.5);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().chatId'), first.chatId);
});

test('a Need confirm accepted in combat grants nothing, says the hold line, and asks again after combat', () => {
  const vm = newVM();
  const first = deliverDenial(vm, ['Bash(git:*)']);
  arm(vm);
  click(vm, 'NeedButton');
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.combat = true');
  accept(vm);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, 'nothing is sent');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox and ClaudeWoWDB.outbox.allow'), null);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Parked()'), null);
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1);
  assert.equal(told(vm, COMBAT_LINE), 1);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].denied[1]'), 'Bash(git:*)', 'the denial stays open');
  vm.run('STUB.combat = false');
  wait(vm, 0);
  wait(vm, 1);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().chatId'), first.chatId);
  arm(vm);
  vm.run('STUB.popup = nil');
  click(vm, 'NeedButton');
  accept(vm);
  assert.ok(vm.evaluate('ClaudeWoWDB.outbox.allow') !== null, 'after combat the confirm grants');
});

test('a Need confirm accepted while a loot roll is open grants nothing', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  arm(vm);
  click(vm, 'NeedButton');
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('GroupLootFrame3:Show()');
  accept(vm);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(told(vm, LOOT_LINE), 1);
});

test('a link Greed 0.2 s after the request shows grants nothing', () => {
  const vm = newVM();
  const { chatId, id } = deliverDenial(vm, ['Bash(git:*)']);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.now = STUB.now + 0.2');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:greed|h[Greed]|h")`);
  vm.run(`STUB.popup = nil; STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:need|h[Need]|h")`);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(grantedOnce(vm), false);
  assert.equal(vm.evaluate('STUB.popup'), null);
  assert.equal(shown(vm), true);
  vm.run('STUB.now = STUB.now + 0.3');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:greed|h[Greed]|h")`);
  assert.equal(grantedOnce(vm), true, 'armed, the link grants');
});

test('a link Greed or Need during a combat hold grants nothing and says the hold line', () => {
  const vm = newVM();
  vm.run('STUB.combat = true');
  const { chatId, id } = deliverDenial(vm, ['Bash(git:*)']);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:greed|h[Greed]|h")`);
  vm.run(`STUB.popup = nil; STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:need|h[Need]|h")`);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(grantedOnce(vm), false);
  assert.equal(vm.evaluate('STUB.popup'), null);
  assert.equal(told(vm, COMBAT_LINE), 3, 'the hold line, then once per refused link');
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1);
  vm.run('STUB.combat = false');
  wait(vm, 0);
  wait(vm, 0.5);
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:greed|h[Greed]|h")`);
  assert.equal(grantedOnce(vm), false, 'not inside the 1 s wait either');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:pass|h[Pass]|h")`);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), 'Passed on: Bash(git:*)', 'Pass still works');
});

test('a link Greed or Need with the roll off, in combat, grants nothing and says it is not allowed now, not that it waits', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("config roll off")');
  const { chatId, id } = deliverDenial(vm, ['Bash(git:*)']);
  vm.run('STUB.now = STUB.now + 1; STUB.combat = true; STUB.popup = nil');
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:greed|h[Greed]|h")`);
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:need|h[Need]|h")`);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(vm.evaluate('STUB.popup'), null, 'no confirm opens');
  assert.equal(told(vm, NOT_NOW_LINE), 2);
  assert.equal(told(vm, COMBAT_LINE), 0, 'nothing is queued, so it never says it waits');
});

const allowButton = vm => {
  vm.run('BTN = nil; for _, f in ipairs(STUB.frames) do if f.template == "UIPanelButtonTemplate" and f.rules and f.shown then BTN = f end end');
  assert.equal(vm.evaluate('BTN ~= nil'), 'true', 'the Allow & retry button is on the reply');
};

test('the transcript Allow & retry button in combat: the confirm cannot grant, and a live chat grants nothing', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("config roll off")');
  deliverDenial(vm, ['Bash(git:*)']);
  allowButton(vm);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.now = STUB.now + 1; STUB.combat = true; STUB.popup = nil; BTN.scripts.OnClick(BTN)');
  assert.equal(vm.evaluate('STUB.popup'), null, 'a confirm that cannot grant never opens');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(told(vm, NOT_NOW_LINE), 1);

  const live = newVM();
  live.run('SlashCmdList.CLAUDE("config roll off"); ClaudeWoWDB.chats[1].liveTarget = "abc123"');
  deliverDenial(live, ['Bash(git:*)']);
  allowButton(live);
  const before = live.num('ClaudeWoWDB.lastSeq');
  live.run('STUB.now = STUB.now + 1; STUB.combat = true; BTN.scripts.OnClick(BTN)');
  assert.equal(live.num('ClaudeWoWDB.lastSeq'), before, 'a live chat sends nothing in combat');
  assert.equal(grantedOnce(live), false);
  assert.equal(told(live, NOT_NOW_LINE), 1);
  live.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED"); STUB.now = STUB.now + 1; BTN.scripts.OnClick(BTN)');
  assert.equal(grantedOnce(live), true, 'out of combat the same click allows once');
});

test('a queued request: its [Greed] link 0.2 s after the reply arrived grants nothing and says click again', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('ClaudeWoW.NewChat("second")');
  const second = deliverDenial(vm, ['WebFetch'], 2);
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  const link = `|Haddon:claudewow:roll:${second.chatId}:${second.id}:greed|h[Greed]|h`;
  vm.run(`STUB.now = STUB.now + 0.2; STUB.ClickLink("${link}")`);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(grantedOnce(vm), false);
  assert.equal(told(vm, TOO_SOON_LINE), 1);
  vm.run(`STUB.now = STUB.now + 0.3; STUB.ClickLink("${link}")`);
  assert.equal(grantedOnce(vm), true, '0.5 s after it arrived the link grants');
});

test('the live chat reply button 0.2 s after the reply arrived grants nothing', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("config roll off"); ClaudeWoWDB.chats[1].liveTarget = "abc123"');
  deliverDenial(vm, ['Bash(git:*)']);
  allowButton(vm);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.now = STUB.now + 0.2; BTN.scripts.OnClick(BTN)');
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(grantedOnce(vm), false);
  assert.equal(told(vm, TOO_SOON_LINE), 1);
  vm.run('STUB.now = STUB.now + 0.3; BTN.scripts.OnClick(BTN)');
  assert.equal(grantedOnce(vm), true);
});

test('the reply button 0.2 s after the reply arrived opens no confirm; 0.5 s after, the confirm opens and grants', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("config roll off")');
  deliverDenial(vm, ['Bash(git:*)']);
  allowButton(vm);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.popup = nil; STUB.now = STUB.now + 0.2; BTN.scripts.OnClick(BTN)');
  assert.equal(vm.evaluate('STUB.popup'), null);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(told(vm, TOO_SOON_LINE), 1);
  vm.run('STUB.now = STUB.now + 0.3; BTN.scripts.OnClick(BTN)');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_ALLOW_ALWAYS');
  accept(vm);
  assert.ok(vm.evaluate('ClaudeWoWDB.outbox.allow') !== null);
});

for (const [label, block, clear] of [
  ['combat ends (the event)', 'STUB.combat = true', 'STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")'],
  ['combat ends (the watch ticker, no event)', 'STUB.combat = true; STUB.Tick()', 'STUB.combat = false'],
  ['a loot frame closes (the watch ticker)', 'GroupLootFrame1:Show(); STUB.Tick()', 'GroupLootFrame1:Hide()'],
  ['a loot roll ends (the event)', 'GroupLootFrame1:Show(); STUB.FireEvent("START_LOOT_ROLL")', 'GroupLootFrame1:Hide(); STUB.FireEvent("CANCEL_LOOT_ROLL")'],
]) {
  test(`a parked Need confirm accepted 0.3 s after ${label} grants nothing; the roll comes back`, () => {
    const vm = newVM();
    const first = deliverDenial(vm, ['Bash(git:*)']);
    arm(vm);
    click(vm, 'NeedButton');
    assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_ALLOW_ALWAYS');
    const seq = vm.num('ClaudeWoWDB.lastSeq');
    vm.run(block);
    vm.run(clear);
    vm.run('STUB.now = STUB.now + 0.3');
    accept(vm);
    assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, 'nothing is sent');
    assert.equal(vm.evaluate('ClaudeWoWDB.outbox and ClaudeWoWDB.outbox.allow'), null);
    assert.equal(told(vm, TOO_SOON_LINE), 1);
    assert.equal(vm.evaluate('ClaudeWoWRoll.Current() and ClaudeWoWRoll.Current().chatId'), first.chatId, 'the roll is offered again');
    vm.run('STUB.now = STUB.now + 1; ClaudeWoWRoll.Update(); STUB.popup = nil');
    click(vm, 'NeedButton');
    accept(vm);
    assert.ok(vm.evaluate('ClaudeWoWDB.outbox.allow') !== null, 'after the wait it grants');
  });
}

test('an armed roll clicked 0.3 s after combat ended says click again and grants nothing', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  arm(vm);
  vm.run('STUB.FireEvent("PLAYER_REGEN_DISABLED"); STUB.FireEvent("PLAYER_REGEN_ENABLED"); STUB.now = STUB.now + 0.3');
  click(vm, 'GreedButton');
  assert.equal(grantedOnce(vm), false);
  assert.equal(told(vm, TOO_SOON_LINE), 1);
  assert.equal(shown(vm), true);
  vm.run('STUB.now = STUB.now + 0.7');
  click(vm, 'GreedButton');
  assert.equal(grantedOnce(vm), true);
});

test('a queued request shown later: its link Greed 0.2 s after the roll shows grants nothing, though the reply is older', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('ClaudeWoW.NewChat("second")');
  const second = deliverDenial(vm, ['WebFetch'], 2);
  arm(vm);
  vm.run('STUB.now = STUB.now + 2');
  click(vm, 'PassButton');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().chatId'), second.chatId);
  vm.run(`STUB.now = STUB.now + 0.2; STUB.ClickLink("|Haddon:claudewow:roll:${second.chatId}:${second.id}:greed|h[Greed]|h")`);
  assert.equal(grantedOnce(vm), false);
  assert.equal(told(vm, TOO_SOON_LINE), 1);
});

test('a confirm opened from a link for a queued request keeps the blocker watched, so Always Allow 0.3 s after a loot frame closes grants nothing', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('ClaudeWoW.NewChat("second")');
  const second = deliverDenial(vm, ['WebFetch'], 2);
  vm.run(`STUB.now = STUB.now + 1; STUB.popup = nil; STUB.ClickLink("|Haddon:claudewow:roll:${second.chatId}:${second.id}:need|h[Need]|h")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_ALLOW_ALWAYS');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Parked()'), null, 'nothing is parked; only the confirm is open');
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.Tick(); GroupLootFrame4:Show(); STUB.Tick(); GroupLootFrame4:Hide(); STUB.now = STUB.now + 0.3');
  accept(vm);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox and ClaudeWoWDB.outbox.allow'), null);
  assert.equal(told(vm, TOO_SOON_LINE), 1);
});

test('a link Greed after the 1 s settle but while the hold has not released yet is still held', () => {
  const vm = newVM();
  vm.run('STUB.combat = true');
  const { chatId, id } = deliverDenial(vm, ['Bash(git:*)']);
  vm.run('STUB.Tick(); STUB.combat = false; STUB.now = STUB.now + 0.9; STUB.Tick(); STUB.now = STUB.now + 0.2');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Held()'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Settling()'), 'false');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:greed|h[Greed]|h")`);
  assert.equal(grantedOnce(vm), false);
  assert.equal(told(vm, COMBAT_LINE), 2, 'the hold line, then once for the refused link');
});

test('the watch ticker runs while a confirm is open and stops when it closes', () => {
  const vm = newVM();
  const base = vm.num('#STUB.tickers');
  deliverDenial(vm, ['Bash(git:*)']);
  arm(vm);
  click(vm, 'NeedButton');
  assert.equal(vm.num('#STUB.tickers'), base + 1);
  cancel(vm);
  vm.run('STUB.Tick()');
  assert.equal(vm.num('#STUB.tickers'), base);
});

test('an armed click right after combat starts, before the next update, grants nothing and holds the request', () => {
  for (const button of ['GreedButton', 'NeedButton']) {
    const vm = newVM();
    deliverDenial(vm, ['Bash(git:*)']);
    arm(vm);
    const seq = vm.num('ClaudeWoWDB.lastSeq');
    vm.run('STUB.combat = true; STUB.popup = nil');
    click(vm, button);
    assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, button);
    assert.equal(grantedOnce(vm), false, button);
    assert.equal(vm.evaluate('STUB.popup'), null, button);
    assert.equal(shown(vm), false, button);
    assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1, button);
    assert.equal(told(vm, COMBAT_LINE), 1, button);
  }
});

test('a link Greed on the shown request right after combat starts grants nothing', () => {
  const vm = newVM();
  const { chatId, id } = deliverDenial(vm, ['Bash(git:*)']);
  arm(vm);
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.combat = true');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${chatId}:${id}:greed|h[Greed]|h")`);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(shown(vm), false);
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1);
  assert.equal(told(vm, COMBAT_LINE), 1);
});

test('the hold line goes through ClaudeWoW.SayAboutDenial for the held chat', () => {
  const vm = newVM();
  vm.run('STUB.combat = true');
  const { chatId } = deliverDenial(vm, ['Bash(git:*)']);
  assert.equal(vm.num('#STUB.said'), 1);
  assert.equal(vm.evaluate('STUB.said[1].chat'), chatId);
  assert.equal(vm.evaluate('STUB.said[1].text'), COMBAT_LINE);
});

test('a GroupLootFrame that is shown but not visible (its parent hidden) does not block', () => {
  const vm = newVM();
  vm.run('GroupLootFrame2:Show(); GroupLootFrame2.IsVisible = function() return false end');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Blocked()'), null);
  vm.run('GroupLootFrame2.IsVisible = function() return true end');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Blocked()'), 'loot');
});

test('the hold ticker is cancelled on release and on CloseAll', () => {
  const vm = newVM();
  const base = vm.num('#STUB.tickers');
  vm.run('STUB.combat = true');
  deliverDenial(vm, ['Bash(git:*)']);
  assert.equal(vm.num('#STUB.tickers'), base + 1);
  vm.run('STUB.combat = false');
  wait(vm, 0);
  wait(vm, 1);
  assert.equal(shown(vm), true);
  assert.equal(vm.num('#STUB.tickers'), base, 'released');
  vm.run('STUB.combat = true; STUB.RunFrames(0.05)');
  assert.equal(vm.num('#STUB.tickers'), base + 1);
  vm.run('ClaudeWoWRoll.CloseAll()');
  assert.equal(vm.num('#STUB.tickers'), base, 'closed');
});

test('staggered requests keep their order through holds, and each shows with its own fresh timer', () => {
  const vm = newVM();
  vm.run('STUB.combat = true');
  const first = deliverDenial(vm, ['Bash(rm:*)']);
  vm.run('ClaudeWoW.NewChat("second")');
  const second = deliverDenial(vm, ['WebFetch'], 2);
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 2);
  assert.equal(told(vm, COMBAT_LINE), 1);
  vm.run('STUB.combat = false');
  wait(vm, 0);
  wait(vm, 1);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().chatId'), first.chatId);
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 1);
  vm.run('STUB.combat = true');
  vm.run('STUB.RunFrames(0.05)');
  assert.equal(shown(vm), false);
  assert.equal(vm.num('ClaudeWoWRoll.Waiting()'), 2);
  assert.equal(told(vm, COMBAT_LINE), 2, 'a new hold says it again');
  vm.run('STUB.combat = false');
  wait(vm, 0);
  wait(vm, 1);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().chatId'), first.chatId, 'the hidden one comes back first');
  arm(vm);
  click(vm, 'PassButton');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().chatId'), second.chatId);
  assert.equal(timeLeft(vm), 60);
});

test('a click in the first 0.5 s after the request shows grants nothing; the buttons start disabled', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(rm:*)']);
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.Header.text'), 'Azeroth Companion asks');
  for (const name of ['GreedButton', 'NeedButton', 'PassButton']) {
    assert.equal(vm.evaluate(`ClaudeWoWRollFrame.${name}:IsEnabled()`), 'false', name);
  }
  const seq = vm.num('ClaudeWoWDB.lastSeq');
  vm.run('STUB.popup = nil');
  for (const name of ['GreedButton', 'NeedButton', 'PassButton']) click(vm, name);
  vm.run('STUB.now = STUB.now + 0.4');
  for (const name of ['GreedButton', 'NeedButton', 'PassButton']) click(vm, name);
  assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq);
  assert.equal(grantedOnce(vm), false);
  assert.equal(vm.evaluate('STUB.popup'), null);
  assert.equal(shown(vm), true);
  vm.run('STUB.now = STUB.now + 0.1; ClaudeWoWRoll.Update()');
  for (const name of ['GreedButton', 'NeedButton', 'PassButton']) {
    assert.equal(vm.evaluate(`ClaudeWoWRollFrame.${name}:IsEnabled()`), 'true', name);
  }
  click(vm, 'GreedButton');
  assert.equal(grantedOnce(vm), true);
});

for (const [label, change, field, value] of [
  ['agent', 'ClaudeWoWDB.chats[1].agent = "grok"', 'target', 'grok'],
  ['plugin', 'ClaudeWoWDB.chats[1].plugin = "ask"', 'plugin', 'ask'],
]) {
  test(`${label} drift during a hold: Greed rebuilds the request for the new ${label} and grants nothing`, () => {
    const vm = newVM();
    vm.run('ClaudeWoWDB.chats[1].agent = "claude"; ClaudeWoWDB.chats[1].plugin = "claude-code"');
    vm.run('STUB.combat = true');
    deliverDenial(vm, ['Bash(git:*)']);
    vm.run(change);
    vm.run('STUB.combat = false');
    vm.run('STUB.Tick(); STUB.now = STUB.now + 1; STUB.Tick()');
    assert.equal(shown(vm), true);
    assert.equal(vm.evaluate(`ClaudeWoWRoll.Current().${field}`), field === 'target' ? 'claude' : 'claude-code', 'the held offer shows before any update');
    const seq = vm.num('ClaudeWoWDB.lastSeq');
    vm.run('STUB.now = STUB.now + 0.5');
    click(vm, 'GreedButton');
    assert.equal(vm.num('ClaudeWoWDB.lastSeq'), seq, 'nothing is sent');
    assert.equal(grantedOnce(vm), false);
    assert.equal(shown(vm), true, 'the rebuilt request shows');
    assert.equal(vm.evaluate(`ClaudeWoWRoll.Current().${field}`), value);
    assert.equal(timeLeft(vm), 60);
    click(vm, 'GreedButton');
    assert.equal(grantedOnce(vm), false, 'the rebuilt request has its own 0.5 s');
    arm(vm);
    click(vm, 'GreedButton');
    assert.equal(grantedOnce(vm), true);
  });
}

test('drift while the request shows: the frame rebuilds on its next update, and Need on a drifted offer opens no confirm', () => {
  const vm = newVM();
  vm.run('ClaudeWoWDB.chats[1].agent = "claude"');
  deliverDenial(vm, ['Bash(git:*)']);
  arm(vm);
  vm.run('ClaudeWoWDB.chats[1].agent = "grok"; STUB.popup = nil');
  click(vm, 'NeedButton');
  assert.equal(vm.evaluate('STUB.popup'), null);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().target'), 'grok');
  vm.run('ClaudeWoWDB.chats[1].agent = "claude"; ClaudeWoWRoll.Update()');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().target'), 'claude', 'the update rebuilds it too');
});

test('changed rules under the same reply: Greed grants nothing and the request shows the new rules', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  arm(vm);
  vm.run('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].denied = { "Bash(rm:*)" }');
  click(vm, 'GreedButton');
  assert.equal(grantedOnce(vm), false);
  assert.equal(vm.evaluate('ClaudeWoWRoll.Current().rules[1]'), 'Bash(rm:*)');
  assert.equal(vm.evaluate('ClaudeWoWRollFrame.Name.text'), 'Scroll of rm');
});

test('a newer reply under the same chat: Greed on the old request grants nothing', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  arm(vm);
  vm.run('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].id = 999');
  click(vm, 'GreedButton');
  assert.equal(grantedOnce(vm), false);
});

test('a Need timeout still passes, never allows', () => {
  const vm = newVM();
  deliverDenial(vm, ['Bash(git:*)']);
  wait(vm, 61);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), 'Passed on: Bash(git:*) (the roll timed out)');
  assert.equal(grantedOnce(vm), false);
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox and ClaudeWoWDB.outbox.allow'), null);
});

test('turning the roll off ends a hold', () => {
  const vm = newVM();
  vm.run('STUB.combat = true');
  deliverDenial(vm, ['Bash(git:*)']);
  vm.run('ClaudeWoWRoll.CloseAll()');
  assert.equal(vm.evaluate('ClaudeWoWRoll.Held()'), 'false');
  vm.run('STUB.combat = false');
  wait(vm, 1);
  wait(vm, 1);
  assert.equal(shown(vm), false);
});

const P = require('../bridge/protocol');
const PL = require('../bridge/plugins');
const roast = require('../bridge/plugins/roast');

const BRIDGE_JS = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'bridge.js'), 'utf8');
const bridgeAt = (version, protoMin = P.PROTO_MIN, protoMax = P.PROTO_MAX) => ({ version, protoMin, protoMax });

test('E2: every version verdict the player reads says companion app, never bridge', () => {
  const cases = [
    [{ version: '1.0.0', proto: P.PROTO_MIN - 1 }, bridgeAt('2.0.0', P.PROTO_MIN, P.PROTO_MAX), 'update-addon'],
    [{ version: '9.0.0', proto: P.PROTO_MAX + 1 }, bridgeAt('2.0.0', P.PROTO_MIN, P.PROTO_MAX), 'update-bridge'],
    [{ version: '1.0.0', proto: P.PROTO }, bridgeAt('2.0.0'), 'addon-older'],
    [{ version: '3.0.0', proto: P.PROTO }, bridgeAt('2.0.0'), 'bridge-older'],
    [{ version: '2.0.0', proto: P.PROTO }, bridgeAt('2.0.0-dev'), 'differs'],
  ];
  for (const [addon, bridge, verdict] of cases) {
    const v = P.versionVerdict(addon, bridge);
    assert.equal(v.verdict, verdict);
    assert.match(v.text, /companion app/, verdict);
    assert.doesNotMatch(v.text, /\bbridge\b/i, verdict);
  }
});

test('E2: plugin routing errors the player reads say companion app', () => {
  assert.equal(PL.createRegistry().route({ text: 'hi' }).error, 'the companion app has no plugins');
  const reg = PL.createRegistry();
  reg.register({ id: 'ask', label: 'ask', handle: () => {} });
  const r = reg.route({ text: 'hi', plugin: 'nope' });
  assert.equal(r.error, 'Unknown plugin "nope". The companion app knows: ask.');
});

test('E2: run-ending, setup and note texts in bridge.js say companion app, and the old bridge wording is gone', () => {
  const wanted = [
    '`The companion app was stopped while ${agent.name} was still working. Send the message again once it is back.`',
    "`The companion app stopped unexpectedly while ${run.agent || 'the agent'} was working on this message (started ${since} UTC), so its reply is lost. Send it again. The reason is in ${LOG_FILE}.`",
    '`${agent.name} is not installed on the computer that runs the companion app: ${cmd.note}.`',
    "for the companion app's default (${DEFAULT_PLUGIN})",
    "for the companion app's default (${DEFAULT_AGENT})",
    'The companion app knows: ',
    'The companion app keeps trying.',
    'Discord is not set up in the companion app',
    "why: 'the companion app failed'",
    "`\\n\\n[companion app] ${notes.join('\\n\\n[companion app] ')}`",
    "`\\n\\n[companion app] ${m.notes.join('; ')}`",
  ];
  for (const text of wanted) assert.ok(BRIDGE_JS.includes(text), text);
  for (const old of [
    'The bridge was stopped while',
    'The bridge stopped unexpectedly',
    'on the bridge PC',
    "for the bridge's default",
    'This bridge knows',
    'The bridge keeps trying',
    'on this bridge (discord',
    "'the bridge failed'",
    '[bridge] ',
  ]) {
    assert.ok(!BRIDGE_JS.includes(old), old);
  }
});

test('E2: the roast overlay still drops the note, under the new and the old marker', () => {
  const recap = [
    'Death recap: a level 23 Night Elf Hunter just died in Duskwood - Darkshire.',
    'Hits taken in the last 10 s, oldest first:',
    '-0.2s Hogger (level 11): Melee 52, overkill 17 <- killing blow',
    "Damage taken: 52 from 1 source. Killing blow: Hogger's Melee.",
  ].join('\n');
  const line = text => roast.overlayCommand(recap, { status: 'done', text, summary: '' }).roast.text;
  assert.equal(line('Hogger wins again.\n\n[companion app] a note'), 'Hogger wins again.');
  assert.equal(line('[companion app] some map marks were left out.'), undefined);
  assert.equal(line('Hogger wins again.\n\n[bridge] a note'), 'Hogger wins again.');
});

test('E2: the addon copy of the version verdict matches the companion app words', () => {
  const vm = newVM();
  vm.run('STUB.v, STUB.t = ClaudeWoW.Version.Verdict({ version = "0.0.1", protoMin = 1, protoMax = 99 })');
  assert.equal(vm.evaluate('STUB.v'), 'bridge-older');
  assert.match(vm.evaluate('STUB.t'), /^The companion app \(0\.0\.1\) is older than this addon .* update the companion app when you can\.$/);
});
