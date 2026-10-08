'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const LEGACY = 'CLICK ClaudeWoWRefreshButton:LeftButton';

function newVM({ before = '', saved = '' } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = code => {
    const buf = to_luastring(code);
    if (lauxlib.luaL_loadstring(L, buf) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
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
  run(BINDINGS);
  if (before) run(before);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'LootRoll.lua', 'Window.lua', 'Help.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'));
  if (saved) run(saved);
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate, num };
}

const BINDINGS = `
  STUB.saves = 0
  function GetBindingKey(action)
    local keys = {}
    for key, cmd in pairs(STUB.bindings) do if cmd == action then table.insert(keys, key) end end
    table.sort(keys)
    return (table.unpack or unpack)(keys)
  end
  function SaveBindings(set) STUB.saves = STUB.saves + 1; STUB.savedSet = set end
`;

const NATIVE = `
  local templates = { ButtonFrameTemplate = true, InsetFrameTemplate = true, SearchBoxTemplate = true, ScrollFrameTemplate = true, NavBarTemplate = true }
  C_XMLUtil = { GetTemplateInfo = function(name) if templates[name] then return { type = "Frame" } end end }
  function NavBar_Initialize() end
  function NavBar_Reset() end
  function NavBar_AddButton() end
  function ScrollingEdit_OnCursorChanged() end
  function ScrollingEdit_OnTextChanged() end
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
  end
`;

const MENU_UTIL = `
  local function Item(node, it) it.enabled = true; function it:SetEnabled(v) self.enabledArg = v; if type(v) == "function" then self.enabled = v(self) and true or false else self.enabled = v end end; table.insert(node.items, it); return it end
  local function Node() local n = { items = {} }
    function n:CreateTitle(t) table.insert(self.items, { title = t }) end
    function n:CreateButton(t, fn) return Item(self, { text = t, fn = fn }) end
    function n:CreateCheckbox(t, get, fn) return Item(self, { text = t, fn = fn, get = get }) end
    function n:CreateRadio(t, get, fn) return Item(self, { text = t, fn = fn, get = get, radio = true }) end
    function n:CreateDivider() table.insert(self.items, { divider = true }) end
    return n
  end
  MenuUtil = { CreateContextMenu = function(owner, gen) local root = Node(); STUB.menu = root; gen(owner, root) end }
`;

const open = vm => {
  vm.run('ClaudeWoW.Toggle(true); STUB.RunTimers(); STUB.RunTimers()');
};
const resize = (vm, w) => vm.run(`ClaudeWoWFrame:SetSize(${w}, 500); for _, fn in ipairs(ClaudeWoWFrame.hooks.OnSizeChanged or {}) do fn(ClaudeWoWFrame) end`);
const nativeVM = (extra = '') => {
  const vm = newVM({ before: NATIVE + extra });
  open(vm);
  return vm;
};
const menuTexts = vm =>
  vm.evaluate('(function() local t = {} for _, it in ipairs(STUB.menu.items) do table.insert(t, it.title or it.text) end return table.concat(t, "|") end)()');
const fallbackRows = vm =>
  JSON.parse(
    vm.evaluate(
      '(function() local t = {} for _, r in ipairs(ClaudeWoWChatMenu.rows) do if r.shown then t[#t + 1] = string.format("{\\"text\\":%q,\\"disabled\\":%s,\\"mark\\":%s,\\"on\\":%s}", r.label.text or "", tostring(r.disabled == true), tostring(r.check.shown), tostring(r.check.stubTexCoord ~= nil and r.check.stubTexCoord[1] == 0)) end end return "[" .. table.concat(t, ",") .. "]" end)()',
    ),
  );
const clickRow = (vm, text) =>
  vm.run(`for _, r in ipairs(ClaudeWoWChatMenu.rows) do if r.shown and r.label.text == "${text}" then r.scripts.OnClick(r) end end`);

