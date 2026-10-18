local ADDON_NAME, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Boot.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q, Whisper = ns.run, ns.ui, ns.Q, ns.Whisper
local ActiveChat, AnyPending, InitDB = ns.ActiveChat, ns.AnyPending, ns.InitDB
local BuildUI, SelfTestSignals, ProcessInbox, ScheduleNextPoll = ns.BuildUI, ns.SelfTestSignals, ns.ProcessInbox, ns.ScheduleNextPoll
local SyncScreenshotMode, ScreenshotCVarsOff, ScreenshotDone = ns.SyncScreenshotMode, ns.ScreenshotCVarsOff, ns.ScreenshotDone
local InstallChatHooks, ApplyLongChat, Tick, WL = ns.InstallChatHooks, ns.ApplyLongChat, ns.Tick, ns.WL
local TICK_SECONDS = 2

ns.events:SetScript("OnEvent", function(self, event, arg1)
	if event == "PLAYER_ENTERING_WORLD" then
		if ns.db then Q.NoteLogin(arg1) end
	elseif event == "ADDON_LOADED" then
		if arg1 == ADDON_NAME then
			InitDB()
			-- The saved data is here: a screenshotFormat left behind by a crash
			-- (no PLAYER_LOGOUT, no restore) goes back to the player's value now,
			-- unless the remembered transport is about to need ours again.
			SyncScreenshotMode()
		end
	elseif event == "SCREENSHOT_SUCCEEDED" then
		ScreenshotDone(true, true)
	elseif event == "SCREENSHOT_FAILED" then
		ScreenshotDone(false, true)
	elseif event == "PLAYER_LOGOUT" then
		-- The player's screenshot format goes back before the client saves its CVars.
		if ns.db then
			ScreenshotCVarsOff()
			ClaudeWoWCharDB = Q.StashCharacterChats(ns.db, ClaudeWoWCharDB)
		end
	elseif event == "PLAYER_LOGIN" then
		if not ns.db then InitDB() end
		BuildUI()
		Q.BuildMinimapButton()
		wipe(run)
		run.outbound = {}
		run.startedAt = GetTime()
		Q.RestoreRequests()
		SelfTestSignals()
		ProcessInbox()
		SyncScreenshotMode()
		if AnyPending() then
			-- Still waiting after a reload: resume polling with a fresh slot pool.
			run.sentAt = GetTime()
			run.polls = 0
			run.act = {}
			for _, ch in ipairs(ns.db.chats) do
				if ch.pendingId then run.act[ch.id] = Q.ActivityAtLogin(ch) end
			end
			ScheduleNextPoll()
		end
		local c = ActiveChat()
		if c and c.draft and c.draft ~= "" then
			ui.input:SetText(c.draft)
			if not c.pendingId then c.draft = nil end
		end
		ClaudeWoW.Render()
		InstallChatHooks()
		Whisper.Install()
		if ns.db.settings.shown and Whisper.Active() then
			ns.db.settings.shown = false
		elseif ns.db.settings.shown then
			ClaudeWoW.Toggle(true)
		end
		ClaudeWoW.ArmAutoRefresh()
		ClaudeWoW.UpdateDot()
		if ns.db.settings.longchat then ApplyLongChat() end
		C_Timer.NewTicker(TICK_SECONDS, Tick)
		C_Timer.NewTicker(WL.PULSE_SECONDS, Whisper.Pulse)
		Q.LoginNotice()
		C_Timer.After(3, function()
			ClaudeWoW.SayHello()
			C_Timer.After(Q.BRIDGE_CHECK_SECONDS, Q.UnreachableNotice)
		end)
	elseif event == "UPDATE_MACROS" then
		-- "Create" / "Update" on the macro buttons follows what exists now.
		if ui.frame and ui.frame:IsShown() then ClaudeWoW.Render() end
	elseif event == "PLAYER_REGEN_ENABLED" then
		Q.AfterCombat()
	end
end)
