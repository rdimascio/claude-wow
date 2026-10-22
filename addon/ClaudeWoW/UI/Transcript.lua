local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "UI\\Transcript.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q, Cli, Whisper = ns.run, ns.ui, ns.Q, ns.Cli, ns.Whisper
local Display, Try, Link, FmtDur, FmtTokens, SEG, Flat = ns.Display, ns.Try, ns.Link, ns.FmtDur, ns.FmtTokens, ns.SEG, ns.Flat
local ActiveChat, AddHistory, HasUserMessage = ns.ActiveChat, ns.AddHistory, ns.HasUserMessage
local STRIP_SECONDS = ns.STRIP_SECONDS
local ContextReport = ns.ContextReport
local ECHO = ns.ECHO

-- The assistant bubble is labelled with the agent that wrote it (see AgentName).

local ROLE_STYLE = {
	user = { label = "You", color = { 0.49, 0.78, 1.00 }, bg = { 0.25, 0.45, 0.75, 0.16 } },
	assistant = { label = "AI", color = { 1.00, 0.82, 0.25 }, bg = { 0.85, 0.70, 0.30, 0.10 } },
	system = { label = "System", color = { 0.62, 0.62, 0.62 }, bg = { 0.50, 0.50, 0.50, 0.10 } },
}

Q.PARCHMENT_STYLE = {
	user = { color = { 0.10, 0.22, 0.45 }, bg = { 0.10, 0.20, 0.40, 0.07 } },
	assistant = { color = { 0.45, 0.13, 0.02 }, bg = { 0, 0, 0, 0 } },
	system = { color = { 0.32, 0.25, 0.16 }, bg = { 0, 0, 0, 0 } },
}
Q.PARCHMENT_TEXT, Q.PARCHMENT_DIM = { 0.18, 0.12, 0.06 }, { 0.30, 0.22, 0.12 }

Q.BUBBLE_PAD = { left = 10, right = 8, top = 6, bottom = 8 }
Q.BUBBLE_WHO_GAP = 4
Q.BODY_FONT, Q.SPEAKER_FONT, Q.BODY_SPACING = "GameFontBlackMedium", "Fancy16Font", 2
Q.STEP_MAX_CHARS = 90
Q.STEPS_TITLE, Q.STEPS_HINT = "Steps so far", "Click the message to copy them."

Q.STATUS_READY = "Ready"
Q.STATUS_WORKING = "Working..."
Q.STATUS_REPLY = "Reply waiting"
Q.STATUS_UNREACHABLE = "Can't reach the companion app. Start it, then click Connect."
Q.STATUS_CONNECTING = "Connecting..."
Q.STATUS_NO_ANSWER = "No answer from the companion app. Is it running?"
Q.STATUS_RELOAD_HINT = "Click Reload to read it."
Q.RESEND_AFTER_SECONDS = STRIP_SECONDS
Q.RESEND_TIP = "The companion app has not picked up this message yet. Resend shows it to the app again."

function Q.StatusState(c)
	if c and c.pendingId then
		if ns.db.settings.mode == "pixel" and (run.slotsExhausted or run.slotsMissing or run.pixelFailed) then return "reply", Q.STATUS_RELOAD_HINT end
		local a = run.act and run.act[c.id]
		return "working", Q.ReplyReloadNeeded() and Q.STATUS_RELOAD_HINT or nil, (a and a.startedAt) or run.sentAt
	end
	if not ClaudeWoW.IsConnected() then
		local key = Q.ConnectionKey()
		if key == "connecting" then return "connecting", nil, run.connectingAt or run.startedAt end
		if key == "failed" then return "failed" end
		return "down"
	end
	if c and c.draft and c.draft ~= "" then return "reply" end
	if run.restoring then return "working", nil, run.restoring end
	return "ready"
end

function Q.ShouldShowResend(c)
	if not c or not c.pendingId or c.quiet or ns.db.settings.mode ~= "pixel" then return false end
	if c.progress or (run.steps and run.steps[c.id]) then return false end
	local a = run.act and run.act[c.id]
	if a and (a.count or 0) > 0 then return false end
	local r = Q.PendingRequest(c)
	if r and r.acked then return false end
	local since = (r and r.sentAt) or run.sentAt
	return since ~= nil and GetTime() - since >= Q.RESEND_AFTER_SECONDS
end

function Q.ResendVisible(c, mode) return (c and c.pendingId and mode == "pixel" and Q.ShouldShowResend(c)) and true or false end

function Q.ResendTooltip(button)
	GameTooltip:SetOwner(button, "ANCHOR_TOP")
	GameTooltip:SetText("Resend")
	GameTooltip:AddLine(Q.RESEND_TIP, 0.8, 0.8, 0.8, true)
	GameTooltip:Show()
end

function ClaudeWoW.UpdateStatus()
	if not ui.status then return end
	local c = ActiveChat()
	local mode = ns.db.settings.mode
	local state, hint = Q.StatusState(c)
	ui.status:SetText(Q.ShortStatus(c))
	run.statusText = hint
	run.statusWorking = state == "working" and hint == nil
	ClaudeWoW.UpdateDot()
	ClaudeWoW.UpdateConnect()
	if ui.title then
		local t = c and Display(Q.ShownName(c)) or Q.PANEL_TITLE
		if ui.chatTitle then
			t = Q.PANEL_TITLE
		else
			local folder = ns.FolderName(ns.ChatFolder(c))
			if folder ~= "" then t = t .. "  |cff888888" .. Display(folder) .. "|r" end
			if c and c.agent and c.agent ~= "" then t = t .. "  |cff888888" .. ns.AgentName(c.agent) .. "|r" end
		end
		ui.title:SetText(t)
	end
	if ui.chatTitle then ClaudeWoW.RefreshTitleBar() end
	if ui.resend then ui.resend:SetShown(Q.ResendVisible(c, mode)) end
	if ui.refresh then ui.refresh:SetShown(mode ~= "pixel" or run.slotsExhausted or run.slotsMissing or run.pixelFailed or false) end
	if ui.ctxBar then
		Q.UpdateContextBar(c)
		ui.ctxBar:ClearAllPoints()
		local beside = (ui.refresh:IsShown() and ui.refresh) or (ui.resend:IsShown() and ui.resend) or nil
		if beside then
			ui.ctxBar:SetPoint("RIGHT", beside, "LEFT", -Q.CTX_BAR_GAP, 0)
		else
			ui.ctxBar:SetPoint("RIGHT", ui.frame, "BOTTOMRIGHT", Q.CTX_BAR_RIGHT_X, Q.CTX_BAR_Y)
		end
	end
	Q.UpdateMinimapSignal()
