local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Transport\\ChatLog.lua"

local ClaudeWoW = ns.ClaudeWoW
local run = ns.run
local FmtDur = ns.FmtDur
local TellPlayer = ns.TellPlayer
local Codec = ClaudeWoW_Codec

ClaudeWoW.ChatLog =
	{ MISSES_BEFORE_PAUSE = 2, RETRY_SECONDS = 8, SLOW_RETRY_SECONDS = 15, ACK_POLL_SECONDS = 4, FIRST_PAUSE_SECONDS = 600, MAX_PAUSE_SECONDS = 3600 }

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
	return ns.db ~= nil
		and ns.db.settings.mode == "pixel"
		and ns.db.settings.transport == "screenshot"
		and type(ns.db.settings.chatlog) == "table"
		and type(ns.db.settings.chatlog.key) == "string"
		and not ClaudeWoW.ChatLog.Paused()
		and type(SendSystemMessage) == "function"
		and type(LoggingChat) == "function"
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
	local spec = ns.db and ns.db.settings.chatlog
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
	local spec = ns.db.settings.chatlog
	local ok, err = pcall(function()
		if not LoggingChat() then LoggingChat(true) end
		ClaudeWoW.ChatLog.InstallFilter()
		local lines = Codec.LogLines(id, payload, spec.line, spec.filler, spec.key)
		for i = 1, #lines do
			SendSystemMessage(lines[i])
		end
		run.chatlogStats = run.chatlogStats or { frames = 0, lines = 0, acked = 0, late = 0, gs = 0 }
		if kind == "gs" then
			run.chatlogStats.gs = run.chatlogStats.gs + 1
		else
			run.chatlogStats.frames = run.chatlogStats.frames + 1
		end
		run.chatlogStats.lines = run.chatlogStats.lines + #lines
	end)
	if not ok then ClaudeWoW.ChatLog.Pause("error: " .. tostring(err)) end
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
			TellPlayer(
				"the companion app did not read the chat log in time. Messages go out by screenshot; the chat log is tried again in " .. FmtDur(wait) .. "."
			)
		end
	end
end

function ClaudeWoW.ChatLog.Status()
	local s = ns.db.settings
	if type(s.chatlog) ~= "table" then return "chat log transport: off (the bridge did not ask for it)" end
	local stats = run.chatlogStats
	local pause = run.chatlogPause
	local state = ClaudeWoW.ChatLog.Mode() and (pause and "on trial after a pause" or "on") or "unavailable in this client"
	if ClaudeWoW.ChatLog.Paused() then
		state = "PAUSED, next try in " .. FmtDur(pause.wait - (GetTime() - pause.at)) .. " (" .. tostring(pause.reason) .. ")"
	end
	return string.format(
		"chat log transport: %s, lines of %d, filler %d bytes%s%s",
		state,
		s.chatlog.line,
		s.chatlog.filler,
		s.chatlog.show and ", lines shown in chat" or "",
		stats
				and string.format(
					"; %d frames, %d lines written, %d acknowledged first time, %d only after the screenshot retry, %d game state frames",
					stats.frames,
					stats.lines,
					stats.acked,
					stats.late,
					stats.gs
				)
			or ""
	)
end