test('the chat list takes 38% of the window between 200 and 300 px, and follows a resize', () => {
  const vm = nativeVM();
  assert.equal(vm.num('ClaudeWoWFrame:GetWidth()'), 780);
  assert.equal(vm.num('ClaudeWoW.UI.listPanel:GetWidth()'), 296, 'default width: 0.38 x 780');
  assert.equal(vm.num('ClaudeWoW.UI.newChat:GetWidth()'), 284);
  resize(vm, 560);
  assert.equal(vm.num('ClaudeWoW.UI.listPanel:GetWidth()'), 212, 'the 560 px minimum: 0.38 x 560');
  assert.equal(vm.num('ClaudeWoW.UI.newChat:GetWidth()'), 200);
  assert.equal(vm.num('ClaudeWoW.UI.questList.empty:GetWidth()'), 152);
  resize(vm, 1400);
  assert.equal(vm.num('ClaudeWoW.UI.listPanel:GetWidth()'), 300, 'capped at 300');
  resize(vm, 400);
  assert.equal(vm.num('ClaudeWoW.UI.listPanel:GetWidth()'), 200, 'never under the 200 px floor');
});

test('at 560 px the chat title keeps 80 px of the header band; at the default width the labels fit in full', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoW.SetFolder("~/wow-ai", ClaudeWoWDB.chats[1]); ClaudeWoW.Render()');
  const band = (w, list) => w - 60 - 6 - list - 6;
  const layout = w => {
    resize(vm, w);
    const width = band(w, vm.num('ClaudeWoW.UI.listPanel:GetWidth()'));
    vm.run(`ClaudeWoWTitleBar.width = ${width}; ClaudeWoWTitleBar.rect = { left = 60, right = ${60 + width}, top = 500, bottom = 466 }`);
    vm.run('for _, fn in ipairs(ClaudeWoWTitleBar.hooks.OnSizeChanged) do fn(ClaudeWoWTitleBar) end');
    return width;
  };
  const narrow = layout(560);
  assert.equal(narrow, 276);
  const buttons = vm.num('ClaudeWoWProjectButton:GetWidth()');
  assert.ok(narrow - 12 - 8 - buttons - 8 >= 80 - 12, 'the title keeps its minimum room at 560 px: ' + buttons);
  assert.ok(vm.num('ClaudeWoWProjectButton:GetLeft()') >= 60 + 8 + 80);
  vm.run('ClaudeWoWProjectButton.text.GetStringWidth = function() return 400 end; ClaudeWoW.Render()');
  assert.equal(vm.num('ClaudeWoWProjectButton:GetWidth()'), narrow - 16 - 80, 'a long project name gives way to the title');
  vm.run('ClaudeWoWProjectButton.text.GetStringWidth = function() return 100 end; ClaudeWoW.Render()');
  layout(780);
  assert.match(vm.evaluate('ClaudeWoWProjectButton.text:GetText()'), /^Project: /, 'the default width shows the full label');
});

test('the input text area gives way to Stop while a run is in flight, in both themes', () => {
  for (const [vm, base] of [
    [nativeVM(), 8],
    [newVM(), 24],
  ]) {
    if (base === 24) open(vm);
    const inset = () => vm.num('ClaudeWoWInputScroll.x');
    assert.equal(vm.evaluate('ClaudeWoWInputScroll.point'), 'BOTTOMRIGHT');
    assert.equal(inset(), -base, 'idle: the plain inset');
    assert.equal(vm.evaluate('ClaudeWoW.UI.stop.shown'), 'false');
    vm.run('ClaudeWoW.IsConnected = function() return true end; ClaudeWoWDB.chats[1].pendingId = 7; ClaudeWoW.Render()');
    assert.equal(vm.evaluate('ClaudeWoW.UI.stop.shown'), 'true');
    assert.equal(inset(), -(base + 48 + 5), 'busy: the inset grows by the Stop width and its margin');
    vm.run('ClaudeWoWDB.chats[1].pendingId = nil; ClaudeWoW.Render()');
    assert.equal(vm.evaluate('ClaudeWoW.UI.stop.shown'), 'false');
    assert.equal(inset(), -base, 'idle again: the text gets its room back');
  }
});

