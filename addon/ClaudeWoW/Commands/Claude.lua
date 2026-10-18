local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Commands\\Claude.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Cli, Whisper = ns.run, ns.ui, ns.Cli, ns.Whisper
local Trim, Display, Contains = ns.Trim, ns.Display, ns.Contains
local FindChat, ActiveChat, AddHistory = ns.FindChat, ns.ActiveChat, ns.AddHistory
local AgentList, RunCommand, IsCommand = ns.AgentList, ns.RunCommand, Cli.IsCommand

ClaudeWoW.HELP_MISSING = "The Commands and tips page is in a new addon file. Restart the game client once to load it: a /reload does not load new files."

function ClaudeWoW.ShowHelp()
	if ClaudeWoWHelp and ClaudeWoWHelp.Open then return ClaudeWoWHelp.Open() end
	print(ClaudeWoW.PREFIX .. ClaudeWoW.HELP_MISSING)
	return nil
end

function ClaudeWoW.ShowOptions()
	if ClaudeWoWHelp and ClaudeWoWHelp.OpenOptions then return ClaudeWoWHelp.OpenOptions() end
	print(ClaudeWoW.PREFIX .. ClaudeWoW.HELP_MISSING)
	return nil
end

Cli.emitted = setmetatable({}, { __mode = "k" })
Cli.invocation = nil

function Cli.Quiet() return type(Cli.invocation) == "table" and Cli.invocation.quiet == true end

function Cli.WindowShown() return ui.frame ~= nil and ui.frame:IsShown() end

function Cli.Emit(c, text)
	if not c or not Whisper.Active() then return end
	local cmd = run.cmd
	if cmd and cmd.tab then
		Whisper.System(c, text, true)
		return
	end
	if Cli.WindowShown() then return end
	if cmd and cmd.general then
		for line in (tostring(text) .. "\n"):gmatch("(.-)\n") do
			if line:match("%S") then print(ClaudeWoW.PREFIX .. line) end
		end
		return
	end
	Whisper.System(c, text, true)
end

function Cli.Show(c)
	if Whisper.Active() then
		if not c or Cli.WindowShown() then return end
		local had = run.whisperTabs and run.whisperTabs[c.id]
		local frame = Whisper.FrameFor(c, true, true)
		if frame then return frame == had end
	end
	ClaudeWoW.Toggle(true)
	return false
end

function Cli.Point(c)
	if Cli.Show(c) and run.cmd and run.cmd.general then
		print(ClaudeWoW.PREFIX .. Display(c.name) .. ' is the "' .. Whisper.Title(c) .. '" tab in the chat dock; bare /claude opens the workspace window.')
	end
end

