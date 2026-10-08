local T = {}
ClaudeWoWDM = T

local FRAME_NAME = "ClaudeWoWDMFrame"
local FRAME_WIDTH = 338
local FRAME_HEIGHT = 496
local FRAME_TITLE = "Dungeon Master"
local PARCHMENT_X = 7
local PARCHMENT_Y = -62
local PARCHMENT_WIDTH = 322
local PARCHMENT_HEIGHT = 404
local TEXT_X = 20
local TEXT_Y = -18
local TEXT_WIDTH = 286
local LINE_GAP = 10
local HINT_X = 16
local HINT_Y = 12
local TITLE_MAX = 60
local LINE_MAX = 400
local LINES_MAX = 8
local BEAT_ID_MAX = 16
local MAX_DATA_AGE_SECONDS = 300
local SIGNATURE_SEPARATOR = "\031"
local HINT_TEXT = "Click Continue, or type /dm next, when you are ready to go on."
local EMPTY_TITLE = "The Dungeon Master has no story for you yet."
local EMPTY_BODY = "A live agent session starts a campaign. Its first beat shows here."
local READY_TITLE = "The story is ready."
local READY_HINT = "Click Continue, or type /dm next, to begin."
local CONTINUE_LABEL = "Continue"
local CONTINUE_WIDTH = 96
local CONTINUE_HEIGHT = 22
local CONTINUE_X = -14
local CONTINUE_Y = 10
local CONTINUE_HOLD_SECONDS = 5
local CHAT_PREFIX = "|cff66ccff[Azeroth Companion]|r "
local PORTRAIT = "Interface\\AddOns\\ClaudeWoW\\Portrait"
local PARCHMENT_FALLBACK_COLOR = { 0.80, 0.70, 0.52, 1 }
local INK = { 0.18, 0.12, 0.06 }
local INK_DIM = { 0.38, 0.30, 0.20 }

T.LAYOUT = {
	frameHeight = FRAME_HEIGHT,
	parchmentTop = -PARCHMENT_Y,
	parchmentHeight = PARCHMENT_HEIGHT,
	textTop = -TEXT_Y,
	titleHeight = 24,
	lineGap = LINE_GAP,
	bodyHeight = 320,
	bodyLineHeight = 15,
	bodyMaxLines = 21,
	hintSpace = HINT_Y + 18,
}
T.TEMPLATES = { frame = "ButtonFrameTemplate", plain = "BackdropTemplate", close = "UIPanelCloseButton", button = "UIPanelButtonTemplate" }
T.FONTS = {
	title = { "QuestTitleFont", "GameFontNormalLarge" },
	body = { "QuestFont", "GameFontHighlight" },
	hint = { "QuestFontNormalSmall", "GameFontNormalSmall" },
}

T.debug = { renders = 0, native = {} }

local frame
local watcher

local function CanAddMessage(f)
	return type(f) == "table" and type(f.AddMessage) == "function"
end

local function OutputFrame(editBox)
	local typedIn = type(editBox) == "table" and editBox.chatFrame
	if CanAddMessage(typedIn) then return typedIn end
	if CanAddMessage(DEFAULT_CHAT_FRAME) then return DEFAULT_CHAT_FRAME end
	return nil
end

local function Print(msg, editBox)
	local out = OutputFrame(editBox)
	if out then
		out:AddMessage(CHAT_PREFIX .. msg)
	else
		print(CHAT_PREFIX .. msg)
	end
end

function T.TemplateExists(name)
	if type(C_XMLUtil) ~= "table" or type(C_XMLUtil.GetTemplateInfo) ~= "function" then return false end
	local ok, info = pcall(C_XMLUtil.GetTemplateInfo, name)
	return ok and info ~= nil
end

local function FontName(pair)
	return _G[pair[1]] ~= nil and pair[1] or pair[2]
end

local function Clip(value, max)
	local s = tostring(value or ""):gsub("%c", " ")
	if #s > max then s = s:sub(1, max) end
	return (s:gsub("|", "||"))
end

local function PlayQuestSound(key)
	if type(SOUNDKIT) == "table" and SOUNDKIT[key] and type(PlaySound) == "function" then pcall(PlaySound, SOUNDKIT[key]) end
end

function T.CharacterKey()
	if ClaudeWoWOrders and type(ClaudeWoWOrders.CharacterKey) == "function" then return ClaudeWoWOrders.CharacterKey() end
	return nil
