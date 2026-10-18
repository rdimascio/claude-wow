local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Core\\State.lua"

local ClaudeWoW = {}
ns.ClaudeWoW = ClaudeWoW
_G.ClaudeWoW = ClaudeWoW

local ToHex = ns.ToHex

local DEFAULT_CWD = "" -- empty = the bridge's configured defaultCwd
local MAX_HISTORY = 200
ns.DEFAULT_CWD = DEFAULT_CWD
local LIVE_PLUGIN = "live"
local LIVE_PASS_TEXT = "Denied."
ns.LIVE_PLUGIN, ns.LIVE_PASS_TEXT = LIVE_PLUGIN, LIVE_PASS_TEXT

-- The footer segment's glyphs (Claude Code's own: "11m 58s · ↓ 186.7k tokens").
-- One place to change if the client's font lacks one of them.
local SEG = { DOT = "·", DOWN = "↓", APPROX = "≈" }
ns.SEG = SEG

local db
local ui = {}
ns.ui = ui
-- Transport state for this UI session. outbound[id] = { chat, cwd, flags, text, sentAt, acked }
local run = { outbound = {} }
ns.run = run
-- Whisper tabs (the section after the game context). Declared up here because
-- Send, ApplyReplies and Finish use it and come first in the file.
local Whisper = {}
local Cli = { DIM_DEFAULT = 0.35, Links = {}, CONTEXT_WARN_DEFAULT = 300000, CONTEXT_WARN_OLD = 100000 }
ns.Whisper = Whisper
ns.Cli = Cli

local Q = {}
Q.CHAT_PAGE = 16
ns.Q = Q

local function HasUserMessage(c)
	for _, m in ipairs(c.history or {}) do
		if m.role == "user" and not tostring(m.text or ""):find("^@dev ") then return true end
	end
	return false
end
ns.HasUserMessage = HasUserMessage

