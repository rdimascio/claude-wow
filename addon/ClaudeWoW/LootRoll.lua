local R = {}
ClaudeWoWRoll = R

local ROLL_SECONDS = 60
local EPIC_COLOR = { 0.64, 0.21, 0.93 }
local LOOT_TOAST = "Interface\\LootFrame\\LootToast"
local LOOT_TOAST_BACKGROUND_COORDS = { 0.28222656, 0.55273438, 0.30859375, 0.57031250 }
local LOOT_TOAST_BORDER_COORDS = { 0.00097656, 0.28027344, 0.43750000, 0.73437500 }
local EPIC_ICON_BORDER_ATLAS = "loottoast-itemborder-purple"
local TIMER_BAR = "Interface\\PaperDollInfoFrame\\UI-Character-Skills-Bar"
local SCROLL_ICON = "Interface\\Icons\\INV_Scroll_03"
local GEAR_ICON = "Interface\\Icons\\Trade_Engineering"

local DETAIL_GAP = 4
local DETAIL_PAD = 6
local DETAIL_RULES_SHOWN = 3
local DETAIL_COMMAND_CHARS = 90
local TOAST_WIDTH, TOAST_HEIGHT = 277, 67
local FALLBACK_BOTTOM = 240
local HEADER_TEXT = "Azeroth Companion asks"
local CLICK_DELAY = 0.5
local RELEASE_DELAY = 1
local HOLD_TICK = 0.25
local GROUP_LOOT_FRAMES = 4
local HOLD_TEXT = {
	combat = "A permission request is waiting until combat ends.",
	loot = "A permission request is waiting until the loot roll closes.",
}

local ROLL_BUTTONS = {
	need = { atlas = "lootroll-toast-icon-need", file = "Interface\\Buttons\\UI-GroupLoot-Dice", label = NEED or "Need" },
	greed = { atlas = "lootroll-toast-icon-greed", file = "Interface\\Buttons\\UI-GroupLoot-Coin", label = GREED or "Greed" },
	pass = { atlas = "lootroll-toast-icon-pass", file = "Interface\\Buttons\\UI-GroupLoot-Pass", label = PASS or "Pass" },
}
local CHOICE_ORDER = { "greed", "need", "pass" }

local SOUND_KIT_IDS = {
	UI_EPICLOOT_TOAST = 31578,
	UI_NEED_ROLL_POSITIVE = 229319,
	LOOT_WINDOW_COIN_SOUND = 120,
	UI_NEED_ROLL_NEGATIVE = 229321,
}
local SOUND_ON_OFFER = "UI_EPICLOOT_TOAST"
local SOUND_ON_CHOICE = { need = "UI_NEED_ROLL_POSITIVE", greed = "LOOT_WINDOW_COIN_SOUND", pass = "UI_NEED_ROLL_NEGATIVE" }

local frame
local current
local parked
local queue = {}
local hold
local holdTicker

local function PlayKit(name)
	local id = (SOUNDKIT and SOUNDKIT[name]) or SOUND_KIT_IDS[name]
	if id and PlaySound then pcall(PlaySound, id) end
end

local function AtlasExists(atlas)
	return C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists(atlas) or false
end

local function FolderOf(rule)
	return tostring(rule):match("^AddDir%((.+)%)$")
end

function R.Hint(choice, rules, chatId, agent)
	if not ROLL_BUTTONS[choice] then return "" end
	return ClaudeWoW.GrantText(chatId, choice, rules, agent)
end

function R.CommandOf(rule)
	local folder = FolderOf(rule)
	if folder then return folder end
	local tool, inside = tostring(rule):match("^([%w_]+)%((.*)%)$")
	if not tool then return tostring(rule) end
	local prefix = inside:match("^(.-):%*$")
	return prefix or inside
end

function R.ItemName(rules)
	local first = tostring(rules[1])
	local name = (first:match("^Bash%(") or FolderOf(first)) and ("Scroll of " .. R.CommandOf(first)) or R.CommandOf(first)
	if #rules > 1 then name = name .. " +" .. (#rules - 1) end
	return name
end

function R.IconFor(rules)
	for _, rule in ipairs(rules) do
		if tostring(rule):match("^Bash") or FolderOf(rule) then return SCROLL_ICON end
	end
	return GEAR_ICON
end

local function AgentLabel(agent)
	if type(agent) ~= "string" or agent == "" then return "The agent" end
	return agent:sub(1, 1):upper() .. agent:sub(2)
end

local function SameOffer(offer, chatId, msgId)
	return offer ~= nil and offer.chatId == chatId and offer.msgId == msgId
end

