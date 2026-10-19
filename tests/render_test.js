'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVM } = require('./lua/vm');
const { NATIVE_TEMPLATES } = require('../dev/render-bench');

const RECORDER = `
local mt = getmetatable(UIParent)
local orig = mt.__index
local RECORD = { SetTextColor = "textColor", SetAtlas = "atlas", SetFontObject = "fontObject", SetJustifyH = "justifyH", SetBlendMode = "blend", SetValue = "value" }
mt.__index = function(t, k)
	local field = RECORD[k]
	if field then
		return function(self, ...)
			local parts = {}
			for i = 1, select("#", ...) do
				parts[i] = tostring(select(i, ...))
			end
			self["rec_" .. field] = table.concat(parts, ",")
		end
	end
	return orig(t, k)
end
`;

const DUMP = `
function DUMP(root)
	local ids, order = {}, {}
	local function collect(o)
		if o.shown == false then return end
		order[#order + 1] = o
		ids[o] = #order
		for _, child in ipairs(o.children) do
			collect(child)
		end
	end
	collect(root)
	local function num(v)
		if type(v) == "number" then return string.format("%.3f", v) end
		return tostring(v)
	end
	local function list(t)
		if type(t) ~= "table" then return tostring(t) end
		local parts = {}
		for i, v in ipairs(t) do
			parts[i] = num(v)
		end
		return table.concat(parts, ",")
	end
	local lines = {}
	for i, o in ipairs(order) do
		local rel = o.rel and (ids[o.rel] or ("ext:" .. tostring(o.rel.name or o.rel.kind))) or "-"
		lines[i] = table.concat({
			i,
			o.kind,
			tostring(o.name),
			tostring(o.text),
			num(o.width),
			num(o.height),
			tostring(o.point),
			tostring(o.relPoint),
			tostring(rel),
			num(o.x),
			num(o.y),
			list(o.color),
			tostring(o.texture),
			tostring(o.rec_textColor),
			tostring(o.rec_atlas),
			tostring(o.rec_fontObject),
			tostring(o.rec_justifyH),
			tostring(o.rec_blend),
			tostring(o.rec_value),
			num(o.alpha),
			tostring(o.disabled),
		}, "|")
	end
	return table.concat(lines, "\\n")
end
`;

const COLD = `
local ns = ...
local render = ClaudeWoW.Render
ClaudeWoW.Render = function(...)
	ns.run.renderKey = nil
	return render(...)
end
`;

const COUNT_TEXT = `
local mt = getmetatable(UIParent)
local orig = mt.__index
TEXTS, HEIGHTS = 0, 0
local function under(o, root)
	local seen = 0
	while o and seen < 64 do
		if o == root then return true end
		o = o.parent
		seen = seen + 1
	end
	return false
end
mt.__index = function(t, k)
	local v = orig(t, k)
	if k == "SetText" then
		return function(self, ...)
			if under(self, ClaudeWoWContent) then TEXTS = TEXTS + 1 end
			return v(self, ...)
		end
	elseif k == "GetStringHeight" then
		return function(self, ...)
			if under(self, ClaudeWoWContent) then HEIGHTS = HEIGHTS + 1 end
			return v(self, ...)
		end
	end
	return v
end
`;

function boot({ native, cold }) {
  const vm = createVM();
  vm.run(RECORDER);
  if (native) vm.run(NATIVE_TEMPLATES);
  vm.run(DUMP);
  vm.loadAddon();
  vm.login();
  if (cold) vm.run(COLD, { ns: true });
  return vm;
}

const reply = (fields, k = 'ClaudeWoWDB.activeChat') =>
  `STUB.onLoadAddOn = function() local c for _, ch in ipairs(ClaudeWoWDB.chats) do if ch.id == ${k} then c = ch end end ClaudeWoW_SlotData = { now = time(), cwd = "", replies = { { chat = c.id, id = c.pendingId, ${fields} } } } end; STUB.now = STUB.now + 6; STUB.Tick()`;

const MARKDOWN = 'Here is the plan.\\n\\n- **first** point\\n- second point with `code`\\n\\n```lua\\nlocal x = 1\\n```\\n\\nTL;DR: do the thing.';

