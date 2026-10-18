local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "UI\\Menu.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q = ns.run, ns.ui, ns.Q
local Display = ns.Display
local FindChat = ns.FindChat

Q.MENU_W = 170
Q.MENU_ROW_H = 18
Q.MENU_MAX_AGENTS = 12
Q.RADIO_TEXTURE = "Interface\\Common\\UI-DropDownRadioChecks"

function Q.MenuAgents()
	local agents = {}
	for _, id in ipairs(type(run.bridgeAgents) == "table" and run.bridgeAgents or {}) do
		if type(id) == "string" and id:match("^[%w_%-]+$") and #agents < Q.MENU_MAX_AGENTS then table.insert(agents, id) end
	end
	return agents
end

function Q.AgentMenuItems(chatId)
	local function Pick(id)
		return function()
			local chat = FindChat(chatId)
			if chat then ClaudeWoW.SetAgent(id == "" and "default" or id, chat) end
		end
	end
	local function Selected(id)
		return function()
			local chat = FindChat(chatId)
			return chat ~= nil and (chat.agent or "") == id
		end
	end
	local defaultLabel = run.bridgeAgent and ("Default (" .. Display(ns.AgentName(run.bridgeAgent)) .. ")") or "Default"
	local items = { { text = defaultLabel, radio = true, selected = Selected(""), fn = Pick("") } }
	for _, id in ipairs(Q.MenuAgents()) do
		table.insert(items, { text = Display(ns.AgentName(id)), radio = true, selected = Selected(id), fn = Pick(id) })
	end
	return items
end

function Q.ChatMenuItems(chatId)
	local c = FindChat(chatId)
	if not c then return nil end
	local items = {
		{ title = Display(c.name) },
		{ text = "Rename...", fn = function() ClaudeWoW.RenamePrompt(chatId) end },
		{ text = "Project...", fn = function() ClaudeWoW.FolderPrompt(chatId) end },
	}
	if #Q.MenuAgents() > 0 then
		table.insert(items, { text = "Agent", submenu = Q.AgentMenuItems(chatId) })
	else
		table.insert(items, { text = "Agent...", fn = function() ClaudeWoW.AgentPrompt(chatId) end })
	end
	table.insert(items, { divider = true })
	table.insert(items, { text = "Clear Messages", fn = function() ClaudeWoW.ConfirmClear(chatId) end })
	table.insert(items, { text = "Delete", color = "ffff4040", fn = function() ClaudeWoW.ConfirmDelete(chatId) end })
	return items
end

function Q.MenuLabel(item) return item.color and ("|c" .. item.color .. item.text .. "|r") or item.text end

function Q.MenuEnabled(item)
	local enabled = item.enabled
	if enabled == nil then return true end
	if type(enabled) == "function" then return enabled() and true or false end
	return enabled and true or false
end

function Q.ApplyNativeEnabled(element, item)
	if item.enabled == nil or type(element) ~= "table" or type(element.SetEnabled) ~= "function" then return end
	element:SetEnabled(Q.MenuEnabled(item))
end

function Q.NativeAction(item, holder)
	if item.enabled == nil or type(item.fn) ~= "function" then return item.fn end
	return function(...)
		if not Q.MenuEnabled(item) then
			Q.ApplyNativeEnabled(holder.element, item)
			return
		end
		return item.fn(...)
	end
end

function Q.FillNativeMenu(root, items)
	for _, it in ipairs(items) do
		local element
		local holder = {}
		local action = Q.NativeAction(it, holder)
		if it.title then
			root:CreateTitle(it.title)
		elseif it.divider then
			root:CreateDivider()
		elseif it.submenu then
			element = root:CreateButton(it.text)
			Q.FillNativeMenu(element, it.submenu)
		elseif it.radio then
			element = root:CreateRadio(it.text, it.selected, action)
		elseif it.checked then
			element = root:CreateCheckbox(it.text, it.checked, action)
		else
			element = root:CreateButton(Q.MenuLabel(it), action)
		end
		holder.element = element
		if element then Q.ApplyNativeEnabled(element, it) end
	end
end

function Q.MenuRows(items, depth, out)
	out = out or {}
	depth = depth or 0
	for _, it in ipairs(items) do
		if it.submenu then
			table.insert(out, { item = it, depth = depth, header = true })
			Q.MenuRows(it.submenu, depth + 1, out)
		elseif not it.title then
			table.insert(out, { item = it, depth = depth })
		end
	end
	return out
end

function Q.MenuFrame()
	if ui.menu then return ui.menu end
	local menu = CreateFrame("Frame", "ClaudeWoWChatMenu", ui.frame or UIParent, "BackdropTemplate")
	menu:SetSize(Q.MENU_W, 40)
	menu:SetFrameStrata("TOOLTIP")
	menu:SetBackdrop({
		bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
		edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
		tile = true,
		tileSize = 16,
		edgeSize = 12,
		insets = { left = 3, right = 3, top = 3, bottom = 3 },
	})
	menu:SetBackdropColor(0.08, 0.08, 0.1, 0.97)
	menu:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
	menu:EnableMouse(true)
	menu.title = menu:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	menu.title:SetPoint("TOPLEFT", menu, "TOPLEFT", 10, -8)
	menu.title:SetPoint("RIGHT", menu, "RIGHT", -8, 0)
	menu.title:SetJustifyH("LEFT")
	menu.title:SetWordWrap(false)
	menu.rows = {}
	menu:SetScript("OnUpdate", function(self, dt)
		if not MouseIsOver then return end
		if MouseIsOver(self) or (self.owner and MouseIsOver(self.owner)) then
			self.away = 0
		else
			self.away = (self.away or 0) + dt
			if self.away > 0.5 then self:Hide() end
		end
	end)
	menu:Hide()
	ui.menu = menu
	ui.chatMenu = menu
	return menu