local function StillOpen(offer)
	local rules, msgId = ClaudeWoW.OpenDenial(offer.chatId)
	return rules ~= nil and msgId == offer.msgId
end

local function SameRules(a, b)
	if type(a) ~= "table" or type(b) ~= "table" or #a ~= #b then return false end
	for i = 1, #a do
		if a[i] ~= b[i] then return false end
	end
	return true
end

local function Snapshot(chatId)
	local rules, msgId, agent = ClaudeWoW.OpenDenial(chatId)
	if not rules then return nil end
	local copied = {}
	for i, rule in ipairs(rules) do copied[i] = rule end
	local target, plugin = ClaudeWoW.GrantTarget(chatId)
	return {
		key = tostring(chatId) .. ":" .. tostring(msgId),
		chatId = chatId,
		msgId = msgId,
		rules = copied,
		agent = agent,
		target = target,
		plugin = plugin,
	}
end

local function Unchanged(offer)
	local rules = ClaudeWoW.OpenDenial(offer.chatId)
	if not rules or not SameRules(rules, offer.rules) then return false end
	local target, plugin = ClaudeWoW.GrantTarget(offer.chatId)
	return target == offer.target and plugin == offer.plugin
end

function R.Blocked()
	if InCombatLockdown and InCombatLockdown() then return "combat" end
	for i = 1, GROUP_LOOT_FRAMES do
		local roll = _G["GroupLootFrame" .. i]
		if type(roll) == "table" and type(roll.IsShown) == "function" and roll:IsShown() then return "loot" end
	end
	return nil
end

local function IsLive(offer)
	return offer ~= nil and ClaudeWoW.IsLiveChat(offer.chatId)
end

local function Choices(offer)
	if IsLive(offer) then return { "greed", "pass" } end
	return CHOICE_ORDER
end

local function Clip(text, max)
	text = tostring(text or "")
	if #text <= max then return text end
	return text:sub(1, max - 3) .. "..."
end

local function Plain(text)
	return (tostring(text or ""):gsub("|", "||"))
end

