-- ClaudeWoW: talk to local coding agents (Claude Code, Codex, Grok) from inside WoW,
-- without reloading.
--
-- The WoW sandbox has no network and no file reads at runtime. Two doors remain open:
--
--   OUT ("pixel" mode): pending messages are drawn as a strip of colored squares in
--        the top-left corner of the screen until the bridge acknowledges them.
--        bridge.js screen-captures that corner and decodes it. Nothing touches the game.
--        When the bridge says it listens on the "screenshot" transport instead, the
--        strip is only up for the two frames around a Screenshot() call and the
--        bridge reads the file the client wrote to its Screenshots folder.
--   IN:  load-on-demand addons read their files from disk at the moment they load.
--        The bridge writes the latest replies for every chat into a pool of pre-made
--        slot addons (ClaudeWoW_S001..S200); we load a fresh slot from a timer.
--        Each slot is single-use per session; a /reload frees them all.
--   Fallback ("reload" mode): SavedVariables + Inbox.lua, a ReloadUI() per step.
--
-- Chats: each chat is its own agent session (like a separate terminal) with its own
-- folder, agent, history and pending message. The bridge runs them in parallel.
-- Everything here is plain addon API. No automation, no memory reading.

local ADDON_NAME = ...
local ClaudeWoW = {}
_G.ClaudeWoW = ClaudeWoW
_G.BINDING_NAME_CLAUDEWOW_WORKSPACE = "Azeroth Companion: open or close the workspace"
ClaudeWoW.PRODUCT = "Azeroth Companion"
ClaudeWoW.PREFIX = "|cff66ccff[" .. ClaudeWoW.PRODUCT .. "]|r "
local Codec = ClaudeWoW_Codec

local DEFAULT_CWD = "" -- empty = the bridge's configured defaultCwd
local MAX_HISTORY = 200

local SLOT_COUNT = 200
local SLOT_PREFIX = "ClaudeWoW_S"
local ACT_MAX = 60 -- heartbeat files per message (act/NNN/01..60.wav)
local PRESENCE_MAX = 2000
local Presence = { RINGS = { "a", "b" }, STALL_SECONDS = 150, ROOT = "Interface\\AddOns\\ClaudeWoW_Runtime\\", LEGACY_ROOT = "Interface\\AddOns\\ClaudeWoW\\" }
Presence.root = Presence.ROOT
local STRIP_TRIES = 3 -- re-show an unacknowledged message this many times before falling back
local CELL, CELLS_PER_ROW, MAX_ROWS = 4, 200, 48
local STRIP_SECONDS = 40 -- max per message; it leaves the strip as soon as the bridge acknowledges
local SHOT_FRAMES = 2 -- screenshot transport: frames the strip is drawn before Screenshot() is called
local SHOT_TIMEOUT = 3 -- seconds to wait for SCREENSHOT_SUCCEEDED/FAILED before hiding the strip anyway
local SHOT_RETRIES = 3 -- failed screenshots per message before the normal 40 s retry takes over
local POLL_SCHEDULE = { 5, 10, 16, 24, 34, 46, 60, 80, 100, 130, 160, 200, 240, 300 }
local POLL_TAIL = 60
local TICK_SECONDS = 2
local CONNECT_WAIT = 15 -- seconds the Connect button waits for the bridge before giving up
local IDLE_POLL_SECONDS = 600 -- without the sound channel, spend one slot this often while idle to check the bridge
local LIVE_PLUGIN = "live"
local LIVE_PASS_TEXT = "Denied."
local LINK_PREFIX = "addon:claudewow:"
local RS, US = "\30", "\31" -- record / unit separators in the strip payload

local db
local ui = {}
ClaudeWoW.UI = ui
-- Transport state for this UI session. outbound[id] = { chat, cwd, flags, text, sentAt, acked }
local run = { outbound = {} }
-- Whisper tabs (the section after the game context). Declared up here because
-- Send, ApplyReplies and Finish use it and come first in the file.
local Whisper = {}
local Cli = { DIM_DEFAULT = 0.35, Links = {}, CONTEXT_WARN_DEFAULT = 300000, CONTEXT_WARN_OLD = 100000 }

-- Shared window backdrop. Declared up here because ShowCopy (rendering section)
-- uses it too: a later `local` would be invisible there and resolve to a nil global.
local BACKDROP = {
	bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
	edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
	tile = true, tileSize = 16, edgeSize = 16,
	insets = { left = 4, right = 4, top = 4, bottom = 4 },
}

-- The assistant bubble is labelled with the agent that wrote it (see AgentName).
local Q = {}
Q.CHAT_PAGE = 16

local ROLE_STYLE = {
	user      = { label = "You",    color = { 0.49, 0.78, 1.00 }, bg = { 0.25, 0.45, 0.75, 0.16 } },
	assistant = { label = "AI",     color = { 1.00, 0.82, 0.25 }, bg = { 0.85, 0.70, 0.30, 0.10 } },
	system    = { label = "System", color = { 0.62, 0.62, 0.62 }, bg = { 0.50, 0.50, 0.50, 0.10 } },
}

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

local function ToHex(s)
	return (s:gsub(".", function(c)
		return string.format("%02x", c:byte())
	end))
end

-- Record fields use control characters as separators, so keep them out of the wire format.
local function Wire(s)
	local value = tostring(s or "")
	return (value:gsub("[\30\31]", " "))
end

-- EditBoxes do not render UI escape sequences, so just make pipes harmless.
local function Display(s)
	return (tostring(s or ""):gsub("|", "¦"))
end

local function Trim(s)
	return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function Link(action, arg, label, hex)
	return "|H" .. LINK_PREFIX .. action .. (arg and (":" .. arg) or "") .. "|h|cff" .. (hex or "7ec8ff") .. "[" .. Display(label) .. "]|r|h"
end
ClaudeWoW.Link = Link

local function Flat(s)
	return (Display(s):gsub("%s*\n%s*", " "))
end

local function FmtDur(sec)
	sec = math.floor(sec or 0)
	if sec < 60 then return sec .. "s" end
	if sec < 3600 then return math.floor(sec / 60) .. "m" .. string.format("%02d", sec % 60) .. "s" end
	return math.floor(sec / 3600) .. "h" .. string.format("%02d", math.floor(sec / 60) % 60) .. "m"
end

-- Tokens as Claude Code's status line shows them: 850, 9.5k, 186.7k, 1.2M.
local function FmtTokens(n)
	n = tonumber(n) or 0
	if n < 1000 then return tostring(math.floor(n + 0.5)) end
	if n < 1000000 then return string.format("%.1fk", n / 1000) end
	return string.format("%.1fM", n / 1000000)
end

-- Elapsed time the way the same status line shows it: 45s, 11m 58s, 1h 02m.
local function FmtElapsed(sec)
	sec = math.max(0, math.floor(sec or 0))
	if sec < 60 then return sec .. "s" end
	if sec < 3600 then return math.floor(sec / 60) .. "m " .. string.format("%02d", sec % 60) .. "s" end
	return math.floor(sec / 3600) .. "h " .. string.format("%02d", math.floor(sec / 60) % 60) .. "m"
end

-- The footer segment's glyphs (Claude Code's own: "11m 58s · ↓ 186.7k tokens").
-- One place to change if the client's font lacks one of them.
local SEG = { DOT = "·", DOWN = "↓", APPROX = "≈" }

-- "100000", "100k", "0.5m" -> a token count; anything else nil.
local function ParseTokens(text)
	local num, unit = tostring(text or ""):lower():match("^(%d+%.?%d*)([km]?)$")
	if not num then return nil end
	local n = tonumber(num)
	if not n then return nil end
	if unit == "k" then n = n * 1000 elseif unit == "m" then n = n * 1000000 end
	return math.floor(n + 0.5)
end

function Cli.NormalizeFolder(cwd)
	local p = tostring(cwd or "")
	local home = run.bridgeHome
	if home and home ~= "" then
		if p == "~" then
			p = home
		elseif p:match("^~[\\/]") then
			p = home:gsub("[\\/]+$", "") .. p:sub(2)
		end
	end
	if #p > 1 then p = p:gsub("([^:\\/])[\\/]+$", "%1") end
	return p
end

-- Last path component of a folder, for labels.
local function FolderName(cwd)
	local labels = run.bridgeProjectLabels
	local label = labels and labels[Cli.NormalizeFolder(cwd)]
	if label and label ~= "" then return label end
	local name = tostring(cwd or ""):gsub("[\\/]+$", ""):match("([^\\/]+)$")
	return name or ""
end

-- The folder a chat works in: its own, or the bridge's default (the folder the
-- bridge was started from), which the bridge reports in every slot file.
local function ChatFolder(c)
	return Cli.ProjectOf(c)
end

-- Agents are named by id as the bridge knows them ("claude", "codex", "grok");
-- the bridge lists the ones it has, and its default, in every slot file. A chat
-- with no agent of its own runs on the bridge's default.
local AGENT_NAMES = { claude = "Claude", codex = "Codex", grok = "Grok", agy = "Antigravity", hermes = "Hermes" }

local function AgentName(id)
	id = tostring(id or "")
	if id == "" then return "AI" end
	return AGENT_NAMES[id] or (id:sub(1, 1):upper() .. id:sub(2))
end

local function ChatAgent(c)
	if c and c.agent and c.agent ~= "" then return c.agent end
	return run.bridgeAgent or ""
end

local function ChatAgentName(c)
	return AgentName(ChatAgent(c))
end

-- The name to show on a reply: the agent the bridge says wrote it, else the chat's.
local function ReplyAgentName(c, agent)
	if agent and agent ~= "" then return AgentName(agent) end
	return ChatAgentName(c)
end

local function Contains(list, v)
	for _, x in ipairs(list or {}) do
		if x == v then return true end
	end
	return false
end

function Cli.ChatPlugin(c)
	if not c then return "" end
	if c.liveTarget and c.liveTarget ~= "" then return LIVE_PLUGIN end
	if c.plugin and c.plugin ~= "" then return c.plugin end
	if c.cwd and c.cwd ~= "" then return "claude-code" end
	return ""
end

function ClaudeWoW.FolderOf(rule)
	if type(rule) ~= "string" then return nil end
	return rule:match("^AddDir%((.+)%)$")
end

function ClaudeWoW.GrantLabel(rule)
	local dir = ClaudeWoW.FolderOf(rule)
	return dir and ("folder " .. dir) or tostring(rule)
end

function ClaudeWoW.GrantsLabel(rules)
	local labels = {}
	for i, rule in ipairs(rules or {}) do labels[i] = ClaudeWoW.GrantLabel(rule) end
	return table.concat(labels, ", ")
end

function ClaudeWoW.SplitGrants(rules)
	local commands, dirs = {}, {}
	for _, rule in ipairs(rules or {}) do
		local dir = ClaudeWoW.FolderOf(rule)
		if dir then table.insert(dirs, dir) else table.insert(commands, rule) end
	end
	return commands, dirs
end

function Cli.ChatDirs(c, extra)
	local dirs = {}
	for _, list in ipairs({ type(c.addDirs) == "table" and c.addDirs or {}, type(extra) == "table" and extra or {} }) do
		for _, dir in ipairs(list) do
			if not Contains(dirs, dir) then table.insert(dirs, dir) end
		end
	end
	return dirs
end

function Cli.AddChatDirs(c, dirs)
	local left = {}
	for _, dir in ipairs(dirs or {}) do
		c.addDirs = c.addDirs or {}
		if not Contains(c.addDirs, dir) then
			if #c.addDirs < Cli.ADD_DIRS_MAX then table.insert(c.addDirs, dir) else table.insert(left, dir) end
		end
	end
	if c.addDirs and #c.addDirs == 0 then c.addDirs = nil end
	return left
end

function Cli.ChatOptionTokens(c, extraDirs)
	local tokens = {}
	if c.model and c.model ~= "" then table.insert(tokens, "model=" .. c.model) end
	if c.effort and c.effort ~= "" then table.insert(tokens, "effort=" .. c.effort) end
	if c.permissionMode and c.permissionMode ~= "" then table.insert(tokens, "pm=" .. c.permissionMode) end
	local dirs = Cli.ChatDirs(c, extraDirs)
	if #dirs > 0 then table.insert(tokens, "dirs=" .. ToHex(table.concat(dirs, "\31"))) end
	if c.resumeId and c.resumeId ~= "" then table.insert(tokens, "resume=" .. c.resumeId) end
	if c.liveTarget and c.liveTarget ~= "" then table.insert(tokens, "live=" .. ToHex(c.liveTarget)) end
	if c.discordLinkPending then table.insert(tokens, "discord=link") end
	local mcp = Cli.McpToken(c)
	if mcp ~= "" then table.insert(tokens, mcp) end
	return tokens
end

function Cli.LinkDiscord(c)
	if not run.bridgeDiscord then
		Cli.Out(c, "Discord is not on in this companion app. Set discord.enabled in its config.json and restart it.")
		return
	end
	local plugin = Cli.ChatPlugin(c)
	if plugin == "" then plugin = run.bridgePlugin or "" end
	if plugin ~= "claude-code" then
		Cli.Out(c, "Only a coding chat can live in Discord. Pick a project for this chat first (/claude --project <name>).")
		return
	end
	if c.pendingId then
		Cli.Out(c, "Wait for the reply first, then link the chat.")
		return
	end
	c.discordLinkPending = true
	ClaudeWoW.Send("/claude discord", nil, { chat = c.id, verbatim = true })
	c.discordLinkPending = nil
end

local function HasUserMessage(c)
	for _, m in ipairs(c.history or {}) do
		if m.role == "user" and not tostring(m.text or ""):find("^@dev ") then return true end
	end
	return false
end

Q.NEW_CHAT_TITLE = "New chat"

function Q.ShownName(c)
	if not c then return "" end
	local name = tostring(c.name or "")
	if name:match("^Chat %d+$") and not HasUserMessage(c) then return Q.NEW_CHAT_TITLE end
	return name
end

-- First few words of a message, as a chat title.
local function AutoTitle(text)
	local words = {}
	for w in tostring(text or ""):gmatch("%S+") do
		w = w:gsub("^[%p]+", ""):gsub("[%p]+$", "")
		if w ~= "" then
			table.insert(words, w)
			if #words >= 5 then break end
		end
	end
	local title = table.concat(words, " ")
	if #title > 24 then title = title:sub(1, 24):gsub("%s+%S*$", "") end
	if title == "" then return nil end
	return title:sub(1, 1):upper() .. title:sub(2)
end

local function NewId()
	return string.format("%x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF))
end

local function FindChat(id)
	for i, c in ipairs(db.chats) do
		if c.id == id then return c, i end
	end
end

local function ActiveChat()
	return FindChat(db.activeChat)
end

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

function Q.IsCharacterChat(c)
	return not c.quiet and (c.cwd or "") == "" and Cli.ChatPlugin(c) ~= "claude-code"
end

function Q.LoadCharacterChats(data, own)
	own = type(own) == "table" and own or {}
	local seen = {}
	for _, c in ipairs(data.chats) do seen[c.id] = true end
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

function Q.CharacterKey()
	return ClaudeWoWOrders and ClaudeWoWOrders.CharacterKey() or nil
end

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
	if not db.session then
		db.session = string.format("%x%04x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF), math.random(0, 0xFFFF))
	end
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
			if m.role == "claude" then m.role, m.agent = "assistant", m.agent or "claude" end
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
	for _, c in ipairs(db.chats) do c.plugin = c.plugin or "" end
	ClaudeWoW.RepairQuietChats(db)
	if FindChat(db.activeChat).quiet then db.activeChat = AddChat().id end
	ClaudeWoW.MigrateWhisper(s, fresh)
	if s.dim == nil then s.dim = Cli.DIM_DEFAULT end
	if s.dodge == nil then s.dodge = true end
	if s.autohide == nil then s.autohide = true end
end

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

function ClaudeWoW.ApplyMirror(list)
	if type(list) ~= "table" then return end
	local changed = false
	for _, e in ipairs(list) do
		local c = type(e) == "table" and type(e.chat) == "string" and FindChat(e.chat) or nil
		if not c and type(e) == "table" and e.room == true and type(e.chat) == "string" and e.chat:match("^r%x+$") and not db.forget[e.chat] then
			local title = type(e.title) == "string" and e.title ~= "" and e.title:sub(1, 40) or "agent-room"
			c = ClaudeWoW.AddChat(title, { id = e.chat, cwd = "", plugin = "room" })
		end
		local seq = c and tonumber(e.seq)
		if seq and seq > (c.mirrorSeq or 0) then
			local first = (c.mirrorSeq or 0) + 1
			if (c.mirrorSeq or e.room == true) and seq > first then
				AddHistory(c, "system", (seq - first) .. " earlier message(s) are in " .. (e.room == true and "agent-room" or "Discord") .. ".")
			end
			local text = tostring(e.text or "")
			if e.role == "user" then
				AddHistory(c, "user", "(" .. (type(e.from) == "string" and e.from ~= "" and e.from or "Discord") .. ") " .. text)
			elseif e.role == "assistant" then
				local denied = type(e.denied) == "table" and #e.denied > 0 and e.denied or nil
				AddHistory(c, "assistant", text, nil, denied, e.agent ~= "" and e.agent or nil)
			else
				AddHistory(c, "system", text)
			end
			c.mirrorSeq = seq
			if db.activeChat ~= c.id then c.unread = (c.unread or 0) + 1 end
			changed = true
		end
	end
	if changed then ClaudeWoW.Render() end
end

local function SlotName(i)
	return string.format("%s%03d", SLOT_PREFIX, i)
end

local function SlotNumber(id)
	return ((id - 1) % SLOT_COUNT) + 1
end

---------------------------------------------------------------------------
-- Reload plumbing (fallback path)
---------------------------------------------------------------------------

Q.RELOAD_COMBAT_STATUS = "In combat. You can reload when combat ends."
Q.RELOAD_TEXT_REPLY = "Reload needed\n\nA reply is waiting. The game must reload its interface to read it."
Q.RELOAD_TEXT_AFTER_COMBAT = "Reload needed\n\nCombat is over. Reload the interface now to finish what you started."

local function SafeReload()
	if InCombatLockdown() then
		run.reloadAfterCombat = true
		run.reloadAsked = nil
		if ui.status then ui.status:SetText(Q.RELOAD_COMBAT_STATUS) end
		return
	end
	ReloadUI()
end

Q.RELOAD_POPUP = "CLAUDEWOW_RELOAD"

function Q.AskReload()
	StaticPopupDialogs[Q.RELOAD_POPUP].text = Q.ReplyReloadNeeded() and Q.RELOAD_TEXT_REPLY or Q.RELOAD_TEXT_AFTER_COMBAT
	if not StaticPopup_Show(Q.RELOAD_POPUP) then return false end
	run.reloadAsked = Q.PendingKey()
	run.reloadDialogManual = run.reloadAfterCombat == true
	run.reloadAfterCombat = nil
	return true
end

function Q.AfterCombat()
	if not db then return end
	if run.reloadAfterCombat and Q.AskReload() then return end
	ClaudeWoW.ArmAutoRefresh()
end

StaticPopupDialogs[Q.RELOAD_POPUP] = {
	text = Q.RELOAD_TEXT_REPLY,
	button1 = "Reload",
	button2 = "Later",
	OnAccept = function() SafeReload() end,
	OnCancel = function() ClaudeWoW.ReloadLater() end,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	preferredIndex = 3,
}

function ClaudeWoW.DisarmReload()
	run.reloadArmed, run.reloadAsked = nil, nil
	if StaticPopup_Hide and not run.reloadDialogManual then StaticPopup_Hide(Q.RELOAD_POPUP) end
	if run.reloadAfterCombat and not InCombatLockdown() then ClaudeWoW.ArmAutoRefresh() end
end

function Q.PendingKey()
	local ids = {}
	for _, c in ipairs(db.chats) do
		if c.pendingId then table.insert(ids, c.id .. ":" .. c.pendingId) end
	end
	return table.concat(ids, ",")
end

function Q.ReloadKey()
	return Q.PendingKey() .. (run.reloadAfterCombat and "|combat" or "")
end

function Q.ReloadNeeded()
	if not db then return false end
	return run.reloadAfterCombat == true or Q.ReplyReloadNeeded()
end

function Q.ReplyReloadNeeded()
	if not db or not AnyPending() then return false end
	if db.settings.mode ~= "pixel" then return true end
	return (run.slotsExhausted or run.slotsMissing or run.pixelFailed) and true or false
end

function ClaudeWoW.ArmAutoRefresh()
	if not Q.ReloadNeeded() then return end
	local key = Q.ReloadKey()
	if run.reloadAsked == key or run.reloadArmed == key then return end
	run.reloadArmed = key
	C_Timer.After(db.settings.interval, function()
		if run.reloadArmed ~= key then return end
		run.reloadArmed = nil
		if not Q.ReloadNeeded() or InCombatLockdown() then return end
		if not Q.AskReload() then ClaudeWoW.ArmAutoRefresh() end
	end)
end

function ClaudeWoW.ReloadLater()
	if not db.settings.autoRefresh then return end
	run.reloadAsked = nil
	ClaudeWoW.ArmAutoRefresh()
end

---------------------------------------------------------------------------
-- Pixel strip (out)
---------------------------------------------------------------------------

local strip
local cellPool = {}

local function EnsureStrip()
	if strip then return strip end
	strip = CreateFrame("Frame", "ClaudeWoWStrip", UIParent)
	strip:SetFrameStrata("TOOLTIP")
	strip:SetFrameLevel(10000)
	-- Scale so that one UI unit is exactly one physical pixel (see Blizzard's PixelUtil).
	local physH = 1080
	if GetPhysicalScreenSize then
		local _, h = GetPhysicalScreenSize()
		physH = h or physH
	end
	if strip.SetIgnoreParentScale then strip:SetIgnoreParentScale(true) end
	strip:SetScale(768 / physH)
	strip:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
	strip:SetSize(CELLS_PER_ROW * CELL, MAX_ROWS * CELL)
	strip:Hide()
	return strip
end

local function HideStrip()
	if strip then strip:Hide() end
	run.stripShown = nil
end

-- Which codec the strip is drawn with (see Codec.lua) and the two levels, 0..255,
-- its channels span. Codec 1 at full primaries, except on the screenshot
-- transport, where the bridge asked for levels of its own (see StripLevels): a
-- screenshot is bit-exact, so dark levels read as well as bright ones and the
-- strip all but disappears. Codec 2 (2 px cells, four levels a channel between
-- the same two numbers) only when that bridge asked for it.
local function StripCodec()
	local lv = db and db.settings.mode == "pixel" and db.settings.transport == "screenshot" and db.settings.stripLevels
	if type(lv) == "table" and type(lv.on) == "number" and type(lv.off) == "number" then
		return lv.codec == 2 and 2 or 1, lv.on, lv.off
	end
	return 1, 255, 0
end

local function ShowStrip(id, payload)
	local codec, on, off = StripCodec()
	local geo = Codec.GEOMETRY[codec]
	local cells = Codec.Encode(id % 65536, payload, codec)
	local s = EnsureStrip()
	local rows = math.ceil(#cells / geo.cells)
	local total = rows * geo.cells
	local levels = codec == 2 and Codec.DenseLevels(on, off) or nil
	for i = 1, total do
		local t = cellPool[i]
		if not t then
			t = s:CreateTexture(nil, "OVERLAY")
			cellPool[i] = t
		end
		-- A texture is laid out for one codec; a switch (the bridge changed its
		-- mind, or an older saved setting) places it again.
		if t.codec ~= codec then
			t:SetSize(geo.cell, geo.cell)
			local c = (i - 1) % geo.cells
			local r = math.floor((i - 1) / geo.cells)
			t:ClearAllPoints()
			t:SetPoint("TOPLEFT", s, "TOPLEFT", c * geo.cell, -r * geo.cell)
			t.codec = codec
		end
		local v = cells[i] or 0
		if codec == 2 then
			local cr, cg, cb = Codec.DenseCellColor(v)
			t:SetColorTexture(levels[cr + 1] / 255, levels[cg + 1] / 255, levels[cb + 1] / 255, 1)
		else
			local cr, cg, cb = Codec.CellColor(v)
			t:SetColorTexture((off + cr * (on - off)) / 255, (off + cg * (on - off)) / 255, (off + cb * (on - off)) / 255, 1)
		end
		t:Show()
	end
	for i = total + 1, #cellPool do
		cellPool[i]:Hide()
	end
	s:Show()
	run.stripShown = true
end

-- Record: session, chat, id, cwd, flags, name, [context,] text. Several records
-- per frame. The context field is only present when the flags carry "c", so the
-- bridge can tell it from a separator inside the text.
local NoScreenshot -- below (Screenshot transport): the bridge wants shots this client cannot take
local function RecordFor(id, rec)
	local flags = Wire(rec.flags)
	-- The bridge wants screenshots and this record cannot be shot (no
	-- Screenshot() in this client, or SCREENSHOT_FAILED on every try): tell the
	-- bridge, and it falls back to the pixel capture (bridge.js fallbackToPixel;
	-- the reload outbox says it too).
	local shot = NoScreenshot() and "missing" or (rec.shotFailed and "failed") or nil
	if shot then flags = flags == "" and ("shot=" .. shot) or (flags .. ";shot=" .. shot) end
	local report = Presence.Report and Presence.Report() or ""
	if report ~= "" then flags = flags == "" and report or (flags .. ";" .. report) end
	local fields = { Wire(db.session), Wire(rec.chat), tostring(id), Wire(rec.cwd), flags, Wire(rec.name) }
	if rec.ctx ~= nil then
		fields[5] = flags == "" and "c" or (flags .. ";c")
		table.insert(fields, Wire(rec.ctx))
	end
	table.insert(fields, Wire(rec.text))
	return table.concat(fields, US)
end

---------------------------------------------------------------------------
-- Screenshot transport
---------------------------------------------------------------------------
--
-- The bridge names its outbound transport in every slot file (`transport`). On
-- "screenshot" it doesn't watch the screen: we draw the strip, wait SHOT_FRAMES
-- frames so it is really rendered, call Screenshot(), and hide the strip when
-- the client reports SCREENSHOT_SUCCEEDED / SCREENSHOT_FAILED (or after
-- SHOT_TIMEOUT). The bridge decodes the file from the Screenshots folder and
-- deletes it. Each outbound record is shot once (`rec.shot`); the 40 s retry in
-- Tick clears the flag so an unacknowledged message is shot again. The last
-- transport heard is kept in the saved settings, so the login hello already
-- goes out the right way.

local function ScreenshotMode()
	return db ~= nil and db.settings.mode == "pixel" and db.settings.transport == "screenshot" and type(Screenshot) == "function"
end

-- The bridge listens for screenshots, and this client cannot take one.
NoScreenshot = function()
	return db ~= nil and db.settings.transport == "screenshot" and type(Screenshot) ~= "function"
end

local function ShotStats()
	run.shotStats = run.shotStats or { taken = 0, ok = 0, failed = 0, timeouts = 0 }
	return run.shotStats
end

-- Vision ("/claude-wow vision on", off by default): the screenshot this transport
-- takes per message is the whole screen; the bridge keeps the part under the
-- strip, scales it down and attaches it to the agent's message as an image, so
-- "what is this item?" or "why is this boss killing me?" can be answered. A "v"
-- flag on the record asks for it. The pixel transport never sees more than the
-- strip, so there the flag is sent but changes nothing.
local function VisionStatus()
	local s = db.settings
	if not s.vision then return "Vision is OFF: the agent gets no picture of your screen" end
	if s.transport ~= "screenshot" then
		return "Vision is ON, but the companion app listens on the pixel transport, which has no screenshot to send: set capture.mode to \"screenshot\" in its config.json and restart the companion app"
	end
	return "Vision is ON: each message goes out with a picture of your screen (the screenshot this transport takes anyway, strip cropped off and downscaled by the companion app), so the agent can see what you see"
end

-- The client writes screenshots as JPEG by default, which is lossy; the
-- transport needs PNG (or TGA). The player's own setting is kept in the saved
-- settings (shotFormatSaved) from the first time we change it until we leave
-- the mode or log out, so a /reload in between can't lose it, and a crash,
-- which skips the logout restore, is repaired at the next load (ADDON_LOADED
-- and PLAYER_LOGIN both call SyncScreenshotMode). The two values we set are
-- ours to recognise: a stored original is never replaced by one of them, or
-- the player's real setting would be gone for good, and only a value that is
-- still ours is ever put back, so a format the player chose since stays.
local function IsAddonFormat(v)
	return v == "png" or v == "tga"
end

local function ScreenshotCVarsOn()
	if type(SetCVar) ~= "function" or type(GetCVar) ~= "function" then return end
	local cur = tostring(GetCVar("screenshotFormat") or "jpeg")
	local saved = db.settings.shotFormatSaved
	-- Nothing on record: this is the player's value. Something on record and a
	-- current value that is neither it nor ours: the player changed it since
	-- (after a crash, say), and that is the setting to give back later.
	if saved == nil or (cur ~= saved and not IsAddonFormat(cur)) then
		db.settings.shotFormatSaved = cur
	end
	if cur == "png" then return end
	local ok = pcall(SetCVar, "screenshotFormat", "png")
	if not ok or GetCVar("screenshotFormat") ~= "png" then pcall(SetCVar, "screenshotFormat", "tga") end
end

local function ScreenshotCVarsOff()
	local saved = db.settings.shotFormatSaved
	if saved == nil then return end
	db.settings.shotFormatSaved = nil
	if type(SetCVar) ~= "function" or type(GetCVar) ~= "function" then return end
	-- Still ours (png, or the tga fallback): put the player's back. Anything
	-- else the player set by hand in the meantime, and it stays.
	if IsAddonFormat(tostring(GetCVar("screenshotFormat") or "")) then pcall(SetCVar, "screenshotFormat", saved) end
end

local function SyncScreenshotMode()
	if ScreenshotMode() then ScreenshotCVarsOn() else ScreenshotCVarsOff() end
end

local RefreshStrip -- below; ScreenshotDone re-runs it for records that arrived mid-shot
local ShotsPaused -- after BridgeState: whether the bridge has been dark too long to shoot for

local function TellPlayer(msg)
	local c = ActiveChat()
	if c then AddHistory(c, "system", msg) end
	Q.Notify(msg)
	if ui.frame then ClaudeWoW.Render() end
end

function Q.Notify(msg)
	local c = ActiveChat()
	if not (c and Whisper.Active() and Whisper.System(c, msg, true)) then print(ClaudeWoW.PREFIX .. msg) end
end

ClaudeWoW.ChatLog = { MISSES_BEFORE_PAUSE = 2, RETRY_SECONDS = 8, SLOW_RETRY_SECONDS = 15, ACK_POLL_SECONDS = 4, FIRST_PAUSE_SECONDS = 600, MAX_PAUSE_SECONDS = 3600 }

function ClaudeWoW.ChatLog.RetrySeconds()
	local L = ClaudeWoW.ChatLog
	if ClaudeWoW.PresenceWorks() and not run.signalUnreliable then return L.RETRY_SECONDS end
	return L.SLOW_RETRY_SECONDS
end

function ClaudeWoW.ChatLog.Paused()
	local pause = run.chatlogPause
	return pause ~= nil and GetTime() - pause.at < pause.wait
end

function ClaudeWoW.ChatLog.Pause(reason)
	local L = ClaudeWoW.ChatLog
	local earlier = run.chatlogPause
	local wait = earlier and math.min(earlier.wait * 2, L.MAX_PAUSE_SECONDS) or L.FIRST_PAUSE_SECONDS
	run.chatlogPause = { at = GetTime(), wait = wait, reason = reason }
	run.chatlogMisses = 0
	return wait, earlier == nil
end

function ClaudeWoW.ChatLog.Resume()
	run.chatlogPause = nil
	run.chatlogMisses = 0
end

function ClaudeWoW.ChatLog.Spec(data)
	local spec = type(data) == "table" and data.chatlog
	if type(spec) ~= "table" or type(spec.line) ~= "number" or type(spec.filler) ~= "number" then return nil end
	local line, filler = math.floor(spec.line), math.floor(spec.filler)
	if line < 60 or line > 940 or filler < 0 or filler > 65536 then return nil end
	local key = spec.key
	if type(key) ~= "string" or #key ~= 32 or key:find("[^0-9a-f]") then return nil end
	return { line = line, filler = filler, key = key, show = spec.show == true or nil }
end

function ClaudeWoW.ChatLog.Same(a, b)
	if a == nil or b == nil then return a == b end
	return a.line == b.line and a.filler == b.filler and a.key == b.key and a.show == b.show
end

function ClaudeWoW.ChatLog.Mode()
	return db ~= nil and db.settings.mode == "pixel" and db.settings.transport == "screenshot"
		and type(db.settings.chatlog) == "table" and type(db.settings.chatlog.key) == "string" and not ClaudeWoW.ChatLog.Paused()
		and type(SendSystemMessage) == "function" and type(LoggingChat) == "function"
end

function ClaudeWoW.ChatLog.Fits(records)
	for _, rec in ipairs(records) do
		if (rec.tries or 1) > 1 then return false end
		if (";" .. (rec.flags or "") .. ";"):find(";v;", 1, true) then return false end
	end
	return true
end

function ClaudeWoW.ChatLog.Hide(_, _, msg, ...)
	if type(msg) ~= "string" or msg:sub(1, #Codec.LOG_TAG + 1) ~= Codec.LOG_TAG .. " " then return false end
	local spec = db and db.settings.chatlog
	if type(spec) ~= "table" or not spec.show then return true end
	local keyless = msg:gsub("^(%S+) %x+ (%d+ %d+/%d+ )", "%1 ... %2", 1)
	return false, keyless, ...
end

function ClaudeWoW.ChatLog.InstallFilter()
	local L = ClaudeWoW.ChatLog
	if L.filtered then return end
	local add = (type(ChatFrameUtil) == "table" and ChatFrameUtil.AddMessageEventFilter) or ChatFrame_AddMessageEventFilter
	if type(add) == "function" then L.filtered = pcall(add, "CHAT_MSG_SYSTEM", L.Hide) end
end

function ClaudeWoW.ChatLog.Write(id, payload, kind)
	local spec = db.settings.chatlog
	local ok, err = pcall(function()
		if not LoggingChat() then LoggingChat(true) end
		ClaudeWoW.ChatLog.InstallFilter()
		local lines = Codec.LogLines(id, payload, spec.line, spec.filler, spec.key)
		for i = 1, #lines do SendSystemMessage(lines[i]) end
		run.chatlogStats = run.chatlogStats or { frames = 0, lines = 0, acked = 0, late = 0, gs = 0 }
		if kind == "gs" then
			run.chatlogStats.gs = run.chatlogStats.gs + 1
		else
			run.chatlogStats.frames = run.chatlogStats.frames + 1
		end
		run.chatlogStats.lines = run.chatlogStats.lines + #lines
	end)
	if not ok then
		ClaudeWoW.ChatLog.Pause("error: " .. tostring(err))
	end
	return ok
end

function ClaudeWoW.ChatLog.Acked(rec)
	if not rec.logged then return end
	local stats = run.chatlogStats
	if (rec.tries or 1) == 1 then
		if stats then stats.acked = stats.acked + 1 end
		ClaudeWoW.ChatLog.Resume()
		return
	end
	if stats then stats.late = stats.late + 1 end
	run.chatlogMisses = (run.chatlogMisses or 0) + 1
	if run.chatlogPause or run.chatlogMisses >= ClaudeWoW.ChatLog.MISSES_BEFORE_PAUSE then
		local wait, first = ClaudeWoW.ChatLog.Pause("the bridge read the last message only from the screenshot retry")
		if first then
			TellPlayer("the companion app did not read the chat log in time. Messages go out by screenshot; the chat log is tried again in " .. FmtDur(wait) .. ".")
		end
	end
end

function ClaudeWoW.ChatLog.Status()
	local s = db.settings
	if type(s.chatlog) ~= "table" then return "chat log transport: off (the bridge did not ask for it)" end
	local stats = run.chatlogStats
	local pause = run.chatlogPause
	local state = ClaudeWoW.ChatLog.Mode() and (pause and "on trial after a pause" or "on") or "unavailable in this client"
	if ClaudeWoW.ChatLog.Paused() then
		state = "PAUSED, next try in " .. FmtDur(pause.wait - (GetTime() - pause.at)) .. " (" .. tostring(pause.reason) .. ")"
	end
	return string.format("chat log transport: %s, lines of %d, filler %d bytes%s%s",
		state,
		s.chatlog.line, s.chatlog.filler,
		s.chatlog.show and ", lines shown in chat" or "",
		stats and string.format("; %d frames, %d lines written, %d acknowledged first time, %d only after the screenshot retry, %d game state frames", stats.frames, stats.lines, stats.acked, stats.late, stats.gs) or "")
end

local Tm = {}

function Tm.Settle(outcome, rec)
	local telemetry = ClaudeWoWTelemetry
	if rec and type(telemetry) == "table" and type(telemetry[outcome]) == "function" then pcall(telemetry[outcome], rec) end
end

function Tm.CallOff()
	if run.shot and not run.shot.fired then
		Tm.Settle("Lost", run.shot.telemetry)
		run.shot = nil
	end
end

local ShotStatus = { hooked = {} }

function ShotStatus.Frames()
	local out = {}
	if _G.ActionStatus then table.insert(out, _G.ActionStatus) end
	if WorldFrame and WorldFrame.GetChildren then
		for _, child in ipairs({ WorldFrame:GetChildren() }) do
			if child ~= _G.ActionStatus and child.GetName and child:GetName() == "ActionStatus" then table.insert(out, child) end
		end
	end
	return out
end

function ShotStatus.Quiet(gen)
	run.quietShot = gen
	for _, frame in ipairs(ShotStatus.Frames()) do
		if not ShotStatus.hooked[frame] and frame.HookScript then
			ShotStatus.hooked[frame] = true
			frame:HookScript("OnShow", function(self)
				if run.quietShot then self:Hide() end
			end)
		end
	end
end

function ShotStatus.End(gen)
	C_Timer.After(0, function()
		if run.quietShot == gen then run.quietShot = nil end
	end)
end

-- ok = true (SCREENSHOT_SUCCEEDED), false (SCREENSHOT_FAILED or the call raised),
-- nil (no event within SHOT_TIMEOUT: the file may or may not exist).
local function ScreenshotDone(ok, fromEvent)
	local shot = run.shot
	if fromEvent and run.staleShotUntil then
		run.staleShotUntil = nil
		if run.staleShotGen then ShotStatus.End(run.staleShotGen) end
		run.staleShotGen = nil
		if not (shot and shot.fired) then return end
	end
	if not shot or (fromEvent and not shot.fired) then return end
	run.shot = nil
	if ok == nil then
		run.staleShotUntil = GetTime() + SHOT_TIMEOUT
		run.staleShotGen = shot.gen
	else
		ShotStatus.End(shot.gen)
	end
	HideStrip()
	Tm.Settle(ok == true and "Delivered" or "Lost", shot.telemetry)
	local stats = ShotStats()
	if ok == true then stats.ok = stats.ok + 1
	elseif ok == false then stats.failed = stats.failed + 1
	else stats.timeouts = stats.timeouts + 1 end
	if ok == false then
		for id, rec in pairs(run.outbound) do
			if rec.shot == shot.gen then
				rec.shotFails = (rec.shotFails or 0) + 1
				if rec.shotFails < SHOT_RETRIES then
					rec.shot = nil
					rec.sentOnce = nil
				else
					-- Every try failed: the bridge should fall back to the pixel
					-- capture. Said on the record (the reload fallback carries it
					-- in the outbox; the strip retries carry it as a flag) and to
					-- the player, once.
					rec.shotFailed = true
					if db.outbox and db.outbox.id == id then db.outbox.shot = "failed" end
					if not run.shotFailTold then
						run.shotFailTold = true
						TellPlayer("the client reported SCREENSHOT_FAILED " .. SHOT_RETRIES .. " times for one message" .. (shot.err and (" (" .. shot.err .. ")") or "") .. ". The message waits for the usual retries and the reload fallback, which tell the companion app to switch to the pixel capture; set capture.mode to \"pixel\" in the companion app's config.json to skip the wait.")
					end
				end
			end
		end
	end
	-- Whatever is still unshot (arrived mid-shot, or just failed) goes next; in
	-- pixel mode this puts the strip back up.
	RefreshStrip()
end

local function TakeScreenshot()
	local s = EnsureStrip()
	run.shotGen = (run.shotGen or 0) + 1
	local gen = run.shotGen
	run.shot = { gen = gen, frames = 0, fired = false }
	run.shotOverride = nil -- a Connect click buys exactly one shot while the bridge is dark
	-- OnUpdate only runs while the strip is shown, which is exactly when the
	-- frames are being rendered with it.
	s:SetScript("OnUpdate", function(self)
		local shot = run.shot
		if not shot or shot.gen ~= gen then
			self:SetScript("OnUpdate", nil)
			return
		end
		shot.frames = shot.frames + 1
		if shot.frames < SHOT_FRAMES then return end
		if run.staleShotUntil and GetTime() < run.staleShotUntil then return end
		if run.staleShotGen then ShotStatus.End(run.staleShotGen) end
		run.staleShotUntil, run.staleShotGen = nil, nil
		self:SetScript("OnUpdate", nil)
		shot.fired = true
		for _, rec in pairs(run.outbound) do
			if rec.openUrl and rec.shot == gen then rec.sentOnce = true end
		end
		ShotStats().taken = ShotStats().taken + 1
		pcall(ShotStatus.Quiet, gen)
		local ok, err = pcall(Screenshot)
		if not ok then
			shot.err = tostring(err)
			ScreenshotDone(false)
			return
		end
		C_Timer.After(SHOT_TIMEOUT, function()
			if run.shot and run.shot.gen == gen then ScreenshotDone(nil) end
		end)
	end)
	return gen
end

function Tm.Record(room, solo)
	local telemetry = ClaudeWoWTelemetry
	if type(telemetry) ~= "table" or type(telemetry.Take) ~= "function" then return nil end
	if room <= 0 or ShotsPaused(true) or run.shotOverride then return nil end
	local ok, rec = pcall(telemetry.Take, room, solo)
	if ok and type(rec) == "string" and rec ~= "" and #rec <= room then return rec end
	return nil
end

function ClaudeWoW.TelemetryShot()
	if not db or not ScreenshotMode() or run.shot then return end
	RefreshStrip()
end

-- Redraw the strip from every outbound message the bridge hasn't acknowledged.
RefreshStrip = function()
	local ids = {}
	for id, rec in pairs(run.outbound) do
		if not rec.acked and not (rec.openUrl and rec.sentOnce) then table.insert(ids, id) end
	end
	if #ids == 0 then
		-- Nothing left to send. A shot still counting frames is called off; one
		-- the client is already writing keeps the strip until its event.
		if run.shot and not run.shot.solo then Tm.CallOff() end
		if not run.shot and ClaudeWoW.ChatLog.Mode() then
			HideStrip()
			local solo = Tm.Record(Codec.MAX_PAYLOAD, true)
			if solo then Tm.Settle(ClaudeWoW.ChatLog.Write(0, solo, "gs") and "Delivered" or "Lost", solo) end
			return
		end
		if not run.shot then
			local solo = ScreenshotMode() and Tm.Record(Codec.MAX_PAYLOAD, true)
			if solo then
				ShowStrip(0, solo)
				TakeScreenshot()
				run.shot.telemetry = solo
				run.shot.solo = true
				return
			end
			HideStrip()
		end
		return
	end
	table.sort(ids)
	-- Newest first; drop the oldest if the frame would overflow.
	local parts, size, latest, included = {}, 0, ids[#ids], {}
	for i = #ids, 1, -1 do
		local rec = run.outbound[ids[i]]
		local r = RecordFor(ids[i], rec)
		if size + #r + 1 > Codec.MAX_PAYLOAD then break end
		table.insert(parts, 1, r)
		table.insert(included, rec)
		size = size + #r + 1
	end
	if ClaudeWoW.ChatLog.Mode() and ClaudeWoW.ChatLog.Fits(included) then
		local unsent = false
		for _, rec in ipairs(included) do
			if not rec.shot then unsent = true end
		end
		local rider = unsent and Tm.Record(Codec.MAX_PAYLOAD - size - 1, false) or nil
		if rider then table.insert(parts, rider) end
		local written = unsent and ClaudeWoW.ChatLog.Write(latest, table.concat(parts, RS))
		Tm.Settle(written and "Delivered" or "Lost", rider)
		if rider and not written then table.remove(parts) end
		if not unsent or written then
			Tm.CallOff()
			if not run.shot then HideStrip() end
			if unsent then
				for _, rec in ipairs(included) do
					rec.shot = "log"
					rec.sentOnce = rec.openUrl or nil
					rec.logged = true
					rec.loggedAt = GetTime()
					if (rec.forget or rec.cancelOf or rec.dm) and not run.helloPollAt and not run.ackPollAt then
						run.ackPollAt = GetTime() + ClaudeWoW.ChatLog.ACK_POLL_SECONDS
					end
				end
			end
			return
		end
	end
	if not ScreenshotMode() then
		-- A shot still counting frames (the transport just changed) is called off.
		Tm.CallOff()
		if NoScreenshot() and not run.noShotTold then
			-- The bridge wants screenshots and this client has no Screenshot():
			-- the strip stays up pixel-style, the retries and then the reload
			-- fallback carry the message, and the record tells the bridge to
			-- fall back to the pixel capture (shot=missing). Said once.
			run.noShotTold = true
			TellPlayer("this client has no Screenshot() function, so the companion app's screenshot transport cannot work here. Messages wait for the reload fallback (a couple of minutes the first time), which tells the companion app to switch to the pixel capture; set capture.mode to \"pixel\" in the companion app's config.json to skip the wait.")
		end
		ShowStrip(latest, table.concat(parts, RS))
		return
	end
	if ShotsPaused() then
		-- The bridge has been dark for a while: every shot would be a full-screen
		-- file nobody deletes. The strip goes up pixel-style instead, as when
		-- Screenshot() is missing, so the usual retries and then the reload
		-- fallback take the message from here; nothing is dropped. Said once,
		-- when a shot is actually withheld; Tick says when shooting resumes.
		Tm.CallOff()
		if not run.shotsPaused then
			run.shotsPaused = true
			local age = GetTime() - (run.bridgeSeen or run.startedAt or GetTime())
			TellPlayer("Companion app not seen for " .. FmtDur(age) .. ": screenshots paused so they don't pile up with your own screenshots. Messages wait (the strip stays up, as in pixel mode) and shooting resumes when the companion app is back; the Connect button takes one by hand.")
		end
		ShowStrip(latest, table.concat(parts, RS))
		return
	end
	-- Screenshot transport: only records not yet shot put the strip up.
	local unshot = false
	for _, rec in ipairs(included) do
		if not rec.shot then unshot = true end
	end
	if not unshot then
		if not run.shot then HideStrip() end
		return
	end
	if run.shot and run.shot.fired then
		-- The client is writing a shot of the previous strip; ScreenshotDone takes
		-- another for the records still unshot.
		return
	end
	local retry = false
	for _, rec in ipairs(included) do
		if (rec.tries or 1) > 1 or rec.shotFails then retry = true end
	end
	local room = Codec.MAX_PAYLOAD - size - 1
	local waiting = run.shot and not run.shot.fired and run.shot.telemetry
	local keep = waiting and not retry and #waiting <= room
	if waiting and not keep then Tm.Settle("Lost", waiting) end
	local rider = keep and waiting or (not retry and Tm.Record(room, false)) or nil
	if rider then table.insert(parts, rider) end
	ShowStrip(latest, table.concat(parts, RS))
	local gen = TakeScreenshot()
	run.shot.telemetry = rider
	for _, rec in ipairs(included) do rec.shot = gen end
end

-- The two levels the bridge wants the strip drawn at on the screenshot transport
-- and the codec it decodes (`strip = { on, off, codec }` in its slot files; no
-- codec, as an older bridge writes it, is codec 1), sanity-checked and remembered.
local function StripLevels(data)
	local lv = type(data) == "table" and data.strip
	if type(lv) ~= "table" or type(lv.on) ~= "number" or type(lv.off) ~= "number" then return nil end
	local on, off = math.floor(lv.on), math.floor(lv.off)
	if off < 0 or on > 255 or on - off < 8 then return nil end
	return { on = on, off = off, codec = lv.codec == 2 and 2 or 1 }
end

-- The bridge's slot files and Inbox.lua say which transport it listens on, and
-- for the screenshot transport, which levels to draw the strip at.
local function ApplyTransport(data)
	if type(data) ~= "table" or type(data.transport) ~= "string" then return end
	local t = data.transport
	if t ~= "pixel" and t ~= "screenshot" then return end
	-- Why the bridge is on the pixel capture when nobody asked for it (it fell
	-- back after we reported shot=missing or shot=failed); /claude-wow diag shows it.
	db.settings.transportNote = type(data.transportNote) == "string" and data.transportNote ~= "" and data.transportNote or nil
	local lv = StripLevels(data)
	local cur = db.settings.stripLevels
	local sameLevels = (lv == nil and cur == nil) or (lv ~= nil and cur ~= nil and lv.on == cur.on and lv.off == cur.off and lv.codec == (cur.codec or 1))
	local logSpec = ClaudeWoW.ChatLog.Spec(data)
	if db.settings.transport == t and sameLevels and ClaudeWoW.ChatLog.Same(logSpec, db.settings.chatlog) then return end
	db.settings.transport = t
	db.settings.stripLevels = lv
	if not ClaudeWoW.ChatLog.Same(logSpec, db.settings.chatlog) then ClaudeWoW.ChatLog.Resume() end
	db.settings.chatlog = logSpec
	SyncScreenshotMode()
	-- Whatever is still unacknowledged goes out again the new way.
	for _, rec in pairs(run.outbound) do rec.shot = nil end
	RefreshStrip()
	ClaudeWoW.UpdateStatus()
end

---------------------------------------------------------------------------
-- Signals and slots (in)
---------------------------------------------------------------------------

local signalAvailable = type(PlaySoundFile) == "function"
local signalStats = { checks = 0, hits = 0, lastHit = nil }

function Presence.Probe(path)
	if not signalAvailable or not db.settings.signal then return nil end
	signalStats.checks = signalStats.checks + 1
	local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
	if not ok then
		signalAvailable = false
		signalStats.error = tostring(willPlay)
		return nil
	end
	if willPlay and handle then pcall(StopSound, handle) end
	if willPlay then
		signalStats.hits = signalStats.hits + 1
		signalStats.lastHit = GetTime()
	end
	return willPlay and true or false
end

local function SoundValid(path)
	return Presence.Probe(path) == true
end

function Presence.Fired(path)
	return Presence.Probe(path) == false
end

local function CheckSignal(kind, id)
	if run.signalUnreliable then return false end
	return Presence.Fired(string.format("%s%s\\%03d.wav", Presence.root, kind, SlotNumber(id)))
end

local function NoteStaleSignals(id)
	local rec = run.outbound[id]
	if not rec then return end
	rec.staleAck = CheckSignal("ack", id) or nil
	if CheckSignal("sig", id) then
		run.staleSig = run.staleSig or {}
		run.staleSig[id] = true
	end
end

local function FreshSignal(kind, id)
	if kind == "sig" and run.staleSig and run.staleSig[id] then return false end
	return CheckSignal(kind, id)
end

local function ActPath(id, k)
	return string.format("%sact\\%03d\\%02d.wav", Presence.root, SlotNumber(id), k)
end

local function StartActivity(chat, id)
	local a = { next = 1, count = 0, startedAt = GetTime() }
	if Presence.Fired(ActPath(id, 1)) then a.unreliable = true end
	run.act = run.act or {}
	run.act[chat.id] = a
end

local function PollActivity(chat)
	local a = run.act and run.act[chat.id]
	if not a or a.unreliable or not chat.pendingId then return false end
	local moved = false
	for _ = 1, 3 do
		if a.next > ACT_MAX then break end
		if not Presence.Fired(ActPath(chat.pendingId, a.next)) then break end
		a.count = a.count + 1
		a.next = a.next + 1
		a.last = GetTime()
		moved = true
	end
	if moved then Q.NoteLife(chat) end
	return moved
end

function Q.ActivityAtLogin(chat)
	local a = { next = 1, count = 0, startedAt = GetTime() }
	while a.next <= ACT_MAX and Presence.Fired(ActPath(chat.pendingId, a.next)) do
		a.next, a.count = a.next + 1, a.count + 1
	end
	return a
end

local function NotedBridge(at)
	if run.replay then
		at = run.replay.at
		if not at then return end
	end
	at = at or GetTime()
	if not run.bridgeSeen or at > run.bridgeSeen then run.bridgeSeen = at end
	run.pixelFailed = nil
end

local function PresencePath(ring, k)
	return string.format("%spresence\\%s\\%04d.wav", Presence.root, ring, k)
end

local function FindPresenceHead(ring, pathOf, max)
	local lo, hi = 1, (max or PRESENCE_MAX) + 1
	while lo < hi do
		local mid = math.floor((lo + hi) / 2)
		if SoundValid((pathOf or PresencePath)(ring, mid)) then hi = mid else lo = mid + 1 end
	end
	return lo
end

function Presence.Channel()
	return signalAvailable and db ~= nil and db.settings.signal and true or false
end

function Presence.State()
	if run.presence then return run.presence end
	local p = { heads = {}, loginHeads = {}, staleRing = {}, beats = 0, test = "pending" }
	for _, ring in ipairs(Presence.RINGS) do
		p.heads[ring] = FindPresenceHead(ring)
		p.loginHeads[ring] = p.heads[ring]
	end
	run.presence = p
	return p
end

function Presence.Passed(p, why)
	if p.test == "passed" then return end
	p.test = "passed"
	p.testWhy = why
	p.testAt = GetTime()
end

local function PollPresence(limit)
	if not Presence.Channel() then return end
	local p = Presence.State()
	for _, ring in ipairs(Presence.RINGS) do
		for _ = 1, limit or 3 do
			local k = p.heads[ring]
			if k > PRESENCE_MAX or not Presence.Fired(PresencePath(ring, k)) then break end
			p.heads[ring] = k + 1
			p.beats = p.beats + 1
			p.lastBeat = GetTime()
			Presence.Passed(p, "a launch-time file read missing after the bridge deleted it")
			NotedBridge()
		end
	end
end

Presence.NEWS_MAX = 500
Presence.NEWS_GAP_SECONDS = 30
Presence.NEWS_SLOT_RESERVE = 50

function Presence.NewsPath(ring, k)
	return string.format("%snews\\%s\\%04d.wav", Presence.root, ring, k)
end

function Presence.News()
	if run.news then return run.news end
	local n = { heads = {}, fired = 0 }
	for _, ring in ipairs(Presence.RINGS) do n.heads[ring] = FindPresenceHead(ring, Presence.NewsPath, Presence.NEWS_MAX) end
	run.news = n
	return n
end

function Presence.PollNews(limit)
	if not Presence.Channel() then return false end
	local n = Presence.News()
	local fired = false
	for _, ring in ipairs(Presence.RINGS) do
		for _ = 1, limit or 3 do
			local k = n.heads[ring]
			if k > Presence.NEWS_MAX or not Presence.Fired(Presence.NewsPath(ring, k)) then break end
			n.heads[ring] = k + 1
			n.fired = n.fired + 1
			fired = true
		end
	end
	return fired
end

function Presence.FreeSlots()
	local free = 0
	for i = 1, SLOT_COUNT do
		if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
	end
	return free
end

function Presence.Check(info, bridgeNow)
	if type(info) ~= "table" or type(info.ring) ~= "string" or type(info.at) ~= "number" then return end
	run.bridgePresence = info
	if not Presence.Channel() then return end
	local p = Presence.State()
	PollPresence(PRESENCE_MAX)
	local head = p.heads[info.ring]
	if not head then return end
	if head <= info.at then
		if p.test ~= "passed" then
			p.test = "failed"
			p.testWhy = "presence/" .. info.ring .. string.format("/%04d.wav", head) .. " still reads present after the bridge deleted it"
			p.testAt = GetTime()
		else
			p.staleRing[info.ring] = "a file the bridge deleted still reads present"
		end
	elseif head > PRESENCE_MAX and info.at < PRESENCE_MAX then
		p.staleRing[info.ring] = "the bridge beats on files this client did not see at launch"
	elseif p.test == "passed" and type(bridgeNow) == "number" and time() - bridgeNow < 90
		and GetTime() - (p.lastBeat or p.testAt or GetTime()) > Presence.STALL_SECONDS then
		p.staleRing[info.ring] = "the bridge is up but its beats stopped reaching this client"
	end
	if type(info.probe) == "string" and run.lateProbe and info.probe == run.lateProbe.token and run.lateProbe.result == nil then
		run.lateProbe.result = SoundValid(Presence.root .. "ctl\\probe-" .. info.probe .. ".wav") and "seen" or "unseen"
	end
end

local function PresenceWorks()
	if not Presence.Channel() then return false end
	local p = run.presence
	if not p or p.test ~= "passed" then return false end
	local current = run.bridgePresence and run.bridgePresence.ring
	if current and p.staleRing[current] then return false end
	for _, ring in ipairs(Presence.RINGS) do
		if p.heads[ring] <= PRESENCE_MAX and not p.staleRing[ring] then return true end
	end
	return false
end

ClaudeWoW.PresenceWorks = PresenceWorks
ClaudeWoW.Presence = Presence

function Presence.Scheme()
	if not Presence.Channel() then return "slot polls only (sound channel unusable)" end
	local p = run.presence
	if not p then return "not started" end
	if p.test == "failed" then return "slot polls only (self-test failed: " .. tostring(p.testWhy) .. ")" end
	if p.test ~= "passed" then
		local seen = false
		for _, ring in ipairs(Presence.RINGS) do
			if p.loginHeads[ring] <= PRESENCE_MAX then seen = true end
		end
		if not seen then return "slot polls only (no presence file existed when the game started: run setup, then restart WoW)" end
		return "slot polls until the self-test passes (pending: waiting for a bridge-driven deletion)"
	end
	if PresenceWorks() then return "beats (self-test passed: " .. tostring(p.testWhy) .. ")" end
	local current = run.bridgePresence and run.bridgePresence.ring
	local why = current and p.staleRing[current]
	return "slot polls only (self-test passed, but " .. (type(why) == "string" and why or "no presence ring this client can see is left") .. ": restart WoW)"
end

function Presence.Report()
	local out = {}
	local p = run.presence
	if p and (p.test == "passed" or p.test == "failed") then table.insert(out, "pt=" .. p.test) end
	if run.lateProbe and run.lateProbe.result then table.insert(out, "lc=" .. run.lateProbe.result) end
	return table.concat(out, ";")
end

local function PresenceWindows()
	if PresenceWorks() then return 90, 300 end
	return IDLE_POLL_SECONDS + 120, IDLE_POLL_SECONDS * 2 + 120
end

-- Returns state ("ok" | "stale" | "down" | "unknown"), a color and a description.
function ClaudeWoW.BridgeState()
	local seen = run.bridgeSeen
	if not seen then
		return "unknown", 0.6, 0.6, 0.6, "Companion app: not seen yet this session"
	end
	local age = GetTime() - seen
	local okFor, staleFor = PresenceWindows()
	if age < okFor then
		return "ok", 0.2, 0.9, 0.3, "Companion app: connected (seen " .. FmtDur(age) .. " ago)"
	elseif age < staleFor then
		return "stale", 0.95, 0.8, 0.2, "Companion app: last seen " .. FmtDur(age) .. " ago"
	end
	return "down", 0.9, 0.25, 0.25, "Companion app: not seen for " .. FmtDur(age) .. ". Is it running?"
end

-- Screenshot transport: no more shots once the bridge would count as down (the
-- same window BridgeState uses: 5 minutes of silence with the presence beats,
-- 22 minutes without them), measured from the last sign of it or, before any,
-- from login. Each shot is a full-screen file only the bridge deletes, so a
-- dead bridge and a player still typing would otherwise fill the disk. A
-- Connect click (run.shotOverride) buys one shot regardless, which is how a
-- bridge that came back is found again when the presence beats can't say so.
-- `raw` ignores the override: what the bridge's silence alone says.
ShotsPaused = function(raw)
	if run.shotOverride and not raw then return false end
	local since = run.bridgeSeen or run.startedAt
	if not since then return false end
	local _, staleFor = PresenceWindows()
	return GetTime() - since >= staleFor
end

-- Same icons the friends list uses for online / away / busy / offline.
local STATE_ICON = {
	ok = "Interface\\FriendsFrame\\StatusIcon-Online",
	stale = "Interface\\FriendsFrame\\StatusIcon-Away",
	down = "Interface\\FriendsFrame\\StatusIcon-DnD",
	unknown = "Interface\\FriendsFrame\\StatusIcon-Offline",
}

function ClaudeWoW.UpdateDot()
	local state, _, _, _, tip = ClaudeWoW.BridgeState()
	if run.pixelFailed then state = "down" end
	for _, dot in pairs({ ui.dot, ui.minimapDot }) do
		dot:SetTexture(STATE_ICON[state] or STATE_ICON.unknown)
		dot.tip = tip
	end
end

-- Connected = the bridge has been seen recently. In pixel mode, sending needs this;
-- until then the Connect button takes the Send button's place. The reload
-- transport has no idea whether the bridge is there, so it never gates.
function ClaudeWoW.IsConnected()
	if not db or db.settings.mode ~= "pixel" then return true end
	return ClaudeWoW.BridgeState() == "ok" and not run.pixelFailed
end

-- Connect button: say hello to the bridge (it acks, refreshes the slots and
-- offers a restore), ignoring SayHello's throttle so a click always does something.
-- `manual` is the button itself (Send calls this too, for a message typed while
-- disconnected): a deliberate click may take one screenshot even while shots
-- are paused; the automatic path never does, or a dark bridge would still get
-- a file per message typed.
function ClaudeWoW.Connect(manual)
	if db.settings.mode ~= "pixel" then
		SafeReload()
		return
	end
	run.lastHelloAt = nil
	run.pixelFailed = nil
	run.connectFailed = nil
	run.connectingAt = GetTime()
	if manual == true and ScreenshotMode() then run.shotOverride = true end
	ClaudeWoW.SayHello()
end

-- One word for the connection state, so Tick can tell when it changed.
local function ConnectionKey()
	if ClaudeWoW.IsConnected() then return "ok" end
	if run.connectingAt or Q.LoginConnecting() then return "connecting" end
	if run.connectFailed or (run.loginChecked and not run.bridgeSeen) then return "failed" end
	return ClaudeWoW.BridgeState()
end

function Q.LoginConnecting()
	return run.startedAt ~= nil and not run.loginChecked and not run.bridgeSeen and not run.pixelFailed
end

function Q.ConnectionKey()
	return ConnectionKey()
end

-- Called every tick: time out a Connect attempt, and redraw when the state flips
-- (light, button, status line, placeholder) without redrawing every tick.
function ClaudeWoW.CheckConnection()
	if run.connectingAt then
		if ClaudeWoW.IsConnected() then
			run.connectingAt, run.connectFailed = nil, nil
			-- A message typed while disconnected goes out now, without a second click,
			-- as long as the same chat is still in front and free.
			local queued = run.sendOnConnect
			run.sendOnConnect = nil
			local c = queued and ActiveChat()
			if c and c.id == queued.chat and not c.pendingId then
				if ui.input and Trim(ui.input:GetText() or "") == queued.text then ui.input:SetText("") end
				ClaudeWoW.Send(queued.text, queued.allow, queued.opts)
			end
		elseif GetTime() - run.connectingAt > CONNECT_WAIT then
			run.connectingAt, run.connectFailed = nil, true
			run.sendOnConnect = nil -- the text is still in the box
			run.shotOverride = nil -- an unused click does not carry over to a later shot
		end
	elseif run.connectFailed and ClaudeWoW.IsConnected() then
		run.connectFailed = nil
	end
	local key = ConnectionKey()
	if key ~= run.connKey then
		run.connKey = key
		ClaudeWoW.Render()
	end
end

-- Swap Send and Connect depending on the state; part of UpdateStatus.
function ClaudeWoW.UpdateConnect()
	if not ui.connect or not ui.send then return end
	local connected = ClaudeWoW.IsConnected()
	local c = ActiveChat()
	local busy = connected and c ~= nil and c.pendingId ~= nil
	ui.send:SetShown(connected)
	ui.send:SetEnabled(not busy)
	if ui.effort then ui.effort:SetShown(connected) end
	if ui.stop then ui.stop:SetShown(busy) end
	ui.connect:SetShown(not connected)
	if connected then return end
	if run.connectingAt then
		ui.connect:SetText("Connecting...")
		ui.connect:Disable()
	else
		ui.connect:SetText(ClaudeWoW.BridgeState() == "stale" and "Reconnect" or "Connect")
		ui.connect:Enable()
	end
end

-- Prove the sound-file trick actually distinguishes empty from valid files on this
-- client before trusting it for presence, heartbeats and readiness signals.
local function SelfTestSignals()
	if not signalAvailable then
		signalStats.selftest = "PlaySoundFile missing"
		return
	end
	Presence.root = Presence.ROOT
	local missingLooksValid = SoundValid(Presence.ROOT .. "ctl\\absent.wav")
	local validLooksValid = SoundValid(Presence.ROOT .. "ctl\\valid.wav")
	if not missingLooksValid and not validLooksValid and SoundValid(Presence.LEGACY_ROOT .. "ctl\\valid.wav") then
		Presence.root = Presence.LEGACY_ROOT
		validLooksValid = true
	end
	if missingLooksValid then
		signalAvailable = false
		signalStats.selftest = "a missing file reports as playable"
	elseif not validLooksValid then
		signalAvailable = false
		signalStats.selftest = "a valid file reports as unplayable (files not indexed? restart WoW)"
	else
		signalStats.selftest = "passed"
		Presence.State()
	end
end

function Cli.WorkCount(chat)
	local steps = run.steps and run.steps[chat.id] or 0
	if steps > 0 then return steps .. (steps == 1 and " step" or " steps") end
	local a = run.act and run.act[chat.id]
	if a and not a.unreliable and a.count > 0 then return a.count .. (a.count == 1 and " action" or " actions") end
	return nil
end

local function ActivityLine(chat)
	local a = run.act and run.act[chat.id]
	local now = GetTime()
	local started = (a and a.startedAt) or run.sentAt or now
	local parts = { FmtDur(now - started) }
	local count = Cli.WorkCount(chat)
	if count then table.insert(parts, count) end
	local s = table.concat(parts, " " .. SEG.DOT .. " ")
	if a and not a.unreliable and a.last then
		local quiet = now - a.last
		if quiet > 120 then s = s .. " " .. SEG.DOT .. " quiet for " .. FmtDur(quiet) .. ", stuck? /claude cancel" end
	elseif not count and now - started > 60 then
		s = s .. " " .. SEG.DOT .. " no activity seen yet"
	end
	return s
end

Cli.STEPS_SHOWN = 6

function Cli.StepLines(chat)
	local lines = {}
	for line in tostring(chat.progress or ""):gmatch("[^\n]+") do
		line = Trim(line)
		if line ~= "" then table.insert(lines, line) end
	end
	local total = (run.steps and run.steps[chat.id]) or #lines
	local first = math.max(1, #lines - Cli.STEPS_SHOWN + 1)
	local out = {}
	local hidden = math.max(0, total - (#lines - first + 1))
	if hidden > 0 then table.insert(out, "+" .. hidden .. " earlier") end
	for i = first, #lines do table.insert(out, SEG.DOT .. " " .. lines[i]) end
	return out, lines[#lines]
end

local function FreeSlot()
	for i = 1, SLOT_COUNT do
		local name = SlotName(i)
		if not C_AddOns.IsAddOnLoaded(name) then
			return name
		end
	end
end

local function ScheduleNextPoll()
	local idx = (run.polls or 0) + 1
	local t = POLL_SCHEDULE[idx]
	if not t then
		t = POLL_SCHEDULE[#POLL_SCHEDULE] + POLL_TAIL * (idx - #POLL_SCHEDULE)
	end
	run.nextPollAt = (run.sentAt or GetTime()) + t
end

local Finish -- defined below

---------------------------------------------------------------------------
-- Context growth
---------------------------------------------------------------------------
--
-- Every message resumes the chat's agent session, so the context the model
-- reads grows with every turn and each message costs more than the last
-- (measured: 107k tokens after 8 turns, 312k after 213). The bridge reports,
-- on every final reply, what the next message will carry (ctx), how many turns
-- the session has had, and the model's window when its CLI names it. The
-- footer shows it, /claude-wow context reports it, and past the threshold the
-- chat says so once and offers a new chat.

local function NoteUsage(c, r)
	if type(r.turns) == "number" then c.turns = r.turns end
	if type(r.ctx) == "number" and r.ctx > 0 then
		c.ctx = r.ctx
	elseif type(r.turns) == "number" and r.turns <= 1 then
		c.ctx = nil -- a fresh session with an agent that reports nothing
	end
	if type(r.window) == "number" and r.window > 0 then c.window = r.window end
	-- When the session started (its clock), and what it would have cost at API
	-- prices so far; a fresh session starts both over.
	if type(r.since) == "number" and r.since > 0 then c.since = r.since end
	if type(r.cost) == "number" then c.cost = r.cost
	elseif type(r.turns) == "number" and r.turns <= 1 then c.cost = nil end
end

-- The footer segment, shaped like Claude Code's status line:
-- "11m 58s · ↓ 186.7k tokens · ≈$2.41 API". Elapsed since the chat's current
-- agent session started; the tokens its next message carries; the session's
-- runs at API list prices ("API": a comparison, a subscription is not billed
-- by the token). Each part only when known; "" when none is.
local function ContextSegment(c, long)
	if not c then return "" end
	local parts = {}
	if c.since then table.insert(parts, FmtElapsed(time() - c.since)) end
	if c.ctx then
		table.insert(parts, SEG.DOWN .. " " .. FmtTokens(c.ctx) .. " tokens" .. ((long and c.window) and (" of " .. FmtTokens(c.window)) or ""))
	end
	if c.cost then table.insert(parts, SEG.APPROX .. string.format("$%.2f API", c.cost)) end
	return table.concat(parts, " " .. SEG.DOT .. " ")
end

-- "8 turns" for diag and the context report.
local function TurnsLabel(c)
	if not c or not c.turns then return "" end
	return c.turns .. (c.turns == 1 and " turn" or " turns")
end

local function ContextThresholdLabel()
	local limit = tonumber(db.settings.contextWarn) or 0
	if limit > 0 then return "warning at " .. FmtTokens(limit) .. " tokens (/claude config context <n> to change, 0 = off)" end
	return "warning off (/claude config context <n> turns it on)"
end

-- What /claude-wow context prints for the current chat.
local function ContextReport(c)
	local size
	if c and c.ctx then
		size = "Context: " .. FmtTokens(c.ctx) .. " tokens" .. (c.window and (" of " .. FmtTokens(c.window)) or "") .. " after " .. (c.turns or "?") .. " turn" .. ((c.turns or 0) == 1 and "" or "s") .. ": that is what your next message here re-reads before it starts on your question."
	elseif c and c.turns then
		size = "Context: " .. c.turns .. " turn" .. (c.turns == 1 and "" or "s") .. " in this session; " .. ChatAgentName(c) .. " does not report its context size."
	else
		size = "Context: nothing yet - no reply in this session."
	end
	if c and c.since then
		size = size .. "\nSession: " .. FmtElapsed(time() - c.since) .. " since it started"
			.. (c.cost and string.format("; %s$%.2f at API list prices so far (a comparison, not a bill: a subscription is not charged per token)", SEG.APPROX, c.cost) or "") .. "."
	end
	return size .. "\n" .. ContextThresholdLabel():gsub("^%l", string.upper) .. "."
end

-- Past the threshold: say so once per crossing (a fresh session brings the
-- number back down, which re-arms it), with a New chat button on the message.
local function ContextWarning(c)
	local limit = tonumber(db.settings.contextWarn) or 0
	if limit <= 0 or not c.ctx or c.ctx < limit then
		c.ctxWarned = nil
		return
	end
	if c.ctxWarned then return end
	c.ctxWarned = true
	local size = FmtTokens(c.ctx) .. " tokens"
	local text = "This chat's context is " .. size .. (c.window and (" of " .. FmtTokens(c.window)) or "") .. " after " .. (c.turns or "?") .. " turn" .. ((c.turns or 0) == 1 and "" or "s") .. ", past the " .. FmtTokens(limit) .. " mark: every message re-reads all of it, so replies cost more and start slower.\n"
		.. "New chat starts " .. ChatAgentName(c) .. " fresh; this transcript stays here.\n"
		.. "/claude config context <n> moves the mark, 0 turns it off."
	AddHistory(c, "system", text)
	c.history[#c.history].newChat = true
	-- Where the reply itself went: the whisper tab if the chat has one, else the game chat.
	if not Whisper.Reply(c, text, nil, "system") then
		print(ClaudeWoW.PREFIX .. Display(c.name) .. ": " .. (text:gsub("\n", " ")) .. " Type /claude new for a new chat.")
	end
end

Q.RUN_LIMIT_DEFAULT = 30 * 60
Q.RUN_LIMIT_MIN = 60
Q.RUN_LIMIT_MAX = 7 * 86400
Q.PENDING_MARGIN = 5 * 60
Q.PENDING_LOGIN_GRACE = 120

function Q.QuietLimit()
	return (run.runLimit or Q.RUN_LIMIT_DEFAULT) + Q.PENDING_MARGIN
end

function Q.NoteLife(c, at)
	if not c or not c.pendingId then return end
	local now = time()
	at = math.min(tonumber(at) or now, now)
	if not c.lifeAt or at > c.lifeAt then c.lifeAt = at end
end

function Q.LastLife(c)
	if type(c.lifeAt) == "number" then return c.lifeAt end
	local at = time()
	for i = #c.history, 1, -1 do
		local m = c.history[i]
		if m.id == c.pendingId and m.role == "user" then
			at = tonumber(m.t) or at
			break
		end
	end
	c.lifeAt = at
	return at
end

function Q.ApplyRuns(data)
	if type(data) ~= "table" then return end
	local limit = data.runLimit
	if type(limit) == "number" and limit == math.floor(limit) and limit >= Q.RUN_LIMIT_MIN and limit <= Q.RUN_LIMIT_MAX then run.runLimit = limit end
	if type(data.now) ~= "number" or time() - data.now > Q.INBOX_FRESH_SECONDS or type(data.alive) ~= "table" then return end
	for _, a in ipairs(data.alive) do
		local since = type(a) == "table" and type(a.since) == "number" and a.since or nil
		if since and since <= data.now and a.session == db.session then
			for _, c in ipairs(db.chats) do
				if c.pendingId == a.id then
					Q.NoteLife(c, since > 0 and since or data.now)
					Q.NoteRequestAcked(c.id, a.id)
				end
			end
		end
	end
end

-- The bridge has read this record: whatever game context rode on it is now
-- what the bridge knows, so later messages only carry it again if it changes.
function Q.NoteRequestSent(chatId, id)
	run.requests = run.requests or {}
	run.requests[chatId] = { id = id, sentAt = GetTime() }
end

function Q.NoteRequestAcked(chatId, id)
	local r = run.requests and run.requests[chatId]
	if r and r.id == id then r.acked = true end
end

function Q.NoteAckedId(id)
	for _, c in ipairs(db.chats) do
		if c.pendingId == id then
			local r = run.requests and run.requests[c.id]
			if r and r.id == id and not r.acked then
				r.acked = true
				return true
			end
			return false
		end
	end
	return false
end

function Q.RestoreRequests()
	for _, c in ipairs(db.chats) do
		if c.pendingId then Q.NoteRequestSent(c.id, c.pendingId) end
	end
end

function Q.PendingRequest(c)
	local r = run.requests and run.requests[c.id]
	if r and r.id == c.pendingId then return r end
	return nil
end

local function NoteAcked(rec)
	rec.acked = true
	if rec.request then Q.NoteRequestAcked(rec.chat, rec.request) end
	ClaudeWoW.ChatLog.Acked(rec)
	if rec.ctx ~= nil then run.contextSent = rec.ctx end
	if not (rec.hello or rec.forget or rec.cancelOf or rec.dm or rec.openUrl) then Q.NoteLife((FindChat(rec.chat))) end
end

local function MarkAcked(id)
	local rec = run.outbound[id]
	if rec and not rec.acked then
		NoteAcked(rec)
		RefreshStrip()
	end
	NotedBridge()
end

function ClaudeWoW.ApplyAcks(acks)
	if type(acks) ~= "table" or not db then return false end
	local any = false
	for _, a in ipairs(acks) do
		local ours = type(a) == "table" and a.session == db.session
		local rec = ours and run.outbound[a.id]
		if rec and not rec.acked then
			NoteAcked(rec)
			any = true
		end
		if ours and Q.NoteAckedId(a.id) then any = true end
	end
	if any then NotedBridge() end
	return any
end

Q.LATE_SHOWN_MAX = 8
Q.LATE_IN_MAX = 3600

function Q.LateKey(r)
	local seq = r.lateSeq
	if type(seq) == "number" and seq > 0 and seq == math.floor(seq) then return seq end
	return tonumber(r.id) or 0
end

function Q.LateShown(c, key)
	if c.lateSeen ~= nil then
		c.lateShown = { tonumber(c.lateSeen) or 0 }
		c.lateSeen = nil
	end
	for _, k in ipairs(c.lateShown or {}) do
		if k == key then return true end
	end
	return false
end

function Q.NoteLateShown(c, key)
	c.lateShown = c.lateShown or {}
	table.insert(c.lateShown, key)
	while #c.lateShown > Q.LATE_SHOWN_MAX do table.remove(c.lateShown, 1) end
end

function Q.LateIn(v)
	if type(v) == "number" and v >= 0 and v <= Q.LATE_IN_MAX and v == math.floor(v) then return v end
	return 0
end

function Q.ArmLateWait(c, id, after, prompt)
	run.lateWait = run.lateWait or {}
	run.lateWait[c.id] = { id = id, since = GetTime() + after, step = 1, prompt = prompt or nil }
end

function Q.EndPromptWait(c)
	local w = run.lateWait and run.lateWait[c.id]
	if w and w.prompt then run.lateWait[c.id] = nil end
end

function Cli.KeepPlayerRoute(c)
	c.adoptBind, c.adoptCwd = nil, nil
end

function Cli.BindAdoptedPlugin(c, plugin)
	if not c.adoptBind then return false end
	if type(plugin) ~= "string" or #plugin > 32 or not plugin:match("^[%w_-]+$") then return false end
	if plugin == "claude-code" or plugin == LIVE_PLUGIN then return false end
	if (c.plugin or "") ~= "" then return false end
	c.plugin = plugin
	c.cwd = ""
	return true
end

-- Dispatch a list of reply records to the chats waiting for them.
local function ApplyReplies(replies)
	local matched = false
	for _, r in ipairs(replies or {}) do
		local c = (r.token == nil or r.token == db.session) and FindChat(r.chat) or nil
		if c and c.titleFor and (tonumber(r.titleFor) or r.id) == c.titleFor and type(r.title) == "string" and r.title ~= "" then
			c.name = r.title
			c.titleFor = nil
			Whisper.Retitle(c)
		end
		if c and r.late == true then
			if r.status == "done" and r.id ~= c.pendingId and not Q.LateShown(c, Q.LateKey(r)) then
				Q.NoteLateShown(c, Q.LateKey(r))
				ClaudeWoW.LateReply(c, r)
				Q.OfferDraft(c)
			end
		elseif c and c.pendingId and r.id == c.pendingId then
			matched = true
			MarkAcked(r.id)
			local denied = type(r.denied) == "table" and #r.denied > 0 and r.denied or nil
			if (r.status == "done" or r.status == "error") and r.plugin ~= Cli.DEV_PLUGIN then
				NoteUsage(c, r)
				local bound = Cli.BindAdoptedPlugin(c, r.plugin)
				if not bound and c.adoptCwd and type(r.cwd) == "string" and r.cwd ~= "" then c.cwd = r.cwd end
				if type(r.session) == "string" and r.session ~= "" then c.session = r.session end
				Cli.KeepPlayerRoute(c)
				c.resumeId = nil
			end
			if r.status == "done" then
				if r.lateOk == true then Q.ArmLateWait(c, r.id, Q.LateIn(r.lateIn), true) end
				Finish(c, "assistant", r.text or "", denied, r.agent, r.summary, ClaudeWoW.CleanMacros(r.macros))
			elseif r.status == "error" then
				if r.lateOk == true then Q.ArmLateWait(c, r.id, 0) end
				Finish(c, "system", "The companion app could not finish: " .. tostring(r.text), denied)
			elseif r.status == "working" then
				if ClaudeWoWVoice then ClaudeWoWVoice.Started(r.id) end
				if c.progress ~= r.text then Q.NoteLife(c) end
				c.progress = r.text
				run.steps = run.steps or {}
				run.steps[c.id] = tonumber(r.steps)
				Whisper.Progress(c, r.text)
			end
		elseif c and c.gaveUp and r.id == c.gaveUp and (r.status == "done" or r.status == "error") then
			c.gaveUp = nil
			if run.staleSig then run.staleSig[r.id] = nil end
			if r.status == "done" then
				ClaudeWoW.LateReply(c, r)
				Q.OfferDraft(c)
			end
		end
	end
	return matched
end

-- The bridge keeps every chat's transcript. After the client wipes our saved data,
-- it sends them back once, addressed to our new session token.
local function ImportRestore(r)
	if type(r) ~= "table" or r.token ~= db.session or ClaudeWoWCharDB.restored then return end
	if type(r.char) == "string" and r.char ~= "" and r.char ~= Q.CharacterKey() then return end
	ClaudeWoWCharDB.restored = true
	local added = 0
	local current = ActiveChat()
	for _, rc in ipairs(r.chats or {}) do
		-- Skip chats deleted here that the bridge hasn't been told about yet.
		if type(rc) == "table" and rc.id and not FindChat(rc.id) and not db.forget[rc.id] then
			local chat = {
				id = rc.id,
				name = (rc.name and rc.name ~= "") and rc.name or ("Chat " .. (#db.chats + 1)),
				cwd = rc.cwd or DEFAULT_CWD,
				agent = "",
				plugin = type(rc.plugin) == "string" and rc.plugin or "",
				ctx = type(rc.ctx) == "number" and rc.ctx > 0 and rc.ctx or nil,
				turns = type(rc.turns) == "number" and rc.turns > 0 and rc.turns or nil,
				since = type(rc.since) == "number" and rc.since > 0 and rc.since or nil,
				cost = type(rc.cost) == "number" and rc.cost or nil,
				history = {},
				unread = 0,
				created = time(),
			}
			for _, m in ipairs(rc.messages or {}) do
				local role, agent = m.role, m.agent
				if role == "claude" then role, agent = "assistant", agent or "claude" end -- an older bridge's transcript
				if agent == "" then agent = nil end
				table.insert(chat.history, { role = role, text = m.text, id = m.id, t = m.t, agent = agent })
			end
			-- Keep the chat we're currently using last so it stays where it was.
			table.insert(db.chats, math.max(1, #db.chats), chat)
			added = added + 1
		end
	end
	run.restoring = nil
	if added > 0 then
		if current and #current.history <= 2 then
			for _, ch in ipairs(db.chats) do
				if ch ~= current and ch.name == current.name then current.name = "New chat" end
			end
		end
		Q.AddEvent(current, "Restored " .. added .. " chat(s)")
		AddHistory(current, "system", "The game reset its saved data, so these came back from the companion app.")
		ClaudeWoW.RenderChatList()
	end
end

ClaudeWoW.Version = { PROTO = 1, SEMVER = "0.5.0-beta.1", PATTERN = "^%d+%.%d+%.%d+[%w%.%-+]*$" }

function ClaudeWoW.Version.Meta(key)
	local read = C_AddOns and C_AddOns.GetAddOnMetadata
	if type(read) ~= "function" then return "" end
	local ok, v = pcall(read, "ClaudeWoW", key)
	return ok and type(v) == "string" and v or ""
end

function ClaudeWoW.Version.Own()
	local V = ClaudeWoW.Version
	local v = V.Meta("Version")
	if #v <= 40 and v:match(V.PATTERN) then return v end
	return V.SEMVER
end

ClaudeWoW.Version.LOADED = { version = ClaudeWoW.Version.Meta("Version"), build = ClaudeWoW.Version.Meta("X-Build"), at = time() }

function ClaudeWoW.Version.ApplyDisk(d, stamp)
	local V = ClaudeWoW.Version
	if type(d) ~= "table" then return end
	local at = tonumber(stamp)
	if not at or time() - at > Q.INBOX_FRESH_SECONDS then return end
	V.CheckFolders()
	if at < V.LOADED.at then return end
	if type(d.version) ~= "string" or #d.version > 40 or not d.version:match(V.PATTERN) then return end
	local build = type(d.build) == "string" and #d.build == 12 and d.build:match("^[0-9a-f]+$") and d.build or ""
	run.addonDisk = { version = d.version, build = build }
	local L = V.LOADED
	if L.version == "" or (d.version == L.version and build == L.build) then
		if run.updateReady then
			run.updateReady, run.reloadTold = nil, nil
			Q.UpdateNoticeBar()
		end
		return
	end
	local text = "New addon files are installed (" .. d.version .. (build ~= "" and (", build " .. build) or "") .. "). Type /reload to load them."
	if run.reloadTold ~= text then
		run.reloadTold = text
		run.updateReady = { version = d.version, build = build, sameVersion = d.version == L.version }
		Q.Notify(text)
		Q.UpdateNoticeBar()
	end
end

function ClaudeWoW.Version.Notice()
	local u = run.updateReady
	if not u then return nil end
	return "Addon update ready " .. SEG.DOT .. " " .. u.version .. ((u.sameVersion and u.build ~= "") and (" build " .. u.build) or "")
end

ClaudeWoW.Version.CLIENTS_MAX = 8

function ClaudeWoW.Version.ApplyClients(list, stamp)
	local V = ClaudeWoW.Version
	if type(list) ~= "table" then return end
	local at = tonumber(stamp)
	if not at or time() - at > Q.INBOX_FRESH_SECONDS then return end
	local out = {}
	for i = 1, math.min(#list, V.CLIENTS_MAX) do
		local c = list[i]
		if type(c) == "table" and type(c.name) == "string" and #c.name <= 40 and c.name:match("^[%w_ %.%-]+$") then
			local heard = tonumber(c.heard)
			table.insert(out, {
				name = c.name,
				version = type(c.version) == "string" and #c.version <= 40 and c.version:match(V.PATTERN) and c.version or "",
				build = type(c.build) == "string" and #c.build == 12 and c.build:match("^[0-9a-f]+$") and c.build or "",
				heard = heard and heard > 0 and heard == math.floor(heard) and heard or 0,
				here = c.here == true,
				last = c.last == true,
			})
		end
	end
	run.bridgeClients = out
end

function ClaudeWoW.Version.ClientsStatus()
	local list = run.bridgeClients
	if not list then return "clients: not reported (an older bridge, or not heard yet)" end
	if #list == 0 then return "clients: none in the bridge's config.json" end
	local parts = {}
	for _, c in ipairs(list) do
		local files = c.version ~= "" and (c.version .. (c.build ~= "" and (" build " .. c.build) or "")) or "no addon installed"
		local heard = c.heard > 0 and ("heard " .. FmtDur(math.max(0, time() - c.heard)) .. " ago") or "not heard yet"
		table.insert(parts, c.name .. (c.here and " (this client)" or "") .. ": " .. files .. ", " .. heard .. (c.last and ", spoke last" or ""))
	end
	return "clients: " .. table.concat(parts, "; ")
end

function ClaudeWoW.Version.CheckFolders()
	local info = C_AddOns and C_AddOns.GetAddOnInfo
	if run.restartTold or type(info) ~= "function" then return end
	local ok, _, _, _, _, reason = pcall(info, "ClaudeWoW_Runtime")
	if ok and reason == "MISSING" then
		run.restartTold = true
		TellPlayer("The ClaudeWoW_Runtime addon was installed after the game started. Fully quit and restart the game to load it; /reload is not enough.")
	end
end

function ClaudeWoW.Version.Compare(a, b)
	local a1, a2, a3 = tostring(a):match("^(%d+)%.(%d+)%.(%d+)")
	local b1, b2, b3 = tostring(b):match("^(%d+)%.(%d+)%.(%d+)")
	if not a1 or not b1 then return nil end
	local x = { tonumber(a1), tonumber(a2), tonumber(a3) }
	local y = { tonumber(b1), tonumber(b2), tonumber(b3) }
	for i = 1, 3 do
		if x[i] ~= y[i] then return x[i] < y[i] and -1 or 1 end
	end
	return 0
end

function ClaudeWoW.Version.Verdict(b)
	local V = ClaudeWoW.Version
	local version = V.Own()
	local range = b.protoMin == b.protoMax and tostring(b.protoMin) or (b.protoMin .. " to " .. b.protoMax)
	local mine = version .. ", protocol " .. V.PROTO
	local theirs = b.version .. ", protocol " .. range
	if V.PROTO < b.protoMin then
		return "update-addon", "This addon (" .. mine .. ") is too old for the companion app (" .. theirs .. "). The companion app refuses messages until you update the addon: update the addon in the CurseForge app or run claude-wow setup, then type /reload."
	end
	if V.PROTO > b.protoMax then
		return "update-bridge", "The companion app (" .. theirs .. ") is too old for this addon (" .. mine .. "). It refuses messages until you update it: run brew upgrade claude-wow or the installer again, then claude-wow service restart."
	end
	if version == b.version then return "equal", "" end
	local order = V.Compare(version, b.version)
	if order == -1 then
		return "addon-older", "This addon (" .. version .. ") is older than the companion app (" .. b.version .. "). They still work together; update the addon when you can."
	end
	if order == 1 then
		return "bridge-older", "The companion app (" .. b.version .. ") is older than this addon (" .. version .. "). They still work together; update the companion app when you can."
	end
	return "differs", "This addon (" .. version .. ") and the companion app (" .. b.version .. ") are different builds. They still work together."
end

function ClaudeWoW.Version.Apply(b, stamp)
	local V = ClaudeWoW.Version
	if type(b) ~= "table" then return end
	local at = tonumber(stamp)
	if not at or time() - at > Q.INBOX_FRESH_SECONDS then return end
	local lo, hi = tonumber(b.protoMin), tonumber(b.protoMax)
	if type(b.version) ~= "string" or #b.version > 40 or not b.version:match(V.PATTERN) then return end
	if not lo or not hi or lo ~= math.floor(lo) or hi ~= math.floor(hi) or lo < 1 or hi < lo then return end
	run.bridgeVersion = { version = b.version, protoMin = lo, protoMax = hi }
	local verdict, text = V.Verdict(run.bridgeVersion)
	run.versionVerdict = verdict
	if text ~= "" and run.versionTold ~= text then
		run.versionTold = text
		TellPlayer(text)
	end
end

function ClaudeWoW.Version.Status()
	local V = ClaudeWoW.Version
	local b = run.bridgeVersion
	local bridge = b and (b.version .. " (protocol " .. (b.protoMin == b.protoMax and b.protoMin or (b.protoMin .. " to " .. b.protoMax)) .. ")") or "not reported (an older bridge, or not heard yet)"
	local function files(f) return f.version ~= "" and (f.version .. (f.build ~= "" and (" build " .. f.build) or "")) or "unknown" end
	return "versions: addon " .. V.Own() .. " (protocol " .. V.PROTO .. "), bridge " .. bridge .. ", verdict: " .. (run.versionVerdict or "unknown")
		.. "; addon files loaded: " .. files(V.LOADED) .. ", on disk: " .. (run.addonDisk and files(run.addonDisk) or "not reported")
end

local function TryLoadSlot(why)
	local name = FreeSlot()
	if not name then
		run.slotsExhausted = true
		ClaudeWoW.ArmAutoRefresh()
		ClaudeWoW.UpdateStatus()
		return
	end
	ClaudeWoW_SlotData = nil
	local loaded, reason = C_AddOns.LoadAddOn(name)
	if not loaded then
		run.slotError = reason
		run.slotsMissing = true
		ClaudeWoW.ArmAutoRefresh()
		if reason ~= "MISSING" and reason ~= "DISABLED" and not run.slotErrorTold then
			run.slotErrorTold = true
			local build = select(4, GetBuildInfo())
			local fix = reason == "INTERFACE_VERSION"
				and ("the slot addons were made for another game version (this client is " .. tostring(build) .. "). Set tocInterface to " .. tostring(build) .. " in the companion app's config.json, run \"npm run slots\", then restart WoW.")
				or "run \"npm run slots\" on the computer that runs the companion app, then restart WoW."
			TellPlayer("reply slots do not load (" .. tostring(reason) .. "): " .. fix .. " Until then replies arrive on /reload.")
		end
		ClaudeWoW.UpdateStatus()
		return
	end
	run.polls = (run.polls or 0) + 1
	ScheduleNextPoll()
	local data = ClaudeWoW_SlotData
	if type(data) == "table" and type(data.now) == "number" then
		-- The bridge's clock and ours are the same machine; translate to GetTime().
		NotedBridge(GetTime() - (time() - data.now))
	end
	if type(data) == "table" and type(data.cwd) == "string" and data.cwd ~= "" then run.bridgeCwd = data.cwd end
	if type(data) == "table" then
		if data.cancel == true then run.bridgeCancel = true end
		run.bridgeOpenUrl = data.openUrl == true
		if type(data.agent) == "string" and data.agent ~= "" then run.bridgeAgent = data.agent end
		if type(data.agents) == "table" and #data.agents > 0 then run.bridgeAgents = data.agents end
		if type(data.plugin) == "string" and data.plugin ~= "" then run.bridgePlugin = data.plugin end
		if type(data.plugins) == "table" and #data.plugins > 0 then run.bridgePlugins = data.plugins end
		ClaudeWoW.ApplyEfforts(data)
		ClaudeWoW.ApplyLive(data.live)
		ClaudeWoW.ApplySessions(data.sessions, data.now)
		ClaudeWoW.ApplyProjects(data.projects, data.home)
		ClaudeWoW.ApplySkills(data.skills)
		run.bridgeDiscord = data.discord == true
		ClaudeWoW.ApplyMirror(data.mirror)
		ClaudeWoW.ApplyMcp(data.mcp)
		ClaudeWoW.ApplyContract(data.contract)
		local acked = ClaudeWoW.ApplyAcks(data.acks)
		Q.ApplyOpenResults(data.acks)
		ApplyTransport(data)
		if acked then RefreshStrip() end
		Presence.Check(data.presence, data.now)
		ClaudeWoW.Version.Apply(data.bridge, data.now)
		ClaudeWoW.Version.ApplyDisk(data.addonDisk, data.now)
		ClaudeWoW.Version.ApplyClients(data.clients, data.now)
		Q.ApplyRuns(data)
	end
	local matched = ApplyReplies(type(data) == "table" and data.replies or nil)
	if type(data) == "table" and data.restore then ImportRestore(data.restore) end
	if type(data) == "table" and data.map and ClaudeWoWMap then ClaudeWoWMap.Sync(data.map) end
	if type(data) == "table" and data.achievements and ClaudeWoWAchievements then ClaudeWoWAchievements.Sync(data.achievements, data.now) end
	if type(data) == "table" and data.goals and ClaudeWoWOrders then ClaudeWoWOrders.SyncSlot(data.goals, data.now) end
	if type(data) == "table" and type(data.dm) == "table" then
		run.bridgeDm = true
		if ClaudeWoWDM then ClaudeWoWDM.SyncSlot(data.dm) end
	end
	if type(data) == "table" and data.widgets and ClaudeWoWWidgets then ClaudeWoWWidgets.Sync(data.widgets) end
	if type(data) == "table" and ClaudeWoWTelemetry then ClaudeWoWTelemetry.Sync(data.gs) end
	if why == "signal" and not matched then
		run.signalUnreliable = true
	end
	ClaudeWoW.Render()
end

local LATE_POLLS = { 10, 20, 30, 45, 60, 90, 120, 180, 240, 300 }

local function PollLate(now)
	for chatId, w in pairs(run.lateWait or {}) do
		local due = LATE_POLLS[w.step]
		if not due or not FindChat(chatId) then
			run.lateWait[chatId] = nil
		elseif now - w.since >= due then
			w.step = w.step + 1
			TryLoadSlot("late")
			return
		end
	end
end

function Q.GiveUp(c)
	local id = c.pendingId
	Whisper.StopProgress(c)
	run.outbound[id] = nil
	if run.act then run.act[c.id] = nil end
	c.pendingId, c.progress, c.lifeAt = nil, nil, nil
	RefreshStrip()
	if not AnyPending() then ClaudeWoW.DisarmReload() end
	if c.quiet then return ClaudeWoW.Render() end
	c.gaveUp = id
	Cli.Out(c, "No reply arrived and nothing was heard about it for " .. math.floor(Q.QuietLimit() / 60)
		.. " minutes, so this chat is free again. If the reply comes later it still shows here. Send the message again, or ask for the last answer.")
	Q.OfferDraft(c)
end

function Q.NoteLogin(isInitialLogin)
	if isInitialLogin == true then db.graceUntil = time() + Q.PENDING_LOGIN_GRACE end
end

function Q.GiveUpSilent()
	local now = time()
	if now < (tonumber(db.graceUntil) or 0) then return end
	local limit = Q.QuietLimit()
	for _, c in ipairs(db.chats) do
		if c.pendingId and now - Q.LastLife(c) > limit then Q.GiveUp(c) end
	end
end

function Q.LateSignal()
	for _, c in ipairs(db.chats) do
		local id = c.gaveUp
		if id and run.staleSig and run.staleSig[id] and not CheckSignal("sig", id) then run.staleSig[id] = nil end
		if id and FreshSignal("sig", id) then
			run.staleSig = run.staleSig or {}
			run.staleSig[id] = true
			TryLoadSlot("late")
			return true
		end
	end
	return false
end

local function Tick()
	if not db then return end
	local now = GetTime()
	PollPresence()
	Q.GiveUpSilent()
	-- Without presence beats, the only evidence is a slot read; spend one every
	-- IDLE_POLL_SECONDS while idle so the light still reflects reality (and stays
	-- green while the bridge is up: BridgeState allows for this interval).
	if not PresenceWorks() and db.settings.mode == "pixel" and not AnyPending()
		and now - (run.lastIdlePoll or -1e9) >= IDLE_POLL_SECONDS then
		run.lastIdlePoll = now
		TryLoadSlot("idle")
	elseif PresenceWorks() and db.settings.mode == "pixel" and not AnyPending()
		and now - (run.presence.lastBeat or run.presence.testAt or now) > Presence.STALL_SECONDS
		and now - (run.lastPresenceCheck or -1e9) >= IDLE_POLL_SECONDS then
		run.lastPresenceCheck = now
		TryLoadSlot("presence")
	end
	ClaudeWoW.UpdateDot()
	ClaudeWoW.CheckConnection()
	-- The footer's elapsed time ticks while the window is open (a pending chat
	-- refreshes it below anyway).
	if ui.frame and ui.frame:IsShown() and not AnyPending() then
		local c = ActiveChat()
		if c and c.since then ClaudeWoW.UpdateStatus() end
	end
	if run.shotsPaused and not ShotsPaused(true) then
		-- Heard from the bridge again (a beat, an ack, a slot): shoot what waited.
		run.shotsPaused = nil
		TellPlayer("Companion app is back: screenshots resume")
		RefreshStrip()
	end
	if db.settings.mode ~= "pixel" then return end
	local changed = false
	if Presence.PollNews(Presence.NEWS_MAX) and not run.newsPollAt then
		run.newsPollAt = math.max(now + 1, (run.lastNewsLoad or -1e9) + Presence.NEWS_GAP_SECONDS)
	end
	if run.newsPollAt and now >= run.newsPollAt then
		run.newsPollAt = nil
		if Presence.FreeSlots() > Presence.NEWS_SLOT_RESERVE then
			run.lastNewsLoad = now
			TryLoadSlot("news")
		end
	end
	if run.helloPollAt and now >= run.helloPollAt then
		run.helloPollAt = nil
		TryLoadSlot("hello")
		-- Whatever that slot held, the wait is over.
		if run.restoring then
			run.restoring = nil
			ClaudeWoW.Render()
		end
	end
	if run.ackPollAt and now >= run.ackPollAt then
		run.ackPollAt = nil
		if not ClaudeWoW.PresenceWorks() then TryLoadSlot("ack") end
	end
	if run.dmPollAt and now >= run.dmPollAt then
		run.dmPollAt = nil
		TryLoadSlot("dm")
	end
	Q.TickOpen(now)
	if run.restoring and now - run.restoring > 25 then
		run.restoring = nil
		ClaudeWoW.Render()
	end
	for id, rec in pairs(run.outbound) do
		if rec.staleAck and not CheckSignal("ack", id) then rec.staleAck = nil end
		if not rec.acked and not rec.staleAck and CheckSignal("ack", id) then
			NoteAcked(rec)
			changed = true
			NotedBridge()
			if (rec.text or "") ~= "" and not rec.openUrl and ClaudeWoWVoice then ClaudeWoWVoice.Started(id) end
			if rec.hello and run.lateProbe and not run.lateProbe.result then run.helloPollAt = now + 1 end
			if rec.dm and not (run.ackPollAt and not PresenceWorks()) then run.dmPollAt = now + 1 end
			if rec.openUrl then Q.OpenAcked(id, now) end
		end
		-- A hello only needs the bridge to have been seen; it never escalates.
		-- A forget is the same, but the bridge must have been seen a moment after
		-- the record went up, so it had a chance to read it. That holds for a strip
		-- that stays up; on the screenshot transport only the ack file says it was read.
		if (rec.hello or rec.forget) and not rec.acked and not ScreenshotMode() and run.bridgeSeen and run.bridgeSeen >= rec.sentAt + (rec.forget and 2 or 0) then
			NoteAcked(rec)
			changed = true
		end
		if rec.acked then
			if rec.forget then db.forget[rec.forget] = nil end
			run.outbound[id] = nil
			changed = true
		elseif rec.openUrl then
			if now - (rec.clickedAt or rec.sentAt) >= Q.OPEN_URL_EXPIRE_SECONDS then
				run.outbound[id] = nil
				changed = true
			end
		elseif rec.shot == "log" and now - (rec.loggedAt or rec.sentAt) >= ClaudeWoW.ChatLog.RetrySeconds() then
			rec.tries = (rec.tries or 1) + 1
			rec.sentAt = now
			rec.shot = nil
			changed = true
		elseif rec.hello and now - rec.sentAt >= 20 then
			run.outbound[id] = nil
			changed = true
		elseif now - rec.sentAt >= STRIP_SECONDS then
			rec.tries = (rec.tries or 1) + 1
			if rec.tries <= STRIP_TRIES then
				-- Nobody picked it up: show it again (a new screenshot in that mode).
				rec.sentAt = now
				rec.shot = nil
				changed = true
			elseif rec.forget or rec.cancelOf or rec.dm then
				-- The bridge is away; db.forget keeps it for the next hello.
				run.outbound[id] = nil
				changed = true
			else
				-- Give up on pixels for this message; the reload path still has it.
				run.outbound[id] = nil
				run.pixelFailed = true
				changed = true
				ClaudeWoW.ArmAutoRefresh()
			end
		end
	end
	if changed then
		RefreshStrip()
		ClaudeWoW.UpdateStatus()
	end
	if Q.LateSignal() then return end
	if not AnyPending() then
		PollLate(now)
		return
	end
	local moved = false
	for _, c in ipairs(db.chats) do
		if c.pendingId and PollActivity(c) then moved = true end
	end
	if moved then ClaudeWoW.Render() end
	for _, c in ipairs(db.chats) do
		if c.pendingId and run.staleSig and run.staleSig[c.pendingId] and not CheckSignal("sig", c.pendingId) then run.staleSig[c.pendingId] = nil end
		if c.pendingId and FreshSignal("sig", c.pendingId) then
			TryLoadSlot("signal")
			return
		end
	end
	if run.nextPollAt and now >= run.nextPollAt then
		TryLoadSlot("schedule")
	end
end

-- Pull whatever bridge.js last wrote into Inbox.lua (the reload path).
local ApplyInbox

local function ProcessInbox()
	local inbox = ClaudeWoW_Inbox
	if type(inbox) ~= "table" then return end
	local stamp = tonumber(inbox.now)
	run.replay = { at = stamp and GetTime() - math.max(0, time() - stamp) or nil }
	local ok, err = pcall(ApplyInbox, inbox)
	run.replay = nil
	if not ok then error(err, 0) end
end

ApplyInbox = function(inbox)
	if type(inbox.cwd) == "string" and inbox.cwd ~= "" then run.bridgeCwd = inbox.cwd end
	if inbox.cancel == true then run.bridgeCancel = true end
	local inboxStamp = tonumber(inbox.now)
	if inboxStamp and time() - inboxStamp <= Q.INBOX_FRESH_SECONDS then run.bridgeOpenUrl = inbox.openUrl == true end
	if type(inbox.agent) == "string" and inbox.agent ~= "" then run.bridgeAgent = inbox.agent end
	if type(inbox.agents) == "table" and #inbox.agents > 0 then run.bridgeAgents = inbox.agents end
	if type(inbox.plugin) == "string" and inbox.plugin ~= "" then run.bridgePlugin = inbox.plugin end
	if type(inbox.plugins) == "table" and #inbox.plugins > 0 then run.bridgePlugins = inbox.plugins end
	ClaudeWoW.ApplyEfforts(inbox)
	ClaudeWoW.ApplyLive(inbox.live)
	ClaudeWoW.ApplySessions(inbox.sessions, inbox.now)
	ClaudeWoW.ApplyProjects(inbox.projects, inbox.home)
	ClaudeWoW.ApplySkills(inbox.skills)
	run.bridgeDiscord = inbox.discord == true
	ClaudeWoW.ApplyMirror(inbox.mirror)
	ClaudeWoW.ApplyMcp((tonumber(inbox.now) or 0) >= time() - Q.INBOX_FRESH_SECONDS and inbox.mcp or nil)
	ClaudeWoW.ApplyContract((tonumber(inbox.now) or 0) >= time() - Q.INBOX_FRESH_SECONDS and inbox.contract or nil)
	ApplyTransport(inbox)
	ClaudeWoW.Version.Apply(inbox.bridge, inbox.now)
	ClaudeWoW.Version.ApplyDisk(inbox.addonDisk, inbox.now)
	ClaudeWoW.Version.ApplyClients(inbox.clients, inbox.now)
	Q.ApplyRuns(inbox)
	ApplyReplies(inbox.replies)
	if inbox.restore then ImportRestore(inbox.restore) end
	if inbox.map and ClaudeWoWMap then ClaudeWoWMap.Sync(inbox.map) end
	if inbox.achievements and ClaudeWoWAchievements then ClaudeWoWAchievements.Sync(inbox.achievements, inbox.now) end
	if inbox.goals and ClaudeWoWOrders then ClaudeWoWOrders.SyncInbox(inbox.goals, inbox.now) end
	if type(inbox.dm) == "table" then
		local stamp = tonumber(inbox.now)
		if stamp and time() - stamp <= Q.INBOX_FRESH_SECONDS then run.bridgeDm = true end
		if ClaudeWoWDM then ClaudeWoWDM.SyncInbox(inbox.dm) end
	end
	if inbox.widgets and ClaudeWoWWidgets then ClaudeWoWWidgets.Sync(inbox.widgets) end
	if ClaudeWoWTelemetry then ClaudeWoWTelemetry.SyncInbox(inbox.gs, inbox.now) end
end

local quietReplyHandlers = {}

function ClaudeWoW.OnQuietReply(plugin, handler)
	quietReplyHandlers[plugin] = handler
end

local function FinishQuiet(chat, role, text)
	chat.pendingId = nil
	chat.progress = nil
	if run.act then run.act[chat.id] = nil end
	NotedBridge()
	if not AnyPending() then ClaudeWoW.DisarmReload() end
	local handler = quietReplyHandlers[chat.plugin]
	if handler then pcall(handler, chat, role, text) end
end

Finish = function(chat, role, text, denied, agent, summary, macros)
	if chat.quiet then return FinishQuiet(chat, role, text) end
	local msgId = chat.pendingId
	AddHistory(chat, role, text, msgId, denied, agent, macros, role == "assistant" and summary or nil)
	chat.pendingId = nil
	chat.progress = nil
	ContextWarning(chat)
	if run.act then run.act[chat.id] = nil end
	NotedBridge()
	local visible = ui.frame and ui.frame:IsShown() and db.activeChat == chat.id
	if not AnyPending() then
		ClaudeWoW.DisarmReload()
	end
	if visible then Q.OfferDraft(chat) end
	ClaudeWoW.Render()
	if denied and ClaudeWoW.LootRollEnabled() then ClaudeWoWRoll.Offer(chat.id) end
	local tabbed = ClaudeWoW.Notify(chat, text, agent, summary, role, denied, msgId, macros)
	Q.NoteUnread(chat, visible, tabbed)
	if not visible then Q.OfferDraft(chat) end
end

function Q.OfferDraft(chat)
	if chat.pendingId or not chat.draft or chat.draft == "" then return end
	if ui.frame and ui.frame:IsShown() and db.activeChat == chat.id and ui.input then
		ui.input:SetText(chat.draft)
		chat.draft = nil
		return
	end
	Whisper.System(chat, "Waiting to go: " .. Flat(chat.draft) .. "  " .. Link("send", chat.id, "send it", "55ff55"), false, true)
end

function ClaudeWoW.LateReply(chat, r)
	local text = type(r.text) == "string" and r.text or ""
	local agent = type(r.agent) == "string" and r.agent ~= "" and r.agent or nil
	local w = run.lateWait and run.lateWait[chat.id]
	if w and w.id == r.id then run.lateWait[chat.id] = nil end
	AddHistory(chat, "assistant", text, r.id, nil, agent, nil, r.summary)
	local visible = ui.frame and ui.frame:IsShown() and db.activeChat == chat.id
	ClaudeWoW.Render()
	local tabbed = ClaudeWoW.Notify(chat, text, agent, r.summary, "assistant", nil, r.id, nil)
	Q.NoteUnread(chat, visible, tabbed)
end

function Q.NoteUnread(chat, visible, tabbed)
	if visible or tabbed then return end
	chat.unread = (chat.unread or 0) + 1
	ClaudeWoW.Render()
end

---------------------------------------------------------------------------
-- Game context and links
---------------------------------------------------------------------------

-- The agent only sees text, so two things about the game are spelled out for it:
-- who is asking (the character, where they are; sent with the hello and again
-- when it changes, and put into the agent's system prompt by the bridge), and
-- what the player shift-clicked into the message (item, spell and quest links
-- are meaningless markup to the agent; their tooltips are what the player sees).
-- Every game API here is optional: whatever the client lacks is left out.

local CTX = { MAX = 900, LINK_LINES_MAX = 30, LINK_BYTES_MAX = 900 }

-- Call a game API that may not exist or may throw, and get its returns or nothing.
local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	return (function(ok, ...)
		if ok then return ... end
	end)(pcall(fn, ...))
end

local function Money(copper)
	copper = tonumber(copper) or 0
	local g, s, c = math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100
	if g > 0 then return g .. "g " .. s .. "s " .. c .. "c" end
	if s > 0 then return s .. "s " .. c .. "c" end
	return c .. "c"
end

-- A few lines about the game and the character, as the bridge will show them to the agent.
-- Profession and secondary skill lines by skill id (vanilla ids).
local PROFESSION_SKILL_IDS = {
	[164] = true, [165] = true, [171] = true, [182] = true, [186] = true, [197] = true, [202] = true,
	[333] = true, [393] = true, [129] = true, [185] = true, [356] = true,
}
ClaudeWoW.PROFESSION_SKILL_IDS = PROFESSION_SKILL_IDS
ClaudeWoW.PROFESSION_SKILL_NAMES = {
	Blacksmithing = 164, Leatherworking = 165, Alchemy = 171, Herbalism = 182, Mining = 186, Tailoring = 197,
	Engineering = 202, Enchanting = 333, Skinning = 393, ["First Aid"] = 129, Cooking = 185, Fishing = 356,
}

-- The character's skill lines as { name, isHeader, rank, maxRank, skillID }.
-- Forever only has C_SkillInfo (one table per line); the classic globals
-- (multiple returns) are the fallback for other clients.
function ClaudeWoW.SkillLines()
	local out = {}
	if C_SkillInfo and C_SkillInfo.GetNumSkillLines then
		local n = Try(C_SkillInfo.GetNumSkillLines)
		local seen = {}
		for i = 1, (type(n) == "number" and n or 0) do
			local sk = Try(C_SkillInfo.GetSkillLineInfo, i)
			-- Child lines (parentSkillLineID ~= 0) repeat their parent; Blizzard's
			-- skills frame skips them too.
			if type(sk) == "table" and type(sk.name) == "string" and (sk.parentSkillLineID or 0) == 0 then
				local key = sk.isHeader and ("h:" .. sk.name) or (sk.skillID or sk.name)
				if not seen[key] then
					seen[key] = true
					out[#out + 1] = { name = sk.name, isHeader = sk.isHeader, rank = sk.rank, maxRank = sk.maxRank, skillID = sk.skillID }
				end
			end
		end
		return out
	end
	local n = Try(GetNumSkillLines)
	for i = 1, (type(n) == "number" and n or 0) do
		local sname, isHeader, _, rank, _, _, maxRank = Try(GetSkillLineInfo, i)
		if type(sname) == "string" then
			out[#out + 1] = { name = sname, isHeader = isHeader and true or false, rank = rank, maxRank = maxRank, skillID = not isHeader and ClaudeWoW.PROFESSION_SKILL_NAMES[sname] or nil }
		end
	end
	return out
end

function ClaudeWoW.ActiveTraitConfigID()
	local specGroup = Try(C_SpecializationInfo and C_SpecializationInfo.GetActiveSpecGroup)
	if type(specGroup) ~= "number" then return nil end
	local configID = Try(C_SpecializationInfo.GetCombatConfigIDForSpecGroup, specGroup)
	if type(configID) == "number" then return configID end
end

function ClaudeWoW.TraitTalentTrees()
	if not C_Traits then return {} end
	local configID = ClaudeWoW.ActiveTraitConfigID()
	if not configID then return {} end
	local config = Try(C_Traits.GetConfigInfo, configID)
	local treeID = type(config) == "table" and type(config.treeIDs) == "table" and config.treeIDs[1]
	if type(treeID) ~= "number" then return {} end
	local displays = Try(C_Traits.GetGroupDisplayInfoByTreeID, treeID)
	if type(displays) ~= "table" then return {} end
	local groupIDs = {}
	for _, display in ipairs(displays) do
		if type(display) == "table" and type(display.groupID) == "number" then table.insert(groupIDs, display.groupID) end
	end
	local currencies = Try(C_Traits.GetGroupCurrencyInfo, configID, groupIDs)
	if type(currencies) ~= "table" then return {} end
	local spentByGroup = {}
	for _, group in ipairs(currencies) do
		local first = type(group) == "table" and type(group.traitNodeGroupID) == "number" and type(group.currencyInfos) == "table" and group.currencyInfos[1]
		if type(first) == "table" and type(first.spent) == "number" then spentByGroup[group.traitNodeGroupID] = first.spent end
	end
	if next(spentByGroup) == nil then return {} end
	local trees = {}
	for _, display in ipairs(displays) do
		if type(display) == "table" and type(display.displayName) == "string" and display.displayName ~= "" then
			table.insert(trees, { name = display.displayName, points = spentByGroup[display.groupID] or 0 })
		end
	end
	return trees
end

function ClaudeWoW.TabTalentTrees()
	local trees = {}
	local tabs = Try(GetNumTalentTabs)
	local specInfo = C_SpecializationInfo and C_SpecializationInfo.GetSpecializationInfo
	for i = 1, (type(tabs) == "number" and tabs or 0) do
		local tname, points
		if specInfo then
			local _, specName, _, _, _, _, spent = Try(specInfo, i)
			tname, points = specName, spent
		else
			tname, _, points = Try(GetTalentTabInfo, i)
		end
		if type(tname) == "string" and type(points) == "number" then
			table.insert(trees, { name = tname, points = points })
		end
	end
	return trees
end

function ClaudeWoW.TalentTrees()
	local trees = Try(ClaudeWoW.TraitTalentTrees)
	if type(trees) == "table" and #trees > 0 then return trees end
	trees = Try(ClaudeWoW.TabTalentTrees)
	return type(trees) == "table" and trees or {}
end

function ClaudeWoW.CharacterLine()
	local name = Try(UnitName, "player")
	if not name then return nil end
	local realm = Try(GetRealmName)
	local level = Try(UnitLevel, "player")
	local race = Try(UnitRace, "player")
	local class = Try(UnitClass, "player")
	local faction = Try(UnitFactionGroup, "player")
	local guild = Try(GetGuildInfo, "player")
	local who = tostring(name) .. (realm and (" on " .. tostring(realm)) or "")
	local desc = {}
	if level then table.insert(desc, "level " .. tostring(level)) end
	if race then table.insert(desc, tostring(race)) end
	if class then table.insert(desc, tostring(class)) end
	if #desc > 0 then who = who .. ", " .. table.concat(desc, " ") end
	if faction then who = who .. " (" .. tostring(faction) .. ")" end
	if guild then who = who .. ", guild <" .. tostring(guild) .. ">" end
	return who
end

function ClaudeWoW.GameContext()
	local lines = {}
	local version, build, _, toc = Try(GetBuildInfo)
	toc = tonumber(toc)
	local game = "World of Warcraft"
	if toc and toc >= 16000 and toc < 20000 then game = "World of Warcraft: Forever"
	elseif toc and toc >= 11500 and toc < 11600 then game = "World of Warcraft Classic" end
	local client = ""
	if version then
		client = " (client " .. tostring(version) .. (build and ("." .. tostring(build)) or "") .. (toc and (", interface " .. toc) or "") .. ")"
	end
	table.insert(lines, "Game: " .. game .. client)

	local who = ClaudeWoW.CharacterLine()
	if who then table.insert(lines, "Character: " .. who) end

	local zone = Try(GetZoneText)
	local sub = Try(GetSubZoneText)
	if zone and zone ~= "" then
		table.insert(lines, "Location: " .. zone .. ((sub and sub ~= "" and sub ~= zone) and (" - " .. sub) or ""))
	end

	-- Map coordinates, as the minimap shows them (0-100 across the current map;
	-- addons get no world x/y/z). Modern C_Map first, the vanilla call as fallback.
	local x, y, mapName
	local mapId = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	if type(mapId) == "number" then
		local pos = Try(C_Map.GetPlayerMapPosition, mapId, "player")
		if type(pos) == "table" and type(pos.x) == "number" and type(pos.y) == "number" then x, y = pos.x, pos.y end
		local info = Try(C_Map.GetMapInfo, mapId)
		if type(info) == "table" and type(info.name) == "string" then mapName = info.name end
	end
	if not x then
		local px, py = Try(GetPlayerMapPosition, "player")
		if type(px) == "number" and type(py) == "number" then x, y = px, py end
	end
	if x and y and (x > 0 or y > 0) then
		local where = (mapName and mapName ~= zone) and (" on " .. mapName) or ""
		table.insert(lines, string.format("Position: %.1f, %.1f%s%s", x * 100, y * 100, where, mapId and (" (map " .. mapId .. ")") or ""))
	end

	local progress = {}
	local copper = Try(GetMoney)
	if copper then table.insert(progress, "Money: " .. Money(copper)) end
	local xp, xpMax = Try(UnitXP, "player"), Try(UnitXPMax, "player")
	if type(xp) == "number" and type(xpMax) == "number" and xpMax > 0 then
		table.insert(progress, "XP: " .. xp .. "/" .. xpMax)
	end
	if #progress > 0 then table.insert(lines, table.concat(progress, "; ")) end

	local trees = ClaudeWoW.TalentTrees()
	if #trees > 0 then
		local parts = {}
		for _, tree in ipairs(trees) do table.insert(parts, tree.name .. " " .. tree.points) end
		table.insert(lines, "Talents: " .. table.concat(parts, " / "))
	end

	-- Skill lines under the Professions and Secondary Skills headers.
	local header, parts = nil, {}
	local wanted = { [TRADE_SKILLS or "Professions"] = true, [SECONDARY_SKILLS or "Secondary Skills"] = true }
	for _, sk in ipairs(ClaudeWoW.SkillLines()) do
		if sk.isHeader then
			header = sk.name
		elseif (header and wanted[header]) or PROFESSION_SKILL_IDS[sk.skillID] then
			table.insert(parts, sk.name .. (sk.rank and (" " .. tostring(sk.rank) .. (sk.maxRank and ("/" .. tostring(sk.maxRank)) or "")) or ""))
		end
	end
	if #parts > 0 then table.insert(lines, "Professions: " .. table.concat(parts, ", ")) end

	-- Quest log ids (what is accepted, and which are done), so route planning can
	-- skip pickups and turn-ins that no longer apply.
	local quests = {}
	local qn = Try(C_QuestLog and C_QuestLog.GetNumQuestLogEntries) or Try(GetNumQuestLogEntries)
	if type(qn) == "number" then
		for i = 1, math.min(qn, 40) do
			local id, header, complete
			local info = Try(C_QuestLog and C_QuestLog.GetInfo, i)
			if type(info) == "table" then
				id, header = info.questID, info.isHeader
				complete = Try(C_QuestLog.IsComplete, id)
			else
				local _, _, _, isHeader, _, isComplete, _, qid = Try(GetQuestLogTitle, i)
				id, header, complete = qid, isHeader, isComplete == 1 or isComplete == true
			end
			if not header and type(id) == "number" and id > 0 then
				table.insert(quests, tostring(id) .. (complete and "*" or ""))
			end
		end
	end
	if #quests > 0 then table.insert(lines, "Quest log (id, * = ready to turn in): " .. table.concat(quests, ",")) end

	local s = table.concat(lines, "\n"):gsub("[\30\31]", " ")
	if #s > CTX.MAX then s = s:sub(1, CTX.MAX) end
	return s
end

-- The context to put on the next record, or nil when the bridge already has
-- it (or it wouldn't fit next to this message; it goes with a later one).
-- "" when the setting is off, so the bridge drops what it had.
local function ContextToSend(room)
	local ctx = db.settings.context and ClaudeWoW.GameContext() or ""
	if ctx == (run.contextSent or "") then return nil end
	if room and #ctx > room then return nil end
	return ctx
end

-- Read a link's tooltip off a hidden GameTooltip, one line per row.
local scanTip
local function TooltipLines(payload)
	if not scanTip then
		scanTip = CreateFrame("GameTooltip", "ClaudeWoWScanTip", UIParent, "GameTooltipTemplate")
	end
	scanTip:SetOwner(UIParent, "ANCHOR_NONE")
	scanTip:ClearLines()
	local lines = {}
	if pcall(scanTip.SetHyperlink, scanTip, payload) then
		for i = 1, math.min(scanTip:NumLines() or 0, CTX.LINK_LINES_MAX) do
			local left = _G["ClaudeWoWScanTipTextLeft" .. i]
			local right = _G["ClaudeWoWScanTipTextRight" .. i]
			local l = Trim(tostring((left and left:GetText()) or ""))
			local r = Trim(tostring((right and right:IsShown() and right:GetText()) or ""))
			if r ~= "" then l = l .. "  " .. r end
			if l ~= "" then table.insert(lines, l) end
		end
	end
	scanTip:Hide()
	return lines
end

-- What a link is, in words: "item 2140 (Uncommon)", "spell 1978", "quest 176".
local function DescribeLink(payload)
	local kind, id = payload:match("^(%a+):(%d+)")
	if not kind then return payload:match("^(%a+)") or "link" end
	local s = kind .. " " .. id
	if kind == "item" then
		local _, _, quality = Try((C_Item and C_Item.GetItemInfo) or GetItemInfo, payload)
		local desc = type(quality) == "number" and _G["ITEM_QUALITY" .. quality .. "_DESC"]
		if desc then s = s .. " (" .. desc .. ")" end
	end
	return s
end

-- Turn the links in a message into text the agent can use: each becomes [Name]
-- in place, and a block at the end lists what the tooltip says about it.
-- Returns the new text and the number of links found.
function ClaudeWoW.ExpandLinks(text)
	local links, seen = {}, {}
	local function Take(payload, name)
		if not seen[payload] then
			seen[payload] = true
			table.insert(links, { payload = payload, name = name })
		end
		return "[" .. name .. "]"
	end
	-- Coloured links first (|cAARRGGBB|H...|h[Name]|h|r), then bare ones.
	local out = text:gsub("|c%x%x%x%x%x%x%x%x|H([^|]+)|h%[([^%]]*)%]|h|r", Take)
	out = out:gsub("|H([^|]+)|h%[([^%]]*)%]|h", Take)
	if #links == 0 then return text, 0 end
	local blocks = {}
	for _, l in ipairs(links) do
		local head = "[" .. l.name .. "] " .. DescribeLink(l.payload)
		local body = table.concat(TooltipLines(l.payload), "\n  ")
		local block = body ~= "" and (head .. "\n  " .. body) or head
		if #block > CTX.LINK_BYTES_MAX then block = block:sub(1, CTX.LINK_BYTES_MAX) .. "..." end
		table.insert(blocks, block)
	end
	return out .. "\n\n--- Linked from the game ---\n" .. table.concat(blocks, "\n"), #links
end

---------------------------------------------------------------------------
-- Sending
---------------------------------------------------------------------------

-- allow: optional list of permission rules to grant before this message runs.
---------------------------------------------------------------------------
-- Whisper tabs
---------------------------------------------------------------------------

local WL = { TEXT_MAX = 4000, PROBE_NAME = "Cwowprobe", PRE_SEND_EVENT = "ChatFrame.OnEditBoxPreSendText", SHORT_LINES = 8, SHORT_CHARS = 700, TLDR_LINES = 3, PREVIEW_LINES = 2, PROGRESS_MAX = 120, LINE_MAX = 300, THROTTLE_SECONDS = 20, ELAPSED_STEP = 5, PULSE_SECONDS = 1 }
local preSendHooked = false
local whisperLive = setmetatable({}, { __mode = "k" })

local function WhisperOn()
	return db ~= nil and db.settings.whisper == true
end

function Whisper.Active()
	return WhisperOn() and preSendHooked and type(FCF_OpenTemporaryWindow) == "function"
end

local function WhisperColor(kind, r, g, b)
	local info = type(ChatTypeInfo) == "table" and ChatTypeInfo[kind]
	if type(info) == "table" and info.r then return info.r, info.g, info.b end
	return r, g, b
end

function Whisper.SystemColor()
	return WhisperColor("SYSTEM", 1, 1, 0)
end

-- The game's own format string when it has one ("%s whispers: "), else ours.
local function WhisperFormat(fmt, default, arg)
	if type(fmt) == "string" then
		local ok, s = pcall(string.format, fmt, arg)
		if ok then return s end
	end
	return string.format(default, arg)
end

-- Every chat frame the dock knows, temporary ones included.
local function WhisperFrames()
	local list, seen = {}, {}
	local function add(f)
		if type(f) == "table" and not seen[f] then
			seen[f] = true
			table.insert(list, f)
		end
	end
	if type(CHAT_FRAMES) == "table" then
		for _, name in ipairs(CHAT_FRAMES) do add(_G[name]) end
	end
	for i = 1, (NUM_CHAT_WINDOWS or 10) + 30 do add(_G["ChatFrame" .. i]) end
	return list
end

local function WhisperAlive(frame)
	return frame ~= nil and frame.inUse ~= false and (frame.isDocked or frame:IsShown()) and true or false
end

local function WhisperTab(frame)
	return frame.tab or _G[frame:GetName() .. "Tab"]
end

local function WhisperBox(frame)
	return frame.editBox or _G[frame:GetName() .. "EditBox"]
end

function Whisper.Title(chat)
	if tostring(chat.name or ""):match("^Chat %d+$") then return ChatAgentName(chat) end
	return Display(chat.name)
end

-- Still the tab we opened: alive, and its whisper still aimed at our agent (a
-- closed temporary window is reused by the game for the next real whisper).
local function WhisperOwns(chat, frame)
	if not frame or frame.claudewowChatId ~= chat.id or not WhisperAlive(frame) then return false end
	local eb = WhisperBox(frame)
	local target = eb and eb.GetAttribute and eb:GetAttribute("tellTarget")
	return target == nil or frame.claudewowTarget == nil or tostring(target):lower() == frame.claudewowTarget:lower()
end

local function WhisperWrite(frame, text, r, g, b)
	if frame and frame.AddMessage then pcall(frame.AddMessage, frame, text, r, g, b) end
end

function Whisper.Lines(frame, text, r, g, b)
	for line in (tostring(text) .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then WhisperWrite(frame, line, r, g, b) end
	end
end

function Whisper.CanEdit(frame)
	return type(frame.RemoveMessagesByPredicate) == "function"
end

function Whisper.DropLine(frame, text)
	if not Whisper.CanEdit(frame) then return false end
	return pcall(frame.RemoveMessagesByPredicate, frame, function(message) return message == text end) and true or false
end

function Whisper.Live(frame, key, text, r, g, b, force)
	if not frame then return nil end
	whisperLive[frame] = whisperLive[frame] or {}
	local slot = whisperLive[frame][key]
	if slot and slot.text == text then return "same" end
	if slot and not Whisper.CanEdit(frame) and not force and GetTime() - slot.at < WL.THROTTLE_SECONDS then return "throttled" end
	local how = "added"
	if slot and Whisper.DropLine(frame, slot.text) then how = "edited" end
	WhisperWrite(frame, text, r, g, b)
	whisperLive[frame][key] = { text = text, at = GetTime() }
	return how
end

function Whisper.EndLive(frame, key)
	local lines = frame and whisperLive[frame]
	local slot = lines and lines[key]
	if not slot then return end
	lines[key] = nil
	Whisper.DropLine(frame, slot.text)
end

function Whisper.Retitle(chat)
	local frame = run.whisperTabs and run.whisperTabs[chat.id]
	if not frame then return end
	local title = Whisper.Title(chat)
	if frame.claudewowTitle == title then return end
	frame.claudewowTitle = title
	local ok = type(FCF_SetWindowName) == "function" and pcall(FCF_SetWindowName, frame, title, true)
	if not ok then
		local tab = WhisperTab(frame)
		if tab and tab.SetText then pcall(tab.SetText, tab, title) end
	end
end

function Whisper.HookPreSend(handler)
	if preSendHooked then return true end
	if type(EventRegistry) ~= "table" or type(EventRegistry.RegisterCallback) ~= "function" then return false end
	preSendHooked = pcall(EventRegistry.RegisterCallback, EventRegistry, WL.PRE_SEND_EVENT, handler, Whisper) and true or false
	return preSendHooked
end

local function WhisperAdopt(chat, frame)
	run.whisperTabs = run.whisperTabs or {}
	frame.claudewowChatId = chat.id
	frame.claudewowTarget = frame.claudewowTarget or ChatAgentName(chat)
	run.whisperTabs[chat.id] = frame
	Whisper.Retitle(chat)
	return frame
end

function Whisper.Welcome(chat, frame)
	local folder = FolderName(ChatFolder(chat))
	local where = folder ~= "" and (" in " .. Display(folder)) or ", general chat"
	local r, g, b = Whisper.SystemColor()
	WhisperWrite(frame, ChatAgentName(chat) .. where .. ". Type to talk; " .. Link("open", chat.id, "workspace") .. " opens the full window.", r, g, b)
end

function Whisper.CompanionAlive()
	return ClaudeWoW.BridgeState() == "ok" and not run.pixelFailed
end

function Whisper.MayOpen(chat)
	return chat ~= nil and Whisper.CompanionAlive() and HasUserMessage(chat) and ChatAgent(chat) ~= ""
end

function Whisper.FrameFor(chat, create, select)
	if not WhisperOn() or not chat then return nil end
	if not preSendHooked then
		run.whisperError = "this client has no " .. WL.PRE_SEND_EVENT .. " hook, so a tab could not keep its whispers off the server"
		return nil
	end
	run.whisperTabs = run.whisperTabs or {}
	local frame = run.whisperTabs[chat.id]
	local stale = frame and create and ChatAgent(chat) ~= "" and tostring(frame.claudewowTarget or ""):lower() ~= ChatAgentName(chat):lower()
	if stale then
		Whisper.Close(chat)
		frame = nil
	end
	if WhisperOwns(chat, frame) then
		Whisper.Retitle(chat)
		return frame
	end
	run.whisperTabs[chat.id] = nil
	local title = Whisper.Title(chat):lower()
	for _, f in ipairs(WhisperFrames()) do
		if f.isTemporary and WhisperAlive(f) then
			local tab = WhisperTab(f)
			local name = tab and tab.GetText and tab:GetText()
			local unclaimed = f.claudewowChatId == nil or not FindChat(f.claudewowChatId)
			if WhisperOwns(chat, f) or (unclaimed and ChatAgent(chat) ~= "" and type(name) == "string" and name:lower() == title) then
				return WhisperAdopt(chat, f)
			end
		end
	end
	if not create or type(FCF_OpenTemporaryWindow) ~= "function" or not Whisper.MayOpen(chat) then return nil end
	local ok, f = pcall(FCF_OpenTemporaryWindow, "WHISPER", ChatAgentName(chat), DEFAULT_CHAT_FRAME, select and true or false)
	if not ok or type(f) ~= "table" then
		run.whisperError = tostring(f)
		return nil
	end
	f.claudewowTitle = nil
	f.claudewowTarget = ChatAgentName(chat)
	WhisperAdopt(chat, f)
	Whisper.Welcome(chat, f)
	return f
end

-- Flash the tab as a real whisper does. The game's own function when it has
-- one, else the tab glow by hand; a tab already on screen needs none.
function Whisper.Flash(frame)
	local how
	if frame:IsShown() then
		how = "visible"
	elseif type(FCF_StartAlertFlash) == "function" and pcall(FCF_StartAlertFlash, frame) then
		how = "FCF_StartAlertFlash"
	else
		local tab = WhisperTab(frame)
		local glow = tab and tab.glow
		if glow and type(UIFrameFlash) == "function" and pcall(UIFrameFlash, glow, 1, 1, -1, false, 0, 0, "chat") then
			tab.alerting = true
			how = "UIFrameFlash"
		elseif glow and glow.Show then
			pcall(glow.Show, glow)
			how = "glow"
		else
			how = "none"
		end
	end
	run.whisperFlash = how
	return how
end

function Whisper.System(chat, text, create, raw)
	local frame = Whisper.FrameFor(chat, create)
	if not frame then return false end
	local r, g, b = Whisper.SystemColor()
	Whisper.Lines(frame, raw and text or Display(text), r, g, b)
	return true
end

function Q.CutLine(line, width)
	local cut = line:sub(1, width)
	if line:sub(width + 1, width + 1):match("%S") then
		local whole = cut:gsub("%s+%S*$", "")
		if whole ~= cut then cut = whole else cut = cut:gsub("https?://%S*$", "") end
	end
	return cut:match("%S") and cut or line
end

function Whisper.BodyLines(source, max, width)
	local lines, total = {}, 0
	for line in (source .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then
			total = total + 1
			if width and #line > width then line = Q.CutLine(line, width) .. "..." end
			if total <= max then table.insert(lines, line) end
		end
	end
	return lines, total
end

function Whisper.Body(text, summary)
	local body = Q.MarkFences(Display(text))
	local mode = db.settings.echo
	local limit = mode == "full" and WL.TEXT_MAX or tonumber(mode)
	if limit then
		local lines, shown = {}, 0
		for line in (body .. "\n"):gmatch("(.-)\n") do
			if line:match("%S") then
				if shown + #line > limit then return lines, (#body - shown) .. " more characters" end
				table.insert(lines, line)
				shown = shown + #line
			end
		end
		return lines, nil
	end
	local all, total = Whisper.BodyLines(body, WL.SHORT_LINES)
	if total <= WL.SHORT_LINES and #body <= WL.SHORT_CHARS then return all, nil end
	local tldr = Q.MarkFences(Display(summary or ""))
	if tldr:match("%S") then
		local lines = Whisper.BodyLines(tldr, WL.TLDR_LINES, WL.LINE_MAX)
		return lines, "TL;DR of a longer reply (" .. total .. " lines)"
	end
	local lines = Whisper.BodyLines(body, WL.PREVIEW_LINES, WL.LINE_MAX)
	local more = total - #lines
	return lines, more > 0 and ("... " .. more .. " more lines") or "... the rest is longer than the tab shows"
end

function Whisper.RollLinks(chat, msgId)
	local id = chat.id .. ":" .. tostring(msgId or 0)
	local roll = ClaudeWoW.LootRollEnabled()
	local greed = Link("roll", id .. ":greed", roll and (GREED or "Greed") or "Allow once", "ffd100")
	local pass = Link("roll", id .. ":pass", roll and (PASS or "Pass") or "Pass", "ff6060")
	if ClaudeWoW.IsLiveChat(chat) then return greed .. " " .. pass end
	return greed .. " " .. Link("roll", id .. ":need", roll and (NEED or "Need") or "Allow & retry", "1eff00") .. " " .. pass
end

function Whisper.MacroLinkLabel(m)
	return (ClaudeWoW.MacroLabel(m):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", ""))
end

function Whisper.Reply(chat, text, agent, role, denied, summary, msgId, macros)
	local frame = Whisper.FrameFor(chat, true, false)
	if not frame then return false end
	if role ~= "system" and Q.WaitForLinks(Display(tostring(summary or "") .. "\n" .. tostring(text or "")), tostring(chat.id) .. ":" .. tostring(msgId)) then
		C_Timer.After(Q.LINK_RETRY_SECONDS, function() Whisper.Reply(chat, text, agent, role, denied, summary, msgId, macros) end)
		return true
	end
	Whisper.EndLive(frame, "progress")
	local who = ReplyAgentName(chat, agent)
	local sr, sg, sb = Whisper.SystemColor()
	if role == "system" then
		local lines = Whisper.BodyLines(Display(text), WL.SHORT_LINES)
		for i, line in ipairs(lines) do
			WhisperWrite(frame, line .. (i == #lines and ("  " .. Link("open", chat.id, "open")) or ""), sr, sg, sb)
		end
	else
		local r, g, b = WhisperColor("WHISPER", 1, 0.5, 1)
		local prefix = WhisperFormat(CHAT_WHISPER_GET, "%s whispers: ", "|H" .. LINK_PREFIX .. "reply:" .. chat.id .. "|h[" .. who .. "]|h")
		local lines, cut = Whisper.Body(text, summary)
		for i, line in ipairs(lines) do WhisperWrite(frame, (i == 1 and prefix or "") .. Q.RichText(line), r, g, b) end
		if #lines == 0 then WhisperWrite(frame, prefix, r, g, b) end
		if cut then WhisperWrite(frame, "|cff888888" .. cut .. ":|r " .. Link("open", chat.id, "full reply"), r, g, b) end
		for k, m in ipairs(macros or {}) do
			WhisperWrite(frame, Link("macro", chat.id .. ":" .. tostring(msgId or 0) .. ":" .. k, Whisper.MacroLinkLabel(m), "ffd100") .. "  |cff888888click, then drop it on an action bar|r", sr, sg, sb)
		end
	end
	if denied then
		WhisperWrite(frame, who .. " needs permission for " .. Display(ClaudeWoW.GrantsLabel(denied)) .. ": " .. Whisper.RollLinks(chat, msgId), sr, sg, sb)
	end
	Whisper.Flash(frame)
	return true
end

function Whisper.ProgressText(chat)
	local a = run.act and run.act[chat.id]
	local started = (a and a.startedAt) or (run.whisperSentAt and run.whisperSentAt[chat.id]) or GetTime()
	local elapsed = math.floor((GetTime() - started) / WL.ELAPSED_STEP) * WL.ELAPSED_STEP
	local parts = { FmtElapsed(elapsed) }
	local count = Cli.WorkCount(chat)
	if count then table.insert(parts, count) end
	local text = ChatAgentName(chat) .. " is working... " .. table.concat(parts, " " .. SEG.DOT .. " ")
	local _, latest = Cli.StepLines(chat)
	local p = Trim(Flat(latest or ""))
	if p ~= "" then
		if #p > WL.PROGRESS_MAX then p = p:sub(1, WL.PROGRESS_MAX) .. "..." end
		text = text .. " - " .. p
	end
	return text .. "  " .. Link("cancel", chat.id, "stop", "888888")
end

function Whisper.RefreshProgress(chat, force)
	if not chat.pendingId then return nil end
	local frame = Whisper.FrameFor(chat, false)
	if not frame then return nil end
	local r, g, b = Whisper.SystemColor()
	return Whisper.Live(frame, "progress", Whisper.ProgressText(chat), r, g, b, force)
end

function Whisper.Sent(chat, text)
	local frame = Whisper.FrameFor(chat, true, false)
	if not frame then return false end
	local who = ChatAgentName(chat)
	WhisperWrite(frame, WhisperFormat(CHAT_WHISPER_INFORM_GET, "To %s: ", who) .. Flat(text), WhisperColor("WHISPER_INFORM", 1, 0.5, 1))
	run.whisperSentAt = run.whisperSentAt or {}
	run.whisperSentAt[chat.id] = GetTime()
	Whisper.EndLive(frame, "progress")
	Whisper.RefreshProgress(chat, true)
	return true
end

function Whisper.Progress(chat)
	if chat.pendingId then Whisper.RefreshProgress(chat) end
end

function Whisper.StopProgress(chat)
	local frame = run.whisperTabs and run.whisperTabs[chat.id]
	if frame then Whisper.EndLive(frame, "progress") end
end

function Whisper.BridgeLine(chat)
	local key = ConnectionKey()
	if key == run.whisperBridgeKey then return end
	run.whisperBridgeKey = key
	local frame = chat and Whisper.FrameFor(chat, false)
	if not frame then return end
	local r, g, b = Whisper.SystemColor()
	local text
	if key == "ok" then
		if run.whisperBridgeBad then text = "|cff33ff66The companion app is back.|r" end
		run.whisperBridgeBad = nil
	elseif key == "stale" then
		text = "The companion app has been quiet for a while. " .. Link("connect", nil, "reconnect")
	elseif key == "down" then
		text = select(5, ClaudeWoW.BridgeState()) .. " " .. Link("connect", nil, "connect")
	elseif key == "failed" then
		text = Q.STATUS_NO_ANSWER .. " " .. Link("connect", nil, "try again")
	elseif key == "connecting" then
		text = Q.STATUS_CONNECTING
	elseif key == "unknown" then
		text = "Not connected to the companion app yet. Start it, then " .. Link("connect", nil, "connect")
	end
	if key == "stale" or key == "down" or key == "failed" then run.whisperBridgeBad = true end
	if text then
		Whisper.Live(frame, "bridge", text, r, g, b, true)
	else
		Whisper.EndLive(frame, "bridge")
	end
end

function Whisper.Pulse()
	if not db or not Whisper.Active() then return end
	local c = ActiveChat()
	if not run.whisperBooted and Whisper.MayOpen(c) then
		run.whisperBooted = true
		Whisper.FrameFor(c, true, false)
	end
	for _, ch in ipairs(db.chats) do
		if ch.pendingId then Whisper.RefreshProgress(ch) end
	end
	Whisper.BridgeLine(c)
end

function Whisper.Close(chat)
	local frame = run.whisperTabs and run.whisperTabs[chat.id]
	if not frame then return end
	run.whisperTabs[chat.id] = nil
	frame.claudewowChatId = nil
	whisperLive[frame] = nil
	if type(FCF_Close) == "function" and WhisperAlive(frame) then pcall(FCF_Close, frame) end
end

function Whisper.CloseAll()
	for _, c in ipairs(db.chats) do Whisper.Close(c) end
end

-- The chat behind an agent's name typed as a whisper target: the active chat
-- when it talks to that agent, else the one that last replied, else the first.
local function WhisperAgentChat(target)
	target = tostring(target or ""):lower()
	if target == "" then return nil end
	local best
	for _, c in ipairs(db.chats) do
		if not c.quiet and ChatAgentName(c):lower() == target then
			if c.id == db.activeChat then return c end
			if c.id == run.lastReplyChat or not best then best = c end
		end
	end
	return best
end

function Whisper.ReplyName(chat)
	local label = Trim(Display(chat.name))
	if label == "" then label = tostring(chat.id) end
	return ChatAgentName(chat) .. " [" .. label .. "]"
end

local function ReplyNameChat(target)
	target = tostring(target or ""):lower()
	if target == "" or not db then return nil end
	local offered = run.replyNames and run.replyNames[target]
	if offered then return FindChat(offered) or FindChat(run.lastReplyChat) or ActiveChat() end
	local best
	for _, c in ipairs(db.chats) do
		if Whisper.ReplyName(c):lower() == target then
			if c.id == run.lastReplyChat then return c end
			best = best or c
		end
	end
	return best
end

local function SetLastTellFunction()
	if type(ChatFrameUtil) == "table" and type(ChatFrameUtil.SetLastTellTarget) == "function" then return ChatFrameUtil.SetLastTellTarget end
	if type(ChatEdit_SetLastTellTarget) == "function" then return ChatEdit_SetLastTellTarget end
	return nil
end

function Whisper.OfferReply(chat)
	local setLastTell = SetLastTellFunction()
	if not preSendHooked or not setLastTell then return false end
	local name = Whisper.ReplyName(chat)
	run.replyNames = run.replyNames or {}
	run.replyNames[name:lower()] = chat.id
	local ok = pcall(setLastTell, name, "WHISPER")
	if ok then run.replyTarget = name end
	return ok
end

function Whisper.TabChat(eb)
	if not WhisperOn() or type(eb) ~= "table" then return nil end
	local frame = eb.chatFrame or (eb.GetParent and eb:GetParent())
	local chat = type(frame) == "table" and frame.claudewowChatId and FindChat(frame.claudewowChatId)
	if chat and run.whisperTabs and run.whisperTabs[chat.id] == frame then return chat end
	return nil
end

function Whisper.SelectedTabChat(eb)
	if not WhisperOn() or type(eb) ~= "table" or not eb.GetAttribute or eb:GetAttribute("chatType") ~= "WHISPER" then return nil end
	local frame = type(FCFDock_GetSelectedWindow) == "function" and type(GENERAL_CHAT_DOCK) == "table" and Try(FCFDock_GetSelectedWindow, GENERAL_CHAT_DOCK) or SELECTED_DOCK_FRAME or SELECTED_CHAT_FRAME
	local chat = type(frame) == "table" and frame.claudewowChatId and FindChat(frame.claudewowChatId)
	if not chat or not run.whisperTabs or run.whisperTabs[chat.id] ~= frame then return nil end
	local target = tostring(eb:GetAttribute("tellTarget") or ""):lower()
	if target ~= ChatAgentName(chat):lower() and ReplyNameChat(target) ~= chat then return nil end
	return chat
end

function Whisper.ChatForBox(eb)
	if type(eb) ~= "table" or not eb.GetAttribute then return nil end
	if eb:GetAttribute("chatType") ~= "WHISPER" then return nil end
	local target = eb:GetAttribute("tellTarget")
	local replied = ReplyNameChat(target)
	if replied then return replied end
	if not WhisperOn() then return nil end
	return Whisper.TabChat(eb) or WhisperAgentChat(target)
end

function Whisper.Intercept(eb, layer)
	local chat = Whisper.ChatForBox(eb)
	if not chat then return false end
	local text = Trim(eb:GetText() or "")
	pcall(eb.SetText, eb, "")
	if text == "" then return true end
	run.whisperSwallowed = (run.whisperSwallowed or 0) + 1
	run.whisperLayer = layer
	if eb.AddHistoryLine then pcall(eb.AddHistoryLine, eb, text) end
	if run.whisperProbe then
		run.whisperProbe(chat, text, layer)
		return true
	end
	if db.activeChat ~= chat.id then ClaudeWoW.SwitchChat(chat.id) end
	ClaudeWoW.Send(text)
	return true
end

-- The name in "No player named '%s' is currently playing.", or nil.
local function WhisperNotFoundName(msg)
	local fmt = type(ERR_CHAT_PLAYER_NOT_FOUND_S) == "string" and ERR_CHAT_PLAYER_NOT_FOUND_S or "No player named '%s' is currently playing."
	local pattern = fmt:gsub("[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0")
	pattern = pattern:gsub("%%%%s", "(.-)")
	return tostring(msg or ""):match("^" .. pattern .. "$")
end

-- A whisper that got out comes back as this system message: make it a loud
-- leak report instead of a line that looks like the game's business.
local function WhisperLeakFilter(_, _, msg, ...)
	if not db then return false end
	local name = WhisperNotFoundName(msg)
	if not name then return false end
	name = name:lower()
	local ours = ReplyNameChat(name) ~= nil or (run.replyTarget and run.replyTarget:lower() == name)
	if not ours and not WhisperOn() then return false end
	ours = ours or name == WL.PROBE_NAME:lower()
	for _, c in ipairs(db.chats) do
		if ChatAgentName(c):lower() == name then ours = true end
	end
	for _, n in pairs(AGENT_NAMES) do
		if n:lower() == name then ours = true end
	end
	if not ours then return false end
	run.whisperLeaks = (run.whisperLeaks or 0) + 1
	run.whisperLastLeak = msg
	return false, "|cffff4040[" .. ClaudeWoW.PRODUCT .. "] WHISPER LEAK: " .. tostring(msg) .. " - a send reached the server. Type /claude diag and report what it shows.|r", ...
end

local whisperInstalled = false

function Whisper.Install()
	if whisperInstalled then return end
	whisperInstalled = true
	run.whisperLayers = { preSendHooked and WL.PRE_SEND_EVENT or ("no " .. WL.PRE_SEND_EVENT) }
	if type(ChatFrame_AddMessageEventFilter) == "function" then
		pcall(ChatFrame_AddMessageEventFilter, "CHAT_MSG_SYSTEM", WhisperLeakFilter)
		table.insert(run.whisperLayers, "leak filter")
	end
end

function Whisper.Status()
	local tabs = 0
	for _, c in ipairs(db.chats) do
		if WhisperOwns(c, run.whisperTabs and run.whisperTabs[c.id]) then tabs = tabs + 1 end
	end
	return "whisper tabs: " .. (WhisperOn() and "on" or "off") .. ", " .. tabs .. " open, send hook: " .. (preSendHooked and "pre-send" or "MISSING")
		.. ", sends swallowed: " .. (run.whisperSwallowed or 0)
		.. ", LEAKS: " .. (run.whisperLeaks or 0) .. (run.whisperError and (", last open error: " .. run.whisperError) or "")
		.. ", /r: " .. (run.replyTarget or "the game's last whisper")
end

function Q.SayStillWaiting(c)
	run.waitSaid = run.waitSaid or {}
	if c.quiet or run.waitSaid[c.id] == c.pendingId then return end
	run.waitSaid[c.id] = c.pendingId
	Cli.Out(c, ChatAgentName(c) .. " is still working. What you type now waits as a draft and is offered again when the reply lands. Click Stop to cancel.")
end

-- opts.vision asks for a picture of the screen with this one message, whatever
-- the setting ("/claude-wow look <question>").
function ClaudeWoW.Send(text, allow, opts)
	local c = (opts and opts.chat and FindChat(opts.chat)) or ActiveChat()
	if not c then return end
	text = Trim(text or "")
	if c.pendingId then
		-- Typing while waiting: keep the draft, and check for the reply.
		if text ~= "" then
			c.draft = text
			Q.SayStillWaiting(c)
		end
		if db.settings.mode == "pixel" and not (run.slotsExhausted or run.slotsMissing) then
			TryLoadSlot("manual")
		else
			SafeReload()
		end
		return
	end
	if text == "" then return end
	if not (opts and opts.verbatim) then text = Cli.ProjectTag(c, text) end
	if not ClaudeWoW.IsConnected() then
		if ui.input then ui.input:SetText(text) end
		run.sendOnConnect = { chat = c.id, text = text, allow = allow, opts = opts }
		if not run.connectingAt then ClaudeWoW.Connect(ShotsPaused(true)) end
		if not (Whisper.Active() and Whisper.System(c, "Not connected to the companion app yet; connecting now. Your message goes out as soon as it answers.", true)) then
			ClaudeWoW.Toggle(true)
		end
		return
	end
	-- Shift-clicked links become [Name] plus their tooltip, which is what the agent can read.
	local links
	text, links = ClaudeWoW.ExpandLinks(text)
	local limit = Codec.MAX_PAYLOAD - 300 - #Cli.McpToken(c)
	if #text > limit then
		Cli.Out(c, "That message is too long for one send (" .. #text .. " chars, max ~" .. limit .. "). Split it up." .. (links > 0 and " Each linked item adds its tooltip to the message." or ""))
		return
	end
	-- The game context rides along when the bridge doesn't have this version yet.
	local ctx = ContextToSend(limit - #text)

	db.lastSeq = db.lastSeq + 1
	local id = db.lastSeq
	local tokens = {}
	local plugin = Cli.ChatPlugin(c)
	local verbatim = opts and opts.verbatim
	if c.resetNext and not verbatim then table.insert(tokens, "n") end
	if c.agent and c.agent ~= "" then table.insert(tokens, "agent=" .. c.agent) end
	if plugin ~= "" then table.insert(tokens, "plugin=" .. plugin) end
	if db.settings.vision or (opts and opts.vision) then table.insert(tokens, "v") end
	if opts and opts.kind then table.insert(tokens, "kind=" .. opts.kind) end
	local allowHex, allowOnceHex
	if type(allow) == "table" and #allow > 0 then
		if opts and opts.allowForThisRunOnly then
			table.insert(tokens, "once=" .. table.concat(allow, ","))
			allowOnceHex = ToHex(table.concat(allow, US))
		else
			table.insert(tokens, "allow=" .. table.concat(allow, ","))
			allowHex = ToHex(table.concat(allow, US))
		end
	end
	local optionTokens = Cli.ChatOptionTokens(c, opts and opts.onceDirs)
	if verbatim then
		for i = #optionTokens, 1, -1 do
			if optionTokens[i]:find("^resume=") or optionTokens[i]:find("^live=") then table.remove(optionTokens, i) end
		end
	end
	local wantsTitle = c.name:match("^Chat %d+$") and not HasUserMessage(c) and not (opts and opts.verbatim)
	if wantsTitle then table.insert(optionTokens, "t") end
	for _, t in ipairs(optionTokens) do table.insert(tokens, t) end
	local flags = table.concat(tokens, ";")
	local outboxTokens = { "ver=" .. ClaudeWoW.Version.Own(), "proto=" .. ClaudeWoW.Version.PROTO, Q.CharacterFlag() }
	for _, t in ipairs(optionTokens) do table.insert(outboxTokens, t) end
	local newSession = (c.resetNext and not verbatim) and true or nil
	if not verbatim then c.resetNext = nil end
	db.outbox = {
		id = id,
		session = db.session,
		chat = c.id,
		text = ToHex(text),
		cwd = ToHex(c.cwd),
		ctx = ctx and ToHex(ctx) or nil,
		agent = (c.agent and c.agent ~= "") and c.agent or nil,
		plugin = plugin ~= "" and plugin or nil,
		opts = ToHex(table.concat(outboxTokens, ";")),
		allow = allowHex,
		allowOnce = allowOnceHex,
		newSession = newSession,
		-- The bridge wants screenshots and this client cannot take one: the
		-- reload fallback tells it so, and it switches to the pixel capture.
		shot = NoScreenshot() and "missing" or nil,
		t = time(),
	}
	c.pendingId = id
	c.lifeAt = time()
	c.draft = nil
	c.progress = nil
	if run.steps then run.steps[c.id] = nil end
	if not c.quiet then
		AddHistory(c, "user", text, id)
		if wantsTitle then
			c.name = AutoTitle(text) or c.name
			c.titleFor = id
		end
		if not Whisper.Sent(c, text) then db.settings.shown = true end
		if ClaudeWoWVoice then ClaudeWoWVoice.Event("sent") end
	end

	if db.settings.mode == "pixel" then
		run.outbound[id] = { chat = c.id, cwd = c.cwd, flags = flags, name = c.name, text = text, ctx = ctx, sentAt = GetTime(), request = id }
		Q.NoteRequestSent(c.id, id)
		NoteStaleSignals(id)
		run.sentAt = GetTime()
		run.polls = 0
		StartActivity(c, id)
		ScheduleNextPoll()
		RefreshStrip()
		ClaudeWoW.Render()
	else
		SafeReload()
	end
end

-- Forget: a record with no text telling the bridge a chat was deleted, so it drops
-- the transcript (which a later restore would otherwise bring back) and the
-- agent session. db.forget keeps the id until the bridge acks, so a delete made
-- while the bridge was away is sent again with the next hello.
local function SendForget(chatId)
	if db.settings.mode ~= "pixel" then return end
	for _, rec in pairs(run.outbound) do
		if rec.forget == chatId and not rec.acked then return end
	end
	local info = db.forget[chatId] or {}
	db.lastSeq = db.lastSeq + 1
	run.outbound[db.lastSeq] = { chat = chatId, cwd = info.cwd or "", flags = "d", name = info.name or "", text = "", sentAt = GetTime(), forget = chatId }
	NoteStaleSignals(db.lastSeq)
	RefreshStrip()
end

local function SendCancel(chat, id)
	if db.settings.mode ~= "pixel" or not id or not run.bridgeCancel then return end
	db.lastSeq = db.lastSeq + 1
	run.outbound[db.lastSeq] = { chat = chat.id, cwd = chat.cwd or "", flags = "cancel=" .. id, name = chat.name or "", text = "", sentAt = GetTime(), cancelOf = id }
	NoteStaleSignals(db.lastSeq)
	RefreshStrip()
end

Q.DM_NEXT_GAP_SECONDS = 5
Q.INBOX_FRESH_SECONDS = 300

function ClaudeWoW.SendDmNext(charKey)
	if not db or db.settings.mode ~= "pixel" then return "reload" end
	if not run.bridgeDm then return "unsupported" end
	if type(charKey) ~= "string" or charKey == "" then return "nochar" end
	local now = GetTime()
	for _, rec in pairs(run.outbound) do
		if rec.dm and not rec.acked then return "busy" end
	end
	if run.dmSentAt and now - run.dmSentAt < Q.DM_NEXT_GAP_SECONDS then return "busy" end
	run.dmSentAt = now
	db.lastSeq = db.lastSeq + 1
	run.outbound[db.lastSeq] = { chat = "", cwd = "", flags = "kind=dm", name = charKey, text = "next", sentAt = now, dm = true }
	NoteStaleSignals(db.lastSeq)
	RefreshStrip()
	return "sent"
end

Q.OPEN_URL_MAX = 2048
Q.OPEN_URL_GAP_SECONDS = 5
Q.OPEN_URL_EXPIRE_SECONDS = 40
Q.OPEN_URL_POLLS = { 4, 12, 25 }

function Q.OpenRefused(url, why)
	if UIErrorsFrame then UIErrorsFrame:AddMessage("Link not opened: " .. why .. ". Copy it from the box.", 1, 0.3, 0.3, 1) end
	ClaudeWoW.ShowCopy(url)
end

function Q.ApplyOpenResults(acks)
	local w = run.openWait
	if not w or type(acks) ~= "table" or not db then return end
	for _, a in ipairs(acks) do
		if type(a) == "table" and a.session == db.session and a.id == w.id and (a.open == "ok" or a.open == "refused") then
			run.openWait = nil
			if a.open == "refused" then Q.OpenRefused(w.url, type(a.why) == "string" and a.why ~= "" and a.why or "the companion app refused it") end
			return
		end
	end
end

function Q.OpenAcked(id, now)
	local w = run.openWait
	if w and w.id == id then w.pollAt = now + 1 end
end

function Q.TickOpen(now)
	local w = run.openWait
	if not w then return end
	if now - w.at >= Q.OPEN_URL_EXPIRE_SECONDS then
		run.openWait = nil
		Q.OpenRefused(w.url, "no answer from the companion app")
		return
	end
	local offset = Q.OPEN_URL_POLLS[w.step]
	if w.pollAt and now >= w.pollAt then
		w.pollAt = nil
		TryLoadSlot("open")
	elseif offset and now - w.at >= offset then
		w.step = w.step + 1
		TryLoadSlot("open")
	end
end

function Q.OpenableUrl(url)
	if type(url) ~= "string" or #url > Q.OPEN_URL_MAX then return false end
	if not url:match("^https?://[%w%-]") then return false end
	return not url:find("[^%w%-%._~:/%?#@!%$&'%(%)%+,;=%%]")
end

function Q.HasLink(text, url)
	if type(text) ~= "string" or not text:find(url, 1, true) then return false end
	for found in text:gmatch("https?://" .. Q.URL_CHARS .. "+") do
		if Q.SplitUrl(found) == url then return true end
	end
	return false
end

function Q.ChatForUrl(url)
	local active = ActiveChat()
	local order = { active }
	for _, c in ipairs(db.chats) do
		if c ~= active then table.insert(order, c) end
	end
	for _, c in ipairs(order) do
		for i = #c.history, 1, -1 do
			local m = c.history[i]
			if m.role == "assistant" and Q.HasLink(m.text, url) then return c end
		end
	end
end

function ClaudeWoW.OpenUrl(url)
	if not db or db.settings.mode ~= "pixel" then return "reload" end
	if not run.bridgeOpenUrl then return "unsupported" end
	if ClaudeWoW.BridgeState() == "down" then return "offline" end
	if not Q.OpenableUrl(url) then return "refused" end
	local c = Q.ChatForUrl(url)
	if not c then return "unknown" end
	local now = GetTime()
	if run.openWait then return "busy" end
	for _, rec in pairs(run.outbound) do
		if rec.openUrl then return "busy" end
	end
	if run.openUrlAt and now - run.openUrlAt < Q.OPEN_URL_GAP_SECONDS then return "wait" end
	run.openUrlAt = now
	db.lastSeq = db.lastSeq + 1
	run.outbound[db.lastSeq] = { chat = c.id, cwd = "", flags = "kind=url", name = "", text = url, sentAt = now, clickedAt = now, openUrl = true }
	run.openWait = { id = db.lastSeq, url = url, at = now, step = 1 }
	NoteStaleSignals(db.lastSeq)
	RefreshStrip()
	return "sent"
end

local function ForgetOnBridge(c)
	if not c or not c.id then return end
	db.forget[c.id] = { name = c.name, cwd = c.cwd }
	SendForget(c.id)
end

-- Hello: a record with no text that just announces our session token. The bridge
-- acks it, offers a restore if our saved data is fresh, and refreshes the slots,
-- so the status light and any lost chats come back before the first message.
-- The game context always rides on it (empty when turned off), so the bridge's
-- copy is brought in line at every login and Connect.
function ClaudeWoW.SayHello()
	if db.settings.mode ~= "pixel" then return end
	local now = GetTime()
	if run.lastHelloAt and now - run.lastHelloAt < 60 then return end
	run.lastHelloAt = now
	db.lastSeq = db.lastSeq + 1
	local c = ActiveChat()
	local ctx = db.settings.context and ClaudeWoW.GameContext() or ""
	local flags = "h;ver=" .. ClaudeWoW.Version.Own() .. ";proto=" .. ClaudeWoW.Version.PROTO
	if Q.CharacterFlag() then flags = flags .. ";" .. Q.CharacterFlag() end
	if Presence.Channel() and not (run.lateProbe and run.lateProbe.result) then
		run.lateProbe = run.lateProbe or { token = string.format("%06x%04x", time() % 16777216, math.floor(now * 1000) % 65536) }
		flags = flags .. ";probe=" .. run.lateProbe.token
	end
	run.outbound[db.lastSeq] = { chat = c and c.id or "", cwd = c and c.cwd or "", flags = flags, name = c and c.name or "", text = "", ctx = ctx, sentAt = now, hello = true }
	NoteStaleSignals(db.lastSeq)
	run.helloPollAt = now + 5
	-- Deletions the bridge never confirmed ride along with the hello.
	for id in pairs(db.forget) do SendForget(id) end
	-- Fresh saved data: show "restoring" instead of an empty panel until we hear back.
	if not ClaudeWoWCharDB.restored then
		local empty = true
		for _, ch in ipairs(db.chats) do
			if #ch.history > 0 then empty = false end
		end
		if empty then run.restoring = now end
	end
	RefreshStrip()
	ClaudeWoW.Render()
end

-- Put the active chat's pending message back on the strip.
function ClaudeWoW.Resend()
	local c = ActiveChat()
	if not c or not c.pendingId then return end
	local text
	for i = #c.history, 1, -1 do
		if c.history[i].id == c.pendingId and c.history[i].role == "user" then
			text = c.history[i].text
			break
		end
	end
	if not text then return end
	local tokens = {}
	local plugin = Cli.ChatPlugin(c)
	if c.agent and c.agent ~= "" then table.insert(tokens, "agent=" .. c.agent) end
	if plugin ~= "" then table.insert(tokens, "plugin=" .. plugin) end
	if db.settings.vision then table.insert(tokens, "v") end -- a resend is a fresh screenshot
	for _, t in ipairs(Cli.ChatOptionTokens(c)) do table.insert(tokens, t) end
	if c.titleFor == c.pendingId then table.insert(tokens, "t") end
	run.outbound[c.pendingId] = { chat = c.id, cwd = c.cwd, flags = table.concat(tokens, ";"), name = c.name, text = text, sentAt = GetTime(), request = c.pendingId }
	Q.NoteRequestSent(c.id, c.pendingId)
	NoteStaleSignals(c.pendingId)
	run.sentAt = GetTime()
	run.polls = 0
	ScheduleNextPoll()
	RefreshStrip()
	ClaudeWoW.UpdateStatus()
end

function ClaudeWoW.SendFromInput()
	if not ui.input then return end
	local text = ui.input:GetText()
	ui.input:SetText("")
	ui.input:ClearFocus() -- hand the keyboard back to the game after sending
	ClaudeWoW.Send(text)
end

local function AllowAlways(chatId, rules)
	local c = FindChat(chatId)
	if not c or c.pendingId or not rules or #rules == 0 then return end
	if db.activeChat ~= c.id then ClaudeWoW.SwitchChat(c.id) end
	for _, m in ipairs(c.history) do m.denied = nil end
	local commands, dirs = ClaudeWoW.SplitGrants(rules)
	local full = Cli.AddChatDirs(c, dirs)
	local text = "Allowed: " .. ClaudeWoW.GrantsLabel(rules)
	if #dirs > 0 then text = text .. ". Extra folders for this chat: " .. Cli.DirsLabel(c) end
	if #full > 0 then text = text .. ". No room for " .. table.concat(full, ", ") .. " (at most " .. Cli.ADD_DIRS_MAX .. " folders), so it is added for this retry only" end
	Cli.Out(c, text)
	Q.EndPromptWait(c)
	ClaudeWoW.Send("Those actions are allowed now. Continue from where you left off.", commands, { onceDirs = full })
end

function ClaudeWoW.AllowOnce(chatId, rules)
	local c = FindChat(chatId)
	if not c or c.pendingId or not rules or #rules == 0 then return end
	if db.activeChat ~= c.id then ClaudeWoW.SwitchChat(c.id) end
	for _, m in ipairs(c.history) do m.denied = nil end
	local commands, dirs = ClaudeWoW.SplitGrants(rules)
	Cli.Out(c, "Allowed for this retry only: " .. ClaudeWoW.GrantsLabel(rules))
	Q.EndPromptWait(c)
	ClaudeWoW.Send("Those actions are allowed for this run. Continue from where you left off.", commands, { allowForThisRunOnly = true, onceDirs = dirs })
end

function ClaudeWoW.PassOnDenial(chatId, rules, reason)
	local c = FindChat(chatId)
	if not c or not rules or #rules == 0 then return end
	for _, m in ipairs(c.history) do m.denied = nil end
	Cli.Out(c, "Passed on: " .. ClaudeWoW.GrantsLabel(rules) .. (reason and (" (" .. reason .. ")") or ""))
	if c.plugin == LIVE_PLUGIN and not c.pendingId then
		Q.EndPromptWait(c)
		ClaudeWoW.Send(LIVE_PASS_TEXT, nil, { chat = c.id })
		return
	end
	ClaudeWoW.Render()
end

Q.ALLOW_POPUP = "CLAUDEWOW_ALLOW_ALWAYS"
Q.DENIAL_DETAILS_MAX = 6
Q.DENIAL_DETAIL_CHARS = 160
Q.STALE_DENIAL_TEXT = "That request was answered already."

function ClaudeWoW.IsLiveChat(chatOrId)
	local c = type(chatOrId) == "table" and chatOrId or FindChat(chatOrId)
	return c ~= nil and Cli.ChatPlugin(c) == LIVE_PLUGIN
end

function Q.DenialAgentName(c, agent)
	local name = ReplyAgentName(c, agent)
	if name == AgentName("") then return "this agent" end
	return Display(name)
end

function Q.GrantTarget(c)
	return ChatAgent(c), Cli.ChatPlugin(c)
end

function ClaudeWoW.GrantTarget(chatId)
	local c = FindChat(chatId)
	if not c then return nil end
	return Q.GrantTarget(c)
end

function Q.AlwaysTarget(c, rules, agent)
	local commands, dirs = ClaudeWoW.SplitGrants(rules)
	local target = Q.GrantTarget(c)
	local name = Q.DenialAgentName(c, target ~= "" and target or agent)
	if #dirs > 0 and #commands > 0 then return name .. " and this chat" end
	if #dirs > 0 then return "this chat" end
	return name
end

function ClaudeWoW.GrantText(chatId, kind, rules, agent)
	local c = FindChat(chatId)
	local live = ClaudeWoW.IsLiveChat(c)
	local commands, dirs = ClaudeWoW.SplitGrants(rules)
	local folderOnly = #dirs > 0 and #commands == 0
	if kind == "pass" then return "Deny it. The agent is not retried." end
	if kind == "greed" or (kind == "need" and live) then
		if folderOnly then return "Add the folder for this retry only. The chat's folders stay as they are." end
		return "Allow it for this retry only. Nothing is saved."
	end
	local target = Q.AlwaysTarget(c, rules, agent)
	if kind == "need" then
		if folderOnly then return "Add the folder always, for this chat, like /claude --add-dir, and retry." end
		return "Allow it always, for " .. target .. ". It is saved, so it is not asked again, and the agent retries."
	end
	if kind == "scope" then
		if live then return "Greed: for this retry only. Nothing is saved." end
		return "Greed: for this retry only. Need: always, for " .. target .. "."
	end
	if kind == "confirm" then
		local lines = { "Always allow this, for " .. target .. "?", "" }
		for _, rule in ipairs(rules or {}) do table.insert(lines, Display(ClaudeWoW.GrantLabel(rule))) end
		local details = ClaudeWoW.DenialDetails(chatId)
		if details[1] then table.insert(lines, "Command: " .. Display(details[1])) end
		table.insert(lines, "")
		local wide
		for _, rule in ipairs(commands) do
			local prefix = tostring(rule):match("^[%w_]+%((.-):%*%)$")
			if prefix then wide = wide or prefix end
		end
		if wide then table.insert(lines, "This covers every command that starts with " .. Display(wide) .. ".") end
		table.insert(lines, "It is saved, so it is not asked again. Greed allows it for this retry only.")
		return table.concat(lines, "\n")
	end
	return ""
end

function ClaudeWoW.DenialDetails(chatId)
	local c = FindChat(chatId)
	local m = c and not c.pendingId and c.history[Q.DenialIndex(c) or 0]
	local out = {}
	if not m or type(m.text) ~= "string" then return out end
	local inList = false
	for line in (m.text .. "\n"):gmatch("(.-)\r?\n") do
		if #out >= Q.DENIAL_DETAILS_MAX then break end
		local item = inList and line:match("^  (%S.*)$")
		if item then
			table.insert(out, item:sub(1, Q.DENIAL_DETAIL_CHARS))
		else
			inList = line:match("not allowed yet:%s*$") ~= nil or line:match("outside this chat's folders:%s*$") ~= nil
			local single = line:match("was not allowed to: (.+)$")
			if single then table.insert(out, single:sub(1, Q.DENIAL_DETAIL_CHARS)) end
		end
	end
	return out
end

function Q.SameRules(a, b)
	if type(a) ~= "table" or type(b) ~= "table" or #a ~= #b then return false end
	for i = 1, #a do
		if a[i] ~= b[i] then return false end
	end
	return true
end

function Q.SayAboutDenial(c, text)
	if c and Whisper.System(c, text) then return end
	ClaudeWoW.Print(text)
end

function ClaudeWoW.SayAboutDenial(chatId, text)
	Q.SayAboutDenial(FindChat(chatId), text)
end

function Q.GrantHeld()
	return ClaudeWoWRoll ~= nil and (ClaudeWoWRoll.Held() or ClaudeWoWRoll.Blocked() ~= nil)
end

function ClaudeWoW.AllowPending(chatId, msgId)
	local p = run.allowConfirm
	return p ~= nil and p.chatId == chatId and p.msgId == msgId
end

function ClaudeWoW.CancelAllow(data)
	if not data or run.allowConfirm ~= data then return false end
	run.allowConfirm = nil
	if ClaudeWoWRoll then ClaudeWoWRoll.Resume(data.chatId, data.msgId) end
	return true
end

function ClaudeWoW.AcceptAllow(data)
	if not data or run.allowConfirm ~= data then return false end
	run.allowConfirm = nil
	if Q.GrantHeld() then
		ClaudeWoWRoll.HoldGrant(data.chatId, data.msgId)
		return false
	end
	local rules, openId = ClaudeWoW.OpenDenial(data.chatId)
	local c = FindChat(data.chatId)
	local agent, plugin = Q.GrantTarget(c)
	local sameTarget = c ~= nil and agent == data.agent and plugin == data.plugin
	local fresh = rules ~= nil and openId == data.msgId and Q.SameRules(rules, data.rules) and sameTarget
	if fresh then AllowAlways(data.chatId, rules) end
	if ClaudeWoWRoll then ClaudeWoWRoll.Settle(data.chatId, data.msgId, fresh) end
	if not fresh then Q.SayAboutDenial(FindChat(data.chatId), Q.STALE_DENIAL_TEXT) end
	return fresh
end

function ClaudeWoW.ConfirmAllow(chatId, msgId, rules)
	local c = FindChat(chatId)
	local open, openId, deniedBy = ClaudeWoW.OpenDenial(chatId)
	if not c or not open or openId ~= msgId or not Q.SameRules(open, rules) then
		Q.SayAboutDenial(c, Q.STALE_DENIAL_TEXT)
		return false
	end
	if ClaudeWoW.IsLiveChat(c) then
		if Q.GrantHeld() then
			ClaudeWoWRoll.HoldGrant(chatId, msgId)
			return false
		end
		ClaudeWoW.AllowOnce(chatId, open)
		return true
	end
	if ClaudeWoW.AllowPending(chatId, msgId) then return true end
	local previous = run.allowConfirm
	if previous then
		run.allowConfirm = nil
		if ClaudeWoWRoll then ClaudeWoWRoll.Requeue(previous.chatId, previous.msgId) end
	end
	local copied = {}
	for i, rule in ipairs(open) do copied[i] = rule end
	local targetAgent, targetPlugin = Q.GrantTarget(c)
	local data = { chatId = chatId, msgId = msgId, rules = copied, agent = targetAgent, plugin = targetPlugin }
	run.allowConfirm = data
	if ClaudeWoWRoll then ClaudeWoWRoll.Park(chatId, msgId) end
	local dialog = StaticPopup_Show(Q.ALLOW_POPUP, ClaudeWoW.GrantText(chatId, "confirm", copied, deniedBy), nil, data)
	if not dialog then
		ClaudeWoW.CancelAllow(data)
		Q.SayAboutDenial(c, "The confirm dialog did not open. Close other dialogs and try again.")
		return false
	end
	dialog.data = data
	return true
end

StaticPopupDialogs[Q.ALLOW_POPUP] = {
	text = "%s",
	button1 = "Always Allow",
	button2 = CANCEL,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	showAlert = true,
	OnAccept = function(dialog, data) ClaudeWoW.AcceptAllow(data or (dialog and dialog.data)) end,
	OnCancel = function(dialog, data) ClaudeWoW.CancelAllow(data or (dialog and dialog.data)) end,
	OnHide = function(dialog) ClaudeWoW.CancelAllow(dialog and dialog.data) end,
}

function ClaudeWoW.ApplyLive(live)
	if type(live) ~= "table" then return end
	run.bridgeLive = {
		sessions = type(live.sessions) == "table" and live.sessions or {},
		start = type(live.start) == "string" and live.start or "",
	}
end

function ClaudeWoW.LiveStatus()
	local live = run.bridgeLive
	if not live then
		return { "Running Claude Code sessions: unknown until the companion app is heard from." }
	end
	if #live.sessions == 0 then
		local lines = { "No Claude Code session is running with the claude-wow channel. Start one in a terminal with:" }
		if live.start ~= "" then table.insert(lines, live.start) end
		table.insert(lines, "Then attach a chat to it: /claude -r <name>")
		return lines
	end
	local lines = { "Running Claude Code sessions (" .. #live.sessions .. "):" }
	for i, name in ipairs(live.sessions) do table.insert(lines, i .. ". " .. tostring(name)) end
	table.insert(lines, "Attach a chat to one: /claude -r <name>")
	return lines
end

function ClaudeWoW.ApplySessions(list, now)
	if type(list) ~= "table" then return end
	local clean = {}
	for _, e in ipairs(list) do
		if type(e) == "table" and (type(e.id) == "string" or type(e.name) == "string") then
			table.insert(clean, {
				id = type(e.id) == "string" and e.id or "",
				name = type(e.name) == "string" and e.name or "",
				cwd = type(e.cwd) == "string" and e.cwd or "",
				agent = type(e.agent) == "string" and e.agent or "",
				plugin = type(e.plugin) == "string" and e.plugin or "",
				chat = type(e.chat) == "string" and e.chat or "",
				at = tonumber(e.at) or 0,
				live = e.live == true,
				running = e.running == true or e.live == true,
				title = type(e.title) == "string" and e.title or "",
				branch = type(e.branch) == "string" and e.branch or "",
				restart = type(e.restart) == "string" and e.restart or "",
				handoff = e.handoff == true or nil,
				recap = type(e.recap) == "string" and e.recap ~= "" and e.recap or nil,
			})
		end
	end
	run.bridgeSessions = clean
	if type(now) == "number" then run.bridgeNow = now end
end

function Q.HasDenial(m)
	return type(m) == "table" and type(m.denied) == "table" and #m.denied > 0
end

function Q.DenialIndex(c)
	local history = c and c.history or {}
	for i = #history, 1, -1 do
		local m = history[i]
		if Q.HasDenial(m) then return i end
		if m.role ~= "system" then return nil end
	end
	return nil
end

function ClaudeWoW.OpenDenial(chatId)
	local c = FindChat(chatId)
	if not c or c.pendingId then return nil end
	local latest = c.history[Q.DenialIndex(c) or 0]
	if latest then
		return latest.denied, latest.id, latest.agent
	end
	return nil
end

function ClaudeWoW.LootRollEnabled()
	return db ~= nil and db.settings.lootRoll ~= false and ClaudeWoWRoll ~= nil
end

---------------------------------------------------------------------------
-- Chats
---------------------------------------------------------------------------

function ClaudeWoW.SwitchChat(id)
	local c = FindChat(id)
	if not c then return end
	local prev = ActiveChat()
	if prev and prev ~= c and ui.input then
		local typed = Trim(ui.input:GetText() or "")
		prev.draft = typed ~= "" and typed or nil
	end
	db.activeChat = c.id
	c.unread = 0
	ui.chatPage = nil
	if ui.input then
		ui.input:SetText(c.draft or "")
		c.draft = nil
	end
	ClaudeWoW.Render()
	ClaudeWoW.RenderChatList()
end

function ClaudeWoW.AddChat(name, fields)
	local c = AddChat(name)
	if not c then return nil end
	for k, v in pairs(fields or {}) do c[k] = v end
	ClaudeWoW.RenderChatList()
	return c
end

function ClaudeWoW.NewChat(name, prepare)
	local c = AddChat(name and name ~= "" and name or nil)
	if prepare then prepare(c) end
	ClaudeWoW.SwitchChat(c.id)
	Cli.Show(c)
	return c
end

Cli.PROJECTS_MAX = 20
Cli.NO_PROJECT = "No project"

Cli.SKILL_BUILTINS = { "runs", "stop" }
Cli.skillCommands = {}

function Cli.IsCodingChat(c)
	if not c then return false end
	local plugin = Cli.ChatPlugin(c)
	if plugin == "" then plugin = run.bridgePlugin or "" end
	return plugin == "claude-code"
end

function Cli.SlashNames()
	local names = {}
	if #(run.bridgeSkills or {}) == 0 then return names end
	for _, s in ipairs(Cli.SKILL_BUILTINS) do table.insert(names, s) end
	for _, s in ipairs(run.bridgeSkills) do
		if not Contains(names, s) then table.insert(names, s) end
	end
	return names
end

function Cli.SlashTaken(cmd)
	for _, list in ipairs({ SlashCmdList or {}, SecureCmdList or {} }) do
		for key in pairs(list) do
			for i = 1, 20 do
				local v = _G["SLASH_" .. key .. i]
				if v == nil then break end
				if type(v) == "string" and v:lower() == cmd then return true end
			end
		end
	end
	return false
end

function Cli.RunSkillCommand(name, msg, editBox)
	if not db then return end
	if not Contains(Cli.SlashNames(), name) then
		TellPlayer("/" .. name .. " is not a factory skill in this companion app right now.")
		return
	end
	local chat = editBox and Whisper.ChatForBox(editBox) or nil
	if not Cli.IsCodingChat(chat) then chat = ActiveChat() end
	if not Cli.IsCodingChat(chat) then
		TellPlayer("/" .. name .. " runs in a coding chat. Pick a project for this chat first (/claude --project <name>).")
		return
	end
	if db.activeChat ~= chat.id then ClaudeWoW.SwitchChat(chat.id) end
	local args = Trim(tostring(msg or ""))
	ClaudeWoW.Send("/" .. name .. (args ~= "" and (" " .. args) or ""))
end

function Cli.RegisterSkillCommand(name)
	if Cli.skillCommands[name] ~= nil or type(SlashCmdList) ~= "table" then return end
	local cmd = "/" .. name
	if Cli.SlashTaken(cmd) then
		Cli.skillCommands[name] = false
		return
	end
	local key = "CLAUDEWOW_SKILL_" .. name:upper():gsub("[^%w]", "_")
	_G["SLASH_" .. key .. "1"] = cmd
	SlashCmdList[key] = function(msg, editBox) Cli.RunSkillCommand(name, msg, editBox) end
	Cli.skillCommands[name] = true
end

function ClaudeWoW.ApplySkills(list)
	local skills = {}
	for _, s in ipairs(type(list) == "table" and list or {}) do
		if type(s) == "string" and #s <= 64 and s:match("^[%l%d][%l%d:_%-]*$") then table.insert(skills, s) end
	end
	run.bridgeSkills = skills
	for _, s in ipairs(Cli.SlashNames()) do Cli.RegisterSkillCommand(s) end
end

function Cli.CompleteSlash(box)
	local typed = tostring(box:GetText() or ""):match("^/([%w:_%-]*)$")
	local c = ActiveChat()
	if not typed or not Cli.IsCodingChat(c) then return end
	local names = Cli.SlashNames()
	if #names == 0 then return end
	typed = typed:lower()
	local hits = {}
	for _, n in ipairs(names) do
		if n:sub(1, #typed) == typed then table.insert(hits, n) end
	end
	if #hits == 0 then
		Cli.Out(c, "No command starts with /" .. typed .. ". Commands: /" .. table.concat(names, ", /"))
		return
	end
	local prefix = hits[1]
	for _, n in ipairs(hits) do
		while n:sub(1, #prefix) ~= prefix do prefix = prefix:sub(1, -2) end
	end
	if #hits == 1 then prefix = prefix .. " " end
	if #prefix > #typed then
		box:SetText("/" .. prefix)
		box:SetCursorPosition(#prefix + 1)
	else
		Cli.Out(c, "Commands: /" .. table.concat(hits, ", /"))
	end
end

function Cli.ProjectOf(c)
	if not c then return "" end
	if c.cwd and c.cwd ~= "" then return c.cwd end
	if Cli.ChatPlugin(c) == "claude-code" then return run.bridgeCwd or "" end
	return ""
end

function Cli.KnownProjects()
	local out, seen = {}, {}
	local function Add(p)
		if type(p) ~= "string" or p == "" or #out >= Cli.PROJECTS_MAX then return end
		local key = Cli.NormalizeFolder(p)
		if seen[key] then return end
		seen[key] = true
		table.insert(out, key)
	end
	for _, p in ipairs(db.settings.projects or {}) do Add(p) end
	for _, c in ipairs(db.chats) do Add(Cli.ProjectOf(c)) end
	Add(run.bridgeCwd)
	for _, p in ipairs(run.bridgeProjects or {}) do Add(p) end
	return out
end

function ClaudeWoW.ApplyProjects(projects, home)
	if type(home) == "string" and home ~= "" then run.bridgeHome = home end
	if type(projects) ~= "table" then return end
	local list, labels = {}, {}
	for _, p in ipairs(projects) do
		if type(p) == "table" and type(p.path) == "string" and p.path ~= "" then
			table.insert(list, p.path)
			if type(p.label) == "string" and p.label ~= "" then labels[Cli.NormalizeFolder(p.path)] = p.label end
		end
	end
	run.bridgeProjects, run.bridgeProjectLabels = list, labels
end

function Cli.RememberProject(path)
	local list = { path }
	for _, p in ipairs(db.settings.projects or {}) do
		if p ~= path and #list < Cli.PROJECTS_MAX then table.insert(list, p) end
	end
	db.settings.projects = list
end

function Cli.FindProject(name)
	name = Trim(tostring(name or ""))
	if name == "" then return nil end
	local lower = name:lower()
	for _, p in ipairs(Cli.KnownProjects()) do
		if p == name or FolderName(p):lower() == lower then return p end
	end
	return nil
end

function Cli.ProjectNames()
	local names = {}
	for _, p in ipairs(Cli.KnownProjects()) do table.insert(names, FolderName(p)) end
	return #names > 0 and table.concat(names, ", ") or "none yet"
end

function Cli.IsNoProject(value)
	value = Trim(tostring(value or "")):lower()
	return value == "" or value == "none" or value == "-" or value == "default"
end

function Cli.ResolveProject(value)
	value = Trim(tostring(value or ""))
	if Cli.IsNoProject(value) then return "" end
	return Cli.FindProject(value) or (value:find("[\\/~]") and value) or nil
end

function Cli.SetProject(c, value)
	local path = Cli.ResolveProject(value)
	if not path then return nil, "Unknown project \"" .. tostring(value) .. "\". Known: " .. Cli.ProjectNames() .. ". Or give a path." end
	c.cwd = path
	Cli.KeepPlayerRoute(c)
	if c.plugin ~= "" and c.plugin ~= LIVE_PLUGIN then c.plugin = "" end
	if path ~= "" then Cli.RememberProject(path) end
	return path == "" and Cli.NO_PROJECT or FolderName(path)
end

function Cli.ProjectTag(c, text)
	for tag in text:gmatch("#([%w%._%-]+)") do
		local path = Cli.FindProject(tag)
		if path then
			if Cli.ProjectOf(c) ~= path then
				Cli.SetProject(c, path)
				Cli.Note(c, "project: " .. FolderName(path))
			end
			local escaped = ("#" .. tag):gsub("%p", "%%%0")
			return (text:gsub(escaped, tag, 1))
		end
	end
	return text
end

function Cli.ProjectLabel(c)
	local path = Cli.ProjectOf(c)
	return path == "" and Cli.NO_PROJECT or FolderName(path)
end

function Cli.PickProject(c, value)
	local note, err = Cli.SetProject(c, value)
	if err then Cli.Out(c, err) else Cli.Note(c, "project: " .. note) end
	ClaudeWoW.Render()
end

function Cli.ParentName(path)
	local parent = tostring(path or ""):gsub("[\\/]+$", ""):match("^(.*)[\\/][^\\/]+$")
	return parent and FolderName(parent) or ""
end

function Cli.ProjectMenuLabels(paths)
	local function Counts(labels)
		local n = {}
		for _, l in ipairs(labels) do n[l] = (n[l] or 0) + 1 end
		return n
	end
	local labels = {}
	for i, p in ipairs(paths) do labels[i] = FolderName(p) end
	local plain = Counts(labels)
	for i, p in ipairs(paths) do
		local parent = Cli.ParentName(p)
		if plain[labels[i]] > 1 and parent ~= "" then labels[i] = labels[i] .. " (" .. parent .. ")" end
	end
	local qualified = Counts(labels)
	for i, p in ipairs(paths) do
		if qualified[labels[i]] > 1 then labels[i] = p end
	end
	return labels
end

function Cli.ProjectMenuItems(c)
	local function Current() return Cli.NormalizeFolder(Cli.ProjectOf(c)) end
	local items = {
		{ title = "Project" },
		{ text = Cli.NO_PROJECT, radio = true, selected = function() return Current() == "" end, fn = function() Cli.PickProject(c, "none") end },
	}
	local paths = Cli.KnownProjects()
	local labels = Cli.ProjectMenuLabels(paths)
	for i, p in ipairs(paths) do
		table.insert(items, { text = Display(labels[i]), radio = true, selected = function() return Current() == p end, fn = function() Cli.PickProject(c, p) end })
	end
	return items
end

function Cli.ProjectMenu(anchor)
	local c = ActiveChat()
	if not c then return end
	Q.ShowMenu(anchor, Cli.ProjectMenuItems(c), "project", true)
end

Cli.EFFORT_CHOICES = { "low", "medium", "high", "xhigh", "max" }
Cli.EFFORT_AUTO = "auto"
Cli.EFFORT_LEVEL_OF = { minimal = 0, low = 1, medium = 2, high = 3, xhigh = 4, max = 5, ultra = 5 }
Cli.EFFORT_BAR_W = 3
Cli.EFFORT_BAR_GAP = 2
Cli.EFFORT_BAR_MIN_H = 4
Cli.EFFORT_BAR_MAX_H = 14
Cli.EFFORT_WORD_GAP = 4
Cli.EFFORT_PAD = 2
Cli.EFFORT_GOLD = { 1, 0.82, 0, 1 }
Cli.EFFORT_DIM = { 0.4, 0.4, 0.4, 0.55 }
Cli.EFFORT_OFF = { 0.25, 0.25, 0.25, 0.45 }

function Cli.EffortPlugin(c)
	local p = Cli.ChatPlugin(c)
	if p == "" then p = run.bridgePlugin or "" end
	return p
end

function Cli.EffortState(c)
	local agent = ChatAgent(c)
	local plugin = Cli.EffortPlugin(c)
	if c and plugin == LIVE_PLUGIN then return { supported = false, agent = agent, why = "live" } end
	local rows = type(run.bridgeEfforts) == "table" and run.bridgeEfforts or nil
	local row = rows and (rows[plugin] or rows[run.bridgePlugin or ""])
	if type(row) == "table" and agent ~= "" and row[agent] == nil then return { supported = false, agent = agent, why = "agent" } end
	local lock = type(run.bridgeEffortLock) == "table" and run.bridgeEffortLock[agent]
	if type(lock) == "string" and lock ~= "" then return { supported = true, agent = agent, value = lock, source = "lock" } end
	local own = c and c.effort
	if own and own ~= "" then return { supported = true, agent = agent, value = own, source = "chat" } end
	local bridge = type(row) == "table" and row[agent]
	if type(bridge) == "string" and bridge ~= "" then return { supported = true, agent = agent, value = bridge, source = "bridge" } end
	return { supported = true, agent = agent, value = Cli.EFFORT_AUTO, source = rows and "agent" or "unknown" }
end

function ClaudeWoW.ApplyEfforts(data)
	if type(data) ~= "table" or type(data.efforts) ~= "table" then return end
	run.bridgeEfforts = data.efforts
	run.bridgeEffortLock = type(data.effortLock) == "table" and data.effortLock or nil
	Cli.UpdateEffortButton()
end

function Cli.EffortLabel(c)
	local s = Cli.EffortState(c)
	return s.supported and s.value or "none"
end

function Cli.EffortLevel(value)
	return Cli.EFFORT_LEVEL_OF[value or ""] or 0
end

function Cli.PickEffort(c, value)
	c.effort = (value and value ~= "") and value or nil
	Cli.Out(c, "effort: " .. Cli.EffortLabel(c))
	Cli.UpdateEffortButton()
end

function Cli.EffortBars(b)
	if b.bars then return b.bars end
	b.bars = {}
	local n = #Cli.EFFORT_CHOICES
	for i = 1, n do
		local bar = b:CreateTexture(nil, "ARTWORK")
		local h = Cli.EFFORT_BAR_MIN_H + math.floor((Cli.EFFORT_BAR_MAX_H - Cli.EFFORT_BAR_MIN_H) * (i - 1) / (n - 1) + 0.5)
		bar:SetSize(Cli.EFFORT_BAR_W, h)
		bar:SetPoint("BOTTOMRIGHT", b, "BOTTOMRIGHT", -Cli.EFFORT_PAD - (n - i) * (Cli.EFFORT_BAR_W + Cli.EFFORT_BAR_GAP), 1)
		b.bars[i] = bar
	end
	return b.bars
end

function Cli.EffortBarsWidth()
	local n = #Cli.EFFORT_CHOICES
	return n * Cli.EFFORT_BAR_W + (n - 1) * Cli.EFFORT_BAR_GAP
end

function Cli.PaintEffortBars(b, filled, supported)
	for i, bar in ipairs(Cli.EffortBars(b)) do
		local color = not supported and Cli.EFFORT_OFF or (i <= filled and Cli.EFFORT_GOLD or Cli.EFFORT_DIM)
		bar:SetColorTexture(color[1], color[2], color[3], color[4])
		bar.filled = supported and i <= filled
	end
end

function Cli.LayoutEffortWord(b)
	local text = b.text
	local barsRight = Cli.EFFORT_PAD + Cli.EffortBarsWidth() + Cli.EFFORT_WORD_GAP
	text:ClearAllPoints()
	text:SetPoint("RIGHT", b, "RIGHT", -barsRight, 0)
	text:SetWidth(0)
	local room = (Try(b.GetWidth, b) or 0) - barsRight - Cli.EFFORT_PAD
	local need = Try(text.GetStringWidth, text) or 0
	b.wordShown = b.word ~= "" and need <= room
	text:SetShown(b.wordShown)
end

function Cli.UpdateEffortButton()
	local b = ui.effort
	if not b then return end
	local s = Cli.EffortState(ActiveChat())
	b.state = s
	b.fullName = s.supported and s.value or "none"
	b.word = s.supported and s.value or ""
	local color = (s.supported and s.source ~= "agent" and s.source ~= "unknown") and "|cffffffff" or "|cff9d9d9d"
	b.text:SetText(b.word ~= "" and (color .. b.word .. "|r") or "")
	Cli.PaintEffortBars(b, s.supported and Cli.EffortLevel(s.value) or 0, s.supported)
	Cli.LayoutEffortWord(b)
	b:SetEnabled(s.supported)
end

Cli.EFFORT_SOURCE_NOTE = {
	chat = "Set for this chat.",
	bridge = "The companion app's setting for this agent.",
	lock = "Fixed by a setting on your computer, so you cannot change it here.",
	agent = "The agent picks its own level.",
	unknown = "Update the companion app to see the real value.",
}

function Cli.EffortButtonTooltip(b)
	local s = b.state or Cli.EffortState(ActiveChat())
	GameTooltip:SetOwner(b, "ANCHOR_TOP")
	if not s.supported then
		GameTooltip:SetText("Effort")
		local what = s.why == "live" and "A running session keeps its own effort." or (AgentName(s.agent) .. " has no effort setting.")
		GameTooltip:AddLine(what, 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
		return
	end
	GameTooltip:SetText("Effort: " .. s.value)
	GameTooltip:AddLine(Cli.EFFORT_SOURCE_NOTE[s.source] or "", 0.8, 0.8, 0.8, true)
	if s.source ~= "lock" then GameTooltip:AddLine("How hard the agent thinks in this chat. Click to change it, or use /claude --effort <level>.", 0.8, 0.8, 0.8, true) end
	GameTooltip:Show()
end

function Cli.EffortAutoLabel(c)
	local saved = c.effort
	c.effort = nil
	local s = Cli.EffortState(c)
	c.effort = saved
	return s.value == Cli.EFFORT_AUTO and "Auto" or ("Auto (" .. s.value .. ")")
end

function Cli.EffortMenuItems(c)
	local function Changeable() return Cli.EffortState(c).source ~= "lock" end
	local items = {
		{ title = "Effort" },
		{ text = Cli.EffortAutoLabel(c), radio = true, enabled = Changeable, selected = function() return (c.effort or "") == "" end, fn = function() Cli.PickEffort(c, nil) end },
	}
	for _, e in ipairs(Cli.EFFORT_CHOICES) do
		table.insert(items, { text = e, radio = true, enabled = Changeable, selected = function() return c.effort == e end, fn = function() Cli.PickEffort(c, e) end })
	end
	return items
end

function Cli.EffortMenu(anchor)
	local c = ActiveChat()
	if not c or not Cli.EffortState(c).supported then return end
	Q.ShowMenu(anchor, Cli.EffortMenuItems(c), "effort", true)
end

Cli.PROJECT_W_MIN = 60
Cli.PROJECT_W_MAX = 240
Cli.PROJECT_PAD = 8
Cli.HEADER_TITLE_MIN = 80

function Cli.HeaderLabelWidth(b, text)
	b.text:SetWidth(0)
	b.text:SetText(text)
	return (Try(b.text.GetStringWidth, b.text) or 100) + Cli.PROJECT_PAD
end

function Cli.HeaderRoom(host)
	local hostWidth = (host and Try(host.GetWidth, host)) or 0
	if ui.chatTitle then return hostWidth - 2 * Cli.PROJECT_PAD - Cli.HEADER_TITLE_MIN end
	return hostWidth - 2 * Cli.PROJECT_PAD
end

function Cli.HeaderSlots()
	local slots = {}
	for _, spec in ipairs({
		{ b = ui.projectButton, label = "Project: ", min = Cli.PROJECT_W_MIN, max = Cli.PROJECT_W_MAX },
		{ b = ui.mcpButton, fixed = true },
	}) do
		if spec.b and spec.b.wanted then table.insert(slots, spec) end
	end
	return slots
end

function Cli.MeasureHeaderSlot(slot)
	local b = slot.b
	if slot.fixed then
		slot.full = Cli.HeaderLabelWidth(b, b.fullText)
		slot.short, slot.min, slot.max = slot.full, slot.full, slot.full
		return
	end
	slot.full = Cli.HeaderLabelWidth(b, slot.label .. "|cffffffff" .. b.fullName .. "|r")
	slot.short = Cli.HeaderLabelWidth(b, "|cffffffff" .. b.fullName .. "|r")
end

function Cli.HeaderSlotFloor(slot)
	return slot.compact and math.min(slot.min, slot.short) or slot.min
end

function Cli.HeaderSlotWidth(slot)
	local natural = slot.compact and slot.short or slot.full
	return math.min(slot.max, math.max(Cli.HeaderSlotFloor(slot), natural)), natural
end

function Cli.HeaderTotal(slots)
	local total = 0
	for i, slot in ipairs(slots) do
		if not slot.hidden then
			total = total + (slot.width or Cli.HeaderSlotWidth(slot)) + (i > 1 and Cli.PROJECT_PAD or 0)
		end
	end
	return total
end

function Cli.FitHeaderSlots(slots, room)
	for _, i in ipairs({ 2, 1 }) do
		if Cli.HeaderTotal(slots) <= room then return end
		if slots[i] and not slots[i].fixed then slots[i].compact = true end
	end
	for _, i in ipairs({ 1, 2 }) do
		local slot = slots[i]
		local over = Cli.HeaderTotal(slots) - room
		if over <= 0 then return end
		if slot and not slot.fixed then slot.width = math.max(Cli.HeaderSlotFloor(slot), Cli.HeaderSlotWidth(slot) - over) end
	end
	for i = #slots, 2, -1 do
		if Cli.HeaderTotal(slots) <= room then return end
		slots[i].hidden = true
	end
end

function Cli.LayoutHeaderButtons()
	local project = ui.projectButton
	if not project then return end
	local slots = Cli.HeaderSlots()
	for _, slot in ipairs(slots) do Cli.MeasureHeaderSlot(slot) end
	Cli.FitHeaderSlots(slots, Cli.HeaderRoom(project:GetParent()))
	local leftmost = project
	for _, b in ipairs({ ui.mcpButton }) do
		if b then b:Hide() end
	end
	for _, slot in ipairs(slots) do
		local b = slot.b
		if not slot.hidden then
			local width, natural = Cli.HeaderSlotWidth(slot)
			width = slot.width or width
			b.truncated = natural > width
			b.text:SetWidth(0)
			b.text:SetText(slot.fixed and b.fullText or ((slot.compact and "" or slot.label) .. "|cffffffff" .. b.fullName .. "|r"))
			b:SetWidth(width)
			b.text:SetWidth(width - Cli.PROJECT_PAD)
			if b ~= project then
				b:ClearAllPoints()
				b:SetPoint("RIGHT", leftmost, "LEFT", -Cli.PROJECT_PAD, 0)
				b:Show()
			end
			leftmost = b
		end
	end
	if ui.titleBar and ui.chatTitle then ui.chatTitle:SetPoint("RIGHT", leftmost, "LEFT", -Cli.PROJECT_PAD, 0) end
end

function Cli.UpdateProjectButton()
	local b = ui.projectButton
	if not b then return end
	b.fullName = Display(Cli.ProjectLabel(ActiveChat()))
	b.wanted = true
	Cli.LayoutHeaderButtons()
end

function Cli.ProjectButtonTooltip(b)
	GameTooltip:SetOwner(b, ui.chatTitle and "ANCHOR_BOTTOMRIGHT" or "ANCHOR_TOP")
	GameTooltip:SetText("Project: " .. (b.fullName or Cli.NO_PROJECT))
	GameTooltip:AddLine("The repo this chat works in. No project = a general chat. You can also type #name in a message or use /claude --project <name>.", 0.8, 0.8, 0.8, true)
	GameTooltip:Show()
end

Cli.MCP_MAX = 16
Cli.MCP_LIST_MAX = 64
Cli.MCP_AGENTS = { claude = true, codex = true }
Cli.CONTRACT_NAMES = { claude = "Claude Code", codex = "Codex" }
Cli.MCP_HEALTH = {
	connected = { "ok", "33cc33" },
	["needs-auth"] = { "needs login", "ff9933" },
	failed = { "failed", "ff4444" },
	pending = { "starting", "999999" },
	unknown = { "not seen yet", "999999" },
}
Cli.MCP_SOURCES = {
	{ "config", "From config.json" },
	{ "claude", "Your Claude servers" },
	{ "plugin", "Claude plugins" },
	{ "claude.ai", "claude.ai connectors" },
	{ "codex", "Your Codex servers" },
}

function ClaudeWoW.ApplyMcp(list)
	if type(list) ~= "table" then
		run.bridgeMcp = nil
		Cli.UpdateMcpButton()
		return
	end
	local known = {}
	for _, src in ipairs(Cli.MCP_SOURCES) do known[src[1]] = true end
	local out = {}
	for _, s in ipairs(list) do
		if #out >= Cli.MCP_LIST_MAX then break end
		if type(s) == "table" and type(s.id) == "string" and #s.id <= 64 and s.id:match("^[%w_%-]+$") and known[s.src] then
			local label = type(s.label) == "string" and s.label:gsub("[%c|]", ""):sub(1, 64) or ""
			local health = (type(s.health) == "string" and Cli.MCP_HEALTH[s.health]) and s.health or "unknown"
			table.insert(out, { id = s.id, label = label ~= "" and label or s.id, src = s.src, on = s.on == true, health = health })
		end
	end
	run.bridgeMcp = out
	for _, c in ipairs(db and db.chats or {}) do
		if type(c.mcp) == "table" then
			local set = {}
			for _, id in ipairs(c.mcp) do
				if type(id) == "string" then set[id] = true end
			end
			c.mcp, c.mcpSet, c.mcpAllOff = nil, next(set) and set or nil, true
		end
	end
	Cli.UpdateMcpButton()
end

function ClaudeWoW.ApplyContract(t)
	if type(t) ~= "table" then
		run.bridgeContract = nil
		Cli.UpdateMcpButton()
		return
	end
	local known = {}
	for _, src in ipairs(Cli.MCP_SOURCES) do known[src[1]] = true end
	local out = {}
	for id in pairs(Cli.CONTRACT_NAMES) do
		local e = t[id]
		if type(e) == "table" then
			local version = type(e.version) == "string" and (e.version:gsub("[%c|]", "")):sub(1, 40) or ""
			local reason = type(e.reason) == "string" and (e.reason:gsub("[%c|]", "")):sub(1, 400) or ""
			local sources
			if type(e.sources) == "table" then
				sources = {}
				for _, src in ipairs(e.sources) do
					if known[src] then sources[src] = true end
				end
			end
			out[id] = { version = version, checked = e.checked == true, off = e.off ~= false, reason = reason, sources = sources }
		end
	end
	run.bridgeContract = out
	Cli.UpdateMcpButton()
end

function Cli.McpContract(c)
	return run.bridgeContract and run.bridgeContract[ChatAgent(c)] or nil
end

function Cli.McpOffBlocked(c, s)
	local e = Cli.McpContract(c)
	if not (e and e.off == false) then return nil end
	if s and e.sources and not e.sources[s.src] then return nil end
	if e.reason ~= "" then return e.reason end
	return ChatAgentName(c) .. " failed the MCP off check in claude-wow agents check, so this companion app cannot turn a server off."
end

function Cli.McpAllOffBlocked(c)
	for _, s in ipairs(run.bridgeMcp or {}) do
		local blocked = Cli.McpOffBlocked(c, s)
		if blocked then return blocked end
	end
end

function Cli.McpContractNote(c)
	local e = Cli.McpContract(c)
	if not e or e.checked then return nil end
	return "Not checked on " .. Cli.CONTRACT_NAMES[ChatAgent(c)] .. (e.version ~= "" and (" " .. e.version) or "") .. ": run claude-wow agents check"
end

function Cli.McpUnsupported(c)
	local agent = ChatAgent(c)
	return agent ~= "" and not Cli.MCP_AGENTS[agent]
end

function Cli.McpOn(c, s)
	if c and type(c.mcpSet) == "table" and c.mcpSet[s.id] ~= nil then return c.mcpSet[s.id] end
	if c and c.mcpAllOff then return false end
	return s.on
end

function Cli.McpChoiceParts(c)
	local parts = {}
	if not c then return parts end
	if c.mcpAllOff then table.insert(parts, "-*") end
	local ids = {}
	for _, s in ipairs(run.bridgeMcp or {}) do
		if type(c.mcpSet) == "table" and c.mcpSet[s.id] ~= nil then table.insert(ids, s.id) end
	end
	table.sort(ids)
	for _, id in ipairs(ids) do table.insert(parts, (c.mcpSet[id] and "+" or "-") .. id) end
	return parts
end

function Cli.McpToken(c)
	if not (c and run.bridgeMcp) then return "" end
	local parts = Cli.McpChoiceParts(c)
	if #parts == 0 then return "" end
	return "mcp=" .. table.concat(parts, ",")
end

function Cli.McpCounts(c)
	local on = 0
	for _, s in ipairs(run.bridgeMcp or {}) do
		if Cli.McpOn(c, s) then on = on + 1 end
	end
	return on, #(run.bridgeMcp or {})
end

function Cli.McpHealthText(s)
	local h = Cli.MCP_HEALTH[s.health] or Cli.MCP_HEALTH.unknown
	return "|cff" .. h[2] .. h[1] .. "|r"
end

function Cli.McpMissing()
	if not run.bridgeMcp then
		if not ClaudeWoW.IsConnected() then return "not connected to the companion app yet." end
		return "this companion app sends no MCP server list. Update the companion app (claude-wow update) and reconnect."
	end
	if #run.bridgeMcp == 0 then return "the companion app sees no MCP servers: none in your Claude or Codex setup, or in mcp.servers in its config.json." end
end

function Cli.McpFind(name)
	name = tostring(name or "")
	for _, s in ipairs(run.bridgeMcp or {}) do
		if s.id == name then return s end
	end
	local want = name:lower()
	for _, field in ipairs({ "id", "label" }) do
		local hits, ids = {}, {}
		for _, s in ipairs(run.bridgeMcp or {}) do
			if s[field]:lower() == want then
				table.insert(hits, s)
				table.insert(ids, s.id)
			end
		end
		if #hits > 1 then return nil, "more than one server is called " .. name .. "; name one of " .. table.concat(ids, ", ") .. "." end
		if hits[1] then return hits[1] end
	end
end

function Cli.SetMcp(c, name, on)
	local missing = Cli.McpMissing()
	if missing then return nil, missing end
	local s, ambiguous = Cli.McpFind(name)
	if ambiguous then return nil, ambiguous end
	if not s then return nil, "no MCP server named \"" .. tostring(name) .. "\" (servers: " .. Cli.McpNames() .. ")." end
	local blocked = not on and Cli.McpOffBlocked(c, s)
	if blocked then return nil, blocked end
	local set = {}
	for id, v in pairs(c.mcpSet or {}) do set[id] = v end
	local plain = s.on
	if c.mcpAllOff then plain = false end
	if on == plain and on then set[s.id] = nil else set[s.id] = on end
	local count = 0
	for _ in pairs(set) do count = count + 1 end
	local before = c.mcpSet
	c.mcpSet = set
	if count > Cli.MCP_MAX then
		c.mcpSet = before
		return nil, "this chat already changes " .. Cli.MCP_MAX .. " servers. Use /claude mcp none, then turn on the ones you want, or /claude mcp default."
	end
	if next(set) == nil then c.mcpSet = nil end
	return s.label .. " is " .. (on and "on" or "off") .. " for this chat."
end

function Cli.McpNames()
	local names = {}
	for _, s in ipairs(run.bridgeMcp or {}) do table.insert(names, s.label) end
	return #names > 0 and table.concat(names, ", ") or "none"
end

function Cli.McpGroups()
	local groups = {}
	for _, src in ipairs(Cli.MCP_SOURCES) do
		local rows = {}
		for _, s in ipairs(run.bridgeMcp or {}) do
			if s.src == src[1] then table.insert(rows, s) end
		end
		if #rows > 0 then table.insert(groups, { title = src[2], rows = rows }) end
	end
	return groups
end

function Cli.McpReport(c)
	local missing = Cli.McpMissing()
	if missing then return "MCP: " .. missing end
	local custom = c.mcpAllOff or type(c.mcpSet) == "table"
	local lines = { "MCP servers for this chat" .. (custom and "" or " (the defaults)") .. ":" }
	for _, g in ipairs(Cli.McpGroups()) do
		table.insert(lines, g.title .. ":")
		for _, s in ipairs(g.rows) do
			table.insert(lines, "  " .. (Cli.McpOn(c, s) and "on   " or "off  ") .. s.label .. "  " .. Cli.McpHealthText(s))
		end
	end
	if Cli.McpUnsupported(c) then table.insert(lines, ChatAgentName(c) .. " does not use MCP servers; this list applies to Claude and Codex chats.") end
	local contractLine = Cli.McpAllOffBlocked(c) or Cli.McpContractNote(c)
	if contractLine then table.insert(lines, contractLine) end
	table.insert(lines, "/claude mcp on|off <name> changes one; /claude mcp none turns all off; /claude mcp default goes back to the defaults.")
	return table.concat(lines, "\n")
end

function Cli.McpCommand(c, rest)
	if not c then return end
	rest = Trim(rest or "")
	local word = rest:lower()
	if word == "" then
		Cli.Say(c, Cli.McpReport(c))
	elseif word == "default" then
		c.mcpSet, c.mcpAllOff = nil, nil
		Cli.Out(c, "MCP: this chat uses the default servers again.")
	elseif word == "none" then
		local missing = Cli.McpMissing() or Cli.McpAllOffBlocked(c)
		if not missing then c.mcpSet, c.mcpAllOff = nil, true end
		Cli.Out(c, "MCP: " .. (missing or "every server is off for this chat."))
	else
		local verb, name = rest:match("^(%S+)%s+(.+)$")
		local note, err = Cli.SetMcp(c, name, verb:lower() == "on")
		Cli.Out(c, "MCP: " .. (err or note))
	end
end

function Cli.IsMcpCommand(rest)
	rest = Trim(rest or ""):lower()
	if rest == "" or rest == "default" or rest == "none" then return true end
	local verb, name = rest:match("^(%S+)%s+(.+)$")
	return (verb == "on" or verb == "off") and name ~= nil
end

function Cli.McpMenu(anchor)
	local c = ActiveChat()
	if not c then return end
	if not Cli.McpMissing() and type(MenuUtil) == "table" and type(MenuUtil.CreateContextMenu) == "function" then
		local shown = pcall(MenuUtil.CreateContextMenu, anchor, function(_, root)
			local blocked = Cli.McpAllOffBlocked(c)
			local note = Cli.McpContractNote(c)
			if blocked then root:CreateTitle("|cffff9933Turning a server off is disabled: " .. ChatAgentName(c) .. " failed the MCP check|r") end
			if note then root:CreateTitle("|cff999999" .. note .. "|r") end
			local function grey(item, off) if off and type(item) == "table" and type(item.SetEnabled) == "function" then item:SetEnabled(false) end end
			for _, g in ipairs(Cli.McpGroups()) do
				root:CreateTitle(g.title)
				for _, s in ipairs(g.rows) do
					local item = root:CreateCheckbox(s.label .. "  " .. Cli.McpHealthText(s), function() return Cli.McpOn(c, s) end, function()
						local _, err = Cli.SetMcp(c, s.id, not Cli.McpOn(c, s))
						if err then Cli.Out(c, "MCP: " .. err) end
						ClaudeWoW.Render()
					end)
					if Cli.McpOn(c, s) then grey(item, Cli.McpOffBlocked(c, s)) end
				end
			end
			root:CreateDivider()
			grey(root:CreateButton("Turn all off", function() Cli.McpCommand(c, "none") end), blocked)
			root:CreateButton("Use the defaults", function() Cli.McpCommand(c, "default") end)
		end)
		if shown then return end
	end
	Cli.Say(c, Cli.McpReport(c))
end

function Cli.UpdateMcpButton()
	local b = ui.mcpButton
	if not b then return end
	local c = ActiveChat()
	local on, total = Cli.McpCounts(c)
	b.wanted = c ~= nil and total > 0
	if not b.wanted then
		Cli.LayoutHeaderButtons()
		return
	end
	local warn = false
	for _, s in ipairs(run.bridgeMcp) do
		if Cli.McpOn(c, s) and (s.health == "failed" or s.health == "needs-auth") then warn = true end
	end
	local color = Cli.McpUnsupported(c) and "999999" or (warn and "ff9933" or "ffffff")
	b.fullText = "MCP |cff" .. color .. on .. "/" .. total .. "|r"
	Cli.LayoutHeaderButtons()
end

function Cli.McpButtonTooltip(b)
	local c = ActiveChat()
	GameTooltip:SetOwner(b, ui.chatTitle and "ANCHOR_BOTTOMRIGHT" or "ANCHOR_TOP")
	GameTooltip:SetText("MCP servers")
	local on, total = Cli.McpCounts(c)
	GameTooltip:AddLine(on .. " of " .. total .. " on for this chat. Your own Claude and Codex servers are on unless you turn them off here.", 0.8, 0.8, 0.8, true)
	local warn = {}
	for _, s in ipairs(run.bridgeMcp or {}) do
		if Cli.McpOn(c, s) and (s.health == "failed" or s.health == "needs-auth") then table.insert(warn, s.label .. ": " .. Cli.McpHealthText(s)) end
	end
	for _, line in ipairs(warn) do GameTooltip:AddLine(line, 1, 1, 1) end
	if c and Cli.McpUnsupported(c) then GameTooltip:AddLine(ChatAgentName(c) .. " does not use MCP servers.", 1, 0.6, 0.2, true) end
	local contractLine = c and (Cli.McpAllOffBlocked(c) or Cli.McpContractNote(c))
	if contractLine then GameTooltip:AddLine(contractLine, 1, 0.6, 0.2, true) end
	GameTooltip:AddLine("Click to turn servers on or off for this chat.", 0.8, 0.8, 0.8, true)
	GameTooltip:Show()
end

-- Folder this chat's agent works in. Empty (or "-" / "default") = the bridge's
-- default. Relative paths are resolved by the bridge against that default.
function ClaudeWoW.SetFolder(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or "")
	if rest ~= "" or (c.cwd or "") ~= "" then Cli.KeepPlayerRoute(c) end
	if rest == "-" or rest == "default" then rest = "" end
	local base = run.bridgeCwd or Q.PROJECT_BASE_UNKNOWN
	if rest ~= "" then
		local changed = rest ~= c.cwd
		c.cwd = rest
		local absolute = rest:match("^%a:[\\/]") or rest:match("^[\\/~]")
		local note = absolute and "" or (" (relative to " .. base .. ")")
		Cli.Out(c, "Project set to " .. rest .. note .. (changed and #c.history > 1 and ("; the next message starts a fresh " .. ChatAgentName(c) .. " session there") or ""))
	elseif c.cwd ~= "" then
		c.cwd = ""
		Cli.Out(c, "Project reset to the companion app's default: " .. base)
	else
		Cli.Out(c, "Project is the companion app's default: " .. base .. " (/claude cd <path>, or right-click the chat and pick Project..., to change)")
	end
	ClaudeWoW.Render()
end

StaticPopupDialogs["CLAUDEWOW_FOLDER"] = {
	text = "Project for this chat\n\nType a full path, a path that starts with ~, or a folder name inside %s.\nLeave it empty for no project. A change starts a new session with the agent.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 320,
	maxLetters = 250,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.cwd or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if not (chat and box) then return end
		Cli.KeepPlayerRoute(chat)
		if Cli.IsNoProject(box:GetText()) then
			Cli.PickProject(chat, "none")
		else
			ClaudeWoW.SetFolder(box:GetText(), chat)
		end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_FOLDER"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

Q.PROJECT_BASE_UNKNOWN = "the companion app's folder"

function ClaudeWoW.FolderPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_FOLDER", run.bridgeCwd or Q.PROJECT_BASE_UNKNOWN, nil, { id = c.id, cwd = c.cwd })
end

-- The agent this chat talks to, by id. Empty (or
-- "-" / "default") = the bridge's default. The bridge starts a fresh session
-- when a chat changes agent, since a session belongs to the agent that made it.
local function AgentList()
	return run.bridgeAgents and table.concat(run.bridgeAgents, ", ") or "claude, codex, grok, agy, hermes"
end

function ClaudeWoW.SetAgent(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or ""):lower()
	if rest == "" then
		Cli.Out(c, (c.agent ~= "" and ("agent is " .. AgentName(c.agent)) or ("agent is the companion app's default: " .. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected"))) .. " (/claude -c --agent <name>, or right-click the chat and pick Agent, to change; agents: " .. AgentList() .. ")")
		ClaudeWoW.Render()
		return
	end
	if rest == "-" or rest == "default" then rest = "" end
	if rest ~= "" and run.bridgeAgents and not Contains(run.bridgeAgents, rest) then
		Cli.Out(c, "Unknown agent \"" .. rest .. "\". The companion app knows: " .. AgentList())
		ClaudeWoW.Render()
		return
	end
	local changed = rest ~= (c.agent or "")
	c.agent = rest
	if rest ~= "" then
		Cli.Out(c, "agent set to " .. AgentName(rest) .. (changed and #c.history > 1 and "; the next message starts a fresh session with it" or ""))
	elseif changed then
		Cli.Out(c, "agent reset to the companion app's default: " .. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected"))
	else
		Cli.Out(c, "agent is the companion app's default: " .. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected") .. " (/claude -c --agent <name>, or right-click the chat and pick Agent, to change; agents: " .. AgentList() .. ")")
	end
	ClaudeWoW.Render()
end

StaticPopupDialogs["CLAUDEWOW_AGENT"] = {
	text = "Agent for this chat\n\nOne of: %s.\nEmpty = the companion app's default (%s). Changing it starts a fresh session.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 200,
	maxLetters = 32,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.agent or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if chat and box then ClaudeWoW.SetAgent(Trim(box:GetText() or "") == "" and "default" or box:GetText(), chat) end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_AGENT"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Agent dialog for a chat (the active one when no id is given).
function ClaudeWoW.AgentPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_AGENT", AgentList(), run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected", { id = c.id, agent = c.agent or "" })
end

-- The plugin this chat is bound to, by id ("ask": general in-game chat,
-- "claude-code": an agent session in a folder; docs/PLATFORM.md). Empty (or
-- "-" / "default") = the bridge's default. The bridge starts a fresh session
-- when a chat changes plugin, since a session belongs to the plugin that made it.
local function PluginList()
	return run.bridgePlugins and table.concat(run.bridgePlugins, ", ") or "ask, claude-code"
end

local function BridgePluginName()
	return run.bridgePlugin or "unknown until connected"
end

function ClaudeWoW.SetPlugin(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or ""):lower()
	if rest == "" then
		Cli.Out(c, ((c.plugin or "") ~= "" and ("plugin is " .. c.plugin) or ("plugin is the companion app's default: " .. BridgePluginName())) .. " (/claude config plugin <name>, or right-click the chat and pick Plugin, to change; plugins: " .. PluginList() .. "). This is an advanced setting: a chat with a project (/claude cd) is a coding session and one without is general chat, and /claude -r attaches running sessions.")
		ClaudeWoW.Render()
		return
	end
	if rest == "-" or rest == "default" then rest = "" end
	if rest ~= "" and run.bridgePlugins and not Contains(run.bridgePlugins, rest) then
		Cli.Out(c, "Unknown plugin \"" .. rest .. "\". The companion app has: " .. PluginList())
		ClaudeWoW.Render()
		return
	end
	local changed = rest ~= (c.plugin or "")
	c.plugin = rest
	Cli.KeepPlayerRoute(c)
	if rest ~= "" then
		Cli.Out(c, "plugin set to " .. rest .. (changed and #c.history > 1 and "; the next message starts a fresh session with it" or ""))
	elseif changed then
		Cli.Out(c, "plugin reset to the companion app's default: " .. BridgePluginName())
	else
		Cli.Out(c, "plugin is the companion app's default: " .. BridgePluginName() .. " (/claude config plugin <name>, or right-click the chat and pick Plugin, to change; plugins: " .. PluginList() .. ")")
	end
	ClaudeWoW.Render()
end

StaticPopupDialogs["CLAUDEWOW_PLUGIN"] = {
	text = "Plugin for this chat\n\nOne of: %s.\nEmpty = the companion app's default (%s). Changing it starts a fresh session.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 200,
	maxLetters = 32,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.plugin or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if chat and box then ClaudeWoW.SetPlugin(Trim(box:GetText() or "") == "" and "default" or box:GetText(), chat) end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_PLUGIN"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Plugin dialog for a chat (the active one when no id is given).
function ClaudeWoW.PluginPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_PLUGIN", PluginList(), BridgePluginName(), { id = c.id, plugin = c.plugin or "" })
end

StaticPopupDialogs["CLAUDEWOW_RENAME"] = {
	text = "Rename this chat",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	maxLetters = 24,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.name or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		local name = box and Trim(box:GetText() or "") or ""
		if chat and name ~= "" then
			chat.name = name:sub(1, 24)
			chat.titleFor = nil
			Whisper.Retitle(chat)
			ClaudeWoW.Render()
		end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_RENAME"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box)
		box:GetParent():Hide()
	end,
}

-- Rename dialog for a chat (the active one when no id is given).
function ClaudeWoW.RenamePrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_RENAME", nil, nil, { id = c.id, name = c.name })
end
ClaudeWoW.RenameActive = ClaudeWoW.RenamePrompt

-- Delete a chat (the active one when no id is given). The last chat is cleared
-- and renamed instead of removed, so there is always one to type into. Either
-- way the bridge is told to forget it, so a restore won't bring it back.
function ClaudeWoW.DeleteChat(id)
	local c, idx = nil, nil
	if id then c, idx = FindChat(id) end
	if not c then c, idx = ActiveChat() end
	if not c then return end
	ForgetOnBridge(c)
	Whisper.Close(c)
	local otherUserChats = 0
	for _, ch in ipairs(db.chats) do
		if ch ~= c and not ch.quiet then otherUserChats = otherUserChats + 1 end
	end
	if #db.chats == 1 or (otherUserChats == 0 and not c.quiet) then
		wipe(c.history)
		c.pendingId, c.progress, c.unread, c.draft = nil, nil, 0, nil
		c.gaveUp, c.lifeAt = nil, nil
		c.resumeId = nil
		Cli.KeepPlayerRoute(c)
		c.name = "Chat 1"
		ClaudeWoW.Render()
		ClaudeWoW.RenderChatList()
		return
	end
	table.remove(db.chats, idx)
	local heldReply = run.replyTarget and run.replyNames and run.replyNames[run.replyTarget:lower()] == c.id
	if run.lastReplyChat == c.id then run.lastReplyChat = nil end
	if db.activeChat == c.id then
		ClaudeWoW.SwitchChat(Cli.LatestChat().id)
	else
		ClaudeWoW.RenderChatList()
	end
	if heldReply then Whisper.OfferReply(Cli.LatestChat()) end
end

-- The trash can on a chat row asks first; /claude-wow delete does not.
StaticPopupDialogs["CLAUDEWOW_DELETE"] = {
	text = "Delete chat \"%s\"?\n\nIts transcript goes away (the last chat is cleared instead of removed).",
	button1 = "Delete",
	button2 = CANCEL,
	showAlert = true,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data and FindChat(data.id) then ClaudeWoW.DeleteChat(data.id) end
	end,
}

function ClaudeWoW.ConfirmDelete(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_DELETE", Display(c.name), nil, { id = c.id })
end

StaticPopupDialogs["CLAUDEWOW_CLEAR"] = {
	text = "Clear the messages in \"%s\"?\n\nThe chat and its session stay; only the transcript shown here goes away.",
	button1 = "Clear",
	button2 = CANCEL,
	showAlert = true,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data and FindChat(data.id) then ClaudeWoW.ClearChat(data.id) end
	end,
}

function ClaudeWoW.ConfirmClear(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_CLEAR", Display(c.name), nil, { id = c.id })
end

---------------------------------------------------------------------------
-- Macros
---------------------------------------------------------------------------

-- The agent can hand over ready-made macros (a ```wowmacro block the bridge turns
-- into `macros` on the reply). Each gets a button under its message that creates
-- the macro, or updates the one with that name, and puts it on the cursor to drop
-- on an action bar. The addon never runs a macro; the player's own click does.

local MACRO = {
	ACCOUNT_MAX = (Constants and Constants.MacroConsts and Constants.MacroConsts.MAX_ACCOUNT_MACROS) or 120,
	CHAR_MAX = (Constants and Constants.MacroConsts and Constants.MacroConsts.MAX_CHARACTER_MACROS) or 30,
	DEFAULT_ICON = 134400,
}

local function MacroSay(msg)
	ClaudeWoW.Print(msg)
end

-- Only well-formed entries survive (the slot file is trusted, but not blindly).
function ClaudeWoW.CleanMacros(list)
	if type(list) ~= "table" then return nil end
	local out = {}
	for _, m in ipairs(list) do
		if type(m) == "table" and type(m.name) == "string" and m.name ~= "" and type(m.body) == "string" and m.body ~= "" then
			out[#out + 1] = {
				name = m.name, body = m.body, char = m.char == true, risky = m.risky == true,
				icon = (type(m.icon) == "number" or type(m.icon) == "string") and m.icon or nil,
			}
		end
	end
	return #out > 0 and out or nil
end

-- The macro called `name` among account (1..120) or character (121..150) macros:
-- the same name may exist in both, and only the requested kind counts.
local function FindMacro(name, perCharacter)
	local first = perCharacter and MACRO.ACCOUNT_MAX + 1 or 1
	local last = perCharacter and MACRO.ACCOUNT_MAX + MACRO.CHAR_MAX or MACRO.ACCOUNT_MAX
	for i = first, last do
		local n, icon, body = Try(GetMacroInfo, i)
		if n == name then return i, icon, body end
	end
end

local function MacroIcon(icon)
	if type(icon) == "number" then return icon end
	if type(icon) == "string" then
		local id = Try(GetFileIDFromPath, "Interface\\Icons\\" .. icon)
		if type(id) == "number" and id > 0 then return id end
		return icon -- CreateMacro also takes a texture name
	end
	return MACRO.DEFAULT_ICON
end

function ClaudeWoW.MacroLabel(m)
	local verb = FindMacro(m.name, m.char) and "Update" or "Create"
	return verb .. " Macro: " .. Display(m.name) .. (m.char and " (character)" or "") .. (m.risky and "  |cffff6060(runs code)|r" or "")
end

StaticPopupDialogs["CLAUDEWOW_MACRO"] = {
	text = "%s",
	button1 = "Create Macro",
	button2 = CANCEL,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data then ClaudeWoW.InstallMacro(data, true) end
	end,
}

function Q.ShowMacroPopup(text, m, index)
	StaticPopupDialogs["CLAUDEWOW_MACRO"].button1 = index and "Update Macro" or "Create Macro"
	StaticPopup_Show("CLAUDEWOW_MACRO", text, nil, m)
end

-- Create or update macro `m` ({ name, body, icon, char, risky }). Asks first when it
-- would replace a different macro of yours, or when it runs code (/run, /click...).
function ClaudeWoW.InstallMacro(m, confirmed)
	if type(m) ~= "table" then return end
	if InCombatLockdown() then
		MacroSay("macros can't be changed in combat; click the button again afterwards.")
		return
	end
	local index, _, oldBody = FindMacro(m.name, m.char)
	if not confirmed then
		local why = {}
		if m.risky then table.insert(why, "This macro runs code or clicks buttons (/run, /script, /click). Only keep it if you trust what it does.") end
		if index and oldBody ~= m.body then table.insert(why, "It replaces your existing macro \"" .. m.name .. "\" (/claude config macro undo brings the old one back).") end
		if #why > 0 then
			Q.ShowMacroPopup(table.concat(why, "\n\n") .. "\n\n" .. Display(m.body), m, index)
			return
		end
	end
	-- Blizzard's macro window saves its edit box into its selected macro when it
	-- hides; close it first so that can't land on a macro we just moved.
	if MacroFrame and MacroFrame:IsShown() then
		Try(HideUIPanel, MacroFrame)
		index, _, oldBody = FindMacro(m.name, m.char)
	end
	local ok, newIndex
	if index then
		local _, oldIcon = FindMacro(m.name, m.char)
		ok, newIndex = pcall(EditMacro, index, m.name, m.icon ~= nil and MacroIcon(m.icon) or nil, m.body)
		if ok and type(newIndex) == "number" then
			db.macroUndo = { name = m.name, char = m.char, icon = oldIcon, body = oldBody }
		end
	else
		local acc, chr = Try(GetNumMacros)
		if m.char and type(chr) == "number" and chr >= MACRO.CHAR_MAX then
			MacroSay("your character macros are full (" .. MACRO.CHAR_MAX .. "); delete one in /macro first.")
			return
		elseif not m.char and type(acc) == "number" and acc >= MACRO.ACCOUNT_MAX then
			MacroSay("your account macros are full (" .. MACRO.ACCOUNT_MAX .. "); delete one in /macro first.")
			return
		end
		ok, newIndex = pcall(CreateMacro, m.name, MacroIcon(m.icon), m.body, m.char)
		if (not ok or type(newIndex) ~= "number") and m.icon ~= nil then
			ok, newIndex = pcall(CreateMacro, m.name, MACRO.DEFAULT_ICON, m.body, m.char)
		end
		if ok and type(newIndex) == "number" then
			db.macroUndo = { name = m.name, char = m.char, created = true }
		end
	end
	if not ok or type(newIndex) ~= "number" then
		MacroSay("could not save macro \"" .. m.name .. "\": " .. (ok and "the game refused it (is the list full?)" or tostring(newIndex)))
		return
	end
	-- EditMacro may move the macro (names are sorted): pick up the index it returned.
	Try(PickupMacro, newIndex)
	MacroSay("macro \"" .. m.name .. "\" " .. (index and "updated" or "created") .. " and on your cursor: click an action bar slot to place it (it is also in /macro).")
	ClaudeWoW.Render()
end

function ClaudeWoW.MacroPrompt(m)
	if type(m) ~= "table" then return end
	if InCombatLockdown() then
		MacroSay("macros can't be changed in combat; click the link again afterwards.")
		return
	end
	local index, _, oldBody = FindMacro(m.name, m.char)
	local lines = { (index and "Update" or "Create") .. " the macro \"" .. Display(m.name) .. "\"" .. (m.char and " (this character only)" or "") .. "? It lands on your cursor: click an action bar slot to place it." }
	if m.risky then table.insert(lines, "This macro runs code or clicks buttons (/run, /script, /click). Only keep it if you trust what it does.") end
	if index and oldBody ~= m.body then table.insert(lines, "It replaces your existing macro \"" .. Display(m.name) .. "\" (/claude config macro undo brings the old one back).") end
	table.insert(lines, Display(m.body))
	Q.ShowMacroPopup(table.concat(lines, "\n\n"), m, index)
end

function ClaudeWoW.UndoMacro()
	local u = db.macroUndo
	if not u then MacroSay("nothing to undo."); return end
	if InCombatLockdown() then MacroSay("macros can't be changed in combat."); return end
	local index = FindMacro(u.name, u.char)
	if not index then MacroSay("macro \"" .. u.name .. "\" is gone already."); db.macroUndo = nil; return end
	if MacroFrame and MacroFrame:IsShown() then Try(HideUIPanel, MacroFrame); index = FindMacro(u.name, u.char) end
	if u.created then
		Try(DeleteMacro, index)
		MacroSay("removed macro \"" .. u.name .. "\".")
	else
		Try(EditMacro, index, u.name, u.icon, u.body)
		MacroSay("macro \"" .. u.name .. "\" is back to what it was.")
	end
	db.macroUndo = nil
	ClaudeWoW.Render()
end

---------------------------------------------------------------------------
-- Rendering
---------------------------------------------------------------------------

Q.STATUS_READY = "Ready"
Q.STATUS_WORKING = "Working..."
Q.STATUS_REPLY = "Reply waiting"
Q.STATUS_UNREACHABLE = "Can't reach the companion app. Start it, then click Connect."
Q.STATUS_CONNECTING = "Connecting..."
Q.STATUS_NO_ANSWER = "No answer from the companion app. Is it running?"
Q.STATUS_RELOAD_HINT = "Click Reload to read it."
Q.RESEND_AFTER_SECONDS = STRIP_SECONDS
Q.RESEND_TIP = "The companion app has not picked up this message yet. Resend shows it to the app again."

function Q.StatusState(c)
	if c and c.pendingId then
		if db.settings.mode == "pixel" and (run.slotsExhausted or run.slotsMissing or run.pixelFailed) then return "reply", Q.STATUS_RELOAD_HINT end
		local a = run.act and run.act[c.id]
		return "working", Q.ReplyReloadNeeded() and Q.STATUS_RELOAD_HINT or nil, (a and a.startedAt) or run.sentAt
	end
	if not ClaudeWoW.IsConnected() then
		local key = Q.ConnectionKey()
		if key == "connecting" then return "connecting", nil, run.connectingAt or run.startedAt end
		if key == "failed" then return "failed" end
		return "down"
	end
	if c and c.draft and c.draft ~= "" then return "reply" end
	if run.restoring then return "working", nil, run.restoring end
	return "ready"
end

function Q.ShouldShowResend(c)
	if not c or not c.pendingId or c.quiet or db.settings.mode ~= "pixel" then return false end
	if c.progress or (run.steps and run.steps[c.id]) then return false end
	local a = run.act and run.act[c.id]
	if a and (a.count or 0) > 0 then return false end
	local r = Q.PendingRequest(c)
	if r and r.acked then return false end
	local since = (r and r.sentAt) or run.sentAt
	return since ~= nil and GetTime() - since >= Q.RESEND_AFTER_SECONDS
end

function Q.ResendVisible(c, mode)
	return (c and c.pendingId and mode == "pixel" and Q.ShouldShowResend(c)) and true or false
end

function Q.ResendTooltip(button)
	GameTooltip:SetOwner(button, "ANCHOR_TOP")
	GameTooltip:SetText("Resend")
	GameTooltip:AddLine(Q.RESEND_TIP, 0.8, 0.8, 0.8, true)
	GameTooltip:Show()
end

function ClaudeWoW.UpdateStatus()
	if not ui.status then return end
	local c = ActiveChat()
	local mode = db.settings.mode
	local state, hint = Q.StatusState(c)
	ui.status:SetText(Q.ShortStatus(c))
	run.statusText = hint
	run.statusWorking = state == "working" and hint == nil
	ClaudeWoW.UpdateDot()
	ClaudeWoW.UpdateConnect()
	if ui.title then
		local t = c and Display(Q.ShownName(c)) or Q.PANEL_TITLE
		if ui.chatTitle then
			t = Q.PANEL_TITLE
		else
			local folder = FolderName(ChatFolder(c))
			if folder ~= "" then t = t .. "  |cff888888" .. Display(folder) .. "|r" end
			if c and c.agent and c.agent ~= "" then t = t .. "  |cff888888" .. AgentName(c.agent) .. "|r" end
		end
		ui.title:SetText(t)
	end
	if ui.chatTitle then ClaudeWoW.RefreshTitleBar() end
	if ui.resend then ui.resend:SetShown(Q.ResendVisible(c, mode)) end
	if ui.refresh then ui.refresh:SetShown(mode ~= "pixel" or run.slotsExhausted or run.slotsMissing or run.pixelFailed or false) end
	if ui.ctxBar then
		Q.UpdateContextBar(c)
		ui.ctxBar:ClearAllPoints()
		local beside = (ui.refresh:IsShown() and ui.refresh) or (ui.resend:IsShown() and ui.resend) or nil
		if beside then
			ui.ctxBar:SetPoint("RIGHT", beside, "LEFT", -Q.CTX_BAR_GAP, 0)
		else
			ui.ctxBar:SetPoint("RIGHT", ui.frame, "BOTTOMRIGHT", Q.CTX_BAR_RIGHT_X, Q.CTX_BAR_Y)
		end
	end
	Q.UpdateMinimapSignal()
end

local PICKER_ROW_HEIGHT = 20

local function GetPickerRow(b, k)
	local rb = b.rowBtns[k]
	if rb then return rb end
	rb = CreateFrame("Button", nil, b)
	rb:SetHeight(PICKER_ROW_HEIGHT - 2)
	rb.label = rb:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
	rb.label:SetPoint("LEFT", rb, "LEFT", 4, 0)
	rb.label:SetPoint("RIGHT", rb, "RIGHT", -4, 0)
	rb.label:SetJustifyH("LEFT")
	rb.label:SetWordWrap(false)
	rb:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
	rb:SetScript("OnClick", function(self) ClaudeWoW.PickRow(self.row) end)
	b.rowBtns[k] = rb
	return rb
end

-- One message bubble: accent bar, colored label, timestamp, wrapped body.
local function GetBubble(i)
	local b = ui.bubbles[i]
	if b then return b end
	b = CreateFrame("Frame", nil, ui.content)
	if b.SetHyperlinksEnabled then
		pcall(b.SetHyperlinksEnabled, b, true)
		b:SetScript("OnHyperlinkClick", Q.LinkClick)
		b:SetScript("OnHyperlinkEnter", Q.LinkEnter)
		b:SetScript("OnHyperlinkLeave", function() GameTooltip:Hide() end)
	end
	b.bg = b:CreateTexture(nil, "BACKGROUND")
	b.bg:SetAllPoints()
	b.accent = b:CreateTexture(nil, "BORDER")
	b.accent:SetPoint("TOPLEFT", b, "TOPLEFT", 0, 0)
	b.accent:SetPoint("BOTTOMLEFT", b, "BOTTOMLEFT", 0, 0)
	b.accent:SetWidth(3)
	local onParchment = ui.parchment ~= nil
	if onParchment then b.accent:Hide() end
	b.who = b:CreateFontString(nil, "OVERLAY", onParchment and Q.FontObject("QuestTitleFont", Q.FontObject("QuestFontNormalSmall", "GameFontNormalSmall")) or "GameFontNormalSmall")
	b.who:SetPoint("TOPLEFT", b, "TOPLEFT", 10, -6)
	b.who:SetJustifyH("LEFT")
	b.when = b:CreateFontString(nil, "OVERLAY", onParchment and Q.FontObject("QuestFontNormalSmall", "GameFontDisableSmall") or "GameFontDisableSmall")
	b.when:SetPoint("TOPRIGHT", b, "TOPRIGHT", -8, -6)
	b.bodyFont = onParchment and Q.FontObject("QuestFont", "ChatFontNormal") or "ChatFontNormal"
	b.noteFont = onParchment and Q.FontObject("QuestFontNormalSmall", "GameFontNormalSmall") or "GameFontDisableSmall"
	b.body = b:CreateFontString(nil, "OVERLAY", b.bodyFont)
	b.body:SetPoint("TOPLEFT", b.who, "BOTTOMLEFT", 0, -4)
	b.body:SetJustifyH("LEFT")
	b.body:SetJustifyV("TOP")
	b.body:SetWordWrap(true)
	b.body:SetNonSpaceWrap(true)
	b.ruleL = b:CreateTexture(nil, "ARTWORK")
	b.ruleL:SetHeight(1)
	b.ruleL:Hide()
	b.ruleR = b:CreateTexture(nil, "ARTWORK")
	b.ruleR:SetHeight(1)
	b.ruleR:Hide()
	b.allow = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
	b.allow:SetHeight(22)
	b.allow:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6)
	b.allow:SetScript("OnClick", function(self)
		ClaudeWoW.ConfirmAllow(self.chatId, self.msgId, self.rules)
	end)
	b.allow:Hide()
	-- The New chat button on a context warning: exactly what bare /claude does.
	b.fresh = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
	b.fresh:SetHeight(22)
	b.fresh:SetText("New Chat")
	b.fresh:SetScript("OnClick", function() ClaudeWoW.NewChat() end)
	b.fresh:Hide()
	b.macroBtns = {}
	b.rowBtns = {}
	-- FontStrings can't be selected, so a click opens the message in the copy box.
	b:EnableMouse(true)
	b:SetScript("OnMouseUp", function(self, button)
		if button ~= "LeftButton" or not self.text or self.text == "" then return end
		local clickedAt = GetTime()
		C_Timer.After(0, function()
			if self.linkClickAt ~= clickedAt then ClaudeWoW.ShowCopy(self.text) end
		end)
	end)
	ui.bubbles[i] = b
	return b
end

function Q.HeaderButton(host, name, rightOf, onClick, onEnter)
	local b = CreateFrame("Button", name, host)
	b:SetSize(60, ui.titleBar and Q.NAV_H - 10 or 16)
	b:SetPoint("RIGHT", rightOf, "LEFT", -Cli.PROJECT_PAD, 0)
	b:SetFrameLevel((Try(host.GetFrameLevel, host) or 1) + 5)
	b.text = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.text:SetPoint("RIGHT", b, "RIGHT", -2, 0)
	b.text:SetJustifyH("RIGHT")
	b.text:SetWordWrap(false)
	local hl = b:CreateTexture(nil, "HIGHLIGHT")
	hl:SetAllPoints()
	hl:SetColorTexture(1, 1, 1, 0.08)
	b:RegisterForClicks("LeftButtonUp")
	b:SetScript("OnClick", function(self)
		GameTooltip:Hide()
		onClick(self)
	end)
	b:SetScript("OnEnter", onEnter)
	b:SetScript("OnLeave", function() GameTooltip:Hide() end)
	b:Hide()
	return b
end

Q.INPUT_INSET_PLAIN = 8
Q.INPUT_INSET_SCROLL = 24

function Q.InputRightInset(busy)
	local base = ui.inputRightInset or Q.INPUT_INSET_PLAIN
	return busy and (base + Q.STOP_W + Q.STOP_INSET) or base
end

function Q.InsetComposer(busy)
	local scroll, box = ui.inputScroll, ui.inputBg
	if not scroll or not box then return end
	scroll:SetPoint("BOTTOMRIGHT", box, "BOTTOMRIGHT", -Q.InputRightInset(busy), 6)
end

function Q.BesideInput(button, inputBg, native)
	if native then
		button:SetPoint("BOTTOMLEFT", inputBg, "BOTTOMRIGHT", Q.COMPOSER_GAP, 0)
	else
		button:SetPoint("LEFT", inputBg, "RIGHT", Q.COMPOSER_GAP, 0)
	end
end

function Q.SendTooltip(button)
	GameTooltip:SetOwner(button, "ANCHOR_TOP")
	GameTooltip:SetText("Send (Enter)")
	GameTooltip:AddLine("/claude help lists commands.", 0.8, 0.8, 0.8, true)
	GameTooltip:Show()
end

function Q.UpdatePlaceholder()
	local placeholder, input = ui.placeholder, ui.input
	if not placeholder or not input then return end
	placeholder:SetText("Message " .. ChatAgentName(ActiveChat()))
	if (input:GetText() or "") == "" and not input:HasFocus() then placeholder:Show() else placeholder:Hide() end
end

Q.EMPTY_GAP, Q.EMPTY_SIDE, Q.EMPTY_LINE_GAP = 16, 20, 8
Q.NOTE_GAP, Q.NOTE_PAD, Q.NOTE_SIDE, Q.RULE_GAP, Q.RULE_MIN, Q.NOTE_MAX_LINES, Q.NOTE_MAX_CHARS = 6, 4, 24, 8, 24, 2, 120

function Q.NoteKind(m)
	if m.role ~= "system" or m.newChat or type(m.text) ~= "string" then return nil end
	if m.event then return "event" end
	local _, breaks = m.text:gsub("\n", "")
	return breaks < Q.NOTE_MAX_LINES and #m.text <= Q.NOTE_MAX_CHARS and "note" or nil
end

function Q.LayoutCard(b)
	b.who:Show()
	b.when:Show()
	b.bg:Show()
	b.accent:SetShown(ui.parchment == nil)
	b.ruleL:Hide()
	b.ruleR:Hide()
	b.body:SetFontObject(b.bodyFont)
	b.body:SetJustifyH("LEFT")
	b.body:ClearAllPoints()
	b.body:SetPoint("TOPLEFT", b.who, "BOTTOMLEFT", 0, -4)
end

function Q.LayoutNote(b, text, kind, width)
	for _, part in ipairs({ b.who, b.when, b.bg, b.accent, b.allow, b.fresh }) do part:Hide() end
	for _, part in ipairs(b.macroBtns) do part:Hide() end
	for _, part in ipairs(b.rowBtns) do part:Hide() end
	local ink = ui.parchment and Q.PARCHMENT_DIM or { 0.62, 0.62, 0.62 }
	local inner = math.max(80, width - 2 * Q.NOTE_SIDE)
	b.body:SetFontObject(b.noteFont)
	b.body:SetTextColor(ink[1], ink[2], ink[3])
	b.body:SetJustifyH("CENTER")
	b.body:SetWidth(inner)
	b.body:SetText(text)
	b.body:ClearAllPoints()
	b.body:SetPoint("TOP", b, "TOP", 0, -Q.NOTE_PAD)
	local h = Try(b.body.GetStringHeight, b.body) or 12
	if h < 1 then h = 12 end
	b:SetHeight(h + 2 * Q.NOTE_PAD)
	local half = math.floor((Try(b.body.GetStringWidth, b.body) or inner) / 2) + Q.RULE_GAP
	local ruled = kind == "event" and width / 2 - half - Q.NOTE_SIDE >= Q.RULE_MIN
	for _, rule in ipairs({ b.ruleL, b.ruleR }) do
		rule:SetColorTexture(ink[1], ink[2], ink[3], 0.45)
		rule:ClearAllPoints()
		rule:SetShown(ruled)
	end
	if ruled then
		b.ruleL:SetPoint("LEFT", b, "LEFT", Q.NOTE_SIDE, 0)
		b.ruleL:SetPoint("RIGHT", b, "CENTER", -half, 0)
		b.ruleR:SetPoint("LEFT", b, "CENTER", half, 0)
		b.ruleR:SetPoint("RIGHT", b, "RIGHT", -Q.NOTE_SIDE, 0)
	end
end

Q.NOTICE_H, Q.NOTICE_INSET, Q.NOTICE_BUTTON_W = 34, 3, 80

function Q.BuildNoticeBar(native)
	local bar = CreateFrame("Frame", "ClaudeWoWNoticeBar", ui.scrollBottom[1])
	bar:SetHeight(Q.NOTICE_H - 2 * Q.NOTICE_INSET)
	bar:SetPoint("TOPLEFT", ui.scroll, "BOTTOMLEFT", 0, -Q.NOTICE_INSET)
	bar:SetPoint("TOPRIGHT", ui.scroll, "BOTTOMRIGHT", 0, -Q.NOTICE_INSET)
	bar.bg = bar:CreateTexture(nil, "BACKGROUND")
	bar.bg:SetAllPoints()
	bar.line = bar:CreateTexture(nil, "ARTWORK")
	bar.line:SetHeight(1)
	bar.line:SetPoint("TOPLEFT", bar, "TOPLEFT", 0, 0)
	bar.line:SetPoint("TOPRIGHT", bar, "TOPRIGHT", 0, 0)
	if native then
		bar.bg:SetColorTexture(0.45, 0.30, 0.10, 0.12)
		bar.line:SetColorTexture(Q.PARCHMENT_DIM[1], Q.PARCHMENT_DIM[2], Q.PARCHMENT_DIM[3], 0.45)
	else
		bar.bg:SetColorTexture(0.85, 0.70, 0.30, 0.12)
		bar.line:SetColorTexture(1, 0.82, 0, 0.5)
	end
	bar.button = CreateFrame("Button", "ClaudeWoWNoticeReload", bar, "UIPanelButtonTemplate")
	bar.button:SetSize(Q.NOTICE_BUTTON_W, 22)
	bar.button:SetPoint("RIGHT", bar, "RIGHT", -6, 0)
	bar.button:SetText("Reload")
	bar.button:SetScript("OnClick", function() ReloadUI() end)
	bar.text = bar:CreateFontString(nil, "OVERLAY", native and Q.FontObject("QuestFont", "GameFontNormal") or "GameFontNormal")
	bar.text:SetPoint("LEFT", bar, "LEFT", 8, 0)
	bar.text:SetPoint("RIGHT", bar.button, "LEFT", -8, 0)
	bar.text:SetJustifyH("LEFT")
	bar.text:SetWordWrap(false)
	if native then bar.text:SetTextColor(Q.PARCHMENT_TEXT[1], Q.PARCHMENT_TEXT[2], Q.PARCHMENT_TEXT[3]) end
	bar:EnableMouse(true)
	bar:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:AddLine("New addon files are installed")
		local u = run.updateReady
		if u then GameTooltip:AddLine(u.version .. (u.build ~= "" and (" build " .. u.build) or ""), 1, 1, 1) end
		GameTooltip:AddLine("Reload the UI to load them.", 1, 1, 1, true)
		GameTooltip:Show()
	end)
	bar:SetScript("OnLeave", function() GameTooltip:Hide() end)
	bar:Hide()
	ui.notice = bar
	Q.UpdateNoticeBar()
end

function Q.UpdateNoticeBar()
	local bar, scroll, base = ui.notice, ui.scroll, ui.scrollBottom
	if not bar or not scroll or not base then return end
	local text = ClaudeWoW.Version.Notice()
	bar.text:SetText(text or "")
	bar:SetShown(text ~= nil)
	scroll:SetPoint("BOTTOMRIGHT", base[1], "BOTTOMRIGHT", base[2], base[3] + (text and Q.NOTICE_H or 0))
end

function Q.AddEvent(chat, text)
	AddHistory(chat, "system", text)
	chat.history[#chat.history].event = true
end

Q.EMPTY_ICON, Q.EMPTY_ROW_H, Q.EMPTY_ROWS_W, Q.EMPTY_ROW_ICON = 56, 22, 300, 16
Q.STARTER_ICON = "Interface\\GossipFrame\\AvailableQuestIcon"
Q.STARTERS = {
	project = { "Summarize what changed today", "Find and fix the failing test", "Explain how this repo is laid out" },
	game = { "What should I do next?", "Plan a route for my quests", "Which gear upgrades should I look for?" },
}
Q.EMPTY_HINT = "Shift-click an item, spell or quest to link it."

function Q.EmptyState(c)
	for _, m in ipairs(c.history) do
		if m.role ~= "system" or (type(m.picker) == "table" and #m.picker > 0) then return nil end
	end
	if run.restoring then
		return { title = "Restoring your chats", lines = { "Connecting to the companion app and restoring your chats..." } }
	end
	if not ClaudeWoW.IsConnected() then
		local state = Q.StatusState(c)
		if state == "connecting" then return { title = Q.STATUS_CONNECTING, lines = { "Looking for the companion app on this computer." } } end
		return { title = "Not connected", lines = { state == "failed" and Q.STATUS_NO_ANSWER or Q.STATUS_UNREACHABLE } }
	end
	local project = Cli.ProjectOf(c) ~= ""
	local lines = { Q.EMPTY_HINT }
	if Q.FirstRun() then table.insert(lines, Q.FIRST_RUN_TEXT) end
	return {
		title = project and "What are we working on?" or "What do you need?",
		lines = lines,
		starters = project and Q.STARTERS.project or Q.STARTERS.game,
	}
end

Q.FIRST_RUN_TEXT = "New here? Type below and press Enter. Replies show here, and /claude brings this window back."

function Q.FirstRun()
	for _, ch in ipairs(db.chats) do
		if HasUserMessage(ch) then return false end
	end
	return true
end

function Q.UseStarter(text)
	local input = ui.input
	if not input then return end
	if (input:GetText() or "") ~= "" then return input:SetFocus() end
	input:SetText(text)
	input:SetFocus()
	if input.SetCursorPosition then input:SetCursorPosition(#text) end
	Q.UpdatePlaceholder()
end

function Q.StarterRow(f, k)
	local row = f.rows[k]
	if row then return row end
	local parchment = ui.parchment ~= nil
	row = CreateFrame("Button", nil, f)
	row:SetHeight(Q.EMPTY_ROW_H)
	row.icon = row:CreateTexture(nil, "ARTWORK")
	row.icon:SetSize(Q.EMPTY_ROW_ICON, Q.EMPTY_ROW_ICON)
	row.icon:SetPoint("LEFT", row, "LEFT", 4, 0)
	row.icon:SetTexture(Q.STARTER_ICON)
	row.label = row:CreateFontString(nil, "OVERLAY", parchment and Q.FontObject("QuestFont", "GameFontHighlight") or "GameFontHighlight")
	row.label:SetPoint("LEFT", row.icon, "RIGHT", 6, 0)
	row.label:SetPoint("RIGHT", row, "RIGHT", -4, 0)
	row.label:SetJustifyH("LEFT")
	row.label:SetWordWrap(false)
	if parchment then row.label:SetTextColor(Q.PARCHMENT_TEXT[1], Q.PARCHMENT_TEXT[2], Q.PARCHMENT_TEXT[3]) end
	row:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
	row:SetScript("OnClick", function(self) Q.UseStarter(self.starter) end)
	f.rows[k] = row
	return row
end

function Q.EmptyFrame()
	if ui.empty then return ui.empty end
	local parchment = ui.parchment ~= nil
	local f = CreateFrame("Frame", nil, ui.content)
	f.rows = {}
	f.icon = f:CreateTexture(nil, "ARTWORK")
	f.icon:SetSize(Q.EMPTY_ICON, Q.EMPTY_ICON)
	if not (type(SetPortraitToTexture) == "function" and pcall(SetPortraitToTexture, f.icon, Q.PORTRAIT)) then
		f.icon:SetTexture(Q.PORTRAIT)
		if type(f.icon.SetMask) == "function" then pcall(f.icon.SetMask, f.icon, Q.MINIMAP_ICON_MASK) end
	end
	f.title = f:CreateFontString(nil, "OVERLAY", parchment and Q.FontObject("QuestTitleFont", "GameFontNormalLarge") or "GameFontNormalLarge")
	f.title:SetJustifyH("CENTER")
	f.body = f:CreateFontString(nil, "OVERLAY", parchment and Q.FontObject("QuestFontNormalSmall", "GameFontHighlightSmall") or "GameFontHighlightSmall")
	f.body:SetJustifyH("CENTER")
	f.body:SetJustifyV("TOP")
	f.body:SetWordWrap(true)
	if parchment then
		f.title:SetTextColor(Q.PARCHMENT_TEXT[1], Q.PARCHMENT_TEXT[2], Q.PARCHMENT_TEXT[3])
		f.body:SetTextColor(Q.PARCHMENT_DIM[1], Q.PARCHMENT_DIM[2], Q.PARCHMENT_DIM[3])
	else
		f.title:SetTextColor(1, 0.82, 0)
		f.body:SetTextColor(0.8, 0.8, 0.8)
	end
	ui.empty = f
	return f
end

function Q.PlaceEmpty(state, y, width)
	local f = Q.EmptyFrame()
	local inner = math.max(80, width - 2 * Q.EMPTY_SIDE)
	f:SetWidth(inner)
	f.title:SetWidth(inner)
	f.body:SetWidth(inner)
	local below = y > 0
	local h = 0
	local function Stack(region, height, gap)
		region:ClearAllPoints()
		region:SetPoint("TOP", f, "TOP", 0, -h)
		h = h + height + (gap or Q.EMPTY_LINE_GAP)
	end
	f.icon:SetShown(not below)
	if not below then Stack(f.icon, Q.EMPTY_ICON) end
	f.title:SetShown(not below)
	f.title:SetText(below and "" or Display(state.title))
	if not below then Stack(f.title, Try(f.title.GetStringHeight, f.title) or 14) end
	local starters = state.starters or {}
	local rowsW = math.min(inner, Q.EMPTY_ROWS_W)
	for k, text in ipairs(starters) do
		local row = Q.StarterRow(f, k)
		row.starter = text
		row.label:SetText(Display(text))
		row:SetWidth(rowsW)
		Stack(row, Q.EMPTY_ROW_H, k == #starters and Q.EMPTY_LINE_GAP or 0)
		row:Show()
	end
	for k = #starters + 1, #f.rows do f.rows[k]:Hide() end
	f.body:SetText(Display(below and state.lines[1] or table.concat(state.lines, "\n")))
	Stack(f.body, Try(f.body.GetStringHeight, f.body) or 14, 0)
	f:SetHeight(h)
	local view = Try(ui.scroll.GetHeight, ui.scroll) or 0
	local top = below and (y + Q.EMPTY_GAP) or math.max(0, math.floor((view - h) / 2))
	f:ClearAllPoints()
	f:SetPoint("TOPLEFT", ui.content, "TOPLEFT", math.floor((width - inner) / 2), -top)
	f:Show()
	return top + h
end

function ClaudeWoW.Render()
	local c = ActiveChat()
	Cli.UpdateMcpButton()
	Cli.UpdateProjectButton()
	Cli.UpdateEffortButton()
	ClaudeWoW.UpdateConnect()
	Q.UpdatePlaceholder()
	if ui.content and c then
		local width = ui.scroll:GetWidth()
		if not width or width < 80 then width = 400 end
		ui.content:SetWidth(width)
		local y, n = 0, 0
		local function PlaceNote(text, kind)
			n = n + 1
			local b = GetBubble(n)
			b:SetWidth(width)
			Q.LayoutNote(b, Display(text), kind, width)
			b:ClearAllPoints()
			b:SetPoint("TOPLEFT", ui.content, "TOPLEFT", 0, -y)
			b.text = text
			b:Show()
			y = y + b:GetHeight() + Q.NOTE_GAP
			return b
		end
		local function Place(role, text, when, dim, denied, agent, macros, newChat, picker)
			n = n + 1
			local b = GetBubble(n)
			Q.LayoutCard(b)
			local st = ROLE_STYLE[role] or ROLE_STYLE.system
			local look = ui.parchment and (Q.PARCHMENT_STYLE[role] or Q.PARCHMENT_STYLE.system) or st
			b:SetWidth(width)
			b.bg:SetColorTexture(look.bg[1], look.bg[2], look.bg[3], look.bg[4])
			b.accent:SetColorTexture(look.color[1], look.color[2], look.color[3], ui.parchment and 0.6 or 0.9)
			b.who:SetText(st == ROLE_STYLE.assistant and ReplyAgentName(c, agent) or st.label)
			b.who:SetTextColor(look.color[1], look.color[2], look.color[3])
			b.when:SetText(when or "")
			b.body:SetWidth(width - 18)
			b.body:SetText(role == "assistant" and Q.RichText(Display(text), ui.parchment ~= nil) or Display(text))
			local ink = ui.parchment and (dim and Q.PARCHMENT_DIM or Q.PARCHMENT_TEXT) or (dim and { 0.72, 0.72, 0.72 } or { 0.93, 0.93, 0.93 })
			b.body:SetTextColor(ink[1], ink[2], ink[3])
			local h = b.body:GetStringHeight()
			if not h or h < 1 then h = 14 end
			local extra = 0
			if denied and ClaudeWoW.LootRollEnabled() then
				b.allow:Hide()
				ClaudeWoWRoll.Offer(c.id)
			elseif denied then
				local label = "Allow " .. ClaudeWoW.GrantsLabel(denied) .. (ClaudeWoW.IsLiveChat(c) and " once & retry" or " & retry")
				b.allow:SetText(label)
				b.allow:SetWidth(math.min(width - 24, math.max(160, b.allow:GetFontString():GetStringWidth() + 30)))
				b.allow.chatId = c.id
				b.allow.msgId = select(2, ClaudeWoW.OpenDenial(c.id))
				b.allow.rules = denied
				b.allow:Show()
				extra = 28
			else
				b.allow:Hide()
			end
			if newChat then
				b.fresh:SetWidth(math.min(width - 24, math.max(120, b.fresh:GetFontString():GetStringWidth() + 30)))
				b.fresh:ClearAllPoints()
				b.fresh:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6 - extra)
				b.fresh:Show()
				extra = extra + 28
			else
				b.fresh:Hide()
			end
			-- One button per macro the agent handed over.
			local shownMacros = 0
			for k, m in ipairs(macros or {}) do
				local mb = b.macroBtns[k]
				if not mb then
					mb = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
					mb:SetHeight(22)
					mb:SetScript("OnClick", function(self) ClaudeWoW.InstallMacro(self.macro) end)
					mb:SetScript("OnEnter", function(self)
						GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
						GameTooltip:AddLine(Display(self.macro.name))
						GameTooltip:AddLine(Display(self.macro.body), 1, 1, 1, true)
						GameTooltip:Show()
					end)
					mb:SetScript("OnLeave", function() GameTooltip:Hide() end)
					b.macroBtns[k] = mb
				end
				mb.macro = m
				mb:SetText(ClaudeWoW.MacroLabel(m))
				mb:SetWidth(math.min(width - 24, math.max(160, mb:GetFontString():GetStringWidth() + 30)))
				mb:ClearAllPoints()
				mb:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6 - extra)
				mb:Show()
				extra = extra + 28
				shownMacros = k
			end
			for k = shownMacros + 1, #b.macroBtns do b.macroBtns[k]:Hide() end
			local shownRows = 0
			for k, row in ipairs(picker or {}) do
				local rb = GetPickerRow(b, k)
				rb.row = row
				rb.label:SetText(row.text or "")
				rb:SetWidth(width - 24)
				rb:ClearAllPoints()
				rb:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -4 - extra)
				rb:Show()
				extra = extra + PICKER_ROW_HEIGHT
				shownRows = k
			end
			for k = shownRows + 1, #b.rowBtns do b.rowBtns[k]:Hide() end
			local whoH = math.max(12, Try(b.who.GetStringHeight, b.who) or 12)
			b:SetHeight(6 + whoH + 4 + h + 8 + extra)
			b:ClearAllPoints()
			b:SetPoint("TOPLEFT", ui.content, "TOPLEFT", 0, -y)
			b.text = text
			b:Show()
			y = y + b:GetHeight() + 6
			return b
		end
		local openDenial = not c.pendingId and Q.DenialIndex(c) or nil
		for i, m in ipairs(c.history) do
			local denied = i == openDenial and m.denied or nil
			local picker = type(m.picker) == "table" and #m.picker > 0 and m.picker or nil
			local reply = m.role == "assistant" and not picker
			local kind = not denied and not picker and Q.NoteKind(m)
			if kind then
				PlaceNote(m.text, kind)
			else
				local b = Place(m.role, picker and m.head or (reply and Q.StripSummary(m.text, m.summary) or m.text), m.t and date("%H:%M", m.t) or "", false, denied, m.agent, m.macros, m.newChat, picker)
				if reply then b.text = m.text end
			end
		end
		local empty = nil
		if c.pendingId then
			local head = "Working " .. SEG.DOT .. " " .. ActivityLine(c)
			if run.statusText and run.statusText ~= "" and not run.statusWorking then head = head .. "\n" .. run.statusText end
			local steps = Cli.StepLines(c)
			Place("assistant", #steps > 0 and (head .. "\n\n" .. table.concat(steps, "\n")) or head, "", true, nil, ChatAgent(c))
		else
			empty = Q.EmptyState(c)
		end
		for i = n + 1, #ui.bubbles do
			ui.bubbles[i]:Hide()
		end
		if empty then
			y = Q.PlaceEmpty(empty, y, width)
		elseif ui.empty then
			ui.empty:Hide()
		end
		ui.content:SetHeight(math.max(y, 1))
		C_Timer.After(0.05, function()
			if ui.scroll then
				ui.scroll:SetVerticalScroll(ui.scroll:GetVerticalScrollRange())
			end
		end)
	end
	ClaudeWoW.UpdateStatus()
	ClaudeWoW.RenderChatList()
end

-- Copy box (/claude-wow copy): a selectable EditBox with the last reply pre-highlighted for Ctrl+C.
function ClaudeWoW.ShowCopy(text)
	if not ui.copy then
		local cf = CreateFrame("Frame", "ClaudeWoWCopy", UIParent, "BackdropTemplate")
		cf:SetSize(560, 320)
		cf:SetPoint("CENTER")
		cf:SetFrameStrata("FULLSCREEN_DIALOG")
		cf:SetMovable(true)
		cf:SetClampedToScreen(true)
		cf:EnableMouse(true)
		cf:RegisterForDrag("LeftButton")
		cf:SetScript("OnDragStart", cf.StartMoving)
		cf:SetScript("OnDragStop", cf.StopMovingOrSizing)
		cf:SetBackdrop(BACKDROP)
		cf:SetBackdropColor(0.05, 0.05, 0.07, 0.97)
		cf:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
		tinsert(UISpecialFrames, "ClaudeWoWCopy")

		local t = cf:CreateFontString(nil, "OVERLAY", "GameFontNormal")
		t:SetPoint("TOPLEFT", cf, "TOPLEFT", 14, -12)
		t:SetText("Text is selected - press Ctrl+C, then Esc")

		local x = CreateFrame("Button", nil, cf, "UIPanelCloseButton")
		x:SetPoint("TOPRIGHT", cf, "TOPRIGHT", -4, -4)

		local sc = CreateFrame("ScrollFrame", "ClaudeWoWCopyScroll", cf, "UIPanelScrollFrameTemplate")
		sc:SetPoint("TOPLEFT", cf, "TOPLEFT", 14, -36)
		sc:SetPoint("BOTTOMRIGHT", cf, "BOTTOMRIGHT", -32, 14)
		local eb = CreateFrame("EditBox", "ClaudeWoWCopyBox", sc)
		eb:SetMultiLine(true)
		eb:SetAutoFocus(false)
		eb:SetFontObject(ChatFontNormal)
		eb:SetMaxLetters(0)
		eb:SetSize(500, 260)
		eb:SetScript("OnEscapePressed", function() cf:Hide() end)
		sc:SetScrollChild(eb)
		sc:HookScript("OnSizeChanged", function(self, w) eb:SetWidth(w) end)
		ui.copy, ui.copyBox = cf, eb
	end
	ui.copyBox:SetText(text)
	ui.copy:Show()
	ui.copyBox:SetFocus()
	ui.copyBox:HighlightText()
end

function ClaudeWoW.RenderChatList()
	if ui.questList then return ClaudeWoW.RenderQuestList() end
	if not ui.chatButtons then return end
	local listed = Q.ListedChats()
	local pages = math.max(1, math.ceil(#listed / Q.CHAT_PAGE))
	if not ui.chatPage then
		for i, ch in ipairs(listed) do
			if ch.id == db.activeChat then ui.chatPage = math.ceil(i / Q.CHAT_PAGE) end
		end
	end
	ui.chatPage = math.min(math.max(ui.chatPage or 1, 1), pages)
	local offset = (ui.chatPage - 1) * Q.CHAT_PAGE
	if ui.pageLabel then
		ui.pageLabel:SetText(pages > 1 and (ui.chatPage .. " / " .. pages) or "")
		ui.pagePrev:SetShown(pages > 1)
		ui.pageNext:SetShown(pages > 1)
		ui.pagePrev:SetEnabled(ui.chatPage > 1)
		ui.pageNext:SetEnabled(ui.chatPage < pages)
	end
	for i, btn in ipairs(ui.chatButtons) do
		local c = listed[offset + i]
		if c then
			local label = Display(Q.ShownName(c))
			local folder = FolderName(ChatFolder(c))
			if folder ~= "" and folder:lower() ~= c.name:lower() then
				label = label .. " |cff888888" .. Display(folder) .. "|r"
			end
			if c.agent and c.agent ~= "" then
				label = label .. " |cff888888" .. AgentName(c.agent) .. "|r"
			end
			if c.pendingId then
				label = label .. " |cffffd100...|r"
			elseif (c.unread or 0) > 0 then
				label = label .. " |cff55ff55(" .. c.unread .. ")|r"
			end
			btn.label:SetText(label)
			btn.chatId = c.id
			btn.selected:SetShown(c.id == db.activeChat)
			btn:Show()
		else
			btn:Hide()
		end
	end
end

function Q.ChatActivity()
	local unread, working = 0, 0
	for _, c in ipairs(Q.ListedChats()) do
		unread = unread + (c.unread or 0)
		if c.pendingId then working = working + 1 end
	end
	return unread, working
end

function Q.ActivityText(unread, working)
	local parts = {}
	if unread > 0 then table.insert(parts, unread .. (unread == 1 and " new reply" or " new replies")) end
	if working > 0 then table.insert(parts, working .. " working") end
	return table.concat(parts, ", ")
end

local ECHO = { DEFAULT = 4000, SUMMARY_LINES = 3, SUMMARY_FALLBACK_LINES = 2 }

local function ChatLinks(chat)
	return "  " .. Link("reply", chat.id, "reply", "55ff55") .. " " .. Link("open", chat.id, "open")
end


-- Print a reply into the game chat: prefix on the first line, then the text line
-- by line up to the limit, then clickable links. `short` prints one preview line.
-- `summary` (the default) prints the TL;DR block the bridge split off the reply,
-- or the first lines of the reply when the agent didn't write one; the full text
-- is in the window, behind [open].
local function EchoToChat(chat, text, agent, summary)
	local mode = db.settings.echo
	if mode == "off" then return end
	local prefix = "|cff7ec8ff[" .. ReplyAgentName(chat, agent) .. " · " .. Display(chat.name) .. "]|r "
	local body = Q.MarkFences(Display(text))
	if mode == "short" then
		local flat = (body:gsub("\3[^\n]*", ""):gsub("%s+", " "))
		if #flat > 200 then flat = Q.CutLine(flat, 200) .. " ..." end
		print(prefix .. Q.RichText(flat) .. ChatLinks(chat))
		return
	end
	if mode == "summary" then
		local source, max = Q.MarkFences(Display(summary or "")), ECHO.SUMMARY_LINES
		if not source:match("%S") then source, max = body, ECHO.SUMMARY_FALLBACK_LINES end
		local lines, total = {}, 0
		for line in (source .. "\n"):gmatch("(.-)\n") do
			if line:match("%S") then
				total = total + 1
				if total <= max then table.insert(lines, line) end
			end
		end
		for i, line in ipairs(lines) do
			print((i == 1 and prefix or "    ") .. Q.RichText(line))
		end
		if total > max then
			print("    |cff888888... click [open] to read it all|r")
		end
		print("    " .. ChatLinks(chat):sub(3))
		return
	end
	local limit = tonumber(mode) or ECHO.DEFAULT
	local first, shown = true, 0
	for line in (body .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then
			if shown + #line > limit then
				print("    |cff888888... " .. (#body - shown) .. " more characters, click [open] to read it all|r")
				break
			end
			print((first and prefix or "    ") .. Q.RichText(line))
			first = false
			shown = shown + #line
		end
	end
	print("    " .. ChatLinks(chat):sub(3))
end

function ClaudeWoW.Notify(chat, text, agent, summary, role, denied, msgId, macros)
	local inCombat = InCombatLockdown() and true or false
	if not inCombat then pcall(PlaySound, 3081) end
	if ClaudeWoWVoice and not inCombat then ClaudeWoWVoice.Reply(role, denied) end
	Q.UpdateMinimapSignal()
	run.lastReplyChat = chat.id
	Whisper.OfferReply(chat)
	local tabbed = Whisper.Reply(chat, text, agent, role, denied, summary, msgId, macros)
	if not tabbed then EchoToChat(chat, text, agent, summary) end
	if inCombat or tabbed then return tabbed end
	if ui.frame and ui.frame:IsShown() then return false end
	local who = ReplyAgentName(chat, agent)
	if UIErrorsFrame then UIErrorsFrame:AddMessage(who .. " replied.", 0.5, 0.8, 1, 1) end
	if not Q.MinimapButtonOn() then print(ClaudeWoW.PREFIX .. who .. Q.REPLY_WAITING_NOTICE) end
	return false
end

function ClaudeWoW.SystemNote(text)
	if not db then return end
	local c = ActiveChat()
	if not c then return end
	AddHistory(c, "system", text)
	ClaudeWoW.Render()
end

local function OnPreSendText(_, eb)
	if not db or type(eb) ~= "table" then return end
	Whisper.Intercept(eb, "pre-send")
end

local function InstallChatHooks()
	Whisper.HookPreSend(OnPreSendText)
end

function Cli.Split(s)
	local out = {}
	for part in (tostring(s or "") .. ":"):gmatch("([^:]*):") do table.insert(out, part) end
	return out
end

function Cli.FindMessage(c, msgId)
	msgId = tonumber(msgId)
	if not c or not msgId then return nil end
	for i = #c.history, 1, -1 do
		local m = c.history[i]
		if m.id == msgId and m.role ~= "user" then return m end
	end
end

function Cli.Links.resume(arg)
	ClaudeWoW.ResumePick(tonumber(arg))
end

function Cli.Links.open(arg)
	ClaudeWoW.OpenWorkspace(Cli.Split(arg)[1])
end

function Cli.Links.reply(arg)
	local id = Cli.Split(arg)[1]
	if Whisper.Active() then
		if FindChat(id) and db.activeChat ~= id then ClaudeWoW.SwitchChat(id) end
		return
	end
	ClaudeWoW.OpenWorkspace(id, true)
end

function Cli.Links.connect()
	ClaudeWoW.Connect(true)
end

function Cli.Links.cancel(arg)
	ClaudeWoW.Cancel(FindChat(Cli.Split(arg)[1]))
end

function Cli.Links.send(arg)
	local c = FindChat(Cli.Split(arg)[1])
	if not c or c.pendingId or not c.draft or c.draft == "" then return end
	local text = c.draft
	c.draft = nil
	ClaudeWoW.Send(text, nil, { chat = c.id })
end

function Cli.Links.roll(arg)
	local parts = Cli.Split(arg)
	local c, msgId, choice = FindChat(parts[1]), tonumber(parts[2]), parts[3]
	if not c then return end
	local rules, openId = ClaudeWoW.OpenDenial(c.id)
	if not rules or openId ~= msgId then
		Whisper.System(c, "That request was answered already.")
		return
	end
	if choice ~= "pass" and Q.GrantHeld() then
		ClaudeWoWRoll.HoldGrant(c.id, msgId)
		return
	end
	local current = ClaudeWoWRoll and ClaudeWoWRoll.Current()
	if current and current.chatId == c.id and current.msgId == msgId then
		ClaudeWoWRoll.Choose(choice)
	elseif choice == "need" then
		ClaudeWoW.ConfirmAllow(c.id, msgId, rules)
	elseif choice == "greed" then
		ClaudeWoW.AllowOnce(c.id, rules)
	elseif choice == "pass" then
		ClaudeWoW.PassOnDenial(c.id, rules)
	end
end

function Cli.Links.macro(arg)
	local parts = Cli.Split(arg)
	local m = Cli.FindMessage(FindChat(parts[1]), parts[2])
	local macro = m and m.macros and m.macros[tonumber(parts[3]) or 0]
	if macro then ClaudeWoW.MacroPrompt(macro) end
end

function Cli.Links.url(arg, button)
	if arg == "" then return end
	local copyClick = button == "RightButton"
		or (type(IsControlKeyDown) == "function" and IsControlKeyDown())
		or (type(IsShiftKeyDown) == "function" and IsShiftKeyDown())
	if copyClick then return ClaudeWoW.ShowCopy(arg) end
	local result = ClaudeWoW.OpenUrl(arg)
	if result == "sent" then
		if UIErrorsFrame then UIErrorsFrame:AddMessage("Opening in your browser", 1, 0.82, 0, 1) end
	elseif result == "busy" then
		if UIErrorsFrame then UIErrorsFrame:AddMessage("Still opening the last link", 1, 0.82, 0, 1) end
	elseif result == "wait" then
		if UIErrorsFrame then UIErrorsFrame:AddMessage("Wait a moment before the next link", 1, 0.82, 0, 1) end
	else
		ClaudeWoW.ShowCopy(arg)
	end
end

function Cli.Links.map(arg)
	if ClaudeWoWMap and ClaudeWoWMap.ShowLayer then ClaudeWoWMap.ShowLayer(arg) end
end

function ClaudeWoW.OnLink(link, button)
	if not db then return false end
	link = tostring(link or "")
	local body = link:match("^addon:claudewow:(.*)$") or link:match("^claudewow:(.*)$")
	if not body then return false end
	local action, arg = body:match("^(%a+):?(.*)$")
	local fn = action and Cli.Links[action]
	if not fn then return false end
	fn(arg or "", button)
	return true
end

hooksecurefunc("SetItemRef", function(link, _, button)
	ClaudeWoW.OnLink(link, button)
end)

-- Shift-clicking an item, spell, quest or name puts its link into the chat box
-- being typed in. Blizzard's insert function only knows its own boxes, so when
-- ours has the keyboard, take the link too. With no box focused the shift-click
-- keeps its normal meaning (splitting a stack, for one).
--
-- On this client (modern UI code, Blizzard_ChatFrameUtil) every shift-click
-- ends in ChatFrameUtil.InsertLink; ChatEdit_InsertLink is the older global
-- name, hooked only where the new one is missing so one click inserts once.
local function TakeLink(text)
	if text and text ~= "" and ui.input and ui.input:HasFocus() then
		ui.input:Insert(text)
	end
end
if type(ChatFrameUtil) == "table" and type(ChatFrameUtil.InsertLink) == "function" then
	hooksecurefunc(ChatFrameUtil, "InsertLink", TakeLink)
elseif type(ChatEdit_InsertLink) == "function" then
	hooksecurefunc("ChatEdit_InsertLink", TakeLink)
end

---------------------------------------------------------------------------
-- UI
---------------------------------------------------------------------------

function ClaudeWoW.ClearChat(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if c then wipe(c.history) end
	ClaudeWoW.Render()
end

local function MakeButton(parent, label, width, onClick)
	local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
	b:SetSize(width, 22)
	b:SetText(label)
	b:SetScript("OnClick", onClick)
	return b
end

local PANEL_W = 150
Q.PORTRAIT = "Interface\\AddOns\\ClaudeWoW\\Portrait"
Q.NATIVE_TEMPLATES = { "ButtonFrameTemplate", "InsetFrameTemplate" }
Q.LIST_W = 300
Q.LIST_MIN_W = 200
Q.LIST_SHARE = 0.38
Q.COMPOSER_BOTTOM = 2
Q.COMPOSER_GAP = 6
Q.EFFORT_H = 16
Q.EFFORT_GAP = 2
Q.STOP_W = 48
Q.STOP_H = 18
Q.STOP_INSET = 5
Q.NAV_TOP = -24
Q.NAV_H = 34
Q.LIST_ROW_H = 20
Q.LIST_HEADER_H = 22
Q.NO_FOLDER = "Chats"
Q.QUEST_ART = {
	listBg = "QuestLog-main-background",
	header = "common-button-list-collapseExpand",
	plus = "common-button-list-plus",
	minus = "common-button-list-minus",
	rowGlow = "questlog-quest-glow-yellow",
	working = "Quest-In-Progress-Icon-yellow",
	reply = "UI-QuestIcon-TurnIn-Normal",
	parchment = "QuestBG-Parchment",
	poi = "UI-QuestPoi-QuestNumber",
	poiSelected = "UI-QuestPoi-QuestNumber-SuperTracked",
	poiPushed = "UI-QuestPoi-QuestNumber-Pressed",
	poiOuter = "UI-QuestPoi-OuterGlow",
	poiInner = "UI-QuestPoi-InnerGlow",
	workingSelected = "Quest-In-Progress-Icon-Brown",
	frame = "questlog-frame",
	filigree = "questlog-frame-filigree",
	gradient = "questlog-frame-gradient-bottom",
	gear = "questlog-icon-setting",
}
Q.ROW_TITLE_X = 31
Q.ROW_TOP = 8
Q.ROW_BOTTOM = 6
Q.POI_TOP = 4
Q.POI_SIZE = 20
Q.ROW_MIN_H = Q.POI_TOP + Q.POI_SIZE + Q.ROW_BOTTOM
Q.OBJECTIVE_GAP = 3
Q.OBJECTIVE_LINE_GAP = 2
Q.HEADER_INSET = 9
Q.HEADER_RIGHT = 6
Q.PAD_FIRST = 8
Q.PAD_HEADER_AFTER_HEADER = 6
Q.PAD_HEADER_AFTER_ROW = 4
Q.PAD_ROW_AFTER_HEADER = 2
Q.PAD_ROW_AFTER_ROW = -3
Q.TITLE_IDLE = { 0.75, 0.61, 0 }
Q.TITLE_WORKING = { 1, 1, 0 }
Q.TITLE_REPLY = { 0.25, 0.75, 0.25 }
Q.TITLE_NEEDS_YOU = { 1, 0.4, 0.1 }

function Q.TitleColor(c)
	if c.pendingId then return Q.TITLE_WORKING end
	if Q.DenialIndex(c) then return Q.TITLE_NEEDS_YOU end
	if (c.unread or 0) > 0 then return Q.TITLE_REPLY end
	return Q.TITLE_IDLE
end
Q.COUNT_W = 92
Q.STATUS_HIT_W = 260
Q.CTX_BAR_W, Q.CTX_BAR_H = 120, 13
Q.CTX_TICK_W = 2
Q.CTX_BAR_GAP = 24
Q.CTX_BAR_RIGHT_X, Q.CTX_BAR_Y = -40, 9
Q.CTX_WARN_LEVEL = 3
Q.CTX_DEFAULT_WINDOW = 200000
Q.CTX_LEVELS = {
	{ upTo = 0.50, color = { 0.10, 0.75, 0.10 } },
	{ upTo = 0.75, color = { 1.00, 0.82, 0.00 } },
	{ upTo = 0.90, color = { 1.00, 0.50, 0.00 } },
	{ upTo = math.huge, color = { 0.85, 0.10, 0.10 } },
}

function Q.ContextWindow(c)
	return (c and c.window) or Q.CTX_DEFAULT_WINDOW
end

function Q.ContextColor(fraction)
	for _, level in ipairs(Q.CTX_LEVELS) do
		if fraction <= level.upTo then return level.color end
	end
end

function Q.ContextBar(f)
	local bar = CreateFrame("StatusBar", "ClaudeWoWContextBar", f)
	bar:SetSize(Q.CTX_BAR_W, Q.CTX_BAR_H)
	bar:SetStatusBarTexture("Interface\\TargetingFrame\\UI-StatusBar")
	bar:SetMinMaxValues(0, 1)
	local bg = bar:CreateTexture(nil, "BACKGROUND")
	bg:SetAllPoints()
	bg:SetColorTexture(0, 0, 0, 0.6)
	local border = CreateFrame("Frame", nil, bar, "BackdropTemplate")
	border:SetPoint("TOPLEFT", bar, "TOPLEFT", -2, 2)
	border:SetPoint("BOTTOMRIGHT", bar, "BOTTOMRIGHT", 2, -2)
	if border.SetBackdrop then
		border:SetBackdrop({ edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", edgeSize = 8 })
		border:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	end
	bar.tick = bar:CreateTexture(nil, "OVERLAY")
	bar.tick:SetColorTexture(1, 0.95, 0.8, 0.9)
	bar.tick:SetSize(Q.CTX_TICK_W, Q.CTX_BAR_H)
	bar.tick:Hide()
	bar.text = bar:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	bar.text:SetPoint("CENTER", bar, "CENTER", 0, 0)
	bar:EnableMouse(true)
	bar:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Context")
		local c = ActiveChat()
		GameTooltip:AddLine(ContextReport(c), 1, 1, 1, true)
		GameTooltip:Show()
	end)
	bar:SetScript("OnLeave", function() GameTooltip:Hide() end)
	bar:Hide()
	return bar
end

function Q.UpdateContextBar(c)
	local bar = ui.ctxBar
	if not bar then return end
	if not (c and c.ctx) then
		bar:Hide()
		return
	end
	local window = Q.ContextWindow(c)
	local fraction = c.ctx / window
	local color = Q.ContextColor(fraction)
	local warn = tonumber(db.settings.contextWarn) or 0
	local warnLevel = Q.CTX_LEVELS[Q.CTX_WARN_LEVEL]
	if warn > 0 and c.ctx >= warn and fraction <= warnLevel.upTo then color = warnLevel.color end
	if warn > 0 and warn < window then
		bar.tick:ClearAllPoints()
		bar.tick:SetPoint("TOP", bar, "TOPLEFT", bar:GetWidth() * warn / window, 0)
		bar.tick:Show()
	else
		bar.tick:Hide()
	end
	bar:SetValue(math.min(fraction, 1))
	bar:SetStatusBarColor(color[1], color[2], color[3])
	bar.fraction = fraction
	bar.text:SetText(FmtTokens(c.ctx) .. " / " .. FmtTokens(window))
	bar:Show()
end

function Q.ShortStatus(c)
	local state, _, started = Q.StatusState(c)
	if state == "working" then
		return "|cffffd100" .. Q.STATUS_WORKING .. "|r " .. FmtDur(GetTime() - (started or GetTime()))
	end
	if state == "connecting" then return "|cffffd100" .. Q.STATUS_CONNECTING .. "|r" end
	if state == "failed" then return "|cffff5050" .. Q.STATUS_NO_ANSWER .. "|r" end
	if state == "down" then return "|cffff5050" .. Q.STATUS_UNREACHABLE .. "|r" end
	if state == "reply" then return "|cff55ff55" .. Q.STATUS_REPLY .. "|r" end
	return Q.STATUS_READY
end

function Q.TotalCost()
	local total, chats = 0, 0
	for _, ch in ipairs(db.chats) do
		if type(ch.cost) == "number" then
			total = total + ch.cost
			chats = chats + 1
		end
	end
	return total, chats
end

function Q.StatusTooltip()
	local c = ActiveChat()
	if run.statusText then GameTooltip:AddLine(run.statusText, 1, 1, 1, true) end
	local total, chats = Q.TotalCost()
	if (c and c.cost) or chats > 0 then
		GameTooltip:AddLine(" ")
		GameTooltip:AddLine("Estimated API cost", 1, 0.82, 0)
		if c and c.cost then GameTooltip:AddDoubleLine("This chat", string.format("$%.2f", c.cost), 1, 1, 1, 1, 1, 1) end
		if chats > 0 then GameTooltip:AddDoubleLine("All chats", string.format("$%.2f", total), 1, 1, 1, 1, 1, 1) end
		GameTooltip:AddLine("At API list prices: a comparison, not a bill. A subscription is not charged per token.", 0.6, 0.6, 0.6, true)
	end
end

Q.MINIMAP_NAME = "ClaudeWoWMinimapButton"
Q.MINIMAP_SIZE = 31
Q.MINIMAP_ANGLE_DEFAULT = 225
Q.MINIMAP_EDGE_PAD = 5
Q.MINIMAP_DIAGONAL_INSET = 10
Q.MINIMAP_ICON = "Interface\\AddOns\\ClaudeWoW\\MinimapIcon"
Q.MINIMAP_ICON_MASK = "Interface\\CharacterFrame\\TempPortraitAlphaMask"
Q.MINIMAP_ICON_INSET = { 0.05, 0.95, 0.05, 0.95 }
Q.MINIMAP_ICON_PRESSED = { 0, 1, 0, 1 }
Q.MINIMAP_PORTRAIT_INSET = { 0.2, 0.8, 0.2, 0.8 }
Q.MINIMAP_PORTRAIT_PRESSED = { 0.18, 0.82, 0.18, 0.82 }
Q.MINIMAP_BORDER = "Interface\\Minimap\\MiniMap-TrackingBorder"
Q.MINIMAP_BACKGROUND = "Interface\\Minimap\\UI-Minimap-Background"
Q.MINIMAP_HIGHLIGHT = "Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight"
Q.MINIMAP_HINT_COLOR = { 0.1, 1, 0.1 }
Q.MINIMAP_HINT_LEFT = "Left-click: open or close"
Q.MINIMAP_HINT_RIGHT = "Right-click: options"
Q.MINIMAP_ROUND_QUADRANTS = {
	ROUND = { true, true, true, true },
	SQUARE = { false, false, false, false },
	["CORNER-TOPLEFT"] = { false, false, false, true },
	["CORNER-TOPRIGHT"] = { false, false, true, false },
	["CORNER-BOTTOMLEFT"] = { false, true, false, false },
	["CORNER-BOTTOMRIGHT"] = { true, false, false, false },
	["SIDE-LEFT"] = { false, true, false, true },
	["SIDE-RIGHT"] = { true, false, true, false },
	["SIDE-TOP"] = { false, false, true, true },
	["SIDE-BOTTOM"] = { true, true, false, false },
	["TRICORNER-TOPLEFT"] = { false, true, true, true },
	["TRICORNER-TOPRIGHT"] = { true, false, true, true },
	["TRICORNER-BOTTOMLEFT"] = { true, true, false, true },
	["TRICORNER-BOTTOMRIGHT"] = { true, true, true, false },
}
Q.MINIMAP_LAYOUT_MAINLINE = { border = 50, background = 24, icon = 18, centered = true }
Q.MINIMAP_LAYOUT_CLASSIC = { border = 53, background = 20, backgroundX = 7, backgroundY = -5, icon = 17, iconX = 7, iconY = -6 }
Q.MINIMAP_DOT_SIZE = 8
Q.MINIMAP_DOT_X, Q.MINIMAP_DOT_Y = -2, 2
Q.MINIMAP_DOT_SUBLEVEL = 7
Q.MINIMAP_PULSE_LOW, Q.MINIMAP_PULSE_SECONDS = 0.15, 0.8
Q.MINIMAP_WORKING_GLOW = 0.4

function Q.MinimapButtonOn()
	return db.settings.minimap ~= false
end

function Q.MinimapAngle()
	return tonumber(db.settings.minimapAngle) or Q.MINIMAP_ANGLE_DEFAULT
end

function Q.MinimapShape()
	if type(GetMinimapShape) ~= "function" then return "ROUND" end
	local ok, shape = pcall(GetMinimapShape)
	return ok and Q.MINIMAP_ROUND_QUADRANTS[shape] and shape or "ROUND"
end

function Q.MinimapOffset(angle, width, height, shape)
	local radians = math.rad(angle)
	local x, y, quadrant = math.cos(radians), math.sin(radians), 1
	if x < 0 then quadrant = quadrant + 1 end
	if y > 0 then quadrant = quadrant + 2 end
	local w, h = width / 2 + Q.MINIMAP_EDGE_PAD, height / 2 + Q.MINIMAP_EDGE_PAD
	if Q.MINIMAP_ROUND_QUADRANTS[shape or "ROUND"][quadrant] then return x * w, y * h end
	local diagonalW = math.sqrt(2 * w * w) - Q.MINIMAP_DIAGONAL_INSET
	local diagonalH = math.sqrt(2 * h * h) - Q.MINIMAP_DIAGONAL_INSET
	return math.max(-w, math.min(x * diagonalW, w)), math.max(-h, math.min(y * diagonalH, h))
end

function Q.PlaceMinimapButton(button)
	local x, y = Q.MinimapOffset(Q.MinimapAngle(), Minimap:GetWidth(), Minimap:GetHeight(), Q.MinimapShape())
	button:ClearAllPoints()
	button:SetPoint("CENTER", Minimap, "CENTER", x, y)
end

function Q.CursorAngle()
	local mx, my = Minimap:GetCenter()
	local px, py = GetCursorPosition()
	if not (mx and my and px and py) then return nil end
	local scale = Minimap:GetEffectiveScale()
	local atan2 = math.atan2 or math.atan
	return math.deg(atan2(py / scale - my, px / scale - mx)) % 360
end

function Q.MinimapDragUpdate(button)
	local angle = Q.CursorAngle()
	if not angle then return end
	db.settings.minimapAngle = angle
	Q.PlaceMinimapButton(button)
end

function Q.PlainStatus(c)
	local state = Q.StatusState(c)
	if state == "working" then return Q.STATUS_WORKING end
	if state == "connecting" then return Q.STATUS_CONNECTING end
	if state == "failed" then return Q.STATUS_NO_ANSWER end
	if state == "down" then return Q.STATUS_UNREACHABLE end
	if state == "reply" then return Q.STATUS_REPLY end
	return Q.STATUS_READY
end

function Q.MinimapTooltip(button)
	if button.dragging then return end
	local green = Q.MINIMAP_HINT_COLOR
	GameTooltip:SetOwner(button, "ANCHOR_LEFT")
	GameTooltip:SetText(ClaudeWoW.PRODUCT)
	GameTooltip:AddLine(Q.PlainStatus(ActiveChat()), 1, 1, 1, true)
	local activity = Q.ActivityText(Q.ChatActivity())
	if activity ~= "" then GameTooltip:AddLine(activity, 1, 0.82, 0, true) end
	Q.StatusTooltip()
	GameTooltip:AddLine(" ")
	GameTooltip:AddLine(Q.MINIMAP_HINT_LEFT, green[1], green[2], green[3])
	GameTooltip:AddLine(Q.MINIMAP_HINT_RIGHT, green[1], green[2], green[3])
	GameTooltip:Show()
end

function Q.MinimapClick(_, mouseButton)
	if mouseButton == "RightButton" then
		ClaudeWoW.ShowOptions()
	else
		ClaudeWoW.ToggleWorkspace()
	end
end

function Q.MinimapDragStart(button)
	button.dragging = true
	button:LockHighlight()
	Q.MinimapMouseDown(button)
	GameTooltip:Hide()
	button:SetScript("OnUpdate", Q.MinimapDragUpdate)
end

function Q.MinimapDragStop(button)
	button:SetScript("OnUpdate", nil)
	button.dragging = nil
	button:UnlockHighlight()
	Q.MinimapMouseUp(button)
	Q.PlaceMinimapButton(button)
end

function Q.MinimapLayout()
	if WOW_PROJECT_ID ~= nil and WOW_PROJECT_ID == WOW_PROJECT_MAINLINE then return Q.MINIMAP_LAYOUT_MAINLINE end
	return Q.MINIMAP_LAYOUT_CLASSIC
end

function Q.SetMinimapIcon(icon)
	local ok, found = pcall(icon.SetTexture, icon, Q.MINIMAP_ICON)
	if ok and found ~= false then return Q.MINIMAP_ICON end
	icon:SetTexture(Q.PORTRAIT)
	if type(icon.SetMask) == "function" then pcall(icon.SetMask, icon, Q.MINIMAP_ICON_MASK) end
	return Q.PORTRAIT
end

function Q.UpdateMinimapIconCoord(button)
	local portrait = button.iconFile == Q.PORTRAIT
	local rest = portrait and Q.MINIMAP_PORTRAIT_INSET or Q.MINIMAP_ICON_INSET
	local pressed = portrait and Q.MINIMAP_PORTRAIT_PRESSED or Q.MINIMAP_ICON_PRESSED
	local coords = button.isMouseDown and pressed or rest
	button.icon:SetTexCoord(coords[1], coords[2], coords[3], coords[4])
end

function Q.MinimapMouseDown(button)
	button.isMouseDown = true
	Q.UpdateMinimapIconCoord(button)
end

function Q.MinimapMouseUp(button)
	button.isMouseDown = false
	Q.UpdateMinimapIconCoord(button)
end

function Q.BuildMinimapButton()
	if ui.minimap then return ui.minimap end
	if type(Minimap) ~= "table" then return nil end
	local layout = Q.MinimapLayout()
	local button = CreateFrame("Button", Q.MINIMAP_NAME, Minimap)
	button:SetSize(Q.MINIMAP_SIZE, Q.MINIMAP_SIZE)
	button:SetFrameStrata("MEDIUM")
	button:SetFrameLevel(8)
	button:RegisterForClicks("AnyUp")
	button:RegisterForDrag("LeftButton")
	button:SetHighlightTexture(Q.MINIMAP_HIGHLIGHT)

	local border = button:CreateTexture(nil, "OVERLAY")
	border:SetSize(layout.border, layout.border)
	border:SetTexture(Q.MINIMAP_BORDER)
	border:SetPoint("TOPLEFT", button, "TOPLEFT", 0, 0)
	button.border = border

	local background = button:CreateTexture(nil, "BACKGROUND")
	background:SetSize(layout.background, layout.background)
	background:SetTexture(Q.MINIMAP_BACKGROUND)
	local icon = button:CreateTexture(nil, "ARTWORK")
	icon:SetSize(layout.icon, layout.icon)
	button.iconFile = Q.SetMinimapIcon(icon)
	if layout.centered then
		background:SetPoint("CENTER", button, "CENTER", 0, 0)
		icon:SetPoint("CENTER", button, "CENTER", 0, 0)
	else
		background:SetPoint("TOPLEFT", button, "TOPLEFT", layout.backgroundX, layout.backgroundY)
		icon:SetPoint("TOPLEFT", button, "TOPLEFT", layout.iconX, layout.iconY)
	end
	button.background, button.icon = background, icon
	button.isMouseDown = false
	Q.UpdateMinimapIconCoord(button)
	Q.BuildMinimapSignal(button)

	button:SetScript("OnClick", Q.MinimapClick)
	button:SetScript("OnDragStart", Q.MinimapDragStart)
	button:SetScript("OnDragStop", Q.MinimapDragStop)
	button:SetScript("OnMouseDown", Q.MinimapMouseDown)
	button:SetScript("OnMouseUp", Q.MinimapMouseUp)
	button:SetScript("OnEnter", Q.MinimapTooltip)
	button:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.minimap = button
	Q.PlaceMinimapButton(button)
	Q.ApplyMinimapButton()
	return button
end

function Q.BuildMinimapSignal(button)
	local glow = button:CreateTexture(nil, "OVERLAY")
	glow:SetAllPoints(button)
	glow:SetTexture(Q.MINIMAP_HIGHLIGHT)
	glow:SetBlendMode("ADD")
	glow:Hide()
	button.glow = glow
	local ok, pulse = pcall(function()
		local g = glow:CreateAnimationGroup()
		local fade = g:CreateAnimation("Alpha")
		fade:SetFromAlpha(1)
		fade:SetToAlpha(Q.MINIMAP_PULSE_LOW)
		fade:SetDuration(Q.MINIMAP_PULSE_SECONDS)
		fade:SetOrder(1)
		local back = g:CreateAnimation("Alpha")
		back:SetFromAlpha(Q.MINIMAP_PULSE_LOW)
		back:SetToAlpha(1)
		back:SetDuration(Q.MINIMAP_PULSE_SECONDS)
		back:SetOrder(2)
		g:SetLooping("REPEAT")
		return g
	end)
	if ok then button.pulse = pulse end
	local dot = button:CreateTexture(nil, "OVERLAY", nil, Q.MINIMAP_DOT_SUBLEVEL)
	dot:SetSize(Q.MINIMAP_DOT_SIZE, Q.MINIMAP_DOT_SIZE)
	dot:SetPoint("BOTTOMRIGHT", button, "BOTTOMRIGHT", Q.MINIMAP_DOT_X, Q.MINIMAP_DOT_Y)
	dot:SetTexture(STATE_ICON.unknown)
	button.dot = dot
	ui.minimapDot = dot
end

function Q.MinimapSignal()
	if ui.frame and ui.frame:IsShown() then return "idle" end
	local unread, working = Q.ChatActivity()
	if unread > 0 then return "reply" end
	if working > 0 then return "working" end
	return "idle"
end

function Q.UpdateMinimapSignal()
	local button = ui.minimap
	if not (button and button.glow and db) then return end
	local signal = Q.MinimapSignal()
	button.signal = signal
	if signal == "reply" then
		button.glow:SetAlpha(1)
		button.glow:Show()
		if button.pulse and not button.pulse:IsPlaying() then button.pulse:Play() end
		return
	end
	if button.pulse then button.pulse:Stop() end
	button.glow:SetAlpha(Q.MINIMAP_WORKING_GLOW)
	button.glow:SetShown(signal == "working")
end

function Q.ApplyMinimapButton()
	if not ui.minimap then return end
	ui.minimap:SetShown(Q.MinimapButtonOn())
	ClaudeWoW.UpdateDot()
	Q.UpdateMinimapSignal()
end

Q.PARCHMENT_STYLE = {
	user      = { color = { 0.10, 0.22, 0.45 }, bg = { 0.10, 0.20, 0.40, 0.07 } },
	assistant = { color = { 0.45, 0.13, 0.02 }, bg = { 0, 0, 0, 0 } },
	system    = { color = { 0.32, 0.25, 0.16 }, bg = { 0, 0, 0, 0 } },
}
Q.PARCHMENT_TEXT, Q.PARCHMENT_DIM = { 0.18, 0.12, 0.06 }, { 0.38, 0.30, 0.20 }

function Q.TemplateExists(name)
	return type(C_XMLUtil) == "table" and Try(C_XMLUtil.GetTemplateInfo, name) ~= nil
end

function Q.NativeFrames()
	for _, name in ipairs(Q.NATIVE_TEMPLATES) do
		if not Q.TemplateExists(name) then return false end
	end
	return true
end

function Q.AtlasExists(name)
	return C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists(name) and true or false
end

Q.PANEL_TITLE = ClaudeWoW.PRODUCT
Q.WINDOW_STRATA = "HIGH"

Q.BRIDGE_CHECK_SECONDS = 20
Q.LOGIN_NOTICE = ClaudeWoW.PREFIX .. "Loaded. Type /claude to open it."
Q.LOGIN_NOTICE_MINIMAP = ClaudeWoW.PREFIX .. "Loaded. Click the minimap button or type /claude to open it."
Q.REPLY_WAITING_NOTICE = " replied. Type /claude to open the window."
Q.UNREACHABLE_NOTICE = ClaudeWoW.PREFIX .. "Can't reach the companion app. Start it, then type /claude and click Connect."

function Q.LoginNotice()
	if db.settings.loginNoticeV1 then return end
	db.settings.loginNoticeV1 = true
	print(Q.MinimapButtonOn() and Q.LOGIN_NOTICE_MINIMAP or Q.LOGIN_NOTICE)
end

function Q.UnreachableNotice()
	run.loginChecked = true
	if run.unreachableTold or ClaudeWoW.IsConnected() or run.connectingAt then return end
	run.unreachableTold = true
	print(Q.UNREACHABLE_NOTICE)
end

Q.LINK_RETRY_SECONDS, Q.LINK_RETRIES = 0.5, 3
Q.linkTries = {}
Q.linkMissing = false

function Q.ItemLink(id)
	local info = (C_Item and C_Item.GetItemInfo) or GetItemInfo
	local _, link = Try(info, id)
	if type(link) == "string" then return link end
	Q.linkMissing = true
	if C_Item and C_Item.RequestLoadItemDataByID then pcall(C_Item.RequestLoadItemDataByID, id) end
	return nil
end

function Q.SpellLink(id)
	local link = Try((C_Spell and C_Spell.GetSpellLink) or GetSpellLink, id)
	if type(link) == "string" then return link end
	if C_Spell and C_Spell.RequestLoadSpellData then
		Q.linkMissing = true
		pcall(C_Spell.RequestLoadSpellData, id)
	end
	return nil
end

function Q.QuestTitle(id)
	local n = Try(C_QuestLog and C_QuestLog.GetNumQuestLogEntries) or Try(GetNumQuestLogEntries) or 0
	for i = 1, math.min(tonumber(n) or 0, 60) do
		local info = Try(C_QuestLog and C_QuestLog.GetInfo, i)
		if type(info) == "table" then
			if tonumber(info.questID) == id and not info.isHeader then return info.title, info.level, i end
		else
			local title, level, _, isHeader, _, _, _, qid = Try(GetQuestLogTitle, i)
			if tonumber(qid) == id and not isHeader then return title, level, i end
		end
	end
	return nil
end

function Q.RichToken(kind, id)
	id = tonumber(id)
	if not id then return nil end
	if kind == "item" then return Q.ItemLink(id) end
	if kind == "spell" then return Q.SpellLink(id) end
	if kind == "quest" then
		local title, level = Q.QuestTitle(id)
		return title and ("|cffffff00|Hquest:" .. id .. ":" .. math.floor(tonumber(level) or 0) .. "|h[" .. Display(title):gsub("[%[%]]", "") .. "]|h|r") or nil
	end
	return nil
end

Q.PARCHMENT_LINK_COLORS = {
	ff9d9d9d = "ff5c5248", ffffffff = "ff2e1f0f", ff1eff00 = "ff0d6b00", ff0070dd = "ff004c99", ffa335ee = "ff6a1b9a",
	ffff8000 = "ff9a4a00", ffe6cc80 = "ff7a5c1e", ffffff00 = "ff7a3b00", ffffd100 = "ff7a3b00", ff71d5ff = "ff1c4f9c",
}

Q.GAME_LINK_COLORS = {}
for game, dark in pairs(Q.PARCHMENT_LINK_COLORS) do
	if game ~= "ffffd100" then Q.GAME_LINK_COLORS[dark] = game end
end

function Q.OffParchment(text)
	return (tostring(text or ""):gsub("|c(%x%x%x%x%x%x%x%x)", function(hex)
		local game = Q.GAME_LINK_COLORS[hex:lower()]
		return game and ("|c" .. game) or nil
	end))
end

function Q.OnParchment(link)
	return (link:gsub("|c(%x%x%x%x%x%x%x%x)", function(hex)
		local dark = Q.PARCHMENT_LINK_COLORS[hex:lower()]
		return dark and ("|c" .. dark) or nil
	end))
end

Q.URL_CHARS = "[%w%-%._~:/%?#@!%$&'%(%)%+,;=%%]"
Q.TEXT_INK = { game = { strong = "ffffffff", code = "ffa8c8d8", link = "ff71d5ff" } }
Q.TEXT_INK.parchment = { strong = "ff5c1a00", code = "ff7a2e0e", link = Q.PARCHMENT_LINK_COLORS[Q.TEXT_INK.game.link] }

function Q.UrlLabel(url)
	local n = url:match("^https?://github%.com/[^/]+/[^/]+/pull/(%d+)")
	if n then return "PR #" .. n end
	n = url:match("^https?://github%.com/[^/]+/[^/]+/issues/(%d+)")
	if n then return "Issue #" .. n end
	local key = url:match("^https?://linear%.app/[^/]+/issue/(%u+%-%d+)")
	if key then return key end
	local short = url:gsub("^https?://", ""):gsub("^www%.", ""):gsub("/$", "")
	return #short > 32 and (short:sub(1, 31) .. "\226\128\166") or short
end

function Q.UrlLink(url, label, ink)
	return "|c" .. ink.link .. "|H" .. LINK_PREFIX .. "url:" .. url .. "|h[" .. label:gsub("[%[%]%*`]", "") .. "]|h|r"
end

function Q.SplitUrl(url)
	local trail = ""
	while true do
		local last = url:sub(-1)
		local _, opens = url:gsub("%(", "")
		local _, closes = url:gsub("%)", "")
		if last:match("[%.,;:!%?]") or (last == ")" and closes > opens) then
			trail, url = last .. trail, url:sub(1, -2)
		else
			return url, trail
		end
	end
end

function Q.MarkFences(text)
	local out, fenced = {}, false
	for line in (tostring(text or "") .. "\n"):gmatch("(.-)\n") do
		if line:match("^%s*```") then fenced = not fenced
		elseif fenced and line:match("%S") then table.insert(out, "\3" .. line)
		else table.insert(out, line) end
	end
	return table.concat(out, "\n")
end

Q.SUMMARY_STRIP_CHARS = 400

function Q.SummaryMarkerEnd(line)
	local s = line:lower()
	local i = s:match("^[ \t]*#*[ \t]*()")
	local bold = s:sub(i, i + 1)
	if bold == "**" or bold == "__" then i = s:match("^..[ \t]*()", i) end
	i = s:match("^tl;?dr()", i)
	if not i then return nil end
	i = s:match("^[ \t]*:?[ \t]*()", i)
	bold = s:sub(i, i + 1)
	if bold == "**" or bold == "__" then i = i + 2 end
	return s:match("^[ \t]*:?[ \t]*()", i)
end

function Q.FenceRun(line)
	local run, rest = line:match("^%s*(```+)(.*)$")
	if not run then run, rest = line:match("^%s*(~~~+)(.*)$") end
	if not run then return nil end
	return run:sub(1, 1), #run, rest
end

function Q.StripSummary(text, summary)
	text = tostring(text or "")
	local lines, open, at, after, inFence = {}, nil, nil, nil, false
	for line in (text .. "\n"):gmatch("(.-)\n") do
		table.insert(lines, line)
		local mark, size, rest = Q.FenceRun(line)
		if open and mark == open.mark and size >= open.size and rest:match("^%s*$") then
			open = nil
		elseif not open and mark then
			open = { mark = mark, size = size }
		else
			local e = Q.SummaryMarkerEnd(line)
			if e then at, after, inFence = #lines, e, open ~= nil end
		end
	end
	if not at or inFence then return text end
	local rest = { lines[at]:sub(after) }
	for k = at + 1, #lines do table.insert(rest, lines[k]) end
	local tail = Trim(table.concat(rest, "\n"))
	if tail == "" or #tail > Q.SUMMARY_STRIP_CHARS then return text end
	local tailLines = 0
	for _ in tail:gmatch("[^\n]*%S[^\n]*") do tailLines = tailLines + 1 end
	if tailLines > ECHO.SUMMARY_LINES then return text end
	if type(summary) == "string" and summary ~= "" and Trim(summary) ~= tail then return text end
	local head = table.concat(lines, "\n", 1, at - 1):gsub("%s+$", "")
	return head ~= "" and head or tail
end

function Q.MarkdownLine(line, ink, parchment)
	if line:sub(1, 1) == "\3" then return line:sub(2) end
	local held = {}
	local function hold(link) table.insert(held, link) return "\1" .. #held .. "\2" end
	line = line:gsub("^[%-%*] ", "\226\128\162 ")
	line = line:gsub("^%s*#+%s+(.+)$", "**%1**")
	line = line:gsub("%[([^%]]+)%]%((https?://" .. Q.URL_CHARS .. "+)%)", function(label, found)
		local url, trail = Q.SplitUrl(found)
		return hold(Q.UrlLink(url, label, ink)) .. trail
	end)
	line = line:gsub("(https?://" .. Q.URL_CHARS .. "+)", function(found)
		local url, trail = Q.SplitUrl(found)
		if not url:match("^https?://[%w%-]") then return found end
		return hold(Q.UrlLink(url, Q.UrlLabel(url), ink)) .. trail
	end)
	line = line:gsub("%*%*([^%*]+)%*%*", "|c" .. ink.strong .. "%1|r")
	line = line:gsub("`([^`]+)`", "|c" .. ink.code .. "%1|r")
	line = line:gsub("\1(%d+)\2", function(k) return held[tonumber(k)] end)
	return (line:gsub("{(%a+):(%d+)}", function(kind, id)
		local shown = Q.RichToken(kind:lower(), id) or ("|cff9d9d9d" .. kind .. " " .. id .. "|r")
		return parchment and Q.OnParchment(shown) or shown
	end))
end

function Q.Markdown(text, parchment)
	local ink = parchment and Q.TEXT_INK.parchment or Q.TEXT_INK.game
	local lines = {}
	for line in (Q.MarkFences(text) .. "\n"):gmatch("(.-)\n") do table.insert(lines, Q.MarkdownLine(line, ink, parchment)) end
	return table.concat(lines, "\n")
end

function Q.RichText(text, parchment)
	return Q.Markdown(tostring(text or ""), parchment)
end

function Q.WaitForLinks(text, key)
	Q.linkMissing = false
	Q.RichText(text)
	if not Q.linkMissing then return false end
	local tries = (Q.linkTries[key] or 0) + 1
	Q.linkTries[key] = tries
	return tries <= Q.LINK_RETRIES
end

Q.linkEvents = CreateFrame("Frame")
pcall(Q.linkEvents.RegisterEvent, Q.linkEvents, "GET_ITEM_INFO_RECEIVED")
pcall(Q.linkEvents.RegisterEvent, Q.linkEvents, "SPELL_DATA_LOAD_RESULT")
Q.linkEvents:SetScript("OnEvent", function()
	if Q.linkRedraw or not ui.frame then return end
	Q.linkRedraw = true
	C_Timer.After(Q.LINK_RETRY_SECONDS, function()
		Q.linkRedraw = nil
		if ui.frame and ui.frame:IsShown() then ClaudeWoW.Render() end
	end)
end)

function Q.CollapsedHeaders()
	local names = {}
	for i = 1, math.min(tonumber(Try(GetNumQuestLogEntries)) or 0, 60) do
		local title, _, _, isHeader, isCollapsed = Try(GetQuestLogTitle, i)
		if isHeader and isCollapsed and title then names[title] = true end
	end
	return names
end

function Q.CollapseAgain(names)
	if type(CollapseQuestHeader) ~= "function" then return end
	for i = math.min(tonumber(Try(GetNumQuestLogEntries)) or 0, 60), 1, -1 do
		local title, _, _, isHeader = Try(GetQuestLogTitle, i)
		if isHeader and names[title] then pcall(CollapseQuestHeader, i) end
	end
end

function Q.OpenQuest(id)
	local _, _, index = Q.QuestTitle(id)
	if not index and type(ExpandQuestHeader) == "function" then
		local collapsed = Q.CollapsedHeaders()
		pcall(ExpandQuestHeader, 0)
		_, _, index = Q.QuestTitle(id)
		if not index then Q.CollapseAgain(collapsed) end
	end
	if not index then return false end
	if type(QuestMapFrame_OpenToQuestDetails) == "function" then return (pcall(QuestMapFrame_OpenToQuestDetails, id)) end
	if type(QuestLog_SetSelection) ~= "function" or not QuestLogFrame then return false end
	if not QuestLogFrame:IsShown() then pcall(ShowUIPanel, QuestLogFrame) end
	if type(QuestLog_Update) == "function" then pcall(QuestLog_Update) end
	if QuestLogListScrollFrameScrollBar and tonumber(QUESTLOG_QUEST_HEIGHT) then
		pcall(QuestLogListScrollFrameScrollBar.SetValue, QuestLogListScrollFrameScrollBar, (index - 1) * QUESTLOG_QUEST_HEIGHT)
	end
	local ok = pcall(QuestLog_SetSelection, index)
	if type(QuestLog_Update) == "function" then pcall(QuestLog_Update) end
	return ok
end

function Q.LinkClick(self, link, text, button)
	self.linkClickAt = GetTime()
	local quest = tonumber(tostring(link or ""):match("^quest:(%d+)"))
	local modified = type(IsModifiedClick) == "function" and IsModifiedClick()
	if quest and not modified and Q.OpenQuest(quest) then return end
	if type(SetItemRef) == "function" then SetItemRef(link, Q.OffParchment(text), button, self) end
end

function Q.LinkEnter(self, link)
	local kind = tostring(link or ""):match("^(%a+):")
	if kind ~= "item" and kind ~= "spell" and kind ~= "quest" then return end
	GameTooltip:SetOwner(self, "ANCHOR_CURSOR")
	if pcall(GameTooltip.SetHyperlink, GameTooltip, link) then GameTooltip:Show() else GameTooltip:Hide() end
end

function Q.WhenLabel(t)
	t = tonumber(t)
	if not t then return "" end
	if date("%Y-%m-%d", t) == date("%Y-%m-%d", time()) then return "at " .. date("%H:%M", t) end
	return "on " .. date("%b %d", t)
end
Q.CLASSIC_ERA_ART = { parchment = true, reply = true }
Q.CLASSIC_ERA_GEAR = "Interface\\Icons\\INV_Misc_Gear_01"
Q.CLASSIC_PAGE = {
	{ file = "Interface\\QuestFrame\\UI-QuestLog-TopLeft", coords = { 21 / 256, 1, 177 / 256, 1 } },
	{ file = "Interface\\QuestFrame\\UI-QuestLog-TopRight", coords = { 0, 61 / 128, 177 / 256, 1 } },
	{ file = "Interface\\QuestFrame\\UI-QuestLog-BotLeft", coords = { 21 / 256, 1, 0, 179 / 256 } },
	{ file = "Interface\\QuestFrame\\UI-QuestLog-BotRight", coords = { 0, 61 / 128, 0, 179 / 256 } },
}
Q.CLASSIC_PAGE_SPLIT_X, Q.CLASSIC_PAGE_SPLIT_Y = 235 / 296, 79 / 258

function Q.LayoutClassicPage(page, w, h)
	local wl, ht = math.floor(w * Q.CLASSIC_PAGE_SPLIT_X + 0.5), math.floor(h * Q.CLASSIC_PAGE_SPLIT_Y + 0.5)
	local spots = { { 0, 0, wl, ht }, { wl, 0, w - wl, ht }, { 0, -ht, wl, h - ht }, { wl, -ht, w - wl, h - ht } }
	for i, piece in ipairs(page.pieces) do
		local spot = spots[i]
		piece:ClearAllPoints()
		piece:SetPoint("TOPLEFT", page, "TOPLEFT", spot[1], spot[2])
		piece:SetSize(math.max(1, spot[3]), math.max(1, spot[4]))
	end
end

function Q.BuildClassicPage(tex, inset)
	if not Q.IsClassicEra() then return nil end
	inset = inset or 0
	local holder = tex:GetParent()
	local page = CreateFrame("Frame", nil, holder)
	page:SetPoint("TOPLEFT", holder, "TOPLEFT", inset, -inset)
	page:SetPoint("BOTTOMRIGHT", holder, "BOTTOMRIGHT", -inset, inset)
	page:SetFrameLevel(math.max(0, (Try(holder.GetFrameLevel, holder) or 1)))
	page.pieces = {}
	for i, spec in ipairs(Q.CLASSIC_PAGE) do
		local piece = i == 1 and tex or holder:CreateTexture(nil, "BACKGROUND", nil, 1)
		if not pcall(piece.SetTexture, piece, spec.file) then return nil end
		piece:SetTexCoord(spec.coords[1], spec.coords[2], spec.coords[3], spec.coords[4])
		page.pieces[i] = piece
	end
	page:SetScript("OnSizeChanged", function(self, w, h) Q.LayoutClassicPage(self, w, h) end)
	Q.LayoutClassicPage(page, Try(page.GetWidth, page) or 300, Try(page.GetHeight, page) or 300)
	return page
end

function Q.ClassicParchment(tex, inset)
	local page = Q.BuildClassicPage(tex, inset)
	if not page then return false end
	ui.art = ui.art or {}
	ui.art.parchment = Q.CLASSIC_PAGE[1].file
	ui.classicPage = page
	return true
end

function ClaudeWoW.PaintParchment(tex)
	local atlas = Q.QUEST_ART.parchment
	if atlas and Q.ArtAllowed("parchment") and Q.AtlasExists(atlas) and pcall(tex.SetAtlas, tex, atlas) then return atlas end
	if Q.BuildClassicPage(tex, 0) then return Q.CLASSIC_PAGE[1].file end
	return nil
end

function Q.IsClassicEra()
	local _, _, _, interface = Try(GetBuildInfo)
	local toc = tonumber(interface)
	return toc ~= nil and toc >= 11500 and toc < 11600
end

function Q.ArtAllowed(key)
	return not Q.IsClassicEra() or Q.CLASSIC_ERA_ART[key] == true
end

function Q.SetArt(tex, key, useSize)
	local name = Q.QUEST_ART[key]
	local ok = name ~= nil and Q.ArtAllowed(key) and Q.AtlasExists(name) and pcall(tex.SetAtlas, tex, name, useSize)
	ui.art = ui.art or {}
	ui.art[key] = ok and name or false
	return ok and true or false
end

function Q.FontObject(name, fallback)
	return _G[name] ~= nil and name or fallback
end

function Q.FolderKey(c)
	local name = FolderName(Cli.ProjectOf(c))
	return name ~= "" and name or Q.NO_FOLDER
end

function Q.DeleteButton(parent)
	local del = CreateFrame("Button", nil, parent)
	del:SetSize(16, 16)
	if Q.AtlasExists("128-RedButton-Delete") then
		del:SetNormalAtlas("128-RedButton-Delete")
		del:SetPushedAtlas("128-RedButton-Delete-Pressed")
		del:SetHighlightAtlas("128-RedButton-Delete-Highlight")
	else
		del:SetNormalTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Up")
		del:SetHighlightTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Highlight")
	end
	del:SetScript("OnClick", function() ClaudeWoW.ConfirmDelete(parent.chatId) end)
	del:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText("Delete this chat")
		GameTooltip:Show()
	end)
	del:SetScript("OnLeave", function(self)
		GameTooltip:Hide()
		if not Try(parent.IsMouseOver, parent) then self:Hide() end
	end)
	del:Hide()
	return del
end

function Q.ChatRowClicks(row)
	row:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	row:SetScript("OnClick", function(self, button)
		if button == "RightButton" then
			ClaudeWoW.ShowChatMenu(self.chatId, self)
		else
			ClaudeWoW.SwitchChat(self.chatId)
		end
	end)
	row:SetScript("OnDoubleClick", function(self)
		ClaudeWoW.SwitchChat(self.chatId)
		ClaudeWoW.RenamePrompt(self.chatId)
	end)
end

function Q.Color(name, r, g, b)
	local c = _G[name]
	if type(c) == "table" and type(c.GetRGB) == "function" then return c:GetRGB() end
	return r, g, b
end

function Q.PreviewsOn()
	return db.settings.chatPreviews ~= false
end

function Q.LastMessage(c)
	local last, count = nil, 0
	for _, m in ipairs(c.history) do
		if m.role == "user" or m.role == "assistant" then
			last = m
			count = count + 1
		end
	end
	return last, count
end

function Q.WhenShort(t)
	return (Q.WhenLabel(t):gsub("^%a+ ", ""))
end

function Q.MessageSummary(last, count)
	if not last then return "No messages yet" end
	return count .. (count == 1 and " message" or " messages") .. (last.t and (", last " .. Q.WhenLabel(last.t)) or "")
end

function Q.ChatObjectives(c)
	if c.pendingId then return { "Working: " .. ActivityLine(c) } end
	local last = Q.LastMessage(c)
	if not last then return {} end
	local who = last.role == "user" and "You" or ReplyAgentName(c, last.agent)
	local first = tostring(last.text or ""):match("^%s*([^\n]*)") or ""
	return { who .. ": " .. first }
end

function Q.PoiState(poi, glyphKey, number, selected)
	if not Q.SetArt(poi.bg, selected and "poiSelected" or "poi", true) then Q.SetArt(poi.bg, "poi", true) end
	poi.outer:SetShown(selected)
	local glyphShown = glyphKey ~= nil and Q.SetArt(poi.glyph, glyphKey, true)
	poi.glyph:SetShown(glyphShown)
	if glyphShown then
		poi.number:Hide()
	else
		poi.number:SetText(number)
		poi.number:Show()
	end
end

function Q.Poi(parent)
	local poi = CreateFrame("Button", nil, parent)
	poi:SetSize(Q.POI_SIZE, Q.POI_SIZE)
	poi.outer = poi:CreateTexture(nil, "BACKGROUND")
	poi.outer:SetPoint("CENTER")
	if Q.SetArt(poi.outer, "poiOuter", true) then poi.outer:SetBlendMode("ADD") end
	poi.outer:Hide()
	poi.bg = poi:CreateTexture(nil, "BORDER")
	poi.bg:SetPoint("CENTER")
	poi.glyph = poi:CreateTexture(nil, "ARTWORK", nil, 1)
	poi.glyph:SetPoint("CENTER")
	poi.number = poi:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	poi.number:SetPoint("CENTER", poi, "CENTER", 0, 0)
	local inner = poi:CreateTexture(nil, "HIGHLIGHT")
	inner:SetPoint("CENTER")
	if Q.SetArt(inner, "poiInner", true) then inner:SetBlendMode("ADD") end
	poi:SetScript("OnMouseDown", function(self)
		self.glyph:SetPoint("CENTER", 1, -1)
		self.number:SetPoint("CENTER", self, "CENTER", 1, -1)
		Q.SetArt(self.bg, "poiPushed", true)
	end)
	poi:SetScript("OnMouseUp", function(self)
		self.glyph:SetPoint("CENTER")
		self.number:SetPoint("CENTER", self, "CENTER", 0, 0)
		local row = self:GetParent()
		Q.SetArt(self.bg, row.active and "poiSelected" or "poi", true)
	end)
	poi:SetScript("OnClick", function(self) ClaudeWoW.SwitchChat(self:GetParent().chatId) end)
	return poi
end

function Q.Objective(r, k)
	local line = r.objectives[k]
	if line then return line end
	local font = Q.FontObject("ObjectiveFont", "GameFontHighlightSmall")
	line = {
		dash = r:CreateFontString(nil, "OVERLAY", font),
		text = r:CreateFontString(nil, "OVERLAY", font),
	}
	line.dash:SetText(_G.QUEST_DASH or "- ")
	line.text:SetPoint("TOPLEFT", line.dash, "TOPRIGHT", 0, 0)
	line.text:SetJustifyH("LEFT")
	line.text:SetWordWrap(false)
	r.objectives[k] = line
	return line
end

function Q.RowColors(r, hover)
	local c = hover and { 1, 1, 1 } or r.titleColor
	r.title:SetTextColor(c[1], c[2], c[3])
	local or_, og, ob
	if hover then
		or_, og, ob = Q.Color("QUEST_OBJECTIVE_HIGHLIGHT_FONT_COLOR", 1, 1, 1)
	else
		or_, og, ob = Q.Color("QUEST_OBJECTIVE_FONT_COLOR", 0.8, 0.8, 0.8)
	end
	for _, line in ipairs(r.objectives) do
		line.dash:SetTextColor(or_, og, ob)
		line.text:SetTextColor(or_, og, ob)
	end
end

function Q.QuestRow(i)
	local q = ui.questList
	local r = q.rows[i]
	if r then return r end
	r = CreateFrame("Button", nil, q.content)
	r.objectives = {}
	r.glow = r:CreateTexture(nil, "BACKGROUND")
	r.glow:SetAllPoints()
	if not Q.SetArt(r.glow, "rowGlow") then r.glow:SetColorTexture(1, 0.82, 0, 0.12) end
	r.glow:Hide()
	r.poi = Q.Poi(r)
	r.poi:SetPoint("TOPLEFT", r, "TOPLEFT", 6, -Q.POI_TOP)
	r.del = Q.DeleteButton(r)
	r.del:SetPoint("TOPRIGHT", r, "TOPRIGHT", -2, -Q.ROW_TOP + 2)
	r.when = r:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	r.when:SetPoint("TOPRIGHT", r, "TOPRIGHT", -22, -Q.ROW_TOP)
	r.when:SetJustifyH("RIGHT")
	r.title = r:CreateFontString(nil, "OVERLAY", Q.FontObject("GameFontNormalLeft", "GameFontNormalSmall"))
	r.title:SetPoint("TOPLEFT", r, "TOPLEFT", Q.ROW_TITLE_X, -Q.ROW_TOP)
	r.title:SetPoint("RIGHT", r.when, "LEFT", -4, 0)
	r.title:SetJustifyH("LEFT")
	r.title:SetWordWrap(false)
	r.label = r.title
	Q.ChatRowClicks(r)
	r:SetScript("OnEnter", function(self)
		self.del:Show()
		Q.RowColors(self, true)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText(self.fullTitle or "", 1, 1, 1, 1, true)
		GameTooltip:AddLine(self.summary or "", 0.8, 0.8, 0.8)
		GameTooltip:Show()
	end)
	r:SetScript("OnLeave", function(self)
		if not Try(self.del.IsMouseOver, self.del) then self.del:Hide() end
		Q.RowColors(self, false)
		GameTooltip:Hide()
	end)
	q.rows[i] = r
	return r
end

Q.TITLE_EMPTY = { 0.5, 0.5, 0.5 }

function Q.FillRow(r, c, index, width)
	local active = c.id == db.activeChat
	local unread = c.unread or 0
	local previews = Q.PreviewsOn()
	local last, count = Q.LastMessage(c)
	r.chatId = c.id
	r.poi.chatId = c.id
	r.active = active
	r:SetWidth(width)
	r.glow:SetShown(active)
	local title = Display(Q.ShownName(c))
	r.fullTitle = title
	r.summary = Q.MessageSummary(last, count)
	if c.agent and c.agent ~= "" then title = title .. " |cff9d9d9d" .. AgentName(c.agent) .. "|r" end
	if unread > 0 then title = title .. " (" .. unread .. ")" end
	r.title:SetText(title)
	r.when:SetText(last and last.t and Q.WhenShort(last.t) or "")
	local titleColor = Q.TitleColor(c)
	if previews and not last and titleColor == Q.TITLE_IDLE then titleColor = Q.TITLE_EMPTY end
	r.titleColor = active and { 1, 1, 1 } or titleColor
	local glyph = (c.pendingId and (active and "workingSelected" or "working")) or (unread > 0 and "reply") or nil
	Q.PoiState(r.poi, glyph, tostring(index), active)
	local lines = previews and Q.ChatObjectives(c) or {}
	local textW = width - Q.ROW_TITLE_X - 22
	local titleH = Try(r.title.GetStringHeight, r.title) or 14
	if titleH < 1 then titleH = 14 end
	local y = Q.ROW_TOP + titleH + Q.OBJECTIVE_GAP
	for k, text in ipairs(lines) do
		local line = Q.Objective(r, k)
		line.dash:ClearAllPoints()
		line.dash:SetPoint("TOPLEFT", r, "TOPLEFT", Q.ROW_TITLE_X, -y)
		line.text:SetWidth(textW - 8)
		line.text:SetText(Display(text))
		line.dash:Show()
		line.text:Show()
		local h = Try(line.text.GetStringHeight, line.text) or 12
		if h < 1 then h = 12 end
		y = y + h + Q.OBJECTIVE_LINE_GAP
	end
	for k = #lines + 1, #r.objectives do
		r.objectives[k].dash:Hide()
		r.objectives[k].text:Hide()
	end
	local textBottom = #lines > 0 and (y - Q.OBJECTIVE_LINE_GAP) or (Q.ROW_TOP + titleH)
	local height = math.max(textBottom + Q.ROW_BOTTOM, Q.ROW_MIN_H)
	r:SetHeight(height)
	Q.RowColors(r, false)
	return height
end

function Q.QuestHeader(i)
	local q = ui.questList
	local h = q.headers[i]
	if h then return h end
	h = CreateFrame("Button", nil, q.content)
	h:SetHeight(Q.LIST_HEADER_H)
	local bg = h:CreateTexture(nil, "BACKGROUND")
	bg:SetAllPoints()
	if not Q.SetArt(bg, "header") then bg:SetColorTexture(0.25, 0.18, 0.08, 0.6) end
	local hl = h:CreateTexture(nil, "HIGHLIGHT")
	hl:SetAllPoints()
	if Q.SetArt(hl, "header") then
		hl:SetBlendMode("ADD")
		hl:SetAlpha(0.4)
	else
		hl:SetColorTexture(1, 1, 1, 0.08)
	end
	h.collapse = CreateFrame("Button", nil, h)
	h.collapse:SetSize(20, 20)
	h.collapse:SetPoint("RIGHT", h, "RIGHT", -6, 0)
	h.icon = h.collapse:CreateTexture(nil, "ARTWORK")
	h.icon:SetPoint("CENTER")
	h.iconHighlight = h.collapse:CreateTexture(nil, "HIGHLIGHT")
	h.iconHighlight:SetPoint("CENTER")
	h.text = h:CreateFontString(nil, "OVERLAY", Q.FontObject("Game15Font_Shadow", "GameFontNormal"))
	h.text:SetPoint("LEFT", h, "LEFT", 8, 1)
	h.text:SetPoint("RIGHT", h.collapse, "LEFT", -4, 0)
	h.text:SetJustifyH("LEFT")
	h.text:SetWordWrap(false)
	local function Toggle(self)
		local header = self.key and self or self:GetParent()
		local collapsed = db.settings.collapsedFolders or {}
		db.settings.collapsedFolders = collapsed
		collapsed[header.key] = (not collapsed[header.key]) or nil
		ClaudeWoW.RenderChatList()
	end
	h:SetScript("OnClick", Toggle)
	h.collapse:SetScript("OnClick", Toggle)
	h:SetScript("OnEnter", function(self) self.text:SetTextColor(Q.Color("HIGHLIGHT_FONT_COLOR", 1, 1, 1)) end)
	h:SetScript("OnLeave", function(self) self.text:SetTextColor(Q.Color("DISABLED_FONT_COLOR", 0.5, 0.5, 0.5)) end)
	h:SetScript("OnMouseDown", function(self) self.text:SetPoint("LEFT", self, "LEFT", 9, 0) end)
	h:SetScript("OnMouseUp", function(self) self.text:SetPoint("LEFT", self, "LEFT", 8, 1) end)
	h.text:SetTextColor(Q.Color("DISABLED_FONT_COLOR", 0.5, 0.5, 0.5))
	q.headers[i] = h
	return h
end

function Q.SetHeaderIcon(h, collapsed)
	local key = collapsed and "plus" or "minus"
	if Q.SetArt(h.icon, key, true) then
		Q.SetArt(h.iconHighlight, key, true)
		h.iconHighlight:SetBlendMode("ADD")
		h.iconHighlight:SetAlpha(0.4)
	else
		h.icon:SetSize(14, 14)
		h.icon:SetTexture(collapsed and "Interface\\Buttons\\UI-PlusButton-Up" or "Interface\\Buttons\\UI-MinusButton-Up")
	end
end

function ClaudeWoW.RenderQuestList()
	local q = ui.questList
	local filter = ui.chatFilter or ""
	local collapsed = db.settings.collapsedFolders or {}
	local listed = Q.ListedChats()
	local groups, order = {}, {}
	for _, c in ipairs(Q.NewestFirst(listed)) do
		local key = Q.FolderKey(c)
		if not groups[key] then
			groups[key] = {}
			table.insert(order, key)
		end
		table.insert(groups[key], c)
	end
	local fallback = (ui.listWidth or Q.LIST_W) - 32
	local width = Try(q.scroll.GetWidth, q.scroll) or fallback
	if width < 80 then width = fallback end
	q.content:SetWidth(width)
	local y, nh, nr, matched, index = 0, 0, 0, 0, 0
	local last, activeTop, activeBottom
	for _, key in ipairs(order) do
		local matches = {}
		for _, c in ipairs(groups[key]) do
			if filter == "" or tostring(c.name or ""):lower():find(filter, 1, true) then table.insert(matches, c) end
		end
		if #matches > 0 then
			matched = matched + #matches
			y = y + ((last == nil and Q.PAD_FIRST) or (last == "header" and Q.PAD_HEADER_AFTER_HEADER) or Q.PAD_HEADER_AFTER_ROW)
			nh = nh + 1
			local h = Q.QuestHeader(nh)
			local closed = filter == "" and collapsed[key] == true
			h.key = key
			h.collapsed = closed
			h.text:SetText(Display(key))
			Q.SetHeaderIcon(h, closed)
			h:SetWidth(width - Q.HEADER_INSET - Q.HEADER_RIGHT)
			h:ClearAllPoints()
			h:SetPoint("TOPLEFT", q.content, "TOPLEFT", Q.HEADER_INSET, -y)
			h:Show()
			y = y + Q.LIST_HEADER_H
			last = "header"
			if not closed then
				for _, c in ipairs(matches) do
					index = index + 1
					y = y + (last == "header" and Q.PAD_ROW_AFTER_HEADER or Q.PAD_ROW_AFTER_ROW)
					nr = nr + 1
					local r = Q.QuestRow(nr)
					local height = Q.FillRow(r, c, index, width)
					r:ClearAllPoints()
					r:SetPoint("TOPLEFT", q.content, "TOPLEFT", 0, -y)
					r:Show()
					if r.active then activeTop, activeBottom = y, y + height end
					y = y + height
					last = "row"
				end
			else
				index = index + #matches
			end
		end
	end
	for i = nh + 1, #q.headers do q.headers[i]:Hide() end
	for i = nr + 1, #q.rows do q.rows[i]:Hide() end
	q.empty:SetShown(filter ~= "" and matched == 0)
	q.content:SetHeight(math.max(y + Q.PAD_FIRST, 1))
	if activeTop and q.shownActive ~= db.activeChat then
		q.shownActive = db.activeChat
		Q.RevealRow(q, activeTop, activeBottom)
	end
	ui.chatCount:SetText("Chats: |cffffffff" .. #listed .. "|r")
end

function Q.LastActive(c)
	for i = #(c.history or {}), 1, -1 do
		local t = tonumber(c.history[i].t)
		if t then return t end
	end
	return tonumber(c.created) or 0
end

function Q.NewestFirst(chats)
	local sorted, rank = {}, {}
	for i, c in ipairs(chats) do
		rank[c] = { t = Q.LastActive(c), i = i }
		table.insert(sorted, c)
	end
	table.sort(sorted, function(a, b)
		local ra, rb = rank[a], rank[b]
		if ra.t ~= rb.t then return ra.t > rb.t end
		return ra.i > rb.i
	end)
	return sorted
end

function Q.RevealRow(q, top, bottom)
	local view = Try(q.scroll.GetHeight, q.scroll) or 0
	if view <= 0 then return end
	pcall(q.scroll.UpdateScrollChildRect, q.scroll)
	local current = Try(q.scroll.GetVerticalScroll, q.scroll) or 0
	local target = current
	if top < current then
		target = math.max(0, top - Q.LIST_HEADER_H - Q.PAD_FIRST - Q.PAD_ROW_AFTER_HEADER)
	elseif bottom > current + view then
		target = bottom - view
	end
	if target ~= current then pcall(q.scroll.SetVerticalScroll, q.scroll, target) end
end

function Q.ListSettingsMenu(anchor)
	local s = db.settings
	local function SetAll(value)
		local collapsed = {}
		if value then
			for _, c in ipairs(db.chats) do collapsed[Q.FolderKey(c)] = true end
		end
		s.collapsedFolders = collapsed
		ClaudeWoW.RenderChatList()
	end
	local function TogglePreviews()
		s.chatPreviews = not Q.PreviewsOn()
		ClaudeWoW.RenderChatList()
	end
	local items = { { text = "Show message previews", checked = Q.PreviewsOn, fn = TogglePreviews } }
	if ClaudeWoWOrders then table.insert(items, { text = "Show the Orders card", checked = ClaudeWoWOrders.IsOn, fn = ClaudeWoWOrders.Toggle }) end
	if ClaudeWoWTelemetry then table.insert(items, { text = "Share game state with the agent", checked = ClaudeWoWTelemetry.IsOn, fn = ClaudeWoWTelemetry.Toggle }) end
	table.insert(items, { divider = true })
	table.insert(items, { text = "Options", fn = function() ClaudeWoW.ShowOptions() end })
	table.insert(items, { text = "Commands and tips", fn = function() ClaudeWoW.ShowHelp() end })
	table.insert(items, { text = "Expand all projects", fn = function() SetAll(false) end })
	table.insert(items, { text = "Collapse all projects", fn = function() SetAll(true) end })
	Q.ShowMenu(anchor, items, "settings", true)
end

function Q.ChatDetails(c)
	local folder = FolderName(ChatFolder(c))
	local agent = AgentName((c and c.agent ~= "" and c.agent) or run.bridgeAgent)
	return {
		{ "Project", folder ~= "" and Display(folder) or Cli.NO_PROJECT },
		{ "Agent", agent },
	}
end

function ClaudeWoW.RefreshTitleBar()
	local label = ui.chatTitle
	if not label then return end
	local c = ActiveChat()
	label:SetText(c and Display(Q.ShownName(c)) or Q.PANEL_TITLE)
end

function Q.TitleBarTooltip(bar)
	local c = ActiveChat()
	if not c then return end
	GameTooltip:SetOwner(bar, "ANCHOR_BOTTOMLEFT", 0, 0)
	GameTooltip:SetText(Display(c.name))
	for _, row in ipairs(Q.ChatDetails(c)) do GameTooltip:AddDoubleLine(row[1], row[2], 1, 0.82, 0, 1, 1, 1) end
	GameTooltip:AddLine("Click to rename. Right-click for chat options.", 0.6, 0.6, 0.6, true)
	GameTooltip:Show()
end

function Q.ListWidth(frameWidth)
	local share = math.floor((tonumber(frameWidth) or 0) * Q.LIST_SHARE)
	return math.max(Q.LIST_MIN_W, math.min(Q.LIST_W, share))
end

function Q.LayoutListWidth()
	local list, f = ui.questList and ui.listPanel, ui.frame
	if not list or not f then return end
	local width = Q.ListWidth(Try(f.GetWidth, f))
	ui.listWidth = width
	list:SetWidth(width)
	ui.newChat:SetWidth(width - 12)
	ui.questList.content:SetWidth(width - 32)
	ui.questList.empty:SetWidth(width - 60)
end

function Q.BuildQuestFrames(f)
	local list = CreateFrame("Frame", nil, f)
	list:SetPoint("TOPRIGHT", f, "TOPRIGHT", -6, Q.NAV_TOP)
	list:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -6, 28)
	list:SetWidth(Q.LIST_W)
	ui.listPanel = list

	local gear = CreateFrame("Button", "ClaudeWoWChatSettings", list)
	gear:SetSize(15, 16)
	gear:SetPoint("TOPRIGHT", list, "TOPRIGHT", -4, -10)
	local gearIcon = gear:CreateTexture(nil, "ARTWORK")
	gearIcon:SetAllPoints()
	if not Q.SetArt(gearIcon, "gear") then
		if Q.IsClassicEra() then
			gearIcon:SetTexture(Q.CLASSIC_ERA_GEAR)
			gearIcon:SetTexCoord(0.08, 0.92, 0.08, 0.92)
		else
			gearIcon:SetTexture("Interface\\Buttons\\UI-OptionsButton")
		end
	end
	local gearHl = gear:CreateTexture(nil, "HIGHLIGHT")
	gearHl:SetAllPoints()
	if Q.SetArt(gearHl, "gear") then
		gearHl:SetBlendMode("ADD")
		gearHl:SetAlpha(0.4)
	end
	gear:SetScript("OnMouseDown", function() gearIcon:SetPoint("TOPLEFT", gear, "TOPLEFT", 1, -1) end)
	gear:SetScript("OnMouseUp", function() gearIcon:SetAllPoints() end)
	gear:SetScript("OnClick", function(self) Q.ListSettingsMenu(self) end)
	gear:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText("Chat list options")
		GameTooltip:Show()
	end)
	gear:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.listSettings = gear

	local countBox = CreateFrame("Frame", "ClaudeWoWChatCount", list, Q.TemplateExists("InsetFrameTemplate3") and "InsetFrameTemplate3" or "InsetFrameTemplate")
	countBox:SetSize(Q.COUNT_W, 20)
	countBox:SetPoint("RIGHT", gear, "LEFT", -6, 0)
	local count = countBox:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	count:SetPoint("CENTER", countBox, "CENTER", 0, 0)
	ui.chatCount = count

	local search = CreateFrame("EditBox", "ClaudeWoWChatSearch", list, Q.TemplateExists("SearchBoxTemplate") and "SearchBoxTemplate" or "InputBoxTemplate")
	search:SetHeight(20)
	search:SetPoint("LEFT", list, "LEFT", 10, 0)
	search:SetPoint("TOP", countBox, "TOP", 0, 0)
	search:SetPoint("RIGHT", countBox, "LEFT", -6, 0)
	search:SetAutoFocus(false)
	if type(search.Instructions) == "table" then search.Instructions:SetText("Search Chats") end
	search:HookScript("OnTextChanged", function(self)
		ui.chatFilter = Trim(self:GetText() or ""):lower()
		ClaudeWoW.RenderChatList()
	end)
	ui.search = search

	local newChat = MakeButton(list, "New Chat", Q.LIST_W - 12, function() ClaudeWoW.NewChat() end)
	newChat:SetPoint("BOTTOM", list, "BOTTOM", 0, Q.COMPOSER_BOTTOM)
	ui.newChat = newChat

	local listScroll = CreateFrame("ScrollFrame", "ClaudeWoWChatScroll", list, Q.TemplateExists("ScrollFrameTemplate") and "ScrollFrameTemplate" or "UIPanelScrollFrameTemplate")
	listScroll:SetPoint("TOPLEFT", list, "TOPLEFT", 6, -40)
	listScroll:SetPoint("BOTTOMRIGHT", list, "BOTTOMRIGHT", -20, 34)
	local listBg = list:CreateTexture(nil, "BACKGROUND", nil, 1)
	listBg:SetPoint("TOPLEFT", listScroll, "TOPLEFT", 0, 0)
	listBg:SetPoint("BOTTOMRIGHT", listScroll, "BOTTOMRIGHT", 16, 0)
	if not Q.SetArt(listBg, "listBg") then listBg:SetColorTexture(0.06, 0.05, 0.04, 0.9) end
	local listContent = CreateFrame("Frame", "ClaudeWoWChatListContent", listScroll)
	listContent:SetSize(Q.LIST_W - 32, 1)
	listScroll:SetScrollChild(listContent)
	local empty = listContent:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	empty:SetPoint("TOP", listContent, "TOP", 0, -20)
	empty:SetWidth(Q.LIST_W - 60)
	empty:SetText("There are no chats that match your search.")
	empty:Hide()
	ui.questList = { scroll = listScroll, content = listContent, headers = {}, rows = {}, empty = empty }

	local border = CreateFrame("Frame", "ClaudeWoWChatBorder", list)
	border:SetPoint("TOPLEFT", listScroll, "TOPLEFT", -3, 7)
	border:SetPoint("BOTTOMRIGHT", listScroll, "BOTTOMRIGHT", 19, -6)
	border:SetFrameLevel((Try(listScroll.GetFrameLevel, listScroll) or 1) + 20)
	border:EnableMouse(false)
	local edge = border:CreateTexture(nil, "BORDER")
	edge:SetAllPoints()
	if Q.SetArt(edge, "frame") then
		local filigree = border:CreateTexture(nil, "ARTWORK")
		filigree:SetPoint("TOP", border, "TOP", 0, 1)
		Q.SetArt(filigree, "filigree", true)
		local gradient = border:CreateTexture(nil, "BACKGROUND")
		gradient:SetPoint("BOTTOM", border, "BOTTOM", 0, 4)
		Q.SetArt(gradient, "gradient", true)
	else
		edge:Hide()
		local inset = Q.Panel(list, true)
		inset:SetAllPoints(border)
		inset:SetFrameLevel((Try(listScroll.GetFrameLevel, listScroll) or 1) - 1)
	end
	ui.listBorder = border

	local parchment = Q.Panel(f, true)
	parchment:SetPoint("TOPLEFT", f, "TOPLEFT", 8, Q.NAV_TOP - Q.NAV_H - 2)
	parchment:SetPoint("BOTTOMRIGHT", list, "BOTTOMLEFT", -6, 52)
	local paper = parchment:CreateTexture(nil, "BACKGROUND", nil, 1)
	paper:SetPoint("TOPLEFT", parchment, "TOPLEFT", 3, -3)
	paper:SetPoint("BOTTOMRIGHT", parchment, "BOTTOMRIGHT", -3, 3)
	if not Q.SetArt(paper, "parchment") and not Q.ClassicParchment(paper, 3) then paper:SetColorTexture(0.80, 0.70, 0.52, 1) end
	ui.parchment = parchment
	ui.transcriptPanel = parchment

	local bar = CreateFrame("Button", "ClaudeWoWTitleBar", f, Q.TemplateExists("NavBarTemplate") and "NavBarTemplate" or nil)
	bar:SetPoint("TOPLEFT", f, "TOPLEFT", 60, Q.NAV_TOP)
	bar:SetPoint("RIGHT", list, "LEFT", -6, 0)
	bar:SetHeight(Q.NAV_H)
	for _, key in ipairs({ "home", "overflow" }) do
		if type(bar[key]) == "table" and bar[key].Hide then bar[key]:Hide() end
	end
	local label = bar:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	label:SetPoint("LEFT", bar, "LEFT", 12, 0)
	label:SetPoint("RIGHT", bar, "RIGHT", -12, 0)
	label:SetJustifyH("LEFT")
	label:SetWordWrap(false)
	bar:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	bar:SetScript("OnClick", function(self, button)
		local c = ActiveChat()
		if not c then return end
		GameTooltip:Hide()
		if button == "RightButton" then ClaudeWoW.ShowChatMenu(c.id, self) else ClaudeWoW.RenamePrompt(c.id) end
	end)
	bar:SetScript("OnEnter", Q.TitleBarTooltip)
	bar:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.titleBar = bar
	ui.chatTitle = label
	ClaudeWoW.RefreshTitleBar()
end

function Q.Panel(parent, native)
	local p = CreateFrame("Frame", nil, parent, native and "InsetFrameTemplate" or "BackdropTemplate")
	if not native then
		p:SetBackdrop({
			bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
			edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
			tile = true, tileSize = 16, edgeSize = 12,
			insets = { left = 3, right = 3, top = 3, bottom = 3 },
		})
		p:SetBackdropColor(0, 0, 0, 0.4)
		p:SetBackdropBorderColor(0.4, 0.4, 0.4, 1)
	end
	return p
end

Q.MENU_W = 170
Q.MENU_ROW_H = 18
Q.MENU_MAX_AGENTS = 12
Q.RADIO_TEXTURE = "Interface\\Common\\UI-DropDownRadioChecks"

function Q.MenuAgents()
	local agents = {}
	for _, id in ipairs(type(run.bridgeAgents) == "table" and run.bridgeAgents or {}) do
		if type(id) == "string" and id:match("^[%w_%-]+$") and #agents < Q.MENU_MAX_AGENTS then table.insert(agents, id) end
	end
	return agents
end

function Q.AgentMenuItems(chatId)
	local function Pick(id)
		return function()
			local chat = FindChat(chatId)
			if chat then ClaudeWoW.SetAgent(id == "" and "default" or id, chat) end
		end
	end
	local function Selected(id)
		return function()
			local chat = FindChat(chatId)
			return chat ~= nil and (chat.agent or "") == id
		end
	end
	local defaultLabel = run.bridgeAgent and ("Default (" .. Display(AgentName(run.bridgeAgent)) .. ")") or "Default"
	local items = { { text = defaultLabel, radio = true, selected = Selected(""), fn = Pick("") } }
	for _, id in ipairs(Q.MenuAgents()) do
		table.insert(items, { text = Display(AgentName(id)), radio = true, selected = Selected(id), fn = Pick(id) })
	end
	return items
end

function Q.ChatMenuItems(chatId)
	local c = FindChat(chatId)
	if not c then return nil end
	local items = {
		{ title = Display(c.name) },
		{ text = "Rename...", fn = function() ClaudeWoW.RenamePrompt(chatId) end },
		{ text = "Project...", fn = function() ClaudeWoW.FolderPrompt(chatId) end },
	}
	if #Q.MenuAgents() > 0 then
		table.insert(items, { text = "Agent", submenu = Q.AgentMenuItems(chatId) })
	else
		table.insert(items, { text = "Agent...", fn = function() ClaudeWoW.AgentPrompt(chatId) end })
	end
	table.insert(items, { divider = true })
	table.insert(items, { text = "Clear Messages", fn = function() ClaudeWoW.ConfirmClear(chatId) end })
	table.insert(items, { text = "Delete", color = "ffff4040", fn = function() ClaudeWoW.ConfirmDelete(chatId) end })
	return items
end

function Q.MenuLabel(item)
	return item.color and ("|c" .. item.color .. item.text .. "|r") or item.text
end

function Q.MenuEnabled(item)
	local enabled = item.enabled
	if enabled == nil then return true end
	if type(enabled) == "function" then return enabled() and true or false end
	return enabled and true or false
end

function Q.ApplyNativeEnabled(element, item)
	if item.enabled == nil or type(element) ~= "table" or type(element.SetEnabled) ~= "function" then return end
	element:SetEnabled(Q.MenuEnabled(item))
end

function Q.NativeAction(item, holder)
	if item.enabled == nil or type(item.fn) ~= "function" then return item.fn end
	return function(...)
		if not Q.MenuEnabled(item) then
			Q.ApplyNativeEnabled(holder.element, item)
			return
		end
		return item.fn(...)
	end
end

function Q.FillNativeMenu(root, items)
	for _, it in ipairs(items) do
		local element
		local holder = {}
		local action = Q.NativeAction(it, holder)
		if it.title then
			root:CreateTitle(it.title)
		elseif it.divider then
			root:CreateDivider()
		elseif it.submenu then
			element = root:CreateButton(it.text)
			Q.FillNativeMenu(element, it.submenu)
		elseif it.radio then
			element = root:CreateRadio(it.text, it.selected, action)
		elseif it.checked then
			element = root:CreateCheckbox(it.text, it.checked, action)
		else
			element = root:CreateButton(Q.MenuLabel(it), action)
		end
		holder.element = element
		if element then Q.ApplyNativeEnabled(element, it) end
	end
end

function Q.MenuRows(items, depth, out)
	out = out or {}
	depth = depth or 0
	for _, it in ipairs(items) do
		if it.submenu then
			table.insert(out, { item = it, depth = depth, header = true })
			Q.MenuRows(it.submenu, depth + 1, out)
		elseif not it.title then
			table.insert(out, { item = it, depth = depth })
		end
	end
	return out
end

function Q.MenuFrame()
	if ui.menu then return ui.menu end
	local menu = CreateFrame("Frame", "ClaudeWoWChatMenu", ui.frame or UIParent, "BackdropTemplate")
	menu:SetSize(Q.MENU_W, 40)
	menu:SetFrameStrata("TOOLTIP")
	menu:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true, tileSize = 16, edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	menu:SetBackdropColor(0.08, 0.08, 0.1, 0.97)
	menu:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	menu:EnableMouse(true)
	menu.title = menu:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	menu.title:SetPoint("TOPLEFT", menu, "TOPLEFT", 10, -8)
	menu.title:SetPoint("RIGHT", menu, "RIGHT", -8, 0)
	menu.title:SetJustifyH("LEFT")
	menu.title:SetWordWrap(false)
	menu.rows = {}
	menu:SetScript("OnUpdate", function(self, dt)
		if not MouseIsOver then return end
		if MouseIsOver(self) or (self.owner and MouseIsOver(self.owner)) then
			self.away = 0
		else
			self.away = (self.away or 0) + dt
			if self.away > 0.5 then self:Hide() end
		end
	end)
	menu:Hide()
	ui.menu = menu
	ui.chatMenu = menu
	return menu
end

function Q.MenuRow(menu, i)
	local row = menu.rows[i]
	if row then return row end
	row = CreateFrame("Button", nil, menu)
	row:SetSize(Q.MENU_W - 12, Q.MENU_ROW_H)
	row.hl = row:CreateTexture(nil, "HIGHLIGHT")
	row.hl:SetAllPoints()
	row.hl:SetColorTexture(1, 1, 1, 0.12)
	row.check = row:CreateTexture(nil, "ARTWORK")
	row.check:SetSize(14, 14)
	row.check:SetTexture(Q.RADIO_TEXTURE)
	row.line = row:CreateTexture(nil, "ARTWORK")
	row.line:SetHeight(1)
	row.line:SetPoint("LEFT", row, "LEFT", 4, 0)
	row.line:SetPoint("RIGHT", row, "RIGHT", -4, 0)
	row.line:SetColorTexture(0.6, 0.6, 0.6, 0.5)
	row.label = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	row.label:SetJustifyH("LEFT")
	row.label:SetWordWrap(false)
	row:SetScript("OnClick", function(self)
		if not self.fn then return end
		if self.item and not Q.MenuEnabled(self.item) then
			Q.PaintMenuRow(self, false)
			return
		end
		menu:Hide()
		self.fn()
	end)
	menu.rows[i] = row
	return row
end

function Q.PaintMenuRow(row, enabled)
	local it = row.item
	row.fn = (enabled and not it.divider and not row.header) and it.fn or nil
	row.disabled = not enabled
	row:EnableMouse(row.fn ~= nil)
	if not enabled then
		row.label:SetTextColor(0.5, 0.5, 0.5)
	elseif row.header then
		row.label:SetTextColor(1, 0.82, 0)
	else
		row.label:SetTextColor(1, 1, 1)
	end
	row.check:SetAlpha(enabled and 1 or 0.5)
end

function Q.MenuMarkCoords(item, on)
	local left = on and 0 or 0.5
	local top = item.radio and 0.5 or 0
	return left, left + 0.5, top, top + 0.5
end

function Q.FillFallbackMenu(menu, items)
	local title
	for _, it in ipairs(items) do
		if it.title then title = it.title end
	end
	menu.title:SetText(title or "")
	local top = title and 22 or 6
	local rows = Q.MenuRows(items)
	for i, r in ipairs(rows) do
		local it, row = r.item, Q.MenuRow(menu, i)
		local indent = 6 + r.depth * 12
		local mark = it.radio and it.selected or it.checked
		row:ClearAllPoints()
		row:SetPoint("TOPLEFT", menu, "TOPLEFT", 6, -top - (i - 1) * Q.MENU_ROW_H)
		row.item = it
		row.header = r.header
		row.check:ClearAllPoints()
		row.check:SetPoint("LEFT", row, "LEFT", indent, 0)
		if mark then
			row.check:SetTexCoord(Q.MenuMarkCoords(it, mark() == true))
			row.check:Show()
		else
			row.check:Hide()
		end
		if it.divider then row.line:Show() else row.line:Hide() end
		row.label:ClearAllPoints()
		row.label:SetPoint("LEFT", row, "LEFT", indent + (mark and 16 or 0), 0)
		row.label:SetPoint("RIGHT", row, "RIGHT", -4, 0)
		row.label:SetText(it.divider and "" or Q.MenuLabel(it))
		Q.PaintMenuRow(row, Q.MenuEnabled(it))
		row:Show()
	end
	for i = #rows + 1, #menu.rows do menu.rows[i]:Hide() end
	menu:SetHeight(top + #rows * Q.MENU_ROW_H + 8)
end

function Q.ShowMenu(anchor, items, key, allowNative)
	if allowNative and type(MenuUtil) == "table" and type(MenuUtil.CreateContextMenu) == "function" then
		local shown = pcall(MenuUtil.CreateContextMenu, anchor, function(_, root) Q.FillNativeMenu(root, items) end)
		if shown then return end
	end
	local menu = Q.MenuFrame()
	if menu:IsShown() and menu.key == key then
		menu:Hide()
		return
	end
	menu.key = key
	menu.owner = anchor
	menu.away = 0
	Q.FillFallbackMenu(menu, items)
	menu:ClearAllPoints()
	menu:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 8, 2)
	menu:Show()
end

function ClaudeWoW.ShowChatMenu(chatId, anchor)
	local items = Q.ChatMenuItems(chatId)
	if not items then return end
	Q.ShowMenu(anchor, items, "chat:" .. chatId, ui.native)
	if ui.menu then ui.menu.chatId = ui.menu.key == "chat:" .. chatId and chatId or nil end
end

function Q.BuildLegacyList(f)
	local panel = Q.Panel(f, false)
	panel:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -52)
	panel:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 50)
	panel:SetWidth(PANEL_W)
	ui.listPanel = panel

	local newBtn = MakeButton(panel, "New Chat", PANEL_W - 16, function() ClaudeWoW.NewChat() end)
	newBtn:SetPoint("TOP", panel, "TOP", 0, -8)

	ui.chatButtons = {}
	for i = 1, Q.CHAT_PAGE do
		local b = CreateFrame("Button", nil, panel)
		b:SetSize(PANEL_W - 16, 20)
		b:SetPoint("TOP", newBtn, "BOTTOM", 0, -6 - (i - 1) * 21)
		b.selected = b:CreateTexture(nil, "BACKGROUND")
		b.selected:SetAllPoints()
		b.selected:SetColorTexture(1, 1, 1, 0.12)
		b.selected:Hide()
		local hl = b:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.08)

		b.del = CreateFrame("Button", nil, b)
		b.del:SetSize(16, 16)
		b.del:SetPoint("RIGHT", b, "RIGHT", -2, 0)
		if C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists("128-RedButton-Delete") then
			b.del:SetNormalAtlas("128-RedButton-Delete")
			b.del:SetPushedAtlas("128-RedButton-Delete-Pressed")
			b.del:SetHighlightAtlas("128-RedButton-Delete-Highlight")
		else
			b.del:SetNormalTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Up")
			b.del:SetHighlightTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Highlight")
		end
		b.del:SetAlpha(0.6)
		b.del:SetScript("OnClick", function() ClaudeWoW.ConfirmDelete(b.chatId) end)
		b.del:SetScript("OnEnter", function(self)
			self:SetAlpha(1)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText("Delete this chat")
			GameTooltip:Show()
		end)
		b.del:SetScript("OnLeave", function(self)
			self:SetAlpha(0.6)
			GameTooltip:Hide()
		end)

		b.label = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		b.label:SetPoint("LEFT", b, "LEFT", 6, 0)
		b.label:SetPoint("RIGHT", b.del, "LEFT", -4, 0)
		b.label:SetJustifyH("LEFT")
		b.label:SetWordWrap(false)
		b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
		b:SetScript("OnClick", function(self, button)
			if button == "RightButton" then
				ClaudeWoW.ShowChatMenu(self.chatId, self)
			else
				ClaudeWoW.SwitchChat(self.chatId)
			end
		end)
		b:SetScript("OnDoubleClick", function(self)
			ClaudeWoW.SwitchChat(self.chatId)
			ClaudeWoW.RenamePrompt(self.chatId)
		end)
		b:Hide()
		ui.chatButtons[i] = b
	end
	local function PageButton(label, delta)
		local pb = MakeButton(panel, label, 28, function()
			ui.chatPage = (ui.chatPage or 1) + delta
			ClaudeWoW.RenderChatList()
		end)
		pb:SetHeight(18)
		return pb
	end
	ui.pagePrev = PageButton("<", -1)
	ui.pagePrev:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 8, 6)
	ui.pageNext = PageButton(">", 1)
	ui.pageNext:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -8, 6)
	ui.pageLabel = panel:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	ui.pageLabel:SetPoint("BOTTOM", panel, "BOTTOM", 0, 10)
	return panel
end

Q.LEGACY_BIND_BUTTON = "ClaudeWoWRefreshButton"
Q.LEGACY_BIND_ACTION = "CLICK " .. Q.LEGACY_BIND_BUTTON .. ":LeftButton"
Q.WORKSPACE_BINDING = "CLAUDEWOW_WORKSPACE"
Q.BIND_MOVED = "Use Key Bindings > AddOns to set a key that opens or closes the window."
Q.BIND_EVENTS = { "UPDATE_BINDINGS", "PLAYER_REGEN_ENABLED" }

function Q.LegacyBindKeys()
	if type(GetBindingKey) ~= "function" then return {} end
	return { GetBindingKey(Q.LEGACY_BIND_ACTION) }
end

function Q.MoveLegacyBinding()
	if InCombatLockdown() then return false end
	local keys = Q.LegacyBindKeys()
	if #keys == 0 then return false end
	for _, key in ipairs(keys) do SetBinding(key, Q.WORKSPACE_BINDING) end
	SaveBindings(GetCurrentBindingSet())
	return true
end

function Q.MigrateLegacyBinding()
	Q.MoveLegacyBinding()
	if ui.bindWatch then return end
	local watch = CreateFrame("Frame")
	for _, event in ipairs(Q.BIND_EVENTS) do watch:RegisterEvent(event) end
	watch:SetScript("OnEvent", function() Q.MoveLegacyBinding() end)
	ui.bindWatch = watch
end

local function BuildUI()
	if ui.frame then return end
	local s = db.settings
	local native = Q.NativeFrames()
	ui.native = native

	local f = CreateFrame("Frame", "ClaudeWoWFrame", UIParent, native and "ButtonFrameTemplate" or "BackdropTemplate")
	ui.frame = f
	f.claudewowNative = native
	f:SetSize(s.width, s.height)
	f:SetPoint("CENTER")
	f:SetFrameStrata(Q.WINDOW_STRATA)
	f:SetResizable(true)
	f:SetClampedToScreen(true)
	f:SetResizeBounds(560, 300)
	f:EnableMouse(true)
	if native then
		Try(f.SetPortraitToAsset, f, Q.PORTRAIT)
		if type(f.Inset) == "table" then f.Inset:Hide() end
	else
		f:SetBackdrop(BACKDROP)
		f:SetBackdropColor(0.05, 0.05, 0.07, 0.95)
		f:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	end
	f:Hide()
	tinsert(UISpecialFrames, "ClaudeWoWFrame")

	-- Status light: green = bridge seen recently, yellow = stale, red = gone.
	local function MakeDot(parent)
		local holder = CreateFrame("Frame", nil, parent)
		holder:SetSize(16, 16)
		local dot = holder:CreateTexture(nil, "OVERLAY")
		dot:SetAllPoints()
		dot:SetTexture("Interface\\FriendsFrame\\StatusIcon-Offline")
		holder:EnableMouse(true)
		holder:SetScript("OnEnter", function(self)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText(dot.tip or "Companion app status", 0.9, 0.9, 0.9, 1, true)
			Q.StatusTooltip()
			GameTooltip:Show()
		end)
		holder:SetScript("OnLeave", function() GameTooltip:Hide() end)
		return holder, dot
	end

	local dotHolder, dot = MakeDot(f)
	ui.dot = dot
	ui.dotHolder = dotHolder

	local nativeTitle = native and Try(f.GetTitleText, f)
	local title = nativeTitle or f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	if not nativeTitle then title:SetPoint("LEFT", dotHolder, "RIGHT", 6, 0) end
	title:SetText(Q.PANEL_TITLE)
	ui.title = title

	local status = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	status:SetPoint("RIGHT", f, "RIGHT", -60, 0)
	status:SetJustifyH("LEFT")
	ui.status = status
	if native then
		dotHolder:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 12, 6)
		dotHolder:SetHitRectInsets(0, -Q.STATUS_HIT_W, -4, -4)
		status:ClearAllPoints()
		status:SetPoint("LEFT", dotHolder, "RIGHT", 6, 0)
		status:SetWidth(Q.STATUS_HIT_W)
		status:SetWordWrap(false)
		ui.ctxBar = Q.ContextBar(f)
	else
		dotHolder:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -16)
		status:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -34)
	end

	local close = native and type(f.CloseButton) == "table" and f.CloseButton or nil
	if not close then
		close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
		close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -4, -4)
	end
	ui.close = close
	close:SetScript("OnClick", function() ClaudeWoW.Toggle(false) end)
	close:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText("Close (Esc)")
		GameTooltip:AddLine("Type /claude to open it again.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	close:SetScript("OnLeave", function() GameTooltip:Hide() end)

	f:SetScript("OnHide", function()
		if ui.quitting then
			ui.quitting = nil
		elseif db and UIParent:IsShown() then
			db.settings.shown = false
		end
		Q.UpdateMinimapSignal()
	end)

	local panel
	if native then Q.BuildQuestFrames(f) else panel = Q.BuildLegacyList(f) end

	-- Transcript: a scrolling stack of message bubbles
	local scroll = CreateFrame("ScrollFrame", "ClaudeWoWScroll", native and ui.parchment or f, (native and Q.TemplateExists("ScrollFrameTemplate")) and "ScrollFrameTemplate" or "UIPanelScrollFrameTemplate")
	if native then
		scroll:SetPoint("TOPLEFT", ui.parchment, "TOPLEFT", 22, -16)
		ui.scrollBottom = { ui.parchment, -34, 14 }
	else
		scroll:SetPoint("TOPLEFT", panel, "TOPRIGHT", 8, 0)
		ui.scrollBottom = { f, -32, 110 }
	end
	ui.scroll = scroll
	Q.BuildNoticeBar(native)

	local content = CreateFrame("Frame", "ClaudeWoWContent", scroll)
	content:SetSize(500, 1)
	scroll:SetScrollChild(content)
	ui.content = content
	ui.bubbles = {}
	ui.empty = nil
	scroll:HookScript("OnSizeChanged", function(self, w, h)
		if ui.frame:IsShown() then ClaudeWoW.Render() end
	end)

	-- Input box, with Send docked at its right end like a messaging app.
	local SEND_W = 84
	local inputBg = Q.Panel(f, native)
	if native then
		inputBg:SetPoint("TOPLEFT", ui.parchment, "BOTTOMLEFT", 0, -4)
		inputBg:SetPoint("BOTTOMRIGHT", ui.listPanel, "BOTTOMLEFT", -Q.COMPOSER_GAP - SEND_W - Q.COMPOSER_GAP, Q.COMPOSER_BOTTOM)
	else
		inputBg:SetPoint("BOTTOMLEFT", panel, "BOTTOMRIGHT", 8, 0)
		inputBg:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -14 - SEND_W - Q.COMPOSER_GAP, 50)
		inputBg:SetHeight(54)
	end
	if not native then
		inputBg:SetBackdropColor(0, 0, 0, 0.6)
		inputBg:SetBackdropBorderColor(0.5, 0.5, 0.5, 1)
	end

	local plainInput = native and type(ScrollingEdit_OnCursorChanged) == "function" and type(ScrollingEdit_OnTextChanged) == "function"
	local inScroll = CreateFrame("ScrollFrame", "ClaudeWoWInputScroll", inputBg, (not plainInput) and "UIPanelScrollFrameTemplate" or nil)
	inScroll:SetPoint("TOPLEFT", inputBg, "TOPLEFT", 8, -6)
	ui.inputBg, ui.inputScroll = inputBg, inScroll
	ui.inputRightInset = plainInput and Q.INPUT_INSET_PLAIN or Q.INPUT_INSET_SCROLL
	Q.InsetComposer(false)

	local input = CreateFrame("EditBox", "ClaudeWoWInput", inScroll)
	input:SetMultiLine(true)
	input:SetAutoFocus(false)
	input:SetFontObject(ChatFontNormal)
	input:SetMaxLetters(0)
	input:SetSize(500, 40)
	input:SetScript("OnEnterPressed", function() ClaudeWoW.SendFromInput() end)
	input:SetScript("OnEscapePressed", function(self)
		self:ClearFocus()
		ClaudeWoW.Toggle(false)
	end)
	input:SetScript("OnTabPressed", function(self) Cli.CompleteSlash(self) end)
	if plainInput then
		input:SetScript("OnCursorChanged", ScrollingEdit_OnCursorChanged)
		input:SetScript("OnTextChanged", function(self) ScrollingEdit_OnTextChanged(self, inScroll) end)
		if type(ScrollingEdit_OnUpdate) == "function" then input:SetScript("OnUpdate", function(self, elapsed) ScrollingEdit_OnUpdate(self, elapsed, inScroll) end) end
	end
	inScroll:SetScrollChild(input)
	inScroll:HookScript("OnSizeChanged", function(self, w, h)
		input:SetWidth(w)
	end)
	inputBg:SetScript("OnMouseDown", function() input:SetFocus() end)
	ui.input = input

	local placeholder = inputBg:CreateFontString(nil, "OVERLAY", "GameFontDisable")
	placeholder:SetPoint("TOPLEFT", inScroll, "TOPLEFT", 0, 0)
	placeholder:SetPoint("RIGHT", inScroll, "RIGHT", 0, 0)
	placeholder:SetJustifyH("LEFT")
	placeholder:SetWordWrap(false)
	ui.placeholder = placeholder
	input:HookScript("OnTextChanged", function() Q.UpdatePlaceholder() end)
	input:HookScript("OnEditFocusGained", function() Q.UpdatePlaceholder() end)
	input:HookScript("OnEditFocusLost", function() Q.UpdatePlaceholder() end)
	Q.UpdatePlaceholder()

	local projectHost = ui.titleBar or inputBg
	local projectButton = CreateFrame("Button", "ClaudeWoWProjectButton", projectHost)
	if ui.titleBar then
		projectButton:SetSize(120, Q.NAV_H - 10)
		projectButton:SetPoint("RIGHT", projectHost, "RIGHT", -Cli.PROJECT_PAD, 0)
		ui.chatTitle:SetPoint("RIGHT", projectButton, "LEFT", -Cli.PROJECT_PAD, 0)
	else
		projectButton:SetSize(120, 16)
		projectButton:SetPoint("BOTTOMRIGHT", projectHost, "BOTTOMRIGHT", -6, 4)
	end
	projectButton:SetFrameLevel((Try(projectHost.GetFrameLevel, projectHost) or 1) + 5)
	projectButton.text = projectButton:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	projectButton.text:SetPoint("RIGHT", projectButton, "RIGHT", -2, 0)
	projectButton.text:SetJustifyH("RIGHT")
	projectButton.text:SetWordWrap(false)
	local projectHl = projectButton:CreateTexture(nil, "HIGHLIGHT")
	projectHl:SetAllPoints()
	projectHl:SetColorTexture(1, 1, 1, 0.08)
	projectButton:RegisterForClicks("LeftButtonUp")
	projectButton:SetScript("OnClick", function(self)
		GameTooltip:Hide()
		Cli.ProjectMenu(self)
	end)
	projectButton:SetScript("OnEnter", Cli.ProjectButtonTooltip)
	projectButton:SetScript("OnLeave", function() GameTooltip:Hide() end)
	projectHost:HookScript("OnSizeChanged", function() Cli.LayoutHeaderButtons() end)
	ui.projectButton = projectButton

	ui.mcpButton = Q.HeaderButton(projectHost, "ClaudeWoWMcpButton", projectButton, Cli.McpMenu, Cli.McpButtonTooltip)

	local send = MakeButton(f, "Send", SEND_W, ClaudeWoW.SendFromInput)
	Q.BesideInput(send, inputBg, native)
	send:SetScript("OnEnter", Q.SendTooltip)
	send:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.send = send

	local effort = Q.HeaderButton(f, "ClaudeWoWEffortButton", send, Cli.EffortMenu, Cli.EffortButtonTooltip)
	effort:ClearAllPoints()
	effort:SetSize(SEND_W, Q.EFFORT_H)
	effort:SetPoint("BOTTOMRIGHT", send, "TOPRIGHT", 0, Q.EFFORT_GAP)
	Cli.EffortBars(effort)
	ui.effort = effort

	local stop = MakeButton(inputBg, "Stop", Q.STOP_W, function() ClaudeWoW.Cancel(ActiveChat()) end)
	stop:SetHeight(Q.STOP_H)
	if ui.titleBar then
		stop:SetPoint("BOTTOMRIGHT", inputBg, "BOTTOMRIGHT", -Q.STOP_INSET, Q.STOP_INSET)
	else
		stop:SetPoint("TOPRIGHT", inputBg, "TOPRIGHT", -Q.STOP_INSET, -Q.STOP_INSET)
	end
	stop:SetFrameLevel((Try(inputBg.GetFrameLevel, inputBg) or 1) + 6)
	stop:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Stop this run")
		GameTooltip:AddLine("Ends the run this chat is waiting on and frees the chat for a new message. Same as /claude cancel.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	stop:SetScript("OnLeave", function() GameTooltip:Hide() end)
	stop:Hide()
	stop:SetScript("OnShow", function() Q.InsetComposer(true) end)
	stop:SetScript("OnHide", function() Q.InsetComposer(false) end)
	ui.stop = stop

	local connect = MakeButton(f, "Connect", SEND_W, function() ClaudeWoW.Connect(true) end)
	Q.BesideInput(connect, inputBg, native)
	connect:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Connect to the companion app")
		GameTooltip:AddLine("Start the companion app on this computer, then click here. The light turns green when it answers.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	connect:SetScript("OnLeave", function() GameTooltip:Hide() end)
	connect:Hide()
	ui.connect = connect

	-- Reload is the fallback transport's button; it sits apart on the right and
	-- only shows when a reload would do something (see UpdateStatus).
	local refresh = MakeButton(f, "Reload", 70, function() SafeReload() end)
	refresh:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -24, 16)
	refresh:Hide()
	ui.refresh = refresh

	local clear = MakeButton(f, "Clear", 60, function() ClaudeWoW.ConfirmClear() end)
	clear:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 16)

	local resend = MakeButton(f, "Resend", 70, ClaudeWoW.Resend)
	resend:SetPoint("LEFT", clear, "RIGHT", 6, 0)
	resend:SetScript("OnEnter", Q.ResendTooltip)
	resend:SetScript("OnLeave", function() GameTooltip:Hide() end)
	resend:Hide()
	ui.resend = resend
	if native then
		clear:Hide()
		resend:ClearAllPoints()
		resend:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -26, 4)
		refresh:ClearAllPoints()
		refresh:SetPoint("RIGHT", resend, "LEFT", -4, 0)
	end

	local legacyHotkey = CreateFrame("Button", Q.LEGACY_BIND_BUTTON, UIParent)
	legacyHotkey:SetSize(1, 1)
	legacyHotkey:SetPoint("TOPLEFT", UIParent, "TOPLEFT", -10, 10)
	legacyHotkey:SetScript("OnClick", function() ClaudeWoW.ToggleWorkspace() end)
	Q.MigrateLegacyBinding()

	local grip = CreateFrame("Button", nil, f)
	grip:SetSize(16, 16)
	grip:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -5, 5)
	grip:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
	grip:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
	grip:SetPushedTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Down")

	f:HookScript("OnSizeChanged", Q.LayoutListWidth)
	if ClaudeWoWWindow then ClaudeWoWWindow.Attach(f, grip) end
	Q.LayoutListWidth()
end

function ClaudeWoW.Toggle(show)
	if not ui.frame then return end
	if show == nil then show = not ui.frame:IsShown() end
	if show then
		local c = ActiveChat()
		if c then c.unread = 0 end
	end
	if not show then ui.quitting = true end
	ui.frame:SetShown(show)
	ui.quitting = nil
	db.settings.shown = show
	if show then
		ClaudeWoW.Render()
		-- No auto-focus: the game keeps the keyboard until you click the box.
		-- No automatic hello either: if the bridge hasn't been seen, the panel
		-- shows Connect in place of Send and waits for a click.
	end
end

function ClaudeWoW.Suspend(hidden)
	if not ui.frame or not db then return false end
	if hidden then
		if not ui.frame:IsShown() then return false end
		ui.quitting = true
		ui.frame:Hide()
		ui.quitting = nil
		return true
	end
	if not db.settings.shown or ui.frame:IsShown() then return false end
	ui.frame:Show()
	ClaudeWoW.Render()
	return true
end

---------------------------------------------------------------------------
-- Slash commands
---------------------------------------------------------------------------

ClaudeWoW.HELP_MISSING = "The Commands and tips page is in a new addon file. Restart the game client once to load it: a /reload does not load new files."

function ClaudeWoW.ShowHelp()
	if ClaudeWoWHelp and ClaudeWoWHelp.Open then return ClaudeWoWHelp.Open() end
	print(ClaudeWoW.PREFIX .. ClaudeWoW.HELP_MISSING)
	return nil
end

function ClaudeWoW.ShowOptions()
	if ClaudeWoWHelp and ClaudeWoWHelp.OpenOptions then return ClaudeWoWHelp.OpenOptions() end
	print(ClaudeWoW.PREFIX .. ClaudeWoW.HELP_MISSING)
	return nil
end

ClaudeWoW.ROLL_HELP = "A command that needs your OK opens a Greed, Need or Pass roll. Off: Allow once and Allow & retry buttons in the reply. Need and Allow & retry ask before they save a rule."

ClaudeWoW.HELP = {
	{
		title = "Start and resume chats",
		rows = {
			{ "/claude <text>", "Start a new chat with that message, like claude \"<text>\" in a terminal. Bare /claude opens the window on the current chat; /claude new starts an empty chat." },
			{ "/claude -c [text]", "Continue the current chat (--continue). Alone it points at its tab; with the tabs off, it opens the window on it." },
			{ "/claude -r [id|name|n] [text]", "Resume a session (--resume). A Claude Code session started with the claude-wow channel gets the chat live; any other session is resumed headless in its project. Bare -r lists the sessions (live ones first, marked live, running not listening, or resume): click a row or give its number; -r more lists them all." },
			{ "/claude -r all", "Open one chat per session handed off with claude-wow handoff in a terminal; each resumes its session headless." },
			{ "/claude -n <name> [text]", "Name the new chat (--name). With -c it renames the current one." },
		},
	},
	{
		title = "Chat options",
		rows = {
			{ "/claude --model <model> [text]", "The model for the chat: opus, sonnet or a full model name." },
			{ "/claude --effort <level> [text]", "low, medium, high, xhigh or max." },
			{ "/claude --project <name|path|none> [text]", "Attach this chat to a project (or #name in a message). none makes it a general chat." },
			{ "/claude --permission-mode <mode>", "acceptEdits, auto, plan, manual, dontAsk or bypassPermissions." },
			{ "/claude --add-dir <path> [text]", "One more folder the agent may use. Repeat the flag for more." },
			{ "/claude --agent <name> [text]", "Which CLI runs the chat: claude, codex, grok, agy or hermes." },
		},
		notes = {
			"Flags come before the text and combine: /claude --model opus fix the build starts a new chat on opus. With -c they change the current chat.",
			"--flag=value and \"quoted values\" work, a value of - clears a setting, and a flag with no value shows it. The companion app tells you when an agent has no such option.",
		},
	},
	{
		title = "This chat",
		rows = {
			{ "/claude cd <project path>", "Set this chat's project by its path, like --project. A relative path starts where the companion app runs; alone it goes back to the default. A chat with a project is a coding session there, one without is general in-game chat." },
			{ "/claude look <question>", "Send one message to the current chat with a picture of your screen." },
			{ "/claude rename [name]", "Rename the current chat. Alone it opens a dialog." },
			{ "/claude delete", "Delete the current chat." },
			{ "/claude clear", "Clear this chat's transcript." },
			{ "/claude copy", "Open the last reply in a selectable box for Ctrl+C." },
			{ "/claude reset", "The next message in this chat starts a fresh session." },
			{ "/claude cancel", "Stop waiting on this chat's reply." },
			{ "/claude mcp [on|off <name>|none|default]", "The MCP servers this chat's Claude or Codex runs get, with their health. The MCP button in the chat header does the same." },
			{ "/claude wrong [#n] [note]", "Mark the last reply in this chat (or reply #n) as wrong; the companion app keeps it in its feedback list." },
		},
	},
	{
		title = "Whispers",
		rows = {
			{ "/r <text>", "Reply to the chat that answered last, until a real player whispers you." },
			{ "/w <agent> <text>", "Send to that agent's chat when whisper tabs are on." },
		},
	},
	{
		title = "Settings and the window",
		rows = {
			{ "/claude config [key] [value]", "Settings: voice, roast, whisper, echo, vision, roll, achievements, orders, minimap, telemetry, ui, map, macro, context. Alone it lists them with their values; all adds the troubleshooting keys. The Options page under AddOns, " .. ClaudeWoW.PRODUCT .. " in the game's settings has the same switches." },
			{ "/claude config ui [setting]", "The tabs and the window: whisper on|off, dim <10-100>|off, dodge on|off, autohide on|off, reset." },
			{ "/claude orders [on|off]", "Show or hide the Orders card under the quest tracker." },
			{ "/claude dm [next]", "Show or hide the Dungeon Master; next goes on to a beat that waits for you. /dm is the same." },
			{ "/claude map [command]", "Map layers and node pins: ore, herb, filter, show, hide, nav, next, prev, stop. /aimap is the same." },
			{ "/claude stream [command]", "Stream scenes, panes and the quest overlay. /stream is the same." },
			{ "/claude config minimap [on|off]", "The minimap button: left-click opens or closes the window, right-click opens Options, drag it around the minimap." },
			{ "/claude help", "Open this page." },
		},
	},
	{
		title = "Tips",
		notes = {
			"A command word followed by something it does not take is a message: /claude delete the unused imports starts a new chat with that text.",
			"Shift-click an item, spell or quest to link it into your message.",
		},
	},
	{
		title = "More",
		rows = {
			{ "/claude bug <text>", "Report a bug, with the addon's state and Lua errors attached." },
			{ "/claude errors", "The Lua errors the addon caught this UI session." },
			{ "/claude reload", "Reload now. This also frees the slot pool." },
			{ "/claude dev [command]", "Dev tools for this chat's project, run by the companion app: status, diff, log, run, test, doctor, errors, feedback (/claude dev help). globals saves the widget audit list in game." },
			{ "/claude resend", "Show the strip again if the companion app missed it." },
			{ "/claude slots", "How many reply slots are still free this session." },
			{ "/claude diag [copy]", "Transport diagnostics; copy opens them in a box, selected for Ctrl+C." },
			{ "/claude probe [chatlog|asyncfile]", "Write test lines to the client's own logs so the companion app can measure them." },
		},
	},
}

local function OnOffOrNumber(rest)
	return rest == "" or rest == "on" or rest == "off" or tonumber(rest) ~= nil
end

local function ChatArgument(rest)
	if rest == "" or tonumber(rest) or not rest:find("%s") then return true end
	for _, ch in ipairs(db.chats) do
		if ch.name:lower() == rest:lower() then return true end
	end
	return false
end

local function WidgetArgument(rest)
	local lower = rest:lower()
	return lower == "" or lower == "list" or lower:match("^remove%s+%S+$") ~= nil or lower:match("^run%s+%S+$") ~= nil
end

local COMMAND_ARGS = {
	mini = 0, min = 0, hide = 0, quit = 0, help = 0, clear = 0, delete = 0, reset = 0, copy = 0,
	cancel = 0, resend = 0, reload = 0, refresh = 0, slots = 0, diag = { [""] = true, copy = true },
	dev = true, wrong = true, bug = true, errors = 0, discord = 0, mcp = function(rest) return Cli.IsMcpCommand(rest) end,
	context = function(rest) return rest == "" or rest == "on" or rest == "off" or ParseTokens(rest) ~= nil end,
	ctx = function(rest) return rest == "" or rest == "on" or rest == "off" or ParseTokens(rest) ~= nil end,
	mode = { [""] = true, pixel = true, reload = true },
	signal = { [""] = true, on = true, off = true }, longchat = { [""] = true, on = true, off = true },
	roll = { [""] = true, on = true, off = true },
	minimap = { [""] = true, on = true, off = true },
	whisper = { [""] = true, on = true, off = true },
	vision = { [""] = true, on = true, off = true },
	look = true,
	roast = { [""] = true, on = true, off = true },
	telemetry = { [""] = true, on = true, off = true },
	auto = OnOffOrNumber,
	echo = function(rest) return rest == "" or rest == "summary" or rest == "full" or rest == "short" or rest == "off" or tonumber(rest) ~= nil end,
	bind = true, agent = 1, plugin = 1, live = 0,
	chat = ChatArgument, chats = ChatArgument,
	cd = true, new = true, rename = true,
	map = true,
	macro = { undo = true },
	voice = function(rest) return ClaudeWoWVoice ~= nil and ClaudeWoWVoice.IsCommand(rest) end,
	achievements = { [""] = true, on = true, off = true, test = true, list = true },
	toasts = { [""] = true, on = true, off = true, test = true },
	orders = { [""] = true, on = true, off = true },
	ui = function(rest) return Cli.IsUi(rest) end,
	probe = function(rest)
		local which, arg = rest:lower():match("^(%S*)%s*(.-)$")
		if which == "chatlog" then return arg == "" or tonumber(arg) ~= nil end
		return arg == "" and (which == "" or which == "all" or which == "asyncfile")
	end,
}

Cli.CLAUDE_VERBS = {
	help = true, diag = true, cancel = true, copy = true, clear = true, rename = true, delete = true,
	cd = true, hide = true, quit = true, mini = true, min = true, reload = true, refresh = true,
	resend = true, slots = true, look = true, reset = true, probe = true, orders = true,
	dev = true, wrong = true, bug = true, errors = true, mcp = true, discord = true,
	dm = true, map = true, stream = true,
}

function Cli.NoArgument(arg) return arg == "" end
function Cli.OneWord(arg) return arg ~= "" and not arg:find("%s") end
function Cli.OnOffOrEmpty(arg) return arg == "" or arg == "on" or arg == "off" end

Cli.MODULE_SUBCOMMANDS = {
	dm = { [""] = Cli.NoArgument, next = Cli.NoArgument },
	map = {
		[""] = Cli.NoArgument, ore = Cli.OnOffOrEmpty, herb = Cli.OnOffOrEmpty,
		filter = function(arg) return arg == "all" or arg == "skill" end,
		show = Cli.OneWord, hide = Cli.OneWord,
		nav = function(arg) return arg:match("^%S+%s*%d*$") ~= nil end,
		next = Cli.NoArgument, prev = Cli.NoArgument, stop = Cli.NoArgument,
	},
	stream = {
		[""] = Cli.NoArgument, help = Cli.NoArgument,
		starting = Cli.NoArgument, raid = Cli.NoArgument, game = Cli.NoArgument, code = Cli.NoArgument, brb = Cli.NoArgument,
		quest = function(arg) return arg ~= "" end,
		pane = function(arg) return arg == "left" or arg == "right" or arg == "full" end,
		follow = function(arg) return arg == "on" or arg == "off" end,
	},
}

Cli.MODULE_COMMANDS = {
	dm = function() return ClaudeWoWDM and ClaudeWoWDM.Command end,
	map = function() return ClaudeWoWMap and ClaudeWoWMap.Command end,
	stream = function() return ClaudeWoWStream and ClaudeWoWStream.SlashCommand end,
}

function Cli.IsModuleCommand(verb, rest)
	local subcommands = Cli.MODULE_SUBCOMMANDS[verb]
	if not subcommands then return false end
	local word, arg = tostring(rest or ""):lower():match("^(%S*)%s*(.-)%s*$")
	local accepts = subcommands[word or ""]
	return accepts ~= nil and accepts(arg or "") == true
end

Cli.CONFIG_KEYS = {
	"voice", "roast", "whisper", "echo", "vision", "roll", "achievements", "orders", "minimap", "telemetry", "context", "signal",
	"mode", "longchat", "auto", "plugin", "ui", "map", "macro", "probe", "diag",
}
Cli.CONFIG_RETIRED = { bind = true }
Cli.CONFIG_DEV = { signal = true, mode = true, auto = true, longchat = true, plugin = true, probe = true, diag = true }
Cli.CONFIG_ALIASES = { toasts = "achievements", ctx = "context" }

local function IsCommand(cmd, rest)
	local spec = COMMAND_ARGS[cmd]
	if spec == nil then return false end
	if spec == true then return true end
	if spec == 0 then return rest == "" end
	if spec == 1 then return not rest:find("%s") end
	if type(spec) == "table" then return spec[rest:lower()] == true end
	return spec(rest) == true
end

function Cli.ConfigKey(word)
	word = tostring(word or ""):lower()
	word = Cli.CONFIG_ALIASES[word] or word
	return (Contains(Cli.CONFIG_KEYS, word) or Cli.CONFIG_RETIRED[word]) and word or nil
end

function Cli.IsConfig(rest)
	if rest == "" or rest:lower() == "all" then return true end
	local word, args = rest:match("^(%S+)%s*(.-)$")
	local key = Cli.ConfigKey(word)
	if not key then return false end
	if key == "macro" and args == "" then return true end
	return IsCommand(key, args)
end

local function ApplyLongChat()
	local box = ChatFrame1EditBox
	if not box or not box.SetMaxLetters then return end
	box:SetMaxLetters(db.settings.longchat and 4000 or 255)
end


Cli.emitted = setmetatable({}, { __mode = "k" })
Cli.invocation = nil

function Cli.Quiet()
	return type(Cli.invocation) == "table" and Cli.invocation.quiet == true
end

function Cli.WindowShown()
	return ui.frame ~= nil and ui.frame:IsShown()
end

function Cli.Emit(c, text)
	if not c or not Whisper.Active() then return end
	local cmd = run.cmd
	if cmd and cmd.tab then
		Whisper.System(c, text, true)
		return
	end
	if Cli.WindowShown() then return end
	if cmd and cmd.general then
		for line in (tostring(text) .. "\n"):gmatch("(.-)\n") do
			if line:match("%S") then print(ClaudeWoW.PREFIX .. line) end
		end
		return
	end
	Whisper.System(c, text, true)
end

function Cli.Show(c)
	if Whisper.Active() then
		if not c or Cli.WindowShown() then return end
		local had = run.whisperTabs and run.whisperTabs[c.id]
		local frame = Whisper.FrameFor(c, true, true)
		if frame then return frame == had end
	end
	ClaudeWoW.Toggle(true)
	return false
end

function Cli.Point(c)
	if Cli.Show(c) and run.cmd and run.cmd.general then
		print(ClaudeWoW.PREFIX .. Display(c.name) .. " is the \"" .. Whisper.Title(c) .. "\" tab in the chat dock; bare /claude opens the workspace window.")
	end
end



function Cli.Out(c, text, open)
	if not c or Cli.Quiet() then return end
	AddHistory(c, "system", text)
	Cli.emitted[c.history[#c.history]] = true
	ClaudeWoW.Render()
	Cli.Emit(c, text)
	if open then Cli.Show(c) end
end

function Cli.Note(c, text)
	if not c then return end
	ClaudeWoW.Render()
	if Whisper.Active() then
		Cli.Emit(c, text)
	else
		print(ClaudeWoW.PREFIX .. Display(text))
	end
end

function Cli.Say(c, text)
	Cli.Out(c, text, true)
end

function Cli.Begin(editBox)
	local tab = Whisper.TabChat(editBox) or Whisper.SelectedTabChat(editBox)
	local marks = {}
	for _, ch in ipairs(db.chats) do marks[ch.id] = ch.history[#ch.history] or false end
	run.cmd = { tab = tab, general = type(editBox) == "table" and not tab or nil, marks = marks }
	if tab and db.activeChat ~= tab.id then ClaudeWoW.SwitchChat(tab.id) end
end

function Cli.Finish()
	local cmd = run.cmd
	if not cmd then return end
	for _, ch in ipairs(db.chats) do
		local mark = cmd.marks[ch.id]
		local fresh = {}
		for i = #ch.history, 1, -1 do
			local m = ch.history[i]
			if m == mark then break end
			table.insert(fresh, 1, m)
		end
		for _, m in ipairs(fresh) do
			if m.role == "system" and not Cli.emitted[m] then
				Cli.emitted[m] = true
				Cli.Emit(ch, m.text)
			end
		end
	end
	run.cmd = nil
end

function Cli.Run(editBox, fn, ...)
	Cli.Begin(editBox)
	local ok, err = pcall(fn, ...)
	Cli.Finish()
	if not ok then error(err, 0) end
end

function ClaudeWoW.Print(msg)
	local cmd = run.cmd
	local c = cmd and cmd.tab
	if not c and not (cmd and cmd.general) and Whisper.Active() and not Cli.WindowShown() then
		c = FindChat(run.lastReplyChat) or ActiveChat()
	end
	if c and Whisper.System(c, msg, true, true) then return end
	print(ClaudeWoW.PREFIX .. msg)
end

function ClaudeWoW.OpenWorkspace(chatId, focus)
	if not ui.frame then return end
	if chatId and FindChat(chatId) and db.activeChat ~= chatId then ClaudeWoW.SwitchChat(chatId) end
	ClaudeWoW.Toggle(true)
	if focus and ui.input then ui.input:SetFocus() end
end

function ClaudeWoW.ToggleWorkspace()
	if not ui.frame then return end
	if ui.frame:IsShown() then
		ClaudeWoW.Toggle(false)
	else
		ClaudeWoW.OpenWorkspace()
	end
end

function Cli.ConfigValue(key)
	local s = db.settings
	local c = ActiveChat()
	if key == "voice" then return (type(ClaudeWoWDB.voice) == "table" and ClaudeWoWDB.voice.pack) or "race" end
	if key == "roast" then return (type(ClaudeWoWDB.roast) == "table" and ClaudeWoWDB.roast.on) and "on" or "off" end
	if key == "whisper" then return s.whisper and "on" or "off" end
	if key == "ui" then return Cli.UiStatus() end
	if key == "echo" then return tostring(s.echo) end
	if key == "vision" then return s.vision and "on" or "off" end
	if key == "roll" then return s.lootRoll == false and "off" or "on" end
	if key == "minimap" then return s.minimap == false and "off" or "on" end
	if key == "achievements" then return s.toasts == false and "toasts off" or "toasts on" end
	if key == "orders" then return ClaudeWoWOrders and ClaudeWoWOrders.Status() or "" end
	if key == "telemetry" then return ClaudeWoWTelemetry and ClaudeWoWTelemetry.Status() or "" end
	if key == "context" then return (s.context and "on" or "off") .. ", " .. ContextThresholdLabel() end
	if key == "signal" then return s.signal and "on" or "off" end
	if key == "mode" then return tostring(s.mode) end
	if key == "longchat" then return s.longchat and "on" or "off" end
	if key == "auto" then return (s.autoRefresh and "on" or "off") .. ", every " .. tostring(s.interval) .. " s" end
	if key == "plugin" then return (c and (c.plugin or "") ~= "") and c.plugin or ("chat default: " .. (Cli.ChatPlugin(c) ~= "" and Cli.ChatPlugin(c) or BridgePluginName())) end
	return ""
end

Cli.CONFIG_HELP = {
	voice = "race|peasant|peon|off, set <event> <line>, reset, test <event|line>, lines [pack]: voice lines at agent events",
	roast = "on|off: when you die, a short roast of it in the \"Death roasts\" chat",
	whisper = "on|off: each chat as a native whisper tab (same as ui whisper)",
	echo = "summary|full|short|off|<chars>: how much of a reply the game chat prints",
	vision = "on|off: a picture of your screen with each message (screenshot transport)",
	roll = "on|off: " .. ClaudeWoW.ROLL_HELP,
	achievements = "on|off|test: achievement toasts; alone it lists what you earned",
	orders = "on|off: the Orders card under the quest tracker (also /claude orders and the chat list's gear menu)",
	minimap = "on|off: the minimap button (left-click opens or closes the window, right-click opens Options, drag it around the minimap)",
	telemetry = "on|off: share game state with the agent (money, level, zone, professions, watched items, gear, reputation); also the chat list's gear menu",
	context = "on|off|<tokens>: the game context the agent gets, and the context-size warning (0 = never)",
	signal = "on|off: the cheap sound-file readiness check",
	mode = "pixel|reload: the transport",
	longchat = "on|off: let the game chat box take 4000 characters",
	auto = "on|off|<seconds>: how often the Reload needed dialog asks again after Later (reload mode, or when the reply slots are gone)",
	plugin = "<name>|default: advanced, what this chat is bound to",
	ui = "whisper on|off, dim <10-100>|off, dodge on|off, autohide on|off, reset: the tabs and the window; list|remove <name>|run <name>: live widgets",
	map = "map layers, the route navigator and herb/ore nodes (/aimap is the same)",
	macro = "undo: undo the last macro the agent's button created or changed",
	probe = "chatlog|asyncfile: write test lines to the client's own logs so the companion app can measure them",
	diag = "transport diagnostics",
}

function Cli.ConfigList(all)
	local lines = { "Settings. /claude config <key> <value> changes one, /claude config <key> shows it:" }
	for _, key in ipairs(Cli.CONFIG_KEYS) do
		if all or not Cli.CONFIG_DEV[key] then
			local value = Cli.ConfigValue(key)
			table.insert(lines, key .. (value ~= "" and (" = " .. value) or "") .. "  -  " .. Cli.CONFIG_HELP[key])
		end
	end
	table.insert(lines, "The game's Options window has the same settings: AddOns, " .. (ClaudeWoWHelp and ClaudeWoWHelp.AddonTitle() or ClaudeWoW.PRODUCT) .. ".")
	if not all then table.insert(lines, "/claude config all also lists the troubleshooting keys.") end
	return table.concat(lines, "\n")
end

function Cli.ParseDim(v)
	v = tostring(v or ""):lower()
	if v == "off" then return 1 end
	if v == "on" then return Cli.DIM_DEFAULT end
	local n = tonumber((v:gsub("%%$", "")))
	if not n then return nil end
	if n > 1 then n = n / 100 end
	if n < 0.1 or n > 1 then return nil end
	return n
end

function Cli.Percent(alpha)
	return math.floor((alpha or 1) * 100 + 0.5) .. "%"
end

function Cli.UiStatus()
	local s = db.settings
	local dim = tonumber(s.dim) or 1
	return "whisper " .. (s.whisper and "on" or "off")
		.. ", dim " .. (dim < 1 and Cli.Percent(dim) or "off")
		.. ", dodge " .. (s.dodge and "on" or "off")
		.. ", autohide " .. (s.autohide and "on" or "off")
end

function Cli.IsUi(rest)
	local word, arg = tostring(rest or ""):lower():match("^(%S*)%s*(.-)$")
	if word == "whisper" or word == "dodge" or word == "autohide" then return arg == "" or arg == "on" or arg == "off" end
	if word == "dim" then return arg == "" or Cli.ParseDim(arg) ~= nil end
	if word == "reset" then return arg == "" end
	return WidgetArgument(rest)
end

function Cli.SetWhisper(c, rest)
	local s = db.settings
	rest = tostring(rest or ""):lower()
	if rest == "on" then
		s.whisper, s.whisperChoice = true, "on"
		Whisper.Install()
		if Cli.Quiet() then return end
		local frame = Whisper.FrameFor(c, true, true)
		local text
		if frame then
			text = "Whisper tabs are ON: this chat is the \"" .. Whisper.Title(c) .. "\" tab in the chat dock. Type there and press Enter to talk to " .. ChatAgentName(c) .. "; replies flash the tab, and /claude commands work there too. Other chats get a tab of their own. /claude config ui whisper off closes them."
		elseif Whisper.Active() and not Whisper.MayOpen(c) then
			text = "Whisper tabs are ON. A chat gets its tab in the chat dock once the companion app answers and you send that chat a message. /claude config ui whisper off turns them off."
		else
			text = "Whisper tabs are ON, but this client could not open a chat tab" .. (run.whisperError and (": " .. run.whisperError) or " (no FCF_OpenTemporaryWindow)") .. ". Replies keep going to the game chat and the window."
		end
		Cli.Out(c, text)
	elseif rest == "off" then
		s.whisper, s.whisperChoice = false, "off"
		Whisper.CloseAll()
		if Cli.Quiet() then return end
		Cli.Out(c, "Whisper tabs are off; replies go to the game chat and the window as before")
		print(ClaudeWoW.PREFIX .. "Whisper tabs are off: replies go to the game chat, and /claude opens the window. /claude config ui whisper on brings the tabs back.")
	else
		Cli.Out(c, Whisper.Status() .. " (/claude config ui whisper on|off: each chat as a native whisper tab)")
	end
end

function Cli.Ui(c, rest)
	local s = db.settings
	local word, arg = tostring(rest or ""):match("^(%S*)%s*(.-)$")
	word, arg = (word or ""):lower(), (arg or ""):lower()
	if word == "whisper" then
		Cli.SetWhisper(c, arg)
	elseif word == "dodge" then
		if arg == "on" then s.dodge = true elseif arg == "off" then s.dodge = false end
		Cli.Out(c, "Dodge is " .. (s.dodge and "on: the window moves aside when bags, the character sheet, the spellbook, a vendor or another panel opens, and goes back when it closes." or "off: the window stays in the left panel slot."))
	elseif word == "autohide" then
		if arg == "on" then s.autohide = true elseif arg == "off" then s.autohide = false end
		Cli.Out(c, "Auto-hide is " .. (s.autohide and "on: the window steps away while the maximized world map, the game menu or the settings are open, and comes back after." or "off: the window stays up over full-screen panels."))
	elseif word == "dim" then
		if arg ~= "" then s.dim = Cli.ParseDim(arg) end
		local dim = tonumber(s.dim) or 1
		Cli.Out(c, dim < 1 and ("The window dims to " .. Cli.Percent(dim) .. " while you move or fight, and comes back when you stop or point at it.") or "Dimming is off: the window stays fully opaque.")
	elseif word == "reset" then
		if ClaudeWoWWindow then ClaudeWoWWindow.Reset() end
		Cli.Out(c, "The window's size is back to the default for this character.")
	elseif word == "" then
		Cli.Out(c, "Window and tabs: " .. Cli.UiStatus() .. ".\n/claude config ui whisper on|off, dim <10-100>|off, dodge on|off, autohide on|off, reset.\nLive widgets: /claude config ui list, remove <name>, run <name>.")
		if ClaudeWoWWidgets then ClaudeWoWWidgets.Command("") end
	elseif ClaudeWoWWidgets then
		ClaudeWoWWidgets.Command(rest)
	else
		ClaudeWoW.Print("the widget module did not load")
	end
	if ClaudeWoWWindow then ClaudeWoWWindow.Apply() end
end

local RunCommand

function Cli.Reject(text)
	Cli.Say(ActiveChat(), text)
	return text
end

function Cli.ConfigCommand(rest, ctx)
	rest = Trim(rest or "")
	if rest == "" or rest:lower() == "all" then
		Cli.Say(ActiveChat(), Cli.ConfigList(rest ~= ""))
		return nil
	end
	local word, args = rest:match("^(%S+)%s*(.-)$")
	local key = Cli.ConfigKey(word)
	if not key then return Cli.Reject("No setting \"" .. word .. "\". " .. Cli.ConfigList()) end
	if key == "macro" and args == "" then
		Cli.Say(ActiveChat(), "macro: " .. Cli.CONFIG_HELP.macro)
		return nil
	end
	if not IsCommand(key, args) then
		return Cli.Reject(key .. " does not take \"" .. args .. "\". " .. key .. ": " .. Cli.CONFIG_HELP[key])
	end
	RunCommand(key, args, ctx)
	return nil
end

function ClaudeWoW.Config(rest, ctx)
	ctx = type(ctx) == "table" and ctx or {}
	local outer = Cli.invocation
	Cli.invocation = ctx
	local ok, result = pcall(Cli.ConfigCommand, rest, ctx)
	Cli.invocation = outer
	if not ok then error(result, 0) end
	return result
end

Cli.CLI_FLAGS = {
	["-c"] = "continue", ["--continue"] = "continue",
	["-r"] = "resume", ["--resume"] = "resume",
	["-n"] = "name", ["--name"] = "name",
	["-h"] = "help", ["--help"] = "help",
	["--model"] = "model", ["--effort"] = "effort", ["--permission-mode"] = "permissionMode",
	["--add-dir"] = "addDir", ["--agent"] = "agent", ["--project"] = "project",
}
Cli.CLI_VALUE = { name = "required", model = "required", effort = "required", permissionMode = "required", addDir = "required", agent = "required", project = "required", resume = "optional" }
Cli.EFFORTS = { "low", "medium", "high", "xhigh", "max", "minimal" }
Cli.PERMISSION_MODES = { "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan" }
Cli.ADD_DIRS_MAX = 8

function Cli.ReadToken(s, pos)
	local start = s:find("%S", pos)
	if not start then return nil end
	local q = s:sub(start, start)
	if q == "\"" or q == "'" then
		local close = s:find(q, start + 1, true)
		if close and (close == #s or s:sub(close + 1, close + 1):match("%s")) then
			return s:sub(start + 1, close - 1), start, close + 1, true
		end
	end
	local stop = s:find("%s", start) or (#s + 1)
	return s:sub(start, stop - 1), start, stop, false
end

function Cli.TextFrom(msg, start)
	local rest = Trim(msg:sub(start))
	local q = rest:sub(1, 1)
	if (q == "\"" or q == "'") and #rest >= 2 and rest:sub(-1) == q and not rest:sub(2, -2):find(q, 1, true) then
		return rest:sub(2, -2)
	end
	return rest
end

function Cli.FlagKey(tok)
	if not tok then return nil end
	local name = tok:match("^(%-%-[%w%-]+)=") or tok
	return Cli.CLI_FLAGS[name:lower()]
end

function ClaudeWoW.ParseCli(msg)
	msg = msg or ""
	local o = { flags = 0, text = "", addDir = {} }
	local pos = 1
	while true do
		local tok, start, after, quoted = Cli.ReadToken(msg, pos)
		if not tok then return o end
		if quoted then
			o.text = Cli.TextFrom(msg, start)
			return o
		end
		if tok == "--" then
			o.text = Cli.TextFrom(msg, after)
			return o
		end
		local name, inline = tok:match("^(%-%-[%w%-]+)=(.*)$")
		local key = Cli.CLI_FLAGS[(name or tok):lower()]
		if not key then
			o.text = Cli.TextFrom(msg, start)
			return o
		end
		o.flags = o.flags + 1
		pos = after
		local value
		if name then
			if inline ~= "" then
				local v, _, vAfter = Cli.ReadToken(msg, start + #name + 1)
				value, pos = v, vAfter
			end
		elseif Cli.CLI_VALUE[key] then
			local nxt, _, nAfter, nQuoted = Cli.ReadToken(msg, pos)
			if nxt and nxt ~= "--" and (nQuoted or not Cli.FlagKey(nxt)) then
				value, pos = nxt, nAfter
			end
		end
		if key == "addDir" then
			if value then table.insert(o.addDir, value) else o.addDirShow = true end
		elseif Cli.CLI_VALUE[key] then
			o[key] = value or true
		else
			o[key] = true
		end
	end
end

function Cli.Cleared(v)
	v = tostring(v or ""):lower()
	return v == "-" or v == "default"
end

function Cli.Canonical(list, v)
	v = tostring(v or ""):lower()
	for _, x in ipairs(list) do
		if x:lower() == v then return x end
	end
	return nil
end

function Cli.HasSetters(o)
	for _, key in ipairs({ "name", "model", "effort", "permissionMode", "agent", "project" }) do
		if type(o[key]) == "string" then return true end
	end
	return #o.addDir > 0
end

function Cli.CheckFlags(o)
	local errors = {}
	if type(o.model) == "string" and not Cli.Cleared(o.model) and not o.model:match("^[%w%._:%[%]%-]+$") then
		table.insert(errors, "\"" .. o.model .. "\" is not a model name.")
	end
	if type(o.effort) == "string" and not Cli.Cleared(o.effort) and not Cli.Canonical(Cli.EFFORTS, o.effort) then
		table.insert(errors, "Unknown effort \"" .. o.effort .. "\": low, medium, high, xhigh or max.")
	end
	if type(o.permissionMode) == "string" and not Cli.Cleared(o.permissionMode) and not Cli.Canonical(Cli.PERMISSION_MODES, o.permissionMode) then
		table.insert(errors, "Unknown permission mode \"" .. o.permissionMode .. "\": " .. table.concat(Cli.PERMISSION_MODES, ", ") .. ".")
	end
	if type(o.agent) == "string" and not Cli.Cleared(o.agent) and run.bridgeAgents and not Contains(run.bridgeAgents, o.agent:lower()) then
		table.insert(errors, "Unknown agent \"" .. o.agent .. "\". The companion app knows: " .. AgentList() .. ".")
	end
	if #o.addDir > Cli.ADD_DIRS_MAX then table.insert(errors, "At most " .. Cli.ADD_DIRS_MAX .. " --add-dir folders.") end
	if type(o.project) == "string" and not Cli.ResolveProject(o.project) then
		table.insert(errors, "Unknown project \"" .. o.project .. "\". Known: " .. Cli.ProjectNames() .. ". Or give a path.")
	end
	return errors
end

function Cli.DirsLabel(c)
	if type(c.addDirs) ~= "table" or #c.addDirs == 0 then return "none" end
	return table.concat(c.addDirs, ", ")
end

function Cli.ApplyChatFlags(c, o)
	local notes, projectNote = {}, nil
	if o.agent ~= nil then ClaudeWoW.SetAgent(o.agent == true and "" or o.agent, c) end
	if type(o.project) == "string" then
		projectNote = "project: " .. (Cli.SetProject(c, o.project) or Cli.ProjectLabel(c))
	elseif o.project == true then
		table.insert(notes, "project: " .. Cli.ProjectLabel(c) .. " (known: " .. Cli.ProjectNames() .. ")")
	end
	local function Setting(key, label, canonical, unset)
		if o[key] == nil then return end
		if o[key] ~= true then
			if Cli.Cleared(o[key]) then
				c[key] = nil
			else
				c[key] = canonical and canonical(o[key]) or o[key]
			end
		end
		table.insert(notes, label .. ": " .. ((c[key] or "") ~= "" and c[key] or (unset and unset() or "the agent's default")))
	end
	Setting("model", "model")
	Setting("effort", "effort", function(v) return Cli.Canonical(Cli.EFFORTS, v) end, function() return Cli.EffortLabel(c) end)
	Setting("permissionMode", "permission mode", function(v) return Cli.Canonical(Cli.PERMISSION_MODES, v) end)
	if #o.addDir > 0 or o.addDirShow then
		for _, dir in ipairs(o.addDir) do
			if Cli.Cleared(dir) then
				c.addDirs = nil
			else
				c.addDirs = c.addDirs or {}
				if not Contains(c.addDirs, dir) and #c.addDirs < Cli.ADD_DIRS_MAX then table.insert(c.addDirs, dir) end
			end
		end
		table.insert(notes, "extra folders: " .. Cli.DirsLabel(c))
	end
	return notes, projectNote
end

function Cli.Age(at)
	local now = run.bridgeNow or time()
	local sec = math.max(0, now - (tonumber(at) or now))
	if sec < 60 then return "now" end
	if sec < 3600 then return math.floor(sec / 60) .. "m ago" end
	if sec < 86400 then return math.floor(sec / 3600) .. "h ago" end
	return math.floor(sec / 86400) .. "d ago"
end

function Cli.LastActivity(ch)
	local last = ch.history and ch.history[#ch.history]
	return (last and last.t) or ch.created or 0
end

function Cli.LatestChat()
	local best
	for _, ch in ipairs(db.chats) do
		if not ch.quiet and (not best or Cli.LastActivity(ch) > Cli.LastActivity(best)) then best = ch end
	end
	return best or db.chats[1]
end

Cli.PICKER_ROWS = 8
Cli.TITLE_MAX = 48
Cli.BADGES = {
	live = { "live", "55ff55" },
	deaf = { "running, not listening", "ff9933" },
	resume = { "resume", "aaaaaa" },
}

function Cli.SessionEntries()
	local live, deaf, rest, seen, seenId = {}, {}, {}, {}, {}
	for _, e in ipairs(run.bridgeSessions or {}) do
		if e.id == "" or not seenId[e.id] then
			if e.id ~= "" then seenId[e.id] = true end
			local alias = e.name
			local chat = e.chat ~= "" and FindChat(e.chat) or nil
			for _, ch in ipairs(db.chats) do
				if not chat and e.id ~= "" and (ch.session == e.id or ch.resumeId == e.id) and not e.running then chat = ch end
				if not chat and e.running and ch.liveTarget and (ch.liveTarget == e.id or ch.liveTarget:lower() == alias:lower()) then chat = ch end
			end
			if not (chat and seen[chat.id]) then
				local kind = e.live and "live" or (e.running and "deaf" or (chat and "chat" or "headless"))
				local title = e.title ~= "" and e.title or e.name
				local entry = {
					kind = kind, id = e.id, name = (chat and not e.running) and chat.name or title, alias = alias,
					cwd = e.cwd, branch = e.branch, agent = e.agent, plugin = e.plugin, at = e.at,
					live = e.live, running = e.running, restart = e.restart, chat = chat and chat.id or nil,
					bridgeChat = (not chat and e.chat ~= "") and e.chat or nil,
					handoff = e.handoff, recap = e.recap,
				}
				table.insert(kind == "live" and live or (kind == "deaf" and deaf or rest), entry)
				if chat then seen[chat.id] = true end
			end
		end
	end
	for _, ch in ipairs(Q.ListedChats()) do
		if not seen[ch.id] then
			table.insert(rest, { kind = "chat", id = ch.session or "", name = ch.name, cwd = ch.cwd or "", branch = "", agent = ch.agent or "", at = Cli.LastActivity(ch), chat = ch.id })
		end
	end
	for i, e in ipairs(rest) do e.order = i end
	table.sort(rest, function(a, b)
		local x, y = tonumber(a.at) or 0, tonumber(b.at) or 0
		if x ~= y then return x > y end
		return a.order < b.order
	end)
	local list = {}
	for _, group in ipairs({ live, deaf, rest }) do
		for _, e in ipairs(group) do table.insert(list, e) end
	end
	return list
end

function Cli.Badge(e)
	if e.kind == "live" then return Cli.BADGES.live end
	if e.kind == "deaf" then return Cli.BADGES.deaf end
	return Cli.BADGES.resume
end

function Cli.EntryParts(e)
	local title = Flat(e.name ~= "" and e.name or (e.id ~= "" and e.id:sub(1, 8) or "?"))
	if #title > Cli.TITLE_MAX then title = title:sub(1, Cli.TITLE_MAX - 3) .. "..." end
	local where = Display(FolderName(e.cwd or ""))
	if (e.branch or "") ~= "" then where = (where ~= "" and (where .. " ") or "") .. "(" .. Display(e.branch) .. ")" end
	local meta = {}
	if where ~= "" then table.insert(meta, where) end
	if e.at and e.at > 0 then table.insert(meta, Cli.Age(e.at)) end
	local current = e.chat ~= nil and e.chat == db.activeChat
	return title, table.concat(meta, " " .. SEG.DOT .. " "), Cli.Badge(e), current
end

function Cli.EntryLine(i, e)
	local title, meta, badge, current = Cli.EntryParts(e)
	local parts = { title }
	if meta ~= "" then table.insert(parts, meta) end
	table.insert(parts, badge[1])
	return i .. ". " .. table.concat(parts, " " .. SEG.DOT .. " ") .. (current and " (this chat)" or "")
end

function Cli.EntryRich(i, e)
	local title, meta, badge, current = Cli.EntryParts(e)
	return "|cff7ec8ff[" .. i .. "]|r " .. title
		.. (meta ~= "" and (" |cff888888" .. SEG.DOT .. " " .. meta .. "|r") or "")
		.. " |cff" .. badge[2] .. badge[1] .. "|r"
		.. (current and " |cffffd100(this chat)|r" or "")
end

function Cli.EntryLink(i, e)
	return "|H" .. LINK_PREFIX .. "resume:" .. i .. "|h" .. Cli.EntryRich(i, e) .. "|h"
end

function Cli.EntryCopy(e)
	local copy = {}
	for k, v in pairs(e) do
		if type(v) ~= "table" and type(v) ~= "function" then copy[k] = v end
	end
	return copy
end

function Cli.MoreRich(left)
	return "|cff7ec8ff[more]|r |cff888888" .. left .. " older session" .. (left == 1 and "" or "s") .. "|r"
end

function ClaudeWoW.ShowResumePicker(entries, header, all)
	entries = entries or Cli.SessionEntries()
	run.resumeList = entries
	local c = ActiveChat()
	header = header or "Sessions: click one to attach this chat, or /claude -r <n>."
	local shown = all and #entries or math.min(#entries, Cli.PICKER_ROWS)
	local left = #entries - shown
	local lines, rows = { header }, {}
	for i = 1, shown do
		local e = entries[i]
		table.insert(lines, Cli.EntryLine(i, e))
		table.insert(rows, { text = Cli.EntryRich(i, e), entry = Cli.EntryCopy(e) })
	end
	if #entries == 0 then table.insert(lines, "No sessions yet.") end
	if left > 0 then
		table.insert(lines, "[more] " .. left .. " older session" .. (left == 1 and "" or "s") .. ": /claude -r more")
		table.insert(rows, { text = Cli.MoreRich(left), more = true })
	end
	local live = run.bridgeLive
	local startHint = live and #live.sessions == 0 and live.start ~= "" and ("No session is listening to the game. Start one with: " .. live.start) or nil
	if startHint then table.insert(lines, startHint) end
	AddHistory(c, "system", table.concat(lines, "\n"))
	local m = c.history[#c.history]
	m.picker = rows
	m.head = header .. (startHint and ("\n" .. startHint) or "")
	Cli.emitted[m] = true
	ClaudeWoW.Render()
	if not Whisper.Active() then ClaudeWoW.Toggle(true) end
	ClaudeWoW.Print(Display(header))
	for i = 1, shown do ClaudeWoW.Print(Cli.EntryLink(i, entries[i])) end
	if #entries == 0 then ClaudeWoW.Print("No sessions yet.") end
	if left > 0 then ClaudeWoW.Print("|H" .. LINK_PREFIX .. "sessions:all|h" .. Cli.MoreRich(left) .. "|h") end
	if startHint then ClaudeWoW.Print(Display(startHint)) end
end

function Cli.Links.sessions(arg)
	ClaudeWoW.ShowResumePicker(nil, nil, arg == "all")
end

function Cli.Links.headless(arg)
	local id = Cli.Split(arg)[1]
	if not db or id == "" then return end
	local found
	for _, e in ipairs(run.resumeList or {}) do
		if e.id == id then found = e end
	end
	if not found then
		for _, e in ipairs(Cli.SessionEntries()) do
			if e.id == id then found = e end
		end
	end
	local e = Cli.EntryCopy(found or { id = id, name = id:sub(1, 8), cwd = "", agent = "" })
	e.kind, e.live, e.running, e.chat = "headless", false, false, nil
	Cli.AttachWith(e, { text = "", addDir = {}, flags = 1 })
end

function ClaudeWoW.PickRow(row)
	if type(row) ~= "table" or not db then return end
	if row.more then
		ClaudeWoW.ShowResumePicker(nil, nil, true)
		return
	end
	if row.headless then
		Cli.Links.headless(row.headless)
		return
	end
	if type(row.entry) == "table" then Cli.AttachWith(Cli.EntryCopy(row.entry), { text = "", addDir = {}, flags = 1 }) end
end

function Cli.MatchEntries(entries, ref)
	local want = tostring(ref or ""):lower()
	local function alias(e) return tostring(e.alias or ""):lower() end
	local rules = {
		function(e) return e.id ~= "" and e.id:lower() == want end,
		function(e) return e.name:lower() == want end,
		function(e) return alias(e) ~= "" and alias(e) == want end,
		function(e) return #want >= 4 and e.id ~= "" and e.id:lower():sub(1, #want) == want end,
		function(e) return e.name:lower():sub(1, #want) == want end,
		function(e) return alias(e) ~= "" and alias(e):sub(1, #want) == want end,
	}
	for _, rule in ipairs(rules) do
		local hits = {}
		for _, e in ipairs(entries) do
			if rule(e) then table.insert(hits, e) end
		end
		if #hits > 0 then return hits end
	end
	return {}
end

function Cli.AttachTo(e)
	local c = e.chat and FindChat(e.chat) or nil
	if c then
		ClaudeWoW.SwitchChat(c.id)
		return c, false
	end
	if e.chat and (e.id or "") == "" then
		Cli.Say(ActiveChat(), "That chat is gone. /claude -r lists what is left.")
		return nil
	end
	local name = (e.name ~= "" and e.name or e.id:sub(1, 8)):sub(1, 24)
	c = AddChat(name, "")
	if not e.live and type(e.bridgeChat) == "string" and e.bridgeChat:match("^[%w]+$") and not FindChat(e.bridgeChat) then c.id = e.bridgeChat end
	c.plugin = ""
	c.agent = ""
	if e.live then
		c.liveTarget = e.id ~= "" and e.id or (e.alias or e.name)
		c.agent = "claude"
		c.cwd = e.cwd or ""
		Q.AddEvent(c, "Attached to " .. Display(e.name))
		AddHistory(c, "system", "Messages here go to that Claude Code session" .. (e.cwd ~= "" and (" in " .. Display(e.cwd)) or "") .. ", and its answers come back here.")
	else
		c.resumeId = e.id
		if e.agent and e.agent ~= "" then c.agent = e.agent end
		if e.plugin and e.plugin ~= "" and e.plugin ~= "claude-code" and e.plugin ~= LIVE_PLUGIN then
			c.plugin = e.plugin
		else
			c.cwd = e.cwd or ""
			c.adoptCwd = (e.cwd or "") == "" or nil
			c.adoptBind = true
		end
		Q.AddEvent(c, "Attached to session " .. e.id:sub(1, 8))
		AddHistory(c, "system", "Your next message resumes session " .. e.id .. ((e.cwd or "") ~= "" and (" in " .. Display(e.cwd)) or "") .. (e.unverified and " (the companion app looks the id up then)" or "") .. ".")
		if e.recap then AddHistory(c, "system", e.recap) end
	end
	ClaudeWoW.SwitchChat(c.id)
	ClaudeWoW.RenderChatList()
	return c, true
end

function Cli.NotListening(e, text)
	local c = ActiveChat()
	local lines = { Display(e.name) .. " is running in a terminal, but it was not started with the claude-wow channel, so it cannot hear the game." }
	if (e.restart or "") ~= "" then
		table.insert(lines, "Restart it in its terminal with:")
		table.insert(lines, e.restart)
	end
	if (e.id or "") ~= "" then table.insert(lines, "Or resume it headless here: click [resume headless] below.") end
	if (text or "") ~= "" then table.insert(lines, "Your message was not sent.") end
	Cli.Out(c, table.concat(lines, "\n"), true)
	if (e.id or "") ~= "" then
		local link = "|cff55ff55[resume headless]|r |cff888888continue " .. Display(e.name) .. " here without its terminal|r"
		c.history[#c.history].picker = { { text = link, headless = e.id } }
		ClaudeWoW.Render()
		ClaudeWoW.Print("|H" .. LINK_PREFIX .. "headless:" .. e.id .. "|h" .. link .. "|h")
	end
end

function Cli.ResolveResume(ref)
	local n = tonumber(ref)
	if n and n == math.floor(n) and n >= 1 then
		local list = run.resumeList or Cli.SessionEntries()
		if list[n] then return { list[n] } end
	end
	local hits = Cli.MatchEntries(Cli.SessionEntries(), ref)
	if #hits == 0 and ref:match("^[%x%-]+$") and #ref >= 8 then
		return { { kind = "headless", id = ref, name = ref:sub(1, 8), cwd = "", agent = "", at = 0, unverified = true } }
	end
	return hits
end

function Cli.AttachWith(e, o)
	if e.kind == "deaf" then
		Cli.NotListening(e, o.text)
		return
	end
	local c = Cli.AttachTo(e)
	if not c then return end
	if type(o.name) == "string" then
		c.name = o.name:sub(1, 24)
		Whisper.Retitle(c)
	end
	local notes, projectNote = Cli.ApplyChatFlags(c, o)
	if projectNote then Cli.Note(c, projectNote) end
	if #notes > 0 then Cli.Out(c, table.concat(notes, "\n")) end
	if o.text ~= "" then
		ClaudeWoW.Send(o.text, nil, { chat = c.id })
	else
		ClaudeWoW.Render()
		Cli.Show(c)
	end
end

function Cli.RunResume(o)
	if o.resume == true then
		ClaudeWoW.ShowResumePicker()
		return
	end
	if tostring(o.resume):lower() == "more" and o.text == "" then
		ClaudeWoW.ShowResumePicker(nil, nil, true)
		return
	end
	if tostring(o.resume):lower() == "all" and o.text == "" then
		Cli.ResumeAll()
		return
	end
	local hits = Cli.ResolveResume(o.resume)
	if #hits == 0 then
		Cli.Say(ActiveChat(), "No chat or session matches \"" .. Display(o.resume) .. "\". /claude -r lists them.")
		return
	end
	if #hits > 1 then
		ClaudeWoW.ShowResumePicker(hits, "\"" .. Display(o.resume) .. "\" matches " .. #hits .. " sessions: click one, or /claude -r <n>.", true)
		return
	end
	Cli.AttachWith(hits[1], o)
end

function Cli.ResumeAll()
	local from = ActiveChat()
	if db.settings.mode == "pixel" and not (run.slotsExhausted or run.slotsMissing) then TryLoadSlot("manual") end
	local opened, busy, already = {}, {}, {}
	for _, e in ipairs(Cli.SessionEntries()) do
		if e.handoff then
			if e.running then
				table.insert(busy, e)
			elseif e.chat then
				table.insert(already, e)
			else
				local c = Cli.AttachTo(e)
				if c then table.insert(opened, c) end
			end
		end
	end
	if #opened + #busy + #already == 0 then
		Cli.Say(from, "No sessions were handed off. In a terminal, run: claude-wow handoff <repository path> --stop. Then /claude -r all again (the list can take a few seconds to reach the game).")
		return
	end
	local lines = {}
	if #opened > 0 then
		local names = {}
		for _, c in ipairs(opened) do table.insert(names, c.name) end
		table.insert(lines, "Opened " .. #opened .. " chat" .. (#opened == 1 and "" or "s") .. " for the handed-off sessions: " .. table.concat(names, ", ") .. ". Each resumes its session with your first message there.")
	end
	if #already > 0 then table.insert(lines, #already .. " already had a chat.") end
	if #busy > 0 then
		local names = {}
		for _, e in ipairs(busy) do table.insert(names, Display(e.name)) end
		table.insert(lines, "Still running in a terminal, so not opened (resuming both would fork them): " .. table.concat(names, ", ") .. ". Quit them, then /claude -r all again.")
	end
	Cli.Say(opened[#opened] or from, table.concat(lines, "\n"))
end

function ClaudeWoW.ResumePick(n)
	if not n or not db then return end
	local e = (run.resumeList or Cli.SessionEntries())[n]
	if not e then return end
	Cli.RunResume({ resume = tostring(n), text = "", addDir = {}, flags = 1 })
end

Cli.DEV_PLUGIN = "dev"
Cli.DEV_ERRORS_MARK = "\n--- addon errors ---\n"
Cli.DEV_ATTACH_MAX = 1400

function Cli.DevCommand(c, cmd, rest)
	if not c then return end
	local devVerb, devArg = rest:match("^%s*(%S+)%s*(.-)%s*$")
	if cmd == "dev" and devVerb and devVerb:lower() == "globals" then
		Cli.Say(c, ClaudeWoWWidgets and ClaudeWoWWidgets.GlobalsCommand(devArg) or "Widgets.lua is not loaded. Restart the game client once to load new addon files.")
		return
	end
	if c.pendingId then
		Cli.Say(c, "This chat is still waiting on a reply. Run the dev command when it is back, or in another chat.")
		return
	end
	if not (run.bridgePlugins and Contains(run.bridgePlugins, Cli.DEV_PLUGIN)) then
		Cli.Say(c, "The bridge has not said it has dev tools: it is older than this addon, or it has not answered since you logged in. Update it (claude-wow update), send any message, then try again.")
		return
	end
	local body = cmd == "dev" and (rest ~= "" and rest or "help") or (cmd .. (rest ~= "" and (" " .. rest) or ""))
	local verb = (body:match("^(%S+)") or ""):lower()
	if verb == "bug" and rest == "" then
		Cli.Say(c, "Say what went wrong: /claude bug <text>.")
		return
	end
	if (verb == "errors" or verb == "bug") and ClaudeWoWDev then
		local attached = ClaudeWoWDev.Attachment(Cli.DEV_ATTACH_MAX)
		if verb == "bug" then attached = ClaudeWoWDev.State() .. (attached ~= "" and ("\n" .. attached) or "") end
		if attached ~= "" then body = body .. Cli.DEV_ERRORS_MARK .. attached end
	end
	ClaudeWoW.Send("@" .. Cli.DEV_PLUGIN .. " " .. body, nil, { chat = c.id, verbatim = true })
end

function ClaudeWoW.RunCli(o)
	if o.help then
		ClaudeWoW.ShowHelp()
		return
	end
	local errors = Cli.CheckFlags(o)
	if #errors > 0 then
		Cli.Say(ActiveChat(), table.concat(errors, "\n"))
		return
	end
	if o.resume ~= nil then
		Cli.RunResume(o)
		return
	end
	local c, notes, projectNote
	if o.continue or (o.flags > 0 and o.text == "" and not Cli.HasSetters(o)) then
		c = ActiveChat()
		if o.continue and type(o.name) == "string" then
			c.name = o.name:sub(1, 24)
			Whisper.Retitle(c)
		end
		notes, projectNote = Cli.ApplyChatFlags(c, o)
	else
		c = ClaudeWoW.NewChat(type(o.name) == "string" and o.name:sub(1, 24) or nil, function(fresh) notes, projectNote = Cli.ApplyChatFlags(fresh, o) end)
	end
	if projectNote then Cli.Note(c, projectNote) end
	if #notes > 0 then Cli.Out(c, table.concat(notes, "\n")) end
	if o.text ~= "" then
		ClaudeWoW.Send(o.text, nil, { chat = c.id })
	else
		ClaudeWoW.Render()
		Cli.Point(c)
	end
end

SLASH_CLAUDEWOW1 = "/claude-wow"
SLASH_CLAUDE1 = "/claude"
function Cli.ClaudeCommand(msg)
	msg = Trim(msg or "")
	if msg == "" then
		ClaudeWoW.OpenWorkspace(nil, true)
		return
	end
	if msg:lower() == "new" then
		ClaudeWoW.NewChat()
		return
	end
	local cmd, rest = msg:match("^(%S+)%s*(.-)$")
	local verb = cmd:lower()
	if verb == "config" and Cli.IsConfig(rest) then
		ClaudeWoW.Config(rest)
		return
	end
	if Cli.MODULE_SUBCOMMANDS[verb] then
		if Cli.IsModuleCommand(verb, rest) then
			local handler = Cli.MODULE_COMMANDS[verb]()
			if handler then handler(rest) else ClaudeWoW.Print("the " .. verb .. " module did not load") end
			return
		end
	elseif Cli.CLAUDE_VERBS[verb] and IsCommand(verb, rest) then
		RunCommand(verb, rest)
		return
	end
	ClaudeWoW.RunCli(ClaudeWoW.ParseCli(msg))
end

function Cli.ClientCommand(msg)
	msg = Trim(msg or "")
	local cmd, rest = msg:match("^(%S+)%s*(.-)$")
	cmd = cmd and cmd:lower() or ""
	if cmd ~= "" and not IsCommand(cmd, rest) then
		ClaudeWoW.Send(msg)
		return
	end
	RunCommand(cmd, rest)
end

SlashCmdList["CLAUDE"] = function(msg, editBox)
	Cli.Run(editBox, Cli.ClaudeCommand, msg)
end

SlashCmdList["CLAUDEWOW"] = function(msg, editBox)
	Cli.Run(editBox, Cli.ClientCommand, msg)
end

function ClaudeWoW.Cancel(c)
	if c and c.pendingId then
		local cancelled = c.pendingId
		Whisper.StopProgress(c)
		AddHistory(c, "system", "Stopped." .. (run.bridgeCancel and "" or " It may still finish in the background."))
		run.outbound[c.pendingId] = nil
		if run.act then run.act[c.id] = nil end
		c.pendingId = nil
		c.progress = nil
		SendCancel(c, cancelled)
		RefreshStrip()
		if not AnyPending() then ClaudeWoW.DisarmReload() end
	elseif c then
		local waiting = {}
		for i, ch in ipairs(Q.ListedChats()) do
			if ch.pendingId then table.insert(waiting, i .. ". " .. ch.name) end
		end
		Cli.Out(c, "Nothing to cancel: " .. c.name .. " is not waiting for a reply. "
			.. (#waiting > 0 and ("Waiting: " .. table.concat(waiting, ", ") .. ". Pick one with /claude chat <number>, then /claude cancel.") or "No chat is waiting."))
	end
	ClaudeWoW.Render()
end

ClaudeWoW.Probe = {
	TAG = "CWLOG",
	CANCEL_BURST_FIRST = 135000,
	WAIT_BURST_FIRST = 135100,
	BURST_COUNT = 48,
}

function ClaudeWoW.Probe.HideLine(_, _, msg)
	return type(msg) == "string" and msg:find("^CWLOG%d+ H ") ~= nil
end

function ClaudeWoW.Probe.ChatLog(target)
	local P = ClaudeWoW.Probe
	if type(LoggingChat) ~= "function" or type(SendSystemMessage) ~= "function" then
		return "chatlog: LoggingChat or SendSystemMessage is missing in this client"
	end
	target = math.min(math.max(tonumber(target) or 16384, 1024), 262144)
	local tag = P.TAG .. time()
	local wasOn = LoggingChat()
	if not wasOn then LoggingChat(true) end
	if not P.filtered then
		local add = (type(ChatFrameUtil) == "table" and ChatFrameUtil.AddMessageEventFilter) or ChatFrame_AddMessageEventFilter
		if type(add) == "function" then P.filtered = pcall(add, "CHAT_MSG_SYSTEM", P.HideLine) end
	end
	SendSystemMessage(tag .. " LONG " .. string.rep("L", 1000))
	local pad = string.rep("z", 200)
	local lines = math.ceil(target / 240)
	for i = 1, lines do
		SendSystemMessage(string.format("%s %s %05d %s", tag, i % 4 == 1 and "V" or "H", i, pad))
	end
	SendSystemMessage(tag .. " END " .. lines)
	return string.format("chatlog: tag=%s lines=%d bytes=%d wasOn=%s filter=%s", tag, lines, target, tostring(wasOn), tostring(P.filtered or false))
end

function ClaudeWoW.Probe.AsyncFile(done)
	local P = ClaudeWoW.Probe
	local out = {}
	local function step(name, fn)
		local ok, a, b = pcall(fn)
		out[#out + 1] = name .. "=" .. tostring(ok) .. ":" .. tostring(a) .. ":" .. tostring(b)
	end
	if not P.host then
		P.host = CreateFrame("Frame", nil, UIParent)
		P.host:SetSize(2, 2)
		P.host:SetPoint("BOTTOMLEFT", UIParent, "BOTTOMLEFT", 0, 0)
		P.host:Show()
		P.shown = P.host:CreateTexture(nil, "BACKGROUND")
		P.shown:SetAllPoints()
		P.blocking = P.host:CreateTexture(nil, "BACKGROUND")
		P.blocking:SetAllPoints()
		P.hiddenHost = CreateFrame("Frame")
		P.hiddenHost:Hide()
		P.hidden = P.hiddenHost:CreateTexture()
	end
	local shown, hidden, blocking = P.shown, P.hidden, P.blocking
	step("A1_shown_cancel_133975", function() local s = shown:SetTexture(133975); shown:SetTexture(nil); return s end)
	step("A2_twice_133888", function() shown:SetTexture(133888); shown:SetTexture(nil); local s = shown:SetTexture(133888); shown:SetTexture(nil); return s end)
	step("A3_hidden_cancel_134120", function() local s = hidden:SetTexture(134120); hidden:SetTexture(nil); return s end)
	step("A4_missing_8999999", function() local s = shown:SetTexture(8999999); shown:SetTexture(nil); return s end)
	step("A5_blocking_134188", function() blocking:SetBlockingLoadsRequested(true); local s = blocking:SetTexture(134188); return s, blocking:IsBlockingLoadRequested() end)
	step("A6_keep_134336", function() return shown:SetTexture(134336) end)
	C_Timer.After(2, function()
		step("A7_reuse_after_complete_134336", function() shown:SetTexture(nil); local s = shown:SetTexture(134336); shown:SetTexture(nil); return s end)
	end)
	C_Timer.After(4, function()
		step("A8_cancel_burst_" .. P.CANCEL_BURST_FIRST, function()
			for i = 0, P.BURST_COUNT - 1 do
				shown:SetTexture(P.CANCEL_BURST_FIRST + i)
				shown:SetTexture(nil)
			end
			return P.BURST_COUNT
		end)
	end)
	C_Timer.After(6, function()
		step("A9_wait_burst_" .. P.WAIT_BURST_FIRST, function()
			blocking:SetBlockingLoadsRequested(true)
			for i = 0, P.BURST_COUNT - 1 do
				blocking:SetTexture(P.WAIT_BURST_FIRST + i)
			end
			blocking:SetTexture(nil)
			return P.BURST_COUNT
		end)
		done("asyncfile: " .. table.concat(out, " "))
	end)
end

function ClaudeWoW.Probe.Run(rest)
	local P = ClaudeWoW.Probe
	local which, arg = Trim(rest or ""):lower():match("^(%S*)%s*(.-)$")
	if which == "" then which = "all" end
	local function say(line) ClaudeWoW.Print("probe " .. line) end
	say("start " .. which .. " at " .. time())
	if which == "all" or which == "chatlog" then
		local ok, line = pcall(P.ChatLog, arg)
		say(ok and line or ("chatlog: error " .. tostring(line)))
	end
	if which == "all" or which == "asyncfile" then
		local ok, err = pcall(P.AsyncFile, say)
		if not ok then say("asyncfile: error " .. tostring(err)) end
	end
end

RunCommand = function(cmd, rest, ctx)
	local s = db.settings
	local c = ActiveChat()
	local quiet = type(ctx) == "table" and ctx.quiet == true
	local function Missing(module)
		if not quiet then print(ClaudeWoW.PREFIX .. "the " .. module .. " module did not load") end
	end
	if cmd == "" then
		ClaudeWoW.Toggle()
	elseif cmd == "hide" or cmd == "quit" or cmd == "mini" or cmd == "min" then
		ClaudeWoW.Toggle(false)
	elseif cmd == "new" then
		ClaudeWoW.NewChat(rest)
	elseif cmd == "chat" or cmd == "chats" then
		local n = tonumber(rest)
		local listed = Q.ListedChats()
		local target = n and listed[n]
		if not target and rest ~= "" then
			for _, ch in ipairs(listed) do
				if ch.name:lower() == rest:lower() then target = ch end
			end
		end
		if target then
			ClaudeWoW.SwitchChat(target.id)
		else
			local lines = {}
			for i, ch in ipairs(listed) do
				table.insert(lines, i .. ". " .. ch.name .. (ch.id == db.activeChat and "  (current)" or "") .. (ch.pendingId and "  working" or "") .. ((ch.unread or 0) > 0 and ("  " .. ch.unread .. " new") or ""))
			end
			AddHistory(c, "system", "Chats:\n" .. table.concat(lines, "\n"))
			ClaudeWoW.Render()
		end
		Cli.Show(ActiveChat())
	elseif cmd == "rename" then
		if rest ~= "" then
			c.name = rest:sub(1, 24)
			Whisper.Retitle(c)
			ClaudeWoW.Render()
		else
			ClaudeWoW.RenameActive()
		end
		Cli.Show(c)
	elseif cmd == "delete" then
		ClaudeWoW.DeleteChat()
	elseif cmd == "cd" then
		ClaudeWoW.SetFolder(rest, c)
		Cli.Show(c)
	elseif cmd == "map" then
		if ClaudeWoWMap then ClaudeWoWMap.Command(rest, ctx) else Missing("map") end
	elseif cmd == "roast" then
		if ClaudeWoWRoast then ClaudeWoWRoast.Command(rest, ctx) else Missing("roast") end
	elseif cmd == "voice" then
		if ClaudeWoWVoice then ClaudeWoWVoice.Command(rest, ctx) else Missing("voice") end
	elseif cmd == "achievements" or cmd == "toasts" then
		if ClaudeWoWAchievements then ClaudeWoWAchievements.Command(rest, ctx) else Missing("achievements") end
	elseif cmd == "orders" then
		if ClaudeWoWOrders then ClaudeWoWOrders.Command(rest, ctx) else Missing("orders") end
	elseif cmd == "telemetry" then
		if ClaudeWoWTelemetry then ClaudeWoWTelemetry.Command(rest, ctx) else Missing("telemetry") end
	elseif cmd == "ui" then
		Cli.Ui(c, rest)
	elseif cmd == "agent" then
		ClaudeWoW.SetAgent(rest, c)
		Cli.Show(c)
	elseif cmd == "plugin" then
		ClaudeWoW.SetPlugin(rest, c)
		Cli.Show(c)
	elseif cmd == "live" then
		ClaudeWoW.ShowResumePicker()
	elseif cmd == "reset" then
		c.resetNext = true
		local where = ChatFolder(c)
		Q.AddEvent(c, "Next message: new " .. ChatAgentName(c) .. " session" .. (where ~= "" and (" " .. SEG.DOT .. " " .. FolderName(where)) or ""))
		ClaudeWoW.Render()
		Cli.Show(c)
	elseif cmd == "context" or cmd == "ctx" then
		rest = rest:lower()
		local limit = ParseTokens(rest)
		if limit then
			-- The context-growth threshold. Chats now under it are re-armed.
			s.contextWarn = limit
			for _, ch in ipairs(db.chats) do
				if limit <= 0 or (ch.ctx or 0) < limit then ch.ctxWarned = nil end
			end
			AddHistory(c, "system", (limit > 0
				and ("Context warning at " .. FmtTokens(limit) .. " tokens: a chat that passes it says so once and offers a new chat.")
				or "Context warning off: chats grow quietly. The footer still shows ctx and turns.")
				.. "\n" .. ContextReport(c))
			ClaudeWoW.Render()
			Cli.Show(c)
			return
		end
		if rest == "on" or rest == "off" then
			s.context = rest == "on"
			-- Make sure the next record carries the change, hello throttle or not.
			run.contextSent = nil
			run.lastHelloAt = nil
			if ClaudeWoW.IsConnected() then ClaudeWoW.SayHello() end
		end
		local ctx = ClaudeWoW.GameContext()
		AddHistory(c, "system", (rest == "" and (ContextReport(c) .. "\n\n") or "") .. (s.context
			and "Game context is ON: the agent is told this with each message (it goes into its system prompt, so unrelated projects are unaffected by anything but a few lines). /claude config context off to stop.\n\n"
			or "Game context is OFF: the agent is told nothing about the game. /claude config context on to send this:\n\n") .. ctx
			.. "\n\nTip: click the input box, then shift-click an item, spell or quest to link it into your message; the agent gets its tooltip.")
		ClaudeWoW.Render()
		Cli.Show(c)
	elseif cmd == "mode" then
		if rest == "pixel" or rest == "reload" then
			s.mode = rest
			SyncScreenshotMode()
			AddHistory(c, "system", "mode set to " .. rest)
		else
			AddHistory(c, "system", "mode is " .. s.mode .. " (pixel or reload)")
		end
		ClaudeWoW.Render()
		Cli.Show(c)
	elseif cmd == "resend" then
		ClaudeWoW.Resend()
	elseif cmd == "auto" then
		local n = tonumber(rest)
		if n then
			s.interval = math.max(5, math.floor(n))
			s.autoRefresh = true
		elseif rest == "on" then
			s.autoRefresh = true
		elseif rest == "off" then
			s.autoRefresh = false
		end
		ClaudeWoW.UpdateStatus()
		ClaudeWoW.ArmAutoRefresh()
	elseif cmd == "macro" and rest == "undo" then
		ClaudeWoW.UndoMacro()
	elseif cmd == "copy" then
		for i = #c.history, 1, -1 do
			if c.history[i].role == "assistant" then
				ClaudeWoW.ShowCopy(c.history[i].text)
				break
			end
		end
	elseif cmd == "echo" then
		if rest == "summary" or rest == "full" or rest == "short" or rest == "off" then
			s.echo = rest
		elseif tonumber(rest) then
			s.echo = tostring(math.max(200, math.floor(tonumber(rest))))
		end
		if not quiet then AddHistory(c, "system", "replies in game chat: " .. s.echo .. " (summary = the agent's TL;DR lines, full = " .. ECHO.DEFAULT .. " chars, short, off, or a number of characters)") end
		ClaudeWoW.Render()
	elseif cmd == "longchat" then
		if rest == "on" then s.longchat = true elseif rest == "off" then s.longchat = false end
		ApplyLongChat()
		AddHistory(c, "system", "game chat box limit: " .. (s.longchat and "4000 characters (fine for /claude; real chat over 255 may be rejected by the server)" or "255 (default)"))
		ClaudeWoW.Render()
	elseif cmd == "roll" then
		if rest == "on" then s.lootRoll = true elseif rest == "off" then s.lootRoll = false end
		if s.lootRoll == false and ClaudeWoWRoll then ClaudeWoWRoll.CloseAll() end
		if not quiet then ClaudeWoW.Print("Ask with a roll window is " .. (ClaudeWoW.LootRollEnabled() and "on" or "off") .. ". " .. ClaudeWoW.ROLL_HELP) end
		ClaudeWoW.Render()
	elseif cmd == "minimap" then
		if rest == "on" then s.minimap = true elseif rest == "off" then s.minimap = false end
		Q.ApplyMinimapButton()
		if not quiet then ClaudeWoW.Print("minimap button: " .. (Q.MinimapButtonOn() and "on. Left-click opens or closes the window, right-click opens Options, drag it to move it." or "off. /claude config minimap on brings it back.")) end
	elseif cmd == "signal" then
		if rest == "on" then s.signal = true elseif rest == "off" then s.signal = false end
		AddHistory(c, "system", "signal check is " .. (s.signal and "on" or "off"))
		ClaudeWoW.Render()
	elseif cmd == "whisper" then
		Cli.SetWhisper(c, rest)
	elseif cmd == "vision" then
		if rest == "on" then s.vision = true elseif rest == "off" then s.vision = false end
		AddHistory(c, "system", VisionStatus() .. ". /claude config vision on|off; /claude look <question> sends one message with a picture whatever the setting.")
		ClaudeWoW.UpdateStatus()
		ClaudeWoW.Render()
		Cli.Show(c)
	elseif cmd == "look" then
		ClaudeWoW.Send(rest ~= "" and rest or "What do you see on my screen?", nil, { vision = true })
	elseif cmd == "slots" then
		local free = 0
		for i = 1, SLOT_COUNT do
			if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
		end
		AddHistory(c, "system", free .. " of " .. SLOT_COUNT .. " reply slots free this session (a reload frees all)")
		ClaudeWoW.Render()
		Cli.Show(c)
	elseif cmd == "refresh" or cmd == "reload" then
		SafeReload()
	elseif cmd == "bind" then
		AddHistory(c, "system", Q.BIND_MOVED)
		ClaudeWoW.Render()
		Cli.Show(c)
	elseif cmd == "probe" then
		ClaudeWoW.Probe.Run(rest)
	elseif cmd == "discord" then
		Cli.LinkDiscord(c)
	elseif cmd == "diag" then
		local free = 0
		for i = 1, SLOT_COUNT do
			if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
		end
		local lines = {
			"sound channel: " .. (signalAvailable and "usable" or "UNUSABLE") .. " (self-test: " .. tostring(signalStats.selftest) .. ", files: " .. Presence.root .. ")" .. (signalStats.error and (" error: " .. signalStats.error) or ""),
			"signal setting: " .. tostring(s.signal) .. ", marked unreliable this session: " .. tostring(run.signalUnreliable or false),
			"sound checks: " .. signalStats.checks .. ", valid hits: " .. signalStats.hits .. (signalStats.lastHit and (", last hit " .. FmtDur(GetTime() - signalStats.lastHit) .. " ago") or ""),
			"slot polls this session: " .. (run.polls or 0) .. ", free slots: " .. free .. "/" .. SLOT_COUNT,
			"signals: launch-time files, on = file deleted (a file created after the game started is never seen); bridge presence: " .. (run.bridgePresence and (string.format("ring %s at %d of %d", tostring(run.bridgePresence.ring), run.bridgePresence.at, tonumber(run.bridgePresence.n) or PRESENCE_MAX)) or "not heard yet"),
			"presence: " .. Presence.Scheme(),
			"presence self-test: " .. (run.presence and run.presence.test or "not run") .. ", late-created file: " .. (run.lateProbe and (run.lateProbe.result or "pending") or "not checked"),
			"presence: head at " .. (run.presence and string.format("a %d, b %d", run.presence.heads.a, run.presence.heads.b) or "?") .. ", beats seen: " .. tostring(run.presence and run.presence.beats or 0),
			select(5, ClaudeWoW.BridgeState()),
			"mode: " .. s.mode .. ", session token: " .. tostring(db.session),
			ClaudeWoW.Version.Status(),
			ClaudeWoW.Version.ClientsStatus(),
			Whisper.Status(),
			"transport: " .. tostring(s.transport or "pixel") .. (s.transport == "screenshot" and type(Screenshot) ~= "function" and " (Screenshot() missing: strip stays up, and the bridge is told to fall back to the pixel capture)" or "")
				.. (s.transport == "pixel" and s.transportNote and (" (bridge: " .. s.transportNote .. ")") or "")
				.. (s.transport == "screenshot" and s.stripLevels and string.format(", strip levels %d/%d", s.stripLevels.off, s.stripLevels.on) or "")
				.. (run.shotStats and string.format(", screenshots: %d taken, %d confirmed, %d failed, %d without event", run.shotStats.taken, run.shotStats.ok, run.shotStats.failed, run.shotStats.timeouts) or "")
				.. (run.shotsPaused and ", screenshots PAUSED (bridge not seen for " .. FmtDur(GetTime() - (run.bridgeSeen or run.startedAt or GetTime())) .. ")" or "")
				.. (s.shotFormatSaved and (", screenshotFormat saved: " .. s.shotFormatSaved) or ""),
			ClaudeWoW.ChatLog.Status(),
			"vision: " .. (s.vision and "on" or "off") .. (s.vision and s.transport ~= "screenshot" and " (needs the screenshot transport; the pixel capture never sees more than the strip)" or ""),
			"plugin: " .. ((c.plugin and c.plugin ~= "") and c.plugin or ("bridge default, " .. (run.bridgePlugin or "unknown until connected"))) .. " (bridge has: " .. PluginList() .. ")",
			"context: " .. ContextThresholdLabel(),
			"folder: " .. ((c.cwd and c.cwd ~= "") and c.cwd or ("bridge default, " .. (run.bridgeCwd or "unknown until connected")))
				.. ", agent: " .. ((c.agent and c.agent ~= "") and c.agent or ("bridge default, " .. (run.bridgeAgent or "unknown until connected"))),
			"status: " .. Q.StatusState(c) .. (c.pendingId and (", pending #" .. c.pendingId .. ", slot polls " .. (run.polls or 0)) or "")
				.. (run.slotsMissing and (", reply slots missing (" .. tostring(run.slotError or "MISSING") .. "; run install-slots.js, restart the game)") or "")
				.. (run.slotsExhausted and ", slot pool used up (a reload frees it)" or "")
				.. (run.pixelFailed and ", the bridge did not see the strip (the reload path has the message)" or ""),
		}
		for _, ch in ipairs(db.chats) do
			local a = run.act and run.act[ch.id]
			if ch.pendingId then
				table.insert(lines, ch.name .. ": pending #" .. ch.pendingId .. (a and (", heartbeat " .. (a.unreliable and "unreliable" or (a.count .. " beats"))) or ", no heartbeat state"))
			end
			local growth = ContextSegment(ch, true)
			local turns = TurnsLabel(ch)
			if growth ~= "" or turns ~= "" then
				table.insert(lines, ch.name .. ": " .. growth .. ((growth ~= "" and turns ~= "") and ", " or "") .. turns .. (ch.ctxWarned and " (warned)" or ""))
			end
		end
		-- Cost of the addon itself. Memory is always available; CPU needs
		-- scriptProfile, which only takes effect after a restart.
		if UpdateAddOnMemoryUsage then
			UpdateAddOnMemoryUsage()
			local kb = GetAddOnMemoryUsage and GetAddOnMemoryUsage("ClaudeWoW") or 0
			local line = string.format("addon memory: %.1f MB", kb / 1024)
			if UpdateAddOnCPUUsage and GetAddOnCPUUsage then
				UpdateAddOnCPUUsage()
				local ms = GetAddOnCPUUsage("ClaudeWoW")
				local total = 0
				for i = 1, (C_AddOns and C_AddOns.GetNumAddOns and C_AddOns.GetNumAddOns() or 0) do
					total = total + (GetAddOnCPUUsage(i) or 0)
				end
				if ms and ms > 0 then
					line = line .. string.format("; cpu %.0f ms%s", ms,
						total > 0 and string.format(" (%.0f%% of all addons)", ms / total * 100) or "")
				else
					line = line .. "; cpu profiling off (/console scriptProfile 1, then restart WoW)"
				end
			end
			lines[#lines + 1] = line
		end
		local report = "Diagnostics:\n" .. table.concat(lines, "\n")
		AddHistory(c, "system", report)
		ClaudeWoW.Render()
		Cli.Show(c)
		if rest:lower() == "copy" then ClaudeWoW.ShowCopy(report) end
	elseif cmd == "cancel" then
		ClaudeWoW.Cancel(c)
	elseif cmd == "dev" or cmd == "wrong" or cmd == "bug" then
		Cli.DevCommand(c, cmd, rest)
	elseif cmd == "mcp" then
		Cli.McpCommand(c, rest)
	elseif cmd == "errors" then
		Cli.Say(c, ClaudeWoWDev and ClaudeWoWDev.Report() or "Dev.lua is not loaded. Restart the game client once to load new addon files.")
	elseif cmd == "clear" then
		wipe(c.history)
		ClaudeWoW.Render()
	elseif cmd == "help" then
		ClaudeWoW.ShowHelp()
	end
end

---------------------------------------------------------------------------
-- Events
---------------------------------------------------------------------------

local ev = CreateFrame("Frame")
ev:RegisterEvent("ADDON_LOADED")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("PLAYER_REGEN_ENABLED")
ev:RegisterEvent("UPDATE_MACROS")
ev:RegisterEvent("SCREENSHOT_SUCCEEDED")
ev:RegisterEvent("SCREENSHOT_FAILED")
ev:RegisterEvent("PLAYER_LOGOUT")
ev:RegisterEvent("PLAYER_ENTERING_WORLD")
ev:SetScript("OnEvent", function(self, event, arg1)
	if event == "PLAYER_ENTERING_WORLD" then
		if db then Q.NoteLogin(arg1) end
	elseif event == "ADDON_LOADED" then
		if arg1 == ADDON_NAME then
			InitDB()
			-- The saved data is here: a screenshotFormat left behind by a crash
			-- (no PLAYER_LOGOUT, no restore) goes back to the player's value now,
			-- unless the remembered transport is about to need ours again.
			SyncScreenshotMode()
		end
	elseif event == "SCREENSHOT_SUCCEEDED" then
		ScreenshotDone(true, true)
	elseif event == "SCREENSHOT_FAILED" then
		ScreenshotDone(false, true)
	elseif event == "PLAYER_LOGOUT" then
		-- The player's screenshot format goes back before the client saves its CVars.
		if db then
			ScreenshotCVarsOff()
			ClaudeWoWCharDB = Q.StashCharacterChats(db, ClaudeWoWCharDB)
		end
	elseif event == "PLAYER_LOGIN" then
		if not db then InitDB() end
		BuildUI()
		Q.BuildMinimapButton()
		run = { outbound = {}, startedAt = GetTime() }
		Q.RestoreRequests()
		SelfTestSignals()
		ProcessInbox()
		SyncScreenshotMode()
		if AnyPending() then
			-- Still waiting after a reload: resume polling with a fresh slot pool.
			run.sentAt = GetTime()
			run.polls = 0
			run.act = {}
			for _, ch in ipairs(db.chats) do
				if ch.pendingId then run.act[ch.id] = Q.ActivityAtLogin(ch) end
			end
			ScheduleNextPoll()
		end
		local c = ActiveChat()
		if c and c.draft and c.draft ~= "" then
			ui.input:SetText(c.draft)
			if not c.pendingId then c.draft = nil end
		end
		ClaudeWoW.Render()
		InstallChatHooks()
		Whisper.Install()
		if db.settings.shown and Whisper.Active() then
			db.settings.shown = false
		elseif db.settings.shown then
			ClaudeWoW.Toggle(true)
		end
		ClaudeWoW.ArmAutoRefresh()
		ClaudeWoW.UpdateDot()
		if db.settings.longchat then ApplyLongChat() end
		C_Timer.NewTicker(TICK_SECONDS, Tick)
		C_Timer.NewTicker(WL.PULSE_SECONDS, Whisper.Pulse)
		Q.LoginNotice()
		C_Timer.After(3, function()
			ClaudeWoW.SayHello()
			C_Timer.After(Q.BRIDGE_CHECK_SECONDS, Q.UnreachableNotice)
		end)
	elseif event == "UPDATE_MACROS" then
		-- "Create" / "Update" on the macro buttons follows what exists now.
		if ui.frame and ui.frame:IsShown() then ClaudeWoW.Render() end
	elseif event == "PLAYER_REGEN_ENABLED" then
		Q.AfterCombat()
	end
end)
