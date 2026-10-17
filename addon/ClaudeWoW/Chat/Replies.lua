local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Chat\\Replies.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q, Cli, Whisper = ns.run, ns.ui, ns.Q, ns.Cli, ns.Whisper
local DEFAULT_CWD, LIVE_PLUGIN = ns.DEFAULT_CWD, ns.LIVE_PLUGIN
local Flat, Link = ns.Flat, ns.Link
local FindChat, ActiveChat, AnyPending, AddHistory = ns.FindChat, ns.ActiveChat, ns.AnyPending, ns.AddHistory
local NotedBridge = ns.NotedBridge
local NoteUsage, ContextWarning = ns.NoteUsage, ns.ContextWarning

local Finish -- defined below

local MarkAcked = ns.MarkAcked
function Cli.KeepPlayerRoute(c)
	c.adoptBind, c.adoptCwd = nil, nil
end

function Cli.BindAdoptedPlugin(c, plugin)
	if not c.adoptBind then return false end
	if type(plugin) ~= "string" or #plugin > 32 or not plugin:match("^[%w_-]+$") then return false end
	if plugin == "claude-code" or plugin == LIVE_PLUGIN then return false end
	if (c.plugin or "") ~= "" then return false end
	c.plugin = plugin
	c.cwd = ""
	return true
end

-- Dispatch a list of reply records to the chats waiting for them.
local function ApplyReplies(replies)
	local matched = false
	for _, r in ipairs(replies or {}) do
		local c = (r.token == nil or r.token == ns.db.session) and FindChat(r.chat) or nil
		if c and c.titleFor and (tonumber(r.titleFor) or r.id) == c.titleFor and type(r.title) == "string" and r.title ~= "" then
			c.name = r.title
			c.titleFor = nil
			Whisper.Retitle(c)
		end
		if c and r.late == true then
			if r.status == "done" and r.id ~= c.pendingId and not Q.LateShown(c, Q.LateKey(r)) then
				Q.NoteLateShown(c, Q.LateKey(r))
				ClaudeWoW.LateReply(c, r)
				Q.OfferDraft(c)
			end
		elseif c and c.pendingId and r.id == c.pendingId then
			matched = true
			MarkAcked(r.id)
			local denied = type(r.denied) == "table" and #r.denied > 0 and r.denied or nil
			if (r.status == "done" or r.status == "error") and r.plugin ~= Cli.DEV_PLUGIN then
				NoteUsage(c, r)
				local bound = Cli.BindAdoptedPlugin(c, r.plugin)
				if not bound and c.adoptCwd and type(r.cwd) == "string" and r.cwd ~= "" then c.cwd = r.cwd end
				if type(r.session) == "string" and r.session ~= "" then c.session = r.session end
				Cli.KeepPlayerRoute(c)
				c.resumeId = nil
			end
			if r.status == "done" then
				if r.lateOk == true then Q.ArmLateWait(c, r.id, Q.LateIn(r.lateIn), true) end
				Finish(c, "assistant", r.text or "", denied, r.agent, r.summary, ClaudeWoW.CleanMacros(r.macros))
			elseif r.status == "error" then
				if r.lateOk == true then Q.ArmLateWait(c, r.id, 0) end
				Finish(c, "system", "The companion app could not finish: " .. tostring(r.text), denied)
			elseif r.status == "working" then
				if ClaudeWoWVoice then ClaudeWoWVoice.Started(r.id) end
				if c.progress ~= r.text then Q.NoteLife(c) end
				c.progress = r.text
				run.steps = run.steps or {}
				run.steps[c.id] = tonumber(r.steps)
				Whisper.Progress(c, r.text)
			end
		elseif c and c.gaveUp and r.id == c.gaveUp and (r.status == "done" or r.status == "error") then
			c.gaveUp = nil
			if run.staleSig then run.staleSig[r.id] = nil end
			if r.status == "done" then
				ClaudeWoW.LateReply(c, r)
				Q.OfferDraft(c)
			end
		end
	end
	return matched
end
ns.ApplyReplies = ApplyReplies