end

local PICKER_ROW_HEIGHT = 20

local function GetPickerRow(b, k)
	local rb = b.rowBtns[k]
	if rb then return rb end
	rb = CreateFrame("Button", nil, b)
	rb:SetHeight(PICKER_ROW_HEIGHT - 2)
	rb.label = rb:CreateFontString(nil, "OVERLAY", "ChatFontNormal")
	rb.label:SetPoint("LEFT", rb, "LEFT", 4, 0)
	rb.label:SetPoint("RIGHT", rb, "RIGHT", -4, 0)
	rb.label:SetJustifyH("LEFT")
	rb.label:SetWordWrap(false)
	rb:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
	rb:SetScript("OnClick", function(self) ClaudeWoW.PickRow(self.row) end)
	b.rowBtns[k] = rb
	return rb
end

function Q.StepsTooltip(b)
	if not b.steps then return end
	GameTooltip:SetOwner(b, "ANCHOR_TOP")
	GameTooltip:SetText(Q.STEPS_TITLE)
	for _, line in ipairs(b.steps) do
		GameTooltip:AddLine(Display(line), 1, 1, 1, true)
	end
	GameTooltip:AddLine(Q.STEPS_HINT, 0.8, 0.8, 0.8, true)
	GameTooltip:Show()
	b.tipShown = true
end

function Q.WorkingLine(c)
	local head = "Working " .. SEG.DOT .. " " .. ns.ActivityLine(c)
	local steps, latest = Cli.StepLines(c)
	if latest then
		local step = Flat(latest)
		step = Q.CutText(step, Q.STEP_MAX_CHARS)
		head = head .. " - " .. step
	end
	if run.statusText and run.statusText ~= "" and not run.statusWorking then head = head .. "\n" .. run.statusText end
	return head, steps
end

-- One message bubble: accent bar, colored label, timestamp, wrapped body.
local function GetBubble(i)
	local b = ui.bubbles[i]
	if b then return b end
	b = CreateFrame("Frame", nil, ui.content)
	if b.SetHyperlinksEnabled then
		pcall(b.SetHyperlinksEnabled, b, true)
		b:SetScript("OnHyperlinkClick", Q.LinkClick)
		b:SetScript("OnHyperlinkEnter", Q.LinkEnter)
		b:SetScript("OnHyperlinkLeave", function() GameTooltip:Hide() end)
	end
	local onParchment = ui.parchment ~= nil
	b.pad = Q.BUBBLE_PAD
	b.bodySpacing = onParchment and Q.BODY_SPACING or nil
	b.bg = b:CreateTexture(nil, "BACKGROUND")
	b.bg:SetAllPoints()
	b.accent = b:CreateTexture(nil, "BORDER")
	b.accent:SetPoint("TOPLEFT", b, "TOPLEFT", 0, 0)
	b.accent:SetPoint("BOTTOMLEFT", b, "BOTTOMLEFT", 0, 0)
	b.accent:SetWidth(3)
	if onParchment then b.accent:Hide() end
	b.who = b:CreateFontString(
		nil,
		"OVERLAY",
		onParchment and Q.FontObject(Q.SPEAKER_FONT, Q.FontObject("QuestTitleFont", Q.FontObject("QuestFontNormalSmall", "GameFontNormalSmall")))
			or "GameFontNormalSmall"
	)
	b.who:SetPoint("TOPLEFT", b, "TOPLEFT", b.pad.left, -b.pad.top)
	b.who:SetJustifyH("LEFT")
	b.when = b:CreateFontString(nil, "OVERLAY", onParchment and Q.FontObject("QuestFontNormalSmall", "GameFontDisableSmall") or "GameFontDisableSmall")
	b.when:SetPoint("TOPRIGHT", b, "TOPRIGHT", -b.pad.right, -b.pad.top)
	b.bodyFont = onParchment and Q.FontObject(Q.BODY_FONT, Q.FontObject("QuestFont", "ChatFontNormal")) or "ChatFontNormal"
	b.noteFont = onParchment and Q.FontObject("QuestFontNormalSmall", "GameFontNormalSmall") or "GameFontDisableSmall"
	b.body = b:CreateFontString(nil, "OVERLAY", b.bodyFont)
	b.body:SetPoint("TOPLEFT", b.who, "BOTTOMLEFT", 0, -Q.BUBBLE_WHO_GAP)
	b.body:SetJustifyH("LEFT")
	b.body:SetJustifyV("TOP")
	b.body:SetWordWrap(true)
	b.body:SetNonSpaceWrap(true)
	b.ruleL = b:CreateTexture(nil, "ARTWORK")
	b.ruleL:SetHeight(1)
	b.ruleL:Hide()
	b.ruleR = b:CreateTexture(nil, "ARTWORK")
	b.ruleR:SetHeight(1)
	b.ruleR:Hide()
	b.allow = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
	b.allow:SetHeight(22)
	b.allow:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6)
	b.allow:SetScript("OnClick", function(self) ClaudeWoW.ConfirmAllow(self.chatId, self.msgId, self.rules) end)
	b.allow:Hide()
	-- The New chat button on a context warning: exactly what bare /claude does.
	b.fresh = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
	b.fresh:SetHeight(22)
	b.fresh:SetText("New Chat")
	b.fresh:SetScript("OnClick", function() ClaudeWoW.NewChat() end)
	b.fresh:Hide()
	b.macroBtns = {}
	b.rowBtns = {}
	-- FontStrings can't be selected, so a click opens the message in the copy box.
	b:EnableMouse(true)
	b:SetScript("OnEnter", Q.StepsTooltip)
	b:SetScript("OnLeave", function(self)
		if self.tipShown then GameTooltip:Hide() end
		self.tipShown = nil
	end)
	b:SetScript("OnMouseUp", function(self, button)
		if button ~= "LeftButton" or not self.text or self.text == "" then return end
		local clickedAt = GetTime()
		C_Timer.After(0, function()
			if self.linkClickAt ~= clickedAt then ClaudeWoW.ShowCopy(self.text) end
		end)
	end)
	ui.bubbles[i] = b
	return b
