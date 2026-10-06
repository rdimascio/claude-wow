local H = {}
ClaudeWoWHelp = H

H.PAGE_TITLE = "Commands and tips"
H.ADDON_TITLE = (ClaudeWoW and ClaudeWoW.PRODUCT) or "Azeroth Companion"
H.SUBTITLE = "Type these in any chat box or in the " .. H.ADDON_TITLE .. " window."
H.FALLBACK_WIDTH = 560
H.WINDOW_W, H.WINDOW_H = 660, 560

local PAD = 16
local SCROLLBAR = 30
local INDENT = 14
local SECTION_GAP = 18
local HEADER_GAP = 8
local LINE_GAP = 2
local ROW_GAP = 8

local function Font(name, fallback)
	if _G[name] ~= nil then return name end
	return fallback
end

local function AddonTitle()
	local get = (C_AddOns and C_AddOns.GetAddOnMetadata) or GetAddOnMetadata
	if type(get) == "function" then
		local ok, title = pcall(get, "ClaudeWoW", "Title")
		if ok and type(title) == "string" and title ~= "" then return title end
	end
	return H.ADDON_TITLE
end
H.AddonTitle = AddonTitle

local function Sections()
	return (ClaudeWoW and type(ClaudeWoW.HELP) == "table") and ClaudeWoW.HELP or {}
end

local function Text(parent, font, text)
	local fs = parent:CreateFontString(nil, "ARTWORK", font)
	fs:SetJustifyH("LEFT")
	fs:SetJustifyV("TOP")
	fs:SetText(text)
	return fs
end

local function BuildContent(content)
	local items = {}
	local header = Font("GameFontHighlightLarge", "GameFontNormalLarge")
	local command = Font("GameFontNormal", "GameFontNormalSmall")
	local body = Font("GameFontHighlight", "GameFontHighlightSmall")
	local note = Font("GameFontHighlightSmall", body)
	for _, section in ipairs(Sections()) do
		table.insert(items, { fs = Text(content, header, section.title or ""), x = 0, before = #items > 0 and SECTION_GAP or 0, after = HEADER_GAP, kind = "header" })
		for _, row in ipairs(section.rows or {}) do
			table.insert(items, { fs = Text(content, command, row[1]), x = 0, after = LINE_GAP, kind = "command" })
			table.insert(items, { fs = Text(content, body, row[2]), x = INDENT, after = ROW_GAP, kind = "description" })
		end
		for _, line in ipairs(section.notes or {}) do
			table.insert(items, { fs = Text(content, note, line), x = 0, after = ROW_GAP, kind = "note" })
		end
	end
	return items
end

function H.Layout()
	local panel = H.panel
	if not panel then return 0 end
	local width = panel.scroll:GetWidth()
	if not width or width < 100 then width = H.FALLBACK_WIDTH end
	panel.content:SetWidth(width)
	local y = 0
	for _, item in ipairs(panel.items) do
		y = y + (item.before or 0)
		item.fs:ClearAllPoints()
		item.fs:SetPoint("TOPLEFT", panel.content, "TOPLEFT", item.x, -y)
		item.fs:SetWidth(width - item.x)
		y = y + item.fs:GetStringHeight() + item.after
	end
	panel.content:SetHeight(math.max(y, 1))
	return y
end

function H.Build()
	if H.panel then return H.panel end
	local panel = CreateFrame("Frame", "ClaudeWoWHelpPanel")
	panel:Hide()
	panel.name = AddonTitle()
	local title = Text(panel, Font("GameFontNormalLarge", "GameFontNormal"), H.PAGE_TITLE)
	title:SetPoint("TOPLEFT", panel, "TOPLEFT", PAD, -PAD)
	local subtitle = Text(panel, Font("GameFontHighlightSmall", "GameFontNormalSmall"), H.SUBTITLE)
	subtitle:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -8)
	local scroll = CreateFrame("ScrollFrame", "ClaudeWoWHelpScroll", panel, "UIPanelScrollFrameTemplate")
	scroll:SetPoint("TOPLEFT", subtitle, "BOTTOMLEFT", 0, -12)
	scroll:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -SCROLLBAR, PAD)
	local content = CreateFrame("Frame", "ClaudeWoWHelpContent", scroll)
	content:SetSize(H.FALLBACK_WIDTH, 1)
	scroll:SetScrollChild(content)
	panel.title, panel.subtitle, panel.scroll, panel.content = title, subtitle, scroll, content
	panel.items = BuildContent(content)
	H.panel = panel
	panel:SetScript("OnShow", function()
		H.Layout()
		scroll:SetVerticalScroll(0)
	end)
	panel:SetScript("OnSizeChanged", function() H.Layout() end)
	panel.OnRefresh = function() H.Layout() end
	return panel
