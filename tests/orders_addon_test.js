'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const ADDON_FILES = ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Orders.lua'];
const CHAR = 'Testchar-TestRealm';

const STATUSBAR_STUB = `
do
  local probe = CreateFrame("Frame")
  local mt = getmetatable(probe)
  local base = mt.__index
  mt.__index = function(t, k)
    if k == "SetValue" then return function(self, v) if STUB.failBar then error("bar broke") end self.value = v end end
    if k == "SetHighlightAtlas" then return function(self, name) self.highlightAtlas = name end end
    return base(t, k)
  end
end
`;

const LOAD_COUNTER_STUB = `
STUB.loads = 0
local plainLoad = C_AddOns.LoadAddOn
C_AddOns.LoadAddOn = function(name)
  STUB.loads = STUB.loads + 1
  return plainLoad(name)
end
`;

const SPIES = `
STUB.syncs, STUB.printed = 0, {}
local plainSync = ClaudeWoWOrders.Sync
ClaudeWoWOrders.Sync = function(...)
  STUB.syncs = STUB.syncs + 1
  return plainSync(...)
end
local plainPrint = ClaudeWoW.Print
ClaudeWoW.Print = function(msg, tag)
  table.insert(STUB.printed, msg)
  return plainPrint(msg, tag)
end
`;

const NATIVE_TEMPLATES_STUB = `
C_XMLUtil = { GetTemplateInfo = function(name)
  if name == "ObjectiveTrackerModuleHeaderTemplate" or name == "ObjectiveTrackerProgressBarTemplate" then return { type = "Frame" } end
end }
local plainCreateFrame = CreateFrame
function CreateFrame(kind, name, parent, template)
  local f = plainCreateFrame(kind, name, parent, template)
  if template == "ObjectiveTrackerModuleHeaderTemplate" and not STUB.brokenTemplates then
    f.Text = f:CreateFontString(nil, "ARTWORK", "ObjectiveTrackerHeaderFont")
    f.MinimizeButton = plainCreateFrame("Button", nil, f)
  elseif template == "ObjectiveTrackerProgressBarTemplate" and not STUB.brokenTemplates then
    f.Bar = plainCreateFrame("StatusBar", nil, f)
    f.Bar.mouseEnabled = true
    f.Bar.Label = f.Bar:CreateFontString(nil, "ARTWORK", "GameFontHighlightMedium")
  end
  return f
end
`;

const TRACKER_STUB = `
ObjectiveTrackerFrame = CreateFrame("Frame", "ObjectiveTrackerFrame", UIParent)
ObjectiveTrackerFrame:SetSize(260, 800)
ObjectiveTrackerFrame:SetPoint("TOPRIGHT", UIParent, "TOPRIGHT", -85, -200)
ObjectiveTrackerFrame.NineSlice = CreateFrame("Frame", nil, ObjectiveTrackerFrame)
`;

const PET_VEHICLE_STUB = `
C_PetBattles = { IsInBattle = function() return STUB.petBattle == true end }
function UnitHasVehicleUI(unit) return unit == "player" and STUB.vehicle == true end
`;

function newVM({ prelude = '', beforeLogin = '' } = {}) {
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
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(STATUSBAR_STUB);
  run(LOAD_COUNTER_STUB);
  if (prelude) run(prelude);
  for (const f of ADDON_FILES) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run(SPIES);
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  if (beforeLogin) run(beforeLogin);
  run('STUB.FireEvent("PLAYER_LOGIN")');
  run('STUB.RunTimers()');
  return { run, evaluate, num: expr => Number(evaluate(expr)) };
}

