'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const TOC_FILES = fs
  .readFileSync(path.join(ADDON, 'ClaudeWoW.toc'), 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l.endsWith('.lua'));

const SETTINGS_API = `
STUB.settings = { order = {}, categories = {}, proxies = {}, controls = {} }
Settings = {
  VarType = { Boolean = "boolean", String = "string", Number = "number" },
  RegisterCanvasLayoutCategory = function(frame, name)
    local c = { frame = frame, name = name, kind = "canvas" }
    function c:GetID() return 42 end
    table.insert(STUB.settings.categories, c)
    table.insert(STUB.settings.order, "category " .. name)
    return c
  end,
  RegisterCanvasLayoutSubcategory = function(parent, frame, name)
    local c = { frame = frame, name = name, parent = parent, kind = "canvas" }
    table.insert(STUB.settings.categories, c)
    table.insert(STUB.settings.order, "canvas " .. name)
    return c
  end,
  RegisterVerticalLayoutSubcategory = function(parent, name)
    local c = { name = name, parent = parent, kind = "vertical" }
    table.insert(STUB.settings.categories, c)
    table.insert(STUB.settings.order, "vertical " .. name)
    return c
  end,
  RegisterAddOnCategory = function(c) table.insert(STUB.settings.order, "addon " .. c.name) end,
  OpenToCategory = function() end,
  RegisterProxySetting = function(category, variable, varType, name, default, get, set)
    assert(type(default) == varType, variable .. " default type")
    local s = { category = category, variable = variable, varType = varType, name = name, default = default }
    function s:GetValue() return get() end
    function s:SetValue(v) if get() ~= v then set(v) end end
    STUB.settings.proxies[variable] = s
    return s
  end,
  CreateCheckbox = function(category, setting, tooltip)
    assert(setting.varType == "boolean")
    table.insert(STUB.settings.controls, { kind = "checkbox", category = category, setting = setting, tooltip = tooltip })
  end,
  CreateDropdown = function(category, setting, options, tooltip)
    table.insert(STUB.settings.controls, { kind = "dropdown", category = category, setting = setting, options = options, tooltip = tooltip })
  end,
  CreateControlTextContainer = function()
    local c = { data = {} }
    function c:Add(value, label) table.insert(self.data, { value = value, label = label }) end
    function c:GetData() return self.data end
    return c
  end,
}
`;

const LEGACY_API = `
STUB.legacy = {}
function InterfaceOptions_AddCategory(panel) table.insert(STUB.legacy, panel) end
function InterfaceOptionsFrame_OpenToCategory() end
`;

const SERIALIZE = `
function SERIALIZE(v, seen)
  seen = seen or {}
  local t = type(v)
  if t == "string" then return string.format("%q", v) end
  if t == "number" or t == "boolean" then return tostring(v) end
  if t ~= "table" or seen[v] then return "nil" end
  seen[v] = true
  local parts = {}
  for k, x in pairs(v) do
    if (type(k) == "string" or type(k) == "number") and type(x) ~= "function" then
      parts[#parts + 1] = "[" .. SERIALIZE(k, seen) .. "] = " .. SERIALIZE(x, seen)
    end
  end
  return "{ " .. table.concat(parts, ", ") .. " }"
end
`;

function newVM(prelude = SETTINGS_API, savedVariables = '') {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = code => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const runFile = code => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    lua.lua_pushstring(L, to_luastring('ClaudeWoW'));
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
  run(SERIALIZE);
  run('UnitRace = function() return "Human", "Human" end; UnitSex = function() return 2 end; StopSound = function() end');
  if (prelude) run(prelude);
  if (savedVariables) run(savedVariables);
  for (const f of TOC_FILES) runFile(fs.readFileSync(path.join(ADDON, f), 'utf8'));
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate };
}

const proxy = key => `STUB.settings.proxies.CLAUDEWOW_OPTION_${key.toUpperCase()}`;
const configLine = (vm, key) => {
  vm.run('SlashCmdList.CLAUDE("config all")');
  const list = vm.evaluate(
    '(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then return c.history[#c.history].text end end end)()',
  );
  return list.split('\n').find(l => l.startsWith(key + ' = ') || l.startsWith(key + '  -  '));
};

const PLAYER_KEYS = ['whisper', 'dim', 'dodge', 'autohide', 'echo', 'voice', 'roast', 'roll', 'achievements', 'orders', 'telemetry', 'ore', 'herb'];

