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
function Methods.CreateAnimationGroup(self, name) local g = Methods.CreateFontString(self, name) g.kind = "AnimationGroup" return g end
function Methods.CreateAnimation(self, kind, name) local a = Methods.CreateFontString(self, name) a.kind = "Animation" return a end
GameFontNormal.GetFont = function() return "Fonts/FRIZQT__.TTF", 12, "" end
function GameTooltip.SetOwner(self, owner, anchor) self.owner, self.anchor = owner, anchor end
C_NamePlate = { GetNamePlates = function()
  local plates = { DEFAULT_CHAT_FRAME.editBox, nested = { chat = DEFAULT_CHAT_FRAME, run = RunScript, count = 2 } }
  plates.nested.back = plates
  plates[DEFAULT_CHAT_FRAME] = "frame key"
  return plates
end }
function UnitSetRole(unit, role) UNIT_ROLE_SET = role end
function UnitPowerMax(unit) return 100 end
function GameTooltip.AddLine(self, line) self.lines = self.lines or {}; table.insert(self.lines, line) end
GameTooltip.parent = UIParent
function Methods.SetScrollChild(self, child) self.scrollChild = child; child.parent = self end
function Methods.GetScrollChild(self) return self.scrollChild end
function Methods.EnableKeyboard(self, v) self.keyboardEnabled = v and true or false end
function Methods.SetPropagateKeyboardInput(self, v) self.propagateKeys = v and true or false end
function Methods.SetAutoFocus(self, v) self.autoFocus = v and true or false end
function GetUnitName(unit) if unit == "player" then return "Testchar" end end
function GetRaidTargetIndex(unit) if unit == "target" then return 8 end end
for _, name in ipairs({ "GameTooltipText", "Tooltip_Med", "GameFontHighlightSmall" }) do
  local font = CreateFrame("Font", name)
  font.GetObjectType = function() return "Font" end
  _G[name] = font