end

local function Applies(data)
	local key = T.CharacterKey()
	return key ~= nil and type(data.char) == "string" and key == data.char
end

local function Normalize(data)
	local view = { manual = data.manual == true }
	local beat = type(data.beat) == "table" and data.beat or nil
	if beat and type(beat.title) == "string" and beat.title ~= "" then
		view.beat = { id = Clip(beat.id, BEAT_ID_MAX), title = Clip(beat.title, TITLE_MAX), lines = {} }
		for _, line in ipairs(type(beat.lines) == "table" and beat.lines or {}) do
			if #view.beat.lines >= LINES_MAX then break end
			if type(line) == "string" and line ~= "" then table.insert(view.beat.lines, Clip(line, LINE_MAX)) end
		end
	end
	return view
end

local function Signature(view)
	local parts = { tostring(view.manual) }
	if view.beat then
		table.insert(parts, view.beat.id)
		table.insert(parts, view.beat.title)
		for _, line in ipairs(view.beat.lines) do table.insert(parts, line) end
	end
	return table.concat(parts, SIGNATURE_SEPARATOR)
end

local function TextString(parent, pair, color)
	local fs = parent:CreateFontString(nil, "ARTWORK", FontName(pair))
	fs:SetWidth(TEXT_WIDTH)
	fs:SetJustifyH("LEFT")
	fs:SetWordWrap(true)
	fs:SetTextColor(color[1], color[2], color[3])
	return fs
end

local function BuildFrame()
	if T.TemplateExists(T.TEMPLATES.frame) then
		local ok, f = pcall(CreateFrame, "Frame", FRAME_NAME, UIParent, T.TEMPLATES.frame)
		if ok and type(f) == "table" then
			T.debug.native.frame = true
			return f
		end
	end
	T.debug.native.frame = false
	T.debug.native.plain = T.TemplateExists(T.TEMPLATES.plain)
	return CreateFrame("Frame", FRAME_NAME, UIParent, T.debug.native.plain and T.TEMPLATES.plain or nil)
end

local function DecorateNative(f)
	if type(f.Inset) == "table" then f.Inset:Hide() end
	if type(f.SetPortraitToAsset) == "function" then pcall(f.SetPortraitToAsset, f, PORTRAIT) end
	local titled = type(f.SetTitle) == "function" and pcall(f.SetTitle, f, FRAME_TITLE)
	if not titled then
		local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
		title:SetPoint("TOP", f, "TOP", 0, -5)
		title:SetText(FRAME_TITLE)
	end
end

local function DecoratePlain(f)
	if type(f.SetBackdrop) == "function" and type(BACKDROP_DIALOG_32_32) == "table" then pcall(f.SetBackdrop, f, BACKDROP_DIALOG_32_32) end
	local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	title:SetPoint("TOP", f, "TOP", 0, -14)
	title:SetText(FRAME_TITLE)
	if T.TemplateExists(T.TEMPLATES.close) then
		local close = CreateFrame("Button", nil, f, T.TEMPLATES.close)
		close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -4, -4)
		T.debug.close = T.TEMPLATES.close
	else
		T.debug.close = "none"
	end
end

local function BuildParchment(f)
	local area = CreateFrame("Frame", nil, f)
	area:SetPoint("TOPLEFT", f, "TOPLEFT", PARCHMENT_X, PARCHMENT_Y)
	area:SetSize(PARCHMENT_WIDTH, PARCHMENT_HEIGHT)
	local paper = area:CreateTexture(nil, "BACKGROUND", nil, 1)
	paper:SetPoint("TOPLEFT", area, "TOPLEFT", 0, 0)
	paper:SetSize(PARCHMENT_WIDTH, PARCHMENT_HEIGHT)
	f.parchmentArea = area
	local paint = ClaudeWoW and ClaudeWoW.PaintParchment
	local ok, art = false, nil
	if type(paint) == "function" then ok, art = pcall(paint, paper) end
	if ok and art then
		T.debug.parchment = art
	else
		paper:SetColorTexture(PARCHMENT_FALLBACK_COLOR[1], PARCHMENT_FALLBACK_COLOR[2], PARCHMENT_FALLBACK_COLOR[3], PARCHMENT_FALLBACK_COLOR[4])
		T.debug.parchment = "color"
	end
	T.debug.parchmentSize = PARCHMENT_WIDTH .. "x" .. PARCHMENT_HEIGHT
	return paper
