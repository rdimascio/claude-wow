local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Chat\\Sessions.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Q, Cli, Whisper = ns.run, ns.Q, ns.Cli, ns.Whisper
local Display, Flat, SEG, LINK_PREFIX, LIVE_PLUGIN = ns.Display, ns.Flat, ns.SEG, ns.LINK_PREFIX, ns.LIVE_PLUGIN
local FindChat, ActiveChat, AddChat, AddHistory = ns.FindChat, ns.ActiveChat, ns.AddChat, ns.AddHistory
local FolderName, TryLoadSlot = ns.FolderName, ns.TryLoadSlot

function Cli.Age(at)
	local now = run.bridgeNow or time()
	local sec = math.max(0, now - (tonumber(at) or now))
	if sec < 60 then return "now" end
	if sec < 3600 then return math.floor(sec / 60) .. "m ago" end
	if sec < 86400 then return math.floor(sec / 3600) .. "h ago" end
	return math.floor(sec / 86400) .. "d ago"
end

function Cli.LastActivity(ch)
	local last = ch.history and ch.history[#ch.history]
	return (last and last.t) or ch.created or 0
end

function Cli.LatestChat()
	local best
	for _, ch in ipairs(ns.db.chats) do
		if not ch.quiet and (not best or Cli.LastActivity(ch) > Cli.LastActivity(best)) then best = ch end
	end
	return best or ns.db.chats[1]
end

Cli.PICKER_ROWS = 8
Cli.TITLE_MAX = 48
Cli.BADGES = {
	live = { "live", "55ff55" },
	deaf = { "running, not listening", "ff9933" },
	resume = { "resume", "aaaaaa" },
}

function Cli.SessionEntries()
	local live, deaf, rest, seen, seenId = {}, {}, {}, {}, {}
	for _, e in ipairs(run.bridgeSessions or {}) do
		if e.id == "" or not seenId[e.id] then
			if e.id ~= "" then seenId[e.id] = true end
			local alias = e.name
			local chat = e.chat ~= "" and FindChat(e.chat) or nil
			for _, ch in ipairs(ns.db.chats) do
				if not chat and e.id ~= "" and (ch.session == e.id or ch.resumeId == e.id) and not e.running then chat = ch end
				if not chat and e.running and ch.liveTarget and (ch.liveTarget == e.id or ch.liveTarget:lower() == alias:lower()) then chat = ch end
			end
			if not (chat and seen[chat.id]) then
				local kind = e.live and "live" or (e.running and "deaf" or (chat and "chat" or "headless"))
				local title = e.title ~= "" and e.title or e.name
				local entry = {
					kind = kind,
					id = e.id,
					name = (chat and not e.running) and chat.name or title,
					alias = alias,
					cwd = e.cwd,
					branch = e.branch,
					agent = e.agent,
					plugin = e.plugin,
					at = e.at,
					live = e.live,
					running = e.running,
					restart = e.restart,
					chat = chat and chat.id or nil,
					bridgeChat = (not chat and e.chat ~= "") and e.chat or nil,
					handoff = e.handoff,
					recap = e.recap,
				}
				table.insert(kind == "live" and live or (kind == "deaf" and deaf or rest), entry)
				if chat then seen[chat.id] = true end
			end
		end
	end
	for _, ch in ipairs(Q.ListedChats()) do
		if not seen[ch.id] then
			table.insert(rest, {
				kind = "chat",
				id = ch.session or "",
				name = ch.name,
				cwd = ch.cwd or "",
				branch = "",
				agent = ch.agent or "",
				at = Cli.LastActivity(ch),
				chat = ch.id,
			})
		end
	end
	for i, e in ipairs(rest) do
		e.order = i
	end
	table.sort(rest, function(a, b)
		local x, y = tonumber(a.at) or 0, tonumber(b.at) or 0
		if x ~= y then return x > y end
		return a.order < b.order
	end)
	local list = {}
	for _, group in ipairs({ live, deaf, rest }) do
		for _, e in ipairs(group) do
			table.insert(list, e)
		end
	end
	return list
end

function Cli.Badge(e)
	if e.kind == "live" then return Cli.BADGES.live end
	if e.kind == "deaf" then return Cli.BADGES.deaf end
	return Cli.BADGES.resume
end

function Cli.EntryParts(e)
	local title = Flat(e.name ~= "" and e.name or (e.id ~= "" and e.id:sub(1, 8) or "?"))
	if #title > Cli.TITLE_MAX then title = title:sub(1, Cli.TITLE_MAX - 3) .. "..." end
	local where = Display(FolderName(e.cwd or ""))
	if (e.branch or "") ~= "" then where = (where ~= "" and (where .. " ") or "") .. "(" .. Display(e.branch) .. ")" end
	local meta = {}
	if where ~= "" then table.insert(meta, where) end
	if e.at and e.at > 0 then table.insert(meta, Cli.Age(e.at)) end
	local current = e.chat ~= nil and e.chat == ns.db.activeChat
	return title, table.concat(meta, " " .. SEG.DOT .. " "), Cli.Badge(e), current
end

function Cli.EntryLine(i, e)
	local title, meta, badge, current = Cli.EntryParts(e)
	local parts = { title }
	if meta ~= "" then table.insert(parts, meta) end
	table.insert(parts, badge[1])
	return i .. ". " .. table.concat(parts, " " .. SEG.DOT .. " ") .. (current and " (this chat)" or "")
end

function Cli.EntryRich(i, e)
	local title, meta, badge, current = Cli.EntryParts(e)
	return "|cff7ec8ff["
		.. i
		.. "]|r "
		.. title
		.. (meta ~= "" and (" |cff888888" .. SEG.DOT .. " " .. meta .. "|r") or "")
		.. " |cff"
		.. badge[2]
		.. badge[1]
		.. "|r"
		.. (current and " |cffffd100(this chat)|r" or "")
end

function Cli.EntryLink(i, e) return "|H" .. LINK_PREFIX .. "resume:" .. i .. "|h" .. Cli.EntryRich(i, e) .. "|h" end

function Cli.EntryCopy(e)
	local copy = {}
	for k, v in pairs(e) do
		if type(v) ~= "table" and type(v) ~= "function" then copy[k] = v end
	end
	return copy
end

function Cli.MoreRich(left) return "|cff7ec8ff[more]|r |cff888888" .. left .. " older session" .. (left == 1 and "" or "s") .. "|r" end

function ClaudeWoW.ShowResumePicker(entries, header, all)
	entries = entries or Cli.SessionEntries()
	run.resumeList = entries
	local c = ActiveChat()
	header = header or "Sessions: click one to attach this chat, or /claude -r <n>."
	local shown = all and #entries or math.min(#entries, Cli.PICKER_ROWS)
	local left = #entries - shown
	local lines, rows = { header }, {}
	for i = 1, shown do
		local e = entries[i]
		table.insert(lines, Cli.EntryLine(i, e))
		table.insert(rows, { text = Cli.EntryRich(i, e), entry = Cli.EntryCopy(e) })
	end
	if #entries == 0 then table.insert(lines, "No sessions yet.") end
	if left > 0 then
		table.insert(lines, "[more] " .. left .. " older session" .. (left == 1 and "" or "s") .. ": /claude -r more")
		table.insert(rows, { text = Cli.MoreRich(left), more = true })
	end
	local live = run.bridgeLive
	local startHint = live and #live.sessions == 0 and live.start ~= "" and ("No session is listening to the game. Start one with: " .. live.start) or nil
	if startHint then table.insert(lines, startHint) end
	AddHistory(c, "system", table.concat(lines, "\n"))
	local m = c.history[#c.history]
	m.picker = rows
	m.head = header .. (startHint and ("\n" .. startHint) or "")
	Cli.emitted[m] = true
	ClaudeWoW.Render()
	if not Whisper.Active() then ClaudeWoW.Toggle(true) end
	ClaudeWoW.Print(Display(header))
	for i = 1, shown do
		ClaudeWoW.Print(Cli.EntryLink(i, entries[i]))
	end
	if #entries == 0 then ClaudeWoW.Print("No sessions yet.") end
	if left > 0 then ClaudeWoW.Print("|H" .. LINK_PREFIX .. "sessions:all|h" .. Cli.MoreRich(left) .. "|h") end
	if startHint then ClaudeWoW.Print(Display(startHint)) end
end

function Cli.Links.sessions(arg) ClaudeWoW.ShowResumePicker(nil, nil, arg == "all") end

function Cli.Links.headless(arg)
	local id = Cli.Split(arg)[1]
	if not ns.db or id == "" then return end
	local found
	for _, e in ipairs(run.resumeList or {}) do
		if e.id == id then found = e end
	end
	if not found then
		for _, e in ipairs(Cli.SessionEntries()) do
			if e.id == id then found = e end
		end
	end
	local e = Cli.EntryCopy(found or { id = id, name = id:sub(1, 8), cwd = "", agent = "" })
	e.kind, e.live, e.running, e.chat = "headless", false, false, nil
	Cli.AttachWith(e, { text = "", addDir = {}, flags = 1 })
end

function ClaudeWoW.PickRow(row)
	if type(row) ~= "table" or not ns.db then return end
	if row.more then
		ClaudeWoW.ShowResumePicker(nil, nil, true)
		return
	end
	if row.headless then
		Cli.Links.headless(row.headless)
		return
	end
	if type(row.entry) == "table" then Cli.AttachWith(Cli.EntryCopy(row.entry), { text = "", addDir = {}, flags = 1 }) end
end

function Cli.MatchEntries(entries, ref)
	local want = tostring(ref or ""):lower()
	local function alias(e) return tostring(e.alias or ""):lower() end
	local rules = {
		function(e) return e.id ~= "" and e.id:lower() == want end,
		function(e) return e.name:lower() == want end,
		function(e) return alias(e) ~= "" and alias(e) == want end,
		function(e) return #want >= 4 and e.id ~= "" and e.id:lower():sub(1, #want) == want end,
		function(e) return e.name:lower():sub(1, #want) == want end,
		function(e) return alias(e) ~= "" and alias(e):sub(1, #want) == want end,
	}
	for _, rule in ipairs(rules) do
		local hits = {}
		for _, e in ipairs(entries) do
			if rule(e) then table.insert(hits, e) end
		end
		if #hits > 0 then return hits end
	end
	return {}
end

function Cli.AttachTo(e)
	local c = e.chat and FindChat(e.chat) or nil
	if c then
		ClaudeWoW.SwitchChat(c.id)
		return c, false
	end
	if e.chat and (e.id or "") == "" then
		Cli.Say(ActiveChat(), "That chat is gone. /claude -r lists what is left.")
		return nil
	end
	local name = (e.name ~= "" and e.name or e.id:sub(1, 8)):sub(1, 24)
	c = AddChat(name, "")
	if not e.live and type(e.bridgeChat) == "string" and e.bridgeChat:match("^[%w]+$") and not FindChat(e.bridgeChat) then c.id = e.bridgeChat end
	c.plugin = ""
	c.agent = ""
	if e.live then
		c.liveTarget = e.id ~= "" and e.id or (e.alias or e.name)
		c.agent = "claude"
		c.cwd = e.cwd or ""
		Q.AddEvent(c, "Attached to " .. Display(e.name))
		AddHistory(
			c,
			"system",
			"Messages here go to that Claude Code session" .. (e.cwd ~= "" and (" in " .. Display(e.cwd)) or "") .. ", and its answers come back here."
		)
	else
		c.resumeId = e.id
		if e.agent and e.agent ~= "" then c.agent = e.agent end
		if e.plugin and e.plugin ~= "" and e.plugin ~= "claude-code" and e.plugin ~= LIVE_PLUGIN then
			c.plugin = e.plugin
		else
			c.cwd = e.cwd or ""
			c.adoptCwd = (e.cwd or "") == "" or nil
			c.adoptBind = true
		end
		Q.AddEvent(c, "Attached to session " .. e.id:sub(1, 8))
		AddHistory(
			c,
			"system",
			"Your next message resumes session "
				.. e.id
				.. ((e.cwd or "") ~= "" and (" in " .. Display(e.cwd)) or "")
				.. (e.unverified and " (the companion app looks the id up then)" or "")
				.. "."
		)
		if e.recap then AddHistory(c, "system", e.recap) end
	end
	ClaudeWoW.SwitchChat(c.id)
	ClaudeWoW.RenderChatList()
	return c, true
end

function Cli.NotListening(e, text)
	local c = ActiveChat()
	local lines = { Display(e.name) .. " is running in a terminal, but it was not started with the claude-wow channel, so it cannot hear the game." }
	if (e.restart or "") ~= "" then
		table.insert(lines, "Restart it in its terminal with:")
		table.insert(lines, e.restart)
	end
	if (e.id or "") ~= "" then table.insert(lines, "Or resume it headless here: click [resume headless] below.") end
	if (text or "") ~= "" then table.insert(lines, "Your message was not sent.") end
	Cli.Out(c, table.concat(lines, "\n"), true)
	if (e.id or "") ~= "" then
		local link = "|cff55ff55[resume headless]|r |cff888888continue " .. Display(e.name) .. " here without its terminal|r"
		c.history[#c.history].picker = { { text = link, headless = e.id } }
		ClaudeWoW.Render()
		ClaudeWoW.Print("|H" .. LINK_PREFIX .. "headless:" .. e.id .. "|h" .. link .. "|h")
	end
end

function Cli.ResolveResume(ref)
	local n = tonumber(ref)
	if n and n == math.floor(n) and n >= 1 then
		local list = run.resumeList or Cli.SessionEntries()
		if list[n] then return { list[n] } end
	end
	local hits = Cli.MatchEntries(Cli.SessionEntries(), ref)
	if #hits == 0 and ref:match("^[%x%-]+$") and #ref >= 8 then
		return { { kind = "headless", id = ref, name = ref:sub(1, 8), cwd = "", agent = "", at = 0, unverified = true } }
	end
	return hits
end

function Cli.AttachWith(e, o)
	if e.kind == "deaf" then
		Cli.NotListening(e, o.text)
		return
	end
	local c = Cli.AttachTo(e)
	if not c then return end
	if type(o.name) == "string" then
		c.name = o.name:sub(1, 24)
		Whisper.Retitle(c)
	end
	local notes, projectNote = Cli.ApplyChatFlags(c, o)
	if projectNote then Cli.Note(c, projectNote) end
	if #notes > 0 then Cli.Out(c, table.concat(notes, "\n")) end
	if o.text ~= "" then
		ClaudeWoW.Send(o.text, nil, { chat = c.id })
	else
		ClaudeWoW.Render()
		Cli.Show(c)
	end
end

function Cli.RunResume(o)
	if o.resume == true then
		ClaudeWoW.ShowResumePicker()
		return
	end
	if tostring(o.resume):lower() == "more" and o.text == "" then
		ClaudeWoW.ShowResumePicker(nil, nil, true)
		return
	end
	if tostring(o.resume):lower() == "all" and o.text == "" then
		Cli.ResumeAll()
		return
	end
	local hits = Cli.ResolveResume(o.resume)
	if #hits == 0 then
		Cli.Say(ActiveChat(), 'No chat or session matches "' .. Display(o.resume) .. '". /claude -r lists them.')
		return
	end
	if #hits > 1 then
		ClaudeWoW.ShowResumePicker(hits, '"' .. Display(o.resume) .. '" matches ' .. #hits .. " sessions: click one, or /claude -r <n>.", true)
		return
	end
	Cli.AttachWith(hits[1], o)
end

function Cli.ResumeAll()
	local from = ActiveChat()
	if ns.db.settings.mode == "pixel" and not (run.slotsExhausted or run.slotsMissing) then TryLoadSlot("manual") end
	local opened, busy, already = {}, {}, {}
	for _, e in ipairs(Cli.SessionEntries()) do
		if e.handoff then
			if e.running then
				table.insert(busy, e)
			elseif e.chat then
				table.insert(already, e)
			else
				local c = Cli.AttachTo(e)
				if c then table.insert(opened, c) end
			end
		end
	end
	if #opened + #busy + #already == 0 then
		Cli.Say(
			from,
			"No sessions were handed off. In a terminal, run: claude-wow handoff <repository path> --stop. Then /claude -r all again (the list can take a few seconds to reach the game)."
		)
		return
	end
	local lines = {}
	if #opened > 0 then
		local names = {}
		for _, c in ipairs(opened) do
			table.insert(names, c.name)
		end
		table.insert(
			lines,
			"Opened "
				.. #opened
				.. " chat"
				.. (#opened == 1 and "" or "s")
				.. " for the handed-off sessions: "
				.. table.concat(names, ", ")
				.. ". Each resumes its session with your first message there."
		)
	end
	if #already > 0 then table.insert(lines, #already .. " already had a chat.") end
	if #busy > 0 then
		local names = {}
		for _, e in ipairs(busy) do
			table.insert(names, Display(e.name))
		end
		table.insert(
			lines,
			"Still running in a terminal, so not opened (resuming both would fork them): "
				.. table.concat(names, ", ")
				.. ". Quit them, then /claude -r all again."
		)
	end
	Cli.Say(opened[#opened] or from, table.concat(lines, "\n"))
end

function ClaudeWoW.ResumePick(n)
	if not n or not ns.db then return end
	local e = (run.resumeList or Cli.SessionEntries())[n]
	if not e then return end
	Cli.RunResume({ resume = tostring(n), text = "", addDir = {}, flags = 1 })
end
