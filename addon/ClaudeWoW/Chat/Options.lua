local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Chat\\Options.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q, Cli, Whisper = ns.run, ns.ui, ns.Q, ns.Cli, ns.Whisper
local ToHex, Display, Trim, Contains, Try, TellPlayer = ns.ToHex, ns.Display, ns.Trim, ns.Contains, ns.Try, ns.TellPlayer
local LIVE_PLUGIN = ns.LIVE_PLUGIN
local ActiveChat = ns.ActiveChat

function Cli.NormalizeFolder(cwd)
	local p = tostring(cwd or "")
	local home = run.bridgeHome
	if home and home ~= "" then
		if p == "~" then
			p = home
		elseif p:match("^~[\\/]") then
			p = home:gsub("[\\/]+$", "") .. p:sub(2)
		end
	end
	if #p > 1 then p = p:gsub("([^:\\/])[\\/]+$", "%1") end
	return p
end

-- Last path component of a folder, for labels.
local function FolderName(cwd)
	local labels = run.bridgeProjectLabels
	local label = labels and labels[Cli.NormalizeFolder(cwd)]
	if label and label ~= "" then return label end
	local name = tostring(cwd or ""):gsub("[\\/]+$", ""):match("([^\\/]+)$")
	return name or ""
end

-- The folder a chat works in: its own, or the bridge's default (the folder the
-- bridge was started from), which the bridge reports in every slot file.
local function ChatFolder(c) return Cli.ProjectOf(c) end
ns.FolderName, ns.ChatFolder = FolderName, ChatFolder

-- Agents are named by id as the bridge knows them ("claude", "codex", "grok");
-- the bridge lists the ones it has, and its default, in every slot file. A chat
-- with no agent of its own runs on the bridge's default.
local AGENT_NAMES = { claude = "Claude", codex = "Codex", grok = "Grok", agy = "Antigravity", hermes = "Hermes" }

local function AgentName(id)
	id = tostring(id or "")
	if id == "" then return "AI" end
	return AGENT_NAMES[id] or (id:sub(1, 1):upper() .. id:sub(2))
end

local function ChatAgent(c)
	if c and c.agent and c.agent ~= "" then return c.agent end
	return run.bridgeAgent or ""
end

local function ChatAgentName(c) return AgentName(ChatAgent(c)) end

-- The name to show on a reply: the agent the bridge says wrote it, else the chat's.
local function ReplyAgentName(c, agent)
	if agent and agent ~= "" then return AgentName(agent) end
	return ChatAgentName(c)
end
ns.AGENT_NAMES, ns.AgentName, ns.ChatAgent, ns.ChatAgentName, ns.ReplyAgentName = AGENT_NAMES, AgentName, ChatAgent, ChatAgentName, ReplyAgentName

function Cli.ChatPlugin(c)
	if not c then return "" end
	if c.liveTarget and c.liveTarget ~= "" then return LIVE_PLUGIN end
	if c.plugin and c.plugin ~= "" then return c.plugin end
	if c.cwd and c.cwd ~= "" then return "claude-code" end
	return ""
end

function ClaudeWoW.FolderOf(rule)
	if type(rule) ~= "string" then return nil end
	return rule:match("^AddDir%((.+)%)$")
end

function ClaudeWoW.GrantLabel(rule)
	local dir = ClaudeWoW.FolderOf(rule)
	return dir and ("folder " .. dir) or tostring(rule)
end

function ClaudeWoW.GrantsLabel(rules)
	local labels = {}
	for i, rule in ipairs(rules or {}) do
		labels[i] = ClaudeWoW.GrantLabel(rule)
	end
	return table.concat(labels, ", ")
end

function ClaudeWoW.SplitGrants(rules)
	local commands, dirs = {}, {}
	for _, rule in ipairs(rules or {}) do
		local dir = ClaudeWoW.FolderOf(rule)
		if dir then
			table.insert(dirs, dir)
		else
			table.insert(commands, rule)
		end
	end
	return commands, dirs
end

function Cli.ChatDirs(c, extra)
	local dirs = {}
	for _, list in ipairs({ type(c.addDirs) == "table" and c.addDirs or {}, type(extra) == "table" and extra or {} }) do
		for _, dir in ipairs(list) do
			if not Contains(dirs, dir) then table.insert(dirs, dir) end
		end
	end
	return dirs
end

function Cli.AddChatDirs(c, dirs)
	local left = {}
	for _, dir in ipairs(dirs or {}) do
		c.addDirs = c.addDirs or {}
		if not Contains(c.addDirs, dir) then
			if #c.addDirs < Cli.ADD_DIRS_MAX then
				table.insert(c.addDirs, dir)
			else
				table.insert(left, dir)
			end
		end
	end
	if c.addDirs and #c.addDirs == 0 then c.addDirs = nil end
	return left
end

function Cli.ChatOptionTokens(c, extraDirs)
	local tokens = {}
	if c.model and c.model ~= "" then table.insert(tokens, "model=" .. c.model) end
	if c.effort and c.effort ~= "" then table.insert(tokens, "effort=" .. c.effort) end
	if c.permissionMode and c.permissionMode ~= "" then table.insert(tokens, "pm=" .. c.permissionMode) end
	local dirs = Cli.ChatDirs(c, extraDirs)
	if #dirs > 0 then table.insert(tokens, "dirs=" .. ToHex(table.concat(dirs, "\31"))) end
	if c.resumeId and c.resumeId ~= "" then table.insert(tokens, "resume=" .. c.resumeId) end
	if c.liveTarget and c.liveTarget ~= "" then table.insert(tokens, "live=" .. ToHex(c.liveTarget)) end
	if c.discordLinkPending then table.insert(tokens, "discord=link") end
	local mcp = Cli.McpToken(c)
	if mcp ~= "" then table.insert(tokens, mcp) end
	return tokens
end

function Cli.LinkDiscord(c)
	if not run.bridgeDiscord then
		Cli.Out(c, "Discord is not on in this companion app. Set discord.enabled in its config.json and restart it.")
		return
	end
	local plugin = Cli.ChatPlugin(c)
	if plugin == "" then plugin = run.bridgePlugin or "" end
	if plugin ~= "claude-code" then
		Cli.Out(c, "Only a coding chat can live in Discord. Pick a project for this chat first (/claude --project <name>).")
		return
	end
	if c.pendingId then
		Cli.Out(c, "Wait for the reply first, then link the chat.")
		return
	end
	c.discordLinkPending = true
	ClaudeWoW.Send("/claude discord", nil, { chat = c.id, verbatim = true })
	c.discordLinkPending = nil