end
`;

function newVM(savedVariables = '') {
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
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8') + STUB_EXTRAS);
  if (savedVariables) run(savedVariables);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Map.lua', 'Widgets.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { L, run, evaluate };
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
  P.applyWidgetCommands(
    set,
    widgets.map(([name, source]) => ({ op: 'set', name, title: name + ' title', source })),
  );
  set.version = version;
  return P.luaTable('ClaudeWoW_SlotData', [], { now: 1, widgets: set }) + '\nClaudeWoWWidgets.Sync(ClaudeWoW_SlotData.widgets)';
}

const meterFrame = `(function() for _, f in ipairs(STUB.frames) do if f.events.PLAYER_TARGET_CHANGED and f.scripts.OnEvent then return f end end end)()`;
const lastSystemNote = '(function() local h = ClaudeWoWDB.chats[1].history; for i = #h, 1, -1 do if h[i].role == "system" then return h[i].text end end end)()';

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
  vm.run(
    widgetSet([
      ['broken', 'local ui = ...\nif then end'],
      ['sneaky', 'local ui = ...\nlocal name = "Cast" .. "Spell" .. "ByName"\n_G[name]("Fireball")'],
      ['secure', 'local ui = ...\nlocal kind = "Sec" .. "ure"\nCreateFrame("Button", nil, nil, kind .. "ActionButtonTemplate")'],
      ['nosy', 'local ui = ...\nlocal key = "Clau" .. "deWoWDB"\nassert(_G[key] == nil, "leak")\nassert(getmetatable(_G) == false)'],
      ['logger', 'local ui = ...\nlocal f = CreateFrame("Frame")\nf:RegisterEvent("COMBAT" .. "_LOG_EVENT_UNFILTERED")'],
      ['pinger', 'local ui = ...\nlocal f = CreateFrame("Frame")\nf:RegisterUnitEvent("UNIT_PING" .. "_PIN_ADDED", "player")'],
    ]),
  );
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

function savedWidgets(widgets) {
  const items = widgets.map(([name, source]) => `{ name = "${name}", title = "${name}", rev = "${P.widgetRevision(source)}", source = ${P.luaStr(source)} }`);
  return `ClaudeWoWWidgetDB = { removed = {}, data = {}, set = { epoch = "e1", version = 1, items = { ${items.join(', ')} } } }`;
}

test('a saved widget cannot reach code outside the sandbox', () => {
  const vm = newVM(
    savedWidgets([
      ['securecall', 'local ui = ...\nsecurecall("Run" .. "Script", "WIDGET_ESCAPED = true")'],
      ['indirect', 'local ui = ...\nlocal name = "secure" .. "call"\n_G[name]("Run" .. "Script", "WIDGET_ESCAPED = true")'],
      ['editbox', 'local ui = ...\nlocal eb = DEFAULT_CHAT_FRAME.editBox\neb:SetText("/run WIDGET_ESCAPED = true")\neb:GetScript("OnEnterPressed")(eb)'],
      ['unlisted', 'local ui = ...\nlocal abandon = _G["Abandon" .. "Skill"]\nabandon(1)'],
      ['namespace', 'local ui = ...\nassert(C_Fake.GetThing() == 7)\nC_Fake["Drop" .. "Thing"]()'],
      [
        'climber',
        [
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
        ].join('\n'),
      ],
    ]),
  );
  for (const name of ['securecall', 'indirect']) {
    assert.equal(vm.evaluate(`ClaudeWoWWidgets.Status("${name}")`), 'failed', name);
    assert.match(vm.evaluate(`select(2, ClaudeWoWWidgets.Status("${name}"))`), /securecall is not allowed in a widget/);
  }
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("editbox")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("editbox"))'), /DEFAULT_CHAT_FRAME/);
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("unlisted")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("unlisted"))'), /attempt to call a nil value/);
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
  vm.run(
    widgetSet([
      ['counter', counter],
      ['sneak', 'local ui = ...\nui.frame:RegisterEvent("COMBAT" .. "_LOG_EVENT_UNFILTERED")'],
    ]),
  );
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

test('a getter or an event payload cannot hand a widget a Blizzard frame inside a table', () => {
  const vm = newVM(
    savedWidgets([
      [
        'plates',
        [
          'local ui = ...',
          'local plates = C_NamePlate.GetNamePlates()',
          'assert(plates.nested.count == 2, "plain data is lost")',
          'assert(plates.nested.back == plates, "the cycle is not kept")',
          'assert(plates.nested.run == nil, "a function leaked")',
          'assert(plates.nested.chat == nil, "the chat frame leaked")',
          'for key in pairs(plates) do assert(type(key) ~= "table", "a frame key leaked") end',
          'local eb = plates[1]',
          'eb:SetText("/run WIDGET_ESCAPED = true")',
          'eb:GetScript("OnEnterPressed")(eb)',
        ].join('\n'),
      ],
      [
        'payload',
        [
          'local ui = ...',
          'local f = CreateFrame("Frame")',
          'f:RegisterEvent("PLAYER_TARGET_CHANGED")',
          'f:SetScript("OnEvent", function(self, event, payload) ui.db.got = tostring(payload.count) ui.db.leaked = tostring(payload.frame ~= nil) end)',
        ].join('\n'),
      ],
      ['role', 'local ui = ...\nassert(UnitPowerMax("player") == 100)\nUnitSetRole("player", "TANK")'],
    ]),
  );
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("plates")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("plates"))'), /attempt to index/);
  vm.run('STUB.FireEvent("PLAYER_TARGET_CHANGED", { frame = DEFAULT_CHAT_FRAME.editBox, count = 3 })');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.payload.got'), '3');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.payload.leaked'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("role")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("role"))'), /UnitSetRole/);
  assert.equal(vm.evaluate('UNIT_ROLE_SET'), null);
  assert.equal(vm.evaluate('WIDGET_ESCAPED'), null);
  assert.equal(vm.evaluate('CHAT_LINE_SENT'), null);
});

test('a widget frame method takes only frames the widget made, so GameTooltip cannot be captured', () => {
  const vm = newVM(
    savedWidgets([
      [
        'tipgrab',
        [
          'local ui = ...',
          'local s = CreateFrame("ScrollFrame")',
          's:SetScrollChild(GameTooltip)',
          'local tip = s:GetScrollChild()',
          'tip:SetParent(ui.frame)',
          'ui.db.grabbed = tostring(tip:GetName())',
        ].join('\n'),
      ],
      ['container', 'local ui = ...\nCreateFrame("ScrollFrame"):SetScrollChild(ui.frame)'],
      ['anchor', 'local ui = ...\nlocal f = CreateFrame("Frame")\nf:SetPoint("BOTTOMRIGHT", GameTooltip)'],
      [
        'scroll',
        [
          'local ui = ...',
          'local s = CreateFrame("ScrollFrame")',
          'local child = CreateFrame("Frame")',
          's:SetScrollChild(child)',
          'assert(s:GetScrollChild() == child, "own scroll child lost")',
          'assert(child:GetParent() == s, "own scroll child not reparented")',
        ].join('\n'),
      ],
      [
        'owner',
        [
          'local ui = ...',
          'local f = CreateFrame("Frame")',
          'f:RegisterEvent("RAID_TARGET_UPDATE")',
          'f:SetScript("OnEvent", function(self) local tip = self:GetChildren() ui.db.limited = tostring(tip ~= nil and tip.GetParent == nil and tip.SetScript == nil and tip.AddLine ~= nil) end)',
        ].join('\n'),
      ],
    ]),
  );
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("tipgrab")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("tipgrab"))'), /SetScrollChild needs a frame this widget made/);
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.tipgrab.grabbed'), null);
  assert.equal(vm.evaluate('GameTooltip.parent == UIParent'), 'true');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("container"))'), /SetScrollChild needs a frame this widget made/);
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("anchor")'), 'running');
  assert.equal(
    vm.evaluate('(function() for _, f in ipairs(STUB.frames) do if rawequal(f.rel, GameTooltip) then return true end end return false end)()'),
    'false',
    'the real GameTooltip reached a widget frame method',
  );
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("scroll")'), 'running', vm.evaluate('select(2, ClaudeWoWWidgets.Status("scroll"))'));
  vm.run('for _, f in ipairs(STUB.frames) do if f.events.RAID_TARGET_UPDATE then f.children = { GameTooltip }; GameTooltip.parent = f end end');
  vm.run('STUB.FireEvent("RAID_TARGET_UPDATE")');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.owner.limited'), 'true', 'a reparented GameTooltip came back as a full widget frame');
});

const UNPRINTABLE = 'error(setmetatable({}, { __tostring = function() error("no text") end }))';

test('an error that cannot be shown as text still stops the widget, and later widgets start at login', () => {
  const zombie = [
    'local ui = ...',
    'local f = CreateFrame("Frame")',
    'f:RegisterEvent("PLAYER_TARGET_CHANGED")',
    `f:SetScript("OnEvent", function() ui.db.n = (ui.db.n or 0) + 1 ${UNPRINTABLE} end)`,
  ].join('\n');
  const vm = newVM(
    savedWidgets([
      ['first', `local ui = ...\n${UNPRINTABLE}`],
      ['second', 'local ui = ...\nui.db.ok = true'],
      ['zombie', zombie],
    ]),
  );
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("first")'), 'failed');
  assert.equal(vm.evaluate('select(2, ClaudeWoWWidgets.Status("first"))'), 'an error that cannot be shown as text');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("second")'), 'running');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.second.ok'), 'true');
  vm.run('STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  vm.run('STUB.FireEvent("PLAYER_TARGET_CHANGED")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("zombie")'), 'failed');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.zombie.n'), '1');
  assert.match(vm.evaluate(lastSystemNote), /zombie failed and was stopped: an error that cannot be shown as text/);
});

test('a widget cannot take the keyboard, or the mouse on its full-screen container', () => {
  const vm = newVM();
  const before = Number(vm.evaluate('#STUB.frames'));
  vm.run(
    widgetSet([
      ['keys', 'local ui = ...\nCreateFrame("Frame"):EnableKeyboard(true)'],
      ['swallow', 'local ui = ...\nCreateFrame("Frame"):SetPropagateKeyboardInput(false)'],
      ['containerkeys', 'local ui = ...\nui.frame:SetPropagateKeyboardInput(true)'],
      ['containermouse', 'local ui = ...\nui.frame:EnableMouse(true)'],
      ['focus', 'local ui = ...\nCreateFrame("EditBox"):SetFocus()'],
      ['autofocus', 'local ui = ...\nCreateFrame("EditBox"):SetAutoFocus(true)'],
      [
        'fine',
        [
          'local ui = ...',
          'local f = CreateFrame("Frame")',
          'f:EnableMouse(true)',
          'f:EnableKeyboard(false)',
          'f:SetPropagateKeyboardInput(true)',
          'ui.frame:EnableMouse(false)',
          'local box = CreateFrame("EditBox", nil, nil, "InputBoxTemplate")',
          'box:SetAutoFocus(false)',
          'ui.db.ok = true',
        ].join('\n'),
      ],
    ]),
  );
  const refused = {
    keys: /EnableKeyboard is not allowed/,
    swallow: /SetPropagateKeyboardInput is not allowed/,
    containerkeys: /SetPropagateKeyboardInput is not allowed/,
    containermouse: /EnableMouse is not allowed on ui.frame/,
    focus: /SetFocus is not allowed/,
    autofocus: /SetAutoFocus is not allowed/,
  };
  for (const [name, why] of Object.entries(refused)) {
    assert.equal(vm.evaluate(`ClaudeWoWWidgets.Status("${name}")`), 'failed', name);
    assert.match(vm.evaluate(`select(2, ClaudeWoWWidgets.Status("${name}"))`), why);
  }
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("fine")'), 'running', vm.evaluate('select(2, ClaudeWoWWidgets.Status("fine"))'));
  const any = cond =>
    vm.evaluate(`(function() for i = ${before + 1}, #STUB.frames do local f = STUB.frames[i] if ${cond} then return true end end return false end)()`);
  assert.equal(any('f.keyboardEnabled == true'), 'false');
  assert.equal(any('f.propagateKeys == false'), 'false');
  assert.equal(any('f.autoFocus == true'), 'false');
  assert.equal(any('f.kind == "EditBox" and f.autoFocus ~= false'), 'false', 'a widget edit box kept auto focus');
  assert.equal(vm.evaluate('STUB.focus'), null);
  assert.equal(any('f.mouseEnabled == true'), 'true', 'a child frame can still take the mouse');
});

