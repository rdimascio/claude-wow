local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Commands\\Diag.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Q, Cli, Whisper = ns.run, ns.Q, ns.Cli, ns.Whisper
local Trim, FmtDur, AddHistory = ns.Trim, ns.FmtDur, ns.AddHistory
local SLOT_COUNT, PRESENCE_MAX, Presence, SlotName, signalStats = ns.SLOT_COUNT, ns.PRESENCE_MAX, ns.Presence, ns.SlotName, ns.signalStats
local ContextSegment, TurnsLabel, ContextThresholdLabel, PluginList = ns.ContextSegment, ns.TurnsLabel, ns.ContextThresholdLabel, ns.PluginList

ClaudeWoW.Probe = {
	TAG = "CWLOG",
	CANCEL_BURST_FIRST = 135000,
	WAIT_BURST_FIRST = 135100,
	BURST_COUNT = 48,
}

function ClaudeWoW.Probe.HideLine(_, _, msg) return type(msg) == "string" and msg:find("^CWLOG%d+ H ") ~= nil end

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
	step("A1_shown_cancel_133975", function()
		local s = shown:SetTexture(133975)
		shown:SetTexture(nil)
		return s
	end)
	step("A2_twice_133888", function()
		shown:SetTexture(133888)
		shown:SetTexture(nil)
		local s = shown:SetTexture(133888)
		shown:SetTexture(nil)
		return s
	end)
	step("A3_hidden_cancel_134120", function()
		local s = hidden:SetTexture(134120)
		hidden:SetTexture(nil)
		return s
	end)
	step("A4_missing_8999999", function()
		local s = shown:SetTexture(8999999)
		shown:SetTexture(nil)
		return s
	end)
	step("A5_blocking_134188", function()
		blocking:SetBlockingLoadsRequested(true)
		local s = blocking:SetTexture(134188)
		return s, blocking:IsBlockingLoadRequested()
	end)
	step("A6_keep_134336", function() return shown:SetTexture(134336) end)
	C_Timer.After(2, function()
		step("A7_reuse_after_complete_134336", function()
			shown:SetTexture(nil)
			local s = shown:SetTexture(134336)
			shown:SetTexture(nil)
			return s
		end)
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

function Cli.Slots(c)
	local free = 0
	for i = 1, SLOT_COUNT do
		if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
	end
	AddHistory(c, "system", free .. " of " .. SLOT_COUNT .. " reply slots free this session (a reload frees all)")
	ClaudeWoW.Render()
	Cli.Show(c)
end

function Cli.Diag(c, rest)
	local s = ns.db.settings
	local free = 0
	for i = 1, SLOT_COUNT do
		if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
	end
	local lines = {
		"sound channel: "
			.. (ns.SignalAvailable() and "usable" or "UNUSABLE")
			.. " (self-test: "
			.. tostring(signalStats.selftest)
			.. ", files: "
			.. Presence.root
			.. ")"
			.. (signalStats.error and (" error: " .. signalStats.error) or ""),
		"signal setting: " .. tostring(s.signal) .. ", marked unreliable this session: " .. tostring(run.signalUnreliable or false),
		"sound checks: " .. signalStats.checks .. ", valid hits: " .. signalStats.hits .. (signalStats.lastHit and (", last hit " .. FmtDur(
			GetTime() - signalStats.lastHit
		) .. " ago") or ""),
		"slot polls this session: " .. (run.polls or 0) .. ", free slots: " .. free .. "/" .. SLOT_COUNT,
		"signals: launch-time files, on = file deleted (a file created after the game started is never seen); bridge presence: "
			.. (
				run.bridgePresence
					and (string.format(
						"ring %s at %d of %d",
						tostring(run.bridgePresence.ring),
						run.bridgePresence.at,
						tonumber(run.bridgePresence.n) or PRESENCE_MAX
					))
				or "not heard yet"
			),
		"presence: " .. Presence.Scheme(),
		"presence self-test: "
			.. (run.presence and run.presence.test or "not run")
			.. ", late-created file: "
			.. (run.lateProbe and (run.lateProbe.result or "pending") or "not checked"),
		"presence: head at "
			.. (run.presence and string.format("a %d, b %d", run.presence.heads.a, run.presence.heads.b) or "?")
			.. ", beats seen: "
			.. tostring(run.presence and run.presence.beats or 0),
		select(5, ClaudeWoW.BridgeState()),
		"mode: " .. s.mode .. ", session token: " .. tostring(ns.db.session),
		ClaudeWoW.Version.Status(),
		ClaudeWoW.Version.ClientsStatus(),
		Whisper.Status(),
		"transport: "
			.. tostring(s.transport or "pixel")
			.. (s.transport == "screenshot" and type(Screenshot) ~= "function" and " (Screenshot() missing: strip stays up, and the bridge is told to fall back to the pixel capture)" or "")
			.. (s.transport == "pixel" and s.transportNote and (" (bridge: " .. s.transportNote .. ")") or "")
			.. (s.transport == "screenshot" and s.stripLevels and string.format(", strip levels %d/%d", s.stripLevels.off, s.stripLevels.on) or "")
			.. (run.shotStats and string.format(
				", screenshots: %d taken, %d confirmed, %d failed, %d without event",
				run.shotStats.taken,
				run.shotStats.ok,
				run.shotStats.failed,
				run.shotStats.timeouts
			) or "")
			.. (run.shotsPaused and ", screenshots PAUSED (bridge not seen for " .. FmtDur(GetTime() - (run.bridgeSeen or run.startedAt or GetTime())) .. ")" or "")
			.. (s.shotFormatSaved and (", screenshotFormat saved: " .. s.shotFormatSaved) or ""),
		ClaudeWoW.ChatLog.Status(),
		"vision: "
			.. (s.vision and "on" or "off")
			.. (s.vision and s.transport ~= "screenshot" and " (needs the screenshot transport; the pixel capture never sees more than the strip)" or ""),
		"plugin: "
			.. ((c.plugin and c.plugin ~= "") and c.plugin or ("bridge default, " .. (run.bridgePlugin or "unknown until connected")))
			.. " (bridge has: "
			.. PluginList()
			.. ")",
		"context: " .. ContextThresholdLabel(),
		"folder: "
			.. ((c.cwd and c.cwd ~= "") and c.cwd or ("bridge default, " .. (run.bridgeCwd or "unknown until connected")))
			.. ", agent: "
			.. ((c.agent and c.agent ~= "") and c.agent or ("bridge default, " .. (run.bridgeAgent or "unknown until connected"))),
		"status: "
			.. Q.StatusState(c)
			.. (c.pendingId and (", pending #" .. c.pendingId .. ", slot polls " .. (run.polls or 0)) or "")
			.. (run.slotsMissing and (", reply slots missing (" .. tostring(run.slotError or "MISSING") .. "; run install-slots.js, restart the game)") or "")
			.. (run.slotsExhausted and ", slot pool used up (a reload frees it)" or "")
			.. (run.pixelFailed and ", the bridge did not see the strip (the reload path has the message)" or ""),
	}
	for _, ch in ipairs(ns.db.chats) do
		local a = run.act and run.act[ch.id]
		if ch.pendingId then
			table.insert(
				lines,
				ch.name
					.. ": pending #"
					.. ch.pendingId
					.. (a and (", heartbeat " .. (a.unreliable and "unreliable" or (a.count .. " beats"))) or ", no heartbeat state")
			)
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
				line = line .. string.format("; cpu %.0f ms%s", ms, total > 0 and string.format(" (%.0f%% of all addons)", ms / total * 100) or "")
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
end