test('Project is a radio menu marking the current project, with the same items with and without MenuUtil', () => {
  const vm = nativeVM(MENU_UTIL);
  vm.run(
    'ClaudeWoW.SetFolder("~/wow-ai", ClaudeWoWDB.chats[1]); ClaudeWoW.NewChat(); ClaudeWoW.SetFolder("~/every-io/every", ClaudeWoWDB.chats[2]); ClaudeWoW.Render()',
  );
  vm.run('ClaudeWoWProjectButton.scripts.OnClick(ClaudeWoWProjectButton)');
  const native = menuTexts(vm);
  assert.match(native, /^Project\|No project\|/);
  assert.ok(native.includes('wow-ai') && native.includes('every'));
  const radio = text =>
    vm.evaluate(
      `(function() for _, it in ipairs(STUB.menu.items) do if it.text == "${text}" then return tostring(it.radio) .. "," .. tostring(it.get()) end end end)()`,
    );
  assert.equal(radio('every'), 'true,true', 'the current project is marked');
  assert.equal(radio('wow-ai'), 'true,false');
  assert.equal(radio('No project'), 'true,false');
  vm.run('for _, it in ipairs(STUB.menu.items) do if it.text == "wow-ai" then it.fn() end end');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].cwd'), '~/wow-ai');
  vm.run('ClaudeWoW.SetFolder("~/every-io/every", ClaudeWoWDB.chats[1]); ClaudeWoW.Render(); ClaudeWoWProjectButton.scripts.OnClick(ClaudeWoWProjectButton)');
  const again = menuTexts(vm);

  vm.run('MenuUtil = nil; ClaudeWoWProjectButton.scripts.OnClick(ClaudeWoWProjectButton)');
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.shown'), 'true', 'no MenuUtil: the fallback menu, not a chat line');
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.title:GetText()'), 'Project');
  const rows = fallbackRows(vm);
  assert.deepEqual(
    rows.map(r => r.text),
    again.split('|').slice(1),
    'the same items',
  );
  assert.deepEqual(
    rows.filter(r => r.on).map(r => r.text),
    ['wow-ai'],
    'the fallback marks the current project too',
  );
  clickRow(vm, 'No project');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].cwd'), '');
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.shown'), 'false');
});

test('Effort is a radio menu with the same items with and without MenuUtil; a locked effort greys the choices', () => {
  const vm = nativeVM(MENU_UTIL);
  vm.run(
    'ClaudeWoW.ApplyEfforts({ efforts = { [""] = { claude = "high" } }, effortLock = {} }); ClaudeWoWDB.chats[1].agent = "claude"; ClaudeWoWDB.chats[1].effort = "medium"; ClaudeWoW.Render()',
  );
  vm.run('ClaudeWoWEffortButton.scripts.OnClick(ClaudeWoWEffortButton)');
  const native = menuTexts(vm);
  assert.equal(native, 'Effort|Auto (high)|low|medium|high|xhigh|max');
  assert.equal(
    vm.evaluate(
      '(function() for _, it in ipairs(STUB.menu.items) do if it.text == "medium" then return tostring(it.radio) .. "," .. tostring(it.get()) .. "," .. tostring(it.enabled) end end end)()',
    ),
    'true,true,true',
  );
  vm.run('for _, it in ipairs(STUB.menu.items) do if it.text == "max" then it.fn() end end');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].effort'), 'max');

  vm.run('MenuUtil = nil; ClaudeWoWEffortButton.scripts.OnClick(ClaudeWoWEffortButton)');
  const rows = fallbackRows(vm);
  assert.deepEqual(
    rows.map(r => r.text),
    native.split('|').slice(1),
  );
  assert.deepEqual(
    rows.filter(r => r.on).map(r => r.text),
    ['max'],
  );
  clickRow(vm, 'Auto (high)');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].effort'), null);

  vm.run('ClaudeWoW.ApplyEfforts({ efforts = { [""] = { claude = "high" } }, effortLock = { claude = "low" } }); ClaudeWoW.Render()');
  vm.run('ClaudeWoWEffortButton.scripts.OnClick(ClaudeWoWEffortButton)');
  const locked = fallbackRows(vm);
  assert.ok(
    locked.every(r => r.disabled),
    'every choice is disabled while a setting on the computer fixes the effort',
  );
  clickRow(vm, 'max');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].effort'), null, 'a disabled row does nothing');
  vm.run('ClaudeWoWEffortButton.scripts.OnEnter(ClaudeWoWEffortButton)');
  const tip = vm.evaluate('GameTooltip:GetText()') + '\n' + vm.evaluate('table.concat(GameTooltip.lines or {}, "\\n")');
  assert.doesNotMatch(tip, /[A-Z]+_[A-Z_]+/, 'no environment variable names');
  assert.doesNotMatch(tip, /bridge/i);
  assert.doesNotMatch(tip, /Click to change/, 'a locked effort does not offer a change');
});

