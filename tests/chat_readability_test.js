'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVM } = require('./lua/vm');
const { NATIVE_TEMPLATES } = require('../dev/render-bench');

const FONTS = 'GameFontBlackMedium = {}; Fancy16Font = {}; QuestFont = {}; QuestTitleFont = {}';

function boot({ native = true, fonts = true } = {}) {
  const vm = createVM();
  if (native) vm.run(NATIVE_TEMPLATES);
  if (fonts) vm.run(FONTS);
  vm.loadAddon();
  vm.login();
  vm.run('NS = ...', { ns: true });
  vm.run('ClaudeWoW.Toggle(true)');
  vm.run(
    'STUB.RunTimers(); STUB.onLoadAddOn = function() ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} } end; STUB.now = STUB.now + 6; STUB.Tick()',
  );
  return vm;
}

const reply = fields =>
  `STUB.onLoadAddOn = function() local c for _, ch in ipairs(ClaudeWoWDB.chats) do if ch.id == ClaudeWoWDB.activeChat then c = ch end end ClaudeWoW_SlotData = { now = time(), cwd = "", replies = { { chat = c.id, id = c.pendingId, ${fields} } } } end; STUB.now = STUB.now + 6; STUB.Tick()`;

const LAST = '(function() local last for _, b in ipairs(ClaudeWoW.UI.bubbles) do if b.shown then last = b end end return last end)()';
const steps = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `Step ${from + i}`).join('\\n');
const tipLines = vm => vm.evaluate('table.concat(GameTooltip.lines or {}, "\\n")');

test('a running reply shows one live line with the newest step, and every step the bridge sent is behind hover and click', () => {
  const vm = boot();
  vm.run('ClaudeWoW.Send("find the bug")');
  vm.run(reply(`status = "working", text = "${steps(1, 8)}", steps = 8`));
  const body = vm.evaluate(`${LAST}.body:GetText()`);
  assert.ok(body.startsWith('Working '), body);
  assert.equal(body.split('\n').length, 1, 'one line, not a list: ' + JSON.stringify(body));
  assert.ok(body.endsWith(' - Step 8'), 'the newest step: ' + body);
  assert.ok(!body.includes('Step 7'), 'an older step is not inline: ' + body);
  assert.ok(body.includes('8 steps'), 'the step count stays: ' + body);

  vm.run(`local b = ${LAST}; b.scripts.OnEnter(b)`);
  assert.equal(vm.evaluate('GameTooltip.owner') !== null, true);
  assert.equal(vm.evaluate(`GameTooltip.owner == ${LAST}`), 'true', 'the tooltip belongs to the working message');
  const tip = tipLines(vm);
  for (let i = 1; i <= 8; i++) assert.ok(tip.includes(`Step ${i}`), `step ${i} is in the hover list: ${tip}`);
  assert.ok(tip.includes('Click the message to copy them.'), tip);
  const copy = vm.evaluate(`${LAST}.text`);
  assert.ok(copy.includes('Step 1') && copy.includes('Step 8'), 'the copy box text has every step: ' + copy);

  vm.run(reply(`status = "working", text = "${steps(5, 14)}", steps = 14`));
  const live = vm.evaluate(`${LAST}.body:GetText()`);
  assert.ok(live.endsWith(' - Step 14') && !live.includes('Step 13'), 'the newer step replaced the older one: ' + live);
  const refreshed = tipLines(vm);
  assert.ok(refreshed.includes('+4 earlier'), 'the hover list counts the steps the bridge no longer sends: ' + refreshed);
  assert.ok(refreshed.includes('Step 14') && refreshed.includes('Step 5'), 'an open tooltip follows the new steps: ' + refreshed);

  vm.run(reply('status = "done", text = "Found it.", agent = "claude"'));
  assert.equal(vm.evaluate(`${LAST}.steps`), null, 'the reply bubble has no step list');
  assert.equal(vm.evaluate(`${LAST}.tipShown`), null);
  assert.equal(vm.evaluate('GameTooltip.shown'), 'false', 'the step tooltip closes when the reply lands');
  vm.run('GameTooltip.owner = nil');
  vm.run(`local b = ${LAST}; b.scripts.OnEnter(b)`);
  assert.equal(vm.evaluate('GameTooltip.owner'), null, 'hovering a finished reply opens no step tooltip');
});

