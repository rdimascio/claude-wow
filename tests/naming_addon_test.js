'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const ADDON_FILES = ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Map.lua', 'Stream.lua', 'Orders.lua', 'DM.lua'];
const PRODUCT = 'Azeroth Companion';

const NATIVE_MENU = `
  local function MenuNode()
    local node = { items = {} }
    function node:CreateTitle(t) table.insert(self.items, { title = t }) end
    function node:CreateButton(t, fn) local sub = MenuNode(); table.insert(self.items, { text = t, fn = fn, sub = sub }); return sub end
    function node:CreateCheckbox(t, get, fn) table.insert(self.items, { text = t, fn = fn, get = get }) end
    function node:CreateRadio(t, get, fn) table.insert(self.items, { text = t, fn = fn, get = get, radio = true }) end
    function node:CreateDivider() table.insert(self.items, { divider = true }) end
    return node
  end
  MenuUtil = { CreateContextMenu = function(owner, gen)
    local root = MenuNode()
    STUB.menu = root
    gen(owner, root)
  end }
  function STUB.MenuLabels(node, out)
    out = out or {}
    for _, it in ipairs(node.items) do
      if it.divider then table.insert(out, "")
      elseif it.text then
        table.insert(out, it.text)
        if it.sub and #it.sub.items > 0 then STUB.MenuLabels(it.sub, out) end
      end
    end
    return out
  end
  function STUB.FindItem(node, text)
    for _, it in ipairs(node.items) do
      if it.text == text then return it end
      if it.sub then local found = STUB.FindItem(it.sub, text) if found then return found end end
    end
  end
`;

const NATIVE_TEMPLATES = `
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
  end`;

