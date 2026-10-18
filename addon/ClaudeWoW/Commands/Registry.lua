local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Commands\\Registry.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Q, Cli, Whisper = ns.run, ns.Q, ns.Cli, ns.Whisper
local SEG, ECHO, ParseTokens, FmtTokens = ns.SEG, ns.ECHO, ns.ParseTokens, ns.FmtTokens
local ActiveChat, AddHistory = ns.ActiveChat, ns.AddHistory
local ContextReport, SyncScreenshotMode, VisionStatus, SafeReload = ns.ContextReport, ns.SyncScreenshotMode, ns.VisionStatus, ns.SafeReload
local FolderName, ChatFolder, ChatAgentName = ns.FolderName, ns.ChatFolder, ns.ChatAgentName

ClaudeWoW.ROLL_HELP =
	"A command that needs your OK opens a Greed, Need or Pass roll. Off: Allow once and Allow & retry buttons in the reply. Need and Allow & retry ask before they save a rule."

local ON_OFF = { [""] = true, on = true, off = true }

local function OnOffOrNumber(rest) return rest == "" or rest == "on" or rest == "off" or tonumber(rest) ~= nil end

local function ContextArgument(rest) return rest == "" or rest == "on" or rest == "off" or ParseTokens(rest) ~= nil end

local function ChatArgument(rest)
	if rest == "" or tonumber(rest) or not rest:find("%s") then return true end
	for _, ch in ipairs(ns.db.chats) do
		if ch.name:lower() == rest:lower() then return true end
	end
	return false
end

local function WidgetArgument(rest)
	local lower = rest:lower()
	return lower == "" or lower == "list" or lower:match("^remove%s+%S+$") ~= nil or lower:match("^run%s+%S+$") ~= nil
end
ns.WidgetArgument = WidgetArgument

function Cli.NoArgument(arg) return arg == "" end
function Cli.OneWord(arg) return arg ~= "" and not arg:find("%s") end
function Cli.OnOffOrEmpty(arg) return arg == "" or arg == "on" or arg == "off" end

local function ApplyLongChat()
	local box = ChatFrame1EditBox
	if not box or not box.SetMaxLetters then return end
	box:SetMaxLetters(ns.db.settings.longchat and 4000 or 255)
end
ns.ApplyLongChat = ApplyLongChat

local function Quiet(ctx) return type(ctx) == "table" and ctx.quiet == true end

local function Missing(module, ctx)
	if not Quiet(ctx) then print(ClaudeWoW.PREFIX .. "the " .. module .. " module did not load") end
end

local function Forward(label, module)
	return function(_, rest, ctx)
		local m = module()
		if m then
			m.Command(rest, ctx)
		else
			Missing(label, ctx)
		end
	end
end

local function DevVerb(cmd)
	return function(c, rest) Cli.DevCommand(c, cmd, rest) end
end

local function Hide() ClaudeWoW.Toggle(false) end

local function Chats(c, rest)
	local n = tonumber(rest)
	local listed = Q.ListedChats()
	local target = n and listed[n]
	if not target and rest ~= "" then
		for _, ch in ipairs(listed) do
			if ch.name:lower() == rest:lower() then target = ch end
		end
	end
	if target then
		ClaudeWoW.SwitchChat(target.id)
	else
		local lines = {}
		for i, ch in ipairs(listed) do
			table.insert(
				lines,
				i
					.. ". "
					.. ch.name
					.. (ch.id == ns.db.activeChat and "  (current)" or "")
					.. (ch.pendingId and "  working" or "")
					.. ((ch.unread or 0) > 0 and ("  " .. ch.unread .. " new") or "")
			)
		end
		AddHistory(c, "system", "Chats:\n" .. table.concat(lines, "\n"))
		ClaudeWoW.Render()
	end
	Cli.Show(ActiveChat())
end

