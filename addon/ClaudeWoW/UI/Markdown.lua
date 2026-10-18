local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "UI\\Markdown.lua"

local ClaudeWoW = ns.ClaudeWoW
local ui, Q = ns.ui, ns.Q
local Try, Display, Trim = ns.Try, ns.Display, ns.Trim
local LINK_PREFIX = ns.LINK_PREFIX

local ECHO = { DEFAULT = 4000, SUMMARY_LINES = 3, SUMMARY_FALLBACK_LINES = 2 }
ns.ECHO = ECHO

Q.LINK_RETRY_SECONDS, Q.LINK_RETRIES = 0.5, 3
Q.linkTries = {}
Q.linkMissing = false

function Q.ItemLink(id)
	local info = (C_Item and C_Item.GetItemInfo) or GetItemInfo
	local _, link = Try(info, id)
	if type(link) == "string" then return link end
	Q.linkMissing = true
	if C_Item and C_Item.RequestLoadItemDataByID then pcall(C_Item.RequestLoadItemDataByID, id) end
	return nil
end

function Q.SpellLink(id)
	local link = Try((C_Spell and C_Spell.GetSpellLink) or GetSpellLink, id)
	if type(link) == "string" then return link end
	if C_Spell and C_Spell.RequestLoadSpellData then
		Q.linkMissing = true
		pcall(C_Spell.RequestLoadSpellData, id)
	end
	return nil
end

function Q.QuestTitle(id)
	local n = Try(C_QuestLog and C_QuestLog.GetNumQuestLogEntries) or Try(GetNumQuestLogEntries) or 0
	for i = 1, math.min(tonumber(n) or 0, 60) do
		local info = Try(C_QuestLog and C_QuestLog.GetInfo, i)
		if type(info) == "table" then
			if tonumber(info.questID) == id and not info.isHeader then return info.title, info.level, i end
		else
			local title, level, _, isHeader, _, _, _, qid = Try(GetQuestLogTitle, i)
			if tonumber(qid) == id and not isHeader then return title, level, i end
		end
	end
	return nil
end

function Q.RichToken(kind, id)
	id = tonumber(id)
	if not id then return nil end
	if kind == "item" then return Q.ItemLink(id) end
	if kind == "spell" then return Q.SpellLink(id) end
	if kind == "quest" then
		local title, level = Q.QuestTitle(id)
		return title and ("|cffffff00|Hquest:" .. id .. ":" .. math.floor(tonumber(level) or 0) .. "|h[" .. Display(title):gsub("[%[%]]", "") .. "]|h|r") or nil
	end
	return nil
end

Q.PARCHMENT_LINK_COLORS = {
	ff9d9d9d = "ff5c5248",
	ffffffff = "ff2e1f0f",
	ff1eff00 = "ff0d6b00",
	ff0070dd = "ff004c99",
	ffa335ee = "ff6a1b9a",
	ffff8000 = "ff9a4a00",
	ffe6cc80 = "ff7a5c1e",
	ffffff00 = "ff7a3b00",
	ffffd100 = "ff7a3b00",
	ff71d5ff = "ff1c4f9c",
}

Q.GAME_LINK_COLORS = {}
for game, dark in pairs(Q.PARCHMENT_LINK_COLORS) do
	if game ~= "ffffd100" then Q.GAME_LINK_COLORS[dark] = game end
end

function Q.OffParchment(text)
	return (
		tostring(text or ""):gsub("|c(%x%x%x%x%x%x%x%x)", function(hex)
			local game = Q.GAME_LINK_COLORS[hex:lower()]
			return game and ("|c" .. game) or nil
		end)
	)
end

function Q.OnParchment(link)
	return (link:gsub("|c(%x%x%x%x%x%x%x%x)", function(hex)
		local dark = Q.PARCHMENT_LINK_COLORS[hex:lower()]
		return dark and ("|c" .. dark) or nil
	end))
end

Q.URL_CHARS = "[%w%-%._~:/%?#@!%$&'%(%)%+,;=%%]"
Q.TEXT_INK = { game = { strong = "ffffffff", code = "ffa8c8d8", link = "ff71d5ff" } }
Q.TEXT_INK.parchment = { strong = "ff5c1a00", code = "ff7a2e0e", link = Q.PARCHMENT_LINK_COLORS[Q.TEXT_INK.game.link] }

function Q.UrlLabel(url)
	local n = url:match("^https?://github%.com/[^/]+/[^/]+/pull/(%d+)")
	if n then return "PR #" .. n end
	n = url:match("^https?://github%.com/[^/]+/[^/]+/issues/(%d+)")
	if n then return "Issue #" .. n end
	local key = url:match("^https?://linear%.app/[^/]+/issue/(%u+%-%d+)")
	if key then return key end
	local short = url:gsub("^https?://", ""):gsub("^www%.", ""):gsub("/$", "")
	return #short > 32 and (short:sub(1, 31) .. "\226\128\166") or short