end

function Q.MenuRow(menu, i)
	local row = menu.rows[i]
	if row then return row end
	row = CreateFrame("Button", nil, menu)
	row:SetSize(Q.MENU_W - 12, Q.MENU_ROW_H)
	row.hl = row:CreateTexture(nil, "HIGHLIGHT")
	row.hl:SetAllPoints()
	row.hl:SetColorTexture(1, 1, 1, 0.12)
	row.check = row:CreateTexture(nil, "ARTWORK")
	row.check:SetSize(14, 14)
	row.check:SetTexture(Q.RADIO_TEXTURE)
	row.line = row:CreateTexture(nil, "ARTWORK")
	row.line:SetHeight(1)
	row.line:SetPoint("LEFT", row, "LEFT", 4, 0)
	row.line:SetPoint("RIGHT", row, "RIGHT", -4, 0)
	row.line:SetColorTexture(0.6, 0.6, 0.6, 0.5)
	row.label = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	row.label:SetJustifyH("LEFT")
	row.label:SetWordWrap(false)
	row:SetScript("OnClick", function(self)
		if not self.fn then return end
		if self.item and not Q.MenuEnabled(self.item) then
			Q.PaintMenuRow(self, false)
			return
		end
		menu:Hide()
		self.fn()
	end)
	menu.rows[i] = row
	return row
end

function Q.PaintMenuRow(row, enabled)
	local it = row.item
	row.fn = (enabled and not it.divider and not row.header) and it.fn or nil
	row.disabled = not enabled
	row:EnableMouse(row.fn ~= nil)
	if not enabled then
		row.label:SetTextColor(0.5, 0.5, 0.5)
	elseif row.header then
		row.label:SetTextColor(1, 0.82, 0)
	else
		row.label:SetTextColor(1, 1, 1)
	end
	row.check:SetAlpha(enabled and 1 or 0.5)
end

function Q.MenuMarkCoords(item, on)
	local left = on and 0 or 0.5
	local top = item.radio and 0.5 or 0
	return left, left + 0.5, top, top + 0.5
end

function Q.FillFallbackMenu(menu, items)
	local title
	for _, it in ipairs(items) do
		if it.title then title = it.title end
	end
	menu.title:SetText(title or "")
	local top = title and 22 or 6
	local rows = Q.MenuRows(items)
	for i, r in ipairs(rows) do
		local it, row = r.item, Q.MenuRow(menu, i)
		local indent = 6 + r.depth * 12
		local mark = it.radio and it.selected or it.checked
		row:ClearAllPoints()
		row:SetPoint("TOPLEFT", menu, "TOPLEFT", 6, -top - (i - 1) * Q.MENU_ROW_H)
		row.item = it
		row.header = r.header
		row.check:ClearAllPoints()
		row.check:SetPoint("LEFT", row, "LEFT", indent, 0)
		if mark then
			row.check:SetTexCoord(Q.MenuMarkCoords(it, mark() == true))
			row.check:Show()
		else
			row.check:Hide()
		end
		if it.divider then
			row.line:Show()
		else
			row.line:Hide()
		end
		row.label:ClearAllPoints()
		row.label:SetPoint("LEFT", row, "LEFT", indent + (mark and 16 or 0), 0)
		row.label:SetPoint("RIGHT", row, "RIGHT", -4, 0)
		row.label:SetText(it.divider and "" or Q.MenuLabel(it))
		Q.PaintMenuRow(row, Q.MenuEnabled(it))
		row:Show()
	end
	for i = #rows + 1, #menu.rows do
		menu.rows[i]:Hide()
	end
	menu:SetHeight(top + #rows * Q.MENU_ROW_H + 8)
end

function Q.ShowMenu(anchor, items, key, allowNative)
	if allowNative and type(MenuUtil) == "table" and type(MenuUtil.CreateContextMenu) == "function" then
		local shown = pcall(MenuUtil.CreateContextMenu, anchor, function(_, root) Q.FillNativeMenu(root, items) end)
		if shown then return end
	end
	local menu = Q.MenuFrame()
	if menu:IsShown() and menu.key == key then
		menu:Hide()
		return
	end
	menu.key = key
	menu.owner = anchor
	menu.away = 0
	Q.FillFallbackMenu(menu, items)
	menu:ClearAllPoints()
	menu:SetPoint("TOPLEFT", anchor, "BOTTOMLEFT", 8, 2)
	menu:Show()
end

function ClaudeWoW.ShowChatMenu(chatId, anchor)
	local items = Q.ChatMenuItems(chatId)
	if not items then return end
	Q.ShowMenu(anchor, items, "chat:" .. chatId, ui.native)
	if ui.menu then ui.menu.chatId = ui.menu.key == "chat:" .. chatId and chatId or nil end
end