test('the shared menu schema: enabled (boolean or function) reaches MenuUtil as a boolean and dims fallback rows', () => {
  const vm = nativeVM(MENU_UTIL);
  vm.run(
    'ClaudeWoW.ApplyEfforts({ efforts = { [""] = { claude = "high" } }, effortLock = { claude = "low" } }); ClaudeWoWDB.chats[1].agent = "claude"; ClaudeWoW.Render()',
  );
  vm.run('ClaudeWoWEffortButton.scripts.OnClick(ClaudeWoWEffortButton)');
  assert.equal(
    vm.evaluate(
      '(function() for _, it in ipairs(STUB.menu.items) do if it.text == "max" then return type(it.enabledArg) .. "," .. tostring(it.enabled) end end end)()',
    ),
    'boolean,false',
    'SetEnabled gets the evaluated boolean, never a predicate',
  );
  vm.run('ClaudeWoW.ApplyEfforts({ efforts = { [""] = { claude = "high" } }, effortLock = {} }); ClaudeWoWEffortButton.scripts.OnClick(ClaudeWoWEffortButton)');
  assert.equal(vm.evaluate('(function() for _, it in ipairs(STUB.menu.items) do if it.text == "max" then return tostring(it.enabled) end end end)()'), 'true');
  vm.run(`ClaudeWoW.ShowChatMenu(ClaudeWoWDB.chats[1].id, UIParent)`);
  assert.equal(
    vm.evaluate('(function() for _, it in ipairs(STUB.menu.items) do if it.text == "Rename..." then return tostring(it.enabledArg) end end end)()'),
    'nil',
    'items without the field are untouched',
  );

  vm.run(
    'MenuUtil = nil; ClaudeWoW.ApplyEfforts({ efforts = { [""] = { claude = "high" } }, effortLock = { claude = "low" } }); ClaudeWoWEffortButton.scripts.OnClick(ClaudeWoWEffortButton)',
  );
  const row = '(function() for _, r in ipairs(ClaudeWoWChatMenu.rows) do if r.shown and r.label.text == "max" then return r end end end)()';
  assert.equal(vm.evaluate(`${row}.mouseEnabled`), 'false');
  assert.equal(vm.evaluate(`${row}.fn`), null);
  assert.equal(vm.evaluate(`${row}.check.alpha`), '0.5');
});

test('E3 in the chat menu: Project..., a dialog in player words, and no Plugin row in the title tooltip', () => {
  const vm = nativeVM(MENU_UTIL);
  vm.run('ClaudeWoW.UI.native = true; ClaudeWoW.ShowChatMenu(ClaudeWoWDB.chats[1].id, UIParent)');
  const items = menuTexts(vm);
  assert.ok(items.includes('Project...'), items);
  assert.ok(!items.includes('Folder...'));
  vm.run('for _, it in ipairs(STUB.menu.items) do if it.text == "Project..." then it.fn() end end');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_FOLDER');
  const dialog = vm.evaluate('StaticPopupDialogs.CLAUDEWOW_FOLDER.text');
  assert.match(dialog, /^Project for this chat/);
  assert.doesNotMatch(dialog, /bridge|folder for this chat/i);
  assert.doesNotMatch(vm.evaluate('STUB.popup.text'), /bridge|unknown until connected/);
  vm.run('LINES = {}; GameTooltip.AddDoubleLine = function(_, a, b) table.insert(LINES, a .. "=" .. b) end');
  vm.run('ClaudeWoWTitleBar.scripts.OnEnter(ClaudeWoWTitleBar)');
  assert.equal(vm.evaluate('table.concat(LINES, "|")'), 'Project=No project|Agent=AI');
});

test('native frames build no legacy left panel; the fallback keeps it; the grip is driven by the window module', () => {
  const vm = nativeVM();
  assert.equal(vm.evaluate('ClaudeWoW.UI.chatButtons'), null);
  assert.equal(vm.evaluate('ClaudeWoW.UI.pagePrev'), null);
  assert.equal(vm.evaluate('ClaudeWoW.UI.listPanel == ClaudeWoW.UI.questList.scroll:GetParent()'), 'true');
  const plain = newVM();
  open(plain);
  assert.equal(plain.num('#ClaudeWoW.UI.chatButtons'), 16);
  assert.equal(plain.evaluate('ClaudeWoW.UI.pagePrev ~= nil'), 'true');
  plain.run('ClaudeWoW.RenderChatList()');
  assert.equal(plain.evaluate('ClaudeWoW.UI.chatButtons[1].shown'), 'true');

  const grip =
    '(function() for _, c in ipairs(ClaudeWoWFrame.children) do if c.kind == "Button" and c.point == "BOTTOMRIGHT" and c.x == -5 then return c end end end)()';
  vm.run(`${grip}.scripts.OnMouseDown()`);
  assert.equal(vm.evaluate('ClaudeWoWWindow.state.dragging'), 'true', 'one set of grip handlers: the window module');
  vm.run(`${grip}.scripts.OnMouseUp()`);
  assert.equal(vm.evaluate('ClaudeWoWWindow.state.dragging'), 'false');
});