test('a widget can read unit names and raid marks and use tooltip and game font objects by name', () => {
  const source = [
    'local ui = ...',
    'local f = CreateFrame("Frame")',
    'local a, b, c = f:CreateFontString(), f:CreateFontString(), f:CreateFontString()',
    'a:SetFontObject(GameTooltipText)',
    'b:SetFontObject(Tooltip_Med)',
    'c:SetFontObject(GameFontHighlightSmall)',
    'a:SetText(GetUnitName("player") .. " " .. GetRaidTargetIndex("target"))',
  ].join('\n');
  const vm = newVM(savedWidgets([['names', source]]));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("names")'), 'running', vm.evaluate('select(2, ClaudeWoWWidgets.Status("names"))'));
  const strings = '(function() for i = #STUB.frames, 1, -1 do local f = STUB.frames[i] if #f.children == 3 then return f.children end end end)()';
  assert.equal(vm.evaluate(`${strings}[1].text`), 'Testchar 8');
  assert.equal(vm.evaluate(`${strings}[1].font == GameTooltipText`), 'true');
  assert.equal(vm.evaluate(`${strings}[2].font == Tooltip_Med`), 'true');
  assert.equal(vm.evaluate(`${strings}[3].font == GameFontHighlightSmall`), 'true');
});

test('a named font string, texture or animation never replaces a global', () => {
  const source = [
    'local ui = ...',
    'local f = CreateFrame("Frame")',
    'f:CreateFontString("ClaudeWoWWidgets", "OVERLAY")',
    'f:CreateTexture("ClaudeWoWDB")',
    'f:CreateFontString("GameTooltip")',
    'local group = f:CreateAnimationGroup("UIParent")',
    'group:CreateAnimation("Alpha", "SlashCmdList")',
    'ui.db.ok = true',
  ].join('\n');
  const vm = newVM(savedWidgets([['names', source]]));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("names")'), 'running', vm.evaluate('select(2, ClaudeWoWWidgets.Status("names"))'));
  assert.equal(vm.evaluate('type(rawget(ClaudeWoWWidgets, "Status"))'), 'function');
  assert.equal(vm.evaluate('type(ClaudeWoWDB.chats)'), 'table');
  assert.equal(vm.evaluate('GameTooltip.kind'), 'Frame');
  assert.equal(vm.evaluate('UIParent.kind'), 'Frame');
  assert.equal(vm.evaluate('type(rawget(SlashCmdList, "CLAUDE"))'), 'function');
  assert.equal(
    vm.evaluate(
      '(function() for _, f in ipairs(STUB.frames) do if #f.children == 4 then for _, c in ipairs(f.children) do if c.name then return c.name end end return "unnamed" end end end)()',
    ),
    'unnamed',
  );
});

