'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');

function newVM({ before = '', saved = '' } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg, chunk) => {
    const buf = to_luastring(code);
    const loaded = chunk ? lauxlib.luaL_loadbuffer(L, buf, buf.length, to_luastring('@' + chunk)) : lauxlib.luaL_loadstring(L, buf);
    if (loaded !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
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
  run(BLIZZARD);
  if (before) run(before);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'LootRoll.lua', 'Window.lua'])
    run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW', 'addon/' + f);
  if (saved) run(saved);
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate, num };
}

const BLIZZARD = `
  STUB.Panel("CharacterFrame", 16, 1000, 700, 600)
  STUB.Panel("ContainerFrameCombinedBags", 1200, 700, 700, 500)
  STUB.Panel("GameMenuFrame", 760, 700, 400, 400)
  WorldMapFrame = STUB.Panel("WorldMapFrame", 300, 1000, 1300, 900)
  STUB.mapMax = false
  function WorldMapFrame:IsMaximized() return STUB.mapMax end
  function WorldMapFrame:Maximize() STUB.mapMax = true end
  function WorldMapFrame:Minimize() STUB.mapMax = false end
  function ToggleAllBags() if ContainerFrameCombinedBags:IsShown() then ContainerFrameCombinedBags:Hide() else ContainerFrameCombinedBags:Show() end end
`;

const rect = vm => ({
  left: vm.num('ClaudeWoWFrame:GetLeft()'),
  top: vm.num('ClaudeWoWFrame:GetTop()'),
  right: vm.num('ClaudeWoWFrame:GetRight()'),
  bottom: vm.num('ClaudeWoWFrame:GetBottom()'),
});
const settle = vm => vm.run('STUB.RunTimers(); STUB.RunTimers()');
const frames = (vm, n, dt = 0.05) => {
  for (let i = 0; i < n; i++) vm.run(`STUB.RunFrames(${dt})`);
};
const open = vm => {
  vm.run('ClaudeWoW.Toggle(true)');
  settle(vm);
};
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom;
const panelRect = (vm, name) => ({
  left: vm.num(`${name}:GetLeft()`),
  right: vm.num(`${name}:GetRight()`),
  top: vm.num(`${name}:GetTop()`),
  bottom: vm.num(`${name}:GetBottom()`),
});

test('a loot window in the panel slot moves to the right of the workspace window, as beside a Blizzard panel, and the window stays home', () => {
  const vm = newVM({
    before: `
    LootFrame = CreateFrame("Frame", "LootFrame", UIParent)
    LootFrame:SetSize(200, 400)
    UIParent:SetAttribute("PANEl_SPACING_X", 32)
    function STUB.LootInSlot() LootFrame:ClearAllPoints(); LootFrame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 16, -116) end
    STUB.LootInSlot()`,
  });
  open(vm);
  const home = rect(vm);

  vm.run('ShowUIPanel(LootFrame)');
  settle(vm);
  assert.deepEqual(rect(vm), home, 'the window does not move down');
  assert.deepEqual(
    panelRect(vm, 'LootFrame'),
    { left: home.right + 32, right: home.right + 232, top: home.top, bottom: home.top - 400 },
    'the loot window sits right of it, on the same line',
  );
  assert.equal(vm.evaluate('ClaudeWoWWindow.state.dodged'), 'false');

  vm.run('STUB.combat = true; STUB.LootInSlot(); ClaudeWoWWindow.Relayout()');
  assert.equal(vm.num('LootFrame:GetLeft()'), home.right + 32, 'it works in combat too');
  vm.run('STUB.combat = false; HideUIPanel(LootFrame)');
  settle(vm);

  vm.run('STUB.LootInSlot(); LootFrame:Show()');
  frames(vm, 8);
  settle(vm);
  assert.equal(vm.num('LootFrame:GetLeft()'), home.right + 32, 'a loot window shown without the panel manager is caught by the poll');
  assert.deepEqual(rect(vm), home);
  vm.run('LootFrame:Hide()');
  frames(vm, 8);
  settle(vm);

  vm.run('LootFrame.protected = true; STUB.combat = true; STUB.LootInSlot(); ShowUIPanel(LootFrame)');
  settle(vm);
  assert.equal(vm.num('LootFrame:GetLeft()'), 16, 'a protected loot frame is never moved');
  assert.equal(vm.evaluate('STUB.blocked[1]'), null, 'not even in combat');
  assert.ok(!overlaps(rect(vm), panelRect(vm, 'LootFrame')), 'the window steps aside from it instead');
  vm.run('STUB.combat = false; HideUIPanel(LootFrame); LootFrame.protected = nil');
  settle(vm);

  vm.run('LootFrame:ClearAllPoints(); LootFrame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 300, -200); ShowUIPanel(LootFrame)');
  settle(vm);
  assert.equal(vm.num('LootFrame:GetLeft()'), 300, 'a loot window another addon put elsewhere is left there');
  assert.ok(!overlaps(rect(vm), panelRect(vm, 'LootFrame')), 'and the window steps aside from it');
  vm.run('HideUIPanel(LootFrame)');
  settle(vm);
  vm.run('LootFrame:ClearAllPoints(); LootFrame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 16, -500); ShowUIPanel(LootFrame)');
  settle(vm);
  assert.equal(vm.num('LootFrame:GetLeft()'), 16, "one at the slot's x but lower down is left there too");
  vm.run('HideUIPanel(LootFrame)');
  settle(vm);

  vm.run('UIParent:SetSize(1000, 1080); STUB.LootInSlot(); ShowUIPanel(LootFrame)');
  settle(vm);
  assert.ok(!overlaps(rect(vm), panelRect(vm, 'LootFrame')), 'no room on the right: the window steps aside as before');
  vm.run('HideUIPanel(LootFrame); UIParent:SetSize(1920, 1080)');
  settle(vm);

  vm.run(
    'ContainerFrameCombinedBags.rect = { left = 900, right = 1600, top = 1000, bottom = 500 }; ShowUIPanel(ContainerFrameCombinedBags); STUB.LootInSlot(); ShowUIPanel(LootFrame)',
  );
  settle(vm);
  assert.ok(!overlaps(panelRect(vm, 'LootFrame'), panelRect(vm, 'ContainerFrameCombinedBags')), 'the loot window is never moved onto another open panel');
  assert.ok(!overlaps(rect(vm), panelRect(vm, 'LootFrame')), 'the window steps aside instead');
  vm.run(
    'HideUIPanel(LootFrame); HideUIPanel(ContainerFrameCombinedBags); ContainerFrameCombinedBags.rect = { left = 1200, right = 1900, top = 700, bottom = 200 }',
  );
  settle(vm);

  vm.run(
    'STUB.cvars.lootUnderMouse = "1"; LootFrame:ClearAllPoints(); LootFrame:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", 300, 800); ShowUIPanel(LootFrame)',
  );
  settle(vm);
  assert.equal(vm.num('LootFrame:GetLeft()'), 300, 'loot at the mouse is left where the game put it');
  assert.ok(!overlaps(rect(vm), panelRect(vm, 'LootFrame')), 'and the window steps aside from it');
});

test('it dims while the player moves or fights, fades back smoothly, and is opaque under the mouse or while typing', () => {
  const vm = newVM();
  open(vm);
  const alpha = () => vm.num('ClaudeWoWFrame:GetAlpha()');
  assert.equal(alpha(), 1);
  vm.run('STUB.FireEvent("PLAYER_STARTED_MOVING")');
  frames(vm, 1, 0.1);
  assert.ok(alpha() < 1 && alpha() > 0.35, 'a fade, not a jump: ' + alpha());
  frames(vm, 5, 0.1);
  assert.equal(alpha(), 0.35, 'dimmed to 35%');
  assert.equal(vm.num('ClaudeWoWMini:GetAlpha()'), 0.35, 'the bar dims with it');
  vm.run('STUB.mouseOver = ClaudeWoWFrame');
  frames(vm, 5, 0.1);
  assert.equal(alpha(), 1, 'opaque under the mouse');
  vm.run('STUB.mouseOver = nil; ClaudeWoWInput:SetFocus()');
  frames(vm, 5, 0.1);
  assert.equal(alpha(), 1, 'opaque while typing');
  vm.run('ClaudeWoWInput:ClearFocus()');
  frames(vm, 5, 0.1);
  assert.equal(alpha(), 0.35);
  vm.run('STUB.FireEvent("PLAYER_STOPPED_MOVING")');
  frames(vm, 1, 0.1);
  assert.ok(alpha() > 0.35 && alpha() < 1, 'fading back: ' + alpha());
  frames(vm, 5, 0.1);
  assert.equal(alpha(), 1, 'back when the player stops');

  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  frames(vm, 6, 0.1);
  assert.equal(alpha(), 0.35, 'dimmed in combat');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  frames(vm, 6, 0.1);
  assert.equal(alpha(), 1);

  vm.run('SlashCmdList.CLAUDE("config ui dim 60")');
  vm.run('STUB.FireEvent("PLAYER_STARTED_MOVING")');
  frames(vm, 6, 0.1);
  assert.equal(alpha(), 0.6, 'the dim level is the setting');
  vm.run('SlashCmdList.CLAUDE("config ui dim off")');
  frames(vm, 6, 0.1);
  assert.equal(alpha(), 1, 'dim off: never dimmed');
  vm.run('STUB.FireEvent("PLAYER_STARTED_MOVING"); SlashCmdList.CLAUDE("config ui dim 35")');
  frames(vm, 6, 0.1);
  assert.equal(alpha(), 0.35);
  assert.equal(vm.evaluate('ClaudeWoWFrame.mouseEnabled'), 'true', 'dimmed, it still takes clicks: nothing is turned off');
  assert.equal(vm.evaluate('ClaudeWoWInput.mouseEnabled ~= false'), 'true');
});