end

local function BoundBody(body)
	body:SetHeight(T.LAYOUT.bodyHeight)
	if type(body.SetMaxLines) == "function" then pcall(body.SetMaxLines, body, T.LAYOUT.bodyMaxLines) end
	T.debug.bodyMaxLines = T.LAYOUT.bodyMaxLines
end

function T.ContinueReady()
	return T.continueClickedAt == nil
end

local function UpdateContinue(manual)
	local b = frame and frame.continue
	if not b then return end
	b:SetShown(manual == true)
	if T.ContinueReady() then b:Enable() else b:Disable() end
end

function T.Continue()
	if not T.ContinueReady() then return end
	local clickedAt = GetTime()
	T.continueClickedAt = clickedAt
	UpdateContinue(true)
	if type(C_Timer) == "table" and type(C_Timer.After) == "function" then
		C_Timer.After(CONTINUE_HOLD_SECONDS, function()
			if T.continueClickedAt ~= clickedAt then return end
			T.continueClickedAt = nil
			UpdateContinue(T.view ~= nil and T.view.manual)
		end)
	end
	T.Next()
end

local function BuildContinue(f)
	local b = CreateFrame("Button", nil, f, T.TEMPLATES.button)
	b:SetSize(CONTINUE_WIDTH, CONTINUE_HEIGHT)
	b:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", CONTINUE_X, CONTINUE_Y)
	b:SetText(CONTINUE_LABEL)
	b:SetScript("OnClick", function() T.Continue() end)
	b:Hide()
	return b
end

