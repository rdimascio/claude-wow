#!/usr/bin/env node
'use strict';
const { createVM } = require('../tests/lua/vm');

const CHATS = 5;
const ROUNDS = 10;
const TICKS = 60;
const SWITCHES = 10;
const REPLY_LINES = ['Here is what I found.', '', '- the first point', '- the second point, a little longer than the first one', '', 'TL;DR: done.'];

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
end
`;

const COUNTERS = `
local mt = getmetatable(ClaudeWoWContent)
local orig = mt.__index
BENCH = { render = 0, bubbleText = 0, listText = 0, stringHeight = 0, fills = 0 }
local transcript, list = ClaudeWoWContent, ClaudeWoWChatListContent
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
			if under(self, transcript) then
				BENCH.bubbleText = BENCH.bubbleText + 1
			elseif under(self, list) then
				BENCH.listText = BENCH.listText + 1
			end
			return v(self, ...)
		end
	elseif k == "GetStringHeight" then
		return function(self, ...)
			BENCH.stringHeight = BENCH.stringHeight + 1
			return v(self, ...)
		end
	end
	return v
end
local ns = ...
local render = ClaudeWoW.Render
ClaudeWoW.Render = function(...)
	BENCH.render = BENCH.render + 1
	return render(...)
end
local fill = ns.Q.FillRow
ns.Q.FillRow = function(...)
	BENCH.fills = BENCH.fills + 1
	return fill(...)
end
`;

const slot = (vm, body) => vm.run(`STUB.onLoadAddOn = function() ClaudeWoW_SlotData = ${body} end`);
const tick = (vm, seconds = 2) => vm.run(`STUB.now = STUB.now + ${seconds}; STUB.Tick()`);
const luaString = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';

function boot({ native = true } = {}) {
  const vm = createVM();
  if (native) vm.run(NATIVE_TEMPLATES);
  vm.loadAddon();
  vm.login();
  return vm;
}

function script(vm) {
  vm.run('ClaudeWoW.Toggle(true)');
  vm.run('STUB.RunTimers()');
  slot(vm, '{ now = time(), cwd = "", replies = {} }');
  tick(vm, 6);
  if (vm.evaluate('ClaudeWoW.IsConnected()') !== 'true') throw new Error('not connected after the hello slot');
  for (let i = 2; i <= CHATS; i++) vm.run(`ClaudeWoW.NewChat("Chat ${i}")`);
  const chatId = vm.evaluate('ClaudeWoWDB.activeChat');
  for (let i = 1; i <= ROUNDS; i++) {
    vm.run(`ClaudeWoW.Send(${luaString('message ' + i + ': please look at the ' + 'thing '.repeat(i))})`);
    const id = vm.num('(ClaudeWoW.ActiveChat and ClaudeWoW.ActiveChat() or ClaudeWoWDB.chats[#ClaudeWoWDB.chats]).pendingId');
    if (!(id >= 1)) throw new Error('message ' + i + ' did not go out');
    const text = luaString(REPLY_LINES.join('\n').replace('done', 'done ' + i));
    slot(
      vm,
      `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = ${text}, agent = "claude", summary = "done ${i}." } } }`,
    );
    tick(vm, 6);
    if (vm.evaluate(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${chatId}" then return tostring(c.pendingId) end end end)()`) !== 'nil') {
      throw new Error('reply ' + i + ' was not applied');
    }
  }
  slot(vm, '{ now = time(), cwd = "", replies = {} }');
  for (let i = 0; i < TICKS; i++) tick(vm);
  for (let i = 0; i < SWITCHES; i++) vm.run(`ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[${(i % CHATS) + 1}].id)`);
  return chatId;
}

function counted() {
  const vm = boot();
  vm.run(COUNTERS, { ns: true });
  const chatId = script(vm);
  const history = vm.num(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${chatId}" then return #c.history end end end)()`);
  const read = k => vm.num('BENCH.' + k);
  return {
    history,
    render: read('render'),
    bubbleText: read('bubbleText'),
    listText: read('listText'),
    stringHeight: read('stringHeight'),
    fills: read('fills'),
  };
}

function timed(runs) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const vm = boot();
    const start = process.hrtime.bigint();
    script(vm);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function main() {
  const runs = Number(process.argv[2]) || 5;
  const counts = counted();
  const ms = timed(runs);
  const rows = [
    ['`Render` calls', counts.render],
    ['bubble `SetText` calls (under `ClaudeWoWContent`)', counts.bubbleText],
    ['chat-list `SetText` calls (under `ClaudeWoWChatListContent`)', counts.listText],
    ['`GetStringHeight` calls', counts.stringHeight],
    ['chat-list row fills (`Q.FillRow`)', counts.fills],
    [`wall time, median of ${runs} runs`, ms.toFixed(0) + ' ms'],
  ];
  console.log(
    `Script: connect, ${CHATS} chats, ${ROUNDS} messages and ${ROUNDS} slot replies in one chat (${counts.history} history entries), ${TICKS} ticks with the window open, ${SWITCHES} chat switches.`,
  );
  console.log('');
  console.log('| Measure | Value |');
  console.log('|---|---|');
  for (const [name, value] of rows) console.log(`| ${name} | ${value} |`);
}

if (require.main === module) main();

module.exports = { counted, timed, script, boot, NATIVE_TEMPLATES, CHATS, ROUNDS, TICKS, SWITCHES };