function nextSlot(vm, goalsLua, repliesLua = '', nowLua = 'time()') {
  const goals = goalsLua ? `, goals = ${goalsLua}` : '';
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = ${nowLua}, cwd = "", plugin = "ask", plugins = { "ask" }, replies = { ${repliesLua} }${goals} } end`);
}

function tick(vm, seconds = 6) {
  vm.run(`STUB.now = STUB.now + ${seconds}; STUB.Tick()`);
}

const ORDER_GOALS = (rev, text = 'Craft until Leatherworking hits 125', pct = 71, char = CHAR) =>
  `{ rev = ${rev}, char = "${char}", order = { id = "o_${rev}", text = "${text}", pct = ${pct} }, goals = { { title = "Skinning 225", pct = 83 }, { title = "Cooking 75", pct = 14 } } }`;

function shownBars(vm) {
  return vm.num('(function() local n = 0 for _, b in ipairs(ClaudeWoWOrdersCard.bars) do if b.shown then n = n + 1 end end return n end)()');
}

function scenario(vm, slots) {
  for (const s of slots) {
    nextSlot(vm, s);
    tick(vm);
  }
}

function pending(vm) {
  vm.run('PENDING_CHAT, PENDING_ID = nil, nil; for _, c in ipairs(ClaudeWoWDB.chats) do if c.pendingId then PENDING_CHAT, PENDING_ID = c.id, c.pendingId end end');
  return { chat: vm.evaluate('PENDING_CHAT'), id: vm.evaluate('PENDING_ID') };
}

function cardShown(vm) {
  return vm.evaluate('ClaudeWoWOrdersCard ~= nil and ClaudeWoWOrdersCard.shown == true') === 'true';
}

function sendAndRead(vm, goalsLua, text) {
  vm.run(`ClaudeWoW.Send("${text}")`);
  const p = pending(vm);
  nextSlot(vm, goalsLua, `{ chat = "${p.chat}", id = ${p.id}, status = "done", text = "ok", agent = "", plugin = "ask" }`);
  tick(vm);
}

function drawErrorsSaid(vm) {
  vm.run('RESULT = 0; for _, m in ipairs(STUB.printed) do if m:find("could not be drawn", 1, true) then RESULT = RESULT + 1 end end');
  return vm.num('RESULT');
}

test('orders card: a draw error that keeps failing is said once across vehicle and pet battle cycles', () => {
  const vm = newVM({ prelude: PET_VEHICLE_STUB });
  scenario(vm, [ORDER_GOALS(5)]);
  vm.run('STUB.failBar = true');
  for (let i = 0; i < 5; i++) {
    vm.run('STUB.vehicle = true; STUB.FireEvent("UNIT_ENTERED_VEHICLE", "player")');
    vm.run('STUB.vehicle = false; STUB.FireEvent("UNIT_EXITED_VEHICLE", "player")');
    vm.run('STUB.petBattle = true; STUB.FireEvent("PET_BATTLE_OPENING_START")');
    vm.run('STUB.petBattle = false; STUB.FireEvent("PET_BATTLE_CLOSE")');
  }
  assert.equal(cardShown(vm), false);
  assert.equal(drawErrorsSaid(vm), 1);
  vm.run('SlashCmdList.CLAUDE("orders on")');
  assert.equal(drawErrorsSaid(vm), 2, 'an explicit /claude orders on says the error again');
});

test('orders card: a build that fails after the card frame exists never builds a second frame', () => {
  const vm = newVM({ prelude: `
STUB.cardFrames, STUB.failInside = 0, true
local plainCreateFrame = CreateFrame
function CreateFrame(kind, name, parent, ...)
  if name == "ClaudeWoWOrdersCard" then STUB.cardFrames = STUB.cardFrames + 1 end
  if STUB.failInside and parent ~= nil and parent == _G.ClaudeWoWOrdersCard then error("no parts today") end
  return plainCreateFrame(kind, name, parent, ...)