local function BuildParts(f)
	f:SetSize(FRAME_WIDTH, FRAME_HEIGHT)
	f:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 16, -116)
	f:SetFrameStrata("MEDIUM")
	f:SetClampedToScreen(true)
	f:EnableMouse(true)
	f:SetMovable(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", f.StartMoving)
	f:SetScript("OnDragStop", f.StopMovingOrSizing)
	if T.debug.native.frame then DecorateNative(f) else DecoratePlain(f) end
	f.paper = BuildParchment(f)
	local page = f.parchmentArea
	f.beatTitle = TextString(page, T.FONTS.title, INK)
	f.body = TextString(page, T.FONTS.body, INK)
	f.body:SetJustifyV("TOP")
	BoundBody(f.body)
	f.hint = TextString(page, T.FONTS.hint, INK_DIM)
	f.hint:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", HINT_X, HINT_Y)
	f.hint:SetWidth(FRAME_WIDTH - HINT_X - CONTINUE_WIDTH + CONTINUE_X - LINE_GAP)
	f.continue = BuildContinue(f)
	f:SetScript("OnHide", function() PlayQuestSound("IG_QUEST_LIST_CLOSE") end)
	if type(UISpecialFrames) == "table" then table.insert(UISpecialFrames, FRAME_NAME) end
	f:Hide()
end

local function Build()
	local f = BuildFrame()
	frame = f
	local ok, err = pcall(BuildParts, f)
	if not ok then f.buildError = err end
end

local function PlaceText(title, body, hint, hintShown)
	frame.beatTitle:ClearAllPoints()
	frame.beatTitle:SetPoint("TOPLEFT", frame.paper, "TOPLEFT", TEXT_X, TEXT_Y)
	frame.beatTitle:SetText(title)
	frame.body:ClearAllPoints()
	frame.body:SetPoint("TOPLEFT", frame.beatTitle, "BOTTOMLEFT", 0, -LINE_GAP)
	frame.body:SetText(body)
	frame.hint:SetText(hint)
	frame.hint:SetShown(hintShown)
end

local function Layout(view)
	frame.emptyState = view.beat == nil
	UpdateContinue(view.manual)
	if view.beat then
		PlaceText(view.beat.title, table.concat(view.beat.lines, "\n"), HINT_TEXT, view.manual)
	elseif view.manual then
		PlaceText(READY_TITLE, "", READY_HINT, true)
	else
		PlaceText(EMPTY_TITLE, EMPTY_BODY, "", false)
	end
end

local function ReportError(err, editBox)
	local text = tostring(err)
	if text == T.debug.lastError then return end
	T.debug.lastError = text
	Print("the DM frame could not be drawn: " .. text, editBox)
end

local function InCombat()
	return type(InCombatLockdown) == "function" and InCombatLockdown() == true
end

local function Reveal()
	if InCombat() then
		T.showAfterCombat = true
		return
	end
	frame:Show()
	PlayQuestSound("IG_QUEST_LIST_OPEN")
end

local function ShowingEmptyState()
	return frame ~= nil and frame.emptyState == true and frame:IsShown()
end

local function Draw(view, reveal)
	if not view.beat and not reveal and not ShowingEmptyState() then
		if frame then frame:Hide() end
		return
	end
	if not frame then Build() end
	if frame.buildError then error(frame.buildError, 0) end
	Layout(view)
	if reveal then Reveal() end
	T.debug.renders = T.debug.renders + 1
	T.debug.lastError = nil
end

local function DrawFailed(err, editBox)
	if frame then pcall(frame.Hide, frame) end
	ReportError(err, editBox)
end

function T.Sync(data)
	if type(data) ~= "table" then return end
	local view = Applies(data) and Normalize(data) or Normalize({})
	local signature = Signature(view)
	if signature == T.signature then return end
	T.continueClickedAt = nil
	local previous = T.view and T.view.beat
	local isNewBeat = view.beat ~= nil and (previous == nil or previous.id ~= view.beat.id or previous.title ~= view.beat.title)
	if not view.beat then T.showAfterCombat = nil end
	local ok, err = pcall(Draw, view, isNewBeat)
	if not ok then
		DrawFailed(err)
		T.signature, T.view = nil, nil
		return
	end
	if not view.beat then T.debug.lastError = nil end
	T.signature, T.view = signature, view
end

local function Fresh(data)
	local stamp = tonumber(data.now)
	return stamp ~= nil and time() - stamp <= MAX_DATA_AGE_SECONDS
end

function T.SyncInbox(data)
	if type(data) ~= "table" then return end
	return T.Sync(Fresh(data) and data or {})
end

function T.SyncSlot(data)
	if type(data) ~= "table" or not Fresh(data) then return end
	return T.Sync(data)
end

function T.Frame()
	return frame
end

function T.Toggle(editBox)
	if frame and frame:IsShown() then
		frame:Hide()
		return
	end
	local ok, err = pcall(Draw, T.view or Normalize({}), true)
	if not ok then
		DrawFailed(err, editBox)
		T.signature = nil
		return
	end
	if T.showAfterCombat then Print("The Dungeon Master shows after combat.", editBox) end
end

local NEXT_REPLIES = {
	sent = "Asked the companion app for the next beat. It shows here as soon as the companion app has it.",
	busy = "The last /dm next is still on its way. Wait a moment.",
	unsupported = "This companion app cannot take /dm next. Update the companion app, then /reload.",
	reload = "/dm next needs the addon to reach the companion app without a reload (/claude mode pixel).",
	nochar = "The game did not name your character, so the companion app cannot tell whose story this is.",
}

function T.Next(editBox)
	if not T.view or (not T.view.beat and not T.view.manual) then
		Print("There is no campaign beat waiting for /dm next.", editBox)
		return
	end
	if not T.view.manual then
		Print("The next beat starts on its own when its moment comes, not with /dm next.", editBox)
		return
	end
	local result = ClaudeWoW and type(ClaudeWoW.SendDmNext) == "function" and ClaudeWoW.SendDmNext(T.CharacterKey()) or "unsupported"
	Print(NEXT_REPLIES[result] or NEXT_REPLIES.unsupported, editBox)
end

function T.Command(rest, editBox)
	local word = tostring(rest or ""):lower():match("^%s*(%S*)")
	if word == "" then
		T.Toggle(editBox)
	elseif word == "next" then
		T.Next(editBox)
	else
		Print("/dm shows or hides the Dungeon Master. /dm next goes on to the next beat when it waits for you.", editBox)
	end
end

SLASH_CLAUDEWOWDM1 = "/dm"
SlashCmdList.CLAUDEWOWDM = T.Command

watcher = CreateFrame("Frame")
pcall(watcher.RegisterEvent, watcher, "PLAYER_REGEN_ENABLED")
watcher:SetScript("OnEvent", function()
	if not T.showAfterCombat then return end
	T.showAfterCombat = nil
	if frame and not frame.buildError then
		frame:Show()
		PlayQuestSound("IG_QUEST_LIST_OPEN")
	end
end)