test('a widget edit box always lets Escape clear the focus', () => {
  const source = [
    'local ui = ...',
    'local plain = CreateFrame("EditBox")',
    'local trap = CreateFrame("EditBox", nil, nil, "InputBoxTemplate")',
    'trap:SetScript("OnEscapePressed", function() ui.db.escaped = true end)',
    'assert(trap:GetScript("OnEscapePressed") ~= nil)',
  ].join('\n');
  const vm = newVM(savedWidgets([['boxes', source]]));
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("boxes")'), 'running', vm.evaluate('select(2, ClaudeWoWWidgets.Status("boxes"))'));
  for (const which of ['nil', '"InputBoxTemplate"']) {
    const box = `(function() for i = #STUB.frames, 1, -1 do local f = STUB.frames[i] if f.kind == "EditBox" and f.template == ${which} and f.parent ~= DEFAULT_CHAT_FRAME then return f end end end)()`;
    vm.run(`local b = ${box}; STUB.focus = b; b.scripts.OnEscapePressed(b)`);
    assert.equal(vm.evaluate('STUB.focus'), null, which);
  }
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.boxes.escaped'), 'true');
});

test('a widget reads a font object, writes plain fields to its frame and makes only display frame types', () => {
  const source = [
    'local ui = ...',
    'local path, size = GameFontNormal:GetFont()',
    'ui.db.size = size',
    'local b = CreateFrame("Button")',
    'b.tooltipText = "hi"',
    'b.Hide = 1',
    'b.onClick = function() end',
    'ui.frame.Hide = 1',
  ].join('\n');
  const vm = newVM(
    savedWidgets([
      ['font', source],
      ['movie', 'local ui = ...\nCreateFrame("Movie" .. "Frame")'],
    ]),
  );
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("font")'), 'running', vm.evaluate('select(2, ClaudeWoWWidgets.Status("font"))'));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.font.size'), '12');
  const button =
    '(function() for i = #STUB.frames, 1, -1 do if STUB.frames[i].kind == "Button" and STUB.frames[i].tooltipText ~= nil then return STUB.frames[i] end end end)()';
  assert.equal(vm.evaluate(`${button}.tooltipText`), 'hi');
  assert.equal(vm.evaluate(`rawget(${button}, "onClick")`), null);
  assert.equal(vm.evaluate(`rawget(${button}, "Hide")`), null);
  vm.run('SlashCmdList.CLAUDE("config ui remove font")');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("font")'), 'removed');
  assert.equal(vm.evaluate(`${button}.shown`), 'false');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("movie")'), 'failed');
  assert.match(vm.evaluate('select(2, ClaudeWoWWidgets.Status("movie"))'), /MovieFrame is not an allowed widget frame type/);
});