test('options: an Options page of proxy settings and a Widgets page sit under the addon category, registered before it is listed', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('table.concat(STUB.settings.order, ",")'), 'category Azeroth Companion,vertical Options,canvas Widgets,addon Azeroth Companion');
  assert.equal(vm.evaluate('STUB.settings.categories[2].parent == STUB.settings.categories[1]'), 'true');
  assert.equal(vm.evaluate('STUB.settings.categories[3].frame == ClaudeWoWWidgetsPanel'), 'true');
  const keys = vm.evaluate(
    '(function() local t = {} for _, c in ipairs(STUB.settings.controls) do t[#t + 1] = c.setting.variable:sub(18):lower() .. ":" .. c.kind end return table.concat(t, ",") end)()',
  );
  assert.equal(
    keys,
    'whisper:checkbox,dim:dropdown,dodge:checkbox,autohide:checkbox,echo:dropdown,voice:dropdown,roast:checkbox,roll:checkbox,achievements:checkbox,orders:checkbox,telemetry:checkbox,ore:checkbox,herb:checkbox',
  );
  assert.equal(vm.evaluate('STUB.settings.controls[1].category == STUB.settings.categories[2]'), 'true');
  assert.equal(vm.evaluate(`${proxy('telemetry')}.name`), 'Share game state with the agent');
  for (const dev of ['signal', 'mode', 'auto', 'longchat', 'plugin', 'probe', 'diag'])
    assert.equal(vm.evaluate(proxy(dev)), null, `${dev} stays off the Options page`);
  const voice = vm.evaluate(
    '(function() for _, c in ipairs(STUB.settings.controls) do if c.setting.variable == "CLAUDEWOW_OPTION_VOICE" then local t = {} for _, o in ipairs(c.options()) do t[#t + 1] = o.value .. "=" .. o.label end return table.concat(t, ",") end end end)()',
  );
  assert.equal(voice, 'race=Your race,peasant=Peasant,peon=Peon,off=Off');
});

test('options: each control calls the /claude config handler, takes effect at once, and agrees with /claude config both ways', () => {
  const vm = newVM();
  const set = (key, value) => vm.run(`${proxy(key)}:SetValue(${JSON.stringify(value)})`);
  const get = key => vm.evaluate(`${proxy(key)}:GetValue()`);

  assert.equal(get('whisper'), 'true');
  set('whisper', false);
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisperChoice'), 'off', 'went through Cli.SetWhisper');
  assert.match(configLine(vm, 'whisper'), /^whisper = off/);

  vm.run('APPLIED = 0; local apply = ClaudeWoWWindow.Apply; ClaudeWoWWindow.Apply = function(...) APPLIED = APPLIED + 1; return apply(...) end');
  set('dodge', false);
  set('autohide', false);
  set('dim', '60');
  assert.equal(vm.evaluate('APPLIED'), '3', 'Cli.Ui re-applies the window each time');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.dim'), '0.6');
  assert.match(configLine(vm, 'ui'), /^ui = whisper off, dim 60%, dodge off, autohide off/);
  set('dim', 'off');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.dim'), '1');

  set('echo', 'short');
  assert.match(configLine(vm, 'echo'), /^echo = short/);
  vm.run('SlashCmdList.CLAUDE("config echo 900")');
  assert.equal(get('echo'), '900');
  const echoChoices = vm.evaluate(
    '(function() for _, c in ipairs(STUB.settings.controls) do if c.setting.variable == "CLAUDEWOW_OPTION_ECHO" then return c.options()[1].label end end end)()',
  );
  assert.equal(echoChoices, '900 characters', 'a number set by command still shows in the dropdown');

  set('voice', 'peon');
  assert.equal(vm.evaluate('ClaudeWoWDB.voice.pack'), 'peon');
  assert.match(configLine(vm, 'voice'), /^voice = peon/);

  assert.equal(vm.evaluate('ClaudeWoWRoast.Listening()'), 'false');
  set('roast', true);
  assert.equal(vm.evaluate('ClaudeWoWRoast.Listening()'), 'true', 'the roast handler registers its events');
  assert.match(configLine(vm, 'roast'), /^roast = on/);

  set('roll', false);
  assert.equal(vm.evaluate('ClaudeWoW.LootRollEnabled()'), 'false');
  set('achievements', false);
  assert.equal(vm.evaluate('ClaudeWoWAchievements.ToastsOn()'), 'false');
  set('orders', false);
  assert.equal(vm.evaluate('ClaudeWoWOrders.IsOn()'), 'false');
  set('telemetry', false);
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.IsOn()'), 'false');
  assert.match(configLine(vm, 'telemetry'), /^telemetry = off/);
  set('ore', true);
  assert.equal(vm.evaluate('ClaudeWoWMapDB.nodes.ore'), 'true');
  assert.equal(get('herb'), 'false');

  vm.run('SlashCmdList.CLAUDE("config telemetry on")');
  vm.run('SlashCmdList.CLAUDE("config ui dodge on")');
  vm.run('SlashCmdList.CLAUDE("config roll on")');
  vm.run('SlashCmdList.CLAUDE("config map herb on")');
  vm.run('SlashCmdList.CLAUDE("config voice off")');
  assert.equal(get('telemetry'), 'true');
  assert.equal(get('dodge'), 'true');
  assert.equal(get('roll'), 'true');
  assert.equal(get('herb'), 'true');
  assert.equal(get('voice'), 'off');
});

