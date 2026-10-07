'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const TOC_FILES = fs
  .readFileSync(path.join(ADDON, 'ClaudeWoW.toc'), 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l.endsWith('.lua'));

const SETTINGS_API = `
STUB.settings = { order = {}, categories = {}, proxies = {}, controls = {}, opened = {} }
Settings = {
  VarType = { Boolean = "boolean", String = "string", Number = "number" },
  RegisterVerticalLayoutCategory = function(name)
    local c = { name = name, kind = "vertical" }
    function c:GetID() return 41 end
    table.insert(STUB.settings.categories, c)
    table.insert(STUB.settings.order, "vertical " .. name)
    return c, {}
  end,
  RegisterVerticalLayoutSubcategory = function(parent, name)
    local c = { name = name, parent = parent, kind = "vertical" }
    function c:GetID() return 43 end
    table.insert(STUB.settings.categories, c)
    table.insert(STUB.settings.order, "vertical sub " .. name)
    return c
  end,
  RegisterCanvasLayoutCategory = function(frame, name)
    local c = { frame = frame, name = name, kind = "canvas" }
    function c:GetID() return 40 end
    table.insert(STUB.settings.categories, c)
    table.insert(STUB.settings.order, "canvas " .. name)
    return c
  end,
  RegisterCanvasLayoutSubcategory = function(parent, frame, name)
    local c = { frame = frame, name = name, parent = parent, kind = "canvas" }
    function c:GetID() return name == "Commands and tips" and 45 or 46 end
    table.insert(STUB.settings.categories, c)
    table.insert(STUB.settings.order, "canvas sub " .. name)
    return c
  end,
  RegisterAddOnCategory = function(c) table.insert(STUB.settings.order, "addon " .. c.name) end,
  OpenToCategory = function(id) table.insert(STUB.settings.opened, id) end,
  RegisterProxySetting = function(category, variable, varType, name, default, get, set)
    local s = { category = category, variable = variable, varType = varType, name = name, default = default }
    function s:GetValue() return get() end
    function s:SetValue(v) if get() ~= v then set(v) end end
    STUB.settings.proxies[variable] = s
    return s
  end,
  CreateCheckbox = function(category, setting, tooltip)
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

const COUNTS = `
function OUTPUT_COUNTS()
  local history = 0
  for _, c in ipairs(ClaudeWoWDB.chats) do history = history + #c.history end
  local lines = 0
  for _, name in ipairs(CHAT_FRAMES or {}) do
    local f = _G[name]
    lines = lines + #((f and f.messages) or {})
  end
  return table.concat({
    "history=" .. history,
    "prints=" .. #STUB.prints,
    "lines=" .. lines,
    "tabs=" .. tostring(STUB.tempWindows or 0),
    "chats=" .. #ClaudeWoWDB.chats,
    "window=" .. tostring(ClaudeWoWFrame.shown),
  }, " ")