test('a ticker handle the client returns as userdata still cancels', () => {
  const vm = newVM();
  lua.lua_newuserdata(vm.L, 0);
  lua.lua_setglobal(vm.L, to_luastring('TICKER_UD'));
  vm.run(
    [
      'debug.setmetatable(TICKER_UD, { __index = { Cancel = function() TICKER_UD_CANCELLED = true end } })',
      'C_Timer.NewTicker = function(delay, fn) table.insert(STUB.tickers, fn) return TICKER_UD end',
    ].join('\n'),
  );
  vm.run(widgetSet([['tick', 'local ui = ...\nC_Timer.NewTicker(1, function(handle) ui.db.n = (ui.db.n or 0) + 1 handle:Cancel() end)']]));
  vm.run('STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("tick")'), 'running', vm.evaluate('select(2, ClaudeWoWWidgets.Status("tick"))'));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.tick.n'), '1');
  assert.equal(vm.evaluate('TICKER_UD_CANCELLED'), 'true');
});

const AUDIT_EXTRAS = [
  'function GetSecretThing() return 1 end',
  'function IsAuditReady() return true end',
  'function DoAuditAction() AUDIT_ACTION = true end',
  'QuestFontHighlight = CreateFrame("Font", "QuestFontHighlight")',
  'QuestFontHighlight.GetObjectType = function() return "Font" end',
  'OddFontObject = CreateFrame("Font", "OddFontObject")',
  'OddFontObject.GetObjectType = function() return "Font" end',
  'NotAFontTable = { GetObjectType = function() return "Frame" end }',
  'ClaudeWoWAuditFont = CreateFrame("Font", "ClaudeWoWAuditFont")',
  'ClaudeWoWAuditFont.GetObjectType = function() return "Font" end',
].join('\n');