test('in combat the window still steps aside and dims, touches no protected frame and calls no panel function', () => {
  const vm = newVM();
  open(vm);
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  vm.run('ShowUIPanel(CharacterFrame)');
  settle(vm);
  frames(vm, 8, 0.1);
  assert.equal(rect(vm).left, 724, 'moved in combat: it is an ordinary frame');
  assert.equal(vm.num('ClaudeWoWFrame:GetAlpha()'), 0.35);
  vm.run('ShowUIPanel(GameMenuFrame)');
  settle(vm);
  vm.run('HideUIPanel(GameMenuFrame); HideUIPanel(CharacterFrame)');
  settle(vm);
  frames(vm, 8, 0.1);
  vm.run('ClaudeWoW.InstallMacro({ name = "X", body = "/sit" })');
  assert.equal(vm.evaluate('STUB.blocked[1]'), null, 'no protected frame was moved, shown or hidden by addon code');
  assert.equal(
    vm.evaluate('(function() for _, c in ipairs(STUB.panelCalls) do if c.addon then return c.name end end end)()'),
    null,
    'no ShowUIPanel/HideUIPanel from addon code',
  );
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes("macros can't be changed in combat"));
});

test('the window cannot be dragged, the compact bar can, and the size is remembered per character and respects the UI scale', () => {
  const vm = newVM();
  open(vm);
  const home = rect(vm);
  assert.equal(vm.evaluate('ClaudeWoWFrame.scripts.OnDragStart'), null, 'no drag on the window');
  assert.equal(vm.evaluate('ClaudeWoWFrame.scripts.OnDragStop'), null);
  assert.notEqual(vm.evaluate('ClaudeWoWMini.scripts.OnDragStart'), null, 'the compact bar still drags');

  vm.run(
    'ClaudeWoWFrame:SetSize(900, 600); for _, c in ipairs(ClaudeWoWFrame.children) do if c.scripts.OnMouseUp and c.kind == "Button" and not c.name then c.scripts.OnMouseUp(c) end end',
  );
  assert.equal(vm.num('ClaudeWoWDB.layouts["Testchar-Test Realm"].w'), 900, 'the resize grip saves the size');
  settle(vm);
  assert.deepEqual(
    rect(vm),
    { left: home.left, top: home.top, right: home.left + 900, bottom: home.top - 600 },
    'resizing keeps the top-left corner in the slot',
  );

  vm.run('local real = UnitName; UnitName = function() return "Alt" end; ALT = ClaudeWoWWindow.Layout(); UnitName = real');
  assert.equal(vm.num('ALT.w'), 900, "another character starts at the account's last size");

  vm.run(
    'ClaudeWoWFrame:SetSize(780, 500); for _, c in ipairs(ClaudeWoWFrame.children) do if c.scripts.OnMouseUp and c.kind == "Button" and not c.name then c.scripts.OnMouseUp(c) end end',
  );
  settle(vm);
  vm.run('CharacterFrame:SetScale(0.5); ShowUIPanel(CharacterFrame)');
  settle(vm);
  assert.ok(!overlaps(rect(vm), { left: 8, right: 358, top: 500, bottom: 200 }), 'a scaled panel is measured in UIParent units');
  assert.equal(vm.evaluate('ClaudeWoWWindow.state.dodged'), 'true');
  vm.run('HideUIPanel(CharacterFrame); CharacterFrame:SetScale(1)');
  settle(vm);

  vm.run('UIParent:SetSize(1280, 720); STUB.FireEvent("UI_SCALE_CHANGED")');
  settle(vm);
  const r = rect(vm);
  assert.ok(r.left >= 0 && r.right <= 1280 && r.bottom >= 0 && r.top <= 720, 'kept on a smaller screen: ' + JSON.stringify(r));

  vm.run('ClaudeWoWDB.layouts["Testchar-Test Realm"].w = 1000');
  vm.run('SlashCmdList.CLAUDE("config ui reset")');
  assert.equal(vm.evaluate('ClaudeWoWDB.layouts["Testchar-Test Realm"].w'), '780', 'reset goes back to the default size');
});

test("the window replaces nothing of Blizzard's: panel hooks are secure post-hooks and no Blizzard frame script is touched", () => {
  const vm = newVM({
    before: `SNAP = { g = {}, map = {} }
    for k, v in pairs(_G) do if type(v) == "function" then SNAP.g[k] = v end end
    for _, k in ipairs({ "Maximize", "Minimize", "IsMaximized" }) do SNAP.map[k] = WorldMapFrame[k] end`,
  });
  open(vm);
  vm.run('ShowUIPanel(CharacterFrame); ToggleAllBags(); WorldMapFrame:Maximize()');
  settle(vm);
  const bad = vm.evaluate(`(function()
    local bad = {}
    for k, v in pairs(SNAP.g) do if _G[k] ~= v and not STUB.secureHooks[_G[k]] then bad[#bad + 1] = k end end
    for k, v in pairs(SNAP.map) do if WorldMapFrame[k] ~= v and not STUB.secureHooks[WorldMapFrame[k]] then bad[#bad + 1] = "WorldMapFrame:" .. k end end
    for _, name in ipairs({ "CharacterFrame", "ContainerFrameCombinedBags", "GameMenuFrame", "WorldMapFrame" }) do
      if next(_G[name].scripts) then bad[#bad + 1] = name .. " script" end
      if next(_G[name].hooks) then bad[#bad + 1] = name .. " HookScript" end
    end
    return table.concat(bad, ", ")
  end)()`);
  assert.equal(bad, '');
  assert.equal(vm.evaluate('STUB.secureHooks[ShowUIPanel]'), 'true', 'ShowUIPanel is watched through hooksecurefunc');
  assert.equal(vm.evaluate('STUB.secureHooks[SetItemRef]'), 'true', 'links are read through a SetItemRef post-hook');
});

test('the Dragonflight metal border is used where the client has it, and the plain one elsewhere', () => {
  const plain = newVM();
  assert.equal(plain.evaluate('ClaudeWoWWindow.skinned'), 'false');
  const metal = newVM({
    before: `
    NineSliceLayouts = { ButtonFrameTemplateNoPortrait = {} }
    NineSliceUtil = { ApplyLayoutByName = function(frame, name) STUB.layout = name end }`,
  });
  assert.equal(metal.evaluate('ClaudeWoWWindow.skinned'), 'true');
  assert.equal(metal.evaluate('STUB.layout'), 'ButtonFrameTemplateNoPortrait');
  assert.equal(metal.evaluate('ClaudeWoWFrame.claudewowBorder.template'), 'NineSlicePanelTemplate');
});

const NATIVE_TEMPLATES = `
  local templates = { ButtonFrameTemplate = true, InsetFrameTemplate = true, SearchBoxTemplate = true, ScrollFrameTemplate = true, NavBarTemplate = true, MainHelpPlateButton = true }
  C_XMLUtil = { GetTemplateInfo = function(name) if templates[name] then return { type = "Frame" } end end }
  STUB.nav = { resets = 0, buttons = {} }
  function NavBar_Initialize(bar, template, home) STUB.nav.home = home.name end
  function NavBar_Reset(bar) STUB.nav.resets = STUB.nav.resets + 1; STUB.nav.buttons = {} end
  function NavBar_AddButton(bar, data) table.insert(STUB.nav.buttons, data) end
  function ScrollingEdit_OnCursorChanged() end
  function ScrollingEdit_OnTextChanged() end
  MenuUtil = { CreateContextMenu = function(owner, gen)
    local root = { items = {} }
    function root:CreateTitle(t) table.insert(self.items, { text = t }) end
    function root:CreateButton(t, fn) table.insert(self.items, { text = t, fn = fn }) end
    function root:CreateCheckbox(t, get, fn) table.insert(self.items, { text = t, fn = fn, get = get }) end
    function root:CreateDivider() end
    STUB.menu = root
    gen(owner, root)
  end }
  function STUB.Pick(text) for _, it in ipairs(STUB.menu.items) do if it.text == text then it.fn() return end end error("no menu item " .. text) end
  local plainCreate = CreateFrame
  CreateFrame = function(kind, name, parent, template)
    local f = plainCreate(kind, name, parent, template)
    if template == "ButtonFrameTemplate" then
      f.CloseButton = plainCreate("Button", nil, f, "UIPanelCloseButton")
      f.Inset = plainCreate("Frame", nil, f, "InsetFrameTemplate")
      f.TitleText = f:CreateFontString()
      function f:GetTitleText() return self.TitleText end
      function f:SetPortraitToAsset(path) self.portrait = path end
    end
    return f
  end`;

const nativeVM = () => {
  const vm = newVM({ before: NATIVE_TEMPLATES });
  open(vm);
  vm.run('ClaudeWoW.SetFolder("~/every-io/every", ClaudeWoWDB.chats[1])');
  vm.run('ClaudeWoW.NewChat(); ClaudeWoW.SetFolder("~/wow-ai", ClaudeWoW.UI and ClaudeWoWDB.chats[2]); ClaudeWoWDB.chats[2].name = "Fix the bridge"');
  vm.run('ClaudeWoW.NewChat(); ClaudeWoWDB.chats[3].name = "Leatherworking route"; ClaudeWoW.SetFolder("~/every-io/every", ClaudeWoWDB.chats[3])');
  vm.run('ClaudeWoW.Render()');
  return vm;
};
const shownHeaders = vm =>
  vm.evaluate(
    '(function() local t = {} for _, h in ipairs(ClaudeWoW.UI.questList.headers) do if h.shown then table.insert(t, h.text:GetText()) end end return table.concat(t, "|") end)()',
  );
const shownRows = vm =>
  vm.evaluate(
    '(function() local t = {} for _, r in ipairs(ClaudeWoW.UI.questList.rows) do if r.shown then table.insert(t, r.label:GetText()) end end return table.concat(t, "|") end)()',
  );

const rowOf = index =>
  `(function() for _, r in ipairs(ClaudeWoW.UI.questList.rows) do if r.shown and r.chatId == ClaudeWoWDB.chats[${index}].id then return r end end end)()`;
const titleColorOf = (vm, index) => vm.evaluate(`(function() local c = ${rowOf(index)}.titleColor return c[1] .. "," .. c[2] .. "," .. c[3] end)()`);

