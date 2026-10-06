'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ICON = require('../dev/make-minimap-icon');
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

const MAINLINE = 'WOW_PROJECT_MAINLINE = 1; WOW_PROJECT_ID = 1';
const CLASSIC = 'WOW_PROJECT_MAINLINE = 1; WOW_PROJECT_ID = 2';
const SPARK = 'Interface\\AddOns\\ClaudeWoW\\MinimapIcon';
const PORTRAIT = 'Interface\\AddOns\\ClaudeWoW\\Portrait';
const texCoord = vm => vm.evaluate(`table.concat(${B}.icon.stubTexCoord, ",")`);
const anchor = (vm, t) => vm.evaluate(`${B}.${t}.point .. " " .. ${B}.${t}.x .. "," .. ${B}.${t}.y`);
const size = (vm, t) => vm.evaluate(`${B}.${t}.width .. "x" .. ${B}.${t}.height`);

test('minimap button: a 31 px LibDBIcon button on the Minimap with the Claude spark, the tracking border on top and the zoom highlight', () => {
  const vm = newVM();
  assert.equal(vm.evaluate(`${B}.kind`), 'Button');
  assert.equal(vm.evaluate(`${B}.parent == Minimap`), 'true');
  assert.equal(vm.evaluate(`${B}.width .. "x" .. ${B}.height`), '31x31');
  assert.equal(vm.evaluate(`${B}.strata .. " " .. ${B}.frameLevel`), 'MEDIUM 8');
  assert.equal(vm.evaluate(`${B}.shown`), 'true', 'on by default');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.minimap'), 'true');
  assert.equal(vm.evaluate(`${B}.icon:GetTexture()`), SPARK);
  assert.equal(vm.evaluate(`${B}.icon.stubMask`), null, 'the spark has its own transparent edge: no mask');
  assert.equal(texCoord(vm), '0.05,0.95,0.05,0.95', 'the LibDBIcon 5% inset at rest');
  assert.equal(vm.evaluate(`${B}.border:GetTexture()`), 'Interface\\Minimap\\MiniMap-TrackingBorder');
  assert.equal(vm.evaluate(`${B}.background:GetTexture()`), 'Interface\\Minimap\\UI-Minimap-Background');
  assert.equal(
    vm.evaluate(`${B}.background.layer .. " " .. ${B}.icon.layer .. " " .. ${B}.border.layer`),
    'BACKGROUND ARTWORK OVERLAY',
    'the gold ring draws above the icon',
  );
  assert.equal(vm.evaluate(`${B}.stubHighlight`), 'Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight');
  assert.equal(vm.evaluate(`table.concat(${B}.stubDragButtons, ",")`), 'LeftButton');
  assert.equal(vm.evaluate(`table.concat(${B}.stubClickButtons, ",")`), 'AnyUp');
  assert.equal(vm.evaluate(`${B}.point .. " " .. tostring(${B}.rel == Minimap)`), 'CENTER true');
  assert.deepEqual(offset(vm), [-53, -53], 'the default angle, 225 degrees, at the lower left');
});

test('minimap button: sizes and anchors follow LibDBIcon-1.0 for the client layout', () => {
  const classic = newVM(CLASSIC);
  assert.equal(size(classic, 'border'), '53x53');
  assert.equal(anchor(classic, 'border'), 'TOPLEFT 0,0');
  assert.equal(size(classic, 'background'), '20x20');
  assert.equal(anchor(classic, 'background'), 'TOPLEFT 7,-5');
  assert.equal(size(classic, 'icon'), '17x17');
  assert.equal(anchor(classic, 'icon'), 'TOPLEFT 7,-6');
  const era = newVM();
  assert.equal(size(era, 'border') + ' ' + size(era, 'icon'), '53x53 17x17', 'no WOW_PROJECT_ID: the classic layout');
  const mainline = newVM(MAINLINE);
  assert.equal(size(mainline, 'border'), '50x50');
  assert.equal(anchor(mainline, 'border'), 'TOPLEFT 0,0');
  assert.equal(size(mainline, 'background'), '24x24');
  assert.equal(anchor(mainline, 'background'), 'CENTER 0,0');
  assert.equal(size(mainline, 'icon'), '18x18');
  assert.equal(anchor(mainline, 'icon'), 'CENTER 0,0');
});

