local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "UI\\Frame.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q, Cli = ns.run, ns.ui, ns.Q, ns.Cli
local Try, SafeReload = ns.Try, ns.SafeReload
local FindChat, ActiveChat = ns.FindChat, ns.ActiveChat

-- Shared window backdrop. Declared up here because ShowCopy (rendering section)
-- uses it too: a later `local` would be invisible there and resolve to a nil global.
local BACKDROP = {
	bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
	edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
	tile = true,
	tileSize = 16,
	edgeSize = 16,
	insets = { left = 4, right = 4, top = 4, bottom = 4 },
}
ns.BACKDROP = BACKDROP

local function MakeButton(parent, label, width, onClick)
	local b = CreateFrame("Button", nil, parent, "UIPanelButtonTemplate")
	b:SetSize(width, 22)
	b:SetText(label)
	b:SetScript("OnClick", onClick)
	return b
end

local PANEL_W = 150
Q.PORTRAIT = "Interface\\AddOns\\ClaudeWoW\\Portrait"
Q.NATIVE_TEMPLATES = { "ButtonFrameTemplate", "InsetFrameTemplate" }
ns.MakeButton, ns.PANEL_W = MakeButton, PANEL_W

Q.COMPOSER_BOTTOM = 2
Q.COMPOSER_GAP = 6
Q.EFFORT_H = 16
Q.EFFORT_GAP = 2
Q.STOP_W = 48
Q.STOP_H = 18
Q.STOP_INSET = 5
Q.NAV_TOP = -24
Q.NAV_H = 34

Q.STATUS_HIT_W = 260

function Q.TemplateExists(name) return type(C_XMLUtil) == "table" and Try(C_XMLUtil.GetTemplateInfo, name) ~= nil end

function Q.NativeFrames()
	for _, name in ipairs(Q.NATIVE_TEMPLATES) do
		if not Q.TemplateExists(name) then return false end
	end
	return true
end

function Q.AtlasExists(name) return C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists(name) and true or false end

Q.PANEL_TITLE = ns.PRODUCT
Q.WINDOW_STRATA = "HIGH"

Q.BRIDGE_CHECK_SECONDS = 20
Q.LOGIN_NOTICE = ns.PREFIX .. "Loaded. Type /claude to open it."
Q.LOGIN_NOTICE_MINIMAP = ns.PREFIX .. "Loaded. Click the minimap button or type /claude to open it."
Q.REPLY_WAITING_NOTICE = " replied. Type /claude to open the window."
Q.UNREACHABLE_NOTICE = ns.PREFIX .. "Can't reach the companion app. Start it, then type /claude and click Connect."

function Q.LoginNotice()
	if ns.db.settings.loginNoticeV1 then return end
	ns.db.settings.loginNoticeV1 = true
	print(Q.MinimapButtonOn() and Q.LOGIN_NOTICE_MINIMAP or Q.LOGIN_NOTICE)
end

function Q.UnreachableNotice()
	run.loginChecked = true
	if run.unreachableTold or ClaudeWoW.IsConnected() or run.connectingAt then return end
	run.unreachableTold = true
	print(Q.UNREACHABLE_NOTICE)
end

Q.CLASSIC_ERA_ART = { parchment = true, reply = true }
Q.CLASSIC_ERA_GEAR = "Interface\\Icons\\INV_Misc_Gear_01"
Q.CLASSIC_PAGE = {
	{ file = "Interface\\QuestFrame\\UI-QuestLog-TopLeft", coords = { 21 / 256, 1, 177 / 256, 1 } },
	{ file = "Interface\\QuestFrame\\UI-QuestLog-TopRight", coords = { 0, 61 / 128, 177 / 256, 1 } },
	{ file = "Interface\\QuestFrame\\UI-QuestLog-BotLeft", coords = { 21 / 256, 1, 0, 179 / 256 } },
	{ file = "Interface\\QuestFrame\\UI-QuestLog-BotRight", coords = { 0, 61 / 128, 0, 179 / 256 } },
}
Q.CLASSIC_PAGE_SPLIT_X, Q.CLASSIC_PAGE_SPLIT_Y = 235 / 296, 79 / 258