end` });
  scenario(vm, [null]);
  sendAndRead(vm, ORDER_GOALS(5), 'one');
  sendAndRead(vm, ORDER_GOALS(5), 'two');
  sendAndRead(vm, ORDER_GOALS(6, 'Rest'), 'three');
  assert.equal(vm.num('STUB.cardFrames'), 1, 'one named frame for the whole session');
  assert.equal(cardShown(vm), false);
  assert.equal(drawErrorsSaid(vm), 1, 'the build error, said once, not a new error per read');
  assert.match(vm.evaluate('ClaudeWoWOrders.debug.lastError'), /no parts today/);
});

test('orders card: an old slot file left by a stopped bridge never brings back an order Inbox.lua already hid', () => {
  const old = ORDER_GOALS(3, 'Rest');
  const vm = newVM({ beforeLogin: `ClaudeWoW_Inbox = { now = time() - 3600, replies = {}, goals = ${old} }` });
  assert.equal(cardShown(vm), false);
  nextSlot(vm, old, '', 'time() - 3600');
  tick(vm, 9);
  assert.ok(vm.num('STUB.loads') >= 1, 'the hello slot was read');
  assert.equal(cardShown(vm), false);
});

test('orders card: /claude orders off hides it and keeps it hidden through new data, on brings it back; settings stay two booleans', () => {
  const vm = newVM();
  scenario(vm, [ORDER_GOALS(5)]);
  vm.run('SlashCmdList.CLAUDE("orders off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.ordersCard'), 'false');
  assert.equal(cardShown(vm), false);
  vm.run('ClaudeWoW.Send("next")');
  scenario(vm, [ORDER_GOALS(6, 'Skin 30 more')]);
  assert.equal(cardShown(vm), false, 'off stays off when a new order arrives');
  vm.run('SlashCmdList.CLAUDE("config orders on")');
  assert.equal(cardShown(vm), true);
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.text'), 'Skin 30 more', 'the latest order, kept while hidden');
  vm.run('ClaudeWoWOrders.Toggle()');
  assert.equal(cardShown(vm), false, 'the gear menu checkbox toggles the same setting');
  vm.run('ClaudeWoWOrders.Toggle()');
  vm.run('ClaudeWoWOrdersCard.header.MinimizeButton.scripts.OnClick(ClaudeWoWOrdersCard.header.MinimizeButton)');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.ordersCollapsed'), 'true');
  assert.equal(shownBars(vm), 0, 'collapsed: only the header');
  assert.equal(vm.num('ClaudeWoWOrdersCard.height'), 26);
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.buttonArt'), 'ui-questtrackerbutton-secondary-expand');
  vm.run('ClaudeWoWOrdersCard.header.MinimizeButton.scripts.OnClick(ClaudeWoWOrdersCard.header.MinimizeButton)');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.buttonArt'), 'ui-questtrackerbutton-secondary-collapse');
  assert.equal(shownBars(vm), 3);
  assert.equal(vm.evaluate('ClaudeWoWDB.orders'), null);
  vm.run('RESULT = 0; for k, v in pairs(ClaudeWoWDB.settings) do if tostring(k):find("^orders") then RESULT = RESULT + 1; assert(type(v) == "boolean", k) end end');
  assert.equal(vm.num('RESULT'), 2, 'ordersCard and ordersCollapsed, nothing else');
});

test('orders card: follows the quest tracker as it shows, hides and changes size', () => {
  const vm = newVM({ prelude: TRACKER_STUB });
  scenario(vm, [ORDER_GOALS(5)]);
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'tracker');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.rel == ObjectiveTrackerFrame.NineSlice'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.relPoint'), 'BOTTOMLEFT');
  vm.run('ObjectiveTrackerFrame:Hide()');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'tracker-top', 'the tracker hid (no quests): the card takes its place');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.rel == ObjectiveTrackerFrame'), 'true');
  vm.run('ObjectiveTrackerFrame:Show()');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'tracker');
  vm.run('ObjectiveTrackerFrame.NineSlice:Hide(); for _, fn in ipairs(ObjectiveTrackerFrame.hooks.OnSizeChanged or {}) do fn(ObjectiveTrackerFrame) end');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'tracker-top', 'a size change re-anchors');
  vm.run('ClaudeWoWOrders.Refresh(); ClaudeWoWOrders.ToggleCollapsed(); ClaudeWoWOrders.ToggleCollapsed()');
  for (const script of ['OnShow', 'OnHide', 'OnSizeChanged']) {
    assert.equal(vm.num(`#ObjectiveTrackerFrame.hooks.${script}`), 1, `${script} hooked once, with HookScript, however often the card redraws`);
  }
});

