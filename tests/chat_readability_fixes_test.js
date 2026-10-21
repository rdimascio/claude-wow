'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVM } = require('./lua/vm');
const { NATIVE_TEMPLATES } = require('../dev/render-bench');

const FONTS = 'GameFontBlackMedium = {}; Fancy16Font = {}; QuestFont = {}; QuestTitleFont = {}';

function boot({ native = true } = {}) {
  const vm = createVM();
  if (native) vm.run(NATIVE_TEMPLATES);
  vm.run(FONTS);
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
const history = entries => `local c = ClaudeWoWDB.chats[1]; ClaudeWoW.SwitchChat(c.id); c.history = { ${entries} }; ClaudeWoW.Render()`;

const VALID_UTF8 = `function VALID_UTF8(s)
	local i = 1
	while i <= #s do
		local c = s:byte(i)
		local n = c < 128 and 0 or c >= 240 and 3 or c >= 224 and 2 or c >= 192 and 1 or -1
		if n < 0 then return false end
		for k = 1, n do
			local d = s:byte(i + k)
			if not d or d < 128 or d >= 192 then return false end
		end
		i = i + n + 1
	end
	return true
end`;

test('message line spacing survives the font reset when a bubble is laid out again, and notes and the dark theme get none', () => {
  const vm = boot();
  vm.run(history('{ role = "assistant", t = 2, text = "hello" }'));
  assert.equal(vm.evaluate('ClaudeWoW.UI.bubbles[1].body.font'), 'GameFontBlackMedium');
  assert.equal(vm.num('ClaudeWoW.UI.bubbles[1].body.spacing'), 2, 'spacing is set after the font object');
  vm.run(history('{ role = "system", t = 1, text = "A short note" }'));
  assert.equal(vm.num('ClaudeWoW.UI.bubbles[1].body.spacing'), 0, 'a note keeps its font spacing');
  vm.run(history('{ role = "assistant", t = 3, text = "back to a message" }'));
  assert.equal(vm.num('ClaudeWoW.UI.bubbles[1].body.spacing'), 2, 'a reused bubble gets its spacing back');

  const dark = boot({ native: false });
  dark.run(history('{ role = "assistant", t = 2, text = "hello" }'));
  assert.equal(dark.num('ClaudeWoW.UI.bubbles[1].body.spacing'), 0, 'the dark theme keeps the font spacing');
});

test('the dark theme keeps its old bubble padding; only the parchment box gets the wider one', () => {
  const geometry = vm => {
    vm.run(history('{ role = "assistant", t = 2, text = "hello" }'));
    const b = 'ClaudeWoW.UI.bubbles[1]';
    return {
      whoX: vm.num(`${b}.who.x`),
      whoY: vm.num(`${b}.who.y`),
      whenX: vm.num(`${b}.when.x`),
      inset: vm.num(`${b}.width - ${b}.body.width`),
      height: vm.num(`${b}.height`),
    };
  };
  const dark = geometry(boot({ native: false }));
  assert.deepEqual(dark, { whoX: 10, whoY: -6, whenX: -8, inset: 18, height: 6 + 14 + 4 + 14 + 8 });
  const boxed = geometry(boot());
  assert.deepEqual(boxed, { whoX: 12, whoY: -8, whenX: -12, inset: 24, height: 8 + 14 + 4 + 14 + 10 });
});

test('a long step is cut without splitting a multibyte character in the working bubble and the whisper progress line', () => {
  const vm = boot();
  vm.run(VALID_UTF8);
  const cut = (text, max) => vm.evaluate(`(function(ns) local s = ns.Q.CutText(${text}, ${max}) return tostring(VALID_UTF8(s)) .. "," .. #s end)(NS)`);
  assert.equal(cut('string.rep("a", 89) .. "\\194\\166b"', 90), 'true,92', 'drops the split character, then adds the dots');
  assert.equal(cut('string.rep("a", 88) .. "\\194\\166b"', 90), 'true,93', 'keeps a whole character that fits');
  assert.equal(cut('"short"', 90), 'true,5');

  vm.run('ClaudeWoW.Send("go")');
  const step = 'a'.repeat(89) + '|' + 'b'.repeat(40);
  vm.run(reply(`status = "working", text = "${step}", steps = 1`));
  assert.equal(vm.evaluate(`tostring(VALID_UTF8(${LAST}.body:GetText()))`), 'true', 'the live line is whole characters');
  assert.ok(vm.evaluate(`${LAST}.body:GetText()`).endsWith('a...'));

  const whisper = 'a'.repeat(119) + '|' + 'b'.repeat(40);
  vm.run(reply(`status = "working", text = "${whisper}", steps = 1`));
  vm.run('local c for _, ch in ipairs(ClaudeWoWDB.chats) do if ch.id == ClaudeWoWDB.activeChat then c = ch end end PROGRESS = NS.Whisper.ProgressText(c)');
  const line = vm.evaluate('PROGRESS');
  assert.equal(vm.evaluate('tostring(VALID_UTF8(PROGRESS))'), 'true', 'the whisper line is whole characters');
  assert.ok(line.includes('a...'), line);
});

test('steps that arrive while the mouse already rests on the working message open the step tooltip above it', () => {
  const vm = boot();
  vm.run('ClaudeWoW.Send("go")');
  vm.run(`local b = ${LAST}; STUB.mouseOver = b; b.scripts.OnEnter(b)`);
  assert.equal(vm.evaluate(`GameTooltip.owner == ${LAST}`), 'false', 'no tooltip before the first step');
  vm.run(reply('status = "working", text = "Step 1", steps = 1'));
  assert.equal(vm.evaluate(`GameTooltip.owner == ${LAST}`), 'true', 'the first step opens the tooltip under the resting mouse');
  assert.equal(vm.evaluate('GameTooltip.anchor'), 'ANCHOR_TOP', 'the tooltip opens above, clear of the chat list');
  vm.run(`local b = ${LAST}; STUB.mouseOver = nil; b.scripts.OnLeave(b); GameTooltip.owner = nil`);
  vm.run(reply('status = "working", text = "Step 1\\nStep 2", steps = 2'));
  assert.equal(vm.evaluate('GameTooltip.owner'), null, 'no tooltip once the mouse is gone');
});

test('a click on the working message opens the copy box with every step', () => {
  const vm = boot();
  vm.run('ClaudeWoW.Send("go")');
  vm.run(reply('status = "working", text = "Step 1\\nStep 2\\nStep 3", steps = 3'));
  vm.run(`local b = ${LAST}; b.scripts.OnMouseUp(b, "LeftButton"); STUB.RunTimers()`);
  const copy = vm.evaluate('ClaudeWoWCopyBox and ClaudeWoWCopyBox.text');
  assert.ok(copy, 'the copy box opened');
  for (const s of ['Step 1', 'Step 2', 'Step 3']) assert.ok(copy.includes(s), `${s} is in the copy box: ${copy}`);
  assert.ok(copy.startsWith('Working '), copy);
});
