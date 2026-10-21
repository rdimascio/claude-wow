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

local DEFAULTS = {
	autoRefresh = true,
	signal = true,
	minimap = true,
	context = true,
	echo = "summary",
	mode = "pixel",
	vision = false,
	interval = 20,
	cwd = DEFAULT_CWD,
	width = 780,
	height = 500,
	dim = Cli.DIM_DEFAULT,
	dodge = true,
	autohide = true,
}
ns.DEFAULTS = DEFAULTS

local RUN_FIELDS = {
	ackPollAt = true,
	act = true,
	addonDisk = true,
	allowConfirm = true,
	bridgeAgent = true,
	bridgeAgents = true,
	bridgeCancel = true,
	bridgeClients = true,
	bridgeContract = true,
	bridgeCwd = true,
	bridgeDiscord = true,
	bridgeDm = true,
	bridgeEffortLock = true,
	bridgeEfforts = true,
	bridgeHome = true,
	bridgeLive = true,
	bridgeMcp = true,
	bridgeNow = true,
	bridgeOpenUrl = true,
	bridgePlugin = true,
	bridgePlugins = true,
	bridgePresence = true,
	bridgeProjectLabels = true,
	bridgeProjects = true,
	bridgeSeen = true,
	bridgeSessions = true,
	bridgeSkills = true,
	bridgeVersion = true,
	chatlogMisses = true,
	chatlogPause = true,
	chatlogStats = true,
	cmd = true,
	connKey = true,
	connectFailed = true,
	connectingAt = true,
	contextSent = true,
	denialSeen = true,
	dmPollAt = true,
	dmSentAt = true,
	helloPollAt = true,
	lastHelloAt = true,
	lastIdlePoll = true,
	lastNewsLoad = true,
	lastPresenceCheck = true,
	lastReplyChat = true,
	lateProbe = true,
	lateWait = true,
	loginChecked = true,
	news = true,
	newsPollAt = true,
	nextPollAt = true,
	noShotTold = true,
	openUrlAt = true,
	openWait = true,
	outbound = true,
	pixelFailed = true,
	polls = true,
	presence = true,
	quietShot = true,
	reloadAfterCombat = true,
	reloadArmed = true,
	reloadAsked = true,
	reloadDialogManual = true,
	reloadTold = true,
	renderKey = true,
	replay = true,
	replyNames = true,
	replyTarget = true,
	requests = true,
	restartTold = true,
	restoring = true,
	resumeList = true,
	runLimit = true,
	sendOnConnect = true,
	sentAt = true,
	shot = true,
	shotFailTold = true,
	shotGen = true,
	shotOverride = true,
	shotStats = true,
	shotsPaused = true,
	signalUnreliable = true,
	slotError = true,
	slotErrorTold = true,
	slotsExhausted = true,
	slotsMissing = true,
	staleShotGen = true,
	staleShotUntil = true,
	staleSig = true,
	startedAt = true,
	statusText = true,
	statusWorking = true,
	steps = true,
	stripShown = true,
	unreachableTold = true,
	updateReady = true,
	versionTold = true,
	versionVerdict = true,
	waitSaid = true,
	whisperBooted = true,
	whisperBridgeBad = true,
	whisperBridgeKey = true,
	whisperError = true,
	whisperFlash = true,
	whisperLastLeak = true,
	whisperLayer = true,
	whisperLayers = true,
	whisperLeaks = true,
	whisperProbe = true,
	whisperSentAt = true,
	whisperSwallowed = true,
	whisperTabs = true,
}
ns.RUN_FIELDS = RUN_FIELDS

function ns.Settings(key)
	local saved = ns.db
	return saved and saved.settings[key]
end

function ns.Setting(key, value)
	local saved = ns.db
	if not saved then return false end
	saved.settings[key] = value
	return true
end

local OR_KEYS = { echo = true, mode = true, interval = true, cwd = true, width = true, height = true }

local function ApplyDefaults(s)
	for key, value in pairs(DEFAULTS) do
		if s[key] == nil or (OR_KEYS[key] and s[key] == false) then s[key] = value end
	end
end

local function NewSession() return string.format("%x%04x%04x", time() % 0xFFFFFF, math.random(0, 0xFFFF), math.random(0, 0xFFFF)) end