end
`;

function newVM({ prelude = SETTINGS_API, dock = true, saved = '' } = {}) {
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
  run('UnitRace = function() return "Human", "Human" end; UnitSex = function() return 2 end; StopSound = function() end');
  run(COUNTS);
  if (dock) run('STUB.ChatDock()');
  if (prelude) run(prelude);
  if (saved) run(saved);
  for (const f of TOC_FILES) runFile(fs.readFileSync(path.join(ADDON, f), 'utf8'));
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate };
}

function connect(vm) {
  vm.run('STUB.RunTimers()');
  vm.run('STUB.onLoadAddOn = function() ClaudeWoW_SlotData = { now = time(), cwd = "", agent = "claude", agents = { "claude" }, replies = {} } end');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('STUB.RunTimers()');
}

const OPTION_KEYS = vm =>
  vm.evaluate('(function() local t = {} for _, o in ipairs(ClaudeWoWHelp.Options()) do t[#t + 1] = o.key end return table.concat(t, ",") end)()').split(',');

const optionExpr = key => `(function() for _, o in ipairs(ClaudeWoWHelp.OPTIONS) do if o.key == "${key}" then return o end end end)()`;

function otherValue(vm, key) {
  const o = optionExpr(key);
  if (vm.evaluate(`${o}.choices == nil`) === 'true') return { lua: `not ClaudeWoWHelp.OptionValue(${o})` };
  return {
    lua: `(function() local cur = ClaudeWoWHelp.OptionValue(${o}) for _, c in ipairs(${o}.choices()) do if c[1] ~= cur then return c[1] end end end)()`,
  };
}

function setQuietly(vm, key) {
  const o = optionExpr(key);
  vm.run(`WANT = ${otherValue(vm, key).lua}; BEFORE = ClaudeWoWHelp.OptionValue(${o}); REJECTED = ClaudeWoWHelp.SetOption(${o}, WANT)`);
  return {
    before: vm.evaluate('BEFORE'),
    want: vm.evaluate('WANT'),
    after: vm.evaluate(`ClaudeWoWHelp.OptionValue(${o})`),
    rejected: vm.evaluate('REJECTED'),
  };
}

const SCENARIOS = [
  { name: 'whisper tabs on, window closed', setup: vm => vm.run('ClaudeWoWDB.settings.whisper = true') },
  { name: 'whisper tabs off, window closed', setup: vm => vm.run('ClaudeWoWDB.settings.whisper = false') },
  { name: 'whisper tabs off, window open', setup: vm => vm.run('ClaudeWoWDB.settings.whisper = false; ClaudeWoW.Toggle(true)') },
  { name: 'whisper tabs on, window open', setup: vm => vm.run('ClaudeWoWDB.settings.whisper = true; ClaudeWoW.Toggle(true)') },
];

for (const scenario of SCENARIOS) {
  test(`settings quiet path (${scenario.name}): every Options control changes its state and writes nothing anywhere`, () => {
    const vm = newVM();
    connect(vm);
    scenario.setup(vm);
    if (scenario.name.startsWith('whisper tabs on')) assert.equal(vm.evaluate('STUB.tempWindows'), '1', 'a live whisper tab could take a line');
    const keys = OPTION_KEYS(vm);
    assert.equal(keys.length, 14, keys.join(','));
    for (const round of [1, 2]) {
      for (const key of keys) {
        const counts = vm.evaluate('OUTPUT_COUNTS()');
        const r = setQuietly(vm, key);
        assert.notEqual(r.before, r.want, `${key}: a different value`);
        assert.equal(r.after, r.want, `${key}: the state changed`);
        assert.equal(r.rejected, null, `${key}: not rejected`);
        assert.equal(vm.evaluate('OUTPUT_COUNTS()'), counts, `${key} (round ${round}): no history, chat, tab or print, window unchanged`);
      }
    }
  });
}

test('settings quiet path: the proxy setting a Settings checkbox writes goes through the quiet path', () => {
  const vm = newVM();
  connect(vm);
  const counts = vm.evaluate('OUTPUT_COUNTS()');
  vm.run('STUB.settings.proxies.CLAUDEWOW_OPTION_ROLL:SetValue(false)');
  vm.run('STUB.settings.proxies.CLAUDEWOW_OPTION_ECHO:SetValue("off")');
  vm.run('STUB.settings.proxies.CLAUDEWOW_OPTION_WHISPER:SetValue(false)');
  vm.run('STUB.settings.proxies.CLAUDEWOW_OPTION_WHISPER:SetValue(true)');
  assert.equal(vm.evaluate('ClaudeWoW.LootRollEnabled()'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), 'off');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisperChoice'), 'on');
  assert.equal(vm.evaluate('OUTPUT_COUNTS()'), counts);
});

test('settings quiet path: a rejection comes back as a return value and writes nothing', () => {
  const vm = newVM();
  connect(vm);
  const counts = vm.evaluate('OUTPUT_COUNTS()');
  assert.match(vm.evaluate('ClaudeWoW.Config("nosuch on", { quiet = true })'), /^No setting "nosuch"/);
  assert.match(vm.evaluate('ClaudeWoW.Config("roll maybe", { quiet = true })'), /^roll does not take "maybe"/);
  assert.equal(vm.evaluate('ClaudeWoW.Config("roll off", { quiet = true })'), null);
  assert.match(vm.evaluate(`ClaudeWoWHelp.SetOption(${optionExpr('dim')}, "5")`), /^ui does not take "dim 5"/, 'the Options page gets the rejection back');
  assert.equal(vm.evaluate('OUTPUT_COUNTS()'), counts);
  assert.equal(vm.evaluate('ClaudeWoW.LootRollEnabled()'), 'false');
});

test('settings quiet path: the quiet context ends with the call, so the next typed command talks again', () => {
  const vm = newVM();
  connect(vm);
  vm.run('ClaudeWoW.Config("echo short", { quiet = true })');
  assert.equal(vm.evaluate('ClaudeWoW.Config("nosuch", { quiet = true }) ~= nil'), 'true');
  const before = vm.evaluate('#ClaudeWoWDB.chats[1].history');
  vm.run('ClaudeWoW.Config("echo full")');
  assert.equal(Number(vm.evaluate('#ClaudeWoWDB.chats[1].history')), Number(before) + 1);
  vm.run('ClaudeWoWVoice.Command = function() error("boom") end');
  assert.equal(vm.evaluate('pcall(ClaudeWoW.Config, "voice race", { quiet = true })'), 'false');
  vm.run('SlashCmdList.CLAUDE("errors")');
  assert.equal(Number(vm.evaluate('#ClaudeWoWDB.chats[1].history')), Number(before) + 2, 'an error inside a quiet call does not leave the addon quiet');
});

test('settings quiet path: a module that did not load is a silent no-op from Settings and a line when typed', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  vm.run('ClaudeWoWRoast, ClaudeWoWOrders = nil, nil');
  const counts = vm.evaluate('OUTPUT_COUNTS()');
  assert.equal(vm.evaluate('ClaudeWoW.Config("roast on", { quiet = true })'), null);
  assert.equal(vm.evaluate('ClaudeWoW.Config("orders off", { quiet = true })'), null);
  assert.equal(vm.evaluate('OUTPUT_COUNTS()'), counts);
  vm.run('ClaudeWoW.Config("roast on")');
  assert.match(vm.evaluate('STUB.prints[#STUB.prints]'), /the roast module did not load/);
});

test('settings quiet path: typed /claude config stays verbose for every Options key', () => {
  const typed = {
    whisper: 'config ui whisper off',
    dim: 'config ui dim 60',
    dodge: 'config ui dodge off',
    autohide: 'config ui autohide off',
    minimap: 'config minimap off',
    echo: 'config echo short',
    voice: 'config voice peon',
    roast: 'config roast on',
    roll: 'config roll off',
    achievements: 'config achievements off',
    orders: 'config orders off',
    telemetry: 'config telemetry off',
    ore: 'config map ore on',
    herb: 'config map herb on',
  };
  for (const [key, cmd] of Object.entries(typed)) {
    const vm = newVM({ dock: false });
    connect(vm);
    const counts = vm.evaluate('OUTPUT_COUNTS()');
    vm.run(`SlashCmdList.CLAUDE(${JSON.stringify(cmd)})`);
    assert.notEqual(vm.evaluate('OUTPUT_COUNTS()'), counts, `${key}: typed config answers`);
  }
});

test('settings quiet path: voice lines and tests stay silent when quiet, and talk when typed', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  const counts = vm.evaluate('OUTPUT_COUNTS()');
  vm.run('ClaudeWoWVoice.Command("lines", { quiet = true }); ClaudeWoWVoice.Command("test done", { quiet = true })');
  assert.equal(vm.evaluate('OUTPUT_COUNTS()'), counts);
  vm.run('ClaudeWoWVoice.Command("lines")');
  assert.notEqual(vm.evaluate('OUTPUT_COUNTS()'), counts);
});

test('settings: Options is the top-level vertical category, Commands and tips and Widgets are canvas subcategories', () => {
  const vm = newVM();
  assert.equal(
    vm.evaluate('table.concat(STUB.settings.order, ",")'),
    'vertical Azeroth Companion,canvas sub Commands and tips,canvas sub Widgets,addon Azeroth Companion',
  );
  assert.equal(vm.evaluate('STUB.settings.categories[1].kind'), 'vertical');
  assert.equal(vm.evaluate('STUB.settings.categories[1].parent'), null);
  assert.equal(vm.evaluate('STUB.settings.categories[2].frame == ClaudeWoWHelpPanel'), 'true');
  assert.equal(vm.evaluate('STUB.settings.categories[2].parent == STUB.settings.categories[1]'), 'true');
  assert.equal(vm.evaluate('STUB.settings.categories[3].parent == STUB.settings.categories[1]'), 'true');
  assert.equal(vm.evaluate('#STUB.settings.controls'), '14');
  assert.equal(
    vm.evaluate(
      '(function() for _, c in ipairs(STUB.settings.controls) do if c.category ~= STUB.settings.categories[1] then return false end end return true end)()',
    ),
    'true',
    'every control is on the top-level page',
  );
  vm.run('ClaudeWoW.ShowOptions(); ClaudeWoW.ShowHelp()');
  assert.equal(vm.evaluate('table.concat(STUB.settings.opened, ",")'), '41,45');
  vm.run('ClaudeWoWMinimapButton.scripts.OnClick(ClaudeWoWMinimapButton, "RightButton")');
  assert.equal(vm.evaluate('STUB.settings.opened[3]'), '41', 'the minimap right-click opens the top-level Options page');
});

test('settings: a client with a canvas category but no vertical layout puts an Options canvas on top and keeps the help page under it', () => {
  const vm = newVM({ prelude: SETTINGS_API + '\nSettings.RegisterVerticalLayoutCategory = nil' });
  assert.equal(vm.evaluate('table.concat(STUB.settings.order, ",")'), 'canvas Azeroth Companion,canvas sub Commands and tips,addon Azeroth Companion');
  assert.equal(vm.evaluate('STUB.settings.categories[1].frame == ClaudeWoWOptionsPanel'), 'true');
  assert.equal(vm.evaluate('#ClaudeWoWOptionsPanel.controls'), '14');
  vm.run('ClaudeWoW.ShowOptions(); ClaudeWoW.ShowHelp()');
  assert.equal(vm.evaluate('table.concat(STUB.settings.opened, ",")'), '40,45');
});

test('settings: without a subcategory API the help page opens in its own window, Options in Settings', () => {
  const vm = newVM({ prelude: SETTINGS_API + '\nSettings.RegisterCanvasLayoutSubcategory = nil' });
  vm.run('ClaudeWoW.ShowOptions(); ClaudeWoW.ShowHelp()');
  assert.equal(vm.evaluate('table.concat(STUB.settings.opened, ",")'), '41');
  assert.equal(vm.evaluate('ClaudeWoWHelpWindow.shown'), 'true');
});

test('settings: Interface Options lists Options on top and the help page under it', () => {
  const vm = newVM({
    prelude:
      'STUB.legacy, STUB.legacyOpened = {}, {}; function InterfaceOptions_AddCategory(p) table.insert(STUB.legacy, p) end; function InterfaceOptionsFrame_OpenToCategory(p) table.insert(STUB.legacyOpened, p) end',
  });
  assert.equal(vm.evaluate('STUB.legacy[1] == ClaudeWoWOptionsPanel'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWOptionsPanel.parent'), null);
  assert.equal(vm.evaluate('STUB.legacy[2] == ClaudeWoWHelpPanel'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWHelpPanel.parent'), 'Azeroth Companion');
  vm.run('ClaudeWoW.ShowHelp()');
  assert.equal(vm.evaluate('STUB.legacyOpened[1] == ClaudeWoWHelpPanel'), 'true');
  vm.run('STUB.legacyOpened = {}; ClaudeWoW.ShowOptions()');
  assert.equal(vm.evaluate('STUB.legacyOpened[1] == ClaudeWoWOptionsPanel'), 'true');
});

const helpRows = vm =>
  JSON.parse(
    vm.evaluate(
      '(function() local t = {} for _, s in ipairs(ClaudeWoW.HELP) do for _, r in ipairs(s.rows or {}) do t[#t + 1] = string.format("[%q,%q,%q]", s.title, r[1], r[2]) end for _, n in ipairs(s.notes or {}) do t[#t + 1] = string.format("[%q,%q,%q]", s.title, "", n) end end return "[" .. table.concat(t, ",") .. "]" end)()',
    ),
  );

test('help rows: player commands first, transport rows only in a last More section, no hide row, companion app and project wording', () => {
  const vm = newVM();
  const rows = helpRows(vm);
  const titles = [...new Set(rows.map(r => r[0]))];
  assert.equal(titles[titles.length - 1], 'More');
  assert.ok(!titles.includes('Troubleshooting'));
  for (const cmd of ['/claude resend', '/claude slots', '/claude diag [copy]', '/claude probe [chatlog|asyncfile]']) {
    const row = rows.find(r => r[1] === cmd);
    assert.ok(row, cmd);
    assert.equal(row[0], 'More', cmd);
  }
  assert.ok(!rows.some(r => /hide \| mini/.test(r[1])), 'no hide | mini row');
  for (const r of rows) {
    if (/\/claude config \[key\] \[value\]/.test(r[1])) continue;
    assert.doesNotMatch(r[2], /bridge/i, r[1]);
    if (r[1].startsWith('/claude --add-dir')) continue;
    assert.doesNotMatch(r[1] + ' ' + r[2], /folder/i, r[1]);
  }
  assert.ok(rows.some(r => r[1] === '/claude cd <project path>'));
});

test('help: one roll wording in Options, /claude config and the roll command', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  const wording = vm.evaluate('ClaudeWoW.ROLL_HELP');
  assert.match(wording, /^A command that needs your OK opens a Greed, Need or Pass roll\./);
  assert.equal(vm.evaluate('STUB.settings.proxies.CLAUDEWOW_OPTION_ROLL ~= nil'), 'true');
  assert.equal(vm.evaluate(`${optionExpr('roll')}.tooltip`), wording);
  vm.run('SlashCmdList.CLAUDE("config")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('roll = on  -  on|off: ' + wording));
  vm.run('STUB.prints = {}; SlashCmdList.CLAUDE("config roll off")');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Ask with a roll window is off. ' + wording));
});

test('help: the config list points at the top-level Options page and keeps bridge out of player keys', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  vm.run('SlashCmdList.CLAUDE("config")');
  const list = vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  assert.match(list, /The game's Options window has the same settings: AddOns, Azeroth Companion\.\n/);
  for (const line of list.split('\n').filter(l => /  -  /.test(l) && !l.startsWith('bind'))) assert.doesNotMatch(line, /bridge/i, line);
});

const PLAYER_MODULES = [
  'Voice.lua',
  'DM.lua',
  'Telemetry.lua',
  'Orders.lua',
  'Achievements.lua',
  'Map.lua',
  'Widgets.lua',
  'Stream.lua',
  'Roast.lua',
  'Help.lua',
];

function stringLiterals(file) {
  const out = [];
  const ast = luaparse.parse(fs.readFileSync(path.join(ADDON, file), 'utf8'), { luaVersion: '5.1', comments: false, locations: true });
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'StringLiteral') out.push({ text: node.raw, line: node.loc.start.line });
    for (const k of Object.keys(node)) if (k !== 'loc') walk(node[k]);
  };
  walk(ast);
  return out;
}

test('module text: player strings say companion app, never bridge, and project, never folder', () => {
  for (const file of PLAYER_MODULES) {
    for (const s of stringLiterals(file)) {
      assert.doesNotMatch(s.text, /bridge/i, `${file}:${s.line} ${s.text}`);
      assert.doesNotMatch(s.text, /folder/i, `${file}:${s.line} ${s.text}`);
    }
  }
});

test('module text: the changed lines read as the player sees them', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  vm.run('STUB.prints = {}; SlashCmdList.CLAUDE("config telemetry off")');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('the companion app gets no game state'));
  vm.run('STUB.prints = {}; SlashCmdList.CLAUDE("config telemetry on")');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('go to the companion app.'));
  vm.run('STUB.prints = {}; SlashCmdList.CLAUDE("config voice")');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('the companion app picked the message up'));
});