end

function H.Register()
	if H.category or H.legacy then return true end
	local panel = H.Build()
	if type(Settings) == "table" and type(Settings.RegisterCanvasLayoutCategory) == "function" and type(Settings.RegisterAddOnCategory) == "function" then
		local ok, category = pcall(Settings.RegisterCanvasLayoutCategory, panel, panel.name)
		if ok and category then
			H.RegisterOptions(category)
			if pcall(Settings.RegisterAddOnCategory, category) then
				H.category = category
				return true
			end
		end
	end
	if type(InterfaceOptions_AddCategory) == "function" and pcall(InterfaceOptions_AddCategory, panel) then
		H.legacy = true
		H.RegisterLegacyOptions(panel.name)
		return true
	end
	return false
end

local function CategoryID(category)
	if type(category.GetID) == "function" then
		local ok, id = pcall(category.GetID, category)
		if ok and id ~= nil then return id end
	end
	return category.ID
end

function H.ShowWindow()
	local panel = H.Build()
	local win = H.window
	if not win then
		local ok, made = pcall(CreateFrame, "Frame", "ClaudeWoWHelpWindow", UIParent, "BasicFrameTemplateWithInset")
		win = ok and made or CreateFrame("Frame", "ClaudeWoWHelpWindow", UIParent, "BackdropTemplate")
		if not ok then
			local close = CreateFrame("Button", nil, win, "UIPanelCloseButton")
			close:SetPoint("TOPRIGHT", win, "TOPRIGHT", 0, 0)
		end
		win:SetSize(H.WINDOW_W, H.WINDOW_H)
		win:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
		win:SetFrameStrata("DIALOG")
		win:EnableMouse(true)
		win:SetMovable(true)
		win:RegisterForDrag("LeftButton")
		win:SetScript("OnDragStart", win.StartMoving)
		win:SetScript("OnDragStop", win.StopMovingOrSizing)
		if type(win.TitleText) == "table" then win.TitleText:SetText(panel.name) end
		if type(UISpecialFrames) == "table" then table.insert(UISpecialFrames, "ClaudeWoWHelpWindow") end
		H.window = win
	end
	panel:SetParent(win)
	panel:ClearAllPoints()
	panel:SetPoint("TOPLEFT", win, "TOPLEFT", 4, -24)
	panel:SetPoint("BOTTOMRIGHT", win, "BOTTOMRIGHT", -4, 4)
	win:Show()
	panel:Show()
	H.Layout()
	return "window"
end

function H.Open()
	if not H.Register() then return H.ShowWindow() end
	if H.category then
		if type(Settings.OpenToCategory) == "function" and pcall(Settings.OpenToCategory, CategoryID(H.category)) then return "settings" end
		return nil
	end
	if type(InterfaceOptionsFrame_OpenToCategory) == "function" and pcall(InterfaceOptionsFrame_OpenToCategory, H.panel) then
		pcall(InterfaceOptionsFrame_OpenToCategory, H.panel)
		return "interface"
	end
	return nil
end