test('the live line cuts a long step and keeps a pipe from becoming an escape; a run with no step yet shows no tooltip', () => {
  const vm = boot();
  vm.run('ClaudeWoW.Send("go")');
  const before = vm.evaluate(`${LAST}.body:GetText()`);
  assert.ok(before.startsWith('Working '), before);
  assert.ok(!before.includes(' - '), 'no step yet: ' + before);
  vm.run(`local b = ${LAST}; b.scripts.OnEnter(b)`);
  assert.equal(vm.evaluate(`GameTooltip.owner == ${LAST}`), 'false', 'no tooltip without steps');

  const long = 'Run grep -rn ' + 'word '.repeat(60) + '|cffff0000red';
  vm.run(reply(`status = "working", text = "${long}", steps = 1`));
  const body = vm.evaluate(`${LAST}.body:GetText()`);
  const step = body.slice(body.indexOf(' - ') + 3);
  assert.ok(step.length <= 93, 'cut to the limit: ' + step.length);
  assert.ok(step.endsWith('...'), step);
  assert.ok(!body.includes('|c'), 'no raw color escape: ' + body);
});

test('on the parchment a message bubble lies flat on the page with no backdrop edge', () => {
  const vm = boot();
  const seed =
    'local c = ClaudeWoWDB.chats[1]; ClaudeWoW.SwitchChat(c.id); c.history = { { role = "user", t = 1, text = "hi" }, { role = "assistant", t = 2, text = "hello" } }; ClaudeWoW.Render()';
  vm.run(seed);
  assert.notEqual(vm.evaluate('ClaudeWoW.UI.parchment'), null);
  const bubble = i => `ClaudeWoW.UI.bubbles[${i}]`;
  for (const i of [1, 2]) {
    assert.equal(vm.evaluate(`${bubble(i)}.template`), null, `bubble ${i} has no backdrop template`);
    assert.equal(vm.evaluate(`${bubble(i)}.backdrop`), null, `bubble ${i} has no backdrop edge`);
  }
  assert.equal(vm.evaluate(`${bubble(1)}.accent.shown`), 'false', 'no web quote bar');
  assert.equal(vm.num(`${bubble(2)}.bg.color[4]`), 0, 'the reply has no wash');

  const dark = boot({ native: false });
  dark.run(seed);
  assert.equal(dark.evaluate('ClaudeWoW.UI.parchment'), null);
  assert.equal(dark.evaluate(`${bubble(1)}.backdrop`), null, 'the dark theme draws no box');
  assert.equal(dark.evaluate(`${bubble(1)}.accent.shown`), 'true', 'and keeps its accent bar');
});

test('message text uses a 14 pt Blizzard font with line spacing, with fallbacks when the font object is missing', () => {
  const vm = boot();
  vm.run('local c = ClaudeWoWDB.chats[1]; c.history = { { role = "assistant", t = 2, text = "hello" } }; ClaudeWoW.Render()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.bubbles[1].bodyFont'), 'GameFontBlackMedium');
  assert.equal(vm.num('ClaudeWoW.UI.bubbles[1].body.spacing'), 2);
  const plain = boot({ fonts: false });
  plain.run('local c = ClaudeWoWDB.chats[1]; c.history = { { role = "assistant", t = 2, text = "hello" } }; ClaudeWoW.Render()');
  assert.equal(plain.evaluate('ClaudeWoW.UI.bubbles[1].bodyFont'), 'ChatFontNormal', 'falls back when neither Blizzard font exists');
  const quest = boot({ fonts: false });
  quest.run(
    'QuestFont = {}; ClaudeWoW.UI.bubbles = {}; local c = ClaudeWoWDB.chats[1]; c.history = { { role = "assistant", t = 2, text = "hello" } }; ClaudeWoW.Render()',
  );
  assert.equal(quest.evaluate('ClaudeWoW.UI.bubbles[1].bodyFont'), 'QuestFont', 'falls back to the quest font first');
});

test('parchment ink meets 4.5:1 contrast against the parchment fallback color', () => {
  const vm = boot();
  const read = name => JSON.parse(vm.evaluate(`(function(ns) local c = ns.Q.${name} return "[" .. c[1] .. "," .. c[2] .. "," .. c[3] .. "]" end)(NS)`));
  const lin = v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const paper = lum([0.8, 0.7, 0.52]);
  const ratio = c => (paper + 0.05) / (lum(c) + 0.05);
  assert.ok(ratio(read('PARCHMENT_TEXT')) >= 4.5, 'body ink ' + ratio(read('PARCHMENT_TEXT')).toFixed(2));
  assert.ok(ratio(read('PARCHMENT_DIM')) >= 4.5, 'dim ink ' + ratio(read('PARCHMENT_DIM')).toFixed(2));
});
