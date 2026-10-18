'use strict';
const { createVM } = require('./vm');

const FLAGS = 'autoRefreshV2 = true, whisperV3 = true, echoV2 = true, chatsPerCharacterV1 = true, pluginsV1 = true, miniBarV2 = true, contextWarnV2 = true';
const CHAT_FLAGS = 'chatsPerCharacterV1 = true, pluginsV1 = true';
const chat = (id, extra = '') => `{ id = "${id}", name = "Chat ${id}", cwd = "", history = {}, unread = 0, created = 50${extra ? ', ' + extra : ''} }`;

const SHAPES = {
  nil: { saved: null },
  empty: { saved: '{}' },
  'settings-empty': { saved: '{ settings = {} }' },
  'autoRefresh-pre-v2-pixel': { saved: '{ settings = { autoRefresh = true } }' },
  'autoRefresh-pre-v2-reload': { saved: '{ settings = { autoRefresh = true, mode = "reload" } }' },
  'autoRefresh-v2-on': { saved: '{ settings = { autoRefreshV2 = true, autoRefresh = true } }' },
  'autoRefresh-v2-off': { saved: '{ settings = { autoRefreshV2 = true, autoRefresh = false } }' },
  'whisper-pre-v2-on': { saved: '{ settings = { whisper = true } }' },
  'whisper-pre-v2-off': { saved: '{ settings = { whisper = false } }' },
  'whisper-v2-auto': { saved: '{ settings = { whisperV2 = true, whisper = true } }' },
  'whisper-v2-news': { saved: '{ settings = { whisperV2 = true, whisper = true, whisperNews = true } }' },
  'whisper-v2-choice-on': { saved: '{ settings = { whisperV2 = true, whisper = false, whisperChoice = "on" } }' },
  'whisper-v2-choice-off': { saved: '{ settings = { whisperV2 = true, whisper = true, whisperChoice = "off" } }' },
  'whisper-v3-stale-on': { saved: '{ settings = { whisperV3 = true, whisper = true } }' },
  'whisper-v3-choice-on': { saved: '{ settings = { whisperV3 = true, whisperChoice = "on" } }' },
  'echo-full-pre-v2': { saved: '{ settings = { echo = "full" } }' },
  'echo-full-v2': { saved: '{ settings = { echoV2 = true, echo = "full" } }' },
  'echo-short-pre-v2': { saved: '{ settings = { echo = "short" } }' },
  'echo-unset-v2': { saved: '{ settings = { echoV2 = true } }' },
  'minibar-minimized': { saved: '{ settings = { minimized = true, shown = true, miniPoint = "TOPLEFT", miniRelPoint = "TOPLEFT", miniX = 10, miniY = -20 } }' },
  'minibar-not-minimized': { saved: '{ settings = { minimized = false, shown = true, miniX = 10 } }' },
  'minibar-v2-minimized': { saved: '{ settings = { miniBarV2 = true, minimized = true, shown = true, miniX = 10 } }' },
  'contextWarn-pre-v2-unset': { saved: '{ settings = { context = true } }' },
  'contextWarn-pre-v2-old': { saved: '{ settings = { contextWarn = 100000 } }' },
  'contextWarn-pre-v2-custom': { saved: '{ settings = { contextWarn = 50000 } }' },
  'contextWarn-v2-old': { saved: '{ settings = { contextWarnV2 = true, contextWarn = 100000 } }' },
  'contextWarn-v2-unset': { saved: '{ settings = { contextWarnV2 = true } }' },
  'loginNotice-seen': { saved: '{ settings = { loginNoticeV1 = true } }' },
  'loginNotice-false': { saved: '{ settings = { loginNoticeV1 = false } }' },
  'single-chat-layout': {
    saved:
      '{ settings = { chatsPerCharacterV1 = true, cwd = "/work" }, history = { { role = "user", text = "hi", t = 100 }, { role = "claude", text = "hello", t = 101 } }, pendingId = 7, unread = 2, draft = "typing", lastSeq = 7 }',
  },
  'single-chat-layout-pre-per-character': {
    saved: '{ history = { { role = "user", text = "hi", t = 100 } }, pendingId = 7, unread = 2, draft = "typing", lastSeq = 7 }',
  },
  'chats-pre-per-character': { saved: `{ settings = { pluginsV1 = true }, chats = { ${chat('a1')} }, activeChat = "a1" }` },
  'chats-role-claude': {
    saved: `{ settings = { ${CHAT_FLAGS} }, chats = { ${chat('a1', 'plugin = "", history = { { role = "claude", text = "old", t = 100 }, { role = "claude", text = "named", agent = "codex", t = 101 }, { role = "assistant", text = "new", agent = "claude", t = 102 } }')} }, activeChat = "a1" }`,
  },
  'plugins-pre-v1-chats': {
    saved: `{ settings = { chatsPerCharacterV1 = true }, chats = { ${chat('a1', 'cwd = "/work"')}, ${chat('a2', 'plugin = ""')}, ${chat('a3', 'plugin = "live"')} }, activeChat = "a2" }`,
  },
  'plugins-v1-chat-without-plugin': { saved: `{ settings = { ${CHAT_FLAGS} }, chats = { ${chat('a1', 'cwd = "/work"')} }, activeChat = "a1" }` },
  'plugins-pre-v1-no-chats': { saved: '{ settings = { chatsPerCharacterV1 = true } }' },
  'quiet-active-chat': {
    saved: `{ settings = { ${CHAT_FLAGS} }, chats = { ${chat('q1', 'plugin = "stream", quiet = true')}, ${chat('u1', 'plugin = "stream"')} }, activeChat = "q1" }`,
  },
  'only-quiet-chat': { saved: `{ settings = { ${CHAT_FLAGS} }, chats = { ${chat('q1', 'plugin = "stream", quiet = true')} }, activeChat = "q1" }` },
  'dangling-active-chat': {
    saved: `{ settings = { ${CHAT_FLAGS} }, chats = { ${chat('a1', 'plugin = ""')}, ${chat('a2', 'plugin = ""')} }, activeChat = "zz" }`,
  },
  'empty-chat-list': { saved: `{ settings = { ${CHAT_FLAGS} }, chats = {} }` },
  'session-and-forget-kept': {
    saved: `{ settings = { ${FLAGS} }, chats = { ${chat('a1', 'plugin = ""')} }, activeChat = "a1", session = "sess1", lastSeq = 42, forget = { "d1", "d2" } }`,
  },
  'missing-session-and-forget': { saved: `{ settings = { ${FLAGS} }, chats = { ${chat('a1', 'plugin = ""')} }, activeChat = "a1", lastSeq = 3 }` },
  'character-chats-restored': {
    saved: `{ settings = { ${FLAGS} }, chats = { ${chat('a1', 'plugin = ""')} }, activeChat = "a1", session = "sess1" }`,
    own: `{ chats = { ${chat('c1', 'plugin = ""')} }, activeChat = "c1", restored = true }`,
  },
  'character-chats-not-restored': {
    saved: `{ settings = { ${FLAGS} }, chats = { ${chat('a1', 'plugin = ""')} }, activeChat = "a1", session = "sess1" }`,
    own: `{ chats = { ${chat('c1', 'plugin = ""')} }, activeChat = "c1" }`,
  },
  'character-chats-pre-plugins': {
    saved: `{ settings = { chatsPerCharacterV1 = true }, chats = { ${chat('a1')} }, activeChat = "a1", session = "sess1" }`,
    own: `{ chats = { ${chat('c1')}, ${chat('c2', 'plugin = "live"')} }, activeChat = "c2" }`,
  },
  'character-chats-duplicate-id': {
    saved: `{ settings = { ${FLAGS} }, chats = { ${chat('a1', 'plugin = ""')} }, activeChat = "a1", session = "sess1" }`,
    own: `{ chats = { ${chat('a1', 'plugin = "", name = "Dupe"')} }, activeChat = "a1", restored = false }`,
  },
  'character-chats-empty': {
    saved: `{ settings = { ${FLAGS} }, chats = {}, session = "sess1" }`,
    own: '{ chats = {}, restored = true }',
  },
  'window-and-toggles': {
    saved: `{ settings = { ${FLAGS}, dim = 0.5, dodge = false, autohide = false, signal = false, minimap = false, context = false, vision = true, toasts = false, ordersCard = false, ordersCollapsed = true, telemetry = false, interval = 5, width = 900, height = 600, cwd = "/x", mode = "reload", echo = "off", shown = true, longchat = true, minimapAngle = 90, autoRefresh = true, contextWarn = 200000, whisperChoice = "on", loginNoticeV1 = true } }`,
  },
  'modern-complete': {
    saved: `{ settings = { ${FLAGS}, autoRefresh = false, signal = true, minimap = true, context = true, contextWarn = 300000, echo = "summary", mode = "pixel", vision = false, interval = 20, cwd = "", width = 780, height = 500, whisper = false, dim = 0.35, dodge = true, autohide = true, loginNoticeV1 = true }, chats = { ${chat('a1', 'plugin = "", agent = ""')} }, activeChat = "a1", session = "sess1", lastSeq = 9, forget = {} }`,
    own: '{ chats = {}, restored = true }',
  },
  'modules-outside-settings': {
    saved: `{ settings = { ${FLAGS} }, chats = { ${chat('a1', 'plugin = ""')} }, activeChat = "a1", session = "sess1", roast = { on = true, lastAt = 5, chat = "r1" }, stream = { follow = false, chat = "s1", stale = 1 }, voice = { pack = "peon", lines = {} }, telemetry = { seq = 3, chars = {} }, layouts = { ["Bone-Realm"] = { w = 700, h = 450 } }, achievements = { earned = {}, points = 1, total = 2 } }`,
  },
};