const auditList = (vm, which) => {
  const text = vm.evaluate(`table.concat(ClaudeWoWWidgetDB.globals.${which}, "\\n")`);
  return text ? text.split('\n') : [];
};

const byteOrder = list => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

test('/claude dev globals saves the sorted names the widget sandbox admits and refuses, without the bridge', () => {
  const vm = newVM();
  vm.run(AUDIT_EXTRAS);
  vm.run('ClaudeWoW.Send = function(text) AUDIT_SENT = text end');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals'), null);
  vm.run('SlashCmdList.CLAUDE("dev globals")');
  assert.equal(vm.evaluate('AUDIT_SENT'), null, 'the dump went to the bridge');
  const admitted = auditList(vm, 'admitted');
  const refusedFunctions = auditList(vm, 'refused');
  const refusedFonts = auditList(vm, 'refusedFonts');
  assert.deepEqual(refusedFonts, ['OddFontObject']);
  assert.ok(!refusedFunctions.includes('OddFontObject'));
  assert.deepEqual(refusedFunctions, byteOrder(refusedFunctions));
  const refused = [...refusedFunctions, ...refusedFonts];
  for (const name of [
    'UnitPowerMax',
    'GetUnitName',
    'GetRaidTargetIndex',
    'GetTime',
    'C_Fake.GetThing',
    'C_UnitAuras.GetAuraDataByIndex',
    'GameFontNormal',
    'GameTooltipText',
    'QuestFontHighlight',
  ])
    assert.ok(admitted.includes(name), `${name} should be admitted`);
  for (const name of ['UnitSetRole', 'GetSecretThing', 'IsAuditReady', 'C_Fake.DropThing', 'OddFontObject'])
    assert.ok(refused.includes(name), `${name} should be refused`);
  for (const name of ['DoAuditAction', 'NotAFontTable', 'ClaudeWoWAuditFont'])
    assert.ok(!admitted.includes(name) && !refused.includes(name), `${name} is outside the audited patterns`);
  assert.deepEqual(admitted, byteOrder(admitted));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals.admittedCount'), String(admitted.length));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals.refusedCount'), String(refused.length));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals.total'), String(admitted.length + refused.length));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals.truncated'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals.version'), '1.60.1');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals.build'), '69913');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals.interface'), '16001');
  const total = admitted.length + refused.length;
  assert.match(
    vm.evaluate(lastSystemNote),
    new RegExp(
      `Saved ${total} of ${total} global names \\(${admitted.length} a widget can use, ${refused.length} it cannot\\) for client 1\\.60\\.1 \\(69913\\)`,
    ),
  );
  vm.run('SlashCmdList.CLAUDE("dev globals clear")');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals'), null);
  assert.match(vm.evaluate(lastSystemNote), /Dropped the saved global names/);
});

