local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Chat\\Send.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q, Cli, Whisper = ns.run, ns.ui, ns.Q, ns.Cli, ns.Whisper
local Codec = ClaudeWoW_Codec
local ToHex, Trim, US = ns.ToHex, ns.Trim, ns.US
local FindChat, ActiveChat, AnyPending, AddHistory, HasUserMessage = ns.FindChat, ns.ActiveChat, ns.AnyPending, ns.AddHistory, ns.HasUserMessage
local Presence, SafeReload, NoScreenshot, ShotsPaused, RefreshStrip = ns.Presence, ns.SafeReload, ns.NoScreenshot, ns.ShotsPaused, ns.RefreshStrip
local NoteStaleSignals, StartActivity, ScheduleNextPoll, TryLoadSlot = ns.NoteStaleSignals, ns.StartActivity, ns.ScheduleNextPoll, ns.TryLoadSlot
local ContextToSend = ns.ContextToSend

---------------------------------------------------------------------------
-- Sending
---------------------------------------------------------------------------

-- allow: optional list of permission rules to grant before this message runs.

function Q.SayStillWaiting(c)
	run.waitSaid = run.waitSaid or {}
	if c.quiet or run.waitSaid[c.id] == c.pendingId then return end
	run.waitSaid[c.id] = c.pendingId
	Cli.Out(c, ns.ChatAgentName(c) .. " is still working. What you type now waits as a draft and is offered again when the reply lands. Click Stop to cancel.")
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
		if ns.db.settings.mode == "pixel" and not (run.slotsExhausted or run.slotsMissing) then
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
		if
			not (
				Whisper.Active()
				and Whisper.System(c, "Not connected to the companion app yet; connecting now. Your message goes out as soon as it answers.", true)
			)
		then
			ClaudeWoW.Toggle(true)
		end
		return
	end
	-- Shift-clicked links become [Name] plus their tooltip, which is what the agent can read.
	local links
	text, links = ClaudeWoW.ExpandLinks(text)
	local limit = Codec.MAX_PAYLOAD - 300 - #Cli.McpToken(c)
	if #text > limit then
		Cli.Out(
			c,
			"That message is too long for one send ("
				.. #text
				.. " chars, max ~"
				.. limit
				.. "). Split it up."
				.. (links > 0 and " Each linked item adds its tooltip to the message." or "")
		)
		return
	end
	-- The game context rides along when the bridge doesn't have this version yet.
	local ctx = ContextToSend(limit - #text)

	ns.db.lastSeq = ns.db.lastSeq + 1
	local id = ns.db.lastSeq
	local tokens = {}
	local plugin = Cli.ChatPlugin(c)
	local verbatim = opts and opts.verbatim
	if c.resetNext and not verbatim then table.insert(tokens, "n") end
	if c.agent and c.agent ~= "" then table.insert(tokens, "agent=" .. c.agent) end
	if plugin ~= "" then table.insert(tokens, "plugin=" .. plugin) end
	if ns.db.settings.vision or (opts and opts.vision) then table.insert(tokens, "v") end
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
	for _, t in ipairs(optionTokens) do
		table.insert(tokens, t)
	end
	local flags = table.concat(tokens, ";")
	local outboxTokens = { "ver=" .. ClaudeWoW.Version.Own(), "proto=" .. ClaudeWoW.Version.PROTO, Q.CharacterFlag() }
	for _, t in ipairs(optionTokens) do
		table.insert(outboxTokens, t)
	end
	local newSession = (c.resetNext and not verbatim) and true or nil
	if not verbatim then c.resetNext = nil end
	ns.db.outbox = {
		id = id,
		session = ns.db.session,
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
			c.name = ns.AutoTitle(text) or c.name
			c.titleFor = id
		end
		if not Whisper.Sent(c, text) then ns.db.settings.shown = true end
		if ClaudeWoWVoice then ClaudeWoWVoice.Event("sent") end
	end

	if ns.db.settings.mode == "pixel" then
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
	if ns.db.settings.mode ~= "pixel" then return end
	for _, rec in pairs(run.outbound) do
		if rec.forget == chatId and not rec.acked then return end
	end
	local info = ns.db.forget[chatId] or {}
	ns.db.lastSeq = ns.db.lastSeq + 1
	run.outbound[ns.db.lastSeq] = { chat = chatId, cwd = info.cwd or "", flags = "d", name = info.name or "", text = "", sentAt = GetTime(), forget = chatId }
	NoteStaleSignals(ns.db.lastSeq)
	RefreshStrip()
end

local function SendCancel(chat, id)
	if ns.db.settings.mode ~= "pixel" or not id or not run.bridgeCancel then return end
	ns.db.lastSeq = ns.db.lastSeq + 1
	run.outbound[ns.db.lastSeq] =
		{ chat = chat.id, cwd = chat.cwd or "", flags = "cancel=" .. id, name = chat.name or "", text = "", sentAt = GetTime(), cancelOf = id }
	NoteStaleSignals(ns.db.lastSeq)
	RefreshStrip()
end

Q.DM_NEXT_GAP_SECONDS = 5
Q.INBOX_FRESH_SECONDS = 300

function ClaudeWoW.SendDmNext(charKey)
	if not ns.db or ns.db.settings.mode ~= "pixel" then return "reload" end
	if not run.bridgeDm then return "unsupported" end
	if type(charKey) ~= "string" or charKey == "" then return "nochar" end
	local now = GetTime()
	for _, rec in pairs(run.outbound) do
		if rec.dm and not rec.acked then return "busy" end
	end
	if run.dmSentAt and now - run.dmSentAt < Q.DM_NEXT_GAP_SECONDS then return "busy" end
	run.dmSentAt = now
	ns.db.lastSeq = ns.db.lastSeq + 1
	run.outbound[ns.db.lastSeq] = { chat = "", cwd = "", flags = "kind=dm", name = charKey, text = "next", sentAt = now, dm = true }
	NoteStaleSignals(ns.db.lastSeq)
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
	if not w or type(acks) ~= "table" or not ns.db then return end
	for _, a in ipairs(acks) do
		if type(a) == "table" and a.session == ns.db.session and a.id == w.id and (a.open == "ok" or a.open == "refused") then
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
	for _, c in ipairs(ns.db.chats) do
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
	if not ns.db or ns.db.settings.mode ~= "pixel" then return "reload" end
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
	ns.db.lastSeq = ns.db.lastSeq + 1
	run.outbound[ns.db.lastSeq] = { chat = c.id, cwd = "", flags = "kind=url", name = "", text = url, sentAt = now, clickedAt = now, openUrl = true }
	run.openWait = { id = ns.db.lastSeq, url = url, at = now, step = 1 }
	NoteStaleSignals(ns.db.lastSeq)
	RefreshStrip()
	return "sent"
end

local function ForgetOnBridge(c)
	if not c or not c.id then return end
	ns.db.forget[c.id] = { name = c.name, cwd = c.cwd }
	SendForget(c.id)
end

-- Hello: a record with no text that just announces our session token. The bridge
-- acks it, offers a restore if our saved data is fresh, and refreshes the slots,
-- so the status light and any lost chats come back before the first message.
-- The game context always rides on it (empty when turned off), so the bridge's
-- copy is brought in line at every login and Connect.
function ClaudeWoW.SayHello()
	if ns.db.settings.mode ~= "pixel" then return end
	local now = GetTime()
	if run.lastHelloAt and now - run.lastHelloAt < 60 then return end
	run.lastHelloAt = now
	ns.db.lastSeq = ns.db.lastSeq + 1
	local c = ActiveChat()
	local ctx = ns.db.settings.context and ClaudeWoW.GameContext() or ""
	local flags = "h;ver=" .. ClaudeWoW.Version.Own() .. ";proto=" .. ClaudeWoW.Version.PROTO
	if Q.CharacterFlag() then flags = flags .. ";" .. Q.CharacterFlag() end
	if Presence.Channel() and not (run.lateProbe and run.lateProbe.result) then
		run.lateProbe = run.lateProbe or { token = string.format("%06x%04x", time() % 16777216, math.floor(now * 1000) % 65536) }
		flags = flags .. ";probe=" .. run.lateProbe.token
	end
	run.outbound[ns.db.lastSeq] =
		{ chat = c and c.id or "", cwd = c and c.cwd or "", flags = flags, name = c and c.name or "", text = "", ctx = ctx, sentAt = now, hello = true }
	NoteStaleSignals(ns.db.lastSeq)
	run.helloPollAt = now + 5
	-- Deletions the bridge never confirmed ride along with the hello.
	for id in pairs(ns.db.forget) do
		SendForget(id)
	end
	-- Fresh saved data: show "restoring" instead of an empty panel until we hear back.
	if not ClaudeWoWCharDB.restored then
		local empty = true
		for _, ch in ipairs(ns.db.chats) do
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
	if ns.db.settings.vision then table.insert(tokens, "v") end -- a resend is a fresh screenshot
	for _, t in ipairs(Cli.ChatOptionTokens(c)) do
		table.insert(tokens, t)
	end
	if c.titleFor == c.pendingId then table.insert(tokens, "t") end
	run.outbound[c.pendingId] =
		{ chat = c.id, cwd = c.cwd, flags = table.concat(tokens, ";"), name = c.name, text = text, sentAt = GetTime(), request = c.pendingId }
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
		Cli.Out(
			c,
			"Nothing to cancel: "
				.. c.name
				.. " is not waiting for a reply. "
				.. (
					#waiting > 0 and ("Waiting: " .. table.concat(waiting, ", ") .. ". Pick one with /claude chat <number>, then /claude cancel.")
					or "No chat is waiting."
				)
		)
	end
	ClaudeWoW.Render()
end
ns.ForgetOnBridge = ForgetOnBridge
