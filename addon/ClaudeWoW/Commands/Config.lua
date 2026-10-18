local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Commands\\Config.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Cli, Whisper = ns.run, ns.Cli, ns.Whisper
local Trim, Contains = ns.Trim, ns.Contains
local ActiveChat = ns.ActiveChat
local ContextThresholdLabel, BridgePluginName, ChatAgentName = ns.ContextThresholdLabel, ns.BridgePluginName, ns.ChatAgentName
local WidgetArgument, RunCommand, IsCommand = ns.WidgetArgument, ns.RunCommand, Cli.IsCommand

function Cli.ConfigKey(word)
	word = tostring(word or ""):lower()
	word = Cli.CONFIG_ALIASES[word] or word
	return (Contains(Cli.CONFIG_KEYS, word) or Cli.CONFIG_RETIRED[word]) and word or nil
end

function Cli.IsConfig(rest)
	if rest == "" or rest:lower() == "all" then return true end
	local word, args = rest:match("^(%S+)%s*(.-)$")
	local key = Cli.ConfigKey(word)
	if not key then return false end
	if key == "macro" and args == "" then return true end
	return IsCommand(key, args)
end

function Cli.ConfigValue(key)
	local s = ns.db.settings
	local c = ActiveChat()
	if key == "voice" then return (type(ClaudeWoWDB.voice) == "table" and ClaudeWoWDB.voice.pack) or "race" end
	if key == "roast" then return (type(ClaudeWoWDB.roast) == "table" and ClaudeWoWDB.roast.on) and "on" or "off" end
	if key == "whisper" then return s.whisper and "on" or "off" end
	if key == "ui" then return Cli.UiStatus() end
	if key == "echo" then return tostring(s.echo) end
	if key == "vision" then return s.vision and "on" or "off" end
	if key == "roll" then return s.lootRoll == false and "off" or "on" end
	if key == "minimap" then return s.minimap == false and "off" or "on" end
	if key == "achievements" then return s.toasts == false and "toasts off" or "toasts on" end
	if key == "orders" then return ClaudeWoWOrders and ClaudeWoWOrders.Status() or "" end
	if key == "telemetry" then return ClaudeWoWTelemetry and ClaudeWoWTelemetry.Status() or "" end
	if key == "context" then return (s.context and "on" or "off") .. ", " .. ContextThresholdLabel() end
	if key == "signal" then return s.signal and "on" or "off" end
	if key == "mode" then return tostring(s.mode) end
	if key == "longchat" then return s.longchat and "on" or "off" end
	if key == "auto" then return (s.autoRefresh and "on" or "off") .. ", every " .. tostring(s.interval) .. " s" end
	if key == "plugin" then
		return (c and (c.plugin or "") ~= "") and c.plugin or ("chat default: " .. (Cli.ChatPlugin(c) ~= "" and Cli.ChatPlugin(c) or BridgePluginName()))
	end
	return ""
end

function Cli.ConfigList(all)
	local lines = { "Settings. /claude config <key> <value> changes one, /claude config <key> shows it:" }
	for _, key in ipairs(Cli.CONFIG_KEYS) do
		if all or not Cli.CONFIG_DEV[key] then
			local value = Cli.ConfigValue(key)
			table.insert(lines, key .. (value ~= "" and (" = " .. value) or "") .. "  -  " .. Cli.CONFIG_HELP[key])
		end
	end
	table.insert(
		lines,
		"The game's Options window has the same settings: AddOns, " .. (ClaudeWoWHelp and ClaudeWoWHelp.AddonTitle() or ClaudeWoW.PRODUCT) .. "."
	)
	if not all then table.insert(lines, "/claude config all also lists the troubleshooting keys.") end
	return table.concat(lines, "\n")
end

function Cli.ParseDim(v)
	v = tostring(v or ""):lower()
	if v == "off" then return 1 end
	if v == "on" then return Cli.DIM_DEFAULT end
	local n = tonumber((v:gsub("%%$", "")))
	if not n then return nil end
	if n > 1 then n = n / 100 end
	if n < 0.1 or n > 1 then return nil end
	return n
end

function Cli.Percent(alpha) return math.floor((alpha or 1) * 100 + 0.5) .. "%" end

function Cli.UiStatus()
	local s = ns.db.settings
	local dim = tonumber(s.dim) or 1
	return "whisper "
		.. (s.whisper and "on" or "off")
		.. ", dim "
		.. (dim < 1 and Cli.Percent(dim) or "off")
		.. ", dodge "
		.. (s.dodge and "on" or "off")
		.. ", autohide "
		.. (s.autohide and "on" or "off")
end

function Cli.IsUi(rest)
	local word, arg = tostring(rest or ""):lower():match("^(%S*)%s*(.-)$")
	if word == "whisper" or word == "dodge" or word == "autohide" then return arg == "" or arg == "on" or arg == "off" end
	if word == "dim" then return arg == "" or Cli.ParseDim(arg) ~= nil end
	if word == "reset" then return arg == "" end
	return WidgetArgument(rest)
end