H.OPTIONS_TITLE = "Options"
H.WIDGETS_TITLE = "Widgets"
H.VARIABLE_PREFIX = "CLAUDEWOW_OPTION_"
H.ROW_H = 30
H.WIDGET_ROWS_MAX = 12
H.DIM_CHOICES = { { "off", "Off" }, { "80", "80%" }, { "60", "60%" }, { "35", "35%" }, { "20", "20%" } }
H.ECHO_CHOICES = { { "summary", "Summary" }, { "short", "Short" }, { "full", "Full" }, { "off", "Off" } }
H.VOICE_LABELS = { race = "Your race", peasant = "Peasant", peon = "Peon", off = "Off" }

local function Saved()
	return (type(ClaudeWoWDB) == "table" and type(ClaudeWoWDB.settings) == "table") and ClaudeWoWDB.settings or {}
end

local function Config(command)
	if ClaudeWoW and type(ClaudeWoW.Config) == "function" then ClaudeWoW.Config(command) end
end

local function OnOff(value)
	return value and "on" or "off"
end

local function Switch(command)
	return function(value) Config(command .. " " .. OnOff(value)) end
end

local function MapNodes(kind)
	local mapDB = ClaudeWoWMapDB
	local nodes = type(mapDB) == "table" and type(mapDB.nodes) == "table" and mapDB.nodes
	return nodes and nodes[kind] == true or false
end

local function VoicePack()
	local voice = type(ClaudeWoWDB) == "table" and type(ClaudeWoWDB.voice) == "table" and ClaudeWoWDB.voice.pack
	return type(voice) == "string" and voice or "race"
end

local function DimValue()
	local dim = tonumber(Saved().dim) or 1
	if dim >= 1 then return "off" end
	return tostring(math.floor(dim * 100 + 0.5))
end