const STEPS = [
  ['open the window', 'ClaudeWoW.Toggle(true)'],
  [
    'hello slot',
    'STUB.RunTimers(); STUB.onLoadAddOn = function() ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} } end; STUB.now = STUB.now + 6; STUB.Tick()',
  ],
  ['render with nothing changed', 'ClaudeWoW.Render()'],
  ['two more chats', 'ClaudeWoW.NewChat("Second"); ClaudeWoW.NewChat("Third")'],
  ['back to the first chat', 'ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id)'],
  ['send', 'ClaudeWoW.Send("first question with **bold** and a list")'],
  ['progress', reply('status = "working", text = "Reading files\\nEditing Transcript.lua", steps = 2')],
  ['time passes while pending', 'STUB.now = STUB.now + 7; STUB.Tick(); ClaudeWoW.Render()'],
  ['reply', reply(`status = "done", text = "${MARKDOWN}", agent = "claude", summary = "do the thing."`)],
  ['send again', 'ClaudeWoW.Send("second question")'],
  ['reply without an agent', reply('status = "done", text = "Short answer.\\nSecond line."')],
  ['the chat moves to codex', 'ClaudeWoWDB.chats[1].agent = "codex"; ClaudeWoW.Render()'],
  ['a system note', 'ClaudeWoW.SystemNote("A short note")'],
  ['an event note', 'local ns = ...; ns.Q.AddEvent(ns.ActiveChat(), "Joined the room"); ClaudeWoW.Render()'],
  ['a long system message', 'ClaudeWoW.SystemNote(string.rep("A long system message that is a card, not a note. ", 4))'],
  ['a denial with macros', 'ClaudeWoWDB.settings.lootRoll = false; ClaudeWoW.Send("delete the build folder")'],
  [
    'the denied reply',
    reply(
      'status = "done", text = "I need to run rm.", denied = { "Bash(rm:*)" }, macros = { { name = "Burst", body = "#showtooltip\\n/cast Arcane Power" } }, agent = "claude"',
    ),
  ],
  ['render the denial again', 'ClaudeWoW.Render()'],
  [
    'a picker and a context warning',
    'local ns = ...; local c = ns.ActiveChat(); table.insert(c.history, { role = "system", text = "pick", head = "Pick a session", picker = { { text = "row one" }, { text = "row two" } }, t = time() }); table.insert(c.history, { role = "system", text = "This chat is getting long.", newChat = true, t = time() }); ClaudeWoW.Render()',
  ],
  ['the picker rows change', 'local ns = ...; local c = ns.ActiveChat(); c.history[#c.history - 1].picker[2].text = "row two, renamed"; ClaudeWoW.Render()'],
  ['continue past the denial', 'ClaudeWoW.Send("skip that step")'],
  ['its reply', reply('status = "done", text = "Skipped.", agent = "claude"')],
  ['a narrower window', 'ClaudeWoWScroll:SetWidth(320); ClaudeWoW.Render()'],
  ['back to the default width', 'ClaudeWoWScroll.width = nil; ClaudeWoW.Render()'],
  ['switch away and back', 'ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[2].id); ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id)'],
  ['an empty chat', 'ClaudeWoW.NewChat("Empty")'],
  ['back again', 'ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id)'],
  ['a message edited in place', 'ClaudeWoWDB.chats[1].history[1].text = "first question, edited"; ClaudeWoW.Render()'],
  [
    'the history fills up',
    'local ns = ...; local c = ns.ActiveChat(); for i = 1, 205 do ns.AddHistory(c, i % 2 == 0 and "user" or "assistant", "bulk message " .. i .. string.rep(" more", i % 7)) end; ClaudeWoW.Render()',
  ],
  ['one more trims the oldest', 'local ns = ...; ns.AddHistory(ns.ActiveChat(), "user", "one more"); ClaudeWoW.Render()'],
  ['clear', 'SlashCmdList.CLAUDE("clear"); ClaudeWoW.Render()'],
  ['delete the chat', 'ClaudeWoW.DeleteChat()'],
];

function firstDiff(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}\n  incremental: ${la[i]}\n  full:        ${lb[i]}`;
  }
  return 'no difference';
}

function sameTree(warm, cold, root, what) {
  const a = warm.evaluate(`DUMP(${root})`);
  const b = cold.evaluate(`DUMP(${root})`);
  assert.ok(a.length > 0, `${what}: an empty ${root} dump`);
  assert.equal(a === b, true, `${what}: ${root} differs at ${firstDiff(a, b)}`);
}

for (const native of [true, false]) {
  const mode = native ? 'the quest-log list on parchment' : 'the legacy list';
  test(`render identity (${mode}): after every step the incremental transcript and chat list match a cold render of the same state`, () => {
    const warm = boot({ native, cold: false });
    const cold = boot({ native, cold: true });
    const list = native ? 'ClaudeWoWChatListContent' : 'ClaudeWoW.UI.listPanel';
    for (const [what, lua] of STEPS) {
      warm.run(lua, { ns: true });
      cold.run(lua, { ns: true });
      sameTree(warm, cold, 'ClaudeWoWContent', what);
      sameTree(warm, cold, list, what);
    }
    assert.ok(warm.num('#ClaudeWoW.UI.bubbles') >= 200, 'the sequence reached the history cap');
  });
}

test('a render with nothing changed sets no bubble text and reads no height', () => {
  const vm = boot({ native: true, cold: false });
  vm.run('ClaudeWoW.Toggle(true)');
  vm.run(STEPS[1][1], { ns: true });
  vm.run('ClaudeWoW.Send("hello"); ' + reply('status = "done", text = "hi there\\nsecond line", agent = "claude"'), { ns: true });
  vm.run('ClaudeWoW.SystemNote("noted")');
  vm.run(COUNT_TEXT);
  vm.run('ClaudeWoW.Render()');
  assert.equal(vm.num('TEXTS'), 0, 'no SetText under the transcript');
  assert.equal(vm.num('HEIGHTS'), 0, 'no GetStringHeight under the transcript');
  vm.run('ClaudeWoW.SystemNote("one more")');
  assert.ok(vm.num('TEXTS') > 0 && vm.num('TEXTS') <= 2, 'only the new note is laid out: ' + vm.num('TEXTS'));
});
