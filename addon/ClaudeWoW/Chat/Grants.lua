local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Chat\\Grants.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Q, Cli, Whisper = ns.run, ns.Q, ns.Cli, ns.Whisper
local LIVE_PLUGIN, LIVE_PASS_TEXT = ns.LIVE_PLUGIN, ns.LIVE_PASS_TEXT
local Display = ns.Display
local FindChat = ns.FindChat

local function AllowAlways(chatId, rules)
	local c = FindChat(chatId)
	if not c or c.pendingId or not rules or #rules == 0 then return end
	if ns.db.activeChat ~= c.id then ClaudeWoW.SwitchChat(c.id) end
	for _, m in ipairs(c.history) do
		m.denied = nil
	end
	local commands, dirs = ClaudeWoW.SplitGrants(rules)
	local full = Cli.AddChatDirs(c, dirs)
	local text = "Allowed: " .. ClaudeWoW.GrantsLabel(rules)
	if #dirs > 0 then text = text .. ". Extra folders for this chat: " .. Cli.DirsLabel(c) end
	if #full > 0 then
		text = text .. ". No room for " .. table.concat(full, ", ") .. " (at most " .. Cli.ADD_DIRS_MAX .. " folders), so it is added for this retry only"
	end
	Cli.Out(c, text)
	Q.EndPromptWait(c)
	ClaudeWoW.Send("Those actions are allowed now. Continue from where you left off.", commands, { onceDirs = full })
end

function ClaudeWoW.AllowOnce(chatId, rules)
	local c = FindChat(chatId)
	if not c or c.pendingId or not rules or #rules == 0 then return end
	if ns.db.activeChat ~= c.id then ClaudeWoW.SwitchChat(c.id) end
	for _, m in ipairs(c.history) do
		m.denied = nil
	end
	local commands, dirs = ClaudeWoW.SplitGrants(rules)
	Cli.Out(c, "Allowed for this retry only: " .. ClaudeWoW.GrantsLabel(rules))
	Q.EndPromptWait(c)
	ClaudeWoW.Send("Those actions are allowed for this run. Continue from where you left off.", commands, { allowForThisRunOnly = true, onceDirs = dirs })
end

function ClaudeWoW.PassOnDenial(chatId, rules, reason)
	local c = FindChat(chatId)
	if not c or not rules or #rules == 0 then return end
	for _, m in ipairs(c.history) do
		m.denied = nil
	end
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
	local name = ns.ReplyAgentName(c, agent)
	if name == ns.AgentName("") then return "this agent" end
	return Display(name)
end

function Q.GrantTarget(c) return ns.ChatAgent(c), Cli.ChatPlugin(c) end

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
		for _, rule in ipairs(rules or {}) do
			table.insert(lines, Display(ClaudeWoW.GrantLabel(rule)))
		end
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

function ClaudeWoW.SayAboutDenial(chatId, text) Q.SayAboutDenial(FindChat(chatId), text) end

function Q.GrantHeld() return ClaudeWoWRoll ~= nil and (ClaudeWoWRoll.Held() or ClaudeWoWRoll.Blocked() ~= nil) end

Q.GRANT_DELAY = 0.5
ClaudeWoW.TOO_SOON_TEXT = "Click again in a moment."

function Q.OpenDenialEntry(chatId)
	local c = FindChat(chatId)
	if not c or c.pendingId then return nil end
	return c.history[Q.DenialIndex(c) or 0]
end

function Q.StampDenial(chatId, keep)
	local entry = Q.OpenDenialEntry(chatId)
	if not entry then return nil end
	run.denialSeen = run.denialSeen or setmetatable({}, { __mode = "k" })
	if not (keep and run.denialSeen[entry]) then run.denialSeen[entry] = GetTime() end
	return run.denialSeen[entry]
end

function ClaudeWoW.NoteDenialDrawn(chatId) Q.StampDenial(chatId, true) end

function ClaudeWoW.GrantReady(chatId)
	local seenAt = Q.StampDenial(chatId, true) or GetTime()
	if GetTime() - seenAt < Q.GRANT_DELAY then return false end
	return not (ClaudeWoWRoll and ClaudeWoWRoll.Settling())
end

function Q.GrantGate(chatId, msgId)
	if Q.GrantHeld() then
		ClaudeWoWRoll.HoldGrant(chatId, msgId)
		return "held"
	end
	if not ClaudeWoW.GrantReady(chatId) then
		Q.SayAboutDenial(FindChat(chatId), ClaudeWoW.TOO_SOON_TEXT)
		return "soon"
	end
	return nil
end

function ClaudeWoW.ConfirmOpen() return run.allowConfirm ~= nil end

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
	local refused = Q.GrantGate(data.chatId, data.msgId)
	if refused then
		if refused == "soon" and ClaudeWoWRoll then ClaudeWoWRoll.Resume(data.chatId, data.msgId) end
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
	local live = ClaudeWoW.IsLiveChat(c)
	if not live and ClaudeWoW.AllowPending(chatId, msgId) then return true end
	if Q.GrantGate(chatId, msgId) then return false end
	if live then
		ClaudeWoW.AllowOnce(chatId, open)
		return true
	end
	local previous = run.allowConfirm
	if previous then
		run.allowConfirm = nil
		if ClaudeWoWRoll then ClaudeWoWRoll.Requeue(previous.chatId, previous.msgId) end
	end
	local copied = {}
	for i, rule in ipairs(open) do
		copied[i] = rule
	end
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

function Q.HasDenial(m) return type(m) == "table" and type(m.denied) == "table" and #m.denied > 0 end

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
	if latest then return latest.denied, latest.id, latest.agent end
	return nil
end

function ClaudeWoW.LootRollEnabled() return ns.db ~= nil and ns.db.settings.lootRoll ~= false and ClaudeWoWRoll ~= nil end