test('every name the globals dump admits resolves in a widget, and every name it refuses does not', () => {
  const vm = newVM();
  vm.run(AUDIT_EXTRAS);
  vm.run('SlashCmdList.CLAUDE("dev globals")');
  const admitted = auditList(vm, 'admitted');
  const refused = [...auditList(vm, 'refused'), ...auditList(vm, 'refusedFonts')];
  assert.ok(admitted.length > 20 && refused.length >= 5);
  const source = [
    'local ui = ...',
    `local admitted = { ${admitted.map(n => JSON.stringify(n)).join(', ')} }`,
    `local refused = { ${refused.map(n => JSON.stringify(n)).join(', ')} }`,
    'local wrong = {}',
    'local function Lookup(name)',
    '  local ns, field = name:match("^(C_[%w_]+)%.(.+)$")',
    '  if ns then local t = _G[ns]; return t and t[field] end',
    '  return _G[name]',
    'end',
    'local function Usable(value)',
    '  if value == nil then return false end',
    '  if type(value) ~= "function" then return true end',
    '  local ok, err = pcall(value)',
    '  return ok or not tostring(err):find("is not allowed in a widget")',
    'end',
    'for _, n in ipairs(admitted) do if not Usable(Lookup(n)) then wrong[#wrong + 1] = "+" .. n end end',
    'for _, n in ipairs(refused) do if Usable(Lookup(n)) then wrong[#wrong + 1] = "-" .. n end end',
    'ui.db.wrong = table.concat(wrong, " ")',
    'ui.db.checked = #admitted + #refused',
  ].join('\n');
  vm.run(
    `ClaudeWoWWidgetDB.set = { epoch = "audit", version = 1, items = { { name = "audit", title = "audit", rev = "r1", source = ${P.luaStr(source)} } } }; ClaudeWoWWidgets.Apply(false)`,
  );
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("audit")'), 'running', vm.evaluate('select(2, ClaudeWoWWidgets.Status("audit"))'));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.audit.checked'), String(admitted.length + refused.length));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.data.audit.wrong'), '');
});

test('the globals dump keeps at most GLOBALS_MAX names, admitted ones first', () => {
  const vm = newVM();
  vm.run('for i = 1, ClaudeWoWWidgets.GLOBALS_MAX + 50 do _G["GetAuditFiller" .. i] = function() end end');
  vm.run('SlashCmdList.CLAUDE("dev globals")');
  const max = Number(vm.evaluate('ClaudeWoWWidgets.GLOBALS_MAX'));
  const admittedCount = Number(vm.evaluate('ClaudeWoWWidgetDB.globals.admittedCount'));
  assert.ok(admittedCount > 0);
  assert.equal(vm.evaluate('#ClaudeWoWWidgetDB.globals.admitted'), String(admittedCount));
  assert.equal(vm.evaluate('#ClaudeWoWWidgetDB.globals.admitted + #ClaudeWoWWidgetDB.globals.refused'), String(max));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals.saved'), String(max));
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals.truncated'), 'true');
  assert.ok(Number(vm.evaluate('ClaudeWoWWidgetDB.globals.total')) > max);
  assert.match(vm.evaluate(lastSystemNote), new RegExp(`Saved ${max} of \\d+ global names`));
});

test('/claude dev globals with an unknown word saves nothing and says how to use it', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("dev globals now")');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.globals'), null);
  assert.match(vm.evaluate(lastSystemNote), /Usage: \/claude dev globals/);
});
