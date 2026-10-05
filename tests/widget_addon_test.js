'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');

const STUB_EXTRAS = `
function Methods.UnregisterAllEvents(self) self.events = {} end
function Methods.SetAllPoints(self) end
local newTicker = C_Timer.NewTicker
C_Timer.NewTicker = function(delay, fn)
  local handle = newTicker(delay, fn)
  handle.Cancel = function(self) self.cancelled = true end
  STUB.lastTicker = handle
  return handle
end
function Methods.SetFontObject(self, font) self.font = font end
function securecall(fn, ...) if type(fn) == "string" then fn = _G[fn] end return fn(...) end
function RunScript(code) assert((loadstring or load)(code))() end
function AbandonSkill(index) ABANDONED_SKILL = index end
DEFAULT_CHAT_FRAME = CreateFrame("Frame", "ChatFrame1", UIParent)
DEFAULT_CHAT_FRAME.editBox = CreateFrame("EditBox", "ChatFrame1EditBox", DEFAULT_CHAT_FRAME)
DEFAULT_CHAT_FRAME.editBox:SetScript("OnEnterPressed", function(self) CHAT_LINE_SENT = self:GetText() end)
C_Fake = { GetThing = function() return 7 end, DropThing = function() FAKE_DROPPED = true end }
C_UnitAuras = { GetAuraDataByIndex = function(unit, index) if unit == "player" and index == 1 then return { name = "Mark", applications = 2 } end end }
RAID_CLASS_COLORS = { HUNTER = { r = 0.67, g = 0.83, b = 0.45, colorStr = "ffabd473" } }
GameFontNormal = CreateFrame("Font", "GameFontNormal")
GameFontNormal.GetObjectType = function() return "Font" end
function GameTooltip.SetOwner(self, owner, anchor) self.owner, self.anchor = owner, anchor end
function GameTooltip.AddLine(self, line) self.lines = self.lines or {}; table.insert(self.lines, line) end
`;

function newVM(savedVariables = '') {
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
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8') + STUB_EXTRAS);
  if (savedVariables) run(savedVariables);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Map.lua', 'Widgets.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate };
}

const TARGET_METER = [
  'local ui = ...',
  'ui.db.runs = (ui.db.runs or 0) + 1',
  'local f = CreateFrame("Frame")',
  'f:RegisterEvent("PLAYER_TARGET_CHANGED")',
  'local text = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")',
  'f:SetScript("OnEvent", function() if WIDGET_TEST_BOOM then error("boom") end text:SetText("level " .. UnitLevel("player")) end)',
  'C_Timer.NewTicker(1, function() end)',
].join('\n');

function widgetSet(widgets, version = 1, epoch = 'e1') {
  const set = P.newWidgetSet(epoch);
  P.applyWidgetCommands(set, widgets.map(([name, source]) => ({ op: 'set', name, title: name + ' title', source })));
  set.version = version;
  return P.luaTable('ClaudeWoW_SlotData', [], { now: 1, widgets: set }) + '\nClaudeWoWWidgets.Sync(ClaudeWoW_SlotData.widgets)';
}

const meterFrame = `(function() for _, f in ipairs(STUB.frames) do if f.events.PLAYER_TARGET_CHANGED and f.scripts.OnEvent then return f end end end)()`;
const lastSystemNote = '(function() local h = ClaudeWoWDB.chats[1].history; for i = #h, 1, -1 do if h[i].role == "system" then return h[i].text end end end)()';

test('a widget from the slot data runs live inside its container, with saved data', () => {
  const vm = newVM();
  vm.run(widgetSet([['meter', TARGET_METER]]));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'running');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.meter.runs'), '1');
  assert.equal(vm.evaluate(`${meterFrame}.parent.parent == UIParent`), 'true');
  vm.run('STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  assert.equal(vm.evaluate(`${meterFrame}.children[1].text`), 'level 23');
  assert.match(vm.evaluate(lastSystemNote), /meter is live/);
  vm.run(widgetSet([['meter', TARGET_METER]]));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.meter.runs'), '1');
});