local function WithCurrent(list, current, label)
	for _, choice in ipairs(list) do
		if choice[1] == current then return list end
	end
	local out = { { current, label(current) } }
	for _, choice in ipairs(list) do out[#out + 1] = choice end
	return out
end

local function VoiceChoices()
	local names = (ClaudeWoWVoice and type(ClaudeWoWVoice.PACK_NAMES) == "table") and ClaudeWoWVoice.PACK_NAMES or { "race", "off" }
	local list = {}
	for _, name in ipairs(names) do list[#list + 1] = { name, H.VOICE_LABELS[name] or name } end
	return list
end

H.OPTIONS = {
	{
		key = "whisper", label = "Whisper tabs", default = true,
		tooltip = "Each chat is a whisper tab in the chat dock. Off: replies go to the game chat and the window.",
		get = function() return Saved().whisper == true end,
		set = Switch("ui whisper"),
	},
	{
		key = "dim", label = "Dim the window while you move", default = "35", choices = function() return WithCurrent(H.DIM_CHOICES, DimValue(), function(v) return v .. "%" end) end,
		tooltip = "How visible the window stays while you move or fight. It comes back when you stop or point at it.",
		get = DimValue,
		set = function(value) Config("ui dim " .. value) end,
	},
	{
		key = "dodge", label = "Move aside for game panels", default = true,
		tooltip = "The window steps aside when bags, the character sheet, a vendor or another panel opens.",
		get = function() return Saved().dodge == true end,
		set = Switch("ui dodge"),
	},
	{
		key = "autohide", label = "Hide behind the world map and menus", default = true,
		tooltip = "The window steps away while the full-screen map, the game menu or the settings are open.",
		get = function() return Saved().autohide == true end,
		set = Switch("ui autohide"),
	},
	{
		key = "echo", label = "Replies in the game chat", default = "summary",
		choices = function() return WithCurrent(H.ECHO_CHOICES, tostring(Saved().echo or "summary"), function(v) return v .. " characters" end) end,
		tooltip = "How much of each reply the game chat prints. Summary prints the agent's short version.",
		get = function() return tostring(Saved().echo or "summary") end,
		set = function(value) Config("echo " .. value) end,
	},
	{
		key = "voice", label = "Voice lines", default = "race", choices = VoiceChoices, module = "ClaudeWoWVoice",
		tooltip = "A short voice line when the agent starts, finishes or needs you.",
		get = VoicePack,
		set = function(value) Config("voice " .. value) end,
	},
	{
		key = "roast", label = "Death roasts", default = false, module = "ClaudeWoWRoast",
		tooltip = "When you die, the agent gets the death recap and writes a short roast in its own chat.",
		get = function() return type(ClaudeWoWDB) == "table" and type(ClaudeWoWDB.roast) == "table" and ClaudeWoWDB.roast.on == true end,
		set = Switch("roast"),
	},
	{
		key = "roll", label = "Ask with a roll window", default = true,
		tooltip = "A command the agent needs your OK for opens a Need, Greed or Pass roll. Off: an Allow button in the reply.",
		get = function() return Saved().lootRoll ~= false end,
		set = Switch("roll"),
	},
	{
		key = "achievements", label = "Achievement toasts", default = true, module = "ClaudeWoWAchievements",
		tooltip = "A toast when you earn one of the companion's achievements.",
		get = function() return Saved().toasts ~= false end,
		set = Switch("achievements"),
	},
	{
		key = "orders", label = "Orders card", default = true, module = "ClaudeWoWOrders",
		tooltip = "The agent's current order, in a card under the quest tracker.",
		get = function() return ClaudeWoWOrders.IsOn() and true or false end,
		set = Switch("orders"),
	},
	{
		key = "telemetry", label = "Share game state with the agent", default = true, module = "ClaudeWoWTelemetry",
		tooltip = "Your money, level, zone, professions, watched items, gear and reputation go to the bridge.",
		get = function() return ClaudeWoWTelemetry.IsOn() and true or false end,
		set = Switch("telemetry"),
	},
	{
		key = "ore", label = "Ore nodes on the world map", default = false, module = "ClaudeWoWMap",
		tooltip = "This character only.",
		get = function() return MapNodes("ore") end,
		set = Switch("map ore"),
	},
	{
		key = "herb", label = "Herb nodes on the world map", default = false, module = "ClaudeWoWMap",
		tooltip = "This character only.",
		get = function() return MapNodes("herb") end,
		set = Switch("map herb"),
	},
}

function H.Options()
	local list = {}
	for _, option in ipairs(H.OPTIONS) do
		if not option.module or _G[option.module] ~= nil then list[#list + 1] = option end
	end
	return list
end

function H.OptionValue(option)
	local ok, value = pcall(option.get)
	if ok and value ~= nil then return value end
	return option.default
end

function H.SetOption(option, value)
	if value == H.OptionValue(option) then return end
	option.set(value)
	if H.canvas then H.RefreshCanvas(H.canvas) end
end

local function ChoiceLabel(option, value)
	for _, choice in ipairs(option.choices()) do
		if choice[1] == value then return choice[2] end
	end
	return tostring(value)
end

local function NextChoice(option)
	local list, current = option.choices(), H.OptionValue(option)
	for i, choice in ipairs(list) do
		if choice[1] == current then return (list[i % #list + 1] or list[1])[1] end
	end
	return list[1][1]
end

local function DropdownOptions(option)
	return function()
		local container = Settings.CreateControlTextContainer()
		for _, choice in ipairs(option.choices()) do container:Add(choice[1], choice[2]) end
		return container:GetData()
	end
end

function H.AddProxyOption(category, option)
	local isChoice = option.choices ~= nil
	local varType = (Settings.VarType and (isChoice and Settings.VarType.String or Settings.VarType.Boolean)) or (isChoice and "string" or "boolean")
	local setting = Settings.RegisterProxySetting(category, H.VARIABLE_PREFIX .. option.key:upper(), varType, option.label, option.default,
		function() return H.OptionValue(option) end,
		function(value) H.SetOption(option, value) end)
	if isChoice then
		Settings.CreateDropdown(category, setting, DropdownOptions(option), option.tooltip)
	else
		Settings.CreateCheckbox(category, setting, option.tooltip)
	end
	return setting
end

local function CanUseProxies()
	return type(Settings.RegisterVerticalLayoutSubcategory) == "function" and type(Settings.RegisterProxySetting) == "function"
		and type(Settings.CreateCheckbox) == "function" and type(Settings.CreateDropdown) == "function"
		and type(Settings.CreateControlTextContainer) == "function"
end

function H.RegisterOptions(parent)
	if H.optionsCategory or H.optionsPanel then return true end
	if type(Settings) ~= "table" then return false end
	H.settings = {}
	if CanUseProxies() then
		local ok, category = pcall(Settings.RegisterVerticalLayoutSubcategory, parent, H.OPTIONS_TITLE)
		if ok and category then
			H.optionsCategory = category
			for _, option in ipairs(H.Options()) do
				local added, setting = pcall(H.AddProxyOption, category, option)
				if added then H.settings[option.key] = setting end
			end
			if type(Settings.RegisterCanvasLayoutSubcategory) == "function" then
				local panel = H.BuildCanvas("ClaudeWoWWidgetsPanel", H.WIDGETS_TITLE, false)
				local placed, widgets = pcall(Settings.RegisterCanvasLayoutSubcategory, parent, panel, H.WIDGETS_TITLE)
				if placed then H.widgetsCategory = widgets end
			end
			return true
		end
	end
	if type(Settings.RegisterCanvasLayoutSubcategory) == "function" then
		local panel = H.BuildCanvas("ClaudeWoWOptionsPanel", H.OPTIONS_TITLE, true)
		local ok, category = pcall(Settings.RegisterCanvasLayoutSubcategory, parent, panel, H.OPTIONS_TITLE)
		if ok and category then
			H.optionsCategory = category
			return true
		end
	end
	return false
end

function H.RegisterLegacyOptions(parentName)
	if H.optionsPanel then return true end
	local panel = H.BuildCanvas("ClaudeWoWOptionsPanel", H.OPTIONS_TITLE, true)
	panel.parent = parentName
	if pcall(InterfaceOptions_AddCategory, panel) then
		H.optionsPanel = panel
		return true
	end
	return false
end

local function Label(parent, font, text)
	local fs = parent:CreateFontString(nil, "ARTWORK", font)
	fs:SetJustifyH("LEFT")
	fs:SetText(text)
	return fs
end

local function Tooltip(frame, title, text)
	frame:SetScript("OnEnter", function(self)
		if not GameTooltip then return end
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText(title)
		if text then GameTooltip:AddLine(text, 1, 1, 1, true) end
		GameTooltip:Show()
	end)
	frame:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
end

local function OptionControl(panel, option)
	local control
	if option.choices then
		control = CreateFrame("Button", nil, panel, "UIPanelButtonTemplate")
		control:SetSize(220, 22)
		control:SetScript("OnClick", function() H.SetOption(option, NextChoice(option)) end)
		control.Refresh = function(self) self:SetText(option.label .. ": " .. ChoiceLabel(option, H.OptionValue(option))) end
	else
		control = CreateFrame("CheckButton", nil, panel, "UICheckButtonTemplate")
		control:SetSize(26, 26)
		local text = type(control.Text) == "table" and control.Text or Label(control, "GameFontHighlight", "")
		text:ClearAllPoints()
		text:SetPoint("LEFT", control, "RIGHT", 4, 0)
		text:SetText(option.label)
		control.label = text
		control:SetScript("OnClick", function() H.SetOption(option, not H.OptionValue(option)) end)
		control.Refresh = function(self) self:SetChecked(H.OptionValue(option) == true) end
	end
	control.option = option
	Tooltip(control, option.label, option.tooltip)
	return control
end

local function WidgetRow(panel)
	local row = CreateFrame("Frame", nil, panel)
	row:SetSize(H.FALLBACK_WIDTH, H.ROW_H)
	row.text = Label(row, "GameFontHighlight", "")
	row.text:SetPoint("LEFT", row, "LEFT", 0, 0)
	row.text:SetWidth(H.FALLBACK_WIDTH - 220)
	row.button = CreateFrame("Button", nil, row, "UIPanelButtonTemplate")
	row.button:SetSize(90, 22)
	row.button:SetPoint("RIGHT", row, "RIGHT", 0, 0)
	row.button:SetScript("OnClick", function(self)
		local data = self:GetParent().data
		if not data or not ClaudeWoWWidgets then return end
		if data.status == "removed" or data.status == "waiting" then
			ClaudeWoWWidgets.Show(data)
		else
			ClaudeWoWWidgets.Remove(data.name)
		end
		H.RefreshCanvas(panel)
	end)
	return row
end

H.WIDGET_STATUS = { running = "shown", removed = "hidden", waiting = "waiting for your OK", failed = "stopped after an error", stopped = "not running" }

function H.RefreshCanvas(panel)
	for _, control in ipairs(panel.controls or {}) do control:Refresh() end
	local rows = (ClaudeWoWWidgets and type(ClaudeWoWWidgets.Rows) == "function") and ClaudeWoWWidgets.Rows() or {}
	panel.empty:SetShown(#rows == 0)
	for i = 1, H.WIDGET_ROWS_MAX do
		local data = rows[i]
		local row = panel.rows[i]
		if data and not row then
			row = WidgetRow(panel)
			row:SetPoint("TOPLEFT", panel.widgetsHeader, "BOTTOMLEFT", 0, -8 - (i - 1) * H.ROW_H)
			panel.rows[i] = row
		end
		if row then
			row.data = data
			row:SetShown(data ~= nil)
			if data then
				row.text:SetText((data.title or data.name) .. "  (" .. (H.WIDGET_STATUS[data.status] or data.status) .. ")")
				row.button:SetText((data.status == "removed" or data.status == "waiting") and "Show" or "Remove")
			end
		end
	end
end

function H.BuildCanvas(name, title, withOptions)
	local panel = CreateFrame("Frame", name)
	panel:Hide()
	panel.name = title
	panel.controls, panel.rows = {}, {}
	local heading = Label(panel, Font("GameFontNormalLarge", "GameFontNormal"), title)
	heading:SetPoint("TOPLEFT", panel, "TOPLEFT", PAD, -PAD)
	local anchor = heading
	if withOptions then
		for i, option in ipairs(H.Options()) do
			local control = OptionControl(panel, option)
			control:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 0, i == 1 and -12 or -6)
			panel.controls[#panel.controls + 1] = control
			anchor = control
		end
	end
	panel.widgetsHeader = Label(panel, Font("GameFontNormal", "GameFontNormalSmall"), withOptions and "The agent's widgets" or "Widgets the agent made for you. Remove hides one until the agent sends a new version.")
	panel.widgetsHeader:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 0, -SECTION_GAP)
	panel.empty = Label(panel, Font("GameFontHighlightSmall", "GameFontNormalSmall"), "No widgets yet. Ask the agent for one.")
	panel.empty:SetPoint("TOPLEFT", panel.widgetsHeader, "BOTTOMLEFT", 0, -8)
	panel:SetScript("OnShow", function(self) H.RefreshCanvas(self) end)
	panel.OnRefresh = function(self) H.RefreshCanvas(self) end
	if withOptions then H.canvas = panel end
	H.RefreshCanvas(panel)
	return panel
end

function H.OpenOptions()
	if not H.Register() then return H.ShowWindow() end
	if H.category then
		local target = H.optionsCategory or H.category
		if type(Settings.OpenToCategory) == "function" and pcall(Settings.OpenToCategory, CategoryID(target)) then return "settings" end
		return nil
	end
	local panel = H.optionsPanel or H.panel
	if type(InterfaceOptionsFrame_OpenToCategory) == "function" and pcall(InterfaceOptionsFrame_OpenToCategory, panel) then
		pcall(InterfaceOptionsFrame_OpenToCategory, panel)
		return "interface"
	end
	return nil
end

local events = CreateFrame("Frame")
events:RegisterEvent("PLAYER_LOGIN")
events:SetScript("OnEvent", function(self)
	self:UnregisterEvent("PLAYER_LOGIN")
	H.Register()
end)