-- The bridge keeps every chat's transcript. After the client wipes our saved data,
-- it sends them back once, addressed to our new session token.
local function ImportRestore(r)
	if type(r) ~= "table" or r.token ~= ns.db.session or ClaudeWoWCharDB.restored then return end
	if type(r.char) == "string" and r.char ~= "" and r.char ~= Q.CharacterKey() then return end
	ClaudeWoWCharDB.restored = true
	local added = 0
	local current = ActiveChat()
	for _, rc in ipairs(r.chats or {}) do
		-- Skip chats deleted here that the bridge hasn't been told about yet.
		if type(rc) == "table" and rc.id and not FindChat(rc.id) and not ns.db.forget[rc.id] then
			local chat = {
				id = rc.id,
				name = (rc.name and rc.name ~= "") and rc.name or ("Chat " .. (#ns.db.chats + 1)),
				cwd = rc.cwd or DEFAULT_CWD,
				agent = "",
				plugin = type(rc.plugin) == "string" and rc.plugin or "",
				ctx = type(rc.ctx) == "number" and rc.ctx > 0 and rc.ctx or nil,
				turns = type(rc.turns) == "number" and rc.turns > 0 and rc.turns or nil,
				since = type(rc.since) == "number" and rc.since > 0 and rc.since or nil,
				cost = type(rc.cost) == "number" and rc.cost or nil,
				history = {},
				unread = 0,
				created = time(),
			}
			for _, m in ipairs(rc.messages or {}) do
				local role, agent = m.role, m.agent
				if role == "claude" then
					role, agent = "assistant", agent or "claude"
				end -- an older bridge's transcript
				if agent == "" then agent = nil end
				table.insert(chat.history, { role = role, text = m.text, id = m.id, t = m.t, agent = agent })
			end
			-- Keep the chat we're currently using last so it stays where it was.
			table.insert(ns.db.chats, math.max(1, #ns.db.chats), chat)
			added = added + 1
		end
	end
	run.restoring = nil
	if added > 0 then
		if current and #current.history <= 2 then
			for _, ch in ipairs(ns.db.chats) do
				if ch ~= current and ch.name == current.name then current.name = "New chat" end
			end
		end
		Q.AddEvent(current, "Restored " .. added .. " chat(s)")
		AddHistory(current, "system", "The game reset its saved data, so these came back from the companion app.")
		ClaudeWoW.RenderChatList()
	end
end
ns.ImportRestore = ImportRestore

local quietReplyHandlers = {}

function ClaudeWoW.OnQuietReply(plugin, handler) quietReplyHandlers[plugin] = handler end

local function FinishQuiet(chat, role, text)
	chat.pendingId = nil
	chat.progress = nil
	if run.act then run.act[chat.id] = nil end
	NotedBridge()
	if not AnyPending() then ClaudeWoW.DisarmReload() end
	local handler = quietReplyHandlers[chat.plugin]
	if handler then pcall(handler, chat, role, text) end
end

Finish = function(chat, role, text, denied, agent, summary, macros)
	if chat.quiet then return FinishQuiet(chat, role, text) end
	local msgId = chat.pendingId
	AddHistory(chat, role, text, msgId, denied, agent, macros, role == "assistant" and summary or nil)
	chat.pendingId = nil
	chat.progress = nil
	ContextWarning(chat)
	if run.act then run.act[chat.id] = nil end
	NotedBridge()
	local visible = ui.frame and ui.frame:IsShown() and ns.db.activeChat == chat.id
	if not AnyPending() then ClaudeWoW.DisarmReload() end
	if visible then Q.OfferDraft(chat) end
	if denied then Q.StampDenial(chat.id) end
	ClaudeWoW.Render()
	if denied and ClaudeWoW.LootRollEnabled() then ClaudeWoWRoll.Offer(chat.id) end
	local tabbed = ClaudeWoW.Notify(chat, text, agent, summary, role, denied, msgId, macros)
	Q.NoteUnread(chat, visible, tabbed)
	if not visible then Q.OfferDraft(chat) end
end

function Q.OfferDraft(chat)
	if chat.pendingId or not chat.draft or chat.draft == "" then return end
	if ui.frame and ui.frame:IsShown() and ns.db.activeChat == chat.id and ui.input then
		ui.input:SetText(chat.draft)
		chat.draft = nil
		return
	end
	Whisper.System(chat, "Waiting to go: " .. Flat(chat.draft) .. "  " .. Link("send", chat.id, "send it", "55ff55"), false, true)
end

function ClaudeWoW.LateReply(chat, r)
	local text = type(r.text) == "string" and r.text or ""
	local agent = type(r.agent) == "string" and r.agent ~= "" and r.agent or nil
	local w = run.lateWait and run.lateWait[chat.id]
	if w and w.id == r.id then run.lateWait[chat.id] = nil end
	AddHistory(chat, "assistant", text, r.id, nil, agent, nil, r.summary)
	local visible = ui.frame and ui.frame:IsShown() and ns.db.activeChat == chat.id
	ClaudeWoW.Render()
	local tabbed = ClaudeWoW.Notify(chat, text, agent, r.summary, "assistant", nil, r.id, nil)
	Q.NoteUnread(chat, visible, tabbed)
end

function Q.NoteUnread(chat, visible, tabbed)
	if visible or tabbed then return end
	chat.unread = (chat.unread or 0) + 1
	ClaudeWoW.Render()
end
ns.Finish = Finish