local function LoadChats(data, s)
	data.lastSeq = data.lastSeq or 0
	data.forget = data.forget or {}
	if not data.session then data.session = NewSession() end
	if not data.chats then
		data.chats = {}
		local c = {
			id = NewId(),
			name = "Chat 1",
			cwd = s.cwd,
			history = data.history or {},
			pendingId = data.pendingId,
			unread = data.unread or 0,
			draft = data.draft,
			created = time(),
		}
		table.insert(data.chats, c)
		data.activeChat = c.id
		data.history, data.pendingId, data.unread, data.draft = nil, nil, nil, nil
	end
	ClaudeWoWCharDB = Q.LoadCharacterChats(data, ClaudeWoWCharDB)
	if #data.chats == 0 then AddChat() end
	if not FindChat(data.activeChat) then data.activeChat = data.chats[1].id end
	for _, c in ipairs(data.chats) do
		c.agent = c.agent or ""
		for _, m in ipairs(c.history or {}) do
			if m.role == "claude" then
				m.role, m.agent = "assistant", m.agent or "claude"
			end
		end
	end
end

local function BindPluginsOnce(data, _, fresh)
	if fresh then return end
	for _, c in ipairs(data.chats) do
		if not c.plugin or c.plugin == "" then c.plugin = "claude-code" end
	end
end

local function RepairChats(data)
	for _, c in ipairs(data.chats) do
		c.plugin = c.plugin or ""
	end
	ClaudeWoW.RepairQuietChats(data)
	if FindChat(data.activeChat).quiet then data.activeChat = AddChat().id end
end

local function KeepWhisperChoice(_, s, fresh)
	if not s.whisperChoice and not fresh and not s.whisperV2 and s.whisper == true then s.whisperChoice = "on" end
end

local function DeriveWhisper(_, s)
	s.whisperNews = nil
	s.whisper = s.whisperChoice == "on"
end

local MIGRATIONS = {
	{
		flag = "autoRefreshV2",
		run = function(_, s)
			if s.mode ~= "reload" then s.autoRefresh = false end
		end,
	},
	{
		flag = "miniBarV2",
		run = function(_, s)
			if s.minimized then s.shown = false end
			s.minimized = nil
			s.miniPoint, s.miniRelPoint, s.miniX, s.miniY = nil, nil, nil, nil
		end,
	},
	{
		flag = "contextWarnV2",
		run = function(_, s)
			if s.contextWarn == nil or s.contextWarn == Cli.CONTEXT_WARN_OLD then s.contextWarn = Cli.CONTEXT_WARN_DEFAULT end
		end,
	},
	{
		flag = "echoV2",
		run = function(_, s)
			if s.echo == "full" then s.echo = "summary" end
		end,
	},
	{ flag = "chatsPerCharacterV1", run = function(data) Q.ResetChats(data) end },
	{ name = "chats", run = LoadChats },
	{ flag = "pluginsV1", run = BindPluginsOnce },
	{ name = "repair", run = RepairChats },
	{ flag = "whisperV3", run = KeepWhisperChoice },
	{ name = "whisper", run = DeriveWhisper },
}
ns.MIGRATIONS = MIGRATIONS

local function RunMigration(m, data, s, fresh)
	if m.flag then
		if s[m.flag] then return end
		s[m.flag] = true
	end
	m.run(data, s, fresh)
end

local function Migration(key)
	for _, m in ipairs(MIGRATIONS) do
		if m.flag == key or m.name == key then return m end
	end
end

local function InitDB()
	local fresh = ClaudeWoWDB == nil or next(ClaudeWoWDB) == nil
	ClaudeWoWDB = ClaudeWoWDB or {}
	db = ClaudeWoWDB
	ns.db = db
	db.settings = db.settings or {}
	local s = db.settings
	ApplyDefaults(s)
	for _, m in ipairs(MIGRATIONS) do
		RunMigration(m, db, s, fresh)
	end
end
ns.InitDB = InitDB

function ClaudeWoW.MigrateWhisper(s, fresh)
	RunMigration(Migration("whisperV3"), db, s, fresh)
	RunMigration(Migration("whisper"), db, s, fresh)
end

local function AddHistory(chat, role, text, id, denied, agent, macros, summary)
	local kept = type(summary) == "string" and summary ~= "" and #summary <= Q.SUMMARY_STRIP_CHARS and summary or nil
	table.insert(chat.history, { role = role, text = text, id = id, t = time(), denied = denied, agent = agent, macros = macros, summary = kept })
	while #chat.history > MAX_HISTORY do
		table.remove(chat.history, 1)
	end
end
ns.AddHistory = AddHistory