test('options: a value that does not change calls no handler', () => {
  const vm = newVM();
  vm.run('CALLS = 0; local config = ClaudeWoW.Config; ClaudeWoW.Config = function(...) CALLS = CALLS + 1; return config(...) end');
  vm.run(`${proxy('whisper')}:SetValue(true)`);
  vm.run('ClaudeWoWHelp.SetOption(ClaudeWoWHelp.OPTIONS[1], true)');
  assert.equal(vm.evaluate('CALLS'), '0');
  vm.run('ClaudeWoWHelp.SetOption(ClaudeWoWHelp.OPTIONS[1], false)');
  assert.equal(vm.evaluate('CALLS'), '1');
});

test('options: what the page sets is in SavedVariables, so it is the same after a relog', () => {
  const vm = newVM();
  const values = {
    whisper: false,
    dodge: false,
    dim: '20',
    echo: 'off',
    voice: 'peasant',
    roast: true,
    roll: false,
    achievements: false,
    orders: false,
    telemetry: false,
    ore: true,
    herb: true,
  };
  for (const [key, value] of Object.entries(values)) vm.run(`${proxy(key)}:SetValue(${JSON.stringify(value)})`);
  const saved = `ClaudeWoWDB = ${vm.evaluate('SERIALIZE(ClaudeWoWDB)')}\nClaudeWoWMapDB = ${vm.evaluate('SERIALIZE(ClaudeWoWMapDB)')}`;
  const again = newVM(SETTINGS_API, saved);
  for (const [key, value] of Object.entries(values)) assert.equal(again.evaluate(`${proxy(key)}:GetValue()`), String(value), key);
  assert.equal(again.evaluate('ClaudeWoWRoast.Listening()'), 'true');
});

test('options: without the Settings API, an Options panel under the help page works with plain controls and lists widgets', () => {
  const vm = newVM(LEGACY_API);
  assert.equal(vm.evaluate('#STUB.legacy'), '2');
  assert.equal(vm.evaluate('STUB.legacy[2] == ClaudeWoWOptionsPanel'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWOptionsPanel.parent'), 'Azeroth Companion');
  const control = key => `(function() for _, c in ipairs(ClaudeWoWOptionsPanel.controls) do if c.option.key == "${key}" then return c end end end)()`;
  assert.equal(vm.evaluate('#ClaudeWoWOptionsPanel.controls'), String(PLAYER_KEYS.length));
  assert.equal(vm.evaluate(`${control('telemetry')}.label.text`), 'Share game state with the agent');
  assert.equal(vm.evaluate(`${control('telemetry')}.template`), 'UICheckButtonTemplate');
  vm.run(`${control('telemetry')}.scripts.OnClick(${control('telemetry')})`);
  assert.equal(vm.evaluate('ClaudeWoWTelemetry.IsOn()'), 'false');
  vm.run(`${control('echo')}.scripts.OnClick(${control('echo')})`);
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), 'short');
  assert.equal(vm.evaluate(`${control('echo')}.text`), 'Replies in the game chat: Short');
  vm.run('SlashCmdList.CLAUDE("config echo off"); ClaudeWoWOptionsPanel.scripts.OnShow(ClaudeWoWOptionsPanel)');
  assert.equal(vm.evaluate(`${control('echo')}.text`), 'Replies in the game chat: Off', 'the panel shows what /claude config set');
  assert.equal(vm.evaluate('ClaudeWoWOptionsPanel.empty.shown'), 'true');
});

test('options: the Widgets page lists the agent widgets with Remove and Show buttons that use the widget commands', () => {
  const vm = newVM(
    SETTINGS_API,
    'ClaudeWoWWidgetDB = { approved = { meter = "r1" }, set = { epoch = "e1", version = 1, items = { { name = "meter", title = "DPS meter", rev = "r1", source = "local ui = ..." }, { name = "clock", title = "Clock", rev = "r2", source = "local ui = ..." } } } }',
  );
  vm.run('ClaudeWoWWidgetsPanel.scripts.OnShow(ClaudeWoWWidgetsPanel)');
  const row = i => `ClaudeWoWWidgetsPanel.rows[${i}]`;
  assert.equal(vm.evaluate('ClaudeWoWWidgetsPanel.empty.shown'), 'false');
  assert.equal(vm.evaluate(`${row(1)}.text.text`), 'DPS meter  (shown)');
  assert.equal(vm.evaluate(`${row(1)}.button.text`), 'Remove');
  assert.equal(vm.evaluate(`${row(2)}.text.text`), 'Clock  (waiting for your OK)');
  assert.equal(vm.evaluate(`${row(2)}.button.text`), 'Show');
  vm.run(`${row(1)}.button.scripts.OnClick(${row(1)}.button)`);
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("meter")'), 'removed');
  assert.equal(vm.evaluate(`${row(1)}.text.text`), 'DPS meter  (hidden)');
  assert.equal(vm.evaluate(`${row(1)}.button.text`), 'Show');
  vm.run(`${row(2)}.button.scripts.OnClick(${row(2)}.button)`);
  assert.equal(vm.evaluate('ClaudeWoWWidgets.Status("clock")'), 'running');
  assert.equal(vm.evaluate('ClaudeWoWWidgetDB.approved.clock'), 'r2');
});