local function Context(c, rest)
	local s = ns.db.settings
	rest = rest:lower()
	local limit = ParseTokens(rest)
	if limit then
		s.contextWarn = limit
		for _, ch in ipairs(ns.db.chats) do
			if limit <= 0 or (ch.ctx or 0) < limit then ch.ctxWarned = nil end
		end
		AddHistory(
			c,
			"system",
			(
				limit > 0 and ("Context warning at " .. FmtTokens(limit) .. " tokens: a chat that passes it says so once and offers a new chat.")
				or "Context warning off: chats grow quietly. The footer still shows ctx and turns."
			)
				.. "\n"
				.. ContextReport(c)
		)
		ClaudeWoW.Render()
		Cli.Show(c)
		return
	end
	if rest == "on" or rest == "off" then
		s.context = rest == "on"
		run.contextSent = nil
		run.lastHelloAt = nil
		if ClaudeWoW.IsConnected() then ClaudeWoW.SayHello() end
	end
	local gameContext = ClaudeWoW.GameContext()
	AddHistory(
		c,
		"system",
		(rest == "" and (ContextReport(c) .. "\n\n") or "")
			.. (s.context and "Game context is ON: the agent is told this with each message (it goes into its system prompt, so unrelated projects are unaffected by anything but a few lines). /claude config context off to stop.\n\n" or "Game context is OFF: the agent is told nothing about the game. /claude config context on to send this:\n\n")
			.. gameContext
			.. "\n\nTip: click the input box, then shift-click an item, spell or quest to link it into your message; the agent gets its tooltip."
	)
	ClaudeWoW.Render()
	Cli.Show(c)
end

local Achievements = Forward("achievements", function() return ClaudeWoWAchievements end)

local Commands = {}
local byVerb = {}
ns.Commands = Commands

