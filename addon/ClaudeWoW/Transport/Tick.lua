local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Transport\\Tick.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q = ns.run, ns.ui, ns.Q
local ActiveChat, AnyPending = ns.ActiveChat, ns.AnyPending
local Presence, IDLE_POLL_SECONDS, STRIP_SECONDS, STRIP_TRIES = ns.Presence, ns.IDLE_POLL_SECONDS, ns.STRIP_SECONDS, ns.STRIP_TRIES
local ScreenshotMode, ShotsPaused, TellPlayer, RefreshStrip = ns.ScreenshotMode, ns.ShotsPaused, ns.TellPlayer, ns.RefreshStrip
local PollPresence, PresenceWorks, CheckSignal, FreshSignal, PollActivity, NotedBridge =
	ns.PollPresence, ns.PresenceWorks, ns.CheckSignal, ns.FreshSignal, ns.PollActivity, ns.NotedBridge
local TryLoadSlot, PollLate, NoteAcked = ns.TryLoadSlot, ns.PollLate, ns.NoteAcked

---------------------------------------------------------------------------
-- Reload plumbing (fallback path)
---------------------------------------------------------------------------

Q.RELOAD_COMBAT_STATUS = "In combat. You can reload when combat ends."
Q.RELOAD_TEXT_REPLY = "Reload needed\n\nA reply is waiting. The game must reload its interface to read it."
Q.RELOAD_TEXT_AFTER_COMBAT = "Reload needed\n\nCombat is over. Reload the interface now to finish what you started."

local function SafeReload()
	if InCombatLockdown() then
		run.reloadAfterCombat = true
		run.reloadAsked = nil
		if ui.status then ui.status:SetText(Q.RELOAD_COMBAT_STATUS) end
		return
	end
	ReloadUI()
end

Q.RELOAD_POPUP = "CLAUDEWOW_RELOAD"

function Q.AskReload()
	StaticPopupDialogs[Q.RELOAD_POPUP].text = Q.ReplyReloadNeeded() and Q.RELOAD_TEXT_REPLY or Q.RELOAD_TEXT_AFTER_COMBAT
	if not StaticPopup_Show(Q.RELOAD_POPUP) then return false end
	run.reloadAsked = Q.PendingKey()
	run.reloadDialogManual = run.reloadAfterCombat == true
	run.reloadAfterCombat = nil
	return true
end

function Q.AfterCombat()
	if not ns.db then return end
	if run.reloadAfterCombat and Q.AskReload() then return end
	ClaudeWoW.ArmAutoRefresh()
end

StaticPopupDialogs[Q.RELOAD_POPUP] = {
	text = Q.RELOAD_TEXT_REPLY,
	button1 = "Reload",
	button2 = "Later",
	OnAccept = function() SafeReload() end,
	OnCancel = function() ClaudeWoW.ReloadLater() end,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	preferredIndex = 3,
}

function ClaudeWoW.DisarmReload()
	run.reloadArmed, run.reloadAsked = nil, nil
	if StaticPopup_Hide and not run.reloadDialogManual then StaticPopup_Hide(Q.RELOAD_POPUP) end
	if run.reloadAfterCombat and not InCombatLockdown() then ClaudeWoW.ArmAutoRefresh() end
end

function Q.PendingKey()
	local ids = {}
	for _, c in ipairs(ns.db.chats) do
		if c.pendingId then table.insert(ids, c.id .. ":" .. c.pendingId) end
	end
	return table.concat(ids, ",")
end

function Q.ReloadKey() return Q.PendingKey() .. (run.reloadAfterCombat and "|combat" or "") end

function Q.ReloadNeeded()
	if not ns.db then return false end
	return run.reloadAfterCombat == true or Q.ReplyReloadNeeded()
end

function Q.ReplyReloadNeeded()
	if not ns.db or not AnyPending() then return false end
	if ns.db.settings.mode ~= "pixel" then return true end
	return (run.slotsExhausted or run.slotsMissing or run.pixelFailed) and true or false
end

function ClaudeWoW.ArmAutoRefresh()
	if not Q.ReloadNeeded() then return end
	local key = Q.ReloadKey()
	if run.reloadAsked == key or run.reloadArmed == key then return end
	run.reloadArmed = key
	C_Timer.After(ns.db.settings.interval, function()
		if run.reloadArmed ~= key then return end
		run.reloadArmed = nil
		if not Q.ReloadNeeded() or InCombatLockdown() then return end
		if not Q.AskReload() then ClaudeWoW.ArmAutoRefresh() end
	end)
end

function ClaudeWoW.ReloadLater()
	if not ns.db.settings.autoRefresh then return end
	run.reloadAsked = nil
	ClaudeWoW.ArmAutoRefresh()
end
ns.SafeReload = SafeReload

