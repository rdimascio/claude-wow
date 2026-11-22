'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');
const { createVM, ADDON_DIR: ADDON, tocFiles } = require('./lua/vm');

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
  for _, c in ipairs(WoWGPTDB.chats) do history = history + #c.history end
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
    "chats=" .. #WoWGPTDB.chats,
    "window=" .. tostring(WoWGPTFrame.shown),
  }, " ")
end
`;

function newVM({ prelude = SETTINGS_API, dock = true, saved = '' } = {}) {
  const vm = createVM();
  vm.run('UnitRace = function() return "Human", "Human" end; UnitSex = function() return 2 end; StopSound = function() end');
  vm.run(COUNTS);
  if (dock) vm.run('STUB.ChatDock()');
  if (prelude) vm.run(prelude);
  if (saved) vm.run(saved);
  vm.loadAddon();
  vm.login();
  return vm;
}

function connect(vm) {
  vm.run('STUB.RunTimers()');
  vm.run('STUB.onLoadAddOn = function() WoWGPT_SlotData = { now = time(), cwd = "", agent = "claude", agents = { "claude" }, replies = {} } end');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('STUB.RunTimers()');
}

const OPTION_KEYS = vm =>
  vm.evaluate('(function() local t = {} for _, o in ipairs(WoWGPTHelp.Options()) do t[#t + 1] = o.key end return table.concat(t, ",") end)()').split(',');

const optionExpr = key => `(function() for _, o in ipairs(WoWGPTHelp.OPTIONS) do if o.key == "${key}" then return o end end end)()`;

function otherValue(vm, key) {
  const o = optionExpr(key);
  if (vm.evaluate(`${o}.choices == nil`) === 'true') return { lua: `not WoWGPTHelp.OptionValue(${o})` };
  return {
    lua: `(function() local cur = WoWGPTHelp.OptionValue(${o}) for _, c in ipairs(${o}.choices()) do if c[1] ~= cur then return c[1] end end end)()`,
  };
}

function setQuietly(vm, key) {
  const o = optionExpr(key);
  vm.run(`WANT = ${otherValue(vm, key).lua}; BEFORE = WoWGPTHelp.OptionValue(${o}); REJECTED = WoWGPTHelp.SetOption(${o}, WANT)`);
  return {
    before: vm.evaluate('BEFORE'),
    want: vm.evaluate('WANT'),
    after: vm.evaluate(`WoWGPTHelp.OptionValue(${o})`),
    rejected: vm.evaluate('REJECTED'),
  };
}

const WHISPER_READY =
  'WoWGPTDB.settings.whisper = true; WoWGPTDB.settings.whisperChoice = "on"; table.insert(WoWGPTDB.chats[1].history, { role = "user", text = "earlier", t = time() }); STUB.now = STUB.now + 20; STUB.Tick()';

const SCENARIOS = [
  { name: 'whisper tabs on, window closed', setup: vm => vm.run(WHISPER_READY) },
  { name: 'whisper tabs off, window closed', setup: vm => vm.run('WoWGPTDB.settings.whisper = false') },
  { name: 'whisper tabs off, window open', setup: vm => vm.run('WoWGPTDB.settings.whisper = false; WoWGPT.Toggle(true)') },
  { name: 'whisper tabs on, window open', setup: vm => vm.run(`${WHISPER_READY}; WoWGPT.Toggle(true)`) },
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
  vm.run('STUB.settings.proxies.WOWGPT_OPTION_ROLL:SetValue(false)');
  vm.run('STUB.settings.proxies.WOWGPT_OPTION_ECHO:SetValue("off")');
  vm.run('STUB.settings.proxies.WOWGPT_OPTION_WHISPER:SetValue(false)');
  vm.run('STUB.settings.proxies.WOWGPT_OPTION_WHISPER:SetValue(true)');
  assert.equal(vm.evaluate('WoWGPT.LootRollEnabled()'), 'false');
  assert.equal(vm.evaluate('WoWGPTDB.settings.echo'), 'off');
  assert.equal(vm.evaluate('WoWGPTDB.settings.whisperChoice'), 'on');
  assert.equal(vm.evaluate('OUTPUT_COUNTS()'), counts);
});

test('settings quiet path: a rejection comes back as a return value and writes nothing', () => {
  const vm = newVM();
  connect(vm);
  const counts = vm.evaluate('OUTPUT_COUNTS()');
  assert.match(vm.evaluate('WoWGPT.Config("nosuch on", { quiet = true })'), /^No setting "nosuch"/);
  assert.match(vm.evaluate('WoWGPT.Config("roll maybe", { quiet = true })'), /^roll does not take "maybe"/);
  assert.equal(vm.evaluate('WoWGPT.Config("roll off", { quiet = true })'), null);
  assert.match(vm.evaluate(`WoWGPTHelp.SetOption(${optionExpr('dim')}, "5")`), /^ui does not take "dim 5"/, 'the Options page gets the rejection back');
  assert.equal(vm.evaluate('OUTPUT_COUNTS()'), counts);
  assert.equal(vm.evaluate('WoWGPT.LootRollEnabled()'), 'false');
});

test('settings quiet path: the quiet context ends with the call, so the next typed command talks again', () => {
  const vm = newVM();
  connect(vm);
  vm.run('WoWGPT.Config("echo short", { quiet = true })');
  assert.equal(vm.evaluate('WoWGPT.Config("nosuch", { quiet = true }) ~= nil'), 'true');
  const before = vm.evaluate('#WoWGPTDB.chats[1].history');
  vm.run('WoWGPT.Config("echo full")');
  assert.equal(Number(vm.evaluate('#WoWGPTDB.chats[1].history')), Number(before) + 1);
  vm.run('WoWGPTVoice.Command = function() error("boom") end');
  assert.equal(vm.evaluate('pcall(WoWGPT.Config, "voice race", { quiet = true })'), 'false');
  vm.run('SlashCmdList.WOWGPT("errors")');
  assert.equal(Number(vm.evaluate('#WoWGPTDB.chats[1].history')), Number(before) + 2, 'an error inside a quiet call does not leave the addon quiet');
});

test('settings quiet path: a module that did not load is a silent no-op from Settings and a line when typed', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  vm.run('WoWGPTRoast, WoWGPTOrders = nil, nil');
  const counts = vm.evaluate('OUTPUT_COUNTS()');
  assert.equal(vm.evaluate('WoWGPT.Config("roast on", { quiet = true })'), null);
  assert.equal(vm.evaluate('WoWGPT.Config("orders off", { quiet = true })'), null);
  assert.equal(vm.evaluate('OUTPUT_COUNTS()'), counts);
  vm.run('WoWGPT.Config("roast on")');
  assert.match(vm.evaluate('STUB.prints[#STUB.prints]'), /the roast module did not load/);
});

test('settings quiet path: typed /wowgpt config stays verbose for every Options key', () => {
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
    vm.run(`SlashCmdList.WOWGPT(${JSON.stringify(cmd)})`);
    assert.notEqual(vm.evaluate('OUTPUT_COUNTS()'), counts, `${key}: typed config answers`);
  }
});

test('settings quiet path: voice lines and tests stay silent when quiet, and talk when typed', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  const counts = vm.evaluate('OUTPUT_COUNTS()');
  vm.run('WoWGPTVoice.Command("lines", { quiet = true }); WoWGPTVoice.Command("test done", { quiet = true })');
  assert.equal(vm.evaluate('OUTPUT_COUNTS()'), counts);
  vm.run('WoWGPTVoice.Command("lines")');
  assert.notEqual(vm.evaluate('OUTPUT_COUNTS()'), counts);
});

test('settings: Options is the top-level vertical category, Commands and tips and Widgets are canvas subcategories', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('table.concat(STUB.settings.order, ",")'), 'vertical WoWGPT,canvas sub Commands and tips,canvas sub Widgets,addon WoWGPT');
  assert.equal(vm.evaluate('STUB.settings.categories[1].kind'), 'vertical');
  assert.equal(vm.evaluate('STUB.settings.categories[1].parent'), null);
  assert.equal(vm.evaluate('STUB.settings.categories[2].frame == WoWGPTHelpPanel'), 'true');
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
  vm.run('WoWGPT.ShowOptions(); WoWGPT.ShowHelp()');
  assert.equal(vm.evaluate('table.concat(STUB.settings.opened, ",")'), '41,45');
  vm.run('WoWGPTMinimapButton.scripts.OnClick(WoWGPTMinimapButton, "RightButton")');
  assert.equal(vm.evaluate('STUB.settings.opened[3]'), '41', 'the minimap right-click opens the top-level Options page');
});

test('settings: a client with a canvas category but no vertical layout puts an Options canvas on top and keeps the help page under it', () => {
  const vm = newVM({ prelude: SETTINGS_API + '\nSettings.RegisterVerticalLayoutCategory = nil' });
  assert.equal(vm.evaluate('table.concat(STUB.settings.order, ",")'), 'canvas WoWGPT,canvas sub Commands and tips,addon WoWGPT');
  assert.equal(vm.evaluate('STUB.settings.categories[1].frame == WoWGPTOptionsPanel'), 'true');
  assert.equal(vm.evaluate('#WoWGPTOptionsPanel.controls'), '14');
  vm.run('WoWGPT.ShowOptions(); WoWGPT.ShowHelp()');
  assert.equal(vm.evaluate('table.concat(STUB.settings.opened, ",")'), '40,45');
});

test('settings: without a subcategory API the help page opens in its own window, Options in Settings', () => {
  const vm = newVM({ prelude: SETTINGS_API + '\nSettings.RegisterCanvasLayoutSubcategory = nil' });
  vm.run('WoWGPT.ShowOptions(); WoWGPT.ShowHelp()');
  assert.equal(vm.evaluate('table.concat(STUB.settings.opened, ",")'), '41');
  assert.equal(vm.evaluate('WoWGPTHelpWindow.shown'), 'true');
});

test('settings: Interface Options lists Options on top and the help page under it', () => {
  const vm = newVM({
    prelude:
      'STUB.legacy, STUB.legacyOpened = {}, {}; function InterfaceOptions_AddCategory(p) table.insert(STUB.legacy, p) end; function InterfaceOptionsFrame_OpenToCategory(p) table.insert(STUB.legacyOpened, p) end',
  });
  assert.equal(vm.evaluate('STUB.legacy[1] == WoWGPTOptionsPanel'), 'true');
  assert.equal(vm.evaluate('WoWGPTOptionsPanel.parent'), null);
  assert.equal(vm.evaluate('STUB.legacy[2] == WoWGPTHelpPanel'), 'true');
  assert.equal(vm.evaluate('WoWGPTHelpPanel.parent'), 'WoWGPT');
  vm.run('WoWGPT.ShowHelp()');
  assert.equal(vm.evaluate('STUB.legacyOpened[1] == WoWGPTHelpPanel'), 'true');
  vm.run('STUB.legacyOpened = {}; WoWGPT.ShowOptions()');
  assert.equal(vm.evaluate('STUB.legacyOpened[1] == WoWGPTOptionsPanel'), 'true');
});

const helpRows = vm =>
  JSON.parse(
    vm.evaluate(
      '(function() local t = {} for _, s in ipairs(WoWGPT.HELP) do for _, r in ipairs(s.rows or {}) do t[#t + 1] = string.format("[%q,%q,%q]", s.title, r[1], r[2]) end for _, n in ipairs(s.notes or {}) do t[#t + 1] = string.format("[%q,%q,%q]", s.title, "", n) end end return "[" .. table.concat(t, ",") .. "]" end)()',
    ),
  );

test('help rows: player commands first, transport rows only in a last More section, no hide row, companion app and project wording', () => {
  const vm = newVM();
  const rows = helpRows(vm);
  const titles = [...new Set(rows.map(r => r[0]))];
  assert.equal(titles[titles.length - 1], 'More');
  assert.ok(!titles.includes('Troubleshooting'));
  for (const cmd of ['/wowgpt resend', '/wowgpt slots', '/wowgpt diag [copy]', '/wowgpt probe [chatlog|asyncfile]']) {
    const row = rows.find(r => r[1] === cmd);
    assert.ok(row, cmd);
    assert.equal(row[0], 'More', cmd);
  }
  assert.ok(!rows.some(r => /hide \| mini/.test(r[1])), 'no hide | mini row');
  for (const r of rows) {
    if (/\/claude config \[key\] \[value\]/.test(r[1])) continue;
    assert.doesNotMatch(r[2], /bridge/i, r[1]);
    if (r[1].startsWith('/wowgpt --add-dir')) continue;
    assert.doesNotMatch(r[1] + ' ' + r[2], /folder/i, r[1]);
  }
  assert.ok(rows.some(r => r[1] === '/wowgpt cd <project path>'));
});

test('help: one roll wording in Options, /wowgpt config and the roll command', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  const wording = vm.evaluate('WoWGPT.ROLL_HELP');
  assert.match(wording, /^A command that needs your OK opens a Greed, Need or Pass roll\./);
  assert.equal(vm.evaluate('STUB.settings.proxies.WOWGPT_OPTION_ROLL ~= nil'), 'true');
  assert.equal(vm.evaluate(`${optionExpr('roll')}.tooltip`), wording);
  vm.run('SlashCmdList.WOWGPT("config")');
  assert.ok(vm.evaluate('WoWGPTDB.chats[1].history[#WoWGPTDB.chats[1].history].text').includes('roll = on  -  on|off: ' + wording));
  vm.run('STUB.prints = {}; SlashCmdList.WOWGPT("config roll off")');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Ask with a roll window is off. ' + wording));
});

test('help: the config list points at the top-level Options page and keeps bridge out of player keys', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  vm.run('SlashCmdList.WOWGPT("config")');
  const list = vm.evaluate('WoWGPTDB.chats[1].history[#WoWGPTDB.chats[1].history].text');
  assert.match(list, /The game's Options window has the same settings: AddOns, WoWGPT\.\n/);
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

const SINKS = new Set(['print', 'AddHistory', 'Finish', 'TellPlayer', 'Cli.Out', 'Cli.Say', 'Cli.Note', 'Cli.Reject', 'WoWGPT.Print']);
const DEV_FUNCTIONS = new Set([
  'Cli.DevCommand',
  'Cli.Diag',
  'WoWGPT.ChatLog.Status',
  'PollPresence',
  'Presence.Check',
  'Presence.Scheme',
  'WoWGPT.Version.ClientsStatus',
  'WoWGPT.Version.Status',
]);
const DEV_VERBS = new Set(['diag', 'probe', 'dev', 'wrong', 'bug', 'mode', 'signal', 'auto', 'longchat']);
const ALLOWED_LITERALS = [
  'update-bridge',
  'bridge-older',
  'bridge',
  'WOWGPT_FOLDER',
  'the bridge read the last message only from the screenshot retry',
  "the companion app's folder",
  'Project for this chat\\n\\nType a full path, a path that starts with ~, or a folder name inside %s.',
  'folder ',
  '. Extra folders for this chat: ',
  ' folders), so it is added for this retry only',
  'Add the folder for this retry only.',
  'Add the folder always, for this chat, like /wowgpt --add-dir, and retry.',
  "outside this chat's folders:%s*$",
  'One more folder the agent may use.',
  ' --add-dir folders.',
  'extra folders: ',
];
const PREFIX_ALLOWED = new Set([
  'Project for this chat\\n\\nType a full path, a path that starts with ~, or a folder name inside %s.',
  'Add the folder for this retry only.',
  'One more folder the agent may use.',
]);

function calleeName(n) {
  if (!n) return '?';
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'MemberExpression') return calleeName(n.base) + n.indexer + n.identifier.name;
  return '?';
}

function devBranch(clause) {
  const found = [];
  const look = n => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'BinaryExpression' && n.operator === '==' && n.left.type === 'Identifier' && n.left.name === 'cmd' && n.right.type === 'StringLiteral')
      found[found.length] = n.right.raw.slice(1, -1);
    for (const k of ['left', 'right', 'argument']) look(n[k]);
  };
  look(clause.condition);
  return found.length > 0 && found.every(v => DEV_VERBS.has(v));
}

function allowedLiteral(text) {
  return ALLOWED_LITERALS.some(a => (PREFIX_ALLOWED.has(a) ? text.startsWith(a) : text === a));
}

function addonLiterals(file) {
  const src = fs.readFileSync(path.join(ADDON, file), 'utf8');
  const ast = luaparse.parse(src, { luaVersion: '5.1', comments: false, locations: true });
  const out = [];
  const walk = (node, fn, sink) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(n => walk(n, fn, sink));
    if (node.type === 'FunctionDeclaration' && node.identifier) fn = calleeName(node.identifier);
    if (node.type === 'AssignmentStatement' || node.type === 'LocalStatement') {
      node.init.forEach((v, i) => walk(v, v && v.type === 'FunctionDeclaration' && node.variables[i] ? calleeName(node.variables[i]) : fn, sink));
      return;
    }
    if (DEV_FUNCTIONS.has(fn)) return;
    if ((node.type === 'IfClause' || node.type === 'ElseifClause') && devBranch(node)) return;
    if ((node.type === 'CallExpression' || node.type === 'StringCallExpression') && SINKS.has(calleeName(node.base))) sink = calleeName(node.base);
    if (node.type === 'StringLiteral') out[out.length] = { file, text: node.raw.slice(1, -1), line: node.loc.start.line, fn, sink };
    for (const k of Object.keys(node)) if (k !== 'loc') walk(node[k], fn, sink);
  };
  walk(ast, '<file>', null);
  return out;
}

const CORE_FILES = () => tocFiles().filter((f, i, files) => (f.includes('/') && i < files.indexOf('WoWGPT.lua')) || f === 'WoWGPT.lua');

const coreLiterals = () => CORE_FILES().flatMap(addonLiterals);

test('module text: every literal in WoWGPT.lua and the Core and Transport files says companion app and project, except the diag, log and developer functions and listed protocol words', () => {
  const found = coreLiterals();
  assert.ok(found.length > 2000, `the scan sees every literal (${found.length})`);
  assert.ok(
    found.some(s => s.text.includes('companion app could not finish')),
    'the failed-run prefix is scanned',
  );
  assert.ok(
    found.some(s => s.sink === 'TellPlayer' && s.text.includes('Companion app is back')),
    'the transport notices are scanned',
  );
  assert.ok(
    found.some(s => s.fn === 'Cli.McpMissing' && s.text.includes('companion app')),
    'helpers that build text for a sink are scanned',
  );
  assert.ok(
    found.some(s => s.fn === 'VisionStatus'),
    'local helper functions are scanned',
  );
  for (const s of found) {
    if (allowedLiteral(s.text)) continue;
    assert.doesNotMatch(s.text, /bridge/i, `${s.file}:${s.line} in ${s.fn}: ${s.text}`);
    assert.doesNotMatch(s.text, /folder/i, `${s.file}:${s.line} in ${s.fn}: ${s.text}`);
  }
});

test('module text: the allowlists still hold bridge words, so it is the allowlist and not a blind scan that passes them', () => {
  const src = fs.readFileSync(path.join(ADDON, 'WoWGPT.lua'), 'utf8');
  assert.ok(/The bridge has not said it has dev tools/.test(src));
  assert.ok(/bridge default, /.test(fs.readFileSync(path.join(ADDON, 'Commands', 'Diag.lua'), 'utf8')));
  const found = coreLiterals();
  assert.ok(!found.some(s => /dev tools/.test(s.text)), 'Cli.DevCommand is skipped');
  assert.ok(!found.some(s => s.text === 'bridge default, '), 'the diag branch is skipped');
  for (const a of ALLOWED_LITERALS)
    assert.ok(
      found.some(s => (PREFIX_ALLOWED.has(a) ? s.text.startsWith(a) : s.text === a)),
      `allowlist entry still used: ${a}`,
    );
});

test('module text: cd, agent, discord, restore and a failed run read in companion app words', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  const last = () => vm.evaluate('WoWGPTDB.chats[1].history[#WoWGPTDB.chats[1].history].text');
  vm.run('WoWGPTDB.chats[1].cwd = ""; SlashCmdList.WOWGPT("cd")');
  assert.match(last(), /^Project is the companion app's default: .* \(\/wowgpt cd <path>, or right-click the chat and pick Project\.\.\., to change\)$/);
  vm.run('SlashCmdList.WOWGPT("--agent nope")');
  assert.match(last(), /Unknown agent "nope"\. The companion app knows: /);
  vm.run('SlashCmdList.WOWGPT("discord")');
  assert.doesNotMatch(last(), /bridge/i);
});

test('settings widgets page: Show and Remove change the widget and write nothing', () => {
  const vm = newVM({
    saved:
      'WoWGPTWidgetDB = { approved = { meter = { rev = "r1", source = "local ui = ..." } }, set = { epoch = "e1", version = 1, items = { { name = "meter", title = "DPS meter", rev = "r1", source = "local ui = ..." }, { name = "clock", title = "Clock", rev = "r2", source = "local ui = ..." } } } }',
  });
  connect(vm);
  vm.run('WoWGPTWidgetsPanel.scripts.OnShow(WoWGPTWidgetsPanel)');
  const row = i => `WoWGPTWidgetsPanel.rows[${i}]`;
  const counts = vm.evaluate('OUTPUT_COUNTS()');
  vm.run(`${row(1)}.button.scripts.OnClick(${row(1)}.button)`);
  assert.equal(vm.evaluate('WoWGPTWidgets.Status("meter")'), 'removed');
  vm.run(`${row(2)}.button.scripts.OnClick(${row(2)}.button)`);
  assert.equal(vm.evaluate('WoWGPTWidgets.Status("clock")'), 'running');
  vm.run(`${row(1)}.button.scripts.OnClick(${row(1)}.button)`);
  assert.equal(vm.evaluate('WoWGPTWidgets.Status("meter")'), 'running');
  assert.equal(vm.evaluate('OUTPUT_COUNTS()'), counts, 'no history, chat, tab or print');
  vm.run('SlashCmdList.WOWGPT("config ui remove clock")');
  assert.notEqual(vm.evaluate('OUTPUT_COUNTS()'), counts, 'the typed command still answers');
  const typed = vm.evaluate('OUTPUT_COUNTS()');
  vm.run('WoWGPTWidgets.Remove("nosuch", { quiet = true })');
  assert.equal(vm.evaluate('OUTPUT_COUNTS()'), typed, 'an unknown name is silent from Settings');
});

test('module text: the changed lines read as the player sees them', () => {
  const vm = newVM({ dock: false });
  connect(vm);
  vm.run('STUB.prints = {}; SlashCmdList.WOWGPT("config telemetry off")');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('the companion app gets no game state'));
  vm.run('STUB.prints = {}; SlashCmdList.WOWGPT("config telemetry on")');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('go to the companion app.'));
  vm.run('STUB.prints = {}; SlashCmdList.WOWGPT("config voice")');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('the companion app picked the message up'));
});
