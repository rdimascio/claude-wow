local H = {}
ClaudeWoWHelp = H

H.PAGE_TITLE = "Commands and tips"
H.ADDON_TITLE = "Azeroth Companion"
H.SUBTITLE = "Type these in any chat box or in the Claude window."
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
		if ok and category and pcall(Settings.RegisterAddOnCategory, category) then
			H.category = category
			return true
		end
	end
	if type(InterfaceOptions_AddCategory) == "function" and pcall(InterfaceOptions_AddCategory, panel) then
		H.legacy = true
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

local events = CreateFrame("Frame")
events:RegisterEvent("PLAYER_LOGIN")
events:SetScript("OnEvent", function(self)
	self:UnregisterEvent("PLAYER_LOGIN")
	H.Register()
end)