end

function Q.HeaderButton(host, name, rightOf, onClick, onEnter)
	local b = CreateFrame("Button", name, host)
	b:SetSize(60, ui.titleBar and Q.NAV_H - 10 or 16)
	b:SetPoint("RIGHT", rightOf, "LEFT", -Cli.PROJECT_PAD, 0)
	b:SetFrameLevel((Try(host.GetFrameLevel, host) or 1) + 5)
	b.text = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.text:SetPoint("RIGHT", b, "RIGHT", -2, 0)
	b.text:SetJustifyH("RIGHT")
	b.text:SetWordWrap(false)
	local hl = b:CreateTexture(nil, "HIGHLIGHT")
	hl:SetAllPoints()
	hl:SetColorTexture(1, 1, 1, 0.08)
	b:RegisterForClicks("LeftButtonUp")
	b:SetScript("OnClick", function(self)
		GameTooltip:Hide()
		onClick(self)
	end)
	b:SetScript("OnEnter", onEnter)
	b:SetScript("OnLeave", function() GameTooltip:Hide() end)
	b:Hide()
	return b
end

Q.INPUT_INSET_PLAIN = 8
Q.INPUT_INSET_SCROLL = 24

function Q.InputRightInset(busy)
	local base = ui.inputRightInset or Q.INPUT_INSET_PLAIN
	return busy and (base + Q.STOP_W + Q.STOP_INSET) or base
end

function Q.InsetComposer(busy)
	local scroll, box = ui.inputScroll, ui.inputBg
	if not scroll or not box then return end
	scroll:SetPoint("BOTTOMRIGHT", box, "BOTTOMRIGHT", -Q.InputRightInset(busy), 6)
end

function Q.BesideInput(button, inputBg, native)
	if native then
		button:SetPoint("BOTTOMLEFT", inputBg, "BOTTOMRIGHT", Q.COMPOSER_GAP, 0)
	else
		button:SetPoint("LEFT", inputBg, "RIGHT", Q.COMPOSER_GAP, 0)
	end
end

function Q.SendTooltip(button)
	GameTooltip:SetOwner(button, "ANCHOR_TOP")
	GameTooltip:SetText("Send (Enter)")
	GameTooltip:AddLine("/claude help lists commands.", 0.8, 0.8, 0.8, true)
	GameTooltip:Show()
end

function Q.UpdatePlaceholder()
	local placeholder, input = ui.placeholder, ui.input
	if not placeholder or not input then return end
	placeholder:SetText("Message " .. ns.ChatAgentName(ActiveChat()))
	if (input:GetText() or "") == "" and not input:HasFocus() then
		placeholder:Show()
	else
		placeholder:Hide()
	end
end

Q.EMPTY_GAP, Q.EMPTY_SIDE, Q.EMPTY_LINE_GAP = 16, 20, 8
Q.NOTE_GAP, Q.NOTE_PAD, Q.NOTE_SIDE, Q.RULE_GAP, Q.RULE_MIN, Q.NOTE_MAX_LINES, Q.NOTE_MAX_CHARS = 6, 4, 24, 8, 24, 2, 120

function Q.NoteKind(m)
	if m.role ~= "system" or m.newChat or type(m.text) ~= "string" then return nil end
	if m.event then return "event" end
	local _, breaks = m.text:gsub("\n", "")
	return breaks < Q.NOTE_MAX_LINES and #m.text <= Q.NOTE_MAX_CHARS and "note" or nil
end

function Q.LayoutCard(b)
	b.who:Show()
	b.when:Show()
	b.bg:Show()
	b.accent:SetShown(ui.parchment == nil)
	b.ruleL:Hide()
	b.ruleR:Hide()
	b.body:SetFontObject(b.bodyFont)
	if b.bodySpacing and b.body.SetSpacing then b.body:SetSpacing(b.bodySpacing) end
	b.body:SetJustifyH("LEFT")
	b.body:ClearAllPoints()
	b.body:SetPoint("TOPLEFT", b.who, "BOTTOMLEFT", 0, -Q.BUBBLE_WHO_GAP)
end

function Q.LayoutNote(b, text, kind, width)
	for _, part in ipairs({ b.who, b.when, b.bg, b.accent, b.allow, b.fresh }) do
		part:Hide()
	end
	for _, part in ipairs(b.macroBtns) do
		part:Hide()
	end
	for _, part in ipairs(b.rowBtns) do
		part:Hide()
	end
	local ink = ui.parchment and Q.PARCHMENT_DIM or { 0.62, 0.62, 0.62 }
	local inner = math.max(80, width - 2 * Q.NOTE_SIDE)
	b.body:SetFontObject(b.noteFont)
	b.body:SetTextColor(ink[1], ink[2], ink[3])
	b.body:SetJustifyH("CENTER")
	b.body:SetWidth(inner)
	b.body:SetText(text)
	b.body:ClearAllPoints()
	b.body:SetPoint("TOP", b, "TOP", 0, -Q.NOTE_PAD)
	local h = Try(b.body.GetStringHeight, b.body) or 12
	if h < 1 then h = 12 end
	b:SetHeight(h + 2 * Q.NOTE_PAD)
	local half = math.floor((Try(b.body.GetStringWidth, b.body) or inner) / 2) + Q.RULE_GAP
	local ruled = kind == "event" and width / 2 - half - Q.NOTE_SIDE >= Q.RULE_MIN
	for _, rule in ipairs({ b.ruleL, b.ruleR }) do
		rule:SetColorTexture(ink[1], ink[2], ink[3], 0.45)
		rule:ClearAllPoints()
		rule:SetShown(ruled)
	end
	if ruled then
		b.ruleL:SetPoint("LEFT", b, "LEFT", Q.NOTE_SIDE, 0)
		b.ruleL:SetPoint("RIGHT", b, "CENTER", -half, 0)
		b.ruleR:SetPoint("LEFT", b, "CENTER", half, 0)
		b.ruleR:SetPoint("RIGHT", b, "RIGHT", -Q.NOTE_SIDE, 0)
	end