test('on Classic Era a working chat whose glyph atlas is refused shows its number on the disc, not a blank', () => {
  const vm = newVM({ before: NATIVE_TEMPLATES + '\nfunction GetBuildInfo() return "1.15.9", "70003", "Sep 1 2026", 11509, "", " " end' });
  open(vm);
  vm.run('ClaudeWoW.NewChat(); ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[2].id); ClaudeWoWDB.chats[1].pendingId = 99; ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.working'), 'false', 'Era has no working glyph atlas');
  const poi = `${rowOf(1)}.poi`;
  assert.equal(vm.evaluate(`${poi}.glyph.shown`), 'false');
  assert.equal(vm.evaluate(`${poi}.number.shown`), 'true', 'the number stands in for the refused glyph');
  assert.match(vm.evaluate(`${poi}.number.text`), /^\d+$/);

  const forever = nativeVM();
  forever.run('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[3].id); ClaudeWoWDB.chats[1].pendingId = 99; ClaudeWoW.Render()');
  assert.equal(forever.evaluate(`${rowOf(1)}.poi.glyph.shown`), 'true', 'where the atlas exists the glyph shows');
  assert.equal(forever.evaluate(`${rowOf(1)}.poi.number.shown`), 'false');
});

test('a chat whose newest reply waits on a permission gets the needs-you title color; working outranks it, it outranks an unread reply', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[3].id)');
  const idle = '0.75,0.61,0';
  assert.equal(titleColorOf(vm, 1), '0.5,0.5,0.5', 'an idle chat with no messages has a dim title');
  vm.run('ClaudeWoWDB.chats[2].unread = 1; ClaudeWoW.Render()');
  const reply = titleColorOf(vm, 2);
  assert.notEqual(reply, idle);
  vm.run(`local h = ClaudeWoWDB.chats[1].history
    table.insert(h, { role = "user", text = "clean up", t = time() })
    table.insert(h, { role = "assistant", text = "I need permission", t = time(), denied = { "Bash(rm:*)" } })
    table.insert(h, { role = "system", text = "This chat's context is large.", t = time() })
    ClaudeWoW.Render()`);
  const needsYou = titleColorOf(vm, 1);
  assert.equal(needsYou, '1,0.4,0.1', 'a trailing system message does not hide the open denial');
  vm.run('ClaudeWoWDB.chats[1].unread = 2; ClaudeWoW.Render()');
  assert.equal(titleColorOf(vm, 1), needsYou, 'needs you outranks an unread reply');
  vm.run('ClaudeWoWDB.chats[1].pendingId = 99; ClaudeWoW.Render()');
  assert.notEqual(titleColorOf(vm, 1), needsYou, 'working outranks needs you');
  vm.run(
    'ClaudeWoWDB.chats[1].pendingId = nil; ClaudeWoWDB.chats[1].unread = 0; table.insert(ClaudeWoWDB.chats[1].history, { role = "user", text = "never mind", t = time() }); ClaudeWoW.Render()',
  );
  assert.equal(titleColorOf(vm, 1), idle, 'a newer message from the player closes the denial');
});

test('on Classic Era, where the quest parchment atlas is missing, the transcript uses the Vanilla quest panel parchment', () => {
  const vm = newVM({
    before:
      NATIVE_TEMPLATES +
      `
    function GetBuildInfo() return "1.15.9", "70003", "Sep 1 2026", 11509 end
    local realExists = C_Texture.GetAtlasExists
    C_Texture.GetAtlasExists = function(name) if name == "QuestBG-Parchment" then return false end return realExists(name) end`,
  });
  open(vm);
  vm.run('ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.parchment'), 'Interface\\QuestFrame\\UI-QuestLog-TopLeft');
  const page = 'ClaudeWoW.UI.classicPage';
  assert.equal(vm.num(`#${page}.pieces`), 4, 'the quest log page is drawn from its four textures');
  vm.run(`${page}.scripts.OnSizeChanged(${page}, 592, 516)`);
  assert.equal(vm.num(`${page}.pieces[1].width`) + vm.num(`${page}.pieces[2].width`), 592, 'the pieces fill the width');
  assert.equal(vm.num(`${page}.pieces[1].height`) + vm.num(`${page}.pieces[3].height`), 516, 'and the height');
  assert.equal(vm.num(`${page}.pieces[2].x`), vm.num(`${page}.pieces[1].width`), 'the right piece starts where the left one ends');
});

test('a reply names items and spells by token: the client turns each into a real link, unknown ones stay plain, and the bubble makes links clickable', () => {
  const vm = nativeVM();
  vm.run(`
    STUB.itemLoads = {}
    C_Item.GetItemInfo = function(id) if id == 2589 then return "Linen Cloth", "|cffffffff|Hitem:2589::::::::|h[Linen Cloth]|h|r" end end
    C_Item.RequestLoadItemDataByID = function(id) table.insert(STUB.itemLoads, id) end
    C_Spell = { GetSpellLink = function(id) if id == 1752 then return "|cff71d5ff|Hspell:1752|h[Sinister Strike]|h|r" end end }
    local c = ClaudeWoWDB.chats[1]
    ClaudeWoW.SwitchChat(c.id)
    c.history = { { role = "assistant", t = 1, text = "farm {item:2589} then use {spell:1752}\\n- spare {item:999999}\\n- fake |cffff0000[Thunderfury]|r" } }
    ClaudeWoW.Render()
  `);
  const body = vm.evaluate('(function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b.body:GetText() end end end)()');
  assert.ok(body.includes('|Hitem:2589::::::::|h[Linen Cloth]|h'), body);
  assert.ok(body.includes('|Hspell:1752|h[Sinister Strike]|h'), body);
  assert.ok(body.includes('|cff5c5248item 999999|r'), 'an ID the client does not have shows plainly, with no invented name, in parchment ink');
  assert.ok(body.includes('|cff2e1f0f|Hitem:2589'), 'a white item name is drawn dark enough to read on the parchment');
  assert.ok(body.includes('|cff1c4f9c|Hspell:1752'), 'and so is a spell link');
  assert.equal(vm.evaluate('STUB.itemLoads[1]'), '999999', 'and the client is asked to load it');
  assert.ok(body.includes('\u2022 spare'), 'a "- " line becomes a bullet');
  assert.ok(!body.includes('|cffff0000'), 'color codes the agent typed are neutralized');
  const b = '(function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b end end end)()';
  assert.equal(vm.evaluate(`${b}.scripts.OnHyperlinkClick ~= nil`), 'true', 'the bubble handles link clicks');
});

test('a message on the parchment has no colored accent bar; the dark theme keeps it', () => {
  const firstAccent = '(function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b.accent.shown end end end)()';
  const seed =
    'local c = ClaudeWoWDB.chats[1]; ClaudeWoW.SwitchChat(c.id); c.history = { { role = "user", t = 1, text = "hi" }, { role = "assistant", t = 2, text = "hello" } }; ClaudeWoW.Render()';
  const parchment = nativeVM();
  parchment.run(seed);
  assert.equal(parchment.evaluate(firstAccent), 'false', 'no web quote bar on the quest page');
  const dark = newVM();
  open(dark);
  dark.run(seed);
  assert.equal(dark.evaluate('ClaudeWoW.UI.parchment'), null);
  assert.equal(dark.evaluate(firstAccent), 'true', 'the dark theme keeps its accent bar');
});

test('a quest token is a real quest link in parchment ink, and clicking it opens that quest in the quest log', () => {
  const vm = nativeVM();
  vm.run(`
    STUB.refs, STUB.selected, STUB.panels = {}, {}, {}
    SetItemRef = function(link) table.insert(STUB.refs, link) end
    GetNumQuestLogEntries = function() return 2 end
    GetQuestLogTitle = function(i)
      if i == 1 then return "The Barrens", 0, nil, true, STUB.collapsed == true, false, nil, 0 end
      if i == 2 then return "Tribes at War", 21, nil, false, false, false, nil, 855 end
    end
    QuestLogFrame = { shown = false, IsShown = function(self) return self.shown end }
    ShowUIPanel = function(f) f.shown = true table.insert(STUB.panels, f) end
    QuestLog_SetSelection = function(i) table.insert(STUB.selected, i) end
    local c = ClaudeWoWDB.chats[1]
    ClaudeWoW.SwitchChat(c.id)
    c.history = { { role = "assistant", t = 1, text = "turn in {quest:855} and {quest:999}" } }
    ClaudeWoW.Render()
    STUB.bubble = (function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b end end end)()
  `);
  const body = vm.evaluate('STUB.bubble.body:GetText()');
  assert.ok(body.includes('|cff7a3b00|Hquest:855:21|h[Tribes at War]|h|r'), 'a clickable quest link with its level, in dark ink: ' + body);
  assert.ok(body.includes('|cff5c5248quest 999|r'), 'a quest not in the log stays plain');
  vm.run('STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, "quest:855:21", "[Tribes at War]", "LeftButton")');
  assert.equal(vm.num('#STUB.panels'), 1, 'the quest log opens');
  assert.equal(vm.num('STUB.selected[1]'), 2, "on that quest's row");
  assert.equal(vm.num('#STUB.refs'), 0, 'and the click is not also sent to the game');
  vm.run('STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, "quest:777:5", "[Gone]", "LeftButton")');
  assert.equal(vm.evaluate('STUB.refs[1]'), 'quest:777:5', 'a quest no longer in the log falls back to the game');
  vm.run(`
    STUB.scrolled, STUB.max = {}, 0
    QUESTLOG_QUEST_HEIGHT = 16
    QuestLog_Update = function() STUB.max = (GetNumQuestLogEntries() - 1) * 16 end
    QuestLogListScrollFrameScrollBar = { SetValue = function(self, v) table.insert(STUB.scrolled, math.min(v, STUB.max)) end }
    STUB.selected = {}
    STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, "quest:855:21", "[Tribes at War]", "LeftButton")
  `);
  assert.equal(vm.num('STUB.scrolled[1]'), 16, 'the list scrolls to the quest row, with the range updated first');
  vm.run(`
    STUB.refs, STUB.texts, STUB.selected = {}, {}, {}
    SetItemRef = function(link, text) table.insert(STUB.refs, link) table.insert(STUB.texts, text) end
    IsModifiedClick = function() return true end
    STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, "quest:855:21", "|cff7a3b00|Hquest:855:21|h[Tribes at War]|h|r", "LeftButton")
    IsModifiedClick = function() return false end
  `);
  assert.equal(vm.evaluate('STUB.refs[1]'), 'quest:855:21', 'a shift-click goes to the game, which puts the link in the chat box');
  assert.equal(
    vm.evaluate('STUB.texts[1]'),
    '|cffffff00|Hquest:855:21|h[Tribes at War]|h|r',
    'with the game color, not the parchment ink, so other players see a normal link',
  );
  assert.equal(vm.num('#STUB.selected'), 0, 'and does not open the quest log');
  vm.run(`
    STUB.collapsed = true
    GetNumQuestLogEntries = function() return STUB.collapsed and 1 or 2 end
    ExpandQuestHeader = function(i) if i == 0 then STUB.collapsed = false end end
    STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, "quest:855:21", "[Tribes at War]", "LeftButton")
  `);
  assert.equal(vm.evaluate('STUB.collapsed'), 'false', 'a quest under a collapsed zone expands the log');
  assert.equal(vm.num('STUB.selected[1]'), 2, 'and still opens on its row');
  vm.run(
    'STUB.collapsed = true; STUB.refs = {}; CollapseQuestHeader = function(i) if i == 1 then STUB.collapsed = true end end; STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, "quest:777:5", "[Gone]", "LeftButton")',
  );
  assert.equal(vm.evaluate('STUB.collapsed'), 'true', 'a quest that is not in the log leaves the zones as they were');
  assert.equal(vm.evaluate('STUB.refs[1]'), 'quest:777:5', 'and goes to the game');
  vm.run(
    'STUB.mapped = {}; QuestMapFrame_OpenToQuestDetails = function(id) table.insert(STUB.mapped, id) end; STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, "quest:855:21", "[Tribes at War]", "LeftButton")',
  );
  assert.equal(vm.num('STUB.mapped[1]'), 855, 'on a client with the quest map (Forever) it opens the quest details there');
  assert.equal(vm.num('#STUB.selected'), 1, 'and not the old quest log');
});

