local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Whisper\\Intercept.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Whisper = ns.run, ns.Whisper
local Try, Trim, Display = ns.Try, ns.Trim, ns.Display
local FindChat, ActiveChat = ns.FindChat, ns.ActiveChat
local WL, WhisperOn, WhisperOwns = ns.WL, ns.WhisperOn, ns.WhisperOwns

-- The chat behind an agent's name typed as a whisper target: the active chat
-- when it talks to that agent, else the one that last replied, else the first.
local function WhisperAgentChat(target)
	target = tostring(target or ""):lower()
	if target == "" then return nil end
	local best
	for _, c in ipairs(ns.db.chats) do
		if not c.quiet and ns.ChatAgentName(c):lower() == target then
			if c.id == ns.db.activeChat then return c end
			if c.id == run.lastReplyChat or not best then best = c end
		end
	end
	return best
end

function Whisper.ReplyName(chat)
	local label = Trim(Display(chat.name))
	if label == "" then label = tostring(chat.id) end
	return ns.ChatAgentName(chat) .. " [" .. label .. "]"
end

local function ReplyNameChat(target)
	target = tostring(target or ""):lower()
	if target == "" or not ns.db then return nil end
	local offered = run.replyNames and run.replyNames[target]
	if offered then return FindChat(offered) or FindChat(run.lastReplyChat) or ActiveChat() end
	local best
	for _, c in ipairs(ns.db.chats) do
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
	if not Whisper.PreSendHooked() or not setLastTell then return false end
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
	local frame = type(FCFDock_GetSelectedWindow) == "function" and type(GENERAL_CHAT_DOCK) == "table" and Try(FCFDock_GetSelectedWindow, GENERAL_CHAT_DOCK)
		or SELECTED_DOCK_FRAME
		or SELECTED_CHAT_FRAME
	local chat = type(frame) == "table" and frame.claudewowChatId and FindChat(frame.claudewowChatId)
	if not chat or not run.whisperTabs or run.whisperTabs[chat.id] ~= frame then return nil end
	local target = tostring(eb:GetAttribute("tellTarget") or ""):lower()
	if target ~= ns.ChatAgentName(chat):lower() and ReplyNameChat(target) ~= chat then return nil end
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
	if ns.db.activeChat ~= chat.id then ClaudeWoW.SwitchChat(chat.id) end
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
	if not ns.db then return false end
	local name = WhisperNotFoundName(msg)
	if not name then return false end
	name = name:lower()
	local ours = ReplyNameChat(name) ~= nil or (run.replyTarget and run.replyTarget:lower() == name)
	if not ours and not WhisperOn() then return false end
	ours = ours or name == WL.PROBE_NAME:lower()
	for _, c in ipairs(ns.db.chats) do
		if ns.ChatAgentName(c):lower() == name then ours = true end
	end
	for _, n in pairs(ns.AGENT_NAMES) do
		if n:lower() == name then ours = true end
	end
	if not ours then return false end
	run.whisperLeaks = (run.whisperLeaks or 0) + 1
	run.whisperLastLeak = msg
	return false,
		"|cffff4040["
			.. ClaudeWoW.PRODUCT
			.. "] WHISPER LEAK: "
			.. tostring(msg)
			.. " - a send reached the server. Type /claude diag and report what it shows.|r",
		...
end

local whisperInstalled = false

function Whisper.Install()
	if whisperInstalled then return end
	whisperInstalled = true
	run.whisperLayers = { Whisper.PreSendHooked() and WL.PRE_SEND_EVENT or ("no " .. WL.PRE_SEND_EVENT) }
	if type(ChatFrame_AddMessageEventFilter) == "function" then
		pcall(ChatFrame_AddMessageEventFilter, "CHAT_MSG_SYSTEM", WhisperLeakFilter)
		table.insert(run.whisperLayers, "leak filter")
	end
end

function Whisper.Status()
	local tabs = 0
	for _, c in ipairs(ns.db.chats) do
		if WhisperOwns(c, run.whisperTabs and run.whisperTabs[c.id]) then tabs = tabs + 1 end
	end
	return "whisper tabs: "
		.. (WhisperOn() and "on" or "off")
		.. ", "
		.. tabs
		.. " open, send hook: "
		.. (Whisper.PreSendHooked() and "pre-send" or "MISSING")
		.. ", sends swallowed: "
		.. (run.whisperSwallowed or 0)
		.. ", LEAKS: "
		.. (run.whisperLeaks or 0)
		.. (run.whisperError and (", last open error: " .. run.whisperError) or "")
		.. ", /r: "
		.. (run.replyTarget or "the game's last whisper")
end

local function OnPreSendText(_, eb)
	if not ns.db or type(eb) ~= "table" then return end
	Whisper.Intercept(eb, "pre-send")
end

local function InstallChatHooks() Whisper.HookPreSend(OnPreSendText) end
ns.InstallChatHooks = InstallChatHooks