test('minimap button: a press shows the full icon like LibDBIcon, and a release or drag end restores the inset', () => {
  const vm = newVM();
  vm.run(`${B}.scripts.OnMouseDown(${B}, "LeftButton")`);
  assert.equal(texCoord(vm), '0,1,0,1');
  vm.run(`${B}.scripts.OnMouseUp(${B}, "LeftButton")`);
  assert.equal(texCoord(vm), '0.05,0.95,0.05,0.95');
  vm.run(`local b = ${B}; b.scripts.OnDragStart(b)`);
  assert.equal(texCoord(vm), '0,1,0,1', 'held while dragged');
  vm.run(`local b = ${B}; b.scripts.OnDragStop(b)`);
  assert.equal(texCoord(vm), '0.05,0.95,0.05,0.95');
});

test('minimap button: a client that has not restarted since MinimapIcon.tga was added falls back to the round portrait', () => {
  const vm = newVM(`STUB.missingTextures = { [ [[${SPARK}]] ] = true }`);
  assert.equal(vm.evaluate(`${B}.icon:GetTexture()`), PORTRAIT);
  assert.equal(vm.evaluate(`${B}.icon.stubMask`), 'Interface\\CharacterFrame\\TempPortraitAlphaMask');
  assert.equal(texCoord(vm), '0.2,0.8,0.2,0.8', 'the portrait is cropped to its spark so it fills the circle');
  vm.run(`${B}.scripts.OnMouseDown(${B}, "LeftButton")`);
  assert.equal(texCoord(vm), '0.18,0.82,0.18,0.82');
  vm.run(`${B}.scripts.OnMouseUp(${B}, "LeftButton")`);
  assert.equal(texCoord(vm), '0.2,0.8,0.2,0.8');
  const noMask = newVM(`STUB.noMask = true; STUB.missingTextures = { [ [[${SPARK}]] ] = true }`);
  assert.equal(noMask.evaluate(`${B}.icon:GetTexture()`), PORTRAIT, 'no SetMask: still the portrait, cropped, and no error');
  assert.equal(noMask.evaluate(`${B}.icon.stubMask`), null);
});