test('an upgrade moves a key bound to the old hotkey button to the workspace binding', () => {
  const vm = newVM({ before: `STUB.bindings.F5 = "${LEGACY}"; STUB.bindings["CTRL-K"] = "${LEGACY}"; STUB.bindings.F6 = "OTHER"` });
  assert.equal(vm.evaluate('STUB.bindings.F5'), 'CLAUDEWOW_WORKSPACE');
  assert.equal(vm.evaluate('STUB.bindings["CTRL-K"]'), 'CLAUDEWOW_WORKSPACE');
  assert.equal(vm.evaluate('STUB.bindings.F6'), 'OTHER', 'other keys are left alone');
  assert.equal(vm.num('STUB.saves'), 1);
  assert.equal(vm.num('STUB.savedSet'), 1, 'saved to the current binding set');
  vm.run('STUB.FireEvent("UPDATE_BINDINGS")');
  assert.equal(vm.num('STUB.saves'), 1, 'nothing left to move: no second save');
});

test('a legacy key found in combat moves after combat; bindings loaded late move on UPDATE_BINDINGS', () => {
  const vm = newVM({ before: `STUB.combat = true; STUB.bindings.F5 = "${LEGACY}"` });
  assert.equal(vm.evaluate('STUB.bindings.F5'), LEGACY, 'never in combat');
  assert.equal(vm.num('STUB.saves'), 0);
  vm.run('STUB.FireEvent("UPDATE_BINDINGS")');
  assert.equal(vm.evaluate('STUB.bindings.F5'), LEGACY, 'still in combat');
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('STUB.bindings.F5'), 'CLAUDEWOW_WORKSPACE');
  assert.equal(vm.num('STUB.saves'), 1);

  const late = newVM();
  assert.equal(late.num('STUB.saves'), 0, 'no legacy key: no save');
  late.run(`STUB.bindings.F7 = "${LEGACY}"; STUB.FireEvent("UPDATE_BINDINGS")`);
  assert.equal(late.evaluate('STUB.bindings.F7'), 'CLAUDEWOW_WORKSPACE');
});

test('the compatibility button toggles the workspace, and /claude config bind points to Key Bindings', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false');
  vm.run('ClaudeWoWRefreshButton.scripts.OnClick(ClaudeWoWRefreshButton)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true');
  vm.run('ClaudeWoWDB.chats[1].pendingId = 9; ClaudeWoWRefreshButton.scripts.OnClick(ClaudeWoWRefreshButton)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false', 'a pending run no longer turns the click into a check');
  vm.run('ClaudeWoWDB.chats[1].pendingId = nil');

  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  for (const cmd of ['config bind F5', 'config bind', 'bind F5', 'config bind CTRL K']) {
    vm.run(`SlashCmdList.CLAUDE("${cmd}")`);
    assert.match(last(), /^Use Key Bindings > AddOns/, cmd);
  }
  assert.equal(vm.evaluate('next(STUB.bindings)'), null, 'nothing is bound');
  vm.run('SlashCmdList.CLAUDE("config all")');
  assert.doesNotMatch(last(), /\nbind/, 'bind is not listed');
  const help = vm.evaluate(
    '(function() local t = {} for _, s in ipairs(ClaudeWoW.HELP) do for _, r in ipairs(s.rows or {}) do t[#t + 1] = tostring(r[1]) .. " " .. tostring(r[2]) end end return table.concat(t, "\\n") end)()',
  );
  assert.doesNotMatch(help, /\bbind\b/);
});