test('orders card: Blizzard templates when the client has them, plain frames when a template is missing or incomplete', () => {
  const native = newVM({ prelude: NATIVE_TEMPLATES_STUB });
  scenario(native, [ORDER_GOALS(5)]);
  assert.equal(native.evaluate('ClaudeWoWOrders.debug.native.header'), 'true');
  assert.equal(native.evaluate('ClaudeWoWOrders.debug.native.bar'), 'true');
  assert.equal(native.evaluate('ClaudeWoWOrdersCard.header.template'), 'ObjectiveTrackerModuleHeaderTemplate');
  assert.equal(native.evaluate('ClaudeWoWOrdersCard.bars[1].template'), 'ObjectiveTrackerProgressBarTemplate');
  assert.equal(native.evaluate('ClaudeWoWOrdersCard.header.Text.text'), 'Orders');
  assert.equal(native.evaluate('ClaudeWoWOrdersCard.bars[1].Bar.Label.text'), '71%');
  native.run('RESULT = 0; for _, b in ipairs(ClaudeWoWOrdersCard.bars) do if b.Bar.mouseEnabled ~= false then RESULT = RESULT + 1 end end');
  assert.equal(native.num('RESULT'), 0, 'the template bar takes the mouse; every one is turned off');
  const broken = newVM({ prelude: NATIVE_TEMPLATES_STUB + '\nSTUB.brokenTemplates = true' });
  scenario(broken, [ORDER_GOALS(5)]);
  assert.equal(broken.evaluate('ClaudeWoWOrders.debug.native.header'), 'false');
  assert.equal(broken.evaluate('ClaudeWoWOrders.debug.native.bar'), 'false');
  assert.equal(cardShown(broken), true);
  assert.equal(broken.evaluate('ClaudeWoWOrdersCard.bars[1].Bar.Label.text'), '71%');
  const plain = newVM();
  scenario(plain, [ORDER_GOALS(5)]);
  assert.equal(plain.evaluate('ClaudeWoWOrders.debug.native.header'), 'false', 'no C_XMLUtil: plain frames');
  const noAtlas = newVM({ prelude: 'C_Texture.GetAtlasExists = function() return false end' });
  scenario(noAtlas, [ORDER_GOALS(5)]);
  assert.equal(noAtlas.evaluate('ClaudeWoWOrders.debug.buttonArt'), 'Interface\\Buttons\\UI-MinusButton-Up', 'a missing atlas falls back to a file');
});

test('orders card: the module sends nothing and automates nothing', () => {
  const src = fs.readFileSync(path.join(ADDON, 'Orders.lua'), 'utf8');
  for (const name of ['SendChatMessage', 'SendAddonMessage', 'C_ChatInfo', 'ChatFrame_OpenChat', 'ChatFrameUtil', 'RunMacro', 'RunScript', 'loadstring', 'CastSpell', 'UseAction', 'TryLoadSlot', 'LoadAddOn', 'SetBinding']) {
    assert.ok(!src.includes(name), `Orders.lua does not use ${name}`);
  }
  const vm = newVM();
  const before = vm.num('#STUB.chatSent');
  scenario(vm, [ORDER_GOALS(5)]);
  vm.run('SlashCmdList.CLAUDE("orders off"); SlashCmdList.CLAUDE("orders on")');
  assert.equal(vm.num('#STUB.chatSent'), before);
});

const QUEST_WATCH_STUB = `
QuestWatchFrame = CreateFrame("Frame", "QuestWatchFrame", UIParent)
QuestWatchFrame:SetSize(280, 52)
QuestWatchFrame:SetPoint("TOPRIGHT", UIParent, "TOPRIGHT", -85, -200)
NORMAL_FONT_COLOR = { r = 1, g = 0.82, b = 0 }
HIGHLIGHT_FONT_COLOR = { r = 1, g = 1, b = 1 }
GameFontNormal, GameFontHighlight = {}, {}
STUB.atlasAsked, STUB.templatesAsked = {}, {}
C_Texture = { GetAtlasExists = function(name) table.insert(STUB.atlasAsked, name) return true end }
C_XMLUtil = { GetTemplateInfo = function(name) table.insert(STUB.templatesAsked, name) return nil end }
do
  local probe = CreateFrame("Frame")
  local mt = getmetatable(probe)
  local base = mt.__index
  mt.__index = function(t, k)
    if k == "SetTextColor" then return function(self, r, g, b) self.textColor = string.format("%.2f,%.2f,%.2f", r, g, b) end end
    if k == "SetNormalTexture" then return function(self, file) self.normalFile = file end end
    if k == "SetHighlightTexture" then return function(self, file, mode) self.highlightFile = file end end
    if k == "CreateFontString" then
      return function(self, name, layer, font)
        local fs = base(t, k)(self, name, layer, font)
        fs.font = font
        return fs
      end
    end
    return base(t, k)
  end
end
`;

