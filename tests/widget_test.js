'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../bridge/protocol');

const DPS_METER = [
  'local ui = ...',
  'local f = CreateFrame("Frame", nil, ui.frame, "BackdropTemplate")',
  'f:SetSize(160, 40); f:SetPoint("CENTER", 0, -200)',
  'local text = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")',
  'f:RegisterUnitEvent("UNIT_COMBAT", "player")',
  'f:SetScript("OnEvent", function(_, _, unit, action, flag, amount) text:SetText(action .. " " .. amount .. " " .. UnitHealth("player")) end)',
  'local MyCastSpellByNameHelper = "fine"',
  'print("say \\"hi\\" \\\\ ]] done")',
].join('\n');

test('validateWidgetCommand refuses protected calls, secure templates and the addon\'s globals', () => {
  const refused = (source) => {
    const why = [];
    const c = P.validateWidgetCommand({ op: 'set', name: 'bad', source }, why);
    assert.equal(c, null, source);
    assert.match(why.join(' '), /refused, widgets are display-only/);
    return why.join(' ');
  };
  assert.match(refused('CastSpellByName("Fireball")'), /CastSpellByName/);
  assert.match(refused('C_Container.UseContainerItem(0, 1)'), /UseContainerItem/);
  assert.match(refused('local f = _G["SendChatMessage"]'), /SendChatMessage/);
  assert.match(refused('RunMacro("x")'), /RunMacro/);
  assert.match(refused('TargetUnit("target")'), /TargetUnit/);
  assert.match(refused('UseAction(1)'), /UseAction/);
  assert.match(refused('local f = loadstring("return 1")'), /loadstring/);
  assert.match(refused('CreateFrame("Button", nil, nil, "SecureActionButtonTemplate")'), /secure templates/);
  assert.match(refused('ClaudeWoWDB.chats = nil'), /ClaudeWoWDB/);
  assert.match(refused('SlashCmdList.CLAUDEWOW("hello")'), /SlashCmdList/);
  assert.match(refused('f:RegisterEvent("COMBAT_LOG_EVENT_UNFILTERED")'), /COMBAT_LOG_EVENT_UNFILTERED \(an event only the Blizzard UI may register\)/);
  assert.match(refused('local a, b = CombatLogGetCurrentEventInfo()'), /CombatLogGetCurrentEventInfo/);
  assert.match(refused('f:RegisterEvent("MINIMAP_PING")'), /MINIMAP_PING/);
});

test('validateWidgetCommand checks names, size and ops', () => {
  const why = [];
  assert.equal(P.validateWidgetCommand({ op: 'set', name: 'bad name!', source: 'x = 1' }, why), null);
  assert.equal(P.validateWidgetCommand({ op: 'set', name: 'empty', source: '  ' }, why), null);
  assert.equal(P.validateWidgetCommand({ op: 'set', name: 'huge', source: 'x = 1\n'.repeat(P.WIDGET_LIMITS.sourceBytes) }, why), null);
  assert.equal(P.validateWidgetCommand({ op: 'explode', name: 'x' }, why), null);
  assert.ok(why.some(w => /over/.test(w)));
  assert.deepEqual(P.validateWidgetCommand({ op: 'remove', name: 'dps' }), { op: 'remove', name: 'dps' });
  assert.deepEqual(P.validateWidgetCommand({ op: 'clearall' }), { op: 'clearall' });
});

test('applyWidgetCommands bumps the version only on change and keeps the budget', () => {
  const set = P.newWidgetSet('e1');
  let r = P.applyWidgetCommands(set, [{ op: 'set', name: 'dps', source: DPS_METER }]);
  assert.ok(r.changed);
  assert.equal(set.version, 1);
  r = P.applyWidgetCommands(set, [{ op: 'set', name: 'dps', source: DPS_METER }]);
  assert.ok(!r.changed);
  assert.equal(set.version, 1);
  r = P.applyWidgetCommands(set, [{ op: 'set', name: 'dps', source: 'local ui = ...' }, { op: 'set', name: 'evil', source: 'CastSpellByName("x")' }]);
  assert.equal(set.version, 2);
  assert.deepEqual(Object.keys(set.items), ['dps']);
  assert.ok(r.notes.some(n => /evil refused/.test(n)));
  r = P.applyWidgetCommands(set, [{ op: 'remove', name: 'nope' }]);
  assert.ok(!r.changed);
  r = P.applyWidgetCommands(set, [{ op: 'remove', name: 'dps' }]);
  assert.ok(r.changed);
  assert.equal(set.version, 3);
  const many = Array.from({ length: P.WIDGET_LIMITS.widgets + 2 }, (_, i) => ({ op: 'set', name: 'w' + i, source: `local n = ${i}` }));
  P.applyWidgetCommands(set, many.map(c => c), 0);
  assert.equal(Object.keys(set.items).length, P.WIDGET_LIMITS.widgets);
  r = P.applyWidgetCommands(set, [{ op: 'clearall' }]);
  assert.ok(r.changed);
  assert.equal(Object.keys(set.items).length, 0);
});

test('extractWidgetBlocks takes wowui blocks out of the reply', () => {
  const text = 'Here is a meter.\n\n```wowui dps title="DPS meter"\nlocal ui = ...\nui.print("hi")\n```\n\n```wowui old remove\n```\nTL;DR: done';
  const r = P.extractWidgetBlocks(text);
  assert.deepEqual(r.cmds, [
    { op: 'set', name: 'dps', title: 'DPS meter', source: 'local ui = ...\nui.print("hi")\n' },
    { op: 'remove', name: 'old' },
  ]);
  assert.ok(!r.text.includes('wowui'));
  assert.match(r.text, /\[UI widget "dps"\]/);
  assert.ok(r.text.startsWith('Here is a meter.') && r.text.endsWith('TL;DR: done'));
  assert.deepEqual(P.extractWidgetBlocks('no blocks').cmds, []);
});

test('parseWidgetFile reads one command per line', () => {
  const r = P.parseWidgetFile('{"op":"set","name":"a","source":"local ui = ..."}\n\n{"op":"remove","name":"b"}\n{broken\n');
  assert.equal(r.cmds.length, 2);
  assert.equal(r.errors.length, 1);
});

test('the addon blocks the same names the bridge refuses', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addon', 'ClaudeWoW', 'Widgets.lua'), 'utf8');
  const block = src.match(/local DENIED_NAMES = \{([\s\S]*?)\n\}/)[1];
  const luaNames = [...block.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...luaNames].sort(), [...P.WIDGET_DENIED_NAMES].sort());
  const events = src.match(/local RESTRICTED_EVENTS = \{([\s\S]*?)\n\}/)[1];
  const luaEvents = [...events.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual([...luaEvents].sort(), [...P.WIDGET_RESTRICTED_EVENTS].sort());
  const stub = fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8');
  const stubEvents = [...stub.match(/STUB\.RESTRICTED_EVENTS = \{([\s\S]*?)\n\}/)[1].matchAll(/(\w+) = true/g)].map(m => m[1]);
  assert.deepEqual(stubEvents.sort(), [...P.WIDGET_RESTRICTED_EVENTS].sort(), 'the test stub blocks the same events');
});
