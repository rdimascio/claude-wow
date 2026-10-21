local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Whisper\\Reply.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Q, Cli, Whisper = ns.run, ns.Q, ns.Cli, ns.Whisper
local Display, Link, Trim, Flat, FmtElapsed, SEG, LINK_PREFIX = ns.Display, ns.Link, ns.Trim, ns.Flat, ns.FmtElapsed, ns.SEG, ns.LINK_PREFIX
local ActiveChat, ConnectionKey = ns.ActiveChat, ns.ConnectionKey
local WL, WhisperWrite, WhisperColor, WhisperFormat = ns.WL, ns.WhisperWrite, ns.WhisperColor, ns.WhisperFormat

function Q.CutLine(line, width)
	local cut = line:sub(1, width)
	if line:sub(width + 1, width + 1):match("%S") then
		local whole = cut:gsub("%s+%S*$", "")
		if whole ~= cut then
			cut = whole
		else
			cut = cut:gsub("https?://%S*$", "")
		end
	end
	return cut:match("%S") and cut or line
end

function Q.CutText(text, max)
	if #text <= max then return text end
	local n = #Q.CutLine(text, max)
	if n > max then n = max end
	local nextByte = text:byte(n + 1)
	while n > 0 and nextByte and nextByte >= 128 and nextByte < 192 do
		n = n - 1
		nextByte = text:byte(n + 1)
	end
	return text:sub(1, n) .. "..."
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
	local mode = ns.db.settings.echo
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

function Whisper.MacroLinkLabel(m) return (ClaudeWoW.MacroLabel(m):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")) end

function Whisper.Reply(chat, text, agent, role, denied, summary, msgId, macros)
	local frame = Whisper.FrameFor(chat, true, false)
	if not frame then return false end
	if role ~= "system" and Q.WaitForLinks(Display(tostring(summary or "") .. "\n" .. tostring(text or "")), tostring(chat.id) .. ":" .. tostring(msgId)) then
		C_Timer.After(Q.LINK_RETRY_SECONDS, function() Whisper.Reply(chat, text, agent, role, denied, summary, msgId, macros) end)
		return true
	end
	Whisper.EndLive(frame, "progress")
	local who = ns.ReplyAgentName(chat, agent)
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
		for i, line in ipairs(lines) do
			WhisperWrite(frame, (i == 1 and prefix or "") .. Q.RichText(line), r, g, b)
		end
		if #lines == 0 then WhisperWrite(frame, prefix, r, g, b) end
		if cut then WhisperWrite(frame, "|cff888888" .. cut .. ":|r " .. Link("open", chat.id, "full reply"), r, g, b) end
		for k, m in ipairs(macros or {}) do
			WhisperWrite(
				frame,
				Link("macro", chat.id .. ":" .. tostring(msgId or 0) .. ":" .. k, Whisper.MacroLinkLabel(m), "ffd100")
					.. "  |cff888888click, then drop it on an action bar|r",
				sr,
				sg,
				sb
			)
		end
	end
	if denied then
		WhisperWrite(frame, who .. " needs permission for " .. Display(ClaudeWoW.GrantsLabel(denied)) .. ": " .. Whisper.RollLinks(chat, msgId), sr, sg, sb)
		Q.StampDenial(chat.id)
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
	local text = ns.ChatAgentName(chat) .. " is working... " .. table.concat(parts, " " .. SEG.DOT .. " ")
	local _, latest = Cli.StepLines(chat)
	local p = Trim(Flat(latest or ""))
	if p ~= "" then
		p = Q.CutText(p, WL.PROGRESS_MAX)
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
	local who = ns.ChatAgentName(chat)
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
	if not ns.db or not Whisper.Active() then return end
	local c = ActiveChat()
	if not run.whisperBooted and Whisper.MayOpen(c) then
		run.whisperBooted = true
		Whisper.FrameFor(c, true, false)
	end
	for _, ch in ipairs(ns.db.chats) do
		if ch.pendingId then Whisper.RefreshProgress(ch) end
	end
	Whisper.BridgeLine(c)
end