test('a runtime error stops the widget and is reported in the chat window', () => {
  const vm = newVM();
  vm.run(widgetSet([['meter', TARGET_METER]]));
  vm.run('WIDGET_TEST_BOOM = true; STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'failed');
  assert.match(vm.evaluate(lastSystemNote), /meter failed and was stopped: .*boom/);
  assert.equal(vm.evaluate('STUB.lastTicker.cancelled'), 'true');
  assert.equal(vm.evaluate(`${meterFrame}`), null);
  vm.run('WIDGET_TEST_BOOM = false; SlashCmdList.CLAUDE("config ui run meter")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'running');
});

test('compile errors and blocked calls fail cleanly', () => {
  const vm = newVM();
  vm.run(widgetSet([
    ['broken', 'local ui = ...\nif then end'],
    ['sneaky', 'local ui = ...\nlocal name = "Cast" .. "Spell" .. "ByName"\n_G[name]("Fireball")'],
    ['secure', 'local ui = ...\nlocal kind = "Sec" .. "ure"\nCreateFrame("Button", nil, nil, kind .. "ActionButtonTemplate")'],
    ['nosy', 'local ui = ...\nlocal key = "Clau" .. "deWoWDB"\nassert(_G[key] == nil, "leak")\nassert(getmetatable(_G) == false)'],
    ['logger', 'local ui = ...\nlocal f = CreateFrame("Frame")\nf:RegisterEvent("COMBAT" .. "_LOG_EVENT_UNFILTERED")'],
    ['pinger', 'local ui = ...\nlocal f = CreateFrame("Frame")\nf:RegisterUnitEvent("UNIT_PING" .. "_PIN_ADDED", "player")'],
  ]));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("broken")'), 'failed');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("sneaky")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("sneaky"))'), /CastSpellByName is not allowed/);
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("secure"))'), /secure templates are not allowed/);
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("nosy")'), 'running');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("logger"))'), /COMBAT_LOG_EVENT_UNFILTERED is not allowed in a widget/);
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("pinger"))'), /UNIT_PING_PIN_ADDED is not allowed in a widget/);
  assert.equal(vm.evaluate('#STUB.actionBlocked'), '0', 'the refused registration never reached the client');
});

test('/claude config ui remove keeps a widget off until the agent sends a new version', () => {
  const vm = newVM();
  vm.run(widgetSet([['meter', TARGET_METER]]));
  vm.run('SlashCmdList.CLAUDE("config ui remove meter")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'removed');
  assert.equal(vm.evaluate('STUB.lastTicker.cancelled'), 'true');
  vm.run(widgetSet([['meter', TARGET_METER]], 2));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'removed');
  vm.run(widgetSet([['meter', TARGET_METER + '\nlocal changed = true']], 3));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'running');
  vm.run(widgetSet([], 4));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), null);
  assert.match(vm.evaluate(lastSystemNote), /meter was removed by the agent/);
});

test('/claude config ui lists widgets, and free text starting with "ui" is still a message', () => {
  const vm = newVM();
  vm.run(widgetSet([['meter', TARGET_METER]]));
  vm.run('STUB.prints = {}; SlashCmdList.CLAUDE("config ui")');
  assert.match(vm.evaluate('table.concat(STUB.prints, "\\n")'), /meter {2}meter title {2}\(running, \d+ bytes\)/);
  vm.run('STUB.prints = {}; ClaudeWoW.Send = function(text) SENT_TEXT = text end; SlashCmdList.CLAUDE("ui for my bags would be nice")');
  assert.doesNotMatch(vm.evaluate('table.concat(STUB.prints, "\\n")'), /\[Claude WoW ui\]/);
  assert.equal(vm.evaluate('SENT_TEXT'), 'ui for my bags would be nice');
});

test('saved widgets start again at login without the bridge', () => {
  const clock = 'local ui = ...\nui.db.started = true';
  const saved = `ClaudeWoWWidgetDB = { removed = { meter = "${P.widgetRevision(TARGET_METER)}" }, data = {}, set = { epoch = "e1", version = 2, items = {
    { name = "meter", title = "meter title", rev = "${P.widgetRevision(TARGET_METER)}", source = ${P.luaStr(TARGET_METER)} },
    { name = "clock", title = "clock title", rev = "${P.widgetRevision(clock)}", source = ${P.luaStr(clock)} } } } }`;
  const vm = newVM(saved);
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("clock")'), 'running');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.clock.started'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'removed');
});