function Q.LayoutClassicPage(page, w, h)
	local wl, ht = math.floor(w * Q.CLASSIC_PAGE_SPLIT_X + 0.5), math.floor(h * Q.CLASSIC_PAGE_SPLIT_Y + 0.5)
	local spots = { { 0, 0, wl, ht }, { wl, 0, w - wl, ht }, { 0, -ht, wl, h - ht }, { wl, -ht, w - wl, h - ht } }
	for i, piece in ipairs(page.pieces) do
		local spot = spots[i]
		piece:ClearAllPoints()
		piece:SetPoint("TOPLEFT", page, "TOPLEFT", spot[1], spot[2])
		piece:SetSize(math.max(1, spot[3]), math.max(1, spot[4]))
	end
end

function Q.BuildClassicPage(tex, inset)
	if not Q.IsClassicEra() then return nil end
	inset = inset or 0
	local holder = tex:GetParent()
	local page = CreateFrame("Frame", nil, holder)
	page:SetPoint("TOPLEFT", holder, "TOPLEFT", inset, -inset)
	page:SetPoint("BOTTOMRIGHT", holder, "BOTTOMRIGHT", -inset, inset)
	page:SetFrameLevel(math.max(0, (Try(holder.GetFrameLevel, holder) or 1)))
	page.pieces = {}
	for i, spec in ipairs(Q.CLASSIC_PAGE) do
		local piece = i == 1 and tex or holder:CreateTexture(nil, "BACKGROUND", nil, 1)
		if not pcall(piece.SetTexture, piece, spec.file) then return nil end
		piece:SetTexCoord(spec.coords[1], spec.coords[2], spec.coords[3], spec.coords[4])
		page.pieces[i] = piece
	end
	page:SetScript("OnSizeChanged", function(self, w, h) Q.LayoutClassicPage(self, w, h) end)
	Q.LayoutClassicPage(page, Try(page.GetWidth, page) or 300, Try(page.GetHeight, page) or 300)
	return page
end

function Q.ClassicParchment(tex, inset)
	local page = Q.BuildClassicPage(tex, inset)
	if not page then return false end
	ui.art = ui.art or {}
	ui.art.parchment = Q.CLASSIC_PAGE[1].file
	ui.classicPage = page
	return true
end

function ClaudeWoW.PaintParchment(tex)
	local atlas = Q.QUEST_ART.parchment
	if atlas and Q.ArtAllowed("parchment") and Q.AtlasExists(atlas) and pcall(tex.SetAtlas, tex, atlas) then return atlas end
	if Q.BuildClassicPage(tex, 0) then return Q.CLASSIC_PAGE[1].file end
	return nil
end

function Q.IsClassicEra()
	local _, _, _, interface = Try(GetBuildInfo)
	local toc = tonumber(interface)
	return toc ~= nil and toc >= 11500 and toc < 11600
end

function Q.ArtAllowed(key) return not Q.IsClassicEra() or Q.CLASSIC_ERA_ART[key] == true end

function Q.SetArt(tex, key, useSize)
	local name = Q.QUEST_ART[key]
	local ok = name ~= nil and Q.ArtAllowed(key) and Q.AtlasExists(name) and pcall(tex.SetAtlas, tex, name, useSize)
	ui.art = ui.art or {}
	ui.art[key] = ok and name or false
	return ok and true or false
end

function Q.FontObject(name, fallback) return _G[name] ~= nil and name or fallback end

Q.LEGACY_BIND_BUTTON = "ClaudeWoWRefreshButton"
Q.LEGACY_BIND_ACTION = "CLICK " .. Q.LEGACY_BIND_BUTTON .. ":LeftButton"
Q.WORKSPACE_BINDING = "CLAUDEWOW_WORKSPACE"
Q.BIND_MOVED = "Use Key Bindings > AddOns to set a key that opens or closes the window."
Q.BIND_EVENTS = { "UPDATE_BINDINGS", "PLAYER_REGEN_ENABLED" }

function Q.LegacyBindKeys()
	if type(GetBindingKey) ~= "function" then return {} end
	return { GetBindingKey(Q.LEGACY_BIND_ACTION) }
end

