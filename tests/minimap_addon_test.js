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
STUB.opened = {}
Settings = {
  RegisterCanvasLayoutCategory = function(frame, name)
    local c = { frame = frame, name = name }
    function c:GetID() return 42 end
    return c
  end,
  RegisterCanvasLayoutSubcategory = function(parent, frame, name)
    local c = { frame = frame, name = name, parent = parent }
    function c:GetID() return name == "Options" and 44 or 45 end
    return c
  end,
  RegisterAddOnCategory = function() end,
  OpenToCategory = function(id) table.insert(STUB.opened, id) end,
}
`;

const TIP_SPY = `
TIP = {}
GameTooltip.SetText = function(self, text) self.text = text; TIP = { "title=" .. tostring(text) } end
GameTooltip.AddLine = function(self, text, r, g, b) table.insert(TIP, tostring(text) .. (r and string.format(" @%.1f,%.1f,%.1f", r, g, b) or "")) end
GameTooltip.AddDoubleLine = function(self, a, b) table.insert(TIP, tostring(a) .. "=" .. tostring(b)) end
`;

function newVM(prelude = '') {
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
  run('UnitRace = function() return "Human", "Human" end; UnitSex = function() return 2 end');
  run(SETTINGS_API);
  if (prelude) run(prelude);
  for (const f of TOC_FILES) runFile(fs.readFileSync(path.join(ADDON, f), 'utf8'));
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate };
}

const B = 'ClaudeWoWMinimapButton';
const offset = vm => [Math.round(Number(vm.evaluate(`${B}.x`))), Math.round(Number(vm.evaluate(`${B}.y`)))];
const dragTo = (vm, x, y) =>
  vm.run(`local b = ${B}; b.scripts.OnDragStart(b); STUB.cursor = { ${x}, ${y} }; b.scripts.OnUpdate(b, 0.02); b.scripts.OnDragStop(b)`);

test('minimap button: a 31 px button on the Minimap with the Claude portrait, round, with the tracking border and zoom highlight', () => {
  const vm = newVM();
  assert.equal(vm.evaluate(`${B}.kind`), 'Button');
  assert.equal(vm.evaluate(`${B}.parent == Minimap`), 'true');
  assert.equal(vm.evaluate(`${B}.width .. "x" .. ${B}.height`), '31x31');
  assert.equal(vm.evaluate(`${B}.shown`), 'true', 'on by default');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.minimap'), 'true');
  assert.equal(vm.evaluate(`${B}.icon:GetTexture()`), 'Interface\\AddOns\\ClaudeWoW\\Portrait');
  assert.equal(vm.evaluate(`${B}.icon.stubMask`), 'Interface\\CharacterFrame\\TempPortraitAlphaMask');
  assert.equal(vm.evaluate(`${B}.border:GetTexture()`), 'Interface\\Minimap\\MiniMap-TrackingBorder');
  assert.equal(vm.evaluate(`${B}.background:GetTexture()`), 'Interface\\Minimap\\UI-Minimap-Background');
  assert.equal(vm.evaluate(`${B}.stubHighlight`), 'Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight');
  assert.equal(vm.evaluate(`table.concat(${B}.stubDragButtons, ",")`), 'LeftButton');
  assert.equal(vm.evaluate(`table.concat(${B}.stubClickButtons, ",")`), 'AnyUp');
  assert.equal(vm.evaluate(`${B}.point .. " " .. tostring(${B}.rel == Minimap)`), 'CENTER true');
  assert.deepEqual(offset(vm), [-53, -53], 'the default angle, 225 degrees, at the lower left');
});

test('minimap button: without SetMask the icon falls back to an inset texture crop', () => {
  const vm = newVM('STUB.noMask = true');
  assert.equal(vm.evaluate(`${B}.icon.stubMask`), null);
  assert.equal(vm.evaluate(`table.concat(${B}.icon.stubTexCoord, ",")`), '0.05,0.95,0.05,0.95');
});

test('minimap button: left-click opens and closes the window, right-click opens the Options page', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false', 'closed at a first login');
  vm.run(`${B}.scripts.OnClick(${B}, "LeftButton")`);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true');
  vm.run(`${B}.scripts.OnClick(${B}, "LeftButton")`);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false');
  assert.equal(vm.evaluate('#STUB.opened'), '0');
  vm.run(`${B}.scripts.OnClick(${B}, "RightButton")`);
  assert.equal(vm.evaluate('table.concat(STUB.opened, ",")'), '44', 'the Options subcategory');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false', 'a right-click does not toggle the window');
});

test('minimap button: a drag follows the cursor around the edge and saves the angle account-wide', () => {
  const vm = newVM();
  const [cx, cy] = [Number(vm.evaluate('select(1, Minimap:GetCenter())')), Number(vm.evaluate('select(2, Minimap:GetCenter())'))];
  vm.run(`local b = ${B}; b.scripts.OnDragStart(b)`);
  assert.equal(vm.evaluate(`${B}.scripts.OnUpdate ~= nil`), 'true', 'tracks the cursor while dragged');
  assert.equal(vm.evaluate(`${B}.stubHighlightLocked`), 'true');
  vm.run(`STUB.cursor = { ${cx}, ${cy + 200} }; local b = ${B}; b.scripts.OnUpdate(b, 0.02)`);
  assert.deepEqual(offset(vm), [0, 75], 'moves while the button is held');
  vm.run(`local b = ${B}; b.scripts.OnDragStop(b)`);
  assert.equal(vm.evaluate(`${B}.scripts.OnUpdate`), null, 'stops tracking on release');
  assert.equal(vm.evaluate(`${B}.stubHighlightLocked`), 'false');
  assert.equal(vm.evaluate('math.floor(ClaudeWoWDB.settings.minimapAngle + 0.5)'), '90');
  assert.deepEqual(offset(vm), [0, 75], 'stays on top of the round minimap, 5 px outside its edge');
  vm.run('Minimap.scale = 2');
  dragTo(vm, (cx - 100) * 2, cy * 2);
  assert.equal(vm.evaluate('math.floor(ClaudeWoWDB.settings.minimapAngle + 0.5)'), '180', 'the cursor is in screen pixels, scaled to the minimap');
  assert.deepEqual(offset(vm), [-75, 0]);
});

test('minimap button: a saved angle is placed at login, and a square minimap puts it on the square edge', () => {
  const round = newVM('ClaudeWoWDB = { settings = { minimapAngle = 30 } }');
  assert.deepEqual(offset(round), [65, 38]);
  const square = newVM('ClaudeWoWDB = { settings = { minimapAngle = 30 } }; function GetMinimapShape() return "SQUARE" end');
  assert.deepEqual(offset(square), [75, 48], 'clamped to the corner box instead of the circle');
  const corner = newVM('ClaudeWoWDB = { settings = { minimapAngle = 30 } }; function GetMinimapShape() return "CORNER-BOTTOMLEFT" end');
  assert.deepEqual(offset(corner), [75, 48], 'the round corner of CORNER-BOTTOMLEFT is the lower left, so the upper right is square');
  const lowerLeft = newVM('ClaudeWoWDB = { settings = { minimapAngle = 210 } }; function GetMinimapShape() return "CORNER-BOTTOMLEFT" end');
  assert.deepEqual(offset(lowerLeft), [-65, -37], 'and its lower left stays round');
  const upperLeft = newVM('ClaudeWoWDB = { settings = { minimapAngle = 150 } }; function GetMinimapShape() return "CORNER-BOTTOMLEFT" end');
  assert.deepEqual(offset(upperLeft), [-75, 48], 'while its upper left is square');
  const unknown = newVM('ClaudeWoWDB = { settings = { minimapAngle = 30 } }; function GetMinimapShape() return "STAR" end');
  assert.deepEqual(offset(unknown), [65, 38], 'an unknown shape is round');
});

test('minimap button: /claude config minimap and the Options checkbox hide and show the same button', () => {
  const vm = newVM();
  vm.run('FIRST = ClaudeWoWMinimapButton');
  vm.run('SlashCmdList.CLAUDE("config minimap off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.minimap'), 'false');
  assert.equal(vm.evaluate(`${B}.shown`), 'false');
  assert.equal(vm.evaluate(`${B} == FIRST`), 'true', 'hidden, not destroyed');
  vm.run('SlashCmdList.CLAUDE("config minimap on")');
  assert.equal(vm.evaluate(`${B}.shown`), 'true');
  const option = '(function() for _, o in ipairs(ClaudeWoWHelp.Options()) do if o.key == "minimap" then return o end end end)()';
  assert.equal(vm.evaluate(`${option}.label`), 'Minimap button');
  vm.run(`ClaudeWoWHelp.SetOption(${option}, false)`);
  assert.equal(vm.evaluate(`${B}.shown`), 'false');
  assert.equal(vm.evaluate(`ClaudeWoWHelp.OptionValue(${option})`), 'false');
  vm.run(`ClaudeWoWHelp.SetOption(${option}, true)`);
  assert.equal(vm.evaluate(`${B}.shown`), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.minimap'), 'true');
});

test('minimap button: a player who turned it off logs in with it hidden', () => {
  const vm = newVM('ClaudeWoWDB = { settings = { minimap = false } }');
  assert.equal(vm.evaluate(`${B}.shown`), 'false');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.minimap'), 'false', 'the saved choice is kept');
});

test('minimap button: the tooltip names the addon, says the status in words, the API cost and the green click hints', () => {
  const vm = newVM(TIP_SPY);
  vm.run(`${B}.scripts.OnEnter(${B})`);
  assert.equal(vm.evaluate('GameTooltip.owner == ClaudeWoWMinimapButton'), 'true');
  assert.deepEqual(vm.evaluate('table.concat(TIP, "|")').split('|'), [
    'title=Azeroth Companion',
    "Can't reach the bridge. Start it, then click Connect. @1.0,1.0,1.0",
    ' ',
    'Left-click: open or close @0.1,1.0,0.1',
    'Right-click: options @0.1,1.0,0.1',
  ]);
  vm.run('ClaudeWoW.IsConnected = function() return true end');
  vm.run('for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then c.cost = 1.5 end end');
  vm.run(`${B}.scripts.OnEnter(${B})`);
  const tip = vm.evaluate('table.concat(TIP, "|")').split('|');
  assert.equal(tip[1], 'Ready @1.0,1.0,1.0');
  assert.ok(tip.includes('Estimated API cost @1.0,0.8,0.0'), tip.join(' / '));
  assert.ok(tip.includes('This chat=$1.50'));
  assert.ok(tip.includes('All chats=$1.50'));
  assert.equal(tip.at(-1), 'Right-click: options @0.1,1.0,0.1');
  vm.run('for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then c.pendingId = 7 end end');
  vm.run(`${B}.scripts.OnEnter(${B})`);
  assert.equal(vm.evaluate('TIP[2]'), 'Working... @1.0,1.0,1.0', 'plain words, no color codes');
  vm.run(`TIP = {}; local b = ${B}; b.scripts.OnDragStart(b); b.scripts.OnEnter(b)`);
  assert.equal(vm.evaluate('#TIP'), '0', 'no tooltip while dragging');
});

test('minimap button: no Minimap frame, no button and no error', () => {
  const vm = newVM('Minimap = nil');
  assert.equal(vm.evaluate(B), null);
  vm.run('SlashCmdList.CLAUDE("config minimap off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.minimap'), 'false');
});