test('widgets in Inbox.lua reach the widget module on the reload path', () => {
  const set = P.newWidgetSet('e9');
  P.applyWidgetCommands(set, [{ op: 'set', name: 'clock', source: 'local ui = ...\nui.db.started = true' }]);
  const inbox = P.luaTable('ClaudeWoW_Inbox', [], { now: 1, widgets: set });
  const vm = newVM();
  vm.run(inbox + '\nSTUB.FireEvent("PLAYER_LOGIN")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("clock")'), 'running');
});

function savedWidgets(widgets) {
  const items = widgets.map(([name, source]) => `{ name = "${name}", title = "${name}", rev = "${P.widgetRevision(source)}", source = ${P.luaStr(source)} }`);
  return `ClaudeWoWWidgetDB = { removed = {}, data = {}, set = { epoch = "e1", version = 1, items = { ${items.join(', ')} } } }`;
}

test('a saved widget cannot reach code outside the sandbox', () => {
  const vm = newVM(savedWidgets([
    ['securecall', 'local ui = ...\nsecurecall("Run" .. "Script", "WIDGET_ESCAPED = true")'],
    ['indirect', 'local ui = ...\nlocal name = "secure" .. "call"\n_G[name]("Run" .. "Script", "WIDGET_ESCAPED = true")'],
    ['editbox', 'local ui = ...\nlocal eb = DEFAULT_CHAT_FRAME.editBox\neb:SetText("/run WIDGET_ESCAPED = true")\neb:GetScript("OnEnterPressed")(eb)'],
    ['unlisted', 'local ui = ...\nlocal abandon = _G["Abandon" .. "Skill"]\nassert(abandon == nil, "AbandonSkill leaked")\nabandon(1)'],
    ['namespace', 'local ui = ...\nassert(C_Fake.GetThing() == 7)\nC_Fake["Drop" .. "Thing"]()'],
    ['climber', [
      'local ui = ...',
      'local f = CreateFrame("Frame")',
      'assert(f:GetParent() == ui.frame, "own parent")',
      'assert(ui.frame:GetParent() == nil, "climbed to UIParent")',
      'assert(select("#", UIParent:GetChildren()) >= 1)',
      'for _, child in ipairs({ UIParent:GetChildren() }) do assert(child:GetName() ~= "ChatFrame1", "reached the chat frame") end',
      'assert(GameTooltip.GetParent == nil, "tooltip exposes more than the display methods")',
      'assert(getmetatable("") == nil, "string metatable leaked")',
      'f:RegisterEvent("PLAYER_TARGET_CHANGED")',
      'f:SetScript("OnEvent", function(self) ui.db.climbed = tostring(self:GetParent():GetParent()) ui.db.self = tostring(self == f) end)',
    ].join('\n')],
  ]));
  for (const name of ['securecall', 'indirect']) {
    assert.equal(vm.evaluate(`ClaudeWoWWidgets.Status("${name}")`), 'failed', name);
    assert.match(vm.evaluate(`select(2, ClaudeWoWWidgets.Status("${name}"))`), /securecall is not allowed in a widget/);
  }
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("editbox")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("editbox"))'), /DEFAULT_CHAT_FRAME/);
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("unlisted")'), 'failed');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("namespace")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("namespace"))'), /C_Fake.DropThing is not allowed in a widget/);
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("climber")'), 'running', vm.evaluate('select(2, ClaudeWoWWidgets.Status("climber"))'));
  vm.run('STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.climber.climbed'), 'nil');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.climber.self'), 'true');
  assert.equal(vm.evaluate('WIDGET_ESCAPED'), null);
  assert.equal(vm.evaluate('CHAT_LINE_SENT'), null);
  assert.equal(vm.evaluate('ABANDONED_SKILL'), null);
  assert.equal(vm.evaluate('FAKE_DROPPED'), null);
});