test('a coding reply reads cleanly: bold, code and headings are styled, fences dropped, and GitHub and Linear URLs become short links that open the copy box', () => {
  const vm = nativeVM();
  vm.run(`
    STUB.copied = {}
    ClaudeWoW.ShowCopy = function(text) table.insert(STUB.copied, text) end
    local c = ClaudeWoWDB.chats[1]
    ClaudeWoW.SwitchChat(c.id)
    c.history = { { role = "assistant", t = 1, text = table.concat({
      "## Merge train",
      "I merged **2 of the 3** PRs into \`internal\`.",
      "- **#18610** (PRD-7671): **merged**",
      "\`\`\`bash",
      "gh pr merge 18610",
      "\`\`\`",
      "See [the ticket](https://linear.app/every/issue/PRD-8708/pandl-month) and https://github.com/every-io/every/pull/18632.",
      "Docs: https://example.com/a/very/long/path/that/goes/on/and/on",
      "Ticket: https://linear.app/every/issue/PRD-7671/enrollment-state",
    }, "\\n") } }
    ClaudeWoW.Render()
    STUB.bubble = (function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b end end end)()
  `);
  const body = vm.evaluate('STUB.bubble.body:GetText()');
  assert.ok(!body.includes('**') && !body.includes('`') && !body.includes('## '), 'no raw markdown marks: ' + body);
  assert.ok(body.includes('|cff5c1a00Merge train|r'), 'a heading is emphasized');
  assert.ok(body.includes('|cff5c1a002 of the 3|r'), 'bold is emphasized');
  assert.ok(body.includes('|cff7a2e0einternal|r'), 'inline code has its own ink');
  assert.ok(body.includes('gh pr merge 18610') && !body.includes('bash'), 'fence lines are dropped, the code stays');
  assert.ok(body.includes('|Haddon:claudewow:url:https://linear.app/every/issue/PRD-8708/pandl-month|h[the ticket]|h'), 'a markdown link keeps its label');
  assert.ok(
    body.includes('|Haddon:claudewow:url:https://github.com/every-io/every/pull/18632|h[PR #18632]|h|r.'),
    'a bare PR URL is a short link, its full stop kept outside',
  );
  assert.ok(body.includes('[example.com/a/very/long/path/th…]'), 'another long URL is shortened: ' + body);
  assert.ok(body.includes('|h[PRD-7671]|h'), 'a bare Linear URL is named by its issue key');
  assert.equal((body.match(/\|Haddon:claudewow:url:/g) || []).length, 4, 'each URL becomes exactly one link');
  vm.run('STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, "addon:claudewow:url:https://github.com/every-io/every/pull/18632", "[PR #18632]", "LeftButton")');
  assert.equal(vm.evaluate('STUB.copied[1]'), 'https://github.com/every-io/every/pull/18632', 'a click opens the copy box with the full URL');
});

const parchmentInkReply = 'use `internal` and see https://github.com/o/r/pull/5 and {spell:1752}';
const shownBody = '(function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b.body:GetText() end end end)()';
const renderInkReply = vm =>
  vm.run(`
  C_Spell = { GetSpellLink = function(id) if id == 1752 then return "|cff71d5ff|Hspell:1752|h[Sinister Strike]|h|r" end end }
  local c = ClaudeWoWDB.chats[1]
  ClaudeWoW.SwitchChat(c.id)
  c.history = { { role = "assistant", t = 1, text = "${parchmentInkReply}" } }
  ClaudeWoW.Render()
`);

test('on the parchment, inline code is dark red-brown and links are dark blue, and a shift-clicked link goes back to its game color', () => {
  const vm = nativeVM();
  renderInkReply(vm);
  const body = vm.evaluate(shownBody);
  assert.ok(body.includes('|cff7a2e0einternal|r'), 'inline code is dark red-brown: ' + body);
  assert.ok(body.includes('|cff1c4f9c|Haddon:claudewow:url:https://github.com/o/r/pull/5|h[PR #5]|h|r'), 'a URL link is dark blue: ' + body);
  assert.ok(body.includes('|cff1c4f9c|Hspell:1752|h[Sinister Strike]|h|r'), 'a spell link uses the same dark blue: ' + body);
  assert.ok(!body.includes('ff1f4a5a') && !body.includes('ff00577a') && !body.includes('ff71d5ff'), 'no teal ink is left: ' + body);
  vm.run(`
    STUB.texts = {}
    SetItemRef = function(link, text) table.insert(STUB.texts, text) end
    IsModifiedClick = function() return true end
    local b = (function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b end end end)()
    b.scripts.OnHyperlinkClick(b, "spell:1752", "|cff1c4f9c|Hspell:1752|h[Sinister Strike]|h|r", "LeftButton")
    IsModifiedClick = function() return false end
  `);
  assert.equal(vm.evaluate('STUB.texts[1]'), '|cff71d5ff|Hspell:1752|h[Sinister Strike]|h|r', 'the chat box gets the game link color');
});

test('the dark theme keeps its light code and link ink', () => {
  const vm = newVM();
  open(vm);
  renderInkReply(vm);
  assert.equal(vm.evaluate('ClaudeWoW.UI.parchment'), null, 'this window has no parchment');
  const body = vm.evaluate(shownBody);
  assert.ok(body.includes('|cffa8c8d8internal|r'), 'inline code keeps its light ink: ' + body);
  assert.ok(body.includes('|cff71d5ff|Haddon:claudewow:url:https://github.com/o/r/pull/5|h[PR #5]|h|r'), 'a URL link keeps the game link color: ' + body);
  assert.ok(body.includes('|cff71d5ff|Hspell:1752|h[Sinister Strike]|h|r'), 'and so does a spell link: ' + body);
});

test('code fences keep their lines exactly, and URLs keep their whole path but not the marks or punctuation around them', () => {
  const vm = nativeVM();
  vm.run(`
    local c = ClaudeWoWDB.chats[1]
    ClaudeWoW.SwitchChat(c.id)
    c.history = { { role = "assistant", t = 1, text = table.concat({
      "\`\`\`bash",
      "# install deps",
      "echo \`pwd\` **x** https://a.com {item:2589}",
      "",
      "- not a bullet",
      "\`\`\`",
      "**https://github.com/o/r/pull/99**",
      "file https://github.com/o/r/blob/main/app/(auth)/page.tsx and (see https://b.com/x).",
      "open https://... later",
      "wiki https://en.wikipedia.org/wiki/Foo_(bar) ok",
      "[**bold label**](https://c.com)",
      "(see [PR](https://github.com/o/r/pull/7))",
    }, "\\n") } }
    ClaudeWoW.Render()
    STUB.bubble = (function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b end end end)()
  `);
  const body = vm.evaluate('STUB.bubble.body:GetText()');
  assert.ok(
    body.includes('# install deps\necho `pwd` **x** https://a.com {item:2589}\n\n- not a bullet'),
    'fenced lines, tokens and blank lines stay exactly as written: ' + body,
  );
  assert.ok(
    body.includes('|Haddon:claudewow:url:https://github.com/o/r/pull/99|h[PR #99]|h') && !body.includes('pull/99**'),
    'bold marks stay outside the URL',
  );
  assert.ok(
    body.split('\n').some(l => l.startsWith('|cff5c1a00|cff1c4f9c|Haddon:claudewow:url:https://github.com/o/r/pull/99|h')),
    'and are drawn as bold around the link: ' + body,
  );
  assert.ok(body.includes('url:https://github.com/o/r/blob/main/app/(auth)/page.tsx|h'), 'balanced parentheses stay in the path');
  assert.ok(body.includes('url:https://b.com/x|h') && body.includes('|r).'), 'a closing parenthesis and full stop stay outside');
  assert.ok(body.includes('open https://... later') && !body.includes('url:https://|h'), 'a bare scheme is not a link');
  assert.ok(body.includes('url:https://en.wikipedia.org/wiki/Foo_(bar)|h'), 'a URL that ends in a balanced parenthesis keeps it');
  assert.ok(body.includes('|h[bold label]|h'), 'marks inside a link label are dropped');
  assert.ok(
    body.includes('(see |cff1c4f9c|Haddon:claudewow:url:https://github.com/o/r/pull/7|h[PR]|h|r)'),
    'a markdown link in parentheses leaves the outer one outside',
  );
});