const DETERMINISTIC_RANDOM = `
local n = 0
math.random = function(a, b)
	n = n + 1
	if a == nil then return (n % 1000) / 1000 end
	if b == nil then a, b = 1, a end
	return a + (n % (b - a + 1))
end
`;

const DUMP_LUA = `
local function Str(s)
	s = s:gsub('[%c"\\\\]', function(ch)
		if ch == '"' then return '\\\\"' end
		if ch == "\\\\" then return "\\\\\\\\" end
		if ch == "\\n" then return "\\\\n" end
		if ch == "\\t" then return "\\\\t" end
		if ch == "\\r" then return "\\\\r" end
		return string.format("\\\\u%04x", ch:byte())
	end)
	return '"' .. s .. '"'
end

local function Keys(t)
	local ks = {}
	for k in pairs(t) do ks[#ks + 1] = tostring(k) end
	table.sort(ks)
	return ks
end

local function IsList(t)
	local n = 0
	for _ in pairs(t) do n = n + 1 end
	return n == #t
end

local function Enc(v)
	local t = type(v)
	if t == "string" then return Str(v) end
	if t == "number" or t == "boolean" then return tostring(v) end
	if t == "nil" then return "null" end
	if t ~= "table" then return Str("<" .. t .. ">") end
	if IsList(v) then
		local parts = {}
		for i = 1, #v do parts[i] = Enc(v[i]) end
		return "[" .. table.concat(parts, ",") .. "]"
	end
	local byName = {}
	for k, x in pairs(v) do byName[tostring(k)] = x end
	local parts = {}
	for _, k in ipairs(Keys(byName)) do parts[#parts + 1] = Str(k) .. ":" .. Enc(byName[k]) end
	return "{" .. table.concat(parts, ",") .. "}"
end

STATE_DUMP = Enc({ account = ClaudeWoWDB, character = ClaudeWoWCharDB })
`;

function loadShape(shape) {
  const vm = createVM();
  vm.run(DETERMINISTIC_RANDOM);
  vm.loadAddon();
  vm.run(`ClaudeWoWDB = ${shape.saved === null ? 'nil' : shape.saved}; ClaudeWoWCharDB = ${shape.own || 'nil'}`);
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  return vm;
}

function dumpState(vm) {
  vm.run(DUMP_LUA);
  return JSON.parse(vm.evaluate('STATE_DUMP'));
}

function migrateAgain(vm) {
  vm.run('local ns = ...; ns.InitDB()', { ns: true });
}

function migrateShape(shape) {
  const vm = loadShape(shape);
  const after = dumpState(vm);
  migrateAgain(vm);
  return { after, again: dumpState(vm) };
}

module.exports = { SHAPES, loadShape, dumpState, migrateAgain, migrateShape };