test('Resend shows only while a pixel-mode run is pending, and its tooltip stays quiet until a tip exists', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoW.IsConnected = function() return true end; ClaudeWoWDB.settings.mode = "pixel"; ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.resend.shown'), 'false');
  vm.run('ClaudeWoWDB.chats[1].pendingId = 4; ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.resend.shown'), 'false', 'not while the companion app may still answer');
  vm.run(
    'local i = 1 while true do local n, v = debug.getupvalue(ClaudeWoW.Connect, i) if n == nil then break end if n == "run" then v.sentAt = GetTime() break end i = i + 1 end',
  );
  vm.run('STUB.now = STUB.now + 41; ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.resend.shown'), 'true', 'after 40 s with no acknowledgement');
  vm.run('ClaudeWoWDB.settings.mode = "reload"; ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.resend.shown'), 'false');
  assert.equal(vm.evaluate('type(ClaudeWoW.UI.resend.scripts.OnEnter)'), 'function');
});

test('the window module never moves a Blizzard frame', () => {
  const src = fs.readFileSync(path.join(ADDON, 'Window.lua'), 'utf8');
  assert.doesNotMatch(src, /PlaceLootBeside|LootInPanelSlot/);
  assert.doesNotMatch(src, /loot:|_G\.LootFrame/);
});

test('a lock that arrives while the fallback Effort menu is open stops the pick and dims the row', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoW.ApplyEfforts({ efforts = { [""] = { claude = "high" } }, effortLock = {} }); ClaudeWoWDB.chats[1].agent = "claude"; ClaudeWoW.Render()');
  vm.run('ClaudeWoWEffortButton.scripts.OnClick(ClaudeWoWEffortButton)');
  const row = '(function() for _, r in ipairs(ClaudeWoWChatMenu.rows) do if r.shown and r.label.text == "max" then return r end end end)()';
  assert.equal(vm.evaluate(`${row}.disabled`), 'false');
  vm.run('ClaudeWoW.ApplyEfforts({ efforts = { [""] = { claude = "high" } }, effortLock = { claude = "low" } })');
  clickRow(vm, 'max');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].effort'), null, 'the click is refused');
  assert.equal(vm.evaluate(`${row}.disabled`), 'true', 'the row now shows as disabled');
  assert.equal(vm.evaluate(`${row}.check.alpha`), '0.5');
  assert.equal(vm.evaluate(`${row}.mouseEnabled`), 'false');
});

test('Project radio compares full paths and tells same-named projects apart', () => {
  const vm = nativeVM(MENU_UTIL);
  vm.run(
    'ClaudeWoW.SetFolder("/work/a/service", ClaudeWoWDB.chats[1]); ClaudeWoW.NewChat(); ClaudeWoW.SetFolder("/work/b/service", ClaudeWoWDB.chats[2]); ClaudeWoW.Render()',
  );
  vm.run('ClaudeWoWProjectButton.scripts.OnClick(ClaudeWoWProjectButton)');
  const items = menuTexts(vm).split('|');
  assert.ok(items.includes('service (a)') && items.includes('service (b)'), items.join('|'));
  const selected = vm.evaluate(
    '(function() local t = {} for _, it in ipairs(STUB.menu.items) do if it.get and it.get() then table.insert(t, it.text) end end return table.concat(t, "|") end)()',
  );
  assert.equal(selected, 'service (b)', 'only the chat project is marked');
  vm.run('for _, it in ipairs(STUB.menu.items) do if it.text == "service (a)" then it.fn() end end');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].cwd'), '/work/a/service');
  vm.run('ClaudeWoW.SetFolder("/x/a/service", ClaudeWoWDB.chats[1]); ClaudeWoW.Render(); ClaudeWoWProjectButton.scripts.OnClick(ClaudeWoWProjectButton)');
  const full = menuTexts(vm).split('|');
  assert.ok(full.includes('/work/a/service') && full.includes('/x/a/service'), 'same name and parent: the full path ' + full.join('|'));
});

test('an empty Project dialog detaches a coding chat like the menu No project', () => {
  const vm = nativeVM();
  vm.run('ClaudeWoWDB.chats[1].plugin = "claude-code"; ClaudeWoWDB.chats[1].cwd = "/work/a/service"; ClaudeWoW.Render()');
  const accept = text =>
    vm.run(
      `ClaudeWoW.FolderPrompt(ClaudeWoWDB.chats[1].id); local box = CreateFrame("EditBox"); box:SetText("${text}"); StaticPopupDialogs.CLAUDEWOW_FOLDER.OnAccept({ editBox = box }, STUB.popup.data)`,
    );
  accept('');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), '');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), '', 'the explicit coding plugin is cleared too');
  assert.equal(vm.evaluate('ClaudeWoWProjectButton.fullName'), 'No project');
  accept('/work/b/service');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), '/work/b/service', 'a path still sets the project');
});
