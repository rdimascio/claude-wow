local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Whisper\\Tabs.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Whisper = ns.run, ns.Whisper
local Display, Link = ns.Display, ns.Link
local FindChat, HasUserMessage = ns.FindChat, ns.HasUserMessage

---------------------------------------------------------------------------
-- Whisper tabs
---------------------------------------------------------------------------

local WL = {
	TEXT_MAX = 4000,
	PROBE_NAME = "Cwowprobe",
	PRE_SEND_EVENT = "ChatFrame.OnEditBoxPreSendText",
	SHORT_LINES = 8,
	SHORT_CHARS = 700,
	TLDR_LINES = 3,
	PREVIEW_LINES = 2,
	PROGRESS_MAX = 120,
	LINE_MAX = 300,
	THROTTLE_SECONDS = 20,
	ELAPSED_STEP = 5,
	PULSE_SECONDS = 1,
}
local preSendHooked = false
local whisperLive = setmetatable({}, { __mode = "k" })

local function WhisperOn() return ns.db ~= nil and ns.db.settings.whisper == true end

function Whisper.Active() return WhisperOn() and preSendHooked and type(FCF_OpenTemporaryWindow) == "function" end

local function WhisperColor(kind, r, g, b)
	local info = type(ChatTypeInfo) == "table" and ChatTypeInfo[kind]
	if type(info) == "table" and info.r then return info.r, info.g, info.b end
	return r, g, b
end

function Whisper.SystemColor() return WhisperColor("SYSTEM", 1, 1, 0) end

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
		for _, name in ipairs(CHAT_FRAMES) do
			add(_G[name])
		end
	end
	for i = 1, (NUM_CHAT_WINDOWS or 10) + 30 do
		add(_G["ChatFrame" .. i])
	end
	return list
end

local function WhisperAlive(frame) return frame ~= nil and frame.inUse ~= false and (frame.isDocked or frame:IsShown()) and true or false end

local function WhisperTab(frame) return frame.tab or _G[frame:GetName() .. "Tab"] end

local function WhisperBox(frame) return frame.editBox or _G[frame:GetName() .. "EditBox"] end

function Whisper.Title(chat)
	if tostring(chat.name or ""):match("^Chat %d+$") then return ns.ChatAgentName(chat) end
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

function Whisper.CanEdit(frame) return type(frame.RemoveMessagesByPredicate) == "function" end

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
	frame.claudewowTarget = frame.claudewowTarget or ns.ChatAgentName(chat)
	run.whisperTabs[chat.id] = frame
	Whisper.Retitle(chat)
	return frame
end

function Whisper.Welcome(chat, frame)
	local folder = ns.FolderName(ns.ChatFolder(chat))
	local where = folder ~= "" and (" in " .. Display(folder)) or ", general chat"
	local r, g, b = Whisper.SystemColor()
	WhisperWrite(frame, ns.ChatAgentName(chat) .. where .. ". Type to talk; " .. Link("open", chat.id, "workspace") .. " opens the full window.", r, g, b)
end

function Whisper.CompanionAlive() return ClaudeWoW.BridgeState() == "ok" and not run.pixelFailed end

function Whisper.MayOpen(chat) return chat ~= nil and Whisper.CompanionAlive() and HasUserMessage(chat) and ns.ChatAgent(chat) ~= "" end

function Whisper.FrameFor(chat, create, select)
	if not WhisperOn() or not chat then return nil end
	if not preSendHooked then
		run.whisperError = "this client has no " .. WL.PRE_SEND_EVENT .. " hook, so a tab could not keep its whispers off the server"
		return nil
	end
	run.whisperTabs = run.whisperTabs or {}
	local frame = run.whisperTabs[chat.id]
	local stale = frame and create and ns.ChatAgent(chat) ~= "" and tostring(frame.claudewowTarget or ""):lower() ~= ns.ChatAgentName(chat):lower()
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
			if WhisperOwns(chat, f) or (unclaimed and ns.ChatAgent(chat) ~= "" and type(name) == "string" and name:lower() == title) then
				return WhisperAdopt(chat, f)
			end
		end
	end
	if not create or type(FCF_OpenTemporaryWindow) ~= "function" or not Whisper.MayOpen(chat) then return nil end
	local ok, f = pcall(FCF_OpenTemporaryWindow, "WHISPER", ns.ChatAgentName(chat), DEFAULT_CHAT_FRAME, select and true or false)
	if not ok or type(f) ~= "table" then
		run.whisperError = tostring(f)
		return nil
	end
	f.claudewowTitle = nil
	f.claudewowTarget = ns.ChatAgentName(chat)
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

function Whisper.Close(chat)
	local frame = run.whisperTabs and run.whisperTabs[chat.id]
	if not frame then return end
	run.whisperTabs[chat.id] = nil
	frame.claudewowChatId = nil
	whisperLive[frame] = nil
	if type(FCF_Close) == "function" and WhisperAlive(frame) then pcall(FCF_Close, frame) end
end

function Whisper.CloseAll()
	for _, c in ipairs(ns.db.chats) do
		Whisper.Close(c)
	end
end
function Whisper.PreSendHooked() return preSendHooked end
ns.WL = WL
ns.WhisperOn, ns.WhisperColor, ns.WhisperFormat, ns.WhisperOwns, ns.WhisperWrite = WhisperOn, WhisperColor, WhisperFormat, WhisperOwns, WhisperWrite