function newVM({ native = false } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = code => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const runFile = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    lua.lua_pushstring(L, to_luastring(arg));
    if (lua.lua_pcall(L, 1, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = expr => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(NATIVE_MENU);
  if (native) run(NATIVE_TEMPLATES);
  for (const f of ADDON_FILES) runFile(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW');
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN"); STUB.RunTimers()');
  return { run, evaluate, num: expr => Number(evaluate(expr)) };
}

function connect(vm, extra = '') {
  vm.run(`STUB.onLoadAddOn = function() ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} ${extra} } end`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
}

const prints = vm => vm.evaluate('table.concat(STUB.prints, "\\n")') || '';
const chats = vm => vm.num('(function() local n = 0 for _, c in ipairs(ClaudeWoWDB.chats) do if not c.quiet then n = n + 1 end end return n end)()');
const lastText = vm =>
  vm.evaluate(
    '(function() local c = ClaudeWoWDB.chats[#ClaudeWoWDB.chats]; if c.quiet then c = ClaudeWoWDB.chats[#ClaudeWoWDB.chats - 1] end return c.history[#c.history].text end)()',
  );

const fallbackLabels = vm =>
  JSON.parse(
    vm.evaluate(
      '(function() local t = {} for _, r in ipairs(ClaudeWoWChatMenu.rows) do if r.shown then t[#t + 1] = string.format("%q", r.label.text or "") end end return "[" .. table.concat(t, ",") .. "]" end)()',
    ),
  );

test('one product name: every chat prefix in every module, the key binding and the leak line say Azeroth Companion', () => {
  for (const f of fs.readdirSync(ADDON).filter(n => n.endsWith('.lua'))) {
    const src = fs.readFileSync(path.join(ADDON, f), 'utf8');
    assert.doesNotMatch(src, /\[Claude WoW/, `${f} has no "[Claude WoW" prefix`);
    for (const m of src.matchAll(/\|cff66ccff\[([^\]"]*)\]\|r /g)) assert.equal(m[1], PRODUCT, `${f}: ${m[0]}`);
  }
  const vm = newVM();
  assert.equal(vm.evaluate('BINDING_NAME_CLAUDEWOW_WORKSPACE'), `${PRODUCT}: open or close the workspace`);
  assert.equal(vm.evaluate('ClaudeWoW.PREFIX'), `|cff66ccff[${PRODUCT}]|r `);
  vm.run('STUB.prints = {}; ClaudeWoWStream.SlashCommand("nonsense"); SlashCmdList.CLAUDEWOWDM("bogus")');
  assert.match(prints(vm), /\[Azeroth Companion\]\|r Unknown scene/);
  assert.match(prints(vm), /\[Azeroth Companion\]\|r \/dm shows or hides/);
  assert.doesNotMatch(prints(vm), /Claude WoW/);
});

test('/claude dm, map and stream run the module commands, and only their own subcommands: anything else is a message', () => {
  const vm = newVM();
  connect(vm);
  vm.run('CALLS = {}');
  vm.run('local dm, map, stream = ClaudeWoWDM.Command, ClaudeWoWMap.Command, ClaudeWoWStream.SlashCommand');
  vm.run('ClaudeWoWDM.Command = function(rest) table.insert(CALLS, "dm:" .. rest) end');
  vm.run('ClaudeWoWMap.Command = function(rest) table.insert(CALLS, "map:" .. rest) end');
  vm.run('ClaudeWoWStream.SlashCommand = function(rest) table.insert(CALLS, "stream:" .. rest) end');
  const before = chats(vm);
  for (const cmd of [
    'dm',
    'dm next',
    'map',
    'map ore on',
    'map herb',
    'map filter skill',
    'map show route1',
    'map nav route1 3',
    'map stop',
    'stream',
    'stream brb',
    'stream quest Kill ten boars',
    'stream pane left',
    'stream follow off',
  ])
    vm.run(`SlashCmdList.CLAUDE(${JSON.stringify(cmd)})`);
  assert.equal(
    vm.evaluate('table.concat(CALLS, "|")'),
    'dm:|dm:next|map:|map:ore on|map:herb|map:filter skill|map:show route1|map:nav route1 3|map:stop|stream:|stream:brb|stream:quest Kill ten boars|stream:pane left|stream:follow off',
  );
  assert.equal(chats(vm), before, 'no command made a chat');
  for (const msg of ['dm me a funny story', 'map out a leveling path', 'stream ideas for tonight', 'map ore everywhere please', 'stream pane up']) {
    const n = chats(vm);
    vm.run(`SlashCmdList.CLAUDE(${JSON.stringify(msg)})`);
    assert.equal(chats(vm), n + 1, `"${msg}" is a message for a new chat`);
    assert.equal(lastText(vm), msg);
    vm.run('SlashCmdList.CLAUDE("cancel")');
  }
  assert.equal(vm.evaluate('table.concat(CALLS, "|")').split('|').length, 14, 'no message reached a module');
  assert.equal(vm.evaluate('SLASH_CLAUDEWOWDM1'), '/dm');
  assert.equal(vm.evaluate('SLASH_CLAUDEWOWMAP1'), '/aimap');
  assert.equal(vm.evaluate('SLASH_CLAUDEWOWSTREAM1'), '/stream');
  assert.equal(vm.evaluate('SLASH_CLAUDEWOW1'), '/claude-wow');
});

test('/claude stream accepts every scene the stream module knows', () => {
  const src = fs.readFileSync(path.join(ADDON, 'Stream.lua'), 'utf8');
  const scenes = [...src.match(/local SCENES = \{([^}]*)\}/)[1].matchAll(/(\w+) =/g)].map(m => m[1]);
  assert.ok(scenes.length >= 5, scenes.join(','));
  const vm = newVM();
  vm.run('CALLS = {}; ClaudeWoWStream.SlashCommand = function(rest) table.insert(CALLS, rest) end');
  for (const scene of scenes) vm.run(`SlashCmdList.CLAUDE("stream ${scene}")`);
  assert.equal(vm.evaluate('table.concat(CALLS, "|")'), scenes.join('|'));
});

test('Delete and Clear confirm with alert dialogs whose buttons say what they do, and a stale confirm touches nothing', () => {
  const vm = newVM();
  connect(vm);
  vm.run('ClaudeWoW.NewChat(); ClaudeWoW.NewChat()');
  assert.equal(vm.evaluate('StaticPopupDialogs.CLAUDEWOW_DELETE.button1'), 'Delete');
  assert.equal(vm.evaluate('StaticPopupDialogs.CLAUDEWOW_DELETE.showAlert'), 'true');
  assert.equal(vm.evaluate('StaticPopupDialogs.CLAUDEWOW_CLEAR.button1'), 'Clear');
  assert.equal(vm.evaluate('StaticPopupDialogs.CLAUDEWOW_CLEAR.showAlert'), 'true');
  assert.equal(vm.evaluate('StaticPopupDialogs.CLAUDEWOW_CLEAR.button2'), vm.evaluate('CANCEL'));

  const first = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run(`ClaudeWoW.ConfirmDelete("${first}")`);
  vm.run('STALE = STUB.popup.data');
  vm.run(`ClaudeWoW.DeleteChat("${first}")`);
  const n = chats(vm);
  const active = vm.evaluate('ClaudeWoWDB.activeChat');
  vm.run('StaticPopupDialogs.CLAUDEWOW_DELETE.OnAccept({}, STALE)');
  assert.equal(chats(vm), n, 'a delete confirm for a chat that is gone deletes no other chat');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), active);

  vm.run('table.insert(ClaudeWoWDB.chats[1].history, { role = "user", text = "keep me" })');
  const id = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run(`ClaudeWoW.SwitchChat("${id}"); ClaudeWoW.ConfirmClear("${id}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_CLEAR');
  vm.run('STALE = STUB.popup.data');
  vm.run(`ClaudeWoW.DeleteChat("${id}")`);
  vm.run(
    'local before = #ClaudeWoWDB.chats[1].history; StaticPopupDialogs.CLAUDEWOW_CLEAR.OnAccept({}, STALE); AFTER = #ClaudeWoWDB.chats[1].history - before',
  );
  assert.equal(vm.num('AFTER'), 0, 'a clear confirm for a chat that is gone clears no other chat');
});

test('the macro dialog button says Create Macro or Update Macro', () => {
  const vm = newVM();
  vm.run('ClaudeWoW.MacroPrompt({ name = "Fresh", body = "/sit" })');
  assert.equal(vm.evaluate('StaticPopupDialogs.CLAUDEWOW_MACRO.button1'), 'Create Macro');
  vm.run('GetMacroInfo = function(i) if i == 1 then return "Old", 134400, "/stand" end end');
  vm.run('ClaudeWoW.MacroPrompt({ name = "Old", body = "/sit" })');
  assert.equal(vm.evaluate('StaticPopupDialogs.CLAUDEWOW_MACRO.button1'), 'Update Macro');
  assert.match(vm.evaluate('ClaudeWoW.MacroLabel({ name = "Old", body = "/sit" })'), /^Update Macro: Old/);
});

test('the chat menu: Agent is a radio list of the bridge agents, Plugin is gone, and the native and fallback menus have the same items', () => {
  const vm = newVM();
  connect(vm, ', agent = "claude", agents = { "claude", "codex", "bad name|cff" }');
  const id = vm.evaluate('ClaudeWoWDB.activeChat');
  vm.run('ClaudeWoW.UI.native = true');
  vm.run(`ClaudeWoW.ShowChatMenu("${id}", UIParent)`);
  const native = JSON.parse(
    vm.evaluate(
      '(function() local t = {} for _, s in ipairs(STUB.MenuLabels(STUB.menu)) do t[#t + 1] = string.format("%q", s) end return "[" .. table.concat(t, ",") .. "]" end)()',
    ),
  );
  assert.deepEqual(native, ['Rename...', 'Project...', 'Agent', 'Default (Claude)', 'Claude', 'Codex', '', 'Clear Messages', '|cffff4040Delete|r']);
  assert.equal(vm.evaluate('STUB.FindItem(STUB.menu, "Codex").radio'), 'true');
  assert.equal(vm.evaluate('STUB.FindItem(STUB.menu, "Default (Claude)").get()'), 'true', 'a chat with no agent of its own is on the default');
  vm.run('STUB.FindItem(STUB.menu, "Codex").fn()');
  assert.equal(vm.evaluate(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${id}" then return c.agent end end end)()`), 'codex');
  assert.equal(vm.evaluate('STUB.FindItem(STUB.menu, "Codex").get()'), 'true');

  vm.run('ClaudeWoW.UI.native = false');
  vm.run(`ClaudeWoW.ShowChatMenu("${id}", UIParent)`);
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.shown'), 'true');
  assert.deepEqual(fallbackLabels(vm), native, 'the fallback lists the same items');
  vm.run('for _, r in ipairs(ClaudeWoWChatMenu.rows) do if r.shown and r.label.text == "Claude" then r.scripts.OnClick(r) end end');
  assert.equal(vm.evaluate(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${id}" then return c.agent end end end)()`), 'claude');
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.shown'), 'false', 'a pick closes the fallback');
});

test('with no agent list from the bridge, the chat menu offers the Agent... prompt', () => {
  const vm = newVM();
  const id = vm.evaluate('ClaudeWoWDB.activeChat');
  vm.run('ClaudeWoW.UI.native = true');
  vm.run(`ClaudeWoW.ShowChatMenu("${id}", UIParent)`);
  vm.run('STUB.FindItem(STUB.menu, "Agent...").fn()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_AGENT');
});

test('the gear fallback opens a menu with the same items instead of toggling previews', () => {
  const vm = newVM({ native: true });
  assert.equal(vm.evaluate('ClaudeWoWChatSettings ~= nil'), 'true');
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings)');
  const native = JSON.parse(
    vm.evaluate(
      '(function() local t = {} for _, s in ipairs(STUB.MenuLabels(STUB.menu)) do t[#t + 1] = string.format("%q", s) end return "[" .. table.concat(t, ",") .. "]" end)()',
    ),
  );
  vm.run('MenuUtil = nil');
  const before = vm.evaluate('ClaudeWoWDB.settings.chatPreviews');
  vm.run('ClaudeWoWChatSettings.scripts.OnClick(ClaudeWoWChatSettings)');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.chatPreviews'), before, 'nothing toggles on open');
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.shown'), 'true');
  assert.deepEqual(fallbackLabels(vm), native);
  assert.ok(native.includes('Show message previews') && native.includes('Commands and tips'), native.join('|'));
  vm.run('for _, r in ipairs(ClaudeWoWChatMenu.rows) do if r.shown and r.label.text == "Show message previews" then r.scripts.OnClick(r) end end');
  assert.notEqual(vm.evaluate('ClaudeWoWDB.settings.chatPreviews'), before, 'the previews row toggles them');
});