function R.DetailLines(offer)
	local lines = {}
	for i, rule in ipairs(offer.rules) do
		if i > DETAIL_RULES_SHOWN then
			table.insert(lines, "|cffffffffand " .. (#offer.rules - DETAIL_RULES_SHOWN) .. " more|r")
			break
		end
		table.insert(lines, "|cffffffff" .. Plain(ClaudeWoW.GrantLabel(rule)) .. "|r")
	end
	local details = ClaudeWoW.DenialDetails(offer.chatId)
	if details[1] then table.insert(lines, "|cffbbbbbb" .. Plain(Clip(details[1], DETAIL_COMMAND_CHARS)) .. "|r") end
	table.insert(lines, "|cffffd100" .. ClaudeWoW.GrantText(offer.chatId, "scope", offer.rules, offer.agent) .. "|r")
	return lines
end

local function ShowItemTooltip(owner)
	local offer = current
	if not offer then return end
	GameTooltip:SetOwner(owner, "ANCHOR_RIGHT")
	GameTooltip:AddLine(R.ItemName(offer.rules), EPIC_COLOR[1], EPIC_COLOR[2], EPIC_COLOR[3])
	GameTooltip:AddLine(Plain(AgentLabel(offer.agent)) .. " was denied:", 1, 0.82, 0)
	for _, rule in ipairs(offer.rules) do
		local folder = FolderOf(rule)
		GameTooltip:AddLine(Plain(folder and ("Folder outside this chat: " .. folder) or rule), 1, 1, 1, true)
	end
	local details = ClaudeWoW.DenialDetails(offer.chatId)
	if #details > 0 then
		GameTooltip:AddLine(" ")
		GameTooltip:AddLine("What it tried:", 1, 0.82, 0)
		for _, detail in ipairs(details) do GameTooltip:AddLine(Plain(detail), 0.8, 0.8, 0.8, true) end
	end
	GameTooltip:AddLine(" ")
	for _, choice in ipairs(Choices(offer)) do
		local spec = ROLL_BUTTONS[choice]
		GameTooltip:AddLine(spec.label .. ": " .. R.Hint(choice, offer.rules, offer.chatId, offer.agent), 0.8, 0.8, 0.8, true)
	end
	GameTooltip:Show()
end

local function ShowButtonTooltip(button)
	local spec = ROLL_BUTTONS[button.choice]
	local offer = current
	GameTooltip:SetOwner(button, "ANCHOR_RIGHT")
	GameTooltip:AddLine(spec.label)
	if offer then GameTooltip:AddLine(R.Hint(button.choice, offer.rules, offer.chatId, offer.agent), 1, 1, 1, true) end
	GameTooltip:Show()
end

local function SetButtonArt(button, spec)
	if AtlasExists(spec.atlas .. "-up") and button.SetNormalAtlas then
		button:SetNormalAtlas(spec.atlas .. "-up")
		button:SetHighlightAtlas(spec.atlas .. "-highlight", "ADD")
		button:SetPushedAtlas(spec.atlas .. "-down")
	else
		button:SetNormalTexture(spec.file .. "-Up")
		button:SetHighlightTexture(spec.file .. "-Highlight", "ADD")
		button:SetPushedTexture(spec.file .. "-Down")
	end
end

local function RollButton(parent, choice)
	local b = CreateFrame("Button", nil, parent)
	b:SetSize(32, 32)
	b.choice = choice
	SetButtonArt(b, ROLL_BUTTONS[choice])
	b:SetScript("OnClick", function(self)
		if R.Armed() then R.Choose(self.choice) end
	end)
	b:SetScript("OnEnter", ShowButtonTooltip)
	b:SetScript("OnLeave", function() GameTooltip:Hide() end)
	return b
end

local function Build()
	local f = CreateFrame("Frame", "ClaudeWoWRollFrame", UIParent)
	f:SetSize(TOAST_WIDTH, TOAST_HEIGHT)
	f:SetFrameStrata("DIALOG")
	f:SetToplevel(true)
	f:SetClampedToScreen(true)
	f:SetMovable(true)
	f:EnableMouse(true)
	f:RegisterForDrag("LeftButton")
	f:SetScript("OnDragStart", function(self) self:StartMoving() end)
	f:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		self.userPlaced = true
	end)

	f.Background = f:CreateTexture(nil, "BACKGROUND")
	f.Background:SetTexture(LOOT_TOAST)
	f.Background:SetTexCoord(LOOT_TOAST_BACKGROUND_COORDS[1], LOOT_TOAST_BACKGROUND_COORDS[2], LOOT_TOAST_BACKGROUND_COORDS[3], LOOT_TOAST_BACKGROUND_COORDS[4])
	f.Background:SetSize(TOAST_WIDTH, TOAST_HEIGHT)
	f.Background:SetPoint("TOP", f, "TOP", 0, 0)

	f.Border = f:CreateTexture(nil, "BORDER")
	f.Border:SetTexture(LOOT_TOAST)
	f.Border:SetTexCoord(LOOT_TOAST_BORDER_COORDS[1], LOOT_TOAST_BORDER_COORDS[2], LOOT_TOAST_BORDER_COORDS[3], LOOT_TOAST_BORDER_COORDS[4])
	f.Border:SetSize(286, 76)
	f.Border:SetPoint("CENTER", f.Background, "CENTER")
	f.Border:SetVertexColor(EPIC_COLOR[1], EPIC_COLOR[2], EPIC_COLOR[3])

	f.IconFrame = CreateFrame("Button", nil, f)
	f.IconFrame:SetSize(34, 34)
	f.IconFrame:SetPoint("TOPLEFT", f, "TOPLEFT", 10, -11)
	f.IconFrame.Icon = f.IconFrame:CreateTexture(nil, "ARTWORK")
	f.IconFrame.Icon:SetAllPoints()
	f.IconFrame.Border = f.IconFrame:CreateTexture(nil, "OVERLAY")
	f.IconFrame.Border:SetSize(42, 42)
	f.IconFrame.Border:SetPoint("CENTER", f.IconFrame, "CENTER", 0, -2)
	if AtlasExists(EPIC_ICON_BORDER_ATLAS) then
		f.IconFrame.Border:SetAtlas(EPIC_ICON_BORDER_ATLAS)
	else
		f.IconFrame.Border:Hide()
	end
	f.IconFrame:SetScript("OnEnter", ShowItemTooltip)
	f.IconFrame:SetScript("OnLeave", function() GameTooltip:Hide() end)

	f.Header = f:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
	f.Header:SetPoint("TOPLEFT", f, "TOPLEFT", 60, -8)
	f.Header:SetJustifyH("LEFT")
	f.Header:SetText(HEADER_TEXT)

	f.Name = f:CreateFontString(nil, "ARTWORK", "GameFontNormal")
	f.Name:SetSize(125, 30)
	f.Name:SetPoint("TOPLEFT", f, "TOPLEFT", 60, -20)
	f.Name:SetJustifyH("LEFT")
	f.Name:SetJustifyV("MIDDLE")
	f.Name:SetTextColor(EPIC_COLOR[1], EPIC_COLOR[2], EPIC_COLOR[3])

	f.GreedButton = RollButton(f, "greed")
	f.GreedButton:SetPoint("TOPLEFT", f, "TOPLEFT", 202, -7)
	f.PassButton = RollButton(f, "pass")
	f.PassButton:SetPoint("LEFT", f.GreedButton, "RIGHT", 6, 2)
	f.NeedButton = RollButton(f, "need")
	f.NeedButton:SetPoint("TOP", f.GreedButton, "BOTTOM", 0, 5)

	f.Timer = CreateFrame("StatusBar", nil, f)
	f.Timer:SetSize(190, 8)
	f.Timer:SetPoint("BOTTOMLEFT", f.Background, "BOTTOMLEFT", 3, 2)
	f.Timer.Background = f.Timer:CreateTexture(nil, "BACKGROUND")
	f.Timer.Background:SetAllPoints()
	f.Timer.Background:SetColorTexture(0, 0, 0)
	f.Timer:SetStatusBarTexture(TIMER_BAR)
	f.Timer:SetStatusBarColor(1, 1, 0)
	f.Timer:SetMinMaxValues(0, ROLL_SECONDS)

	f.Details = CreateFrame("Frame", nil, f)
	f.Details:SetPoint("TOPLEFT", f, "TOPLEFT", DETAIL_GAP, -TOAST_HEIGHT)
	f.Details:SetWidth(TOAST_WIDTH - 2 * DETAIL_GAP)
	f.Details.Background = f.Details:CreateTexture(nil, "BACKGROUND")
	f.Details.Background:SetAllPoints()
	f.Details.Background:SetColorTexture(0, 0, 0, 0.75)
	f.Details.Text = f.Details:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
	f.Details.Text:SetPoint("TOPLEFT", f.Details, "TOPLEFT", DETAIL_PAD, -DETAIL_PAD)
	f.Details.Text:SetWidth(TOAST_WIDTH - 2 * DETAIL_GAP - 2 * DETAIL_PAD)
	f.Details.Text:SetJustifyH("LEFT")
	f.Details.Text:SetWordWrap(true)
	f.Details.Text:SetNonSpaceWrap(true)
	f.Details:EnableMouse(true)
	f.Details:SetScript("OnEnter", ShowItemTooltip)
	f.Details:SetScript("OnLeave", function() GameTooltip:Hide() end)

	f:SetScript("OnUpdate", function() R.Update() end)
	f:Hide()
	return f
end

function R.Place(f)
	if f.userPlaced then return end
	f:ClearAllPoints()
	f:SetPoint("BOTTOM", UIParent, "BOTTOM", 0, FALLBACK_BOTTOM)
end

local function SetButtonsEnabled(f, on)
	for _, button in ipairs({ f.GreedButton, f.NeedButton, f.PassButton }) do
		button:SetEnabled(on)
	end
	f.armed = on
end

local function Layout(f, offer)
	f.NeedButton:SetShown(not IsLive(offer))
	f.Details.Text:SetText(table.concat(R.DetailLines(offer), "\n"))
	local height = (f.Details.Text:GetStringHeight() or 0) + 2 * DETAIL_PAD
	f.Details:SetHeight(height)
	f:SetHeight(TOAST_HEIGHT + height)
end

local function HighlightGreed(f)
	f.GreedButton:LockHighlight()
end

local function HideFrame()
	if not frame then return end
	frame.GreedButton:UnlockHighlight()
	frame:Hide()
end

local PresentNext

local function Hold(reason)
	if hold then
		if reason then hold.clearSince = nil end
	else
		hold = {}
		ClaudeWoW.Print(HOLD_TEXT[reason] or HOLD_TEXT.combat)
	end
	if not holdTicker and C_Timer and C_Timer.NewTicker then
		holdTicker = C_Timer.NewTicker(HOLD_TICK, function() R.CheckHold() end)
	end
end

local function StopHold()
	hold = nil
	if holdTicker then
		holdTicker:Cancel()
		holdTicker = nil
	end
end

local function HoldOffer(offer)
	table.insert(queue, 1, offer)
	Hold(R.Blocked())
end

local function Present(offer)
	if ClaudeWoW.AllowPending(offer.chatId, offer.msgId) then
		parked = offer
		return
	end
	if hold or R.Blocked() then
		HoldOffer(offer)
		return
	end
	frame = frame or Build()
	current = offer
	offer.shownAt = GetTime()
	offer.expiresAt = offer.shownAt + ROLL_SECONDS
	SetButtonsEnabled(frame, false)
	frame.Name:SetText(R.ItemName(offer.rules))
	frame.IconFrame.Icon:SetTexture(R.IconFor(offer.rules))
	R.Place(frame)
	frame.Timer:SetValue(ROLL_SECONDS)
	frame:Show()
	Layout(frame, offer)
	HighlightGreed(frame)
	PlayKit(SOUND_ON_OFFER)
end

PresentNext = function()
	if current or parked then return end
	while #queue > 0 do
		local offer = table.remove(queue, 1)
		if StillOpen(offer) then
			Present(offer)
			return
		end
	end
end

local function CloseCurrent()
	current = nil
	HideFrame()
	PresentNext()
end

local function Rebuild(offer)
	current = nil
	HideFrame()
	local fresh = Snapshot(offer.chatId)
	if fresh then
		Present(fresh)
	else
		PresentNext()
	end
end

local function Release()
	StopHold()
	PresentNext()
end

function R.CheckHold()
	if not hold then return end
	if R.Blocked() then
		hold.clearSince = nil
		return
	end
	local now = GetTime()
	hold.clearSince = hold.clearSince or now
	if now - hold.clearSince < RELEASE_DELAY then return end
	Release()
end

function R.Armed()
	return current ~= nil and current.shownAt ~= nil and GetTime() - current.shownAt >= CLICK_DELAY
end

function R.Offer(chatId)
	local offer = Snapshot(chatId)
	if not offer then return end
	local key = offer.key
	if (current and current.key == key) or (parked and parked.key == key) then return end
	for _, queued in ipairs(queue) do
		if queued.key == key then return end
	end
	if current or parked or hold then
		table.insert(queue, offer)
	else
		Present(offer)
	end
end

function R.Choose(choice, reason)
	local offer = current
	if not offer or not ROLL_BUTTONS[choice] then return end
	if choice == "need" and IsLive(offer) then choice = "greed" end
	if choice ~= "pass" and StillOpen(offer) and not Unchanged(offer) then
		Rebuild(offer)
		return
	end
	if choice == "need" then
		ClaudeWoW.ConfirmAllow(offer.chatId, offer.msgId, offer.rules)
		return
	end
	local open = StillOpen(offer)
	current = nil
	HideFrame()
	if open then
		PlayKit(SOUND_ON_CHOICE[choice])
		if choice == "greed" then
			ClaudeWoW.AllowOnce(offer.chatId, offer.rules)
		else
			ClaudeWoW.PassOnDenial(offer.chatId, offer.rules, reason)
		end
	end
	PresentNext()
end

function R.Park(chatId, msgId)
	if not SameOffer(current, chatId, msgId) then return false end
	parked = current
	current = nil
	HideFrame()
	return true
end

function R.Requeue(chatId, msgId)
	if not SameOffer(parked, chatId, msgId) then return false end
	table.insert(queue, 1, parked)
	parked = nil
	return true
end

function R.Resume(chatId, msgId)
	if not SameOffer(parked, chatId, msgId) then
		PresentNext()
		return false
	end
	local offer = parked
	parked = nil
	if current then
		table.insert(queue, 1, offer)
	elseif StillOpen(offer) then
		Present(offer)
	else
		PresentNext()
	end
	return true
end

function R.Settle(chatId, msgId, granted)
	if not SameOffer(parked, chatId, msgId) then
		PresentNext()
		return false
	end
	parked = nil
	if granted then PlayKit(SOUND_ON_CHOICE.need) end
	PresentNext()
	return true
end

function R.Update()
	if not current then return end
	local blocked = R.Blocked()
	if blocked then
		local offer = current
		current = nil
		HideFrame()
		HoldOffer(offer)
		return
	end
	if not StillOpen(current) then
		CloseCurrent()
		return
	end
	if not Unchanged(current) then
		Rebuild(current)
		return
	end
	local left = current.expiresAt - GetTime()
	if left <= 0 then
		R.Choose("pass", "the roll timed out")
		return
	end
	if not frame.armed and R.Armed() then SetButtonsEnabled(frame, true) end
	frame.Timer:SetValue(left)
end

function R.CloseAll()
	wipe(queue)
	current = nil
	parked = nil
	StopHold()
	HideFrame()
end

function R.Held()
	return hold ~= nil
end

local events = CreateFrame("Frame")
events:RegisterEvent("PLAYER_REGEN_ENABLED")
events:SetScript("OnEvent", function()
	R.CheckHold()
	if hold and C_Timer and C_Timer.After then C_Timer.After(RELEASE_DELAY, R.CheckHold) end
end)

function R.Current()
	return current
end

function R.Parked()
	return parked
end

function R.Waiting()
	return #queue
end