test('clicking a link in a reply opens the link, not the copy box; clicking the text around it still opens the copy box', () => {
  const vm = nativeVM();
  vm.run(`
    STUB.copies, STUB.refs = 0, {}
    ClaudeWoW.ShowCopy = function(text) STUB.copies = STUB.copies + 1 end
    SetItemRef = function(link) table.insert(STUB.refs, link) end
    local c = ClaudeWoWDB.chats[1]
    ClaudeWoW.SwitchChat(c.id)
    c.history = { { role = "assistant", t = 1, text = "turn in |cffffff00|Hquest:361:5|h[A Letter Undelivered]|h|r" } }
    ClaudeWoW.Render()
    STUB.bubble = (function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b end end end)()
    STUB.bubble.scripts.OnHyperlinkClick(STUB.bubble, "quest:361:5", "[A Letter Undelivered]", "LeftButton")
    STUB.bubble.scripts.OnMouseUp(STUB.bubble, "LeftButton")
    STUB.RunTimers()
  `);
  assert.equal(vm.evaluate('STUB.refs[1]'), 'quest:361:5', 'the link goes to the game');
  assert.equal(vm.num('STUB.copies'), 0, 'the same click does not open the copy box');
  vm.run('STUB.now = STUB.now + 1; STUB.bubble.scripts.OnMouseUp(STUB.bubble, "LeftButton"); STUB.RunTimers()');
  assert.equal(vm.num('STUB.copies'), 1, 'a click on plain text still opens the copy box');
});

const shownBodies = vm =>
  vm
    .evaluate(
      '(function() local t = {} for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then table.insert(t, b.body:GetText()) end end return table.concat(t, "\\n@@\\n") end)()',
    )
    .split('\n@@\n');

test('the window leaves out the closing TL;DR block of a reply, but not one in a code fence, one with more text after it, or one that is not the bridge summary', () => {
  const vm = nativeVM();
  vm.run(`
    local c = ClaudeWoWDB.chats[1]
    ClaudeWoW.SwitchChat(c.id)
    c.history = {
      { role = "assistant", t = 1, text = "Renamed the helper.\\nAll green.\\n\\n**TL;DR:** Helper renamed." },
      { role = "assistant", t = 2, text = "Renamed it.\\n\\nTL;DR: Bridge summary.", summary = "Bridge summary." },
      { role = "assistant", t = 3, text = "Example:\\n\`\`\`\\nTL;DR: fenced line\\n\`\`\`" },
      { role = "assistant", t = 4, text = "TL;DR: first\\nline a\\nline b\\nline c\\nline d" },
      { role = "assistant", t = 5, text = "Body here.\\n\\nTL;DR: Short one.\\n\\nbridge note", summary = "Short one." },
      { role = "assistant", t = 6, text = "TL;DR: Just the answer." },
      { role = "user", t = 7, text = "TL;DR: typed by the player" },
      { role = "assistant", t = 8, text = "Checked the logs.\\n## tldr: heading style" },
    }
    ClaudeWoW.Render()
  `);
  const [plain, bridge, fenced, mid, mismatch, only, user, heading] = shownBodies(vm);
  assert.ok(plain.includes('All green.') && !plain.includes('TL;DR') && !plain.includes('Helper renamed'), 'a bold TL;DR block is left out: ' + plain);
  assert.ok(bridge.includes('Renamed it.') && !bridge.includes('Bridge summary'), 'the block the bridge split off is left out: ' + bridge);
  assert.ok(fenced.includes('TL;DR: fenced line'), 'a TL;DR inside a code fence stays: ' + fenced);
  assert.ok(mid.includes('first') && mid.includes('line d'), 'a TL;DR with more text after it stays: ' + mid);
  assert.ok(mismatch.includes('Short one.') && mismatch.includes('bridge note'), 'a tail that is not the bridge summary stays: ' + mismatch);
  assert.ok(only.includes('Just the answer.') && !only.includes('TL;DR'), 'a reply that is only a TL;DR shows its line without the marker: ' + only);
  assert.ok(user.includes('TL;DR: typed by the player'), 'a player message is never cut: ' + user);
  assert.ok(heading.includes('Checked the logs.') && !heading.includes('heading style'), 'a heading-style marker is the same block: ' + heading);
  vm.run(`
    STUB.copied = {}
    ClaudeWoW.ShowCopy = function(text) table.insert(STUB.copied, text) end
    local b = (function() for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then return b end end end)()
    b.scripts.OnMouseUp(b, "LeftButton")
    STUB.RunTimers()
  `);
  assert.equal(vm.evaluate('STUB.copied[1]'), 'Renamed the helper.\nAll green.\n\n**TL;DR:** Helper renamed.', 'the copy box gets the whole reply');
});

const emptyState = vm => ({
  shown: vm.evaluate('ClaudeWoW.UI.empty and ClaudeWoW.UI.empty.shown'),
  title: vm.evaluate('ClaudeWoW.UI.empty and ClaudeWoW.UI.empty.title:GetText()'),
  body: vm.evaluate('ClaudeWoW.UI.empty and ClaudeWoW.UI.empty.body:GetText()'),
  top: -vm.num('ClaudeWoW.UI.empty.y'),
});

test('an empty chat shows a centered empty state with the project, not a system bubble, and setting the project adds no message', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoW.NewChat(); ClaudeWoW.Render()');
  let e = emptyState(vm);
  assert.equal(e.title, 'Restoring your chats', 'fresh saved data waits for the restore in the same style');
  assert.match(e.body, /restoring your chats\.\.\./);
  vm.run('STUB.now = STUB.now + 30; STUB.Tick(); ClaudeWoW.IsConnected = function() return true end; ClaudeWoW.Render()');
  assert.equal(shownBodies(vm).filter(Boolean).length, 0, 'no bubble on an empty chat');
  e = emptyState(vm);
  assert.equal(e.shown, 'true');
  assert.equal(e.title, 'No messages yet');
  assert.match(e.body, /Type below and press Enter/);
  assert.match(e.body, /Project: No project/);
  assert.ok(e.top > 0, 'centered in the parchment, not at the top: ' + e.top);

  vm.run('ClaudeWoWProjectButton.scripts.OnClick(ClaudeWoWProjectButton); STUB.Pick("wow-ai")');
  assert.equal(vm.num('#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history'), 0, 'picking a project writes no "project:" message');
  assert.match(emptyState(vm).body, /Project: wow-ai/, 'the empty state names the new project');

  vm.run('SlashCmdList.CLAUDE("--project nope")');
  const bodies = shownBodies(vm);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], /Unknown project "nope"/, 'a system answer to a command still shows');
  e = emptyState(vm);
  assert.equal(e.shown, 'true', 'a chat with only system lines is still empty');
  assert.ok(e.top > 0, 'below the system line');

  vm.run('ClaudeWoW.IsConnected = function() return false end; ClaudeWoW.Render()');
  e = emptyState(vm);
  assert.equal(e.title, 'Not connected');
  assert.match(e.body, /click Connect below/);

  vm.run('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history = { { role = "user", t = 1, text = "hi" } }; ClaudeWoW.Render()');
  assert.equal(emptyState(vm).shown, 'false', 'a chat with a message has no empty state');
});

test('general chats sit under Chats, project chats under their project, and the project button in the header switches the project', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoW.NewChat("Best rogue race")');
  vm.run('ClaudeWoW.Render()');
  assert.equal(shownHeaders(vm).split('|')[0], 'Chats', 'the section of the most recently active chat comes first');
  assert.ok(shownHeaders(vm).split('|').includes('every') && shownHeaders(vm).split('|').includes('wow-ai'));
  assert.match(vm.evaluate('ClaudeWoWProjectButton.text:GetText()'), /Project: \|cffffffffNo project/);
  vm.run('ClaudeWoWProjectButton.scripts.OnClick(ClaudeWoWProjectButton)');
  const items = vm.evaluate('(function() local t = {} for _, it in ipairs(STUB.menu.items) do table.insert(t, it.text) end return table.concat(t, "|") end)()');
  assert.match(items, /^Project\|No project\|/);
  assert.ok(items.includes('wow-ai'));
  assert.ok(!items.includes('Other folder...'), 'no folder popup from the dropdown: it pushed the window down');
  vm.run('STUB.Pick("wow-ai")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].cwd'), '~/wow-ai');
  assert.match(vm.evaluate('ClaudeWoWProjectButton.text:GetText()'), /wow-ai/);
  vm.run('ClaudeWoWProjectButton.scripts.OnClick(ClaudeWoWProjectButton); STUB.Pick("No project")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].cwd'), '');
});

