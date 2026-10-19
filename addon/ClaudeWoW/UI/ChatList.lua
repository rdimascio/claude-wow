local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "UI\\ChatList.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q, Cli = ns.run, ns.ui, ns.Q, ns.Cli
local Display, Trim, Try = ns.Display, ns.Trim, ns.Try
local ActiveChat = ns.ActiveChat

function ClaudeWoW.RenderChatList()
	if ui.questList then return ClaudeWoW.RenderQuestList() end
	if not ui.chatButtons then return end
	local listed = Q.ListedChats()
	local pages = math.max(1, math.ceil(#listed / Q.CHAT_PAGE))
	if not ui.chatPage then
		for i, ch in ipairs(listed) do
			if ch.id == ns.db.activeChat then ui.chatPage = math.ceil(i / Q.CHAT_PAGE) end
		end
	end
	ui.chatPage = math.min(math.max(ui.chatPage or 1, 1), pages)
	local offset = (ui.chatPage - 1) * Q.CHAT_PAGE
	if ui.pageLabel then
		ui.pageLabel:SetText(pages > 1 and (ui.chatPage .. " / " .. pages) or "")
		ui.pagePrev:SetShown(pages > 1)
		ui.pageNext:SetShown(pages > 1)
		ui.pagePrev:SetEnabled(ui.chatPage > 1)
		ui.pageNext:SetEnabled(ui.chatPage < pages)
	end
	for i, btn in ipairs(ui.chatButtons) do
		local c = listed[offset + i]
		if c then
			local label = Display(Q.ShownName(c))
			local folder = ns.FolderName(ns.ChatFolder(c))
			if folder ~= "" and folder:lower() ~= c.name:lower() then label = label .. " |cff888888" .. Display(folder) .. "|r" end
			if c.agent and c.agent ~= "" then label = label .. " |cff888888" .. ns.AgentName(c.agent) .. "|r" end
			if c.pendingId then
				label = label .. " |cffffd100...|r"
			elseif (c.unread or 0) > 0 then
				label = label .. " |cff55ff55(" .. c.unread .. ")|r"
			end
			btn.label:SetText(label)
			btn.chatId = c.id
			btn.selected:SetShown(c.id == ns.db.activeChat)
			btn:Show()
		else
			btn:Hide()
		end
	end
end

function Q.ChatActivity()
	local unread, working = 0, 0
	for _, c in ipairs(Q.ListedChats()) do
		unread = unread + (c.unread or 0)
		if c.pendingId then working = working + 1 end
	end
	return unread, working
end

function Q.ActivityText(unread, working)
	local parts = {}
	if unread > 0 then table.insert(parts, unread .. (unread == 1 and " new reply" or " new replies")) end
	if working > 0 then table.insert(parts, working .. " working") end
	return table.concat(parts, ", ")
end

Q.LIST_W = 300
Q.LIST_MIN_W = 200
Q.LIST_SHARE = 0.38

Q.LIST_ROW_H = 20
Q.LIST_HEADER_H = 22
Q.NO_FOLDER = "Chats"
Q.QUEST_ART = {
	listBg = "QuestLog-main-background",
	header = "common-button-list-collapseExpand",
	plus = "common-button-list-plus",
	minus = "common-button-list-minus",
	rowGlow = "questlog-quest-glow-yellow",
	working = "Quest-In-Progress-Icon-yellow",
	reply = "UI-QuestIcon-TurnIn-Normal",
	parchment = "QuestBG-Parchment",
	poi = "UI-QuestPoi-QuestNumber",
	poiSelected = "UI-QuestPoi-QuestNumber-SuperTracked",
	poiPushed = "UI-QuestPoi-QuestNumber-Pressed",
	poiOuter = "UI-QuestPoi-OuterGlow",
	poiInner = "UI-QuestPoi-InnerGlow",
	workingSelected = "Quest-In-Progress-Icon-Brown",
	frame = "questlog-frame",
	filigree = "questlog-frame-filigree",
	gradient = "questlog-frame-gradient-bottom",
	gear = "questlog-icon-setting",
}
Q.ROW_TITLE_X = 31
Q.ROW_TOP = 8
Q.ROW_BOTTOM = 6
Q.POI_TOP = 4
Q.POI_SIZE = 20
Q.ROW_MIN_H = Q.POI_TOP + Q.POI_SIZE + Q.ROW_BOTTOM
Q.OBJECTIVE_GAP = 3
Q.OBJECTIVE_LINE_GAP = 2
Q.HEADER_INSET = 9
Q.HEADER_RIGHT = 6
Q.PAD_FIRST = 8
Q.PAD_HEADER_AFTER_HEADER = 6
Q.PAD_HEADER_AFTER_ROW = 4
Q.PAD_ROW_AFTER_HEADER = 2
Q.PAD_ROW_AFTER_ROW = -3
Q.TITLE_IDLE = { 0.75, 0.61, 0 }
Q.TITLE_WORKING = { 1, 1, 0 }
Q.TITLE_REPLY = { 0.25, 0.75, 0.25 }
Q.TITLE_NEEDS_YOU = { 1, 0.4, 0.1 }

function Q.TitleColor(c)
	if c.pendingId then return Q.TITLE_WORKING end
	if Q.DenialIndex(c) then return Q.TITLE_NEEDS_YOU end
	if (c.unread or 0) > 0 then return Q.TITLE_REPLY end
	return Q.TITLE_IDLE
end
Q.COUNT_W = 92

function Q.FolderKey(c)
	local name = ns.FolderName(Cli.ProjectOf(c))
	return name ~= "" and name or Q.NO_FOLDER
end

function Q.DeleteButton(parent)
	local del = CreateFrame("Button", nil, parent)
	del:SetSize(16, 16)
	if Q.AtlasExists("128-RedButton-Delete") then
		del:SetNormalAtlas("128-RedButton-Delete")
		del:SetPushedAtlas("128-RedButton-Delete-Pressed")
		del:SetHighlightAtlas("128-RedButton-Delete-Highlight")
	else
		del:SetNormalTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Up")
		del:SetHighlightTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Highlight")
	end
	del:SetScript("OnClick", function() ClaudeWoW.ConfirmDelete(parent.chatId) end)
	del:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText("Delete this chat")
		GameTooltip:Show()
	end)
	del:SetScript("OnLeave", function(self)
		GameTooltip:Hide()
		if not Try(parent.IsMouseOver, parent) then self:Hide() end
	end)
	del:Hide()
	return del
end

function Q.ChatRowClicks(row)
	row:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	row:SetScript("OnClick", function(self, button)
		if button == "RightButton" then
			ClaudeWoW.ShowChatMenu(self.chatId, self)
		else
			ClaudeWoW.SwitchChat(self.chatId)
		end
	end)
	row:SetScript("OnDoubleClick", function(self)
		ClaudeWoW.SwitchChat(self.chatId)
		ClaudeWoW.RenamePrompt(self.chatId)
	end)
end

function Q.Color(name, r, g, b)
	local c = _G[name]
	if type(c) == "table" and type(c.GetRGB) == "function" then return c:GetRGB() end
	return r, g, b
end

function Q.PreviewsOn() return ns.db.settings.chatPreviews ~= false end

function Q.LastMessage(c)
	local last, count = nil, 0
	for _, m in ipairs(c.history) do
		if m.role == "user" or m.role == "assistant" then
			last = m
			count = count + 1
		end
	end
	return last, count
end

function Q.WhenShort(t) return (Q.WhenLabel(t):gsub("^%a+ ", "")) end

function Q.MessageSummary(last, count)
	if not last then return "No messages yet" end
	return count .. (count == 1 and " message" or " messages") .. (last.t and (", last " .. Q.WhenLabel(last.t)) or "")
end

function Q.ChatObjectives(c)
	if c.pendingId then return { "Working: " .. ns.ActivityLine(c) } end
	local last = Q.LastMessage(c)
	if not last then return {} end
	local who = last.role == "user" and "You" or ns.ReplyAgentName(c, last.agent)
	local first = tostring(last.text or ""):match("^%s*([^\n]*)") or ""
	return { who .. ": " .. first }
end

function Q.PoiState(poi, glyphKey, number, selected)
	if not Q.SetArt(poi.bg, selected and "poiSelected" or "poi", true) then Q.SetArt(poi.bg, "poi", true) end
	poi.outer:SetShown(selected)
	local glyphShown = glyphKey ~= nil and Q.SetArt(poi.glyph, glyphKey, true)
	poi.glyph:SetShown(glyphShown)
	if glyphShown then
		poi.number:Hide()
	else
		poi.number:SetText(number)
		poi.number:Show()
	end
end

function Q.Poi(parent)
	local poi = CreateFrame("Button", nil, parent)
	poi:SetSize(Q.POI_SIZE, Q.POI_SIZE)
	poi.outer = poi:CreateTexture(nil, "BACKGROUND")
	poi.outer:SetPoint("CENTER")
	if Q.SetArt(poi.outer, "poiOuter", true) then poi.outer:SetBlendMode("ADD") end
	poi.outer:Hide()
	poi.bg = poi:CreateTexture(nil, "BORDER")
	poi.bg:SetPoint("CENTER")
	poi.glyph = poi:CreateTexture(nil, "ARTWORK", nil, 1)
	poi.glyph:SetPoint("CENTER")
	poi.number = poi:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	poi.number:SetPoint("CENTER", poi, "CENTER", 0, 0)
	local inner = poi:CreateTexture(nil, "HIGHLIGHT")
	inner:SetPoint("CENTER")
	if Q.SetArt(inner, "poiInner", true) then inner:SetBlendMode("ADD") end
	poi:SetScript("OnMouseDown", function(self)
		self.glyph:SetPoint("CENTER", 1, -1)
		self.number:SetPoint("CENTER", self, "CENTER", 1, -1)
		Q.SetArt(self.bg, "poiPushed", true)
	end)
	poi:SetScript("OnMouseUp", function(self)
		self.glyph:SetPoint("CENTER")
		self.number:SetPoint("CENTER", self, "CENTER", 0, 0)
		local row = self:GetParent()
		Q.SetArt(self.bg, row.active and "poiSelected" or "poi", true)
	end)
	poi:SetScript("OnClick", function(self) ClaudeWoW.SwitchChat(self:GetParent().chatId) end)
	return poi
end

function Q.Objective(r, k)
	local line = r.objectives[k]
	if line then return line end
	local font = Q.FontObject("ObjectiveFont", "GameFontHighlightSmall")
	line = {
		dash = r:CreateFontString(nil, "OVERLAY", font),
		text = r:CreateFontString(nil, "OVERLAY", font),
	}
	line.dash:SetText(_G.QUEST_DASH or "- ")
	line.text:SetPoint("TOPLEFT", line.dash, "TOPRIGHT", 0, 0)
	line.text:SetJustifyH("LEFT")
	line.text:SetWordWrap(false)
	r.objectives[k] = line
	return line
end

function Q.RowColors(r, hover)
	local c = hover and { 1, 1, 1 } or r.titleColor
	r.title:SetTextColor(c[1], c[2], c[3])
	local or_, og, ob
	if hover then
		or_, og, ob = Q.Color("QUEST_OBJECTIVE_HIGHLIGHT_FONT_COLOR", 1, 1, 1)
	else
		or_, og, ob = Q.Color("QUEST_OBJECTIVE_FONT_COLOR", 0.8, 0.8, 0.8)
	end
	for _, line in ipairs(r.objectives) do
		line.dash:SetTextColor(or_, og, ob)
		line.text:SetTextColor(or_, og, ob)
	end
end

function Q.QuestRow(i)
	local q = ui.questList
	local r = q.rows[i]
	if r then return r end
	r = CreateFrame("Button", nil, q.content)
	r.objectives = {}
	r.glow = r:CreateTexture(nil, "BACKGROUND")
	r.glow:SetAllPoints()
	if not Q.SetArt(r.glow, "rowGlow") then r.glow:SetColorTexture(1, 0.82, 0, 0.12) end
	r.glow:Hide()
	r.poi = Q.Poi(r)
	r.poi:SetPoint("TOPLEFT", r, "TOPLEFT", 6, -Q.POI_TOP)
	r.del = Q.DeleteButton(r)
	r.del:SetPoint("TOPRIGHT", r, "TOPRIGHT", -2, -Q.ROW_TOP + 2)
	r.when = r:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	r.when:SetPoint("TOPRIGHT", r, "TOPRIGHT", -22, -Q.ROW_TOP)
	r.when:SetJustifyH("RIGHT")
	r.title = r:CreateFontString(nil, "OVERLAY", Q.FontObject("GameFontNormalLeft", "GameFontNormalSmall"))
	r.title:SetPoint("TOPLEFT", r, "TOPLEFT", Q.ROW_TITLE_X, -Q.ROW_TOP)
	r.title:SetPoint("RIGHT", r.when, "LEFT", -4, 0)
	r.title:SetJustifyH("LEFT")
	r.title:SetWordWrap(false)
	r.label = r.title
	Q.ChatRowClicks(r)
	r:SetScript("OnEnter", function(self)
		self.del:Show()
		Q.RowColors(self, true)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText(self.fullTitle or "", 1, 1, 1, 1, true)
		GameTooltip:AddLine(self.summary or "", 0.8, 0.8, 0.8)
		GameTooltip:Show()
	end)
	r:SetScript("OnLeave", function(self)
		if not Try(self.del.IsMouseOver, self.del) then self.del:Hide() end
		Q.RowColors(self, false)
		GameTooltip:Hide()
	end)
	q.rows[i] = r
	return r
end

Q.TITLE_EMPTY = { 0.5, 0.5, 0.5 }

function ClaudeWoW.InvalidateRender()
	run.renderKey = nil
	local q = ui.questList
	if not q then return end
	for _, r in ipairs(q.rows) do
		r.drawn = nil
	end
	for _, h in ipairs(q.headers) do
		h.drawn = nil
	end
end

local function SameRow(d, title, when, titleColor, glyph, index, active, width, linesKey)
	return d ~= nil
		and d.title == title
		and d.when == when
		and d.color == titleColor
		and d.glyph == glyph
		and d.index == index
		and d.active == active
		and d.width == width
		and d.lines == linesKey
end

function Q.FillRow(r, c, index, width)
	local active = c.id == ns.db.activeChat
	local unread = c.unread or 0
	local previews = Q.PreviewsOn()
	local last, count = Q.LastMessage(c)
	r.chatId = c.id
	r.poi.chatId = c.id
	r.active = active
	local title = Display(Q.ShownName(c))
	r.fullTitle = title
	r.summary = Q.MessageSummary(last, count)
	if c.agent and c.agent ~= "" then title = title .. " |cff9d9d9d" .. ns.AgentName(c.agent) .. "|r" end
	if unread > 0 then title = title .. " (" .. unread .. ")" end
	local when = last and last.t and Q.WhenShort(last.t) or ""
	local titleColor = Q.TitleColor(c)
	if previews and not last and titleColor == Q.TITLE_IDLE then titleColor = Q.TITLE_EMPTY end
	r.titleColor = active and { 1, 1, 1 } or titleColor
	local glyph = (c.pendingId and (active and "workingSelected" or "working")) or (unread > 0 and "reply") or nil
	local lines = previews and Q.ChatObjectives(c) or {}
	local linesKey = table.concat(lines, "\n")
	local drawn = r.drawn
	if SameRow(drawn, title, when, titleColor, glyph, index, active, width, linesKey) then
		Q.RowColors(r, false)
		return drawn.height
	end
	r.drawn = nil
	r:SetWidth(width)
	r.glow:SetShown(active)
	r.title:SetText(title)
	r.when:SetText(when)
	Q.PoiState(r.poi, glyph, tostring(index), active)
	local textW = width - Q.ROW_TITLE_X - 22
	local titleH = Try(r.title.GetStringHeight, r.title) or 14
	if titleH < 1 then titleH = 14 end
	local y = Q.ROW_TOP + titleH + Q.OBJECTIVE_GAP
	for k, text in ipairs(lines) do
		local line = Q.Objective(r, k)
		line.dash:ClearAllPoints()
		line.dash:SetPoint("TOPLEFT", r, "TOPLEFT", Q.ROW_TITLE_X, -y)
		line.text:SetWidth(textW - 8)
		line.text:SetText(Display(text))
		line.dash:Show()
		line.text:Show()
		local h = Try(line.text.GetStringHeight, line.text) or 12
		if h < 1 then h = 12 end
		y = y + h + Q.OBJECTIVE_LINE_GAP
	end
	for k = #lines + 1, #r.objectives do
		r.objectives[k].dash:Hide()
		r.objectives[k].text:Hide()
	end
	local textBottom = #lines > 0 and (y - Q.OBJECTIVE_LINE_GAP) or (Q.ROW_TOP + titleH)
	local height = math.max(textBottom + Q.ROW_BOTTOM, Q.ROW_MIN_H)
	r:SetHeight(height)
	Q.RowColors(r, false)
	r.drawn =
		{ title = title, when = when, color = titleColor, glyph = glyph, index = index, active = active, width = width, lines = linesKey, height = height }
	return height
end

function Q.QuestHeader(i)
	local q = ui.questList
	local h = q.headers[i]
	if h then return h end
	h = CreateFrame("Button", nil, q.content)
	h:SetHeight(Q.LIST_HEADER_H)
	local bg = h:CreateTexture(nil, "BACKGROUND")
	bg:SetAllPoints()
	if not Q.SetArt(bg, "header") then bg:SetColorTexture(0.25, 0.18, 0.08, 0.6) end
	local hl = h:CreateTexture(nil, "HIGHLIGHT")
	hl:SetAllPoints()
	if Q.SetArt(hl, "header") then
		hl:SetBlendMode("ADD")
		hl:SetAlpha(0.4)
	else
		hl:SetColorTexture(1, 1, 1, 0.08)
	end
	h.collapse = CreateFrame("Button", nil, h)
	h.collapse:SetSize(20, 20)
	h.collapse:SetPoint("RIGHT", h, "RIGHT", -6, 0)
	h.icon = h.collapse:CreateTexture(nil, "ARTWORK")
	h.icon:SetPoint("CENTER")
	h.iconHighlight = h.collapse:CreateTexture(nil, "HIGHLIGHT")
	h.iconHighlight:SetPoint("CENTER")
	h.text = h:CreateFontString(nil, "OVERLAY", Q.FontObject("Game15Font_Shadow", "GameFontNormal"))
	h.text:SetPoint("LEFT", h, "LEFT", 8, 1)
	h.text:SetPoint("RIGHT", h.collapse, "LEFT", -4, 0)
	h.text:SetJustifyH("LEFT")
	h.text:SetWordWrap(false)
	local function Toggle(self)
		local header = self.key and self or self:GetParent()
		local collapsed = ns.db.settings.collapsedFolders or {}
		ns.db.settings.collapsedFolders = collapsed
		collapsed[header.key] = (not collapsed[header.key]) or nil
		ClaudeWoW.RenderChatList()
	end
	h:SetScript("OnClick", Toggle)
	h.collapse:SetScript("OnClick", Toggle)
	h:SetScript("OnEnter", function(self) self.text:SetTextColor(Q.Color("HIGHLIGHT_FONT_COLOR", 1, 1, 1)) end)
	h:SetScript("OnLeave", function(self) self.text:SetTextColor(Q.Color("DISABLED_FONT_COLOR", 0.5, 0.5, 0.5)) end)
	h:SetScript("OnMouseDown", function(self) self.text:SetPoint("LEFT", self, "LEFT", 9, 0) end)
	h:SetScript("OnMouseUp", function(self) self.text:SetPoint("LEFT", self, "LEFT", 8, 1) end)
	h.text:SetTextColor(Q.Color("DISABLED_FONT_COLOR", 0.5, 0.5, 0.5))
	q.headers[i] = h
	return h
end

function Q.SetHeaderIcon(h, collapsed)
	local key = collapsed and "plus" or "minus"
	if Q.SetArt(h.icon, key, true) then
		Q.SetArt(h.iconHighlight, key, true)
		h.iconHighlight:SetBlendMode("ADD")
		h.iconHighlight:SetAlpha(0.4)
	else
		h.icon:SetSize(14, 14)
		h.icon:SetTexture(collapsed and "Interface\\Buttons\\UI-PlusButton-Up" or "Interface\\Buttons\\UI-MinusButton-Up")
	end
end

function ClaudeWoW.RenderQuestList()
	local q = ui.questList
	local filter = ui.chatFilter or ""
	local collapsed = ns.db.settings.collapsedFolders or {}
	local listed = Q.ListedChats()
	local groups, order = {}, {}
	for _, c in ipairs(Q.NewestFirst(listed)) do
		local key = Q.FolderKey(c)
		if not groups[key] then
			groups[key] = {}
			table.insert(order, key)
		end
		table.insert(groups[key], c)
	end
	local fallback = (ui.listWidth or Q.LIST_W) - 32
	local width = Try(q.scroll.GetWidth, q.scroll) or fallback
	if width < 80 then width = fallback end
	q.content:SetWidth(width)
	local y, nh, nr, matched, index = 0, 0, 0, 0, 0
	local last, activeTop, activeBottom
	for _, key in ipairs(order) do
		local matches = {}
		for _, c in ipairs(groups[key]) do
			if filter == "" or tostring(c.name or ""):lower():find(filter, 1, true) then table.insert(matches, c) end
		end
		if #matches > 0 then
			matched = matched + #matches
			y = y + ((last == nil and Q.PAD_FIRST) or (last == "header" and Q.PAD_HEADER_AFTER_HEADER) or Q.PAD_HEADER_AFTER_ROW)
			nh = nh + 1
			local h = Q.QuestHeader(nh)
			local closed = filter == "" and collapsed[key] == true
			h.key = key
			h.collapsed = closed
			local drawn = h.drawn
			if not (drawn and drawn.key == key and drawn.closed == closed and drawn.width == width) then
				h.drawn = nil
				h.text:SetText(Display(key))
				Q.SetHeaderIcon(h, closed)
				h:SetWidth(width - Q.HEADER_INSET - Q.HEADER_RIGHT)
				h.drawn = { key = key, closed = closed, width = width }
			end
			h:ClearAllPoints()
			h:SetPoint("TOPLEFT", q.content, "TOPLEFT", Q.HEADER_INSET, -y)
			h:Show()
			y = y + Q.LIST_HEADER_H
			last = "header"
			if not closed then
				for _, c in ipairs(matches) do
					index = index + 1
					y = y + (last == "header" and Q.PAD_ROW_AFTER_HEADER or Q.PAD_ROW_AFTER_ROW)
					nr = nr + 1
					local r = Q.QuestRow(nr)
					local height = Q.FillRow(r, c, index, width)
					r:ClearAllPoints()
					r:SetPoint("TOPLEFT", q.content, "TOPLEFT", 0, -y)
					r:Show()
					if r.active then
						activeTop, activeBottom = y, y + height
					end
					y = y + height
					last = "row"
				end
			else
				index = index + #matches
			end
		end
	end
	for i = nh + 1, #q.headers do
		q.headers[i]:Hide()
	end
	for i = nr + 1, #q.rows do
		q.rows[i]:Hide()
	end
	q.empty:SetShown(filter ~= "" and matched == 0)
	q.content:SetHeight(math.max(y + Q.PAD_FIRST, 1))
	if activeTop and q.shownActive ~= ns.db.activeChat then
		q.shownActive = ns.db.activeChat
		Q.RevealRow(q, activeTop, activeBottom)
	end
	ui.chatCount:SetText("Chats: |cffffffff" .. #listed .. "|r")
end

function Q.LastActive(c)
	for i = #(c.history or {}), 1, -1 do
		local t = tonumber(c.history[i].t)
		if t then return t end
	end
	return tonumber(c.created) or 0
end

function Q.NewestFirst(chats)
	local sorted, rank = {}, {}
	for i, c in ipairs(chats) do
		rank[c] = { t = Q.LastActive(c), i = i }
		table.insert(sorted, c)
	end
	table.sort(sorted, function(a, b)
		local ra, rb = rank[a], rank[b]
		if ra.t ~= rb.t then return ra.t > rb.t end
		return ra.i > rb.i
	end)
	return sorted
end

function Q.RevealRow(q, top, bottom)
	local view = Try(q.scroll.GetHeight, q.scroll) or 0
	if view <= 0 then return end
	pcall(q.scroll.UpdateScrollChildRect, q.scroll)
	local current = Try(q.scroll.GetVerticalScroll, q.scroll) or 0
	local target = current
	if top < current then
		target = math.max(0, top - Q.LIST_HEADER_H - Q.PAD_FIRST - Q.PAD_ROW_AFTER_HEADER)
	elseif bottom > current + view then
		target = bottom - view
	end
	if target ~= current then pcall(q.scroll.SetVerticalScroll, q.scroll, target) end
end

function Q.ListSettingsMenu(anchor)
	local s = ns.db.settings
	local function SetAll(value)
		local collapsed = {}
		if value then
			for _, c in ipairs(ns.db.chats) do
				collapsed[Q.FolderKey(c)] = true
			end
		end
		s.collapsedFolders = collapsed
		ClaudeWoW.RenderChatList()
	end
	local function TogglePreviews()
		s.chatPreviews = not Q.PreviewsOn()
		ClaudeWoW.RenderChatList()
	end
	local items = { { text = "Show message previews", checked = Q.PreviewsOn, fn = TogglePreviews } }
	if ClaudeWoWOrders then table.insert(items, { text = "Show the Orders card", checked = ClaudeWoWOrders.IsOn, fn = ClaudeWoWOrders.Toggle }) end
	if ClaudeWoWTelemetry then
		table.insert(items, { text = "Share game state with the agent", checked = ClaudeWoWTelemetry.IsOn, fn = ClaudeWoWTelemetry.Toggle })
	end
	table.insert(items, { divider = true })
	table.insert(items, { text = "Options", fn = function() ClaudeWoW.ShowOptions() end })
	table.insert(items, { text = "Commands and tips", fn = function() ClaudeWoW.ShowHelp() end })
	table.insert(items, { text = "Expand all projects", fn = function() SetAll(false) end })
	table.insert(items, { text = "Collapse all projects", fn = function() SetAll(true) end })
	Q.ShowMenu(anchor, items, "settings", true)
end

function Q.ChatDetails(c)
	local folder = ns.FolderName(ns.ChatFolder(c))
	local agent = ns.AgentName((c and c.agent ~= "" and c.agent) or run.bridgeAgent)
	return {
		{ "Project", folder ~= "" and Display(folder) or Cli.NO_PROJECT },
		{ "Agent", agent },
	}
end

function ClaudeWoW.RefreshTitleBar()
	local label = ui.chatTitle
	if not label then return end
	local c = ActiveChat()
	label:SetText(c and Display(Q.ShownName(c)) or Q.PANEL_TITLE)
end

function Q.TitleBarTooltip(bar)
	local c = ActiveChat()
	if not c then return end
	GameTooltip:SetOwner(bar, "ANCHOR_BOTTOMLEFT", 0, 0)
	GameTooltip:SetText(Display(c.name))
	for _, row in ipairs(Q.ChatDetails(c)) do
		GameTooltip:AddDoubleLine(row[1], row[2], 1, 0.82, 0, 1, 1, 1)
	end
	GameTooltip:AddLine("Click to rename. Right-click for chat options.", 0.6, 0.6, 0.6, true)
	GameTooltip:Show()
end

function Q.ListWidth(frameWidth)
	local share = math.floor((tonumber(frameWidth) or 0) * Q.LIST_SHARE)
	return math.max(Q.LIST_MIN_W, math.min(Q.LIST_W, share))
end

function Q.LayoutListWidth()
	local list, f = ui.questList and ui.listPanel, ui.frame
	if not list or not f then return end
	local width = Q.ListWidth(Try(f.GetWidth, f))
	ui.listWidth = width
	list:SetWidth(width)
	ui.newChat:SetWidth(width - 12)
	ui.questList.content:SetWidth(width - 32)
	ui.questList.empty:SetWidth(width - 60)
end

function Q.BuildQuestFrames(f)
	local list = CreateFrame("Frame", nil, f)
	list:SetPoint("TOPRIGHT", f, "TOPRIGHT", -6, Q.NAV_TOP)
	list:SetPoint("BOTTOMRIGHT", f, "BOTTOMRIGHT", -6, 28)
	list:SetWidth(Q.LIST_W)
	ui.listPanel = list

	local gear = CreateFrame("Button", "ClaudeWoWChatSettings", list)
	gear:SetSize(15, 16)
	gear:SetPoint("TOPRIGHT", list, "TOPRIGHT", -4, -10)
	local gearIcon = gear:CreateTexture(nil, "ARTWORK")
	gearIcon:SetAllPoints()
	if not Q.SetArt(gearIcon, "gear") then
		if Q.IsClassicEra() then
			gearIcon:SetTexture(Q.CLASSIC_ERA_GEAR)
			gearIcon:SetTexCoord(0.08, 0.92, 0.08, 0.92)
		else
			gearIcon:SetTexture("Interface\\Buttons\\UI-OptionsButton")
		end
	end
	local gearHl = gear:CreateTexture(nil, "HIGHLIGHT")
	gearHl:SetAllPoints()
	if Q.SetArt(gearHl, "gear") then
		gearHl:SetBlendMode("ADD")
		gearHl:SetAlpha(0.4)
	end
	gear:SetScript("OnMouseDown", function() gearIcon:SetPoint("TOPLEFT", gear, "TOPLEFT", 1, -1) end)
	gear:SetScript("OnMouseUp", function() gearIcon:SetAllPoints() end)
	gear:SetScript("OnClick", function(self) Q.ListSettingsMenu(self) end)
	gear:SetScript("OnEnter", function(self)
		GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
		GameTooltip:SetText("Chat list options")
		GameTooltip:Show()
	end)
	gear:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.listSettings = gear

	local countBox = CreateFrame("Frame", "ClaudeWoWChatCount", list, Q.TemplateExists("InsetFrameTemplate3") and "InsetFrameTemplate3" or "InsetFrameTemplate")
	countBox:SetSize(Q.COUNT_W, 20)
	countBox:SetPoint("RIGHT", gear, "LEFT", -6, 0)
	local count = countBox:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	count:SetPoint("CENTER", countBox, "CENTER", 0, 0)
	ui.chatCount = count

	local search = CreateFrame("EditBox", "ClaudeWoWChatSearch", list, Q.TemplateExists("SearchBoxTemplate") and "SearchBoxTemplate" or "InputBoxTemplate")
	search:SetHeight(20)
	search:SetPoint("LEFT", list, "LEFT", 10, 0)
	search:SetPoint("TOP", countBox, "TOP", 0, 0)
	search:SetPoint("RIGHT", countBox, "LEFT", -6, 0)
	search:SetAutoFocus(false)
	if type(search.Instructions) == "table" then search.Instructions:SetText("Search Chats") end
	search:HookScript("OnTextChanged", function(self)
		ui.chatFilter = Trim(self:GetText() or ""):lower()
		ClaudeWoW.RenderChatList()
	end)
	ui.search = search

	local newChat = ns.MakeButton(list, "New Chat", Q.LIST_W - 12, function() ClaudeWoW.NewChat() end)
	newChat:SetPoint("BOTTOM", list, "BOTTOM", 0, Q.COMPOSER_BOTTOM)
	ui.newChat = newChat

	local listScroll = CreateFrame(
		"ScrollFrame",
		"ClaudeWoWChatScroll",
		list,
		Q.TemplateExists("ScrollFrameTemplate") and "ScrollFrameTemplate" or "UIPanelScrollFrameTemplate"
	)
	listScroll:SetPoint("TOPLEFT", list, "TOPLEFT", 6, -40)
	listScroll:SetPoint("BOTTOMRIGHT", list, "BOTTOMRIGHT", -20, 34)
	local listBg = list:CreateTexture(nil, "BACKGROUND", nil, 1)
	listBg:SetPoint("TOPLEFT", listScroll, "TOPLEFT", 0, 0)
	listBg:SetPoint("BOTTOMRIGHT", listScroll, "BOTTOMRIGHT", 16, 0)
	if not Q.SetArt(listBg, "listBg") then listBg:SetColorTexture(0.06, 0.05, 0.04, 0.9) end
	local listContent = CreateFrame("Frame", "ClaudeWoWChatListContent", listScroll)
	listContent:SetSize(Q.LIST_W - 32, 1)
	listScroll:SetScrollChild(listContent)
	local empty = listContent:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	empty:SetPoint("TOP", listContent, "TOP", 0, -20)
	empty:SetWidth(Q.LIST_W - 60)
	empty:SetText("There are no chats that match your search.")
	empty:Hide()
	ui.questList = { scroll = listScroll, content = listContent, headers = {}, rows = {}, empty = empty }

	local border = CreateFrame("Frame", "ClaudeWoWChatBorder", list)
	border:SetPoint("TOPLEFT", listScroll, "TOPLEFT", -3, 7)
	border:SetPoint("BOTTOMRIGHT", listScroll, "BOTTOMRIGHT", 19, -6)
	border:SetFrameLevel((Try(listScroll.GetFrameLevel, listScroll) or 1) + 20)
	border:EnableMouse(false)
	local edge = border:CreateTexture(nil, "BORDER")
	edge:SetAllPoints()
	if Q.SetArt(edge, "frame") then
		local filigree = border:CreateTexture(nil, "ARTWORK")
		filigree:SetPoint("TOP", border, "TOP", 0, 1)
		Q.SetArt(filigree, "filigree", true)
		local gradient = border:CreateTexture(nil, "BACKGROUND")
		gradient:SetPoint("BOTTOM", border, "BOTTOM", 0, 4)
		Q.SetArt(gradient, "gradient", true)
	else
		edge:Hide()
		local inset = Q.Panel(list, true)
		inset:SetAllPoints(border)
		inset:SetFrameLevel((Try(listScroll.GetFrameLevel, listScroll) or 1) - 1)
	end
	ui.listBorder = border

	local parchment = Q.Panel(f, true)
	parchment:SetPoint("TOPLEFT", f, "TOPLEFT", 8, Q.NAV_TOP - Q.NAV_H - 2)
	parchment:SetPoint("BOTTOMRIGHT", list, "BOTTOMLEFT", -6, 52)
	local paper = parchment:CreateTexture(nil, "BACKGROUND", nil, 1)
	paper:SetPoint("TOPLEFT", parchment, "TOPLEFT", 3, -3)
	paper:SetPoint("BOTTOMRIGHT", parchment, "BOTTOMRIGHT", -3, 3)
	if not Q.SetArt(paper, "parchment") and not Q.ClassicParchment(paper, 3) then paper:SetColorTexture(0.80, 0.70, 0.52, 1) end
	ui.parchment = parchment
	ui.transcriptPanel = parchment

	local bar = CreateFrame("Button", "ClaudeWoWTitleBar", f, Q.TemplateExists("NavBarTemplate") and "NavBarTemplate" or nil)
	bar:SetPoint("TOPLEFT", f, "TOPLEFT", 60, Q.NAV_TOP)
	bar:SetPoint("RIGHT", list, "LEFT", -6, 0)
	bar:SetHeight(Q.NAV_H)
	for _, key in ipairs({ "home", "overflow" }) do
		if type(bar[key]) == "table" and bar[key].Hide then bar[key]:Hide() end
	end
	local label = bar:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
	label:SetPoint("LEFT", bar, "LEFT", 12, 0)
	label:SetPoint("RIGHT", bar, "RIGHT", -12, 0)
	label:SetJustifyH("LEFT")
	label:SetWordWrap(false)
	bar:RegisterForClicks("LeftButtonUp", "RightButtonUp")
	bar:SetScript("OnClick", function(self, button)
		local c = ActiveChat()
		if not c then return end
		GameTooltip:Hide()
		if button == "RightButton" then
			ClaudeWoW.ShowChatMenu(c.id, self)
		else
			ClaudeWoW.RenamePrompt(c.id)
		end
	end)
	bar:SetScript("OnEnter", Q.TitleBarTooltip)
	bar:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.titleBar = bar
	ui.chatTitle = label
	ClaudeWoW.RefreshTitleBar()
end

function Q.Panel(parent, native)
	local p = CreateFrame("Frame", nil, parent, native and "InsetFrameTemplate" or "BackdropTemplate")
	if not native then
		p:SetBackdrop({
			bgFile = "Interface\\ChatFrame\\ChatFrameBackground",
			edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
			tile = true,
			tileSize = 16,
			edgeSize = 12,
			insets = { left = 3, right = 3, top = 3, bottom = 3 },
		})
		p:SetBackdropColor(0, 0, 0, 0.4)
		p:SetBackdropBorderColor(0.4, 0.4, 0.4, 1)
	end
	return p
end

function Q.BuildLegacyList(f)
	local panel = Q.Panel(f, false)
	panel:SetPoint("TOPLEFT", f, "TOPLEFT", 14, -52)
	panel:SetPoint("BOTTOMLEFT", f, "BOTTOMLEFT", 14, 50)
	panel:SetWidth(ns.PANEL_W)
	ui.listPanel = panel

	local newBtn = ns.MakeButton(panel, "New Chat", ns.PANEL_W - 16, function() ClaudeWoW.NewChat() end)
	newBtn:SetPoint("TOP", panel, "TOP", 0, -8)

	ui.chatButtons = {}
	for i = 1, Q.CHAT_PAGE do
		local b = CreateFrame("Button", nil, panel)
		b:SetSize(ns.PANEL_W - 16, 20)
		b:SetPoint("TOP", newBtn, "BOTTOM", 0, -6 - (i - 1) * 21)
		b.selected = b:CreateTexture(nil, "BACKGROUND")
		b.selected:SetAllPoints()
		b.selected:SetColorTexture(1, 1, 1, 0.12)
		b.selected:Hide()
		local hl = b:CreateTexture(nil, "HIGHLIGHT")
		hl:SetAllPoints()
		hl:SetColorTexture(1, 1, 1, 0.08)

		b.del = CreateFrame("Button", nil, b)
		b.del:SetSize(16, 16)
		b.del:SetPoint("RIGHT", b, "RIGHT", -2, 0)
		if C_Texture and C_Texture.GetAtlasExists and C_Texture.GetAtlasExists("128-RedButton-Delete") then
			b.del:SetNormalAtlas("128-RedButton-Delete")
			b.del:SetPushedAtlas("128-RedButton-Delete-Pressed")
			b.del:SetHighlightAtlas("128-RedButton-Delete-Highlight")
		else
			b.del:SetNormalTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Up")
			b.del:SetHighlightTexture("Interface\\Buttons\\UI-GroupLoot-Pass-Highlight")
		end
		b.del:SetAlpha(0.6)
		b.del:SetScript("OnClick", function() ClaudeWoW.ConfirmDelete(b.chatId) end)
		b.del:SetScript("OnEnter", function(self)
			self:SetAlpha(1)
			GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
			GameTooltip:SetText("Delete this chat")
			GameTooltip:Show()
		end)
		b.del:SetScript("OnLeave", function(self)
			self:SetAlpha(0.6)
			GameTooltip:Hide()
		end)

		b.label = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		b.label:SetPoint("LEFT", b, "LEFT", 6, 0)
		b.label:SetPoint("RIGHT", b.del, "LEFT", -4, 0)
		b.label:SetJustifyH("LEFT")
		b.label:SetWordWrap(false)
		b:RegisterForClicks("LeftButtonUp", "RightButtonUp")
		b:SetScript("OnClick", function(self, button)
			if button == "RightButton" then
				ClaudeWoW.ShowChatMenu(self.chatId, self)
			else
				ClaudeWoW.SwitchChat(self.chatId)
			end
		end)
		b:SetScript("OnDoubleClick", function(self)
			ClaudeWoW.SwitchChat(self.chatId)
			ClaudeWoW.RenamePrompt(self.chatId)
		end)
		b:Hide()
		ui.chatButtons[i] = b
	end
	local function PageButton(label, delta)
		local pb = ns.MakeButton(panel, label, 28, function()
			ui.chatPage = (ui.chatPage or 1) + delta
			ClaudeWoW.RenderChatList()
		end)
		pb:SetHeight(18)
		return pb
	end
	ui.pagePrev = PageButton("<", -1)
	ui.pagePrev:SetPoint("BOTTOMLEFT", panel, "BOTTOMLEFT", 8, 6)
	ui.pageNext = PageButton(">", 1)
	ui.pageNext:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -8, 6)
	ui.pageLabel = panel:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	ui.pageLabel:SetPoint("BOTTOM", panel, "BOTTOM", 0, 10)
	return panel
end