function Q.MoveLegacyBinding()
	if InCombatLockdown() then return false end
	local keys = Q.LegacyBindKeys()
	if #keys == 0 then return false end
	for _, key in ipairs(keys) do
		SetBinding(key, Q.WORKSPACE_BINDING)
	end
	SaveBindings(GetCurrentBindingSet())
	return true
end

function Q.MigrateLegacyBinding()
	Q.MoveLegacyBinding()
	if ui.bindWatch then return end
	local watch = CreateFrame("Frame")
	for _, event in ipairs(Q.BIND_EVENTS) do
		watch:RegisterEvent(event)
	end
	watch:SetScript("OnEvent", function() Q.MoveLegacyBinding() end)
	ui.bindWatch = watch
end

local function BuildUI()
	if ui.frame then return end
	local s = ns.db.settings
	local native = Q.NativeFrames()
	ui.native = native

	local f = CreateFrame("Frame", "ClaudeWoWFrame", UIParent, native and "ButtonFrameTemplate" or "BackdropTemplate")
	ui.frame = f
	f.claudewowNative = native
	f:SetSize(s.width, s.height)
	f:SetPoint("CENTER")
	f:SetFrameStrata(Q.WINDOW_STRATA)
	f:SetResizable(true)
	f:SetClampedToScreen(true)
	f:SetResizeBounds(560, 300)
	f:EnableMouse(true)
	if native then
		Try(f.SetPortraitToAsset, f, Q.PORTRAIT)
		if type(f.Inset) == "table" then f.Inset:Hide() end
	else
		f:SetBackdrop(BACKDROP)
		f:SetBackdropColor(0.05, 0.05, 0.07, 0.95)
		f:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	end
	f:Hide()
	tinsert(UISpecialFrames, "ClaudeWoWFrame")

	-- Status light: green = bridge seen recently, yellow = stale, red = gone.
	local function MakeDot(parent)
		local holder = CreateFrame("Frame", nil, parent)
		holder:SetSize(16, 16)
		local dot = holder:CreateTexture(nil, "OVERLAY")
		dot:SetAllPoints()
		dot:SetTexture("Interface\\FriendsFrame\\StatusIcon-Offline")
		holder:EnableMouse(true)
		holder:SetScript("OnEnter", function(self)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText(dot.tip or "Companion app status", 0.9, 0.9, 0.9, 1, true)
			Q.StatusTooltip()
			GameTooltip:Show()
		end)
		holder:SetScript("OnLeave", function() GameTooltip:Hide() end)
		return holder, dot
	end

	local dotHolder, dot = MakeDot(f)
	ui.dot = dot
	ui.dotHolder = dotHolder

	local nativeTitle = native and Try(f.GetTitleText, f)
	local title = nativeTitle or f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	if not nativeTitle then title:SetPoint("LEFT", dotHolder, "RIGHT", 6, 0) end
	title:SetText(Q.PANEL_TITLE)
	ui.title = title

	local status = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	status:SetPoint("RIGHT", f, "RIGHT", -60, 0)
	status:SetJustifyH("LEFT")
	ui.status = status
	if native then
		dotHolder:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 12, 6)
		dotHolder:SetHitRectInsets(0, -Q.STATUS_HIT_W, -4, -4)
		status:ClearAllPoints()
		status:SetPoint("LEFT", dotHolder, "RIGHT", 6, 0)
		status:SetWidth(Q.STATUS_HIT_W)
		status:SetWordWrap(false)
		ui.ctxBar = Q.ContextBar(f)
	else
		dotHolder:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -16)
		status:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -34)
	end

	local close = native and type(f.CloseButton) == "table" and f.CloseButton or nil
	if not close then
		close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
		close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -4, -4)
	end
	ui.close = close
	close:SetScript("OnClick", function() ClaudeWoW.Toggle(false) end)
	close:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_LEFT")
		GameTooltip:SetText("Close (Esc)")
		GameTooltip:AddLine("Type /claude to open it again.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	close:SetScript("OnLeave", function() GameTooltip:Hide() end)

	f:SetScript("OnHide", function()
		if ui.quitting then
			ui.quitting = nil
		elseif ns.db and UIParent:IsShown() then
			ns.db.settings.shown = false
		end
		Q.UpdateMinimapSignal()
	end)

	local panel
	if native then
		Q.BuildQuestFrames(f)
	else
		panel = Q.BuildLegacyList(f)
	end

	-- Transcript: a scrolling stack of message bubbles
	local scroll = CreateFrame(
		"ScrollFrame",
		"ClaudeWoWScroll",
		native and ui.parchment or f,
		(native and Q.TemplateExists("ScrollFrameTemplate")) and "ScrollFrameTemplate" or "UIPanelScrollFrameTemplate"
	)
	if native then
		scroll:SetPoint("TOPLEFT", ui.parchment, "TOPLEFT", 22, -16)
		ui.scrollBottom = { ui.parchment, -34, 14 }
	else
		scroll:SetPoint("TOPLEFT", panel, "TOPRIGHT", 8, 0)
		ui.scrollBottom = { f, -32, 110 }
	end
	ui.scroll = scroll
	Q.BuildNoticeBar(native)

	local content = CreateFrame("Frame", "ClaudeWoWContent", scroll)
	content:SetSize(500, 1)
	scroll:SetScrollChild(content)
	ui.content = content
	ui.bubbles = {}
	ui.empty = nil
	scroll:HookScript("OnSizeChanged", function(self, w, h)
		if ui.frame:IsShown() then ClaudeWoW.Render() end
	end)

	-- Input box, with Send docked at its right end like a messaging app.
	local SEND_W = 84
	local inputBg = Q.Panel(f, native)
	if native then
		inputBg:SetPoint("TOPLEFT", ui.parchment, "BOTTOMLEFT", 0, -4)
		inputBg:SetPoint("BOTTOMRIGHT", ui.listPanel, "BOTTOMLEFT", -Q.COMPOSER_GAP - SEND_W - Q.COMPOSER_GAP, Q.COMPOSER_BOTTOM)
	else
		inputBg:SetPoint("BOTTOMLEFT", panel, "BOTTOMRIGHT", 8, 0)
		inputBg:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -14 - SEND_W - Q.COMPOSER_GAP, 50)
		inputBg:SetHeight(54)
	end
	if not native then
		inputBg:SetBackdropColor(0, 0, 0, 0.6)
		inputBg:SetBackdropBorderColor(0.5, 0.5, 0.5, 1)
	end

	local plainInput = native and type(ScrollingEdit_OnCursorChanged) == "function" and type(ScrollingEdit_OnTextChanged) == "function"
	local inScroll = CreateFrame("ScrollFrame", "ClaudeWoWInputScroll", inputBg, (not plainInput) and "UIPanelScrollFrameTemplate" or nil)
	inScroll:SetPoint("TOPLEFT", inputBg, "TOPLEFT", 8, -6)
	ui.inputBg, ui.inputScroll = inputBg, inScroll
	ui.inputRightInset = plainInput and Q.INPUT_INSET_PLAIN or Q.INPUT_INSET_SCROLL
	Q.InsetComposer(false)

	local input = CreateFrame("EditBox", "ClaudeWoWInput", inScroll)
	input:SetMultiLine(true)
	input:SetAutoFocus(false)
	input:SetFontObject(ChatFontNormal)
	input:SetMaxLetters(0)
	input:SetSize(500, 40)
	input:SetScript("OnEnterPressed", function() ClaudeWoW.SendFromInput() end)
	input:SetScript("OnEscapePressed", function(self)
		self:ClearFocus()
		ClaudeWoW.Toggle(false)
	end)
	input:SetScript("OnTabPressed", function(self) Cli.CompleteSlash(self) end)
	if plainInput then
		input:SetScript("OnCursorChanged", ScrollingEdit_OnCursorChanged)
		input:SetScript("OnTextChanged", function(self) ScrollingEdit_OnTextChanged(self, inScroll) end)
		if type(ScrollingEdit_OnUpdate) == "function" then
			input:SetScript("OnUpdate", function(self, elapsed) ScrollingEdit_OnUpdate(self, elapsed, inScroll) end)
		end
	end
	inScroll:SetScrollChild(input)
	inScroll:HookScript("OnSizeChanged", function(self, w, h) input:SetWidth(w) end)
	inputBg:SetScript("OnMouseDown", function() input:SetFocus() end)
	ui.input = input

	local placeholder = inputBg:CreateFontString(nil, "OVERLAY", "GameFontDisable")
	placeholder:SetPoint("TOPLEFT", inScroll, "TOPLEFT", 0, 0)
	placeholder:SetPoint("RIGHT", inScroll, "RIGHT", 0, 0)
	placeholder:SetJustifyH("LEFT")
	placeholder:SetWordWrap(false)
	ui.placeholder = placeholder
	input:HookScript("OnTextChanged", function() Q.UpdatePlaceholder() end)
	input:HookScript("OnEditFocusGained", function() Q.UpdatePlaceholder() end)
	input:HookScript("OnEditFocusLost", function() Q.UpdatePlaceholder() end)
	Q.UpdatePlaceholder()

	local projectHost = ui.titleBar or inputBg
	local projectButton = CreateFrame("Button", "ClaudeWoWProjectButton", projectHost)
	if ui.titleBar then
		projectButton:SetSize(120, Q.NAV_H - 10)
		projectButton:SetPoint("RIGHT", projectHost, "RIGHT", -Cli.PROJECT_PAD, 0)
		ui.chatTitle:SetPoint("RIGHT", projectButton, "LEFT", -Cli.PROJECT_PAD, 0)
	else
		projectButton:SetSize(120, 16)
		projectButton:SetPoint("BOTTOMRIGHT", projectHost, "BOTTOMRIGHT", -6, 4)
	end
	projectButton:SetFrameLevel((Try(projectHost.GetFrameLevel, projectHost) or 1) + 5)
	projectButton.text = projectButton:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	projectButton.text:SetPoint("RIGHT", projectButton, "RIGHT", -2, 0)
	projectButton.text:SetJustifyH("RIGHT")
	projectButton.text:SetWordWrap(false)
	local projectHl = projectButton:CreateTexture(nil, "HIGHLIGHT")
	projectHl:SetAllPoints()
	projectHl:SetColorTexture(1, 1, 1, 0.08)
	projectButton:RegisterForClicks("LeftButtonUp")
	projectButton:SetScript("OnClick", function(self)
		GameTooltip:Hide()
		Cli.ProjectMenu(self)
	end)
	projectButton:SetScript("OnEnter", Cli.ProjectButtonTooltip)
	projectButton:SetScript("OnLeave", function() GameTooltip:Hide() end)
	projectHost:HookScript("OnSizeChanged", function() Cli.LayoutHeaderButtons() end)
	ui.projectButton = projectButton

	ui.mcpButton = Q.HeaderButton(projectHost, "ClaudeWoWMcpButton", projectButton, Cli.McpMenu, Cli.McpButtonTooltip)

	local send = MakeButton(f, "Send", SEND_W, ClaudeWoW.SendFromInput)
	Q.BesideInput(send, inputBg, native)
	send:SetScript("OnEnter", Q.SendTooltip)
	send:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.send = send

	local effort = Q.HeaderButton(f, "ClaudeWoWEffortButton", send, Cli.EffortMenu, Cli.EffortButtonTooltip)
	effort:ClearAllPoints()
	effort:SetSize(SEND_W, Q.EFFORT_H)
	effort:SetPoint("BOTTOMRIGHT", send, "TOPRIGHT", 0, Q.EFFORT_GAP)
	Cli.EffortBars(effort)
	ui.effort = effort

	local stop = MakeButton(inputBg, "Stop", Q.STOP_W, function() ClaudeWoW.Cancel(ActiveChat()) end)
	stop:SetHeight(Q.STOP_H)
	if ui.titleBar then
		stop:SetPoint("BOTTOMRIGHT", inputBg, "BOTTOMRIGHT", -Q.STOP_INSET, Q.STOP_INSET)
	else
		stop:SetPoint("TOPRIGHT", inputBg, "TOPRIGHT", -Q.STOP_INSET, -Q.STOP_INSET)
	end
	stop:SetFrameLevel((Try(inputBg.GetFrameLevel, inputBg) or 1) + 6)
	stop:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Stop this run")
		GameTooltip:AddLine("Ends the run this chat is waiting on and frees the chat for a new message. Same as /claude cancel.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	stop:SetScript("OnLeave", function() GameTooltip:Hide() end)
	stop:Hide()
	stop:SetScript("OnShow", function() Q.InsetComposer(true) end)
	stop:SetScript("OnHide", function() Q.InsetComposer(false) end)
	ui.stop = stop

	local connect = MakeButton(f, "Connect", SEND_W, function() ClaudeWoW.Connect(true) end)
	Q.BesideInput(connect, inputBg, native)
	connect:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_TOP")
		GameTooltip:SetText("Connect to the companion app")
		GameTooltip:AddLine("Start the companion app on this computer, then click here. The light turns green when it answers.", 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
	end)
	connect:SetScript("OnLeave", function() GameTooltip:Hide() end)
	connect:Hide()
	ui.connect = connect

	-- Reload is the fallback transport's button; it sits apart on the right and
	-- only shows when a reload would do something (see UpdateStatus).
	local refresh = MakeButton(f, "Reload", 70, function() SafeReload() end)
	refresh:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -24, 16)
	refresh:Hide()
	ui.refresh = refresh

	local clear = MakeButton(f, "Clear", 60, function() ClaudeWoW.ConfirmClear() end)
	clear:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 16)

	local resend = MakeButton(f, "Resend", 70, ClaudeWoW.Resend)
	resend:SetPoint("LEFT", clear, "RIGHT", 6, 0)
	resend:SetScript("OnEnter", Q.ResendTooltip)
	resend:SetScript("OnLeave", function() GameTooltip:Hide() end)
	resend:Hide()
	ui.resend = resend
	if native then
		clear:Hide()
		resend:ClearAllPoints()
		resend:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -26, 4)
		refresh:ClearAllPoints()
		refresh:SetPoint("RIGHT", resend, "LEFT", -4, 0)
	end

	local legacyHotkey = CreateFrame("Button", Q.LEGACY_BIND_BUTTON, UIParent)
	legacyHotkey:SetSize(1, 1)
	legacyHotkey:SetPoint("TOPLEFT", UIParent, "TOPLEFT", -10, 10)
	legacyHotkey:SetScript("OnClick", function() ClaudeWoW.ToggleWorkspace() end)
	Q.MigrateLegacyBinding()

	local grip = CreateFrame("Button", nil, f)
	grip:SetSize(16, 16)
	grip:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -5, 5)
	grip:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
	grip:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
	grip:SetPushedTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Down")

	f:HookScript("OnSizeChanged", Q.LayoutListWidth)
	if ClaudeWoWWindow then ClaudeWoWWindow.Attach(f, grip) end
	Q.LayoutListWidth()