local function Add(entry)
	Commands[#Commands + 1] = entry
	byVerb[entry.verb] = entry
end

Add({ verb = "", run = function() ClaudeWoW.Toggle() end })
Add({ verb = "hide", args = 0, verbs = true, run = Hide })
Add({ verb = "quit", args = 0, verbs = true, run = Hide })
Add({ verb = "mini", args = 0, verbs = true, run = Hide })
Add({ verb = "min", args = 0, verbs = true, run = Hide })
Add({ verb = "help", args = 0, verbs = true, help = { "/claude help", "Open this page." }, run = function() ClaudeWoW.ShowHelp() end })
Add({ verb = "new", args = true, run = function(_, rest) ClaudeWoW.NewChat(rest) end })
Add({ verb = "chat", args = ChatArgument, run = Chats })
Add({ verb = "chats", args = ChatArgument, run = Chats })
Add({
	verb = "rename",
	args = true,
	verbs = true,
	help = { "/claude rename [name]", "Rename the current chat. Alone it opens a dialog." },
	run = function(c, rest)
		if rest ~= "" then
			c.name = rest:sub(1, 24)
			Whisper.Retitle(c)
			ClaudeWoW.Render()
		else
			ClaudeWoW.RenameActive()
		end
		Cli.Show(c)
	end,
})
Add({ verb = "delete", args = 0, verbs = true, help = { "/claude delete", "Delete the current chat." }, run = function() ClaudeWoW.DeleteChat() end })
Add({
	verb = "cd",
	args = true,
	verbs = true,
	help = {
		"/claude cd <project path>",
		"Set this chat's project by its path, like --project. A relative path starts where the companion app runs; alone it goes back to the default. A chat with a project is a coding session there, one without is general in-game chat.",
	},
	run = function(c, rest)
		ClaudeWoW.SetFolder(rest, c)
		Cli.Show(c)
	end,
})
Add({
	verb = "look",
	args = true,
	verbs = true,
	help = { "/claude look <question>", "Send one message to the current chat with a picture of your screen." },
	run = function(_, rest) ClaudeWoW.Send(rest ~= "" and rest or "What do you see on my screen?", nil, { vision = true }) end,
})
Add({
	verb = "clear",
	args = 0,
	verbs = true,
	help = { "/claude clear", "Clear this chat's transcript." },
	run = function(c)
		wipe(c.history)
		ClaudeWoW.Render()
	end,
})
Add({
	verb = "copy",
	args = 0,
	verbs = true,
	help = { "/claude copy", "Open the last reply in a selectable box for Ctrl+C." },
	run = function(c)
		for i = #c.history, 1, -1 do
			if c.history[i].role == "assistant" then
				ClaudeWoW.ShowCopy(c.history[i].text)
				break
			end
		end
	end,
})
Add({
	verb = "reset",
	args = 0,
	verbs = true,
	help = { "/claude reset", "The next message in this chat starts a fresh session." },
	run = function(c)
		c.resetNext = true
		local where = ChatFolder(c)
		Q.AddEvent(c, "Next message: new " .. ChatAgentName(c) .. " session" .. (where ~= "" and (" " .. SEG.DOT .. " " .. FolderName(where)) or ""))
		ClaudeWoW.Render()
		Cli.Show(c)
	end,
})
Add({ verb = "cancel", args = 0, verbs = true, help = { "/claude cancel", "Stop waiting on this chat's reply." }, run = function(c) ClaudeWoW.Cancel(c) end })
Add({
	verb = "mcp",
	args = function(rest) return Cli.IsMcpCommand(rest) end,
	verbs = true,
	help = {
		"/claude mcp [on|off <name>|none|default]",
		"The MCP servers this chat's Claude or Codex runs get, with their health. The MCP button in the chat header does the same.",
	},
	run = function(c, rest) Cli.McpCommand(c, rest) end,
})
Add({
	verb = "wrong",
	args = true,
	verbs = true,
	help = { "/claude wrong [#n] [note]", "Mark the last reply in this chat (or reply #n) as wrong; the companion app keeps it in its feedback list." },
	run = DevVerb("wrong"),
})
Add({ verb = "discord", args = 0, verbs = true, run = function(c) Cli.LinkDiscord(c) end })
Add({ verb = "live", args = 0, run = function() ClaudeWoW.ShowResumePicker() end })
Add({
	verb = "agent",
	args = 1,
	run = function(c, rest)
		ClaudeWoW.SetAgent(rest, c)
		Cli.Show(c)
	end,
})
Add({
	verb = "voice",
	args = function(rest) return ClaudeWoWVoice ~= nil and ClaudeWoWVoice.IsCommand(rest) end,
	config = { help = "race|peasant|peon|off, set <event> <line>, reset, test <event|line>, lines [pack]: voice lines at agent events" },
	run = Forward("voice", function() return ClaudeWoWVoice end),
})
Add({
	verb = "roast",
	args = ON_OFF,
	config = { help = 'on|off: when you die, a short roast of it in the "Death roasts" chat' },
	run = Forward("roast", function() return ClaudeWoWRoast end),
})
Add({
	verb = "whisper",
	args = ON_OFF,
	config = { help = "on|off: each chat as a native whisper tab (same as ui whisper)" },
	run = function(c, rest) Cli.SetWhisper(c, rest) end,
})
Add({
	verb = "echo",
	args = function(rest) return rest == "" or rest == "summary" or rest == "full" or rest == "short" or rest == "off" or tonumber(rest) ~= nil end,
	config = { help = "summary|full|short|off|<chars>: how much of a reply the game chat prints" },
	run = function(c, rest, ctx)
		local s = ns.db.settings
		if rest == "summary" or rest == "full" or rest == "short" or rest == "off" then
			s.echo = rest
		elseif tonumber(rest) then
			s.echo = tostring(math.max(200, math.floor(tonumber(rest))))
		end
		if not Quiet(ctx) then
			AddHistory(
				c,
				"system",
				"replies in game chat: "
					.. s.echo
					.. " (summary = the agent's TL;DR lines, full = "
					.. ECHO.DEFAULT
					.. " chars, short, off, or a number of characters)"
			)
		end
		ClaudeWoW.Render()
	end,
})
Add({
	verb = "vision",
	args = ON_OFF,
	config = { help = "on|off: a picture of your screen with each message (screenshot transport)" },
	run = function(c, rest)
		local s = ns.db.settings
		if rest == "on" then
			s.vision = true
		elseif rest == "off" then
			s.vision = false
		end
		AddHistory(
			c,
			"system",
			VisionStatus() .. ". /claude config vision on|off; /claude look <question> sends one message with a picture whatever the setting."
		)
		ClaudeWoW.UpdateStatus()
		ClaudeWoW.Render()
		Cli.Show(c)
	end,
})
Add({
	verb = "roll",
	args = ON_OFF,
	config = { help = "on|off: " .. ClaudeWoW.ROLL_HELP },
	run = function(_, rest, ctx)
		local s = ns.db.settings
		if rest == "on" then
			s.lootRoll = true
		elseif rest == "off" then
			s.lootRoll = false
		end
		if s.lootRoll == false and ClaudeWoWRoll then ClaudeWoWRoll.CloseAll() end
		if not Quiet(ctx) then
			ClaudeWoW.Print("Ask with a roll window is " .. (ClaudeWoW.LootRollEnabled() and "on" or "off") .. ". " .. ClaudeWoW.ROLL_HELP)
		end
		ClaudeWoW.Render()
	end,
})
Add({
	verb = "achievements",
	args = { [""] = true, on = true, off = true, test = true, list = true },
	config = { help = "on|off|test: achievement toasts; alone it lists what you earned" },
	run = Achievements,
})
Add({ verb = "toasts", args = { [""] = true, on = true, off = true, test = true }, configAlias = "achievements", run = Achievements })
Add({
	verb = "orders",
	args = ON_OFF,
	verbs = true,
	config = { help = "on|off: the Orders card under the quest tracker (also /claude orders and the chat list's gear menu)" },
	help = { "/claude orders [on|off]", "Show or hide the Orders card under the quest tracker." },
	run = Forward("orders", function() return ClaudeWoWOrders end),
})
Add({
	verb = "minimap",
	args = ON_OFF,
	config = { help = "on|off: the minimap button (left-click opens or closes the window, right-click opens Options, drag it around the minimap)" },
	help = {
		"/claude config minimap [on|off]",
		"The minimap button: left-click opens or closes the window, right-click opens Options, drag it around the minimap.",
	},
	run = function(_, rest, ctx)
		local s = ns.db.settings
		if rest == "on" then
			s.minimap = true
		elseif rest == "off" then
			s.minimap = false
		end
		Q.ApplyMinimapButton()
		if not Quiet(ctx) then
			ClaudeWoW.Print(
				"minimap button: "
					.. (
						Q.MinimapButtonOn() and "on. Left-click opens or closes the window, right-click opens Options, drag it to move it."
						or "off. /claude config minimap on brings it back."
					)
			)
		end
	end,
})
Add({
	verb = "telemetry",
	args = ON_OFF,
	config = {
		help = "on|off: share game state with the agent (money, level, zone, professions, watched items, gear, reputation); also the chat list's gear menu",
	},
	run = Forward("telemetry", function() return ClaudeWoWTelemetry end),
})
Add({
	verb = "context",
	args = ContextArgument,
	config = { help = "on|off|<tokens>: the game context the agent gets, and the context-size warning (0 = never)" },
	run = Context,
})
Add({ verb = "ctx", args = ContextArgument, configAlias = "context", run = Context })
Add({
	verb = "signal",
	args = ON_OFF,
	config = { help = "on|off: the cheap sound-file readiness check", dev = true },
	run = function(c, rest)
		local s = ns.db.settings
		if rest == "on" then
			s.signal = true
		elseif rest == "off" then
			s.signal = false
		end
		AddHistory(c, "system", "signal check is " .. (s.signal and "on" or "off"))
		ClaudeWoW.Render()
	end,
})
Add({
	verb = "mode",
	args = { [""] = true, pixel = true, reload = true },
	config = { help = "pixel|reload: the transport", dev = true },
	run = function(c, rest)
		local s = ns.db.settings
		if rest == "pixel" or rest == "reload" then
			s.mode = rest
			SyncScreenshotMode()
			AddHistory(c, "system", "mode set to " .. rest)
		else
			AddHistory(c, "system", "mode is " .. s.mode .. " (pixel or reload)")
		end
		ClaudeWoW.Render()
		Cli.Show(c)
	end,
})
Add({
	verb = "longchat",
	args = ON_OFF,
	config = { help = "on|off: let the game chat box take 4000 characters", dev = true },
	run = function(c, rest)
		local s = ns.db.settings
		if rest == "on" then
			s.longchat = true
		elseif rest == "off" then
			s.longchat = false
		end
		ApplyLongChat()
		AddHistory(
			c,
			"system",
			"game chat box limit: "
				.. (s.longchat and "4000 characters (fine for /claude; real chat over 255 may be rejected by the server)" or "255 (default)")
		)
		ClaudeWoW.Render()
	end,
})
Add({
	verb = "auto",
	args = OnOffOrNumber,
	config = {
		help = "on|off|<seconds>: how often the Reload needed dialog asks again after Later (reload mode, or when the reply slots are gone)",
		dev = true,
	},
	run = function(_, rest)
		local s = ns.db.settings
		local n = tonumber(rest)
		if n then
			s.interval = math.max(5, math.floor(n))
			s.autoRefresh = true
		elseif rest == "on" then
			s.autoRefresh = true
		elseif rest == "off" then
			s.autoRefresh = false
		end
		ClaudeWoW.UpdateStatus()
		ClaudeWoW.ArmAutoRefresh()
	end,
})
Add({
	verb = "plugin",
	args = 1,
	config = { help = "<name>|default: advanced, what this chat is bound to", dev = true },
	run = function(c, rest)
		ClaudeWoW.SetPlugin(rest, c)
		Cli.Show(c)
	end,
})
Add({
	verb = "ui",
	args = function(rest) return Cli.IsUi(rest) end,
	config = {
		help = "whisper on|off, dim <10-100>|off, dodge on|off, autohide on|off, reset: the tabs and the window; list|remove <name>|run <name>: live widgets",
	},
	help = { "/claude config ui [setting]", "The tabs and the window: whisper on|off, dim <10-100>|off, dodge on|off, autohide on|off, reset." },
	run = function(c, rest) Cli.Ui(c, rest) end,
})
Add({
	verb = "map",
	args = true,
	verbs = true,
	config = { help = "map layers, the route navigator and herb/ore nodes (/aimap is the same)" },
	help = { "/claude map [command]", "Map layers and node pins: ore, herb, filter, show, hide, nav, next, prev, stop. /aimap is the same." },
	module = {
		[""] = Cli.NoArgument,
		ore = Cli.OnOffOrEmpty,
		herb = Cli.OnOffOrEmpty,
		filter = function(arg) return arg == "all" or arg == "skill" end,
		show = Cli.OneWord,
		hide = Cli.OneWord,
		nav = function(arg) return arg:match("^%S+%s*%d*$") ~= nil end,
		next = Cli.NoArgument,
		prev = Cli.NoArgument,
		stop = Cli.NoArgument,
	},
	moduleRun = function() return ClaudeWoWMap and ClaudeWoWMap.Command end,
	run = Forward("map", function() return ClaudeWoWMap end),
})
Add({
	verb = "macro",
	args = { undo = true },
	config = { help = "undo: undo the last macro the agent's button created or changed" },
	run = function(_, rest)
		if rest == "undo" then ClaudeWoW.UndoMacro() end
	end,
})
Add({
	verb = "probe",
	args = function(rest)
		local which, arg = rest:lower():match("^(%S*)%s*(.-)$")
		if which == "chatlog" then return arg == "" or tonumber(arg) ~= nil end
		return arg == "" and (which == "" or which == "all" or which == "asyncfile")
	end,
	verbs = true,
	config = { help = "chatlog|asyncfile: write test lines to the client's own logs so the companion app can measure them", dev = true },
	help = { "/claude probe [chatlog|asyncfile]", "Write test lines to the client's own logs so the companion app can measure them." },
	run = function(_, rest) ClaudeWoW.Probe.Run(rest) end,
})
Add({
	verb = "diag",
	args = { [""] = true, copy = true },
	verbs = true,
	config = { help = "transport diagnostics", dev = true },
	help = { "/claude diag [copy]", "Transport diagnostics; copy opens them in a box, selected for Ctrl+C." },
	run = function(c, rest) Cli.Diag(c, rest) end,
})
Add({
	verb = "resend",
	args = 0,
	verbs = true,
	help = { "/claude resend", "Show the strip again if the companion app missed it." },
	run = function() ClaudeWoW.Resend() end,
})
Add({ verb = "reload", args = 0, verbs = true, help = { "/claude reload", "Reload now. This also frees the slot pool." }, run = function() SafeReload() end })
Add({ verb = "refresh", args = 0, verbs = true, run = function() SafeReload() end })
Add({
	verb = "slots",
	args = 0,
	verbs = true,
	help = { "/claude slots", "How many reply slots are still free this session." },
	run = function(c) Cli.Slots(c) end,
})
Add({
	verb = "dev",
	args = true,
	verbs = true,
	help = {
		"/claude dev [command]",
		"Dev tools for this chat's project, run by the companion app: status, diff, log, run, test, doctor, errors, feedback (/claude dev help). globals saves the widget audit list in game.",
	},
	run = DevVerb("dev"),
})
Add({
	verb = "bug",
	args = true,
	verbs = true,
	help = { "/claude bug <text>", "Report a bug, with the addon's state and Lua errors attached." },
	run = DevVerb("bug"),
})
Add({
	verb = "errors",
	args = 0,
	verbs = true,
	help = { "/claude errors", "The Lua errors the addon caught this UI session." },
	run = function(c) Cli.Say(c, ClaudeWoWDev and ClaudeWoWDev.Report() or "Dev.lua is not loaded. Restart the game client once to load new addon files.") end,
})
Add({
	verb = "bind",
	args = true,
	config = { retired = true },
	run = function(c)
		AddHistory(c, "system", Q.BIND_MOVED)
		ClaudeWoW.Render()
		Cli.Show(c)
	end,
})
Add({
	verb = "dm",
	verbs = true,
	help = { "/claude dm [next]", "Show or hide the Dungeon Master; next goes on to a beat that waits for you. /dm is the same." },
	module = { [""] = Cli.NoArgument, next = Cli.NoArgument },
	moduleRun = function() return ClaudeWoWDM and ClaudeWoWDM.Command end,
})
Add({
	verb = "stream",
	verbs = true,
	help = { "/claude stream [command]", "Stream scenes, panes and the quest overlay. /stream is the same." },
	module = {
		[""] = Cli.NoArgument,
		help = Cli.NoArgument,
		starting = Cli.NoArgument,
		raid = Cli.NoArgument,
		game = Cli.NoArgument,
		code = Cli.NoArgument,
		brb = Cli.NoArgument,
		quest = function(arg) return arg ~= "" end,
		pane = function(arg) return arg == "left" or arg == "right" or arg == "full" end,
		follow = function(arg) return arg == "on" or arg == "off" end,
	},
	moduleRun = function() return ClaudeWoWStream and ClaudeWoWStream.SlashCommand end,
})

local HELP_LAYOUT = {
	{
		title = "Start and resume chats",
		rows = {
			{
				"/claude <text>",
				'Start a new chat with that message, like claude "<text>" in a terminal. Bare /claude opens the window on the current chat; /claude new starts an empty chat.',
			},
			{ "/claude -c [text]", "Continue the current chat (--continue). Alone it points at its tab; with the tabs off, it opens the window on it." },
			{
				"/claude -r [id|name|n] [text]",
				"Resume a session (--resume). A Claude Code session started with the claude-wow channel gets the chat live; any other session is resumed headless in its project. Bare -r lists the sessions (live ones first, marked live, running not listening, or resume): click a row or give its number; -r more lists them all.",
			},
			{ "/claude -r all", "Open one chat per session handed off with claude-wow handoff in a terminal; each resumes its session headless." },
			{ "/claude -n <name> [text]", "Name the new chat (--name). With -c it renames the current one." },
		},
	},
	{
		title = "Chat options",
		rows = {
			{ "/claude --model <model> [text]", "The model for the chat: opus, sonnet or a full model name." },
			{ "/claude --effort <level> [text]", "low, medium, high, xhigh or max." },
			{ "/claude --project <name|path|none> [text]", "Attach this chat to a project (or #name in a message). none makes it a general chat." },
			{ "/claude --permission-mode <mode>", "acceptEdits, auto, plan, manual, dontAsk or bypassPermissions." },
			{ "/claude --add-dir <path> [text]", "One more folder the agent may use. Repeat the flag for more." },
			{ "/claude --agent <name> [text]", "Which CLI runs the chat: claude, codex, grok, agy or hermes." },
		},
		notes = {
			"Flags come before the text and combine: /claude --model opus fix the build starts a new chat on opus. With -c they change the current chat.",
			'--flag=value and "quoted values" work, a value of - clears a setting, and a flag with no value shows it. The companion app tells you when an agent has no such option.',
		},
	},
	{ title = "This chat", rows = { "cd", "look", "rename", "delete", "clear", "copy", "reset", "cancel", "mcp", "wrong" } },
	{
		title = "Whispers",
		rows = {
			{ "/r <text>", "Reply to the chat that answered last, until a real player whispers you." },
			{ "/w <agent> <text>", "Send to that agent's chat when whisper tabs are on." },
		},
	},
	{
		title = "Settings and the window",
		rows = {
			{
				"/claude config [key] [value]",
				"Settings: voice, roast, whisper, echo, vision, roll, achievements, orders, minimap, telemetry, ui, map, macro, context. Alone it lists them with their values; all adds the troubleshooting keys. The Options page under AddOns, "
					.. ns.PRODUCT
					.. " in the game's settings has the same switches.",
			},
			"ui",
			"orders",
			"dm",
			"map",
			"stream",
			"minimap",
			"help",
		},
	},
	{
		title = "Tips",
		notes = {
			"A command word followed by something it does not take is a message: /claude delete the unused imports starts a new chat with that text.",
			"Shift-click an item, spell or quest to link it into your message.",
		},
	},
	{ title = "More", rows = { "bug", "errors", "reload", "dev", "resend", "slots", "diag", "probe" } },
}
ns.HelpLayout = HELP_LAYOUT

local function HelpRow(item)
	if type(item) == "table" then return item end
	local entry = byVerb[item]
	assert(entry and entry.help, "no help row for the verb " .. tostring(item))
	return entry.help
end

local function BuildHelp()
	local sections = {}
	for _, section in ipairs(HELP_LAYOUT) do
		local out = { title = section.title }
		if section.rows then
			out.rows = {}
			for _, item in ipairs(section.rows) do
				out.rows[#out.rows + 1] = HelpRow(item)
			end
		end
		if section.notes then out.notes = section.notes end
		sections[#sections + 1] = out
	end
	return sections
end
ClaudeWoW.HELP = BuildHelp()

Cli.CLAUDE_VERBS = {}
Cli.CONFIG_KEYS = {}
Cli.CONFIG_HELP = {}
Cli.CONFIG_DEV = {}
Cli.CONFIG_RETIRED = {}
Cli.CONFIG_ALIASES = {}
Cli.MODULE_SUBCOMMANDS = {}
Cli.MODULE_COMMANDS = {}
for _, entry in ipairs(Commands) do
	if entry.verbs then Cli.CLAUDE_VERBS[entry.verb] = true end
	if entry.config then
		if entry.config.retired then
			Cli.CONFIG_RETIRED[entry.verb] = true
		else
			Cli.CONFIG_KEYS[#Cli.CONFIG_KEYS + 1] = entry.verb
		end
		if entry.config.help then Cli.CONFIG_HELP[entry.verb] = entry.config.help end
		if entry.config.dev then Cli.CONFIG_DEV[entry.verb] = true end
	end
	if entry.configAlias then Cli.CONFIG_ALIASES[entry.verb] = entry.configAlias end
	if entry.module then
		Cli.MODULE_SUBCOMMANDS[entry.verb] = entry.module
		Cli.MODULE_COMMANDS[entry.verb] = entry.moduleRun
	end
end

function Cli.CommandVerbs()
	local verbs = {}
	for _, entry in ipairs(Commands) do
		if entry.args ~= nil then verbs[#verbs + 1] = entry.verb end
	end
	table.sort(verbs)
	return verbs
end

function Cli.IsCommand(cmd, rest)
	local entry = byVerb[cmd]
	local spec = entry and entry.args
	if spec == nil then return false end
	if spec == true then return true end
	if spec == 0 then return rest == "" end
	if spec == 1 then return not rest:find("%s") end
	if type(spec) == "table" then return spec[rest:lower()] == true end
	return spec(rest) == true
end

function Cli.IsModuleCommand(verb, rest)
	local subcommands = Cli.MODULE_SUBCOMMANDS[verb]
	if not subcommands then return false end
	local word, arg = tostring(rest or ""):lower():match("^(%S*)%s*(.-)%s*$")
	local accepts = subcommands[word or ""]
	return accepts ~= nil and accepts(arg or "") == true
end

local function RunCommand(cmd, rest, ctx)
	local entry = byVerb[cmd]
	if entry and entry.run then entry.run(ActiveChat(), rest, ctx) end
end
ns.RunCommand = RunCommand