test('orders card on Classic Era: follows QuestWatchFrame with its fonts, colors and dash lines, and asks for no tracker template or atlas', () => {
  const vm = newVM({ prelude: QUEST_WATCH_STUB });
  scenario(vm, [`{ rev = 5, char = "${CHAR}", order = { id = "o_5", text = "Craft until Leatherworking hits 125", pct = 71 }, goals = { { title = "Skinning 225", pct = 83 }, { title = "Cooking 75", pct = 100 } } }`]);
  assert.equal(cardShown(vm), true);
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.style'), 'watch');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'watch');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.rel == QuestWatchFrame'), 'true');
  assert.deepEqual([vm.evaluate('ClaudeWoWOrdersCard.point'), vm.evaluate('ClaudeWoWOrdersCard.relPoint'), vm.num('ClaudeWoWOrdersCard.y')], ['TOPLEFT', 'BOTTOMLEFT', -4]);
  assert.deepEqual([vm.evaluate('ClaudeWoWOrdersCard.header.Text.text'), vm.evaluate('ClaudeWoWOrdersCard.header.Text.font')], ['Orders', 'GameFontNormal']);
  const line = expr => [vm.evaluate(`${expr}.text`), vm.evaluate(`${expr}.font`), vm.evaluate(`${expr}.textColor`)];
  assert.deepEqual(line('ClaudeWoWOrdersCard.orderText'), ['Craft until Leatherworking hits 125', 'GameFontHighlight', '0.75,0.61,0.00'], 'the order is a watched quest title');
  assert.deepEqual(line('ClaudeWoWOrdersCard.pctLine'), [' - 71%', 'GameFontHighlight', '0.80,0.80,0.80']);
  assert.deepEqual(line('ClaudeWoWOrdersCard.goalLines[1]'), [' - Skinning 225: 83%', 'GameFontHighlight', '0.80,0.80,0.80']);
  assert.deepEqual(line('ClaudeWoWOrdersCard.goalLines[2]'), [' - Cooking 75: 100%', 'GameFontHighlight', '1.00,1.00,1.00'], 'a finished line is bright, as a finished objective is');
  assert.equal(vm.num('#ClaudeWoWOrdersCard.bars'), 0, 'the Era watch list has no progress bars');
  vm.run('RESULT = 0; local mine = {}; for _, a in pairs(ClaudeWoWOrders.ATLAS) do mine[a] = true end; for _, a in ipairs(STUB.atlasAsked) do if mine[a] then RESULT = RESULT + 1 end end');
  assert.equal(vm.num('RESULT'), 0, 'no tracker atlas lookup: Era answers yes for atlases it draws green');
  vm.run('RESULT = 0; for _, t in ipairs(STUB.templatesAsked) do if t:find("^ObjectiveTracker") then RESULT = RESULT + 1 end end');
  assert.equal(vm.num('RESULT'), 0, 'no ObjectiveTracker template lookup');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.header.MinimizeButton.normalFile'), 'Interface\\Buttons\\UI-MinusButton-Up');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.header.MinimizeButton.highlightFile'), 'Interface\\Buttons\\UI-PlusButton-Hilight');

  vm.run('QuestWatchFrame:Hide()');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'watch-top', 'no watched quests: the card takes the watch list spot');
  vm.run('QuestWatchFrame:Show()');
  assert.equal(vm.evaluate('ClaudeWoWOrders.debug.anchoredTo'), 'watch');
  vm.run('ClaudeWoWOrders.ToggleCollapsed()');
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.header.MinimizeButton.normalFile'), 'Interface\\Buttons\\UI-PlusButton-Up');
  assert.equal(vm.num('ClaudeWoWOrdersCard.height'), 16);
  assert.equal(vm.evaluate('ClaudeWoWOrdersCard.orderText.shown'), 'false');
  vm.run('ClaudeWoWOrders.ToggleCollapsed()');
  for (const script of ['OnShow', 'OnHide', 'OnSizeChanged']) assert.equal(vm.num(`#QuestWatchFrame.hooks.${script}`), 1, `${script} hooked once`);
});
