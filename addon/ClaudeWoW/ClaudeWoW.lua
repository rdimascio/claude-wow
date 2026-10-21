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

local _, ns = ...
if not ns.Try then
	print("|cff66ccff[Azeroth Companion]|r New addon files are not loaded yet. Type /reload; if that does not help, fully quit and restart the game.")
	return
end
ns.files[#ns.files + 1] = "ClaudeWoW.lua"
local ClaudeWoW = ns.ClaudeWoW
_G.BINDING_NAME_CLAUDEWOW_WORKSPACE = "Azeroth Companion: open or close the workspace"
ClaudeWoW.PRODUCT = ns.PRODUCT
ClaudeWoW.PREFIX = ns.PREFIX

local ui = ns.ui
ClaudeWoW.UI = ui
local run = ns.run
local Whisper = ns.Whisper
local Cli = ns.Cli

local Q = ns.Q

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

local Display = ns.Display

local Trim = ns.Trim

local Link = ns.Link
ClaudeWoW.Link = Link

local FmtDur = ns.FmtDur

local SEG = ns.SEG

local Contains = ns.Contains
local HasUserMessage = ns.HasUserMessage

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
ns.AutoTitle = AutoTitle

local FindChat = ns.FindChat

local ActiveChat = ns.ActiveChat

local AddChat = ns.AddChat

local AddHistory = ns.AddHistory

function ClaudeWoW.ApplyMirror(list)
	if type(list) ~= "table" then return end
	local changed = false
	for _, e in ipairs(list) do
		local c = type(e) == "table" and type(e.chat) == "string" and FindChat(e.chat) or nil
		if not c and type(e) == "table" and e.room == true and type(e.chat) == "string" and e.chat:match("^r%x+$") and not ns.db.forget[e.chat] then
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
			if ns.db.activeChat ~= c.id then c.unread = (c.unread or 0) + 1 end
			changed = true
		end
	end
	if changed then ClaudeWoW.Render() end
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
ns.ActivityLine = ActivityLine

Cli.STEPS_SHOWN = 10

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
	for i = first, #lines do
		table.insert(out, SEG.DOT .. " " .. lines[i])
	end
	return out, lines[#lines]
end

local Try = ns.Try

local ForgetOnBridge = ns.ForgetOnBridge

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
	ns.db.activeChat = c.id
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
	for k, v in pairs(fields or {}) do
		c[k] = v
	end
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

-- Delete a chat (the active one when no id is given). The last chat is cleared
-- and renamed instead of removed, so there is always one to type into. Either
-- way the bridge is told to forget it, so a restore won't bring it back.
function ClaudeWoW.DeleteChat(id)
	local c, idx = nil, nil
	if id then
		c, idx = FindChat(id)
	end
	if not c then
		c, idx = ActiveChat()
	end
	if not c then return end
	ForgetOnBridge(c)
	Whisper.Close(c)
	local otherUserChats = 0
	for _, ch in ipairs(ns.db.chats) do
		if ch ~= c and not ch.quiet then otherUserChats = otherUserChats + 1 end
	end
	if #ns.db.chats == 1 or (otherUserChats == 0 and not c.quiet) then
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
	table.remove(ns.db.chats, idx)
	local heldReply = run.replyTarget and run.replyNames and run.replyNames[run.replyTarget:lower()] == c.id
	if run.lastReplyChat == c.id then run.lastReplyChat = nil end
	if ns.db.activeChat == c.id then
		ClaudeWoW.SwitchChat(Cli.LatestChat().id)
	else
		ClaudeWoW.RenderChatList()
	end
	if heldReply then Whisper.OfferReply(Cli.LatestChat()) end
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

local function MacroSay(msg) ClaudeWoW.Print(msg) end

-- Only well-formed entries survive (the slot file is trusted, but not blindly).
function ClaudeWoW.CleanMacros(list)
	if type(list) ~= "table" then return nil end
	local out = {}
	for _, m in ipairs(list) do
		if type(m) == "table" and type(m.name) == "string" and m.name ~= "" and type(m.body) == "string" and m.body ~= "" then
			out[#out + 1] = {
				name = m.name,
				body = m.body,
				char = m.char == true,
				risky = m.risky == true,
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
		if index and oldBody ~= m.body then
			table.insert(why, 'It replaces your existing macro "' .. m.name .. '" (/claude config macro undo brings the old one back).')
		end
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
		if ok and type(newIndex) == "number" then ns.db.macroUndo = { name = m.name, char = m.char, icon = oldIcon, body = oldBody } end
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
		if ok and type(newIndex) == "number" then ns.db.macroUndo = { name = m.name, char = m.char, created = true } end
	end
	if not ok or type(newIndex) ~= "number" then
		MacroSay('could not save macro "' .. m.name .. '": ' .. (ok and "the game refused it (is the list full?)" or tostring(newIndex)))
		return
	end
	-- EditMacro may move the macro (names are sorted): pick up the index it returned.
	Try(PickupMacro, newIndex)
	MacroSay(
		'macro "' .. m.name .. '" ' .. (index and "updated" or "created") .. " and on your cursor: click an action bar slot to place it (it is also in /macro)."
	)
	ClaudeWoW.Render()
end

function ClaudeWoW.MacroPrompt(m)
	if type(m) ~= "table" then return end
	if InCombatLockdown() then
		MacroSay("macros can't be changed in combat; click the link again afterwards.")
		return
	end
	local index, _, oldBody = FindMacro(m.name, m.char)
	local lines = {
		(index and "Update" or "Create")
			.. ' the macro "'
			.. Display(m.name)
			.. '"'
			.. (m.char and " (this character only)" or "")
			.. "? It lands on your cursor: click an action bar slot to place it.",
	}
	if m.risky then table.insert(lines, "This macro runs code or clicks buttons (/run, /script, /click). Only keep it if you trust what it does.") end
	if index and oldBody ~= m.body then
		table.insert(lines, 'It replaces your existing macro "' .. Display(m.name) .. '" (/claude config macro undo brings the old one back).')
	end
	table.insert(lines, Display(m.body))
	Q.ShowMacroPopup(table.concat(lines, "\n\n"), m, index)
end

function ClaudeWoW.UndoMacro()
	local u = ns.db.macroUndo
	if not u then
		MacroSay("nothing to undo.")
		return
	end
	if InCombatLockdown() then
		MacroSay("macros can't be changed in combat.")
		return
	end
	local index = FindMacro(u.name, u.char)
	if not index then
		MacroSay('macro "' .. u.name .. '" is gone already.')
		ns.db.macroUndo = nil
		return
	end
	if MacroFrame and MacroFrame:IsShown() then
		Try(HideUIPanel, MacroFrame)
		index = FindMacro(u.name, u.char)
	end
	if u.created then
		Try(DeleteMacro, index)
		MacroSay('removed macro "' .. u.name .. '".')
	else
		Try(EditMacro, index, u.name, u.icon, u.body)
		MacroSay('macro "' .. u.name .. '" is back to what it was.')
	end
	ns.db.macroUndo = nil
	ClaudeWoW.Render()
end

---------------------------------------------------------------------------
-- Rendering
---------------------------------------------------------------------------

function Cli.Split(s)
	local out = {}
	for part in (tostring(s or "") .. ":"):gmatch("([^:]*):") do
		table.insert(out, part)
	end
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

function Cli.Links.resume(arg) ClaudeWoW.ResumePick(tonumber(arg)) end

function Cli.Links.open(arg) ClaudeWoW.OpenWorkspace(Cli.Split(arg)[1]) end

function Cli.Links.reply(arg)
	local id = Cli.Split(arg)[1]
	if Whisper.Active() then
		if FindChat(id) and ns.db.activeChat ~= id then ClaudeWoW.SwitchChat(id) end
		return
	end
	ClaudeWoW.OpenWorkspace(id, true)
end

function Cli.Links.connect() ClaudeWoW.Connect(true) end

function Cli.Links.cancel(arg) ClaudeWoW.Cancel(FindChat(Cli.Split(arg)[1])) end

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
	if choice ~= "pass" and Q.GrantGate(c.id, msgId) then return end
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
	if not ns.db then return false end
	link = tostring(link or "")
	local body = link:match("^addon:claudewow:(.*)$") or link:match("^claudewow:(.*)$")
	if not body then return false end
	local action, arg = body:match("^(%a+):?(.*)$")
	local fn = action and Cli.Links[action]
	if not fn then return false end
	fn(arg or "", button)
	return true
end

hooksecurefunc("SetItemRef", function(link, _, button) ClaudeWoW.OnLink(link, button) end)

-- Shift-clicking an item, spell, quest or name puts its link into the chat box
-- being typed in. Blizzard's insert function only knows its own boxes, so when
-- ours has the keyboard, take the link too. With no box focused the shift-click
-- keeps its normal meaning (splitting a stack, for one).
--
-- On this client (modern UI code, Blizzard_ChatFrameUtil) every shift-click
-- ends in ChatFrameUtil.InsertLink; ChatEdit_InsertLink is the older global
-- name, hooked only where the new one is missing so one click inserts once.
local function TakeLink(text)
	if text and text ~= "" and ui.input and ui.input:HasFocus() then ui.input:Insert(text) end
end
if type(ChatFrameUtil) == "table" and type(ChatFrameUtil.InsertLink) == "function" then
	hooksecurefunc(ChatFrameUtil, "InsertLink", TakeLink)
elseif type(ChatEdit_InsertLink) == "function" then
	hooksecurefunc("ChatEdit_InsertLink", TakeLink)
end

---------------------------------------------------------------------------
-- Slash commands
---------------------------------------------------------------------------

Cli.DEV_PLUGIN = "dev"
Cli.DEV_ERRORS_MARK = "\n--- addon errors ---\n"
Cli.DEV_ATTACH_MAX = 1400

function Cli.DevCommand(c, cmd, rest)
	if not c then return end
	local devVerb, devArg = rest:match("^%s*(%S+)%s*(.-)%s*$")
	if cmd == "dev" and devVerb and devVerb:lower() == "globals" then
		Cli.Say(
			c,
			ClaudeWoWWidgets and ClaudeWoWWidgets.GlobalsCommand(devArg) or "Widgets.lua is not loaded. Restart the game client once to load new addon files."
		)
		return
	end
	if c.pendingId then
		Cli.Say(c, "This chat is still waiting on a reply. Run the dev command when it is back, or in another chat.")
		return
	end
	if not (run.bridgePlugins and Contains(run.bridgePlugins, Cli.DEV_PLUGIN)) then
		Cli.Say(
			c,
			"The bridge has not said it has dev tools: it is older than this addon, or it has not answered since you logged in. Update it (claude-wow update), send any message, then try again."
		)
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
ns.events = ev