test('the project button sits at the right end of the header band, and the chat title stops before it', () => {
  const vm = nativeVM();
  assert.equal(vm.evaluate('ClaudeWoWProjectButton:GetParent() == ClaudeWoWTitleBar'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWProjectButton.point .. " " .. ClaudeWoWProjectButton.relPoint'), 'RIGHT RIGHT');
  assert.equal(vm.evaluate('ClaudeWoWProjectButton.rel == ClaudeWoWTitleBar'), 'true');
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatTitle.rel == ClaudeWoWProjectButton'), 'true', 'the title truncates before it reaches the button');
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatTitle.point .. " " .. ClaudeWoW.UI.chatTitle.relPoint .. " " .. ClaudeWoW.UI.chatTitle.x'), 'RIGHT LEFT -8');
  vm.run('STUB.renames = 0; local real = ClaudeWoW.RenamePrompt; ClaudeWoW.RenamePrompt = function(...) STUB.renames = STUB.renames + 1 return real(...) end');
  vm.run('ClaudeWoWProjectButton.scripts.OnClick(ClaudeWoWProjectButton, "LeftButton")');
  assert.equal(vm.num('STUB.renames'), 0, 'a click on the project button opens the project menu, not the rename prompt');
  assert.match(vm.evaluate('STUB.menu.items[1].text'), /^Project$/);
});

test('a long project label truncates inside a bounded button, shows in full in the tooltip, and the bound follows the window size', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoW.SetFolder("~/a-very-long-project-folder-name-for-the-header", ClaudeWoWDB.chats[#ClaudeWoWDB.chats])');
  vm.run('ClaudeWoWProjectButton.text.GetStringWidth = function() return 400 end; ClaudeWoWTitleBar.width = 400; ClaudeWoW.Render()');
  assert.equal(vm.num('ClaudeWoWProjectButton:GetWidth()'), 200, 'half the header band at most');
  assert.equal(vm.num('ClaudeWoWProjectButton.text:GetWidth()'), 192, 'the label is cut to the button');
  vm.run('ClaudeWoWTitleBar.width = 188; for _, fn in ipairs(ClaudeWoWTitleBar.hooks.OnSizeChanged) do fn(ClaudeWoWTitleBar) end');
  assert.equal(vm.num('ClaudeWoWProjectButton:GetWidth()'), 94, 'a narrow window narrows the button');
  vm.run('ClaudeWoWTitleBar.width = 2000; for _, fn in ipairs(ClaudeWoWTitleBar.hooks.OnSizeChanged) do fn(ClaudeWoWTitleBar) end');
  assert.equal(vm.num('ClaudeWoWProjectButton:GetWidth()'), 240, 'a wide window still caps the button');
  vm.run('ClaudeWoWProjectButton.scripts.OnEnter(ClaudeWoWProjectButton)');
  assert.equal(vm.evaluate('GameTooltip:GetText()'), 'Project: a-very-long-project-folder-name-for-the-header');
  vm.run('ClaudeWoWProjectButton.text.GetStringWidth = function() return 40 end; ClaudeWoW.Render()');
  assert.equal(vm.num('ClaudeWoWProjectButton:GetWidth()'), 60, 'a short label keeps the minimum width');
});

test('without native frames the project button stays in the composer and never runs past the box edge', () => {
  const vm = newVM();
  open(vm);
  vm.run('ClaudeWoW.SetFolder("~/a-very-long-project-folder-name-for-the-composer", ClaudeWoWDB.chats[1]); ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatTitle'), null);
  assert.equal(vm.evaluate('ClaudeWoWProjectButton.point'), 'BOTTOMRIGHT');
  vm.run('ClaudeWoWProjectButton.text.GetStringWidth = function() return 1000 end; ClaudeWoW.Render()');
  const box = vm.num('ClaudeWoWProjectButton:GetParent():GetWidth()');
  assert.ok(vm.num('ClaudeWoWProjectButton:GetWidth()') <= box - 16, 'the button fits inside the composer');
  assert.ok(vm.num('ClaudeWoWProjectButton:GetRight()') <= vm.num('ClaudeWoWProjectButton:GetParent():GetRight()'));
  assert.ok(vm.num('ClaudeWoWProjectButton:GetLeft()') >= vm.num('ClaudeWoWProjectButton:GetParent():GetLeft()'));
});

test('a quiet plugin chat stays out of the chat list, the count, the minimized badge and /claude-wow chats', () => {
  const vm = nativeVM();
  const quiet = vm.evaluate('ClaudeWoW.AddChat("Stream control", { cwd = "", plugin = "stream", quiet = true }).id');
  vm.run('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].pendingId = 7; ClaudeWoW.Render()');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 4);
  assert.ok(!shownRows(vm).split('|').includes('Stream control'), shownRows(vm));
  assert.equal(shownRows(vm).split('|').length, 3);
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatCount:GetText()'), 'Chats: |cffffffff3|r');
  vm.run('ClaudeWoW.UpdateMini()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.miniBadge:GetText()'), '|cffccccccReady|r', 'a plugin send does not show as work');

  vm.run('SlashCmdList.CLAUDEWOW("chats")');
  const listing = vm.evaluate(
    '(function() for _, ch in ipairs(ClaudeWoWDB.chats) do for _, m in ipairs(ch.history) do if tostring(m.text):find("^Chats:") then return m.text end end end end)()',
  );
  assert.match(listing, /^Chats:\n1\. /);
  assert.ok(!listing.includes('Stream control'), listing);
  vm.run('SlashCmdList.CLAUDEWOW("chat 4")');
  assert.notEqual(vm.evaluate('ClaudeWoWDB.activeChat'), quiet, 'its index cannot open it');
  vm.run('SlashCmdList.CLAUDEWOW("chat Stream control")');
  assert.notEqual(vm.evaluate('ClaudeWoWDB.activeChat'), quiet, 'its name cannot open it');
});

test('the chat list shows the newest chat first, keeps its order when a chat is opened, and scrolls only to bring an opened chat into view', () => {
  const vm = nativeVM();
  vm.run('for i = 1, 20 do ClaudeWoW.NewChat() end');
  vm.run('ClaudeWoW.UI.questList.scroll.height = 200; ClaudeWoW.Render()');
  const scroll = () => vm.num('ClaudeWoW.UI.questList.scroll:GetVerticalScroll()');
  const firstRow = () =>
    vm.evaluate(
      '(function() local best for _, r in ipairs(ClaudeWoW.UI.questList.rows) do if r.shown and (not best or r.y > best.y) then best = r end end return best and best.chatId end)()',
    );
  assert.equal(firstRow(), vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].id'), 'the newest chat is the top row');
  assert.equal(scroll(), 0, 'the new chat is already in view at the top');
  vm.run('ClaudeWoW.UI.questList.scroll:SetVerticalScroll(300); ClaudeWoW.Render()');
  assert.equal(scroll(), 300, "a render with the same active chat keeps the player's scroll");
  vm.run('ClaudeWoW.UI.questList.scroll:SetVerticalScroll(0); STUB.now = STUB.now + 10; ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id)');
  assert.equal(firstRow(), vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].id'), 'opening the oldest chat does not move it to the top');
  assert.ok(scroll() > 0, 'the list scrolls down to the opened chat instead');
  const kept = scroll();
  const inView = vm.evaluate(
    `(function() for _, r in ipairs(ClaudeWoW.UI.questList.rows) do if r.shown and not r.active and -r.y >= ${kept} and -r.y + r.height <= ${kept} + 200 then return r.chatId end end end)()`,
  );
  assert.ok(inView, 'another chat row is in view');
  vm.run(`STUB.now = STUB.now + 10; ClaudeWoW.SwitchChat("${inView}")`);
  assert.equal(scroll(), kept, 'opening a chat already in view does not scroll');
});

test('the window is built from Blizzard frame templates where the client has them: portrait, title bar, close button, parchment and a quest-log chat list', () => {
  const vm = nativeVM();
  assert.equal(vm.evaluate('ClaudeWoWFrame.template'), 'ButtonFrameTemplate');
  assert.equal(vm.evaluate('ClaudeWoWFrame.portrait'), 'Interface\\AddOns\\ClaudeWoW\\Portrait');
  assert.equal(vm.evaluate('ClaudeWoWFrame.Inset.shown'), 'false', 'the template inset is replaced by our own panels');
  assert.equal(vm.evaluate('ClaudeWoW.UI.title == ClaudeWoWFrame.TitleText'), 'true', 'the title goes in the Blizzard title bar');
  assert.equal(vm.evaluate('ClaudeWoW.UI.minimize == ClaudeWoWFrame.CloseButton'), 'true', 'the red close button collapses to the bar');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.listBg'), 'QuestLog-main-background');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.parchment'), 'QuestBG-Parchment', 'the transcript sits on quest parchment');
  assert.equal(vm.evaluate('ClaudeWoWScroll.parent == ClaudeWoW.UI.parchment'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWChatSearch.template'), 'SearchBoxTemplate');
  assert.equal(vm.evaluate('ClaudeWoWScroll.template'), 'ScrollFrameTemplate', 'the transcript uses the thin Blizzard scroll bar');
  assert.equal(vm.evaluate('ClaudeWoWInputScroll.template'), null, 'the input box has no arrow scroll bar');
  assert.equal(vm.evaluate('ClaudeWoWInput.scripts.OnCursorChanged == ScrollingEdit_OnCursorChanged'), 'true', 'it follows the cursor the Blizzard way');
  assert.equal(vm.evaluate('ClaudeWoW.UI.cwd.shown'), 'false', 'the breadcrumbs replace the cwd footer');
  assert.equal(vm.evaluate('ClaudeWoWWindow.skinned'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWFrame.claudewowBorder'), null, 'no extra border on top of the template');

  assert.equal(shownHeaders(vm), 'every|wow-ai', 'chats are grouped under folder headers in first-seen order');
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatCount:GetText()'), 'Chats: |cffffffff3|r');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.frame'), 'questlog-frame');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.filigree'), 'questlog-frame-filigree');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.poi'), 'UI-QuestPoi-QuestNumber', 'each chat has a round POI button');
  const shownLines = index =>
    vm.num(`(function() local n = 0 for _, l in ipairs(${rowOf(index)}.objectives) do if l.text.shown then n = n + 1 end end return n end)()`);
  assert.equal(shownLines(2), 0, 'an idle chat with no messages has no objective line');
  assert.equal(vm.evaluate(`${rowOf(2)}.when:GetText()`), '', 'no time without messages');
  assert.equal(vm.evaluate(`${rowOf(2)}.label == ${rowOf(2)}.title`), 'true');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.minus'), 'common-button-list-minus');

  vm.run('ClaudeWoW.UI.questList.headers[1].scripts.OnClick(ClaudeWoW.UI.questList.headers[1])');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.collapsedFolders.every'), 'true');
  assert.equal(shownRows(vm), 'Fix the bridge', 'a collapsed folder hides its chats');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.plus'), 'common-button-list-plus');
  vm.run('ClaudeWoW.UI.questList.headers[1].scripts.OnClick(ClaudeWoW.UI.questList.headers[1])');

  vm.run('ClaudeWoWChatSearch:SetText("leather"); for _, fn in ipairs(ClaudeWoWChatSearch.hooks.OnTextChanged) do fn(ClaudeWoWChatSearch) end');
  assert.equal(shownRows(vm), 'Leatherworking route', 'search filters by chat name');
  assert.equal(shownHeaders(vm), 'every');
  vm.run('ClaudeWoWChatSearch:SetText("zzz"); for _, fn in ipairs(ClaudeWoWChatSearch.hooks.OnTextChanged) do fn(ClaudeWoWChatSearch) end');
  assert.equal(vm.evaluate('ClaudeWoW.UI.questList.empty.shown'), 'true');
  vm.run('ClaudeWoWChatSearch:SetText(""); for _, fn in ipairs(ClaudeWoWChatSearch.hooks.OnTextChanged) do fn(ClaudeWoWChatSearch) end');

  vm.run(
    'ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[3].id); table.insert(ClaudeWoWDB.chats[2].history, { role = "user", text = "hi", t = time() }); ClaudeWoWDB.chats[2].unread = 1; ClaudeWoW.Render()',
  );
  assert.equal(vm.evaluate(`${rowOf(2)}.objectives[1].text.shown`), 'true');
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings); STUB.Pick("Show message previews")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.chatPreviews'), 'false', 'the gear menu turns message previews off');
  assert.equal(vm.evaluate(`${rowOf(2)}.objectives[1].text.shown`), 'false');
  assert.equal(vm.evaluate(`${rowOf(2)}.when:GetText()`), '12:00', 'the time stays with previews off');
  assert.equal(titleColorOf(vm, 1), '0.75,0.61,0', 'with previews off an empty chat keeps the idle title');
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings); STUB.Pick("Show message previews")');
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings); STUB.Pick("Collapse all folders")');
  assert.equal(shownRows(vm), '', 'collapse all hides every chat');
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings); STUB.Pick("Expand all folders")');
  assert.equal(vm.evaluate('ClaudeWoW.UI.art.reply'), 'UI-QuestIcon-TurnIn-Normal', 'an unread reply shows the turn-in icon');

  vm.run('ClaudeWoWFrame.CloseButton.scripts.OnClick(ClaudeWoWFrame.CloseButton)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWMini.shown'), 'true');
});