end

Q.NOTICE_H, Q.NOTICE_INSET, Q.NOTICE_BUTTON_W = 34, 3, 80

function Q.BuildNoticeBar(native)
	local bar = CreateFrame("Frame", "ClaudeWoWNoticeBar", ui.scrollBottom[1])
	bar:SetHeight(Q.NOTICE_H - 2 * Q.NOTICE_INSET)
	bar:SetPoint("TOPLEFT", ui.scroll, "BOTTOMLEFT", 0, -Q.NOTICE_INSET)
	bar:SetPoint("TOPRIGHT", ui.scroll, "BOTTOMRIGHT", 0, -Q.NOTICE_INSET)
	bar.bg = bar:CreateTexture(nil, "BACKGROUND")
	bar.bg:SetAllPoints()
	bar.line = bar:CreateTexture(nil, "ARTWORK")
	bar.line:SetHeight(1)
	bar.line:SetPoint("TOPLEFT", bar, "TOPLEFT", 0, 0)
	bar.line:SetPoint("TOPRIGHT", bar, "TOPRIGHT", 0, 0)
	if native then
		bar.bg:SetColorTexture(0.45, 0.30, 0.10, 0.12)
		bar.line:SetColorTexture(Q.PARCHMENT_DIM[1], Q.PARCHMENT_DIM[2], Q.PARCHMENT_DIM[3], 0.45)
	else
		bar.bg:SetColorTexture(0.85, 0.70, 0.30, 0.12)
		bar.line:SetColorTexture(1, 0.82, 0, 0.5)
	end
	bar.button = CreateFrame("Button", "ClaudeWoWNoticeReload", bar, "UIPanelButtonTemplate")
	bar.button:SetSize(Q.NOTICE_BUTTON_W, 22)
	bar.button:SetPoint("RIGHT", bar, "RIGHT", -6, 0)
	bar.button:SetText("Reload")
	bar.button:SetScript("OnClick", function() ReloadUI() end)
	bar.text = bar:CreateFontString(nil, "OVERLAY", native and Q.FontObject("QuestFont", "GameFontNormal") or "GameFontNormal")
	bar.text:SetPoint("LEFT", bar, "LEFT", 8, 0)
	bar.text:SetPoint("RIGHT", bar.button, "LEFT", -8, 0)
	bar.text:SetJustifyH("LEFT")
	bar.text:SetWordWrap(false)
	if native then bar.text:SetTextColor(Q.PARCHMENT_TEXT[1], Q.PARCHMENT_TEXT[2], Q.PARCHMENT_TEXT[3]) end
	bar:EnableMouse(true)
	bar:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:AddLine("New addon files are installed")
		local u = run.updateReady
		if u then GameTooltip:AddLine(u.version .. (u.build ~= "" and (" build " .. u.build) or ""), 1, 1, 1) end
		GameTooltip:AddLine(u and u.restart and ClaudeWoW.Version.RESTART_TEXT or "Reload the UI to load them.", 1, 1, 1, true)
		GameTooltip:Show()
	end)
	bar:SetScript("OnLeave", function() GameTooltip:Hide() end)
	bar:Hide()
	ui.notice = bar
	Q.UpdateNoticeBar()
end

function Q.UpdateNoticeBar()
	local bar, scroll, base = ui.notice, ui.scroll, ui.scrollBottom
	if not bar or not scroll or not base then return end
	local text = ClaudeWoW.Version.Notice()
	bar.text:SetText(text or "")
	bar.button:SetShown(not (run.updateReady and run.updateReady.restart))
	bar:SetShown(text ~= nil)
	scroll:SetPoint("BOTTOMRIGHT", base[1], "BOTTOMRIGHT", base[2], base[3] + (text and Q.NOTICE_H or 0))
end