end

function Q.UrlLink(url, label, ink) return "|c" .. ink.link .. "|H" .. LINK_PREFIX .. "url:" .. url .. "|h[" .. label:gsub("[%[%]%*`]", "") .. "]|h|r" end

function Q.SplitUrl(url)
	local trail = ""
	while true do
		local last = url:sub(-1)
		local _, opens = url:gsub("%(", "")
		local _, closes = url:gsub("%)", "")
		if last:match("[%.,;:!%?]") or (last == ")" and closes > opens) then
			trail, url = last .. trail, url:sub(1, -2)
		else
			return url, trail
		end
	end
end

function Q.MarkFences(text)
	local out, fenced = {}, false
	for line in (tostring(text or "") .. "\n"):gmatch("(.-)\n") do
		if line:match("^%s*```") then
			fenced = not fenced
		elseif fenced and line:match("%S") then
			table.insert(out, "\3" .. line)
		else
			table.insert(out, line)
		end
	end
	return table.concat(out, "\n")
end

Q.SUMMARY_STRIP_CHARS = 400

function Q.SummaryMarkerEnd(line)
	local s = line:lower()
	local i = s:match("^[ \t]*#*[ \t]*()")
	local bold = s:sub(i, i + 1)
	if bold == "**" or bold == "__" then i = s:match("^..[ \t]*()", i) end
	i = s:match("^tl;?dr()", i)
	if not i then return nil end
	i = s:match("^[ \t]*:?[ \t]*()", i)
	bold = s:sub(i, i + 1)
	if bold == "**" or bold == "__" then i = i + 2 end
	return s:match("^[ \t]*:?[ \t]*()", i)
end

function Q.FenceRun(line)
	local fence, rest = line:match("^%s*(```+)(.*)$")
	if not fence then
		fence, rest = line:match("^%s*(~~~+)(.*)$")
	end
	if not fence then return nil end
	return fence:sub(1, 1), #fence, rest
end

function Q.StripSummary(text, summary)
	text = tostring(text or "")
	local lines, open, at, after, inFence = {}, nil, nil, nil, false
	for line in (text .. "\n"):gmatch("(.-)\n") do
		table.insert(lines, line)
		local mark, size, rest = Q.FenceRun(line)
		if open and mark == open.mark and size >= open.size and rest:match("^%s*$") then
			open = nil
		elseif not open and mark then
			open = { mark = mark, size = size }
		else
			local e = Q.SummaryMarkerEnd(line)
			if e then
				at, after, inFence = #lines, e, open ~= nil
			end
		end
	end
	if not at or inFence then return text end
	local rest = { lines[at]:sub(after) }
	for k = at + 1, #lines do
		table.insert(rest, lines[k])
	end
	local tail = Trim(table.concat(rest, "\n"))
	if tail == "" or #tail > Q.SUMMARY_STRIP_CHARS then return text end
	local tailLines = 0
	for _ in tail:gmatch("[^\n]*%S[^\n]*") do
		tailLines = tailLines + 1
	end
	if tailLines > ECHO.SUMMARY_LINES then return text end
	if type(summary) == "string" and summary ~= "" and Trim(summary) ~= tail then return text end
	local head = table.concat(lines, "\n", 1, at - 1):gsub("%s+$", "")
	return head ~= "" and head or tail
end

function Q.MarkdownLine(line, ink, parchment)
	if line:sub(1, 1) == "\3" then return line:sub(2) end
	local held = {}
	local function hold(link)
		table.insert(held, link)
		return "\1" .. #held .. "\2"
	end
	line = line:gsub("^[%-%*] ", "\226\128\162 ")
	line = line:gsub("^%s*#+%s+(.+)$", "**%1**")
	line = line:gsub("%[([^%]]+)%]%((https?://" .. Q.URL_CHARS .. "+)%)", function(label, found)
		local url, trail = Q.SplitUrl(found)
		return hold(Q.UrlLink(url, label, ink)) .. trail
	end)
	line = line:gsub("(https?://" .. Q.URL_CHARS .. "+)", function(found)
		local url, trail = Q.SplitUrl(found)
		if not url:match("^https?://[%w%-]") then return found end
		return hold(Q.UrlLink(url, Q.UrlLabel(url), ink)) .. trail
	end)
	line = line:gsub("%*%*([^%*]+)%*%*", "|c" .. ink.strong .. "%1|r")
	line = line:gsub("`([^`]+)`", "|c" .. ink.code .. "%1|r")
	line = line:gsub("\1(%d+)\2", function(k) return held[tonumber(k)] end)
	return (
		line:gsub("{(%a+):(%d+)}", function(kind, id)
			local shown = Q.RichToken(kind:lower(), id) or ("|cff9d9d9d" .. kind .. " " .. id .. "|r")
			return parchment and Q.OnParchment(shown) or shown
		end)
	)
