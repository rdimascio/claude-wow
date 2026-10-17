local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Chat\\Context.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Whisper = ns.run, ns.Whisper
local Trim, Display = ns.Trim, ns.Display
local FmtTokens, FmtElapsed, SEG = ns.FmtTokens, ns.FmtElapsed, ns.SEG
local AddHistory = ns.AddHistory

---------------------------------------------------------------------------
-- Context growth
---------------------------------------------------------------------------
--
-- Every message resumes the chat's agent session, so the context the model
-- reads grows with every turn and each message costs more than the last
-- (measured: 107k tokens after 8 turns, 312k after 213). The bridge reports,
-- on every final reply, what the next message will carry (ctx), how many turns
-- the session has had, and the model's window when its CLI names it. The
-- footer shows it, /claude-wow context reports it, and past the threshold the
-- chat says so once and offers a new chat.

local function NoteUsage(c, r)
	if type(r.turns) == "number" then c.turns = r.turns end
	if type(r.ctx) == "number" and r.ctx > 0 then
		c.ctx = r.ctx
	elseif type(r.turns) == "number" and r.turns <= 1 then
		c.ctx = nil -- a fresh session with an agent that reports nothing
	end
	if type(r.window) == "number" and r.window > 0 then c.window = r.window end
	-- When the session started (its clock), and what it would have cost at API
	-- prices so far; a fresh session starts both over.
	if type(r.since) == "number" and r.since > 0 then c.since = r.since end
	if type(r.cost) == "number" then
		c.cost = r.cost
	elseif type(r.turns) == "number" and r.turns <= 1 then
		c.cost = nil
	end
end

-- The footer segment, shaped like Claude Code's status line:
-- "11m 58s · ↓ 186.7k tokens · ≈$2.41 API". Elapsed since the chat's current
-- agent session started; the tokens its next message carries; the session's
-- runs at API list prices ("API": a comparison, a subscription is not billed
-- by the token). Each part only when known; "" when none is.
local function ContextSegment(c, long)
	if not c then return "" end
	local parts = {}
	if c.since then table.insert(parts, FmtElapsed(time() - c.since)) end
	if c.ctx then table.insert(parts, SEG.DOWN .. " " .. FmtTokens(c.ctx) .. " tokens" .. ((long and c.window) and (" of " .. FmtTokens(c.window)) or "")) end
	if c.cost then table.insert(parts, SEG.APPROX .. string.format("$%.2f API", c.cost)) end
	return table.concat(parts, " " .. SEG.DOT .. " ")
end

-- "8 turns" for diag and the context report.
local function TurnsLabel(c)
	if not c or not c.turns then return "" end
	return c.turns .. (c.turns == 1 and " turn" or " turns")
end

local function ContextThresholdLabel()
	local limit = tonumber(ns.db.settings.contextWarn) or 0
	if limit > 0 then return "warning at " .. FmtTokens(limit) .. " tokens (/claude config context <n> to change, 0 = off)" end
	return "warning off (/claude config context <n> turns it on)"
end

-- What /claude-wow context prints for the current chat.
local function ContextReport(c)
	local size
	if c and c.ctx then
		size = "Context: "
			.. FmtTokens(c.ctx)
			.. " tokens"
			.. (c.window and (" of " .. FmtTokens(c.window)) or "")
			.. " after "
			.. (c.turns or "?")
			.. " turn"
			.. ((c.turns or 0) == 1 and "" or "s")
			.. ": that is what your next message here re-reads before it starts on your question."
	elseif c and c.turns then
		size = "Context: "
			.. c.turns
			.. " turn"
			.. (c.turns == 1 and "" or "s")
			.. " in this session; "
			.. ns.ChatAgentName(c)
			.. " does not report its context size."
	else
		size = "Context: nothing yet - no reply in this session."
	end
	if c and c.since then
		size = size
			.. "\nSession: "
			.. FmtElapsed(time() - c.since)
			.. " since it started"
			.. (c.cost and string.format(
				"; %s$%.2f at API list prices so far (a comparison, not a bill: a subscription is not charged per token)",
				SEG.APPROX,
				c.cost
			) or "")
			.. "."
	end
	return size .. "\n" .. ContextThresholdLabel():gsub("^%l", string.upper) .. "."