test('a chat row shows one preview line, the last message time beside the title, and the count in its tooltip', () => {
  const vm = nativeVM();
  const shownLines = index =>
    vm.num(`(function() local n = 0 for _, l in ipairs(${rowOf(index)}.objectives) do if l.text.shown then n = n + 1 end end return n end)()`);
  vm.run(`date = function(fmt, t) if fmt == "%Y-%m-%d" then return t == time() and "today" or "before" end return fmt == "%b %d" and "Oct 02" or "18:01" end
    local h = ClaudeWoWDB.chats[2].history
    table.insert(h, { role = "user", text = "why is it down", t = time() - 90000 })
    table.insert(h, { role = "assistant", agent = "claude", text = "Factory run done\\nsecond line", t = time() })
    table.insert(ClaudeWoWDB.chats[3].history, { role = "user", text = "route please", t = time() - 90000 })
    ClaudeWoW.Render()`);
  assert.equal(shownLines(2), 1, 'an idle chat shows one objective line: the preview');
  assert.match(vm.evaluate(`${rowOf(2)}.objectives[1].text:GetText()`), /: Factory run done$/);
  assert.equal(vm.evaluate(`${rowOf(2)}.when:GetText()`), '18:01', 'today shows the clock time');
  assert.equal(vm.evaluate(`${rowOf(3)}.when:GetText()`), 'Oct 02', 'an older day shows the date');
  assert.equal(vm.evaluate(`${rowOf(2)}.title.rel == ${rowOf(2)}.when`), 'true', 'the title truncates before the time');
  vm.run(`local r = ${rowOf(2)}; r.scripts.OnEnter(r)`);
  assert.equal(vm.evaluate('GameTooltip:GetText()'), 'Fix the bridge');
  assert.equal(vm.evaluate('table.concat(GameTooltip.lines, "|")'), '2 messages, last at 18:01');
  vm.run(`local r = ${rowOf(1)}; r.scripts.OnEnter(r)`);
  assert.equal(vm.evaluate('table.concat(GameTooltip.lines, "|")'), 'No messages yet');
  vm.run(`local r = ${rowOf(1)}; r.scripts.OnLeave(r)`);
  assert.equal(vm.evaluate('GameTooltip.shown'), 'false');
  vm.run('ClaudeWoWDB.chats[2].history = {}; ClaudeWoWDB.chats[2].pendingId = 7; ClaudeWoW.Render()');
  assert.equal(shownLines(2), 1, 'a working chat with a cleared history keeps its line');
  assert.match(vm.evaluate(`${rowOf(2)}.objectives[1].text:GetText()`), /^Working: /);
  assert.equal(titleColorOf(vm, 2), '1,1,0', 'and its working title color');
  vm.run('ClaudeWoWDB.chats[2].pendingId = nil; ClaudeWoW.Render()');
});

test('the black bar shows the chat title up to the project button, with folder, agent and plugin in its tooltip', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[2].id)');
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatTitle:GetText()'), 'Fix the bridge');
  assert.equal(vm.evaluate('ClaudeWoWFrame.TitleText:GetText()'), 'Claude', 'the window title is just Claude and does not repeat the chat title');
  assert.equal(vm.num('#STUB.nav.buttons'), 0, 'no folder, agent or plugin crumbs');
  assert.equal(vm.evaluate('STUB.nav.home'), null);

  vm.run('ClaudeWoWDB.chats[2].name = "Renamed"; ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatTitle:GetText()'), 'Renamed', 'the bar follows a rename');

  vm.run('LINES = {}; GameTooltip.AddDoubleLine = function(_, a, b) table.insert(LINES, a .. "=" .. b) end');
  vm.run('ClaudeWoWTitleBar.scripts.OnEnter(ClaudeWoWTitleBar)');
  assert.equal(vm.evaluate('table.concat(LINES, "|")'), 'Folder=wow-ai|Agent=AI|Plugin=default');

  vm.run(
    'CALLS = {}; ClaudeWoW.RenamePrompt = function(id) table.insert(CALLS, "rename:" .. id) end; ClaudeWoW.ShowChatMenu = function(id) table.insert(CALLS, "menu:" .. id) end',
  );
  vm.run('ClaudeWoWTitleBar.scripts.OnClick(ClaudeWoWTitleBar, "LeftButton"); ClaudeWoWTitleBar.scripts.OnClick(ClaudeWoWTitleBar, "RightButton")');
  const id = vm.evaluate('ClaudeWoWDB.chats[2].id');
  assert.equal(vm.evaluate('table.concat(CALLS, "|")'), `rename:${id}|menu:${id}`);
});

test('help lives in the gear menu, and Clear moves from the bottom bar into the chat menu', () => {
  const vm = nativeVM();
  const active = '(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then return c end end end)()';
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings); STUB.Pick("Commands and tips")');
  assert.ok(vm.evaluate(`${active}.history[#${active}.history].text`).includes('/claude'));
  assert.equal(vm.evaluate('ClaudeWoWHelpButton'), null, 'no help button crowds the breadcrumb bar');

  const clearButton = '(function() for _, c in ipairs(ClaudeWoWFrame.children) do if c.kind == "Button" and c.text == "Clear" then return c end end end)()';
  assert.equal(vm.evaluate(`${clearButton}.shown`), 'false', 'no Clear button in the bottom bar');
  vm.run(`ClaudeWoW.ShowChatMenu(ClaudeWoWDB.activeChat, ClaudeWoWFrame); STUB.Pick("Clear messages")`);
  assert.equal(vm.num(`#${active}.history`), 0, 'the chat menu clears the chat');
});

test('the footer is a short state on the left and context and spend on the right, with the detail on hover', () => {
  const vm = nativeVM();
  vm.run(
    'ClaudeWoWDB.settings.contextWarn = 0; ClaudeWoWDB.chats[1].window = nil; ClaudeWoWDB.chats[1].cost = 2.414; ClaudeWoWDB.chats[1].ctx = 186700; ClaudeWoWDB.chats[2].cost = 12.39; ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id); ClaudeWoW.Render()',
  );
  const stats = vm.evaluate('ClaudeWoW.UI.stats:GetText()');
  assert.ok(stats.includes('UI-GoldIcon'), stats);
  assert.ok(stats.includes('$2.41'), "this chat's spend: " + stats);
  assert.ok(stats.includes('all chats $14.80'), 'and the total across chats: ' + stats);
  assert.equal(vm.evaluate('ClaudeWoWContextBar.shown'), 'true', 'the context is a bar');
  assert.ok(vm.evaluate('ClaudeWoWContextBar.text:GetText()').startsWith('186.7k / 200'), vm.evaluate('ClaudeWoWContextBar.text:GetText()'));
  const color = () => vm.evaluate('(function() return string.format("%.2f,%.2f", ClaudeWoWContextBar.color[1], ClaudeWoWContextBar.color[2]) end)()');
  assert.equal(color(), '0.85,0.10', '93% full is red');
  vm.run('ClaudeWoWDB.chats[1].ctx = 80000; ClaudeWoW.UpdateStatus()');
  assert.equal(color(), '0.10,0.75', '40% is green');
  vm.run('ClaudeWoWDB.chats[1].ctx = 130000; ClaudeWoW.UpdateStatus()');
  assert.equal(color(), '1.00,0.82', '65% is yellow');
  vm.run('ClaudeWoWDB.chats[1].ctx = 170000; ClaudeWoW.UpdateStatus()');
  assert.equal(color(), '1.00,0.50', '85% is orange');
  vm.run('ClaudeWoWDB.chats[1].window = 1000000; ClaudeWoW.UpdateStatus()');
  assert.equal(color(), '0.10,0.75', 'measured against the model window when the agent reports one');
  const tick = 'ClaudeWoWContextBar.tick';
  assert.equal(vm.evaluate(`${tick}.shown`), 'false', 'no warning mark when the warning is off');

  vm.run('ClaudeWoWDB.settings.contextWarn = 100000; ClaudeWoWDB.chats[1].window = 1000000; ClaudeWoWDB.chats[1].ctx = 129900; ClaudeWoW.UpdateStatus()');
  assert.equal(vm.evaluate(`${tick}.shown`), 'true', 'the warning mark shows on the bar');
  assert.equal(vm.num(`${tick}.x`), 12, 'the mark sits at 100k of a 1.0M window on a 120 px bar');
  assert.equal(vm.evaluate(`${tick}.point`), 'TOP');
  assert.equal(vm.evaluate(`${tick}.relPoint`), 'TOPLEFT');
  assert.equal(color(), '1.00,0.50', 'past the warning mark the bar is at least orange');
  vm.run('ClaudeWoWDB.chats[1].ctx = 99000; ClaudeWoW.UpdateStatus()');
  assert.equal(color(), '0.10,0.75', 'under the warning mark the window fraction decides');
  vm.run('ClaudeWoWDB.chats[1].window = 200000; ClaudeWoWDB.chats[1].ctx = 186700; ClaudeWoW.UpdateStatus()');
  assert.equal(vm.num(`${tick}.x`), 60, 'the mark moves with the window');
  assert.equal(color(), '0.85,0.10', 'red stays red past the warning mark');
  vm.run('ClaudeWoWDB.settings.contextWarn = 300000; ClaudeWoW.UpdateStatus()');
  assert.equal(vm.evaluate(`${tick}.shown`), 'false', 'no mark when the warning is past the window');
  vm.run('ClaudeWoWDB.settings.contextWarn = 200000; ClaudeWoW.UpdateStatus()');
  assert.equal(vm.evaluate(`${tick}.shown`), 'false', 'no mark when the warning is the window end');
  vm.run('ClaudeWoWDB.chats[1].ctx = nil; ClaudeWoW.UpdateStatus()');
  assert.equal(vm.evaluate('ClaudeWoWContextBar.shown'), 'false', 'no bar without a context size');

  vm.run('ClaudeWoWDB.chats[1].pendingId = 159; ClaudeWoW.UpdateStatus()');
  const status = vm.evaluate('ClaudeWoW.UI.status:GetText()');
  assert.ok(status.includes('Working') && !status.includes('#159'), 'a short state, not the full line: ' + status);
  assert.ok(vm.evaluate('ClaudeWoW.UI.cwd.shown') === 'false');
});