test('a widget gets the display APIs the prompt promises', () => {
  const source = [
    'local ui = ...',
    'local button = CreateFrame("Button", "SendChatMessageButton", UIParent, "UIPanelButtonTemplate")',
    'button:SetPoint("CENTER", UIParent, "CENTER", 0, -120)',
    'local text = button:CreateFontString(nil, "OVERLAY")',
    'text:SetFontObject(GameFontNormal)',
    'local aura = C_UnitAuras.GetAuraDataByIndex("player", 1)',
    'local color = RAID_CLASS_COLORS[select(2, UnitClass("player"))]',
    'text:SetText(string.format("%s x%d %s %d", aura.name, aura.applications, RAID_CLASS_COLORS.HUNTER.colorStr, math.floor(UnitLevel("player") / 2)))',
    'color.colorStr = "changed"',
    'button:SetScript("OnEnter", function(self) GameTooltip:SetOwner(self, "ANCHOR_TOP") GameTooltip:AddLine(text:GetText()) GameTooltip:Show() end)',
    'local ticks = 0',
    'C_Timer.NewTicker(1, function(handle) ticks = ticks + 1 if ticks >= 2 then handle:Cancel() end ui.db.ticks = ticks end)',
  ].join('\n');
  const vm = newVM(savedWidgets([['panel', source]]));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("panel")'), 'running', vm.evaluate('select(2, ClaudeWoWWidgets.Status("panel"))'));
  const button = '(function() for i = #STUB.frames, 1, -1 do local f = STUB.frames[i] if f.template == "UIPanelButtonTemplate" then return f end end end)()';
  assert.equal(vm.evaluate(`#${button}.children`), '1');
  assert.equal(vm.evaluate(`${button}.name`), null, 'a widget frame never takes a global name');
  assert.equal(vm.evaluate('SendChatMessageButton'), null);
  assert.equal(vm.evaluate(`${button}.children[1].text`), 'Mark x2 ffabd473 11');
  assert.equal(vm.evaluate(`${button}.children[1].font == GameFontNormal`), 'true');
  assert.equal(vm.evaluate(`${button}.rel == ${button}.parent`), 'true');
  assert.equal(vm.evaluate('RAID_CLASS_COLORS.HUNTER.colorStr'), 'ffabd473', 'the widget changed only its own copy');
  vm.run(`local b = ${button}; b.scripts.OnEnter(b)`);
  assert.equal(vm.evaluate(`GameTooltip.owner == ${button}`), 'true');
  assert.equal(vm.evaluate('GameTooltip.lines[1]'), 'Mark x2 ffabd473 11');
  vm.run('STUB.Tick(); STUB.Tick(); STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.panel.ticks'), '3');
  assert.equal(vm.evaluate('STUB.lastTicker.cancelled'), 'true');
});

test('templates outside the display list are refused', () => {
  const vm = newVM(savedWidgets([['chatbox', 'local ui = ...\nCreateFrame("EditBox", nil, nil, "ChatFrameEditBoxTemplate")']]));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("chatbox")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("chatbox"))'), /ChatFrameEditBoxTemplate is not an allowed widget template/);
});

test('a removed widget stops the event handlers on its container, and a rerun does not stack them', () => {
  const counter = [
    'local ui = ...',
    'ui.frame:RegisterEvent("PLAYER_TARGET_CHANGED")',
    'ui.frame:SetScript("OnEvent", function(self) ui.db.count = (ui.db.count or 0) + 1 ui.db.self = tostring(self == ui.frame) end)',
    'ui.frame:HookScript("OnEvent", function() ui.db.hooks = (ui.db.hooks or 0) + 1 end)',
  ].join('\n');
  const vm = newVM();
  const listeners = '(function() local n = 0 for _, f in ipairs(STUB.frames) do if f.events.PLAYER_TARGET_CHANGED then n = n + 1 end end return n end)()';
  const before = Number(vm.evaluate(listeners));
  vm.run(widgetSet([['counter', counter], ['sneak', 'local ui = ...\nui.frame:RegisterEvent("COMBAT" .. "_LOG_EVENT_UNFILTERED")']]));
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("sneak"))'), /COMBAT_LOG_EVENT_UNFILTERED is not allowed in a widget/);
  assert.equal(vm.evaluate('#STUB.actionBlocked'), '0');
  vm.run('STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.counter.count'), '1');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.counter.hooks'), '1');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.counter.self'), 'true');
  vm.run('SlashCmdList.CLAUDE("config ui remove counter")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("counter")'), 'removed');
  assert.equal(Number(vm.evaluate(listeners)), before, 'the container no longer listens');
  vm.run('STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.counter.count'), '1');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.counter.hooks'), '1');
  vm.run('SlashCmdList.CLAUDE("config ui run counter"); SlashCmdList.CLAUDE("config ui run counter")');
  assert.equal(Number(vm.evaluate(listeners)), before + 1);
  vm.run('STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.counter.count'), '2');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.counter.hooks'), '2');
});