function Q.AddEvent(chat, text)
	AddHistory(chat, "system", text)
	chat.history[#chat.history].event = true
end

Q.EMPTY_ICON, Q.EMPTY_ROW_H, Q.EMPTY_ROWS_W, Q.EMPTY_ROW_ICON = 56, 22, 300, 16
Q.STARTER_ICON = "Interface\\GossipFrame\\AvailableQuestIcon"
Q.STARTERS = {
	project = { "Summarize what changed today", "Find and fix the failing test", "Explain how this repo is laid out" },
	game = { "What should I do next?", "Plan a route for my quests", "Which gear upgrades should I look for?" },
}
Q.EMPTY_HINT = "Shift-click an item, spell or quest to link it."

function Q.EmptyState(c)
	for _, m in ipairs(c.history) do
		if m.role ~= "system" or (type(m.picker) == "table" and #m.picker > 0) then return nil end
	end
	if run.restoring then return { title = "Restoring your chats", lines = { "Connecting to the companion app and restoring your chats..." } } end
	if not ClaudeWoW.IsConnected() then
		local state = Q.StatusState(c)
		if state == "connecting" then return { title = Q.STATUS_CONNECTING, lines = { "Looking for the companion app on this computer." } } end
		return { title = "Not connected", lines = { state == "failed" and Q.STATUS_NO_ANSWER or Q.STATUS_UNREACHABLE } }
	end
	local project = Cli.ProjectOf(c) ~= ""
	local lines = { Q.EMPTY_HINT }
	if Q.FirstRun() then table.insert(lines, Q.FIRST_RUN_TEXT) end
	return {
		title = project and "What are we working on?" or "What do you need?",
		lines = lines,
		starters = project and Q.STARTERS.project or Q.STARTERS.game,
	}
end

Q.FIRST_RUN_TEXT = "New here? Type below and press Enter. Replies show here, and /claude brings this window back."

function Q.FirstRun()
	for _, ch in ipairs(ns.db.chats) do
		if HasUserMessage(ch) then return false end
	end
	return true
end

function Q.UseStarter(text)
	local input = ui.input
	if not input then return end
	if (input:GetText() or "") ~= "" then return input:SetFocus() end
	input:SetText(text)
	input:SetFocus()
	if input.SetCursorPosition then input:SetCursorPosition(#text) end
	Q.UpdatePlaceholder()
end

function Q.StarterRow(f, k)
	local row = f.rows[k]
	if row then return row end
	local parchment = ui.parchment ~= nil
	row = CreateFrame("Button", nil, f)
	row:SetHeight(Q.EMPTY_ROW_H)
	row.icon = row:CreateTexture(nil, "ARTWORK")
	row.icon:SetSize(Q.EMPTY_ROW_ICON, Q.EMPTY_ROW_ICON)
	row.icon:SetPoint("LEFT", row, "LEFT", 4, 0)
	row.icon:SetTexture(Q.STARTER_ICON)
	row.label = row:CreateFontString(nil, "OVERLAY", parchment and Q.FontObject("QuestFont", "GameFontHighlight") or "GameFontHighlight")
	row.label:SetPoint("LEFT", row.icon, "RIGHT", 6, 0)
	row.label:SetPoint("RIGHT", row, "RIGHT", -4, 0)
	row.label:SetJustifyH("LEFT")
	row.label:SetWordWrap(false)
	if parchment then row.label:SetTextColor(Q.PARCHMENT_TEXT[1], Q.PARCHMENT_TEXT[2], Q.PARCHMENT_TEXT[3]) end
	row:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
	row:SetScript("OnClick", function(self) Q.UseStarter(self.starter) end)
	f.rows[k] = row
	return row
end

function Q.EmptyFrame()
	if ui.empty then return ui.empty end
	local parchment = ui.parchment ~= nil
	local f = CreateFrame("Frame", nil, ui.content)
	f.rows = {}
	f.icon = f:CreateTexture(nil, "ARTWORK")
	f.icon:SetSize(Q.EMPTY_ICON, Q.EMPTY_ICON)
	if not (type(SetPortraitToTexture) == "function" and pcall(SetPortraitToTexture, f.icon, Q.PORTRAIT)) then
		f.icon:SetTexture(Q.PORTRAIT)
		if type(f.icon.SetMask) == "function" then pcall(f.icon.SetMask, f.icon, Q.MINIMAP_ICON_MASK) end
	end
	f.title = f:CreateFontString(nil, "OVERLAY", parchment and Q.FontObject("QuestTitleFont", "GameFontNormalLarge") or "GameFontNormalLarge")
	f.title:SetJustifyH("CENTER")
	f.body = f:CreateFontString(nil, "OVERLAY", parchment and Q.FontObject("QuestFontNormalSmall", "GameFontHighlightSmall") or "GameFontHighlightSmall")
	f.body:SetJustifyH("CENTER")
	f.body:SetJustifyV("TOP")
	f.body:SetWordWrap(true)
	if parchment then
		f.title:SetTextColor(Q.PARCHMENT_TEXT[1], Q.PARCHMENT_TEXT[2], Q.PARCHMENT_TEXT[3])
		f.body:SetTextColor(Q.PARCHMENT_DIM[1], Q.PARCHMENT_DIM[2], Q.PARCHMENT_DIM[3])
	else
		f.title:SetTextColor(1, 0.82, 0)
		f.body:SetTextColor(0.8, 0.8, 0.8)
	end
	ui.empty = f
	return f
end

function Q.PlaceEmpty(state, y, width)
	local f = Q.EmptyFrame()
	local inner = math.max(80, width - 2 * Q.EMPTY_SIDE)
	f:SetWidth(inner)
	f.title:SetWidth(inner)
	f.body:SetWidth(inner)
	local below = y > 0
	local h = 0
	local function Stack(region, height, gap)
		region:ClearAllPoints()
		region:SetPoint("TOP", f, "TOP", 0, -h)
		h = h + height + (gap or Q.EMPTY_LINE_GAP)
	end
	f.icon:SetShown(not below)
	if not below then Stack(f.icon, Q.EMPTY_ICON) end
	f.title:SetShown(not below)
	f.title:SetText(below and "" or Display(state.title))
	if not below then Stack(f.title, Try(f.title.GetStringHeight, f.title) or 14) end
	local starters = state.starters or {}
	local rowsW = math.min(inner, Q.EMPTY_ROWS_W)
	for k, text in ipairs(starters) do
		local row = Q.StarterRow(f, k)
		row.starter = text
		row.label:SetText(Display(text))
		row:SetWidth(rowsW)
		Stack(row, Q.EMPTY_ROW_H, k == #starters and Q.EMPTY_LINE_GAP or 0)
		row:Show()
	end
	for k = #starters + 1, #f.rows do
		f.rows[k]:Hide()
	end
	f.body:SetText(Display(below and state.lines[1] or table.concat(state.lines, "\n")))
	Stack(f.body, Try(f.body.GetStringHeight, f.body) or 14, 0)
	f:SetHeight(h)
	local view = Try(ui.scroll.GetHeight, ui.scroll) or 0
	local top = below and (y + Q.EMPTY_GAP) or math.max(0, math.floor((view - h) / 2))
	f:ClearAllPoints()
	f:SetPoint("TOPLEFT", ui.content, "TOPLEFT", math.floor((width - inner) / 2), -top)
	f:Show()
	return top + h
end

local function MacroSignature(macros)
	if type(macros) ~= "table" or #macros == 0 then return "" end
	local labels = {}
	for k, m in ipairs(macros) do
		labels[k] = ClaudeWoW.MacroLabel(m)
	end
	return #macros .. "\n" .. table.concat(labels, "\n")
end

local function PickerSignature(picker)
	if not picker then return "" end
	local rows = {}
	for k, row in ipairs(picker) do
		rows[k] = row.text or ""
	end
	return #picker .. "\n" .. table.concat(rows, "\n")
end

local function RenderState(c, width)
	local s = run.renderKey
	local parchment = ui.parchment ~= nil
	local count = #c.history
	if not s or s.chat ~= c.id or s.width ~= width or s.parchment ~= parchment or s.bubbles ~= ui.bubbles or count < s.count then
		s = { chat = c.id, width = width, parchment = parchment, bubbles = ui.bubbles, items = {} }
		run.renderKey = s
	end
	s.count = count
	return s
end

local function SameCard(prev, role, body, when, dim, who, newChat, macroSig, pickerSig)
	return prev ~= nil
		and prev.kind == "card"
		and prev.role == role
		and prev.body == body
		and prev.when == when
		and prev.dim == dim
		and prev.who == who
		and prev.newChat == newChat
		and prev.macros == macroSig
		and prev.picker == pickerSig
end

function ClaudeWoW.Render()
	local c = ActiveChat()
	Cli.UpdateMcpButton()
	Cli.UpdateProjectButton()
	Cli.UpdateEffortButton()
	ClaudeWoW.UpdateConnect()
	Q.UpdatePlaceholder()
	if ui.content and c then
		local width = ui.scroll:GetWidth()
		if not width or width < 80 then width = 400 end
		ui.content:SetWidth(width)
		local items = RenderState(c, width).items
		local y, n = 0, 0
		local function Anchor(b)
			if b.tipShown then GameTooltip:Hide() end
			b.tipShown, b.steps = nil, nil
			b:ClearAllPoints()
			b:SetPoint("TOPLEFT", ui.content, "TOPLEFT", 0, -y)
			b:Show()
		end
		local function PlaceNote(text, kind)
			n = n + 1
			local b = GetBubble(n)
			local prev = items[n]
			if prev and prev.kind == kind and prev.text == text then
				Anchor(b)
				b.text = text
				y = y + prev.h + Q.NOTE_GAP
				return b
			end
			b:SetWidth(width)
			Q.LayoutNote(b, Display(text), kind, width)
			Anchor(b)
			b.text = text
			local h = b:GetHeight()
			items[n] = { kind = kind, text = text, h = h }
			y = y + h + Q.NOTE_GAP
			return b
		end
		local function Place(role, text, when, dim, denied, agent, macros, newChat, picker, fresh)
			n = n + 1
			local b = GetBubble(n)
			local st = ROLE_STYLE[role] or ROLE_STYLE.system
			local look = ui.parchment and (Q.PARCHMENT_STYLE[role] or Q.PARCHMENT_STYLE.system) or st
			local who = st == ROLE_STYLE.assistant and ns.ReplyAgentName(c, agent) or st.label
			local macroSig, pickerSig = MacroSignature(macros), PickerSignature(picker)
			local body = role == "assistant" and Q.RichText(Display(text), ui.parchment ~= nil) or Display(text)
			local prev = items[n]
			if not fresh and not denied and SameCard(prev, role, body, when, dim, who, newChat == true, macroSig, pickerSig) then
				for k, m in ipairs(macros or {}) do
					b.macroBtns[k].macro = m
				end
				for k, row in ipairs(picker or {}) do
					b.rowBtns[k].row = row
				end
				Anchor(b)
				b.text = text
				y = y + prev.h + 6
				return b
			end
			items[n] = nil
			Q.LayoutCard(b)
			b:SetWidth(width)
			b.bg:SetColorTexture(look.bg[1], look.bg[2], look.bg[3], look.bg[4])
			b.accent:SetColorTexture(look.color[1], look.color[2], look.color[3], ui.parchment and 0.6 or 0.9)
			b.who:SetText(who)
			b.who:SetTextColor(look.color[1], look.color[2], look.color[3])
			b.when:SetText(when or "")
			b.body:SetWidth(width - b.pad.left - b.pad.right)
			b.body:SetText(body)
			local ink = ui.parchment and (dim and Q.PARCHMENT_DIM or Q.PARCHMENT_TEXT) or (dim and { 0.72, 0.72, 0.72 } or { 0.93, 0.93, 0.93 })
			b.body:SetTextColor(ink[1], ink[2], ink[3])
			local h = b.body:GetStringHeight()
			if not h or h < 1 then h = 14 end
			local extra = 0
			if denied and ClaudeWoW.LootRollEnabled() then
				b.allow:Hide()
				ClaudeWoWRoll.Offer(c.id)
			elseif denied then
				ClaudeWoW.NoteDenialDrawn(c.id)
				local label = "Allow " .. ClaudeWoW.GrantsLabel(denied) .. (ClaudeWoW.IsLiveChat(c) and " once & retry" or " & retry")
				b.allow:SetText(label)
				b.allow:SetWidth(math.min(width - 24, math.max(160, b.allow:GetFontString():GetStringWidth() + 30)))
				b.allow.chatId = c.id
				b.allow.msgId = select(2, ClaudeWoW.OpenDenial(c.id))
				b.allow.rules = denied
				b.allow:Show()
				extra = 28
			else
				b.allow:Hide()
			end
			if newChat then
				b.fresh:SetWidth(math.min(width - 24, math.max(120, b.fresh:GetFontString():GetStringWidth() + 30)))
				b.fresh:ClearAllPoints()
				b.fresh:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6 - extra)
				b.fresh:Show()
				extra = extra + 28
			else
				b.fresh:Hide()
			end
			-- One button per macro the agent handed over.
			local shownMacros = 0
			for k, m in ipairs(macros or {}) do
				local mb = b.macroBtns[k]
				if not mb then
					mb = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
					mb:SetHeight(22)
					mb:SetScript("OnClick", function(self) ClaudeWoW.InstallMacro(self.macro) end)
					mb:SetScript("OnEnter", function(self)
						GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
						GameTooltip:AddLine(Display(self.macro.name))
						GameTooltip:AddLine(Display(self.macro.body), 1, 1, 1, true)
						GameTooltip:Show()
					end)
					mb:SetScript("OnLeave", function() GameTooltip:Hide() end)
					b.macroBtns[k] = mb
				end
				mb.macro = m
				mb:SetText(ClaudeWoW.MacroLabel(m))
				mb:SetWidth(math.min(width - 24, math.max(160, mb:GetFontString():GetStringWidth() + 30)))
				mb:ClearAllPoints()
				mb:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -6 - extra)
				mb:Show()
				extra = extra + 28
				shownMacros = k
			end
			for k = shownMacros + 1, #b.macroBtns do
				b.macroBtns[k]:Hide()
			end
			local shownRows = 0
			for k, row in ipairs(picker or {}) do
				local rb = GetPickerRow(b, k)
				rb.row = row
				rb.label:SetText(row.text or "")
				rb:SetWidth(width - 24)
				rb:ClearAllPoints()
				rb:SetPoint("TOPLEFT", b.body, "BOTTOMLEFT", 0, -4 - extra)
				rb:Show()
				extra = extra + PICKER_ROW_HEIGHT
				shownRows = k
			end
			for k = shownRows + 1, #b.rowBtns do
				b.rowBtns[k]:Hide()
			end
			local whoH = math.max(12, Try(b.who.GetStringHeight, b.who) or 12)
			b:SetHeight(b.pad.top + whoH + Q.BUBBLE_WHO_GAP + h + b.pad.bottom + extra)
			Anchor(b)
			b.text = text
			local height = b:GetHeight()
			if not fresh and not denied then
				items[n] = {
					kind = "card",
					role = role,
					body = body,
					when = when,
					dim = dim,
					who = who,
					newChat = newChat == true,
					macros = macroSig,
					picker = pickerSig,
					h = height,
				}
			end
			y = y + height + 6
			return b
		end
		local openDenial = not c.pendingId and Q.DenialIndex(c) or nil
		for i, m in ipairs(c.history) do
			local denied = i == openDenial and m.denied or nil
			local picker = type(m.picker) == "table" and #m.picker > 0 and m.picker or nil
			local reply = m.role == "assistant" and not picker
			local kind = not denied and not picker and Q.NoteKind(m)
			if kind then
				PlaceNote(m.text, kind)
			else
				local b = Place(
					m.role,
					picker and m.head or (reply and Q.StripSummary(m.text, m.summary) or m.text),
					m.t and date("%H:%M", m.t) or "",
					false,
					denied,
					m.agent,
					m.macros,
					m.newChat,
					picker
				)
				if reply then b.text = m.text end
			end
		end
		local empty = nil
		if c.pendingId then
			local head, steps = Q.WorkingLine(c)
			local tipWasOpen = ui.bubbles[n + 1] and ui.bubbles[n + 1].tipShown
			local b = Place("assistant", head, "", true, nil, ns.ChatAgent(c), nil, nil, nil, true)
			if #steps > 0 then
				b.steps = steps
				b.text = head .. "\n\n" .. table.concat(steps, "\n")
				if tipWasOpen or Try(b.IsMouseOver, b) then Q.StepsTooltip(b) end
			end
		else
			empty = Q.EmptyState(c)
		end
		for i = n + 1, #ui.bubbles do
			ui.bubbles[i]:Hide()
			items[i] = nil
		end
		if empty then
			y = Q.PlaceEmpty(empty, y, width)
		elseif ui.empty then
			ui.empty:Hide()
		end
		ui.content:SetHeight(math.max(y, 1))
		C_Timer.After(0.05, function()
			if ui.scroll then ui.scroll:SetVerticalScroll(ui.scroll:GetVerticalScrollRange()) end
		end)
	end
	ClaudeWoW.UpdateStatus()
	ClaudeWoW.RenderChatList()
end

local function ChatLinks(chat) return "  " .. Link("reply", chat.id, "reply", "55ff55") .. " " .. Link("open", chat.id, "open") end

-- Print a reply into the game chat: prefix on the first line, then the text line
-- by line up to the limit, then clickable links. `short` prints one preview line.
-- `summary` (the default) prints the TL;DR block the bridge split off the reply,
-- or the first lines of the reply when the agent didn't write one; the full text
-- is in the window, behind [open].
local function EchoToChat(chat, text, agent, summary)
	local mode = ns.db.settings.echo
	if mode == "off" then return end
	local prefix = "|cff7ec8ff[" .. ns.ReplyAgentName(chat, agent) .. " · " .. Display(chat.name) .. "]|r "
	local body = Q.MarkFences(Display(text))
	if mode == "short" then
		local flat = (body:gsub("\3[^\n]*", ""):gsub("%s+", " "))
		if #flat > 200 then flat = Q.CutLine(flat, 200) .. " ..." end
		print(prefix .. Q.RichText(flat) .. ChatLinks(chat))
		return
	end
	if mode == "summary" then
		local source, max = Q.MarkFences(Display(summary or "")), ECHO.SUMMARY_LINES
		if not source:match("%S") then
			source, max = body, ECHO.SUMMARY_FALLBACK_LINES
		end
		local lines, total = {}, 0
		for line in (source .. "\n"):gmatch("(.-)\n") do
			if line:match("%S") then
				total = total + 1
				if total <= max then table.insert(lines, line) end
			end
		end
		for i, line in ipairs(lines) do
			print((i == 1 and prefix or "    ") .. Q.RichText(line))
		end
		if total > max then print("    |cff888888... click [open] to read it all|r") end
		print("    " .. ChatLinks(chat):sub(3))
		return
	end
	local limit = tonumber(mode) or ECHO.DEFAULT
	local first, shown = true, 0
	for line in (body .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then
			if shown + #line > limit then
				print("    |cff888888... " .. (#body - shown) .. " more characters, click [open] to read it all|r")
				break
			end
			print((first and prefix or "    ") .. Q.RichText(line))
			first = false
			shown = shown + #line
		end
	end
	print("    " .. ChatLinks(chat):sub(3))
end

function ClaudeWoW.Notify(chat, text, agent, summary, role, denied, msgId, macros)
	local inCombat = InCombatLockdown() and true or false
	if not inCombat then pcall(PlaySound, 3081) end
	if ClaudeWoWVoice and not inCombat then ClaudeWoWVoice.Reply(role, denied) end
	Q.UpdateMinimapSignal()
	run.lastReplyChat = chat.id
	Whisper.OfferReply(chat)
	local tabbed = Whisper.Reply(chat, text, agent, role, denied, summary, msgId, macros)
	if not tabbed then EchoToChat(chat, text, agent, summary) end
	if inCombat or tabbed then return tabbed end
	if ui.frame and ui.frame:IsShown() then return false end
	local who = ns.ReplyAgentName(chat, agent)
	if UIErrorsFrame then UIErrorsFrame:AddMessage(who .. " replied.", 0.5, 0.8, 1, 1) end
	if not Q.MinimapButtonOn() then print(ClaudeWoW.PREFIX .. who .. Q.REPLY_WAITING_NOTICE) end
	return false
end

function ClaudeWoW.SystemNote(text)
	if not ns.db then return end
	local c = ActiveChat()
	if not c then return end
	AddHistory(c, "system", text)
	ClaudeWoW.Render()
end

Q.CTX_BAR_W, Q.CTX_BAR_H = 120, 13
Q.CTX_TICK_W = 2
Q.CTX_BAR_GAP = 24
Q.CTX_BAR_RIGHT_X, Q.CTX_BAR_Y = -40, 9
Q.CTX_WARN_LEVEL = 3
Q.CTX_DEFAULT_WINDOW = 200000
Q.CTX_LEVELS = {
	{ upTo = 0.50, color = { 0.10, 0.75, 0.10 } },
	{ upTo = 0.75, color = { 1.00, 0.82, 0.00 } },
	{ upTo = 0.90, color = { 1.00, 0.50, 0.00 } },
	{ upTo = math.huge, color = { 0.85, 0.10, 0.10 } },
}

function Q.ContextWindow(c) return (c and c.window) or Q.CTX_DEFAULT_WINDOW end

function Q.ContextColor(fraction)
	for _, level in ipairs(Q.CTX_LEVELS) do
		if fraction <= level.upTo then return level.color end
	end
end

function Q.ContextBar(f)
	local bar = CreateFrame("StatusBar", "ClaudeWoWContextBar", f)
	bar:SetSize(Q.CTX_BAR_W, Q.CTX_BAR_H)
	bar:SetStatusBarTexture("Interface\\TargetingFrame\\UI-StatusBar")
	bar:SetMinMaxValues(0, 1)
	local bg = bar:CreateTexture(nil, "BACKGROUND")
	bg:SetAllPoints()
	bg:SetColorTexture(0, 0, 0, 0.6)
	local border = CreateFrame("Frame", nil, bar, "BackdropTemplate")
	border:SetPoint("TOPLEFT", bar, "TOPLEFT", -2, 2)
	border:SetPoint("BOTTOMRIGHT", bar, "BOTTOMRIGHT", 2, -2)
	if border.SetBackdrop then
		border:SetBackdrop({ edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", edgeSize = 8 })
		border:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	end
	bar.tick = bar:CreateTexture(nil, "OVERLAY")
	bar.tick:SetColorTexture(1, 0.95, 0.8, 0.9)
	bar.tick:SetSize(Q.CTX_TICK_W, Q.CTX_BAR_H)
	bar.tick:Hide()
	bar.text = bar:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	bar.text:SetPoint("CENTER", bar, "CENTER", 0, 0)
	bar:EnableMouse(true)
	bar:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Context")
		local c = ActiveChat()
		GameTooltip:AddLine(ContextReport(c), 1, 1, 1, true)
		GameTooltip:Show()
	end)
	bar:SetScript("OnLeave", function() GameTooltip:Hide() end)
	bar:Hide()
	return bar
end

function Q.UpdateContextBar(c)
	local bar = ui.ctxBar
	if not bar then return end
	if not (c and c.ctx) then
		bar:Hide()
		return
	end
	local window = Q.ContextWindow(c)
	local fraction = c.ctx / window
	local color = Q.ContextColor(fraction)
	local warn = tonumber(ns.db.settings.contextWarn) or 0
	local warnLevel = Q.CTX_LEVELS[Q.CTX_WARN_LEVEL]
	if warn > 0 and c.ctx >= warn and fraction <= warnLevel.upTo then color = warnLevel.color end
	if warn > 0 and warn < window then
		bar.tick:ClearAllPoints()
		bar.tick:SetPoint("TOP", bar, "TOPLEFT", bar:GetWidth() * warn / window, 0)
		bar.tick:Show()
	else
		bar.tick:Hide()
	end
	bar:SetValue(math.min(fraction, 1))
	bar:SetStatusBarColor(color[1], color[2], color[3])
	bar.fraction = fraction
	bar.text:SetText(FmtTokens(c.ctx) .. " / " .. FmtTokens(window))
	bar:Show()
end

function Q.ShortStatus(c)
	local state, _, started = Q.StatusState(c)
	if state == "working" then return "|cffffd100" .. Q.STATUS_WORKING .. "|r " .. FmtDur(GetTime() - (started or GetTime())) end
	if state == "connecting" then return "|cffffd100" .. Q.STATUS_CONNECTING .. "|r" end
	if state == "failed" then return "|cffff5050" .. Q.STATUS_NO_ANSWER .. "|r" end
	if state == "down" then return "|cffff5050" .. Q.STATUS_UNREACHABLE .. "|r" end
	if state == "reply" then return "|cff55ff55" .. Q.STATUS_REPLY .. "|r" end
	return Q.STATUS_READY
end

function Q.TotalCost()
	local total, chats = 0, 0
	for _, ch in ipairs(ns.db.chats) do
		if type(ch.cost) == "number" then
			total = total + ch.cost
			chats = chats + 1
		end
	end
	return total, chats
end

function Q.StatusTooltip()
	local c = ActiveChat()
	if run.statusText then GameTooltip:AddLine(run.statusText, 1, 1, 1, true) end
	local total, chats = Q.TotalCost()
	if (c and c.cost) or chats > 0 then
		GameTooltip:AddLine(" ")
		GameTooltip:AddLine("Estimated API cost", 1, 0.82, 0)
		if c and c.cost then GameTooltip:AddDoubleLine("This chat", string.format("$%.2f", c.cost), 1, 1, 1, 1, 1, 1) end
		if chats > 0 then GameTooltip:AddDoubleLine("All chats", string.format("$%.2f", total), 1, 1, 1, 1, 1, 1) end
		GameTooltip:AddLine("At API list prices: a comparison, not a bill. A subscription is not charged per token.", 0.6, 0.6, 0.6, true)
	end
end