end

function ClaudeWoW.ApplyLive(live)
	if type(live) ~= "table" then return end
	run.bridgeLive = {
		sessions = type(live.sessions) == "table" and live.sessions or {},
		start = type(live.start) == "string" and live.start or "",
	}
end

function ClaudeWoW.LiveStatus()
	local live = run.bridgeLive
	if not live then return { "Running Claude Code sessions: unknown until the companion app is heard from." } end
	if #live.sessions == 0 then
		local lines = { "No Claude Code session is running with the claude-wow channel. Start one in a terminal with:" }
		if live.start ~= "" then table.insert(lines, live.start) end
		table.insert(lines, "Then attach a chat to it: /claude -r <name>")
		return lines
	end
	local lines = { "Running Claude Code sessions (" .. #live.sessions .. "):" }
	for i, name in ipairs(live.sessions) do
		table.insert(lines, i .. ". " .. tostring(name))
	end
	table.insert(lines, "Attach a chat to one: /claude -r <name>")
	return lines
end

function ClaudeWoW.ApplySessions(list, now)
	if type(list) ~= "table" then return end
	local clean = {}
	for _, e in ipairs(list) do
		if type(e) == "table" and (type(e.id) == "string" or type(e.name) == "string") then
			table.insert(clean, {
				id = type(e.id) == "string" and e.id or "",
				name = type(e.name) == "string" and e.name or "",
				cwd = type(e.cwd) == "string" and e.cwd or "",
				agent = type(e.agent) == "string" and e.agent or "",
				plugin = type(e.plugin) == "string" and e.plugin or "",
				chat = type(e.chat) == "string" and e.chat or "",
				at = tonumber(e.at) or 0,
				live = e.live == true,
				running = e.running == true or e.live == true,
				title = type(e.title) == "string" and e.title or "",
				branch = type(e.branch) == "string" and e.branch or "",
				restart = type(e.restart) == "string" and e.restart or "",
				handoff = e.handoff == true or nil,
				recap = type(e.recap) == "string" and e.recap ~= "" and e.recap or nil,
			})
		end
	end
	run.bridgeSessions = clean
	if type(now) == "number" then run.bridgeNow = now end
end

Cli.PROJECTS_MAX = 20
Cli.NO_PROJECT = "No project"

Cli.SKILL_BUILTINS = { "runs", "stop" }
Cli.skillCommands = {}

function Cli.IsCodingChat(c)
	if not c then return false end
	local plugin = Cli.ChatPlugin(c)
	if plugin == "" then plugin = run.bridgePlugin or "" end
	return plugin == "claude-code"
end

function Cli.SlashNames()
	local names = {}
	if #(run.bridgeSkills or {}) == 0 then return names end
	for _, s in ipairs(Cli.SKILL_BUILTINS) do
		table.insert(names, s)
	end
	for _, s in ipairs(run.bridgeSkills) do
		if not Contains(names, s) then table.insert(names, s) end
	end
	return names
end

function Cli.SlashTaken(cmd)
	for _, list in ipairs({ SlashCmdList or {}, SecureCmdList or {} }) do
		for key in pairs(list) do
			for i = 1, 20 do
				local v = _G["SLASH_" .. key .. i]
				if v == nil then break end
				if type(v) == "string" and v:lower() == cmd then return true end
			end
		end
	end
	return false
end

function Cli.RunSkillCommand(name, msg, editBox)
	if not ns.db then return end
	if not Contains(Cli.SlashNames(), name) then
		TellPlayer("/" .. name .. " is not a factory skill in this companion app right now.")
		return
	end
	local chat = editBox and Whisper.ChatForBox(editBox) or nil
	if not Cli.IsCodingChat(chat) then chat = ActiveChat() end
	if not Cli.IsCodingChat(chat) then
		TellPlayer("/" .. name .. " runs in a coding chat. Pick a project for this chat first (/claude --project <name>).")
		return
	end
	if ns.db.activeChat ~= chat.id then ClaudeWoW.SwitchChat(chat.id) end
	local args = Trim(tostring(msg or ""))
	ClaudeWoW.Send("/" .. name .. (args ~= "" and (" " .. args) or ""))
end

function Cli.RegisterSkillCommand(name)
	if Cli.skillCommands[name] ~= nil or type(SlashCmdList) ~= "table" then return end
	local cmd = "/" .. name
	if Cli.SlashTaken(cmd) then
		Cli.skillCommands[name] = false
		return
	end
	local key = "CLAUDEWOW_SKILL_" .. name:upper():gsub("[^%w]", "_")
	_G["SLASH_" .. key .. "1"] = cmd
	SlashCmdList[key] = function(msg, editBox) Cli.RunSkillCommand(name, msg, editBox) end
	Cli.skillCommands[name] = true
end

function ClaudeWoW.ApplySkills(list)
	local skills = {}
	for _, s in ipairs(type(list) == "table" and list or {}) do
		if type(s) == "string" and #s <= 64 and s:match("^[%l%d][%l%d:_%-]*$") then table.insert(skills, s) end
	end
	run.bridgeSkills = skills
	for _, s in ipairs(Cli.SlashNames()) do
		Cli.RegisterSkillCommand(s)
	end
end

function Cli.CompleteSlash(box)
	local typed = tostring(box:GetText() or ""):match("^/([%w:_%-]*)$")
	local c = ActiveChat()
	if not typed or not Cli.IsCodingChat(c) then return end
	local names = Cli.SlashNames()
	if #names == 0 then return end
	typed = typed:lower()
	local hits = {}
	for _, n in ipairs(names) do
		if n:sub(1, #typed) == typed then table.insert(hits, n) end
	end
	if #hits == 0 then
		Cli.Out(c, "No command starts with /" .. typed .. ". Commands: /" .. table.concat(names, ", /"))
		return
	end
	local prefix = hits[1]
	for _, n in ipairs(hits) do
		while n:sub(1, #prefix) ~= prefix do
			prefix = prefix:sub(1, -2)
		end
	end
	if #hits == 1 then prefix = prefix .. " " end
	if #prefix > #typed then
		box:SetText("/" .. prefix)
		box:SetCursorPosition(#prefix + 1)
	else
		Cli.Out(c, "Commands: /" .. table.concat(hits, ", /"))
	end
end

function Cli.ProjectOf(c)
	if not c then return "" end
	if c.cwd and c.cwd ~= "" then return c.cwd end
	if Cli.ChatPlugin(c) == "claude-code" then return run.bridgeCwd or "" end
	return ""
end

function Cli.KnownProjects()
	local out, seen = {}, {}
	local function Add(p)
		if type(p) ~= "string" or p == "" or #out >= Cli.PROJECTS_MAX then return end
		local key = Cli.NormalizeFolder(p)
		if seen[key] then return end
		seen[key] = true
		table.insert(out, key)
	end
	for _, p in ipairs(ns.db.settings.projects or {}) do
		Add(p)
	end
	for _, c in ipairs(ns.db.chats) do
		Add(Cli.ProjectOf(c))
	end
	Add(run.bridgeCwd)
	for _, p in ipairs(run.bridgeProjects or {}) do
		Add(p)
	end
	return out
end

function ClaudeWoW.ApplyProjects(projects, home)
	if type(home) == "string" and home ~= "" then run.bridgeHome = home end
	if type(projects) ~= "table" then return end
	local list, labels = {}, {}
	for _, p in ipairs(projects) do
		if type(p) == "table" and type(p.path) == "string" and p.path ~= "" then
			table.insert(list, p.path)
			if type(p.label) == "string" and p.label ~= "" then labels[Cli.NormalizeFolder(p.path)] = p.label end
		end
	end
	run.bridgeProjects, run.bridgeProjectLabels = list, labels
end

function Cli.RememberProject(path)
	local list = { path }
	for _, p in ipairs(ns.db.settings.projects or {}) do
		if p ~= path and #list < Cli.PROJECTS_MAX then table.insert(list, p) end
	end
	ns.db.settings.projects = list
end

function Cli.FindProject(name)
	name = Trim(tostring(name or ""))
	if name == "" then return nil end
	local lower = name:lower()
	for _, p in ipairs(Cli.KnownProjects()) do
		if p == name or FolderName(p):lower() == lower then return p end
	end
	return nil
end

function Cli.ProjectNames()
	local names = {}
	for _, p in ipairs(Cli.KnownProjects()) do
		table.insert(names, FolderName(p))
	end
	return #names > 0 and table.concat(names, ", ") or "none yet"
end

function Cli.IsNoProject(value)
	value = Trim(tostring(value or "")):lower()
	return value == "" or value == "none" or value == "-" or value == "default"
end

function Cli.ResolveProject(value)
	value = Trim(tostring(value or ""))
	if Cli.IsNoProject(value) then return "" end
	return Cli.FindProject(value) or (value:find("[\\/~]") and value) or nil
end

function Cli.SetProject(c, value)
	local path = Cli.ResolveProject(value)
	if not path then return nil, 'Unknown project "' .. tostring(value) .. '". Known: ' .. Cli.ProjectNames() .. ". Or give a path." end
	c.cwd = path
	Cli.KeepPlayerRoute(c)
	if c.plugin ~= "" and c.plugin ~= LIVE_PLUGIN then c.plugin = "" end
	if path ~= "" then Cli.RememberProject(path) end
	return path == "" and Cli.NO_PROJECT or FolderName(path)
end

function Cli.ProjectTag(c, text)
	for tag in text:gmatch("#([%w%._%-]+)") do
		local path = Cli.FindProject(tag)
		if path then
			if Cli.ProjectOf(c) ~= path then
				Cli.SetProject(c, path)
				Cli.Note(c, "project: " .. FolderName(path))
			end
			local escaped = ("#" .. tag):gsub("%p", "%%%0")
			return (text:gsub(escaped, tag, 1))
		end
	end
	return text
end

function Cli.ProjectLabel(c)
	local path = Cli.ProjectOf(c)
	return path == "" and Cli.NO_PROJECT or FolderName(path)
end

function Cli.PickProject(c, value)
	local note, err = Cli.SetProject(c, value)
	if err then
		Cli.Out(c, err)
	else
		Cli.Note(c, "project: " .. note)
	end
	ClaudeWoW.Render()
end

function Cli.ParentName(path)
	local parent = tostring(path or ""):gsub("[\\/]+$", ""):match("^(.*)[\\/][^\\/]+$")
	return parent and FolderName(parent) or ""
end

function Cli.ProjectMenuLabels(paths)
	local function Counts(labels)
		local n = {}
		for _, l in ipairs(labels) do
			n[l] = (n[l] or 0) + 1
		end
		return n
	end
	local labels = {}
	for i, p in ipairs(paths) do
		labels[i] = FolderName(p)
	end
	local plain = Counts(labels)
	for i, p in ipairs(paths) do
		local parent = Cli.ParentName(p)
		if plain[labels[i]] > 1 and parent ~= "" then labels[i] = labels[i] .. " (" .. parent .. ")" end
	end
	local qualified = Counts(labels)
	for i, p in ipairs(paths) do
		if qualified[labels[i]] > 1 then labels[i] = p end
	end
	return labels
end

function Cli.ProjectMenuItems(c)
	local function Current() return Cli.NormalizeFolder(Cli.ProjectOf(c)) end
	local items = {
		{ title = "Project" },
		{ text = Cli.NO_PROJECT, radio = true, selected = function() return Current() == "" end, fn = function() Cli.PickProject(c, "none") end },
	}
	local paths = Cli.KnownProjects()
	local labels = Cli.ProjectMenuLabels(paths)
	for i, p in ipairs(paths) do
		table.insert(
			items,
			{ text = Display(labels[i]), radio = true, selected = function() return Current() == p end, fn = function() Cli.PickProject(c, p) end }
		)
	end
	return items
end

function Cli.ProjectMenu(anchor)
	local c = ActiveChat()
	if not c then return end
	Q.ShowMenu(anchor, Cli.ProjectMenuItems(c), "project", true)
end

Cli.EFFORT_CHOICES = { "low", "medium", "high", "xhigh", "max" }
Cli.EFFORT_AUTO = "auto"
Cli.EFFORT_LEVEL_OF = { minimal = 0, low = 1, medium = 2, high = 3, xhigh = 4, max = 5, ultra = 5 }
Cli.EFFORT_BAR_W = 3
Cli.EFFORT_BAR_GAP = 2
Cli.EFFORT_BAR_MIN_H = 4
Cli.EFFORT_BAR_MAX_H = 14
Cli.EFFORT_WORD_GAP = 4
Cli.EFFORT_PAD = 2
Cli.EFFORT_GOLD = { 1, 0.82, 0, 1 }
Cli.EFFORT_DIM = { 0.4, 0.4, 0.4, 0.55 }
Cli.EFFORT_OFF = { 0.25, 0.25, 0.25, 0.45 }

function Cli.EffortPlugin(c)
	local p = Cli.ChatPlugin(c)
	if p == "" then p = run.bridgePlugin or "" end
	return p
end

function Cli.EffortState(c)
	local agent = ChatAgent(c)
	local plugin = Cli.EffortPlugin(c)
	if c and plugin == LIVE_PLUGIN then return { supported = false, agent = agent, why = "live" } end
	local rows = type(run.bridgeEfforts) == "table" and run.bridgeEfforts or nil
	local row = rows and (rows[plugin] or rows[run.bridgePlugin or ""])
	if type(row) == "table" and agent ~= "" and row[agent] == nil then return { supported = false, agent = agent, why = "agent" } end
	local lock = type(run.bridgeEffortLock) == "table" and run.bridgeEffortLock[agent]
	if type(lock) == "string" and lock ~= "" then return { supported = true, agent = agent, value = lock, source = "lock" } end
	local own = c and c.effort
	if own and own ~= "" then return { supported = true, agent = agent, value = own, source = "chat" } end
	local bridge = type(row) == "table" and row[agent]
	if type(bridge) == "string" and bridge ~= "" then return { supported = true, agent = agent, value = bridge, source = "bridge" } end
	return { supported = true, agent = agent, value = Cli.EFFORT_AUTO, source = rows and "agent" or "unknown" }
end

function ClaudeWoW.ApplyEfforts(data)
	if type(data) ~= "table" or type(data.efforts) ~= "table" then return end
	run.bridgeEfforts = data.efforts
	run.bridgeEffortLock = type(data.effortLock) == "table" and data.effortLock or nil
	Cli.UpdateEffortButton()
end

function Cli.EffortLabel(c)
	local s = Cli.EffortState(c)
	return s.supported and s.value or "none"
end

function Cli.EffortLevel(value) return Cli.EFFORT_LEVEL_OF[value or ""] or 0 end

function Cli.PickEffort(c, value)
	c.effort = (value and value ~= "") and value or nil
	Cli.Out(c, "effort: " .. Cli.EffortLabel(c))
	Cli.UpdateEffortButton()
end

function Cli.EffortBars(b)
	if b.bars then return b.bars end
	b.bars = {}
	local n = #Cli.EFFORT_CHOICES
	for i = 1, n do
		local bar = b:CreateTexture(nil, "ARTWORK")
		local h = Cli.EFFORT_BAR_MIN_H + math.floor((Cli.EFFORT_BAR_MAX_H - Cli.EFFORT_BAR_MIN_H) * (i - 1) / (n - 1) + 0.5)
		bar:SetSize(Cli.EFFORT_BAR_W, h)
		bar:SetPoint("BOTTOMRIGHT", b, "BOTTOMRIGHT", -Cli.EFFORT_PAD - (n - i) * (Cli.EFFORT_BAR_W + Cli.EFFORT_BAR_GAP), 1)
		b.bars[i] = bar
	end
	return b.bars
end

function Cli.EffortBarsWidth()
	local n = #Cli.EFFORT_CHOICES
	return n * Cli.EFFORT_BAR_W + (n - 1) * Cli.EFFORT_BAR_GAP
end

function Cli.PaintEffortBars(b, filled, supported)
	for i, bar in ipairs(Cli.EffortBars(b)) do
		local color = not supported and Cli.EFFORT_OFF or (i <= filled and Cli.EFFORT_GOLD or Cli.EFFORT_DIM)
		bar:SetColorTexture(color[1], color[2], color[3], color[4])
		bar.filled = supported and i <= filled
	end
end

function Cli.LayoutEffortWord(b)
	local text = b.text
	local barsRight = Cli.EFFORT_PAD + Cli.EffortBarsWidth() + Cli.EFFORT_WORD_GAP
	text:ClearAllPoints()
	text:SetPoint("RIGHT", b, "RIGHT", -barsRight, 0)
	text:SetWidth(0)
	local room = (Try(b.GetWidth, b) or 0) - barsRight - Cli.EFFORT_PAD
	local need = Try(text.GetStringWidth, text) or 0
	b.wordShown = b.word ~= "" and need <= room
	text:SetShown(b.wordShown)
end

function Cli.UpdateEffortButton()
	local b = ui.effort
	if not b then return end
	local s = Cli.EffortState(ActiveChat())
	b.state = s
	b.fullName = s.supported and s.value or "none"
	b.word = s.supported and s.value or ""
	local color = (s.supported and s.source ~= "agent" and s.source ~= "unknown") and "|cffffffff" or "|cff9d9d9d"
	b.text:SetText(b.word ~= "" and (color .. b.word .. "|r") or "")
	Cli.PaintEffortBars(b, s.supported and Cli.EffortLevel(s.value) or 0, s.supported)
	Cli.LayoutEffortWord(b)
	b:SetEnabled(s.supported)
end

Cli.EFFORT_SOURCE_NOTE = {
	chat = "Set for this chat.",
	bridge = "The companion app's setting for this agent.",
	lock = "Fixed by a setting on your computer, so you cannot change it here.",
	agent = "The agent picks its own level.",
	unknown = "Update the companion app to see the real value.",
}

function Cli.EffortButtonTooltip(b)
	local s = b.state or Cli.EffortState(ActiveChat())
	GameTooltip:SetOwner(b, "ANCHOR_TOP")
	if not s.supported then
		GameTooltip:SetText("Effort")
		local what = s.why == "live" and "A running session keeps its own effort." or (AgentName(s.agent) .. " has no effort setting.")
		GameTooltip:AddLine(what, 0.8, 0.8, 0.8, true)
		GameTooltip:Show()
		return
	end
	GameTooltip:SetText("Effort: " .. s.value)
	GameTooltip:AddLine(Cli.EFFORT_SOURCE_NOTE[s.source] or "", 0.8, 0.8, 0.8, true)
	if s.source ~= "lock" then
		GameTooltip:AddLine("How hard the agent thinks in this chat. Click to change it, or use /claude --effort <level>.", 0.8, 0.8, 0.8, true)
	end
	GameTooltip:Show()
end

function Cli.EffortAutoLabel(c)
	local saved = c.effort
	c.effort = nil
	local s = Cli.EffortState(c)
	c.effort = saved
	return s.value == Cli.EFFORT_AUTO and "Auto" or ("Auto (" .. s.value .. ")")
end

function Cli.EffortMenuItems(c)
	local function Changeable() return Cli.EffortState(c).source ~= "lock" end
	local items = {
		{ title = "Effort" },
		{
			text = Cli.EffortAutoLabel(c),
			radio = true,
			enabled = Changeable,
			selected = function() return (c.effort or "") == "" end,
			fn = function() Cli.PickEffort(c, nil) end,
		},
	}
	for _, e in ipairs(Cli.EFFORT_CHOICES) do
		table.insert(
			items,
			{ text = e, radio = true, enabled = Changeable, selected = function() return c.effort == e end, fn = function() Cli.PickEffort(c, e) end }
		)
	end
	return items
end

function Cli.EffortMenu(anchor)
	local c = ActiveChat()
	if not c or not Cli.EffortState(c).supported then return end
	Q.ShowMenu(anchor, Cli.EffortMenuItems(c), "effort", true)
end

Cli.PROJECT_W_MIN = 60
Cli.PROJECT_W_MAX = 240
Cli.PROJECT_PAD = 8
Cli.HEADER_TITLE_MIN = 80

function Cli.HeaderLabelWidth(b, text)
	b.text:SetWidth(0)
	b.text:SetText(text)
	return (Try(b.text.GetStringWidth, b.text) or 100) + Cli.PROJECT_PAD
end

function Cli.HeaderRoom(host)
	local hostWidth = (host and Try(host.GetWidth, host)) or 0
	if ui.chatTitle then return hostWidth - 2 * Cli.PROJECT_PAD - Cli.HEADER_TITLE_MIN end
	return hostWidth - 2 * Cli.PROJECT_PAD
end

function Cli.HeaderSlots()
	local slots = {}
	for _, spec in ipairs({
		{ b = ui.projectButton, label = "Project: ", min = Cli.PROJECT_W_MIN, max = Cli.PROJECT_W_MAX },
		{ b = ui.mcpButton, fixed = true },
	}) do
		if spec.b and spec.b.wanted then table.insert(slots, spec) end
	end
	return slots
end

function Cli.MeasureHeaderSlot(slot)
	local b = slot.b
	if slot.fixed then
		slot.full = Cli.HeaderLabelWidth(b, b.fullText)
		slot.short, slot.min, slot.max = slot.full, slot.full, slot.full
		return
	end
	slot.full = Cli.HeaderLabelWidth(b, slot.label .. "|cffffffff" .. b.fullName .. "|r")
	slot.short = Cli.HeaderLabelWidth(b, "|cffffffff" .. b.fullName .. "|r")
end

function Cli.HeaderSlotFloor(slot) return slot.compact and math.min(slot.min, slot.short) or slot.min end

function Cli.HeaderSlotWidth(slot)
	local natural = slot.compact and slot.short or slot.full
	return math.min(slot.max, math.max(Cli.HeaderSlotFloor(slot), natural)), natural
end

function Cli.HeaderTotal(slots)
	local total = 0
	for i, slot in ipairs(slots) do
		if not slot.hidden then total = total + (slot.width or Cli.HeaderSlotWidth(slot)) + (i > 1 and Cli.PROJECT_PAD or 0) end
	end
	return total
end

function Cli.FitHeaderSlots(slots, room)
	for _, i in ipairs({ 2, 1 }) do
		if Cli.HeaderTotal(slots) <= room then return end
		if slots[i] and not slots[i].fixed then slots[i].compact = true end
	end
	for _, i in ipairs({ 1, 2 }) do
		local slot = slots[i]
		local over = Cli.HeaderTotal(slots) - room
		if over <= 0 then return end
		if slot and not slot.fixed then slot.width = math.max(Cli.HeaderSlotFloor(slot), Cli.HeaderSlotWidth(slot) - over) end
	end
	for i = #slots, 2, -1 do
		if Cli.HeaderTotal(slots) <= room then return end
		slots[i].hidden = true
	end
end

function Cli.LayoutHeaderButtons()
	local project = ui.projectButton
	if not project then return end
	local slots = Cli.HeaderSlots()
	for _, slot in ipairs(slots) do
		Cli.MeasureHeaderSlot(slot)
	end
	Cli.FitHeaderSlots(slots, Cli.HeaderRoom(project:GetParent()))
	local leftmost = project
	for _, b in ipairs({ ui.mcpButton }) do
		if b then b:Hide() end
	end
	for _, slot in ipairs(slots) do
		local b = slot.b
		if not slot.hidden then
			local width, natural = Cli.HeaderSlotWidth(slot)
			width = slot.width or width
			b.truncated = natural > width
			b.text:SetWidth(0)
			b.text:SetText(slot.fixed and b.fullText or ((slot.compact and "" or slot.label) .. "|cffffffff" .. b.fullName .. "|r"))
			b:SetWidth(width)
			b.text:SetWidth(width - Cli.PROJECT_PAD)
			if b ~= project then
				b:ClearAllPoints()
				b:SetPoint("RIGHT", leftmost, "LEFT", -Cli.PROJECT_PAD, 0)
				b:Show()
			end
			leftmost = b
		end
	end
	if ui.titleBar and ui.chatTitle then ui.chatTitle:SetPoint("RIGHT", leftmost, "LEFT", -Cli.PROJECT_PAD, 0) end
end

function Cli.UpdateProjectButton()
	local b = ui.projectButton
	if not b then return end
	b.fullName = Display(Cli.ProjectLabel(ActiveChat()))
	b.wanted = true
	Cli.LayoutHeaderButtons()
end

function Cli.ProjectButtonTooltip(b)
	GameTooltip:SetOwner(b, ui.chatTitle and "ANCHOR_BOTTOMRIGHT" or "ANCHOR_TOP")
	GameTooltip:SetText("Project: " .. (b.fullName or Cli.NO_PROJECT))
	GameTooltip:AddLine(
		"The repo this chat works in. No project = a general chat. You can also type #name in a message or use /claude --project <name>.",
		0.8,
		0.8,
		0.8,
		true
	)
	GameTooltip:Show()
end

Cli.MCP_MAX = 16
Cli.MCP_LIST_MAX = 64
Cli.MCP_AGENTS = { claude = true, codex = true }
Cli.CONTRACT_NAMES = { claude = "Claude Code", codex = "Codex" }
Cli.MCP_HEALTH = {
	connected = { "ok", "33cc33" },
	["needs-auth"] = { "needs login", "ff9933" },
	failed = { "failed", "ff4444" },
	pending = { "starting", "999999" },
	unknown = { "not seen yet", "999999" },
}
Cli.MCP_SOURCES = {
	{ "config", "From config.json" },
	{ "claude", "Your Claude servers" },
	{ "plugin", "Claude plugins" },
	{ "claude.ai", "claude.ai connectors" },
	{ "codex", "Your Codex servers" },
}

function ClaudeWoW.ApplyMcp(list)
	if type(list) ~= "table" then
		run.bridgeMcp = nil
		Cli.UpdateMcpButton()
		return
	end
	local known = {}
	for _, src in ipairs(Cli.MCP_SOURCES) do
		known[src[1]] = true
	end
	local out = {}
	for _, s in ipairs(list) do
		if #out >= Cli.MCP_LIST_MAX then break end
		if type(s) == "table" and type(s.id) == "string" and #s.id <= 64 and s.id:match("^[%w_%-]+$") and known[s.src] then
			local label = type(s.label) == "string" and s.label:gsub("[%c|]", ""):sub(1, 64) or ""
			local health = (type(s.health) == "string" and Cli.MCP_HEALTH[s.health]) and s.health or "unknown"
			table.insert(out, { id = s.id, label = label ~= "" and label or s.id, src = s.src, on = s.on == true, health = health })
		end
	end
	run.bridgeMcp = out
	for _, c in ipairs(ns.db and ns.db.chats or {}) do
		if type(c.mcp) == "table" then
			local set = {}
			for _, id in ipairs(c.mcp) do
				if type(id) == "string" then set[id] = true end
			end
			c.mcp, c.mcpSet, c.mcpAllOff = nil, next(set) and set or nil, true
		end
	end
	Cli.UpdateMcpButton()
end

function ClaudeWoW.ApplyContract(t)
	if type(t) ~= "table" then
		run.bridgeContract = nil
		Cli.UpdateMcpButton()
		return
	end
	local known = {}
	for _, src in ipairs(Cli.MCP_SOURCES) do
		known[src[1]] = true
	end
	local out = {}
	for id in pairs(Cli.CONTRACT_NAMES) do
		local e = t[id]
		if type(e) == "table" then
			local version = type(e.version) == "string" and (e.version:gsub("[%c|]", "")):sub(1, 40) or ""
			local reason = type(e.reason) == "string" and (e.reason:gsub("[%c|]", "")):sub(1, 400) or ""
			local sources
			if type(e.sources) == "table" then
				sources = {}
				for _, src in ipairs(e.sources) do
					if known[src] then sources[src] = true end
				end
			end
			out[id] = { version = version, checked = e.checked == true, off = e.off ~= false, reason = reason, sources = sources }
		end
	end
	run.bridgeContract = out
	Cli.UpdateMcpButton()
end

function Cli.McpContract(c) return run.bridgeContract and run.bridgeContract[ChatAgent(c)] or nil end

function Cli.McpOffBlocked(c, s)
	local e = Cli.McpContract(c)
	if not (e and e.off == false) then return nil end
	if s and e.sources and not e.sources[s.src] then return nil end
	if e.reason ~= "" then return e.reason end
	return ChatAgentName(c) .. " failed the MCP off check in claude-wow agents check, so this companion app cannot turn a server off."
end

function Cli.McpAllOffBlocked(c)
	for _, s in ipairs(run.bridgeMcp or {}) do
		local blocked = Cli.McpOffBlocked(c, s)
		if blocked then return blocked end
	end
end

function Cli.McpContractNote(c)
	local e = Cli.McpContract(c)
	if not e or e.checked then return nil end
	return "Not checked on " .. Cli.CONTRACT_NAMES[ChatAgent(c)] .. (e.version ~= "" and (" " .. e.version) or "") .. ": run claude-wow agents check"
end

function Cli.McpUnsupported(c)
	local agent = ChatAgent(c)
	return agent ~= "" and not Cli.MCP_AGENTS[agent]
end

function Cli.McpOn(c, s)
	if c and type(c.mcpSet) == "table" and c.mcpSet[s.id] ~= nil then return c.mcpSet[s.id] end
	if c and c.mcpAllOff then return false end
	return s.on
end

function Cli.McpChoiceParts(c)
	local parts = {}
	if not c then return parts end
	if c.mcpAllOff then table.insert(parts, "-*") end
	local ids = {}
	for _, s in ipairs(run.bridgeMcp or {}) do
		if type(c.mcpSet) == "table" and c.mcpSet[s.id] ~= nil then table.insert(ids, s.id) end
	end
	table.sort(ids)
	for _, id in ipairs(ids) do
		table.insert(parts, (c.mcpSet[id] and "+" or "-") .. id)
	end
	return parts
end

function Cli.McpToken(c)
	if not (c and run.bridgeMcp) then return "" end
	local parts = Cli.McpChoiceParts(c)
	if #parts == 0 then return "" end
	return "mcp=" .. table.concat(parts, ",")
end

function Cli.McpCounts(c)
	local on = 0
	for _, s in ipairs(run.bridgeMcp or {}) do
		if Cli.McpOn(c, s) then on = on + 1 end
	end
	return on, #(run.bridgeMcp or {})
end

function Cli.McpHealthText(s)
	local h = Cli.MCP_HEALTH[s.health] or Cli.MCP_HEALTH.unknown
	return "|cff" .. h[2] .. h[1] .. "|r"
end

function Cli.McpMissing()
	if not run.bridgeMcp then
		if not ClaudeWoW.IsConnected() then return "not connected to the companion app yet." end
		return "this companion app sends no MCP server list. Update the companion app (claude-wow update) and reconnect."
	end
	if #run.bridgeMcp == 0 then return "the companion app sees no MCP servers: none in your Claude or Codex setup, or in mcp.servers in its config.json." end
end

function Cli.McpFind(name)
	name = tostring(name or "")
	for _, s in ipairs(run.bridgeMcp or {}) do
		if s.id == name then return s end
	end
	local want = name:lower()
	for _, field in ipairs({ "id", "label" }) do
		local hits, ids = {}, {}
		for _, s in ipairs(run.bridgeMcp or {}) do
			if s[field]:lower() == want then
				table.insert(hits, s)
				table.insert(ids, s.id)
			end
		end
		if #hits > 1 then return nil, "more than one server is called " .. name .. "; name one of " .. table.concat(ids, ", ") .. "." end
		if hits[1] then return hits[1] end
	end
end

function Cli.SetMcp(c, name, on)
	local missing = Cli.McpMissing()
	if missing then return nil, missing end
	local s, ambiguous = Cli.McpFind(name)
	if ambiguous then return nil, ambiguous end
	if not s then return nil, 'no MCP server named "' .. tostring(name) .. '" (servers: ' .. Cli.McpNames() .. ")." end
	local blocked = not on and Cli.McpOffBlocked(c, s)
	if blocked then return nil, blocked end
	local set = {}
	for id, v in pairs(c.mcpSet or {}) do
		set[id] = v
	end
	local plain = s.on
	if c.mcpAllOff then plain = false end
	if on == plain and on then
		set[s.id] = nil
	else
		set[s.id] = on
	end
	local count = 0
	for _ in pairs(set) do
		count = count + 1
	end
	local before = c.mcpSet
	c.mcpSet = set
	if count > Cli.MCP_MAX then
		c.mcpSet = before
		return nil, "this chat already changes " .. Cli.MCP_MAX .. " servers. Use /claude mcp none, then turn on the ones you want, or /claude mcp default."
	end
	if next(set) == nil then c.mcpSet = nil end
	return s.label .. " is " .. (on and "on" or "off") .. " for this chat."
end

function Cli.McpNames()
	local names = {}
	for _, s in ipairs(run.bridgeMcp or {}) do
		table.insert(names, s.label)
	end
	return #names > 0 and table.concat(names, ", ") or "none"
end

function Cli.McpGroups()
	local groups = {}
	for _, src in ipairs(Cli.MCP_SOURCES) do
		local rows = {}
		for _, s in ipairs(run.bridgeMcp or {}) do
			if s.src == src[1] then table.insert(rows, s) end
		end
		if #rows > 0 then table.insert(groups, { title = src[2], rows = rows }) end
	end
	return groups
end

function Cli.McpReport(c)
	local missing = Cli.McpMissing()
	if missing then return "MCP: " .. missing end
	local custom = c.mcpAllOff or type(c.mcpSet) == "table"
	local lines = { "MCP servers for this chat" .. (custom and "" or " (the defaults)") .. ":" }
	for _, g in ipairs(Cli.McpGroups()) do
		table.insert(lines, g.title .. ":")
		for _, s in ipairs(g.rows) do
			table.insert(lines, "  " .. (Cli.McpOn(c, s) and "on   " or "off  ") .. s.label .. "  " .. Cli.McpHealthText(s))
		end
	end
	if Cli.McpUnsupported(c) then table.insert(lines, ChatAgentName(c) .. " does not use MCP servers; this list applies to Claude and Codex chats.") end
	local contractLine = Cli.McpAllOffBlocked(c) or Cli.McpContractNote(c)
	if contractLine then table.insert(lines, contractLine) end
	table.insert(lines, "/claude mcp on|off <name> changes one; /claude mcp none turns all off; /claude mcp default goes back to the defaults.")
	return table.concat(lines, "\n")
end

function Cli.McpCommand(c, rest)
	if not c then return end
	rest = Trim(rest or "")
	local word = rest:lower()
	if word == "" then
		Cli.Say(c, Cli.McpReport(c))
	elseif word == "default" then
		c.mcpSet, c.mcpAllOff = nil, nil
		Cli.Out(c, "MCP: this chat uses the default servers again.")
	elseif word == "none" then
		local missing = Cli.McpMissing() or Cli.McpAllOffBlocked(c)
		if not missing then
			c.mcpSet, c.mcpAllOff = nil, true
		end
		Cli.Out(c, "MCP: " .. (missing or "every server is off for this chat."))
	else
		local verb, name = rest:match("^(%S+)%s+(.+)$")
		local note, err = Cli.SetMcp(c, name, verb:lower() == "on")
		Cli.Out(c, "MCP: " .. (err or note))
	end
end

function Cli.IsMcpCommand(rest)
	rest = Trim(rest or ""):lower()
	if rest == "" or rest == "default" or rest == "none" then return true end
	local verb, name = rest:match("^(%S+)%s+(.+)$")
	return (verb == "on" or verb == "off") and name ~= nil
end

function Cli.McpMenu(anchor)
	local c = ActiveChat()
	if not c then return end
	if not Cli.McpMissing() and type(MenuUtil) == "table" and type(MenuUtil.CreateContextMenu) == "function" then
		local shown = pcall(MenuUtil.CreateContextMenu, anchor, function(_, root)
			local blocked = Cli.McpAllOffBlocked(c)
			local note = Cli.McpContractNote(c)
			if blocked then root:CreateTitle("|cffff9933Turning a server off is disabled: " .. ChatAgentName(c) .. " failed the MCP check|r") end
			if note then root:CreateTitle("|cff999999" .. note .. "|r") end
			local function grey(item, off)
				if off and type(item) == "table" and type(item.SetEnabled) == "function" then item:SetEnabled(false) end
			end
			for _, g in ipairs(Cli.McpGroups()) do
				root:CreateTitle(g.title)
				for _, s in ipairs(g.rows) do
					local item = root:CreateCheckbox(s.label .. "  " .. Cli.McpHealthText(s), function() return Cli.McpOn(c, s) end, function()
						local _, err = Cli.SetMcp(c, s.id, not Cli.McpOn(c, s))
						if err then Cli.Out(c, "MCP: " .. err) end
						ClaudeWoW.Render()
					end)
					if Cli.McpOn(c, s) then grey(item, Cli.McpOffBlocked(c, s)) end
				end
			end
			root:CreateDivider()
			grey(root:CreateButton("Turn all off", function() Cli.McpCommand(c, "none") end), blocked)
			root:CreateButton("Use the defaults", function() Cli.McpCommand(c, "default") end)
		end)
		if shown then return end
	end
	Cli.Say(c, Cli.McpReport(c))
end

function Cli.UpdateMcpButton()
	local b = ui.mcpButton
	if not b then return end
	local c = ActiveChat()
	local on, total = Cli.McpCounts(c)
	b.wanted = c ~= nil and total > 0
	if not b.wanted then
		Cli.LayoutHeaderButtons()
		return
	end
	local warn = false
	for _, s in ipairs(run.bridgeMcp) do
		if Cli.McpOn(c, s) and (s.health == "failed" or s.health == "needs-auth") then warn = true end
	end
	local color = Cli.McpUnsupported(c) and "999999" or (warn and "ff9933" or "ffffff")
	b.fullText = "MCP |cff" .. color .. on .. "/" .. total .. "|r"
	Cli.LayoutHeaderButtons()
end

function Cli.McpButtonTooltip(b)
	local c = ActiveChat()
	GameTooltip:SetOwner(b, ui.chatTitle and "ANCHOR_BOTTOMRIGHT" or "ANCHOR_TOP")
	GameTooltip:SetText("MCP servers")
	local on, total = Cli.McpCounts(c)
	GameTooltip:AddLine(
		on .. " of " .. total .. " on for this chat. Your own Claude and Codex servers are on unless you turn them off here.",
		0.8,
		0.8,
		0.8,
		true
	)
	local warn = {}
	for _, s in ipairs(run.bridgeMcp or {}) do
		if Cli.McpOn(c, s) and (s.health == "failed" or s.health == "needs-auth") then table.insert(warn, s.label .. ": " .. Cli.McpHealthText(s)) end
	end
	for _, line in ipairs(warn) do
		GameTooltip:AddLine(line, 1, 1, 1)
	end
	if c and Cli.McpUnsupported(c) then GameTooltip:AddLine(ChatAgentName(c) .. " does not use MCP servers.", 1, 0.6, 0.2, true) end
	local contractLine = c and (Cli.McpAllOffBlocked(c) or Cli.McpContractNote(c))
	if contractLine then GameTooltip:AddLine(contractLine, 1, 0.6, 0.2, true) end
	GameTooltip:AddLine("Click to turn servers on or off for this chat.", 0.8, 0.8, 0.8, true)
	GameTooltip:Show()
end

-- Folder this chat's agent works in. Empty (or "-" / "default") = the bridge's
-- default. Relative paths are resolved by the bridge against that default.
function ClaudeWoW.SetFolder(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or "")
	if rest ~= "" or (c.cwd or "") ~= "" then Cli.KeepPlayerRoute(c) end
	if rest == "-" or rest == "default" then rest = "" end
	local base = run.bridgeCwd or Q.PROJECT_BASE_UNKNOWN
	if rest ~= "" then
		local changed = rest ~= c.cwd
		c.cwd = rest
		local absolute = rest:match("^%a:[\\/]") or rest:match("^[\\/~]")
		local note = absolute and "" or (" (relative to " .. base .. ")")
		Cli.Out(
			c,
			"Project set to "
				.. rest
				.. note
				.. (changed and #c.history > 1 and ("; the next message starts a fresh " .. ChatAgentName(c) .. " session there") or "")
		)
	elseif c.cwd ~= "" then
		c.cwd = ""
		Cli.Out(c, "Project reset to the companion app's default: " .. base)
	else
		Cli.Out(c, "Project is the companion app's default: " .. base .. " (/claude cd <path>, or right-click the chat and pick Project..., to change)")
	end
	ClaudeWoW.Render()
end

-- The agent this chat talks to, by id. Empty (or
-- "-" / "default") = the bridge's default. The bridge starts a fresh session
-- when a chat changes agent, since a session belongs to the agent that made it.
local function AgentList() return run.bridgeAgents and table.concat(run.bridgeAgents, ", ") or "claude, codex, grok, agy, hermes" end
ns.AgentList = AgentList

function ClaudeWoW.SetAgent(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or ""):lower()
	if rest == "" then
		Cli.Out(
			c,
			(
				c.agent ~= "" and ("agent is " .. AgentName(c.agent))
				or ("agent is the companion app's default: " .. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected"))
			)
				.. " (/claude -c --agent <name>, or right-click the chat and pick Agent, to change; agents: "
				.. AgentList()
				.. ")"
		)
		ClaudeWoW.Render()
		return
	end
	if rest == "-" or rest == "default" then rest = "" end
	if rest ~= "" and run.bridgeAgents and not Contains(run.bridgeAgents, rest) then
		Cli.Out(c, 'Unknown agent "' .. rest .. '". The companion app knows: ' .. AgentList())
		ClaudeWoW.Render()
		return
	end
	local changed = rest ~= (c.agent or "")
	c.agent = rest
	if rest ~= "" then
		Cli.Out(c, "agent set to " .. AgentName(rest) .. (changed and #c.history > 1 and "; the next message starts a fresh session with it" or ""))
	elseif changed then
		Cli.Out(c, "agent reset to the companion app's default: " .. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected"))
	else
		Cli.Out(
			c,
			"agent is the companion app's default: "
				.. (run.bridgeAgent and AgentName(run.bridgeAgent) or "unknown until connected")
				.. " (/claude -c --agent <name>, or right-click the chat and pick Agent, to change; agents: "
				.. AgentList()
				.. ")"
		)
	end
	ClaudeWoW.Render()
end

-- The plugin this chat is bound to, by id ("ask": general in-game chat,
-- "claude-code": an agent session in a folder; docs/PLATFORM.md). Empty (or
-- "-" / "default") = the bridge's default. The bridge starts a fresh session
-- when a chat changes plugin, since a session belongs to the plugin that made it.
local function PluginList() return run.bridgePlugins and table.concat(run.bridgePlugins, ", ") or "ask, claude-code" end

local function BridgePluginName() return run.bridgePlugin or "unknown until connected" end
ns.PluginList, ns.BridgePluginName = PluginList, BridgePluginName

function ClaudeWoW.SetPlugin(rest, c)
	c = c or ActiveChat()
	if not c then return end
	rest = Trim(rest or ""):lower()
	if rest == "" then
		Cli.Out(
			c,
			((c.plugin or "") ~= "" and ("plugin is " .. c.plugin) or ("plugin is the companion app's default: " .. BridgePluginName()))
				.. " (/claude config plugin <name>, or right-click the chat and pick Plugin, to change; plugins: "
				.. PluginList()
				.. "). This is an advanced setting: a chat with a project (/claude cd) is a coding session and one without is general chat, and /claude -r attaches running sessions."
		)
		ClaudeWoW.Render()
		return
	end
	if rest == "-" or rest == "default" then rest = "" end
	if rest ~= "" and run.bridgePlugins and not Contains(run.bridgePlugins, rest) then
		Cli.Out(c, 'Unknown plugin "' .. rest .. '". The companion app has: ' .. PluginList())
		ClaudeWoW.Render()
		return
	end
	local changed = rest ~= (c.plugin or "")
	c.plugin = rest
	Cli.KeepPlayerRoute(c)
	if rest ~= "" then
		Cli.Out(c, "plugin set to " .. rest .. (changed and #c.history > 1 and "; the next message starts a fresh session with it" or ""))
	elseif changed then
		Cli.Out(c, "plugin reset to the companion app's default: " .. BridgePluginName())
	else
		Cli.Out(
			c,
			"plugin is the companion app's default: "
				.. BridgePluginName()
				.. " (/claude config plugin <name>, or right-click the chat and pick Plugin, to change; plugins: "
				.. PluginList()
				.. ")"
		)
	end
	ClaudeWoW.Render()
end