local function NewId() return string.format("%x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF)) end

local function FindChat(id)
	for i, c in ipairs(db.chats) do
		if c.id == id then return c, i end
	end
end

local function ActiveChat() return FindChat(db.activeChat) end

local function AddChat(name, cwd)
	local current = ActiveChat()
	if current and current.quiet then current = nil end
	local c = {
		id = NewId(),
		name = name or ("Chat " .. (#db.chats + 1)),
		cwd = cwd or DEFAULT_CWD,
		agent = (current and current.agent) or "",
		plugin = "",
		history = {},
		unread = 0,
		created = time(),
	}
	table.insert(db.chats, c)
	return c
end
ns.NewId, ns.FindChat, ns.ActiveChat, ns.AddChat = NewId, FindChat, ActiveChat, AddChat

function Q.IsCharacterChat(c) return not c.quiet and (c.cwd or "") == "" and Cli.ChatPlugin(c) ~= "claude-code" end

function Q.LoadCharacterChats(data, own)
	own = type(own) == "table" and own or {}
	local seen = {}
	for _, c in ipairs(data.chats) do
		seen[c.id] = true
	end
	for _, c in ipairs(type(own.chats) == "table" and own.chats or {}) do
		if type(c) == "table" and c.id and not seen[c.id] then
			table.insert(data.chats, c)
			seen[c.id] = true
		end
	end
	if own.activeChat and seen[own.activeChat] then data.activeChat = own.activeChat end
	return { chats = {}, restored = own.restored }
end

function Q.StashCharacterChats(data, own)
	local shared, mine = {}, {}
	for _, c in ipairs(data.chats) do
		table.insert(Q.IsCharacterChat(c) and mine or shared, c)
	end
	data.chats = shared
	return { chats = mine, activeChat = data.activeChat, restored = type(own) == "table" and own.restored or nil }
end

function Q.CharacterKey() return ClaudeWoWOrders and ClaudeWoWOrders.CharacterKey() or nil end

function Q.CharacterFlag()
	local key = Q.CharacterKey()
	return key and ("char=" .. ToHex(key)) or nil
end

function Q.ResetChats(data)
	data.chats = {}
	data.activeChat, data.history, data.pendingId, data.unread, data.draft, data.restored = nil, nil, nil, nil, nil, nil
end

function Q.ListedChats()
	local listed = {}
	for _, c in ipairs(db.chats) do
		if not c.quiet then table.insert(listed, c) end
	end
	return listed
end

local function AnyPending()
	for _, c in ipairs(db.chats) do
		if c.pendingId then return true end
	end
	return false
end
ns.AnyPending = AnyPending

function ClaudeWoW.RepairQuietChats(data)
	local quietPlugins = {}
	local active, firstUserChat
	for _, c in ipairs(data.chats) do
		if c.quiet and c.plugin ~= "" then quietPlugins[c.plugin] = true end
		if c.id == data.activeChat then active = c end
		if not c.quiet and not firstUserChat then firstUserChat = c end
	end
	for _, c in ipairs(data.chats) do
		if not c.quiet and quietPlugins[c.plugin] then c.plugin = "" end
	end
	if active and active.quiet and firstUserChat then data.activeChat = firstUserChat.id end
end

local function InitDB()
	-- Nothing saved yet: a first run, as opposed to an install from before some setting existed.
	local fresh = ClaudeWoWDB == nil or next(ClaudeWoWDB) == nil
	ClaudeWoWDB = ClaudeWoWDB or {}
	db = ClaudeWoWDB
	ns.db = db
	db.settings = db.settings or {}
	local s = db.settings
	if s.autoRefresh == nil then s.autoRefresh = true end
	if not s.autoRefreshV2 then
		s.autoRefreshV2 = true
		if s.mode ~= "reload" then s.autoRefresh = false end
	end
	if s.signal == nil then s.signal = true end
	if s.minimap == nil then s.minimap = true end
	Q.MigrateMiniBar(s)
	if s.context == nil then s.context = true end -- tell the agent about the character, zone, etc.
	if not s.contextWarnV2 then
		s.contextWarnV2 = true
		if s.contextWarn == nil or s.contextWarn == Cli.CONTEXT_WARN_OLD then s.contextWarn = Cli.CONTEXT_WARN_DEFAULT end
	end
	-- How much of each reply to print in the game chat. "summary" (the agent's
	-- closing TL;DR lines) replaced "full" as the default; an install that still
	-- has the old default saved moves over once, any other choice is kept.
	if not s.echoV2 then
		s.echoV2 = true
		if s.echo == "full" then s.echo = "summary" end
	end
	s.echo = s.echo or "summary"
	s.mode = s.mode or "pixel"
	if s.vision == nil then s.vision = false end -- send a picture of the screen with each message (screenshot transport); opt-in
	s.interval = s.interval or 20
	s.cwd = s.cwd or DEFAULT_CWD
	s.width = s.width or 780
	s.height = s.height or 500
	db.lastSeq = db.lastSeq or 0
	-- Chats deleted in game that the bridge hasn't confirmed forgetting yet.
	db.forget = db.forget or {}
	-- Identifies this counter's lifetime. If the saved data is ever reset, a new
	-- session lets the bridge tell "message #1 again" from "message #1, already done".
	if not db.session then db.session = string.format("%x%04x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF), math.random(0, 0xFFFF)) end
	if not s.chatsPerCharacterV1 then
		s.chatsPerCharacterV1 = true
		Q.ResetChats(db)
	end
	if not db.chats then
		-- Migrate the single-chat layout into the first chat.
		db.chats = {}
		local c = {
			id = NewId(),
			name = "Chat 1",
			cwd = s.cwd,
			history = db.history or {},
			pendingId = db.pendingId,
			unread = db.unread or 0,
			draft = db.draft,
			created = time(),
		}
		table.insert(db.chats, c)
		db.activeChat = c.id
		db.history, db.pendingId, db.unread, db.draft = nil, nil, nil, nil
	end
	ClaudeWoWCharDB = Q.LoadCharacterChats(db, ClaudeWoWCharDB)
	if #db.chats == 0 then AddChat() end
	if not FindChat(db.activeChat) then db.activeChat = db.chats[1].id end
	-- Chats from before agents had names: replies were stored with role "claude".
	for _, c in ipairs(db.chats) do
		c.agent = c.agent or ""
		for _, m in ipairs(c.history or {}) do
			if m.role == "claude" then
				m.role, m.agent = "assistant", m.agent or "claude"
			end
		end
	end
	-- Chats from before plugins existed were all coding chats and stay bound to
	-- that plugin; chats made since follow the bridge's default ("" = its
	-- default, "ask" unless its config says otherwise), like a fresh install.
	if not s.pluginsV1 then
		s.pluginsV1 = true
		if not fresh then
			for _, c in ipairs(db.chats) do
				if not c.plugin or c.plugin == "" then c.plugin = "claude-code" end
			end
		end
	end
	for _, c in ipairs(db.chats) do
		c.plugin = c.plugin or ""
	end
	ClaudeWoW.RepairQuietChats(db)
	if FindChat(db.activeChat).quiet then db.activeChat = AddChat().id end
	ClaudeWoW.MigrateWhisper(s, fresh)
	if s.dim == nil then s.dim = Cli.DIM_DEFAULT end
	if s.dodge == nil then s.dodge = true end
	if s.autohide == nil then s.autohide = true end
end
ns.InitDB = InitDB

function ClaudeWoW.MigrateWhisper(s, fresh)
	s.whisperNews = nil
	if not s.whisperV3 then
		s.whisperV3 = true
		if not s.whisperChoice and not fresh and not s.whisperV2 and s.whisper == true then s.whisperChoice = "on" end
	end
	s.whisper = s.whisperChoice == "on"
end

function Q.MigrateMiniBar(s)
	if s.miniBarV2 then return end
	s.miniBarV2 = true
	if s.minimized then s.shown = false end
	s.minimized = nil
	s.miniPoint, s.miniRelPoint, s.miniX, s.miniY = nil, nil, nil, nil
end

local function AddHistory(chat, role, text, id, denied, agent, macros, summary)
	local kept = type(summary) == "string" and summary ~= "" and #summary <= Q.SUMMARY_STRIP_CHARS and summary or nil
	table.insert(chat.history, { role = role, text = text, id = id, t = time(), denied = denied, agent = agent, macros = macros, summary = kept })
	while #chat.history > MAX_HISTORY do
		table.remove(chat.history, 1)
	end
end
ns.AddHistory = AddHistory