end

-- Past the threshold: say so once per crossing (a fresh session brings the
-- number back down, which re-arms it), with a New chat button on the message.
local function ContextWarning(c)
	local limit = tonumber(ns.db.settings.contextWarn) or 0
	if limit <= 0 or not c.ctx or c.ctx < limit then
		c.ctxWarned = nil
		return
	end
	if c.ctxWarned then return end
	c.ctxWarned = true
	local size = FmtTokens(c.ctx) .. " tokens"
	local text = "This chat's context is "
		.. size
		.. (c.window and (" of " .. FmtTokens(c.window)) or "")
		.. " after "
		.. (c.turns or "?")
		.. " turn"
		.. ((c.turns or 0) == 1 and "" or "s")
		.. ", past the "
		.. FmtTokens(limit)
		.. " mark: every message re-reads all of it, so replies cost more and start slower.\n"
		.. "New chat starts "
		.. ns.ChatAgentName(c)
		.. " fresh; this transcript stays here.\n"
		.. "/claude config context <n> moves the mark, 0 turns it off."
	AddHistory(c, "system", text)
	c.history[#c.history].newChat = true
	-- Where the reply itself went: the whisper tab if the chat has one, else the game chat.
	if not Whisper.Reply(c, text, nil, "system") then
		print(ClaudeWoW.PREFIX .. Display(c.name) .. ": " .. (text:gsub("\n", " ")) .. " Type /claude new for a new chat.")
	end
end

---------------------------------------------------------------------------
-- Game context and links
---------------------------------------------------------------------------

-- The agent only sees text, so two things about the game are spelled out for it:
-- who is asking (the character, where they are; sent with the hello and again
-- when it changes, and put into the agent's system prompt by the bridge), and
-- what the player shift-clicked into the message (item, spell and quest links
-- are meaningless markup to the agent; their tooltips are what the player sees).
-- Every game API here is optional: whatever the client lacks is left out.

local CTX = { MAX = 900, LINK_LINES_MAX = 30, LINK_BYTES_MAX = 900 }

local Try = ns.Try

local Money = ns.Money

-- A few lines about the game and the character, as the bridge will show them to the agent.
-- Profession and secondary skill lines by skill id (vanilla ids).
local PROFESSION_SKILL_IDS = {
	[164] = true,
	[165] = true,
	[171] = true,
	[182] = true,
	[186] = true,
	[197] = true,
	[202] = true,
	[333] = true,
	[393] = true,
	[129] = true,
	[185] = true,
	[356] = true,
}
ClaudeWoW.PROFESSION_SKILL_IDS = PROFESSION_SKILL_IDS
ClaudeWoW.PROFESSION_SKILL_NAMES = {
	Blacksmithing = 164,
	Leatherworking = 165,
	Alchemy = 171,
	Herbalism = 182,
	Mining = 186,
	Tailoring = 197,
	Engineering = 202,
	Enchanting = 333,
	Skinning = 393,
	["First Aid"] = 129,
	Cooking = 185,
	Fishing = 356,
}

-- The character's skill lines as { name, isHeader, rank, maxRank, skillID }.
-- Forever only has C_SkillInfo (one table per line); the classic globals
-- (multiple returns) are the fallback for other clients.
function ClaudeWoW.SkillLines()
	local out = {}
	if C_SkillInfo and C_SkillInfo.GetNumSkillLines then
		local n = Try(C_SkillInfo.GetNumSkillLines)
		local seen = {}
		for i = 1, (type(n) == "number" and n or 0) do
			local sk = Try(C_SkillInfo.GetSkillLineInfo, i)
			-- Child lines (parentSkillLineID ~= 0) repeat their parent; Blizzard's
			-- skills frame skips them too.
			if type(sk) == "table" and type(sk.name) == "string" and (sk.parentSkillLineID or 0) == 0 then
				local key = sk.isHeader and ("h:" .. sk.name) or (sk.skillID or sk.name)
				if not seen[key] then
					seen[key] = true
					out[#out + 1] = { name = sk.name, isHeader = sk.isHeader, rank = sk.rank, maxRank = sk.maxRank, skillID = sk.skillID }
				end
			end
		end
		return out
	end
	local n = Try(GetNumSkillLines)
	for i = 1, (type(n) == "number" and n or 0) do
		local sname, isHeader, _, rank, _, _, maxRank = Try(GetSkillLineInfo, i)
		if type(sname) == "string" then
			out[#out + 1] = {
				name = sname,
				isHeader = isHeader and true or false,
				rank = rank,
				maxRank = maxRank,
				skillID = not isHeader and ClaudeWoW.PROFESSION_SKILL_NAMES[sname] or nil,
			}
		end
	end
	return out
end

function ClaudeWoW.ActiveTraitConfigID()
	local specGroup = Try(C_SpecializationInfo and C_SpecializationInfo.GetActiveSpecGroup)
	if type(specGroup) ~= "number" then return nil end
	local configID = Try(C_SpecializationInfo.GetCombatConfigIDForSpecGroup, specGroup)
	if type(configID) == "number" then return configID end
end

function ClaudeWoW.TraitTalentTrees()
	if not C_Traits then return {} end
	local configID = ClaudeWoW.ActiveTraitConfigID()
	if not configID then return {} end
	local config = Try(C_Traits.GetConfigInfo, configID)
	local treeID = type(config) == "table" and type(config.treeIDs) == "table" and config.treeIDs[1]
	if type(treeID) ~= "number" then return {} end
	local displays = Try(C_Traits.GetGroupDisplayInfoByTreeID, treeID)
	if type(displays) ~= "table" then return {} end
	local groupIDs = {}
	for _, display in ipairs(displays) do
		if type(display) == "table" and type(display.groupID) == "number" then table.insert(groupIDs, display.groupID) end
	end
	local currencies = Try(C_Traits.GetGroupCurrencyInfo, configID, groupIDs)
	if type(currencies) ~= "table" then return {} end
	local spentByGroup = {}
	for _, group in ipairs(currencies) do
		local first = type(group) == "table" and type(group.traitNodeGroupID) == "number" and type(group.currencyInfos) == "table" and group.currencyInfos[1]
		if type(first) == "table" and type(first.spent) == "number" then spentByGroup[group.traitNodeGroupID] = first.spent end
	end
	if next(spentByGroup) == nil then return {} end
	local trees = {}
	for _, display in ipairs(displays) do
		if type(display) == "table" and type(display.displayName) == "string" and display.displayName ~= "" then
			table.insert(trees, { name = display.displayName, points = spentByGroup[display.groupID] or 0 })
		end
	end
	return trees
end

function ClaudeWoW.TabTalentTrees()
	local trees = {}
	local tabs = Try(GetNumTalentTabs)
	local specInfo = C_SpecializationInfo and C_SpecializationInfo.GetSpecializationInfo
	for i = 1, (type(tabs) == "number" and tabs or 0) do
		local tname, points
		if specInfo then
			local _, specName, _, _, _, _, spent = Try(specInfo, i)
			tname, points = specName, spent
		else
			local tabName, _, spent = Try(GetTalentTabInfo, i)
			tname, points = tabName, spent
		end
		if type(tname) == "string" and type(points) == "number" then table.insert(trees, { name = tname, points = points }) end
	end
	return trees
end

function ClaudeWoW.TalentTrees()
	local trees = Try(ClaudeWoW.TraitTalentTrees)
	if type(trees) == "table" and #trees > 0 then return trees end
	trees = Try(ClaudeWoW.TabTalentTrees)
	return type(trees) == "table" and trees or {}
end

function ClaudeWoW.CharacterLine()
	local name = Try(UnitName, "player")
	if not name then return nil end
	local realm = Try(GetRealmName)
	local level = Try(UnitLevel, "player")
	local race = Try(UnitRace, "player")
	local class = Try(UnitClass, "player")
	local faction = Try(UnitFactionGroup, "player")
	local guild = Try(GetGuildInfo, "player")
	local who = tostring(name) .. (realm and (" on " .. tostring(realm)) or "")
	local desc = {}
	if level then table.insert(desc, "level " .. tostring(level)) end
	if race then table.insert(desc, tostring(race)) end
	if class then table.insert(desc, tostring(class)) end
	if #desc > 0 then who = who .. ", " .. table.concat(desc, " ") end
	if faction then who = who .. " (" .. tostring(faction) .. ")" end
	if guild then who = who .. ", guild <" .. tostring(guild) .. ">" end
	return who
end

ClaudeWoW.Polestar = {
	ID_KEYS = { "quest", "npc", "object", "item", "spell", "faction", "skillLine", "achievement", "criteria", "level" },
	OPEN = { active = true, pending = true },
	LABEL = "Polestar guide: ",
}

function ClaudeWoW.Polestar.Whole(n) return type(n) == "number" and n >= 0 and n == math.floor(n) and n < 2 ^ 31 end

function ClaudeWoW.Polestar.GoalText(view, raw)
	if type(view) ~= "table" or type(view.t) ~= "string" or not view.t:match("^%a+$") then return nil end
	raw = type(raw) == "table" and raw or {}
	local whole = ClaudeWoW.Polestar.Whole
	local parts = { view.t }
	for _, key in ipairs(ClaudeWoW.Polestar.ID_KEYS) do
		local id = view[key]
		if id == nil then id = raw[key] end
		if whole(id) and id > 0 then table.insert(parts, key .. " " .. id) end
	end
	if #parts == 1 and whole(view.map) and view.map > 0 then table.insert(parts, "map " .. view.map) end
	local p = view.progress
	if type(p) == "table" and whole(p.cur) and whole(p.max) then
		table.insert(parts, p.cur .. "/" .. p.max)
	elseif whole(raw.count) and raw.count > 0 then
		table.insert(parts, "x" .. raw.count)
	end
	if view.optional then table.insert(parts, "optional") end
	return table.concat(parts, " ")
end

function ClaudeWoW.Polestar.Line(room)
	local host = rawget(_G, "Polestar")
	local engine = type(host) == "table" and host.Engine
	if type(engine) ~= "table" or type(room) ~= "number" then return nil end
	local guide = Try(engine.GetGuide)
	local id = type(guide) == "table" and type(guide.id) == "string" and guide.id or ""
	if id == "" or id:find("[^%w/_%.%-]") then return nil end
	local head = ClaudeWoW.Polestar.LABEL .. id
	local whole = ClaudeWoW.Polestar.Whole
	local ok, step = pcall(engine.GetLiveStep)
	if not ok or not whole(step) or step < 1 then
		local done, total = Try(engine.GetProgress)
		local line = (ok and step == nil and whole(total) and total > 0 and done == total) and (head .. ", complete") or head
		return #line <= room and line or nil
	end
	local count = Try(engine.GetStepCount)
	local line = head .. ", step " .. step .. ((whole(count) and count > 0) and ("/" .. count) or "")
	if #line > room then return nil end
	local view = Try(engine.GetStepView, step)
	local goals = type(view) == "table" and type(view.goals) == "table" and view.goals or {}
	local rawSteps = type(guide.steps) == "table" and guide.steps
	local rawStep = rawSteps and type(rawSteps[step]) == "table" and rawSteps[step]
	local rawGoals = rawStep and type(rawStep.goals) == "table" and rawStep.goals or {}
	local aim = Try(engine.GetWaypoint)
	local first = type(aim) == "table" and aim.stepIndex == step and aim.goalIndex
	if not goals[first] then first = type(view) == "table" and view.current end
	local order = {}
	if goals[first] then table.insert(order, first) end
	for i in ipairs(goals) do
		if i ~= first then table.insert(order, i) end
	end
	local sep = "; open: "
	for _, i in ipairs(order) do
		local goal = goals[i]
		local text = type(goal) == "table" and goal.t ~= "note" and ClaudeWoW.Polestar.OPEN[goal.status] and ClaudeWoW.Polestar.GoalText(goal, rawGoals[i])
		if text then
			if #line + #sep + #text > room then break end
			line = line .. sep .. text
			sep = ", "
		end
	end
	return line
end

function ClaudeWoW.GameContext()
	local lines = {}
	local version, build, _, toc = Try(GetBuildInfo)
	toc = tonumber(toc)
	local game = "World of Warcraft"
	if toc and toc >= 16000 and toc < 20000 then
		game = "World of Warcraft: Forever"
	elseif toc and toc >= 11500 and toc < 11600 then
		game = "World of Warcraft Classic"
	end
	local client = ""
	if version then
		client = " (client " .. tostring(version) .. (build and ("." .. tostring(build)) or "") .. (toc and (", interface " .. toc) or "") .. ")"
	end
	table.insert(lines, "Game: " .. game .. client)

	local who = ClaudeWoW.CharacterLine()
	if who then table.insert(lines, "Character: " .. who) end

	local zone = Try(GetZoneText)
	local sub = Try(GetSubZoneText)
	if zone and zone ~= "" then table.insert(lines, "Location: " .. zone .. ((sub and sub ~= "" and sub ~= zone) and (" - " .. sub) or "")) end

	-- Map coordinates, as the minimap shows them (0-100 across the current map;
	-- addons get no world x/y/z). Modern C_Map first, the vanilla call as fallback.
	local x, y, mapName
	local mapId = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	if type(mapId) == "number" then
		local pos = Try(C_Map.GetPlayerMapPosition, mapId, "player")
		if type(pos) == "table" and type(pos.x) == "number" and type(pos.y) == "number" then
			x, y = pos.x, pos.y
		end
		local info = Try(C_Map.GetMapInfo, mapId)
		if type(info) == "table" and type(info.name) == "string" then mapName = info.name end
	end
	if not x then
		local px, py = Try(GetPlayerMapPosition, "player")
		if type(px) == "number" and type(py) == "number" then
			x, y = px, py
		end
	end
	if x and y and (x > 0 or y > 0) then
		local where = (mapName and mapName ~= zone) and (" on " .. mapName) or ""
		table.insert(lines, string.format("Position: %.1f, %.1f%s%s", x * 100, y * 100, where, mapId and (" (map " .. mapId .. ")") or ""))
	end

	local progress = {}
	local copper = Try(GetMoney)
	if copper then table.insert(progress, "Money: " .. Money(copper)) end
	local xp, xpMax = Try(UnitXP, "player"), Try(UnitXPMax, "player")
	if type(xp) == "number" and type(xpMax) == "number" and xpMax > 0 then table.insert(progress, "XP: " .. xp .. "/" .. xpMax) end
	if #progress > 0 then table.insert(lines, table.concat(progress, "; ")) end

	local trees = ClaudeWoW.TalentTrees()
	if #trees > 0 then
		local parts = {}
		for _, tree in ipairs(trees) do
			table.insert(parts, tree.name .. " " .. tree.points)
		end
		table.insert(lines, "Talents: " .. table.concat(parts, " / "))
	end

	-- Skill lines under the Professions and Secondary Skills headers.
	local header, parts = nil, {}
	local wanted = { [TRADE_SKILLS or "Professions"] = true, [SECONDARY_SKILLS or "Secondary Skills"] = true }
	for _, sk in ipairs(ClaudeWoW.SkillLines()) do
		if sk.isHeader then
			header = sk.name
		elseif (header and wanted[header]) or PROFESSION_SKILL_IDS[sk.skillID] then
			table.insert(parts, sk.name .. (sk.rank and (" " .. tostring(sk.rank) .. (sk.maxRank and ("/" .. tostring(sk.maxRank)) or "")) or ""))
		end
	end
	if #parts > 0 then table.insert(lines, "Professions: " .. table.concat(parts, ", ")) end

	-- Quest log ids (what is accepted, and which are done), so route planning can
	-- skip pickups and turn-ins that no longer apply.
	local quests = {}
	local qn = Try(C_QuestLog and C_QuestLog.GetNumQuestLogEntries) or Try(GetNumQuestLogEntries)
	if type(qn) == "number" then
		for i = 1, math.min(qn, 40) do
			local id, questHeader, complete
			local info = Try(C_QuestLog and C_QuestLog.GetInfo, i)
			if type(info) == "table" then
				id, questHeader = info.questID, info.isHeader
				complete = Try(C_QuestLog.IsComplete, id)
			else
				local _, _, _, isHeader, _, isComplete, _, qid = Try(GetQuestLogTitle, i)
				id, questHeader, complete = qid, isHeader, isComplete == 1 or isComplete == true
			end
			if not questHeader and type(id) == "number" and id > 0 then table.insert(quests, tostring(id) .. (complete and "*" or "")) end
		end
	end
	if #quests > 0 then table.insert(lines, "Quest log (id, * = ready to turn in): " .. table.concat(quests, ",")) end

	local s = table.concat(lines, "\n"):gsub("[\30\31]", " ")
	local guideLine = ClaudeWoW.Polestar.Line(CTX.MAX - #s - 1)
	if guideLine then s = s .. "\n" .. guideLine end
	if #s > CTX.MAX then s = s:sub(1, CTX.MAX) end
	return s
end

-- The context to put on the next record, or nil when the bridge already has
-- it (or it wouldn't fit next to this message; it goes with a later one).
-- "" when the setting is off, so the bridge drops what it had.
local function ContextToSend(room)
	local ctx = ns.db.settings.context and ClaudeWoW.GameContext() or ""
	if ctx == (run.contextSent or "") then return nil end
	if room and #ctx > room then return nil end
	return ctx
end

-- Read a link's tooltip off a hidden GameTooltip, one line per row.
local scanTip
local function TooltipLines(payload)
	if not scanTip then scanTip = CreateFrame("GameTooltip", "ClaudeWoWScanTip", UIParent, "GameTooltipTemplate") end
	scanTip:SetOwner(UIParent, "ANCHOR_NONE")
	scanTip:ClearLines()
	local lines = {}
	if pcall(scanTip.SetHyperlink, scanTip, payload) then
		for i = 1, math.min(scanTip:NumLines() or 0, CTX.LINK_LINES_MAX) do
			local left = _G["ClaudeWoWScanTipTextLeft" .. i]
			local right = _G["ClaudeWoWScanTipTextRight" .. i]
			local l = Trim(tostring((left and left:GetText()) or ""))
			local r = Trim(tostring((right and right:IsShown() and right:GetText()) or ""))
			if r ~= "" then l = l .. "  " .. r end
			if l ~= "" then table.insert(lines, l) end
		end
	end
	scanTip:Hide()
	return lines
end

-- What a link is, in words: "item 2140 (Uncommon)", "spell 1978", "quest 176".
local function DescribeLink(payload)
	local kind, id = payload:match("^(%a+):(%d+)")
	if not kind then return payload:match("^(%a+)") or "link" end
	local s = kind .. " " .. id
	if kind == "item" then
		local _, _, quality = Try((C_Item and C_Item.GetItemInfo) or GetItemInfo, payload)
		local desc = type(quality) == "number" and _G["ITEM_QUALITY" .. quality .. "_DESC"]
		if desc then s = s .. " (" .. desc .. ")" end
	end
	return s
end

-- Turn the links in a message into text the agent can use: each becomes [Name]
-- in place, and a block at the end lists what the tooltip says about it.
-- Returns the new text and the number of links found.
function ClaudeWoW.ExpandLinks(text)
	local links, seen = {}, {}
	local function Take(payload, name)
		if not seen[payload] then
			seen[payload] = true
			table.insert(links, { payload = payload, name = name })
		end
		return "[" .. name .. "]"
	end
	-- Coloured links first (|cAARRGGBB|H...|h[Name]|h|r), then bare ones.
	local out = text:gsub("|c%x%x%x%x%x%x%x%x|H([^|]+)|h%[([^%]]*)%]|h|r", Take)
	out = out:gsub("|H([^|]+)|h%[([^%]]*)%]|h", Take)
	if #links == 0 then return text, 0 end
	local blocks = {}
	for _, l in ipairs(links) do
		local head = "[" .. l.name .. "] " .. DescribeLink(l.payload)
		local body = table.concat(TooltipLines(l.payload), "\n  ")
		local block = body ~= "" and (head .. "\n  " .. body) or head
		if #block > CTX.LINK_BYTES_MAX then block = block:sub(1, CTX.LINK_BYTES_MAX) .. "..." end
		table.insert(blocks, block)
	end
	return out .. "\n\n--- Linked from the game ---\n" .. table.concat(blocks, "\n"), #links
end
ns.NoteUsage, ns.ContextSegment, ns.TurnsLabel, ns.ContextThresholdLabel, ns.ContextReport, ns.ContextWarning =
	NoteUsage, ContextSegment, TurnsLabel, ContextThresholdLabel, ContextReport, ContextWarning
ns.ContextToSend = ContextToSend