local function Tick()
	if not ns.db then return end
	local now = GetTime()
	PollPresence()
	Q.GiveUpSilent()
	-- Without presence beats, the only evidence is a slot read; spend one every
	-- IDLE_POLL_SECONDS while idle so the light still reflects reality (and stays
	-- green while the bridge is up: BridgeState allows for this interval).
	if not PresenceWorks() and ns.db.settings.mode == "pixel" and not AnyPending() and now - (run.lastIdlePoll or -1e9) >= IDLE_POLL_SECONDS then
		run.lastIdlePoll = now
		TryLoadSlot("idle")
	elseif
		PresenceWorks()
		and ns.db.settings.mode == "pixel"
		and not AnyPending()
		and now - (run.presence.lastBeat or run.presence.testAt or now) > Presence.STALL_SECONDS
		and now - (run.lastPresenceCheck or -1e9) >= IDLE_POLL_SECONDS
	then
		run.lastPresenceCheck = now
		TryLoadSlot("presence")
	end
	ClaudeWoW.UpdateDot()
	ClaudeWoW.CheckConnection()
	-- The footer's elapsed time ticks while the window is open (a pending chat
	-- refreshes it below anyway).
	if ui.frame and ui.frame:IsShown() and not AnyPending() then
		local c = ActiveChat()
		if c and c.since then ClaudeWoW.UpdateStatus() end
	end
	if run.shotsPaused and not ShotsPaused(true) then
		-- Heard from the bridge again (a beat, an ack, a slot): shoot what waited.
		run.shotsPaused = nil
		TellPlayer("Companion app is back: screenshots resume")
		RefreshStrip()
	end
	if ns.db.settings.mode ~= "pixel" then return end
	local changed = false
	if Presence.PollNews(Presence.NEWS_MAX) and not run.newsPollAt then
		run.newsPollAt = math.max(now + 1, (run.lastNewsLoad or -1e9) + Presence.NEWS_GAP_SECONDS)
	end
	if run.newsPollAt and now >= run.newsPollAt then
		run.newsPollAt = nil
		if Presence.FreeSlots() > Presence.NEWS_SLOT_RESERVE then
			run.lastNewsLoad = now
			TryLoadSlot("news")
		end
	end
	if run.helloPollAt and now >= run.helloPollAt then
		run.helloPollAt = nil
		TryLoadSlot("hello")
		-- Whatever that slot held, the wait is over.
		if run.restoring then
			run.restoring = nil
			ClaudeWoW.Render()
		end
	end
	if run.ackPollAt and now >= run.ackPollAt then
		run.ackPollAt = nil
		if not ClaudeWoW.PresenceWorks() then TryLoadSlot("ack") end
	end
	if run.dmPollAt and now >= run.dmPollAt then
		run.dmPollAt = nil
		TryLoadSlot("dm")
	end
	Q.TickOpen(now)
	if run.restoring and now - run.restoring > 25 then
		run.restoring = nil
		ClaudeWoW.Render()
	end
	for id, rec in pairs(run.outbound) do
		if rec.staleAck and not CheckSignal("ack", id) then rec.staleAck = nil end
		if not rec.acked and not rec.staleAck and CheckSignal("ack", id) then
			NoteAcked(rec)
			changed = true
			NotedBridge()
			if (rec.text or "") ~= "" and not rec.openUrl and ClaudeWoWVoice then ClaudeWoWVoice.Started(id) end
			if rec.hello and run.lateProbe and not run.lateProbe.result then run.helloPollAt = now + 1 end
			if rec.dm and not (run.ackPollAt and not PresenceWorks()) then run.dmPollAt = now + 1 end
			if rec.openUrl then Q.OpenAcked(id, now) end
		end
		-- A hello only needs the bridge to have been seen; it never escalates.
		-- A forget is the same, but the bridge must have been seen a moment after
		-- the record went up, so it had a chance to read it. That holds for a strip
		-- that stays up; on the screenshot transport only the ack file says it was read.
		if
			(rec.hello or rec.forget)
			and not rec.acked
			and not ScreenshotMode()
			and run.bridgeSeen
			and run.bridgeSeen >= rec.sentAt + (rec.forget and 2 or 0)
		then
			NoteAcked(rec)
			changed = true
		end
		if rec.acked then
			if rec.forget then ns.db.forget[rec.forget] = nil end
			run.outbound[id] = nil
			changed = true
		elseif rec.openUrl then
			if now - (rec.clickedAt or rec.sentAt) >= Q.OPEN_URL_EXPIRE_SECONDS then
				run.outbound[id] = nil
				changed = true
			end
		elseif rec.shot == "log" and now - (rec.loggedAt or rec.sentAt) >= ClaudeWoW.ChatLog.RetrySeconds() then
			rec.tries = (rec.tries or 1) + 1
			rec.sentAt = now
			rec.shot = nil
			changed = true
		elseif rec.hello and now - rec.sentAt >= 20 then
			run.outbound[id] = nil
			changed = true
		elseif now - rec.sentAt >= STRIP_SECONDS then
			rec.tries = (rec.tries or 1) + 1
			if rec.tries <= STRIP_TRIES then
				-- Nobody picked it up: show it again (a new screenshot in that mode).
				rec.sentAt = now
				rec.shot = nil
				changed = true
			elseif rec.forget or rec.cancelOf or rec.dm then
				-- The bridge is away; ns.db.forget keeps it for the next hello.
				run.outbound[id] = nil
				changed = true
			else
				-- Give up on pixels for this message; the reload path still has it.
				run.outbound[id] = nil
				run.pixelFailed = true
				changed = true
				ClaudeWoW.ArmAutoRefresh()
			end
		end
	end
	if changed then
		RefreshStrip()
		ClaudeWoW.UpdateStatus()
	end
	if Q.LateSignal() then return end
	if not AnyPending() then
		PollLate(now)
		return
	end
	local moved = false
	for _, c in ipairs(ns.db.chats) do
		if c.pendingId and PollActivity(c) then moved = true end
	end
	if moved then ClaudeWoW.Render() end
	for _, c in ipairs(ns.db.chats) do
		if c.pendingId and run.staleSig and run.staleSig[c.pendingId] and not CheckSignal("sig", c.pendingId) then run.staleSig[c.pendingId] = nil end
		if c.pendingId and FreshSignal("sig", c.pendingId) then
			TryLoadSlot("signal")
			return
		end
	end
	if run.nextPollAt and now >= run.nextPollAt then TryLoadSlot("schedule") end
end
ns.Tick = Tick