function Cli.Out(c, text, open)
	if not c or Cli.Quiet() then return end
	AddHistory(c, "system", text)
	Cli.emitted[c.history[#c.history]] = true
	ClaudeWoW.Render()
	Cli.Emit(c, text)
	if open then Cli.Show(c) end
end

function Cli.Note(c, text)
	if not c then return end
	ClaudeWoW.Render()
	if Whisper.Active() then
		Cli.Emit(c, text)
	else
		print(ClaudeWoW.PREFIX .. Display(text))
	end
end

function Cli.Say(c, text) Cli.Out(c, text, true) end

function Cli.Begin(editBox)
	local tab = Whisper.TabChat(editBox) or Whisper.SelectedTabChat(editBox)
	local marks = {}
	for _, ch in ipairs(ns.db.chats) do
		marks[ch.id] = ch.history[#ch.history] or false
	end
	run.cmd = { tab = tab, general = type(editBox) == "table" and not tab or nil, marks = marks }
	if tab and ns.db.activeChat ~= tab.id then ClaudeWoW.SwitchChat(tab.id) end
end

function Cli.Finish()
	local cmd = run.cmd
	if not cmd then return end
	for _, ch in ipairs(ns.db.chats) do
		local mark = cmd.marks[ch.id]
		local fresh = {}
		for i = #ch.history, 1, -1 do
			local m = ch.history[i]
			if m == mark then break end
			table.insert(fresh, 1, m)
		end
		for _, m in ipairs(fresh) do
			if m.role == "system" and not Cli.emitted[m] then
				Cli.emitted[m] = true
				Cli.Emit(ch, m.text)
			end
		end
	end
	run.cmd = nil
end

function Cli.Run(editBox, fn, ...)
	Cli.Begin(editBox)
	local ok, err = pcall(fn, ...)
	Cli.Finish()
	if not ok then error(err, 0) end
end

function ClaudeWoW.Print(msg)
	local cmd = run.cmd
	local c = cmd and cmd.tab
	if not c and not (cmd and cmd.general) and Whisper.Active() and not Cli.WindowShown() then c = FindChat(run.lastReplyChat) or ActiveChat() end
	if c and Whisper.System(c, msg, true, true) then return end
	print(ClaudeWoW.PREFIX .. msg)
end

Cli.CLI_FLAGS = {
	["-c"] = "continue",
	["--continue"] = "continue",
	["-r"] = "resume",
	["--resume"] = "resume",
	["-n"] = "name",
	["--name"] = "name",
	["-h"] = "help",
	["--help"] = "help",
	["--model"] = "model",
	["--effort"] = "effort",
	["--permission-mode"] = "permissionMode",
	["--add-dir"] = "addDir",
	["--agent"] = "agent",
	["--project"] = "project",
}
Cli.CLI_VALUE = {
	name = "required",
	model = "required",
	effort = "required",
	permissionMode = "required",
	addDir = "required",
	agent = "required",
	project = "required",
	resume = "optional",
}
Cli.EFFORTS = { "low", "medium", "high", "xhigh", "max", "minimal" }
Cli.PERMISSION_MODES = { "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan" }
Cli.ADD_DIRS_MAX = 8

function Cli.ReadToken(s, pos)
	local start = s:find("%S", pos)
	if not start then return nil end
	local q = s:sub(start, start)
	if q == '"' or q == "'" then
		local close = s:find(q, start + 1, true)
		if close and (close == #s or s:sub(close + 1, close + 1):match("%s")) then return s:sub(start + 1, close - 1), start, close + 1, true end
	end
	local stop = s:find("%s", start) or (#s + 1)
	return s:sub(start, stop - 1), start, stop, false
end

function Cli.TextFrom(msg, start)
	local rest = Trim(msg:sub(start))
	local q = rest:sub(1, 1)
	if (q == '"' or q == "'") and #rest >= 2 and rest:sub(-1) == q and not rest:sub(2, -2):find(q, 1, true) then return rest:sub(2, -2) end
	return rest
end

function Cli.FlagKey(tok)
	if not tok then return nil end
	local name = tok:match("^(%-%-[%w%-]+)=") or tok
	return Cli.CLI_FLAGS[name:lower()]
end

function ClaudeWoW.ParseCli(msg)
	msg = msg or ""
	local o = { flags = 0, text = "", addDir = {} }
	local pos = 1
	while true do
		local tok, start, after, quoted = Cli.ReadToken(msg, pos)
		if not tok then return o end
		if quoted then
			o.text = Cli.TextFrom(msg, start)
			return o
		end
		if tok == "--" then
			o.text = Cli.TextFrom(msg, after)
			return o
		end
		local name, inline = tok:match("^(%-%-[%w%-]+)=(.*)$")
		local key = Cli.CLI_FLAGS[(name or tok):lower()]
		if not key then
			o.text = Cli.TextFrom(msg, start)
			return o
		end
		o.flags = o.flags + 1
		pos = after
		local value
		if name then
			if inline ~= "" then
				local v, _, vAfter = Cli.ReadToken(msg, start + #name + 1)
				value, pos = v, vAfter
			end
		elseif Cli.CLI_VALUE[key] then
			local nxt, _, nAfter, nQuoted = Cli.ReadToken(msg, pos)
			if nxt and nxt ~= "--" and (nQuoted or not Cli.FlagKey(nxt)) then
				value, pos = nxt, nAfter
			end
		end
		if key == "addDir" then
			if value then
				table.insert(o.addDir, value)
			else
				o.addDirShow = true
			end
		elseif Cli.CLI_VALUE[key] then
			o[key] = value or true
		else
			o[key] = true
		end
	end
end

function Cli.Cleared(v)
	v = tostring(v or ""):lower()
	return v == "-" or v == "default"
end

function Cli.Canonical(list, v)
	v = tostring(v or ""):lower()
	for _, x in ipairs(list) do
		if x:lower() == v then return x end
	end
	return nil
end

function Cli.HasSetters(o)
	for _, key in ipairs({ "name", "model", "effort", "permissionMode", "agent", "project" }) do
		if type(o[key]) == "string" then return true end
	end
	return #o.addDir > 0
end

function Cli.CheckFlags(o)
	local errors = {}
	if type(o.model) == "string" and not Cli.Cleared(o.model) and not o.model:match("^[%w%._:%[%]%-]+$") then
		table.insert(errors, '"' .. o.model .. '" is not a model name.')
	end
	if type(o.effort) == "string" and not Cli.Cleared(o.effort) and not Cli.Canonical(Cli.EFFORTS, o.effort) then
		table.insert(errors, 'Unknown effort "' .. o.effort .. '": low, medium, high, xhigh or max.')
	end
	if type(o.permissionMode) == "string" and not Cli.Cleared(o.permissionMode) and not Cli.Canonical(Cli.PERMISSION_MODES, o.permissionMode) then
		table.insert(errors, 'Unknown permission mode "' .. o.permissionMode .. '": ' .. table.concat(Cli.PERMISSION_MODES, ", ") .. ".")
	end
	if type(o.agent) == "string" and not Cli.Cleared(o.agent) and run.bridgeAgents and not Contains(run.bridgeAgents, o.agent:lower()) then
		table.insert(errors, 'Unknown agent "' .. o.agent .. '". The companion app knows: ' .. AgentList() .. ".")
	end
	if #o.addDir > Cli.ADD_DIRS_MAX then table.insert(errors, "At most " .. Cli.ADD_DIRS_MAX .. " --add-dir folders.") end
	if type(o.project) == "string" and not Cli.ResolveProject(o.project) then
		table.insert(errors, 'Unknown project "' .. o.project .. '". Known: ' .. Cli.ProjectNames() .. ". Or give a path.")
	end
	return errors
end

function Cli.DirsLabel(c)
	if type(c.addDirs) ~= "table" or #c.addDirs == 0 then return "none" end
	return table.concat(c.addDirs, ", ")
end

function Cli.ApplyChatFlags(c, o)
	local notes, projectNote = {}, nil
	if o.agent ~= nil then ClaudeWoW.SetAgent(o.agent == true and "" or o.agent, c) end
	if type(o.project) == "string" then
		projectNote = "project: " .. (Cli.SetProject(c, o.project) or Cli.ProjectLabel(c))
	elseif o.project == true then
		table.insert(notes, "project: " .. Cli.ProjectLabel(c) .. " (known: " .. Cli.ProjectNames() .. ")")
	end
	local function Setting(key, label, canonical, unset)
		if o[key] == nil then return end
		if o[key] ~= true then
			if Cli.Cleared(o[key]) then
				c[key] = nil
			else
				c[key] = canonical and canonical(o[key]) or o[key]
			end
		end
		table.insert(notes, label .. ": " .. ((c[key] or "") ~= "" and c[key] or (unset and unset() or "the agent's default")))
	end
	Setting("model", "model")
	Setting("effort", "effort", function(v) return Cli.Canonical(Cli.EFFORTS, v) end, function() return Cli.EffortLabel(c) end)
	Setting("permissionMode", "permission mode", function(v) return Cli.Canonical(Cli.PERMISSION_MODES, v) end)
	if #o.addDir > 0 or o.addDirShow then
		for _, dir in ipairs(o.addDir) do
			if Cli.Cleared(dir) then
				c.addDirs = nil
			else
				c.addDirs = c.addDirs or {}
				if not Contains(c.addDirs, dir) and #c.addDirs < Cli.ADD_DIRS_MAX then table.insert(c.addDirs, dir) end
			end
		end
		table.insert(notes, "extra folders: " .. Cli.DirsLabel(c))
	end
	return notes, projectNote
end

function ClaudeWoW.RunCli(o)
	if o.help then
		ClaudeWoW.ShowHelp()
		return
	end
	local errors = Cli.CheckFlags(o)
	if #errors > 0 then
		Cli.Say(ActiveChat(), table.concat(errors, "\n"))
		return
	end
	if o.resume ~= nil then
		Cli.RunResume(o)
		return
	end
	local c, notes, projectNote
	if o.continue or (o.flags > 0 and o.text == "" and not Cli.HasSetters(o)) then
		c = ActiveChat()
		if o.continue and type(o.name) == "string" then
			c.name = o.name:sub(1, 24)
			Whisper.Retitle(c)
		end
		notes, projectNote = Cli.ApplyChatFlags(c, o)
	else
		c = ClaudeWoW.NewChat(type(o.name) == "string" and o.name:sub(1, 24) or nil, function(fresh)
			notes, projectNote = Cli.ApplyChatFlags(fresh, o)
		end)
	end
	if projectNote then Cli.Note(c, projectNote) end
	if #notes > 0 then Cli.Out(c, table.concat(notes, "\n")) end
	if o.text ~= "" then
		ClaudeWoW.Send(o.text, nil, { chat = c.id })
	else
		ClaudeWoW.Render()
		Cli.Point(c)
	end
end

SLASH_CLAUDEWOW1 = "/claude-wow"
SLASH_CLAUDE1 = "/claude"
function Cli.ClaudeCommand(msg)
	msg = Trim(msg or "")
	if msg == "" then
		ClaudeWoW.OpenWorkspace(nil, true)
		return
	end
	if msg:lower() == "new" then
		ClaudeWoW.NewChat()
		return
	end
	local cmd, rest = msg:match("^(%S+)%s*(.-)$")
	local verb = cmd:lower()
	if verb == "config" and Cli.IsConfig(rest) then
		ClaudeWoW.Config(rest)
		return
	end
	if Cli.MODULE_SUBCOMMANDS[verb] then
		if Cli.IsModuleCommand(verb, rest) then
			local handler = Cli.MODULE_COMMANDS[verb]()
			if handler then
				handler(rest)
			else
				ClaudeWoW.Print("the " .. verb .. " module did not load")
			end
			return
		end
	elseif Cli.CLAUDE_VERBS[verb] and IsCommand(verb, rest) then
		RunCommand(verb, rest)
		return
	end
	ClaudeWoW.RunCli(ClaudeWoW.ParseCli(msg))
end

function Cli.ClientCommand(msg)
	msg = Trim(msg or "")
	local cmd, rest = msg:match("^(%S+)%s*(.-)$")
	cmd = cmd and cmd:lower() or ""
	if cmd ~= "" and not IsCommand(cmd, rest) then
		ClaudeWoW.Send(msg)
		return
	end
	RunCommand(cmd, rest)
end

SlashCmdList["CLAUDE"] = function(msg, editBox) Cli.Run(editBox, Cli.ClaudeCommand, msg) end

SlashCmdList["CLAUDEWOW"] = function(msg, editBox) Cli.Run(editBox, Cli.ClientCommand, msg) end