test("an empty, unfocused input shows a hint naming the chat's agent; typing or focus hides it", () => {
  const vm = newVM({
    before:
      NATIVE_TEMPLATES +
      `
    function ScrollingEdit_OnTextChanged(self, scrollFrame) STUB.textScroll = scrollFrame end`,
  });
  open(vm);
  const hint = 'ClaudeWoW.UI.placeholder';
  const fire = name => vm.run(`for _, fn in ipairs(ClaudeWoWInput.hooks.${name} or {}) do fn(ClaudeWoWInput) end`);
  vm.run(
    'ClaudeWoWDB.chats[1].agent = "claude"; ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id); ClaudeWoWInput:ClearFocus(); ClaudeWoWInput:SetText(""); ClaudeWoW.Render()',
  );
  assert.equal(
    vm.evaluate(`${hint}.parent == ClaudeWoWInput:GetParent():GetParent()`),
    'true',
    'it sits on the input background, not on the scrolling edit box',
  );
  assert.equal(vm.evaluate(`${hint}.shown`), 'true');
  assert.equal(vm.evaluate(`${hint}:GetText()`), 'Message Claude', 'a short hint that fits the box');
  assert.equal(vm.evaluate('type(ClaudeWoWInput.scripts.OnTextChanged)'), 'function', 'the scrolling text handler is kept');

  vm.run('ClaudeWoWInput:SetText("hi")');
  fire('OnTextChanged');
  assert.equal(vm.evaluate(`${hint}.shown`), 'false', 'typed text hides it');
  vm.run('ClaudeWoWInput:SetText("")');
  fire('OnTextChanged');
  assert.equal(vm.evaluate(`${hint}.shown`), 'true', 'clearing the text shows it again');

  vm.run('ClaudeWoWInput:SetFocus()');
  fire('OnEditFocusGained');
  assert.equal(vm.evaluate(`${hint}.shown`), 'false', 'focus hides it');
  vm.run('ClaudeWoWInput:ClearFocus()');
  fire('OnEditFocusLost');
  assert.equal(vm.evaluate(`${hint}.shown`), 'true', 'losing focus with no text shows it');

  vm.run(
    'ClaudeWoW.NewChat(); ClaudeWoWDB.chats[2].agent = "codex"; ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[2].id); ClaudeWoWInput:ClearFocus(); ClaudeWoW.Render()',
  );
  assert.equal(vm.evaluate(`${hint}:GetText()`), 'Message Codex', 'the name follows the chat');
});

test('the input box, Send and New chat sit on one footer line, as 22 px Blizzard buttons, and Send names its key and the help command on hover', () => {
  const vm = nativeVM();
  const box = 'ClaudeWoWInputScroll.parent';
  const anchor = f => vm.evaluate(`(function() local f = ${f} return f.point .. "," .. f.relPoint .. "," .. f.x .. "," .. f.y end)()`);
  for (const b of ['ClaudeWoW.UI.send', 'ClaudeWoW.UI.connect', 'ClaudeWoW.UI.newChat']) {
    assert.equal(vm.num(`${b}:GetHeight()`), 22, `${b} has the UIPanelButtonTemplate height`);
    assert.equal(vm.evaluate(`${b}.template`), 'UIPanelButtonTemplate');
  }
  for (const b of ['ClaudeWoW.UI.send', 'ClaudeWoW.UI.connect']) {
    assert.equal(vm.evaluate(`${b}.rel == ${box}`), 'true');
    assert.equal(anchor(b), 'BOTTOMLEFT,BOTTOMRIGHT,6,0', `${b} sits on the input box's bottom edge, 6 px to its right`);
  }
  assert.equal(vm.evaluate(`${box}.rel == ClaudeWoW.UI.listPanel and ClaudeWoW.UI.newChat.rel == ClaudeWoW.UI.listPanel`), 'true');
  const newChatY = vm.num('ClaudeWoW.UI.newChat.y');
  assert.equal(
    anchor(box),
    `BOTTOMRIGHT,BOTTOMLEFT,${-6 - 84 - 6},${newChatY}`,
    'the box ends on the same line as New chat, one 6 px gap before Send and one after',
  );
  assert.equal(anchor('ClaudeWoW.UI.newChat'), `BOTTOM,BOTTOM,0,${newChatY}`);

  vm.run('ClaudeWoW.UI.send.scripts.OnEnter(ClaudeWoW.UI.send)');
  assert.equal(vm.evaluate('GameTooltip:GetText()'), 'Send (Enter)');
  assert.equal(vm.evaluate('table.concat(GameTooltip.lines, "|")'), '/claude help lists commands.');
  vm.run('ClaudeWoW.UI.send.scripts.OnLeave(ClaudeWoW.UI.send)');
  assert.equal(vm.evaluate('GameTooltip.shown'), 'false');
});

test('a chat row with no preview line keeps the same spacing before the next row as one with a preview line', () => {
  const vm = nativeVM();
  vm.run(`ClaudeWoW.NewChat(); ClaudeWoWDB.chats[4].name = "Chat 4"; ClaudeWoW.SetFolder("~/every-io/every", ClaudeWoWDB.chats[4])
    table.insert(ClaudeWoWDB.chats[3].history, { role = "user", text = "route please", t = time() + 60 })
    ClaudeWoW.Render()`);
  const rows = JSON.parse(
    vm.evaluate(`(function()
      local out = {}
      for _, r in ipairs(ClaudeWoW.UI.questList.rows) do
        if r.shown then
          local lines = 0
          for _, l in ipairs(r.objectives) do if l.text.shown then lines = lines + 1 end end
          table.insert(out, string.format('{"top":%d,"height":%d,"lines":%d}', -r.y, r.height, lines))
        end
      end
      return "[" .. table.concat(out, ",") .. "]"
    end)()`),
  ).sort((a, b) => a.top - b.top);
  const titleH = 14;
  const lineH = 14;
  const textBottom = r => r.top + 8 + titleH + (r.lines > 0 ? 3 + r.lines * lineH + (r.lines - 1) * 2 : 0);
  const gaps = { bare: [], preview: [] };
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    if (b.top !== a.top + a.height - 3) continue;
    gaps[a.lines > 0 ? 'preview' : 'bare'].push(b.top + 8 - textBottom(a));
    assert.ok(b.top + 4 >= a.top + 4 + 20 + 3, 'the next POI disc never touches this one');
  }
  assert.ok(gaps.bare.length > 0 && gaps.preview.length > 0, JSON.stringify(rows));
  assert.ok(Math.min(...gaps.bare) >= Math.max(...gaps.preview), 'no crowding under an empty row: ' + JSON.stringify(gaps));
  for (const r of rows) assert.ok(r.height >= 4 + 20 + 6, 'a row is never shorter than its POI disc and the bottom padding');
});

test("beside the world map the window takes the map's top and height, and goes home at its own size when the map closes", () => {
  const vm = newVM();
  open(vm);
  const home = rect(vm);
  const top = 1080 - 106;
  vm.run(`WorldMapFrame.rect = { left = 0, right = 610, top = ${top}, bottom = ${top - 438} }; ShowUIPanel(WorldMapFrame)`);
  settle(vm);
  assert.deepEqual(rect(vm), { left: 618, right: 618 + 780, top, bottom: top - 438 }, 'top and bottom edges line up with the map, 8 px to its right');
  assert.equal(vm.evaluate('ClaudeWoWWindow.state.dodged'), 'true');
  assert.equal(vm.num('ClaudeWoWWindow.Layout().h'), 500, 'the saved size is not touched');

  vm.run('HideUIPanel(WorldMapFrame)');
  settle(vm);
  assert.deepEqual(rect(vm), home, 'home again at its own size');

  vm.run('UIParent:SetSize(1300, 1080); ShowUIPanel(WorldMapFrame)');
  settle(vm);
  assert.deepEqual(rect(vm), { left: 618, right: 1300, top, bottom: top - 438 }, 'a narrower screen: it narrows to fit beside the map');

  vm.run('HideUIPanel(WorldMapFrame); UIParent:SetSize(1100, 1080); ShowUIPanel(WorldMapFrame)');
  settle(vm);
  const r = rect(vm);
  assert.ok(r.right - r.left >= 560 && !overlaps(r, panelRect(vm, 'WorldMapFrame')), 'no room beside it: it steps aside as for any panel');
  assert.notEqual(r.top - r.bottom, 438);
});