test('minimap icon: MinimapIcon.tga is the 64x64 32-bit spark that dev/make-minimap-icon.js draws', () => {
  const file = fs.readFileSync(path.join(ADDON, 'MinimapIcon.tga'));
  assert.equal(file[2], 2, 'uncompressed true color');
  assert.equal(file.readUInt16LE(12), 64);
  assert.equal(file.readUInt16LE(14), 64);
  assert.equal(file[16], 32);
  assert.equal(file[17] & 0x0f, 8, '8 alpha bits');
  assert.equal(file.length, 18 + 64 * 64 * 4);
  const fresh = ICON.makeIcon();
  assert.equal(fresh.length, file.length);
  let drift = 0;
  for (let i = 18; i < file.length; i++) drift = Math.max(drift, Math.abs(file[i] - fresh[i]));
  assert.ok(drift <= 2, `the committed file matches the script (max channel drift ${drift})`);
  const { rgba } = ICON.decodeTga(file);
  const px = (x, y) => Array.from(rgba.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  for (const [x, y] of [
    [0, 0],
    [63, 0],
    [0, 63],
    [63, 63],
  ])
    assert.equal(px(x, y)[3], 0, 'transparent corners');
  const center = px(32, 32);
  assert.equal(center[3], 255);
  assert.ok(center[0] > ICON.ORANGE[0] && center[1] > ICON.ORANGE[1], 'a lighter center');
  let top = 64;
  let bottom = -1;
  let covered = 0;
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      if (px(x, y)[3] === 0) continue;
      covered++;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  const span = (bottom - top + 1) / 64;
  assert.ok(span > 0.75 && span < 0.92, `the spark fills about 85% of the canvas (${span})`);
  assert.ok(covered < 64 * 64 * 0.5, 'rays with gaps, not a disc');
  const solid = [];
  for (let i = 0; i < 64 * 64; i++) if (rgba[i * 4 + 3] === 255) solid.push(rgba.subarray(i * 4, i * 4 + 3));
  const rim = solid.filter(c => c[0] === ICON.ORANGE[0] && c[1] === ICON.ORANGE[1] && c[2] === ICON.ORANGE[2]);
  assert.ok(rim.length > 0, 'the rays are Claude orange #D97757');
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

const STATE_ICONS = {
  ok: 'Interface\\FriendsFrame\\StatusIcon-Online',
  stale: 'Interface\\FriendsFrame\\StatusIcon-Away',
  down: 'Interface\\FriendsFrame\\StatusIcon-DnD',
  unknown: 'Interface\\FriendsFrame\\StatusIcon-Offline',
};

test('minimap button: an 8 px status light at the lower right, above the gold ring, follows the bridge state like the window light', () => {
  const vm = newVM();
  assert.equal(vm.evaluate(`${B}.dot.parent == ${B}`), 'true', 'a texture of the button, so it hides with it');
  assert.equal(vm.evaluate(`${B}.dot.width .. "x" .. ${B}.dot.height`), '8x8');
  assert.equal(vm.evaluate(`${B}.dot.point .. " " .. ${B}.dot.relPoint`), 'BOTTOMRIGHT BOTTOMRIGHT');
  assert.equal(vm.evaluate(`${B}.dot.layer`), 'OVERLAY', 'the same layer as the ring, on a higher sublevel');
  assert.equal(vm.evaluate(`${B}.dot:GetTexture()`), STATE_ICONS.unknown, 'not seen yet: grey');
  for (const state of ['ok', 'stale', 'down', 'unknown']) {
    vm.run(`ClaudeWoW.BridgeState = function() return "${state}", 0, 0, 0, "tip ${state}" end; ClaudeWoW.UpdateDot()`);
    assert.equal(vm.evaluate(`${B}.dot:GetTexture()`), STATE_ICONS[state], state);
    assert.equal(vm.evaluate(`${B}.dot:GetTexture() == ClaudeWoW.UI.dot:GetTexture()`), 'true', 'the same light as the window');
  }
  vm.run('SlashCmdList.CLAUDE("config minimap off")');
  assert.equal(vm.evaluate(`${B}.shown`), 'false', 'the light goes with the hidden button');
});

test('minimap button: it pulses while a reply is unread and the window is closed, glows while an agent works, and stops when the window opens', () => {
  const vm = newVM(TIP_SPY);
  const signal = () => vm.evaluate(`${B}.signal`);
  const pulsing = () => vm.evaluate(`${B}.pulse:IsPlaying()`);
  const glow = () => vm.evaluate(`${B}.glow.shown`);
  assert.equal(vm.evaluate(`${B}.glow:GetTexture()`), 'Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight', 'the Blizzard minimap highlight');
  assert.equal(signal(), 'idle');
  assert.equal(pulsing(), 'false');
  assert.equal(glow(), 'false');

  vm.run('ClaudeWoWDB.chats[1].unread = 1; ClaudeWoW.Notify(ClaudeWoWDB.chats[1], "done", "claude", nil, "assistant")');
  assert.equal(signal(), 'reply');
  assert.equal(pulsing(), 'true', 'an unread reply with the window closed pulses');
  assert.equal(glow(), 'true');
  vm.run(`${B}.scripts.OnEnter(${B})`);
  assert.ok(vm.evaluate('table.concat(TIP, "|")').includes('1 new reply @1.0,0.8,0.0'), 'the tooltip counts it');

  vm.run(`${B}.scripts.OnClick(${B}, "LeftButton")`);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true');
  assert.equal(signal(), 'idle');
  assert.equal(pulsing(), 'false', 'opening the window stops it');
  assert.equal(glow(), 'false');

  vm.run('ClaudeWoWDB.chats[1].pendingId = 7; ClaudeWoW.Render()');
  assert.equal(signal(), 'idle', 'nothing while the window is open');
  vm.run('ClaudeWoW.Toggle(false)');
  assert.equal(signal(), 'working', 'an agent at work with the window closed');
  assert.equal(pulsing(), 'false', 'a steady glow, not a pulse');
  assert.equal(glow(), 'true');
  assert.equal(vm.evaluate(`${B}.glow:GetAlpha()`), '0.4');
  vm.run(`${B}.scripts.OnEnter(${B})`);
  assert.ok(vm.evaluate('table.concat(TIP, "|")').includes('1 working @1.0,0.8,0.0'));

  vm.run('ClaudeWoWDB.chats[1].unread = 2; ClaudeWoW.Render()');
  assert.equal(signal(), 'reply', 'a reply wins over work');
  assert.equal(pulsing(), 'true');
  vm.run('SlashCmdList.CLAUDE("")');
  assert.equal(pulsing(), 'false', '/claude opens the window and stops it too');
});

test('minimap button: no Minimap frame, no button and no error', () => {
  const vm = newVM('Minimap = nil');
  assert.equal(vm.evaluate(B), null);
  vm.run('SlashCmdList.CLAUDE("config minimap off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.minimap'), 'false');
});
