local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Transport\\Screenshot.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q, Whisper = ns.run, ns.ui, ns.Q, ns.Whisper
local FmtDur = ns.FmtDur
local ActiveChat, AddHistory = ns.ActiveChat, ns.AddHistory
local EnsureStrip, HideStrip, ShowStrip, RecordFor, RS = ns.EnsureStrip, ns.HideStrip, ns.ShowStrip, ns.RecordFor, ns.RS
local Codec = ClaudeWoW_Codec

local SHOT_FRAMES = 2 -- screenshot transport: frames the strip is drawn before Screenshot() is called
local SHOT_TIMEOUT = 3 -- seconds to wait for SCREENSHOT_SUCCEEDED/FAILED before hiding the strip anyway
local SHOT_RETRIES = 3 -- failed screenshots per message before the normal 40 s retry takes over

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

local NoScreenshot -- below (Screenshot transport): the bridge wants shots this client cannot take
local function ScreenshotMode()
	return ns.db ~= nil and ns.db.settings.mode == "pixel" and ns.db.settings.transport == "screenshot" and type(Screenshot) == "function"
end

-- The bridge listens for screenshots, and this client cannot take one.
NoScreenshot = function() return ns.db ~= nil and ns.db.settings.transport == "screenshot" and type(Screenshot) ~= "function" end

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
	local s = ns.db.settings
	if not s.vision then return "Vision is OFF: the agent gets no picture of your screen" end
	if s.transport ~= "screenshot" then
		return 'Vision is ON, but the companion app listens on the pixel transport, which has no screenshot to send: set capture.mode to "screenshot" in its config.json and restart the companion app'
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
local function IsAddonFormat(v) return v == "png" or v == "tga" end

local function ScreenshotCVarsOn()
	if type(SetCVar) ~= "function" or type(GetCVar) ~= "function" then return end
	local cur = tostring(GetCVar("screenshotFormat") or "jpeg")
	local saved = ns.db.settings.shotFormatSaved
	-- Nothing on record: this is the player's value. Something on record and a
	-- current value that is neither it nor ours: the player changed it since
	-- (after a crash, say), and that is the setting to give back later.
	if saved == nil or (cur ~= saved and not IsAddonFormat(cur)) then ns.db.settings.shotFormatSaved = cur end
	if cur == "png" then return end
	local ok = pcall(SetCVar, "screenshotFormat", "png")
	if not ok or GetCVar("screenshotFormat") ~= "png" then pcall(SetCVar, "screenshotFormat", "tga") end
end

local function ScreenshotCVarsOff()
	local saved = ns.db.settings.shotFormatSaved
	if saved == nil then return end
	ns.db.settings.shotFormatSaved = nil
	if type(SetCVar) ~= "function" or type(GetCVar) ~= "function" then return end
	-- Still ours (png, or the tga fallback): put the player's back. Anything
	-- else the player set by hand in the meantime, and it stays.
	if IsAddonFormat(tostring(GetCVar("screenshotFormat") or "")) then pcall(SetCVar, "screenshotFormat", saved) end
end

local function SyncScreenshotMode()
	if ScreenshotMode() then
		ScreenshotCVarsOn()
	else
		ScreenshotCVarsOff()
	end
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
ns.ScreenshotMode, ns.NoScreenshot, ns.ShotStats, ns.VisionStatus = ScreenshotMode, NoScreenshot, ShotStats, VisionStatus
ns.ScreenshotCVarsOff, ns.SyncScreenshotMode, ns.TellPlayer = ScreenshotCVarsOff, SyncScreenshotMode, TellPlayer

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
	if ok == true then
		stats.ok = stats.ok + 1
	elseif ok == false then
		stats.failed = stats.failed + 1
	else
		stats.timeouts = stats.timeouts + 1
	end
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
					if ns.db.outbox and ns.db.outbox.id == id then ns.db.outbox.shot = "failed" end
					if not run.shotFailTold then
						run.shotFailTold = true
						TellPlayer(
							"the client reported SCREENSHOT_FAILED "
								.. SHOT_RETRIES
								.. " times for one message"
								.. (shot.err and (" (" .. shot.err .. ")") or "")
								.. '. The message waits for the usual retries and the reload fallback, which tell the companion app to switch to the pixel capture; set capture.mode to "pixel" in the companion app\'s config.json to skip the wait.'
						)
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
	if not ns.db or not ScreenshotMode() or run.shot then return end
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
			TellPlayer(
				"this client has no Screenshot() function, so the companion app's screenshot transport cannot work here. Messages wait for the reload fallback (a couple of minutes the first time), which tells the companion app to switch to the pixel capture; set capture.mode to \"pixel\" in the companion app's config.json to skip the wait."
			)
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
			TellPlayer(
				"Companion app not seen for "
					.. FmtDur(age)
					.. ": screenshots paused so they don't pile up with your own screenshots. Messages wait (the strip stays up, as in pixel mode) and shooting resumes when the companion app is back; the Connect button takes one by hand."
			)
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
	for _, rec in ipairs(included) do
		rec.shot = gen
	end
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
	ns.db.settings.transportNote = type(data.transportNote) == "string" and data.transportNote ~= "" and data.transportNote or nil
	local lv = StripLevels(data)
	local cur = ns.db.settings.stripLevels
	local sameLevels = (lv == nil and cur == nil) or (lv ~= nil and cur ~= nil and lv.on == cur.on and lv.off == cur.off and lv.codec == (cur.codec or 1))
	local logSpec = ClaudeWoW.ChatLog.Spec(data)
	if ns.db.settings.transport == t and sameLevels and ClaudeWoW.ChatLog.Same(logSpec, ns.db.settings.chatlog) then return end
	ns.db.settings.transport = t
	ns.db.settings.stripLevels = lv
	if not ClaudeWoW.ChatLog.Same(logSpec, ns.db.settings.chatlog) then ClaudeWoW.ChatLog.Resume() end
	ns.db.settings.chatlog = logSpec
	SyncScreenshotMode()
	-- Whatever is still unacknowledged goes out again the new way.
	for _, rec in pairs(run.outbound) do
		rec.shot = nil
	end
	RefreshStrip()
	ClaudeWoW.UpdateStatus()
end
ns.ScreenshotDone, ns.TakeScreenshot, ns.RefreshStrip, ns.ApplyTransport = ScreenshotDone, TakeScreenshot, RefreshStrip, ApplyTransport

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
	local _, staleFor = ns.PresenceWindows()
	return GetTime() - since >= staleFor
end
ns.ShotsPaused = ShotsPaused