function Cli.SetWhisper(c, rest)
	local s = ns.db.settings
	rest = tostring(rest or ""):lower()
	if rest == "on" then
		s.whisper, s.whisperChoice = true, "on"
		Whisper.Install()
		if Cli.Quiet() then return end
		local frame = Whisper.FrameFor(c, true, true)
		local text
		if frame then
			text = 'Whisper tabs are ON: this chat is the "'
				.. Whisper.Title(c)
				.. '" tab in the chat dock. Type there and press Enter to talk to '
				.. ChatAgentName(c)
				.. "; replies flash the tab, and /claude commands work there too. Other chats get a tab of their own. /claude config ui whisper off closes them."
		elseif Whisper.Active() and not Whisper.MayOpen(c) then
			text =
				"Whisper tabs are ON. A chat gets its tab in the chat dock once the companion app answers and you send that chat a message. /claude config ui whisper off turns them off."
		else
			text = "Whisper tabs are ON, but this client could not open a chat tab"
				.. (run.whisperError and (": " .. run.whisperError) or " (no FCF_OpenTemporaryWindow)")
				.. ". Replies keep going to the game chat and the window."
		end
		Cli.Out(c, text)
	elseif rest == "off" then
		s.whisper, s.whisperChoice = false, "off"
		Whisper.CloseAll()
		if Cli.Quiet() then return end
		Cli.Out(c, "Whisper tabs are off; replies go to the game chat and the window as before")
		print(
			ClaudeWoW.PREFIX
				.. "Whisper tabs are off: replies go to the game chat, and /claude opens the window. /claude config ui whisper on brings the tabs back."
		)
	else
		Cli.Out(c, Whisper.Status() .. " (/claude config ui whisper on|off: each chat as a native whisper tab)")
	end
end

function Cli.Ui(c, rest)
	local s = ns.db.settings
	local word, arg = tostring(rest or ""):match("^(%S*)%s*(.-)$")
	word, arg = (word or ""):lower(), (arg or ""):lower()
	if word == "whisper" then
		Cli.SetWhisper(c, arg)
	elseif word == "dodge" then
		if arg == "on" then
			s.dodge = true
		elseif arg == "off" then
			s.dodge = false
		end
		Cli.Out(
			c,
			"Dodge is "
				.. (
					s.dodge
						and "on: the window moves aside when bags, the character sheet, the spellbook, a vendor or another panel opens, and goes back when it closes."
					or "off: the window stays in the left panel slot."
				)
		)
	elseif word == "autohide" then
		if arg == "on" then
			s.autohide = true
		elseif arg == "off" then
			s.autohide = false
		end
		Cli.Out(
			c,
			"Auto-hide is "
				.. (
					s.autohide and "on: the window steps away while the maximized world map, the game menu or the settings are open, and comes back after."
					or "off: the window stays up over full-screen panels."
				)
		)
	elseif word == "dim" then
		if arg ~= "" then s.dim = Cli.ParseDim(arg) end
		local dim = tonumber(s.dim) or 1
		Cli.Out(
			c,
			dim < 1 and ("The window dims to " .. Cli.Percent(dim) .. " while you move or fight, and comes back when you stop or point at it.")
				or "Dimming is off: the window stays fully opaque."
		)
	elseif word == "reset" then
		if ClaudeWoWWindow then ClaudeWoWWindow.Reset() end
		Cli.Out(c, "The window's size is back to the default for this character.")
	elseif word == "" then
		Cli.Out(
			c,
			"Window and tabs: "
				.. Cli.UiStatus()
				.. ".\n/claude config ui whisper on|off, dim <10-100>|off, dodge on|off, autohide on|off, reset.\nLive widgets: /claude config ui list, remove <name>, run <name>."
		)
		if ClaudeWoWWidgets then ClaudeWoWWidgets.Command("") end
	elseif ClaudeWoWWidgets then
		ClaudeWoWWidgets.Command(rest)
	else
		ClaudeWoW.Print("the widget module did not load")
	end
	if ClaudeWoWWindow then ClaudeWoWWindow.Apply() end
end

function Cli.Reject(text)
	Cli.Say(ActiveChat(), text)
	return text
end

function Cli.ConfigCommand(rest, ctx)
	rest = Trim(rest or "")
	if rest == "" or rest:lower() == "all" then
		Cli.Say(ActiveChat(), Cli.ConfigList(rest ~= ""))
		return nil
	end
	local word, args = rest:match("^(%S+)%s*(.-)$")
	local key = Cli.ConfigKey(word)
	if not key then return Cli.Reject('No setting "' .. word .. '". ' .. Cli.ConfigList()) end
	if key == "macro" and args == "" then
		Cli.Say(ActiveChat(), "macro: " .. Cli.CONFIG_HELP.macro)
		return nil
	end
	if not IsCommand(key, args) then return Cli.Reject(key .. ' does not take "' .. args .. '". ' .. key .. ": " .. Cli.CONFIG_HELP[key]) end
	RunCommand(key, args, ctx)
	return nil
end

function ClaudeWoW.Config(rest, ctx)
	ctx = type(ctx) == "table" and ctx or {}
	local outer = Cli.invocation
	Cli.invocation = ctx
	local ok, result = pcall(Cli.ConfigCommand, rest, ctx)
	Cli.invocation = outer
	if not ok then error(result, 0) end
	return result
end