end
ns.BuildUI = BuildUI

function ClaudeWoW.Toggle(show)
	if not ui.frame then return end
	if show == nil then show = not ui.frame:IsShown() end
	if show then
		local c = ActiveChat()
		if c then c.unread = 0 end
	end
	if not show then ui.quitting = true end
	ui.frame:SetShown(show)
	ui.quitting = nil
	ns.db.settings.shown = show
	if show then
		ClaudeWoW.Render()
		-- No auto-focus: the game keeps the keyboard until you click the box.
		-- No automatic hello either: if the bridge hasn't been seen, the panel
		-- shows Connect in place of Send and waits for a click.
	end
end

function ClaudeWoW.Suspend(hidden)
	if not ui.frame or not ns.db then return false end
	if hidden then
		if not ui.frame:IsShown() then return false end
		ui.quitting = true
		ui.frame:Hide()
		ui.quitting = nil
		return true
	end
	if not ns.db.settings.shown or ui.frame:IsShown() then return false end
	ui.frame:Show()
	ClaudeWoW.Render()
	return true
end

function ClaudeWoW.OpenWorkspace(chatId, focus)
	if not ui.frame then return end
	if chatId and FindChat(chatId) and ns.db.activeChat ~= chatId then ClaudeWoW.SwitchChat(chatId) end
	ClaudeWoW.Toggle(true)
	if focus and ui.input then ui.input:SetFocus() end
end

function ClaudeWoW.ToggleWorkspace()
	if not ui.frame then return end
	if ui.frame:IsShown() then
		ClaudeWoW.Toggle(false)
	else
		ClaudeWoW.OpenWorkspace()
	end
end

function ClaudeWoW.ClearChat(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if c then wipe(c.history) end
	ClaudeWoW.Render()
end