end

function Q.Markdown(text, parchment)
	local ink = parchment and Q.TEXT_INK.parchment or Q.TEXT_INK.game
	local lines = {}
	for line in (Q.MarkFences(text) .. "\n"):gmatch("(.-)\n") do
		table.insert(lines, Q.MarkdownLine(line, ink, parchment))
	end
	return table.concat(lines, "\n")
end

function Q.RichText(text, parchment) return Q.Markdown(tostring(text or ""), parchment) end

function Q.WaitForLinks(text, key)
	Q.linkMissing = false
	Q.RichText(text)
	if not Q.linkMissing then return false end
	local tries = (Q.linkTries[key] or 0) + 1
	Q.linkTries[key] = tries
	return tries <= Q.LINK_RETRIES
end

Q.linkEvents = CreateFrame("Frame")
pcall(Q.linkEvents.RegisterEvent, Q.linkEvents, "GET_ITEM_INFO_RECEIVED")
pcall(Q.linkEvents.RegisterEvent, Q.linkEvents, "SPELL_DATA_LOAD_RESULT")
Q.linkEvents:SetScript("OnEvent", function()
	if Q.linkRedraw or not ui.frame then return end
	Q.linkRedraw = true
	C_Timer.After(Q.LINK_RETRY_SECONDS, function()
		Q.linkRedraw = nil
		if ui.frame and ui.frame:IsShown() then ClaudeWoW.Render() end
	end)
end)

function Q.CollapsedHeaders()
	local names = {}
	for i = 1, math.min(tonumber(Try(GetNumQuestLogEntries)) or 0, 60) do
		local title, _, _, isHeader, isCollapsed = Try(GetQuestLogTitle, i)
		if isHeader and isCollapsed and title then names[title] = true end
	end
	return names
end

function Q.CollapseAgain(names)
	if type(CollapseQuestHeader) ~= "function" then return end
	for i = math.min(tonumber(Try(GetNumQuestLogEntries)) or 0, 60), 1, -1 do
		local title, _, _, isHeader = Try(GetQuestLogTitle, i)
		if isHeader and names[title] then pcall(CollapseQuestHeader, i) end
	end
end

function Q.OpenQuest(id)
	local _, _, index = Q.QuestTitle(id)
	if not index and type(ExpandQuestHeader) == "function" then
		local collapsed = Q.CollapsedHeaders()
		pcall(ExpandQuestHeader, 0)
		index = select(3, Q.QuestTitle(id))
		if not index then Q.CollapseAgain(collapsed) end
	end
	if not index then return false end
	if type(QuestMapFrame_OpenToQuestDetails) == "function" then return (pcall(QuestMapFrame_OpenToQuestDetails, id)) end
	if type(QuestLog_SetSelection) ~= "function" or not QuestLogFrame then return false end
	if not QuestLogFrame:IsShown() then pcall(ShowUIPanel, QuestLogFrame) end
	if type(QuestLog_Update) == "function" then pcall(QuestLog_Update) end
	if QuestLogListScrollFrameScrollBar and tonumber(QUESTLOG_QUEST_HEIGHT) then
		pcall(QuestLogListScrollFrameScrollBar.SetValue, QuestLogListScrollFrameScrollBar, (index - 1) * QUESTLOG_QUEST_HEIGHT)
	end
	local ok = pcall(QuestLog_SetSelection, index)
	if type(QuestLog_Update) == "function" then pcall(QuestLog_Update) end
	return ok
end

function Q.LinkClick(self, link, text, button)
	self.linkClickAt = GetTime()
	local quest = tonumber(tostring(link or ""):match("^quest:(%d+)"))
	local modified = type(IsModifiedClick) == "function" and IsModifiedClick()
	if quest and not modified and Q.OpenQuest(quest) then return end
	if type(SetItemRef) == "function" then SetItemRef(link, Q.OffParchment(text), button, self) end
end

function Q.LinkEnter(self, link)
	local kind = tostring(link or ""):match("^(%a+):")
	if kind ~= "item" and kind ~= "spell" and kind ~= "quest" then return end
	GameTooltip:SetOwner(self, "ANCHOR_CURSOR")
	if pcall(GameTooltip.SetHyperlink, GameTooltip, link) then
		GameTooltip:Show()
	else
		GameTooltip:Hide()
	end
end

function Q.WhenLabel(t)
	t = tonumber(t)
	if not t then return "" end
	if date("%Y-%m-%d", t) == date("%Y-%m-%d", time()) then return "at " .. date("%H:%M", t) end
	return "on " .. date("%b %d", t)
end
