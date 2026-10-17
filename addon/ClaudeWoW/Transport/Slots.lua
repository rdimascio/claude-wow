local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Transport\\Slots.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Q, Cli, Whisper = ns.run, ns.Q, ns.Cli, ns.Whisper
local FmtDur, SEG = ns.FmtDur, ns.SEG
local FindChat, AnyPending = ns.FindChat, ns.AnyPending
local Presence, TellPlayer, RefreshStrip, ApplyTransport = ns.Presence, ns.TellPlayer, ns.RefreshStrip, ns.ApplyTransport
local FreeSlot, ScheduleNextPoll, NotedBridge, CheckSignal, FreshSignal = ns.FreeSlot, ns.ScheduleNextPoll, ns.NotedBridge, ns.CheckSignal, ns.FreshSignal

Q.RUN_LIMIT_DEFAULT = 30 * 60
Q.RUN_LIMIT_MIN = 60
Q.RUN_LIMIT_MAX = 7 * 86400
Q.PENDING_MARGIN = 5 * 60
Q.PENDING_LOGIN_GRACE = 120

function Q.QuietLimit() return (run.runLimit or Q.RUN_LIMIT_DEFAULT) + Q.PENDING_MARGIN end

function Q.NoteLife(c, at)
	if not c or not c.pendingId then return end
	local now = time()
	at = math.min(tonumber(at) or now, now)
	if not c.lifeAt or at > c.lifeAt then c.lifeAt = at end
end

function Q.LastLife(c)
	if type(c.lifeAt) == "number" then return c.lifeAt end
	local at = time()
	for i = #c.history, 1, -1 do
		local m = c.history[i]
		if m.id == c.pendingId and m.role == "user" then
			at = tonumber(m.t) or at
			break
		end
	end
	c.lifeAt = at
	return at
end

function Q.ApplyRuns(data)
	if type(data) ~= "table" then return end
	local limit = data.runLimit
	if type(limit) == "number" and limit == math.floor(limit) and limit >= Q.RUN_LIMIT_MIN and limit <= Q.RUN_LIMIT_MAX then run.runLimit = limit end
	if type(data.now) ~= "number" or time() - data.now > Q.INBOX_FRESH_SECONDS or type(data.alive) ~= "table" then return end
	for _, a in ipairs(data.alive) do
		local since = type(a) == "table" and type(a.since) == "number" and a.since or nil
		if since and since <= data.now and a.session == ns.db.session then
			for _, c in ipairs(ns.db.chats) do
				if c.pendingId == a.id then
					Q.NoteLife(c, since > 0 and since or data.now)
					Q.NoteRequestAcked(c.id, a.id)
				end
			end
		end
	end
end

-- The bridge has read this record: whatever game context rode on it is now
-- what the bridge knows, so later messages only carry it again if it changes.
function Q.NoteRequestSent(chatId, id)
	run.requests = run.requests or {}
	run.requests[chatId] = { id = id, sentAt = GetTime() }
end

function Q.NoteRequestAcked(chatId, id)
	local r = run.requests and run.requests[chatId]
	if r and r.id == id then r.acked = true end
end

function Q.NoteAckedId(id)
	for _, c in ipairs(ns.db.chats) do
		if c.pendingId == id then
			local r = run.requests and run.requests[c.id]
			if r and r.id == id and not r.acked then
				r.acked = true
				return true
			end
			return false
		end
	end
	return false
end

function Q.RestoreRequests()
	for _, c in ipairs(ns.db.chats) do
		if c.pendingId then Q.NoteRequestSent(c.id, c.pendingId) end
	end
end

function Q.PendingRequest(c)
	local r = run.requests and run.requests[c.id]
	if r and r.id == c.pendingId then return r end
	return nil
end

local function NoteAcked(rec)
	rec.acked = true
	if rec.request then Q.NoteRequestAcked(rec.chat, rec.request) end
	ClaudeWoW.ChatLog.Acked(rec)
	if rec.ctx ~= nil then run.contextSent = rec.ctx end
	if not (rec.hello or rec.forget or rec.cancelOf or rec.dm or rec.openUrl) then Q.NoteLife((FindChat(rec.chat))) end
end

local function MarkAcked(id)
	local rec = run.outbound[id]
	if rec and not rec.acked then
		NoteAcked(rec)
		RefreshStrip()
	end
	NotedBridge()
end

function ClaudeWoW.ApplyAcks(acks)
	if type(acks) ~= "table" or not ns.db then return false end
	local any = false
	for _, a in ipairs(acks) do
		local ours = type(a) == "table" and a.session == ns.db.session
		local rec = ours and run.outbound[a.id]
		if rec and not rec.acked then
			NoteAcked(rec)
			any = true
		end
		if ours and Q.NoteAckedId(a.id) then any = true end
	end
	if any then NotedBridge() end
	return any
end

Q.LATE_SHOWN_MAX = 8
Q.LATE_IN_MAX = 3600

function Q.LateKey(r)
	local seq = r.lateSeq
	if type(seq) == "number" and seq > 0 and seq == math.floor(seq) then return seq end
	return tonumber(r.id) or 0
end

function Q.LateShown(c, key)
	if c.lateSeen ~= nil then
		c.lateShown = { tonumber(c.lateSeen) or 0 }
		c.lateSeen = nil
	end
	for _, k in ipairs(c.lateShown or {}) do
		if k == key then return true end
	end
	return false
end

function Q.NoteLateShown(c, key)
	c.lateShown = c.lateShown or {}
	table.insert(c.lateShown, key)
	while #c.lateShown > Q.LATE_SHOWN_MAX do
		table.remove(c.lateShown, 1)
	end
end

function Q.LateIn(v)
	if type(v) == "number" and v >= 0 and v <= Q.LATE_IN_MAX and v == math.floor(v) then return v end
	return 0
end

function Q.ArmLateWait(c, id, after, prompt)
	run.lateWait = run.lateWait or {}
	run.lateWait[c.id] = { id = id, since = GetTime() + after, step = 1, prompt = prompt or nil }
end

function Q.EndPromptWait(c)
	local w = run.lateWait and run.lateWait[c.id]
	if w and w.prompt then run.lateWait[c.id] = nil end
end
ns.NoteAcked, ns.MarkAcked = NoteAcked, MarkAcked

ClaudeWoW.Version = { PROTO = 1, SEMVER = "0.5.0-beta.1", PATTERN = "^%d+%.%d+%.%d+[%w%.%-+]*$" }

function ClaudeWoW.Version.Meta(key)
	local read = C_AddOns and C_AddOns.GetAddOnMetadata
	if type(read) ~= "function" then return "" end
	local ok, v = pcall(read, "ClaudeWoW", key)
	return ok and type(v) == "string" and v or ""
end

function ClaudeWoW.Version.Own()
	local V = ClaudeWoW.Version
	local v = V.Meta("Version")
	if #v <= 40 and v:match(V.PATTERN) then return v end
	return V.SEMVER
end

ClaudeWoW.Version.LOADED = { version = ClaudeWoW.Version.Meta("Version"), build = ClaudeWoW.Version.Meta("X-Build"), at = time() }

function ClaudeWoW.Version.ApplyDisk(d, stamp)
	local V = ClaudeWoW.Version
	if type(d) ~= "table" then return end
	local at = tonumber(stamp)
	if not at or time() - at > Q.INBOX_FRESH_SECONDS then return end
	V.CheckFolders()
	if at < V.LOADED.at then return end
	if type(d.version) ~= "string" or #d.version > 40 or not d.version:match(V.PATTERN) then return end
	local build = type(d.build) == "string" and #d.build == 12 and d.build:match("^[0-9a-f]+$") and d.build or ""
	local fileHash = type(d.fileHash) == "string" and #d.fileHash == 8 and d.fileHash:match("^[0-9a-f]+$") and d.fileHash or ""
	run.addonDisk = { version = d.version, build = build, fileHash = fileHash }
	local L = V.LOADED
	local sameFiles = fileHash == "" or fileHash == ns.FileHash()
	if L.version == "" or (d.version == L.version and build == L.build and sameFiles) then
		if run.updateReady then
			run.updateReady, run.reloadTold = nil, nil
			Q.UpdateNoticeBar()
		end
		return
	end
	local restart = not sameFiles and not Q.IsClassicEra()
	local text = "New addon files are installed ("
		.. d.version
		.. (build ~= "" and (", build " .. build) or "")
		.. "). "
		.. (restart and V.RESTART_TEXT or V.RELOAD_TEXT)
	if run.reloadTold ~= text then
		run.reloadTold = text
		run.updateReady = { version = d.version, build = build, sameVersion = d.version == L.version, restart = restart }
		Q.Notify(text)
		Q.UpdateNoticeBar()
	end
end

ClaudeWoW.Version.RELOAD_TEXT = "Type /reload to load them."
ClaudeWoW.Version.RESTART_TEXT = "Fully quit and restart the game to load the new addon files; /reload is not enough."

function ClaudeWoW.Version.Notice()
	local u = run.updateReady
	if not u then return nil end
	local head = "Addon update ready " .. SEG.DOT .. " " .. u.version .. ((u.sameVersion and u.build ~= "") and (" build " .. u.build) or "")
	if u.restart then return head .. " " .. SEG.DOT .. " " .. ClaudeWoW.Version.RESTART_TEXT end
	return head
end

ClaudeWoW.Version.CLIENTS_MAX = 8

function ClaudeWoW.Version.ApplyClients(list, stamp)
	local V = ClaudeWoW.Version
	if type(list) ~= "table" then return end
	local at = tonumber(stamp)
	if not at or time() - at > Q.INBOX_FRESH_SECONDS then return end
	local out = {}
	for i = 1, math.min(#list, V.CLIENTS_MAX) do
		local c = list[i]
		if type(c) == "table" and type(c.name) == "string" and #c.name <= 40 and c.name:match("^[%w_ %.%-]+$") then
			local heard = tonumber(c.heard)
			table.insert(out, {
				name = c.name,
				version = type(c.version) == "string" and #c.version <= 40 and c.version:match(V.PATTERN) and c.version or "",
				build = type(c.build) == "string" and #c.build == 12 and c.build:match("^[0-9a-f]+$") and c.build or "",
				heard = heard and heard > 0 and heard == math.floor(heard) and heard or 0,
				here = c.here == true,
				last = c.last == true,
			})
		end
	end
	run.bridgeClients = out
end

function ClaudeWoW.Version.ClientsStatus()
	local list = run.bridgeClients
	if not list then return "clients: not reported (an older bridge, or not heard yet)" end
	if #list == 0 then return "clients: none in the bridge's config.json" end
	local parts = {}
	for _, c in ipairs(list) do
		local files = c.version ~= "" and (c.version .. (c.build ~= "" and (" build " .. c.build) or "")) or "no addon installed"
		local heard = c.heard > 0 and ("heard " .. FmtDur(math.max(0, time() - c.heard)) .. " ago") or "not heard yet"
		table.insert(parts, c.name .. (c.here and " (this client)" or "") .. ": " .. files .. ", " .. heard .. (c.last and ", spoke last" or ""))
	end
	return "clients: " .. table.concat(parts, "; ")
end

function ClaudeWoW.Version.CheckFolders()
	local info = C_AddOns and C_AddOns.GetAddOnInfo
	if run.restartTold or type(info) ~= "function" then return end
	local ok, _, _, _, _, reason = pcall(info, "ClaudeWoW_Runtime")
	if ok and reason == "MISSING" then
		run.restartTold = true
		TellPlayer("The ClaudeWoW_Runtime addon was installed after the game started. Fully quit and restart the game to load it; /reload is not enough.")
	end
end

function ClaudeWoW.Version.Compare(a, b)
	local a1, a2, a3 = tostring(a):match("^(%d+)%.(%d+)%.(%d+)")
	local b1, b2, b3 = tostring(b):match("^(%d+)%.(%d+)%.(%d+)")
	if not a1 or not b1 then return nil end
	local x = { tonumber(a1), tonumber(a2), tonumber(a3) }
	local y = { tonumber(b1), tonumber(b2), tonumber(b3) }
	for i = 1, 3 do
		if x[i] ~= y[i] then return x[i] < y[i] and -1 or 1 end
	end
	return 0
end

function ClaudeWoW.Version.Verdict(b)
	local V = ClaudeWoW.Version
	local version = V.Own()
	local range = b.protoMin == b.protoMax and tostring(b.protoMin) or (b.protoMin .. " to " .. b.protoMax)
	local mine = version .. ", protocol " .. V.PROTO
	local theirs = b.version .. ", protocol " .. range
	if V.PROTO < b.protoMin then
		return "update-addon",
			"This addon ("
				.. mine
				.. ") is too old for the companion app ("
				.. theirs
				.. "). The companion app refuses messages until you update the addon: update the addon in the CurseForge app or run claude-wow setup, then type /reload."
	end
	if V.PROTO > b.protoMax then
		return "update-bridge",
			"The companion app ("
				.. theirs
				.. ") is too old for this addon ("
				.. mine
				.. "). It refuses messages until you update it: run brew upgrade claude-wow or the installer again, then claude-wow service restart."
	end
	if version == b.version then return "equal", "" end
	local order = V.Compare(version, b.version)
	if order == -1 then
		return "addon-older",
			"This addon (" .. version .. ") is older than the companion app (" .. b.version .. "). They still work together; update the addon when you can."
	end
	if order == 1 then
		return "bridge-older",
			"The companion app ("
				.. b.version
				.. ") is older than this addon ("
				.. version
				.. "). They still work together; update the companion app when you can."
	end
	return "differs", "This addon (" .. version .. ") and the companion app (" .. b.version .. ") are different builds. They still work together."
end

function ClaudeWoW.Version.Apply(b, stamp)
	local V = ClaudeWoW.Version
	if type(b) ~= "table" then return end
	local at = tonumber(stamp)
	if not at or time() - at > Q.INBOX_FRESH_SECONDS then return end
	local lo, hi = tonumber(b.protoMin), tonumber(b.protoMax)
	if type(b.version) ~= "string" or #b.version > 40 or not b.version:match(V.PATTERN) then return end
	if not lo or not hi or lo ~= math.floor(lo) or hi ~= math.floor(hi) or lo < 1 or hi < lo then return end
	run.bridgeVersion = { version = b.version, protoMin = lo, protoMax = hi }
	local verdict, text = V.Verdict(run.bridgeVersion)
	run.versionVerdict = verdict
	if text ~= "" and run.versionTold ~= text then
		run.versionTold = text
		TellPlayer(text)
	end
end

function ClaudeWoW.Version.Status()
	local V = ClaudeWoW.Version
	local b = run.bridgeVersion
	local bridge = b and (b.version .. " (protocol " .. (b.protoMin == b.protoMax and b.protoMin or (b.protoMin .. " to " .. b.protoMax)) .. ")")
		or "not reported (an older bridge, or not heard yet)"
	local function files(f) return f.version ~= "" and (f.version .. (f.build ~= "" and (" build " .. f.build) or "")) or "unknown" end
	return "versions: addon "
		.. V.Own()
		.. " (protocol "
		.. V.PROTO
		.. "), bridge "
		.. bridge
		.. ", verdict: "
		.. (run.versionVerdict or "unknown")
		.. "; addon files loaded: "
		.. files(V.LOADED)
		.. ", on disk: "
		.. (run.addonDisk and files(run.addonDisk) or "not reported")
end

local function TryLoadSlot(why)
	local name = FreeSlot()
	if not name then
		run.slotsExhausted = true
		ClaudeWoW.ArmAutoRefresh()
		ClaudeWoW.UpdateStatus()
		return
	end
	ClaudeWoW_SlotData = nil
	local loaded, reason = C_AddOns.LoadAddOn(name)
	if not loaded then
		run.slotError = reason
		run.slotsMissing = true
		ClaudeWoW.ArmAutoRefresh()
		if reason ~= "MISSING" and reason ~= "DISABLED" and not run.slotErrorTold then
			run.slotErrorTold = true
			local build = select(4, GetBuildInfo())
			local fix = reason == "INTERFACE_VERSION"
					and ("the slot addons were made for another game version (this client is " .. tostring(build) .. "). Set tocInterface to " .. tostring(
						build
					) .. ' in the companion app\'s config.json, run "npm run slots", then restart WoW.')
				or 'run "npm run slots" on the computer that runs the companion app, then restart WoW.'
			TellPlayer("reply slots do not load (" .. tostring(reason) .. "): " .. fix .. " Until then replies arrive on /reload.")
		end
		ClaudeWoW.UpdateStatus()
		return
	end
	run.polls = (run.polls or 0) + 1
	ScheduleNextPoll()
	local data = ClaudeWoW_SlotData
	if type(data) == "table" and type(data.now) == "number" then
		-- The bridge's clock and ours are the same machine; translate to GetTime().
		NotedBridge(GetTime() - (time() - data.now))
	end
	if type(data) == "table" and type(data.cwd) == "string" and data.cwd ~= "" then run.bridgeCwd = data.cwd end
	if type(data) == "table" then
		if data.cancel == true then run.bridgeCancel = true end
		run.bridgeOpenUrl = data.openUrl == true
		if type(data.agent) == "string" and data.agent ~= "" then run.bridgeAgent = data.agent end
		if type(data.agents) == "table" and #data.agents > 0 then run.bridgeAgents = data.agents end
		if type(data.plugin) == "string" and data.plugin ~= "" then run.bridgePlugin = data.plugin end
		if type(data.plugins) == "table" and #data.plugins > 0 then run.bridgePlugins = data.plugins end
		ClaudeWoW.ApplyEfforts(data)
		ClaudeWoW.ApplyLive(data.live)
		ClaudeWoW.ApplySessions(data.sessions, data.now)
		ClaudeWoW.ApplyProjects(data.projects, data.home)
		ClaudeWoW.ApplySkills(data.skills)
		run.bridgeDiscord = data.discord == true
		ClaudeWoW.ApplyMirror(data.mirror)
		ClaudeWoW.ApplyMcp(data.mcp)
		ClaudeWoW.ApplyContract(data.contract)
		local acked = ClaudeWoW.ApplyAcks(data.acks)
		Q.ApplyOpenResults(data.acks)
		ApplyTransport(data)
		if acked then RefreshStrip() end
		Presence.Check(data.presence, data.now)
		ClaudeWoW.Version.Apply(data.bridge, data.now)
		ClaudeWoW.Version.ApplyDisk(data.addonDisk, data.now)
		ClaudeWoW.Version.ApplyClients(data.clients, data.now)
		Q.ApplyRuns(data)
	end
	local matched = ns.ApplyReplies(type(data) == "table" and data.replies or nil)
	if type(data) == "table" and data.restore then ns.ImportRestore(data.restore) end
	if type(data) == "table" and data.map and ClaudeWoWMap then ClaudeWoWMap.Sync(data.map) end
	if type(data) == "table" and data.achievements and ClaudeWoWAchievements then ClaudeWoWAchievements.Sync(data.achievements, data.now) end
	if type(data) == "table" and data.goals and ClaudeWoWOrders then ClaudeWoWOrders.SyncSlot(data.goals, data.now) end
	if type(data) == "table" and type(data.dm) == "table" then
		run.bridgeDm = true
		if ClaudeWoWDM then ClaudeWoWDM.SyncSlot(data.dm) end
	end
	if type(data) == "table" and data.widgets and ClaudeWoWWidgets then ClaudeWoWWidgets.Sync(data.widgets) end
	if type(data) == "table" and ClaudeWoWTelemetry then ClaudeWoWTelemetry.Sync(data.gs) end
	if why == "signal" and not matched then run.signalUnreliable = true end
	ClaudeWoW.Render()
end

local LATE_POLLS = { 10, 20, 30, 45, 60, 90, 120, 180, 240, 300 }

local function PollLate(now)
	for chatId, w in pairs(run.lateWait or {}) do
		local due = LATE_POLLS[w.step]
		if not due or not FindChat(chatId) then
			run.lateWait[chatId] = nil
		elseif now - w.since >= due then
			w.step = w.step + 1
			TryLoadSlot("late")
			return
		end
	end
end

function Q.GiveUp(c)
	local id = c.pendingId
	Whisper.StopProgress(c)
	run.outbound[id] = nil
	if run.act then run.act[c.id] = nil end
	c.pendingId, c.progress, c.lifeAt = nil, nil, nil
	RefreshStrip()
	if not AnyPending() then ClaudeWoW.DisarmReload() end
	if c.quiet then return ClaudeWoW.Render() end
	c.gaveUp = id
	Cli.Out(
		c,
		"No reply arrived and nothing was heard about it for "
			.. math.floor(Q.QuietLimit() / 60)
			.. " minutes, so this chat is free again. If the reply comes later it still shows here. Send the message again, or ask for the last answer."
	)
	Q.OfferDraft(c)
end

function Q.NoteLogin(isInitialLogin)
	if isInitialLogin == true then ns.db.graceUntil = time() + Q.PENDING_LOGIN_GRACE end
end

function Q.GiveUpSilent()
	local now = time()
	if now < (tonumber(ns.db.graceUntil) or 0) then return end
	local limit = Q.QuietLimit()
	for _, c in ipairs(ns.db.chats) do
		if c.pendingId and now - Q.LastLife(c) > limit then Q.GiveUp(c) end
	end
end

function Q.LateSignal()
	for _, c in ipairs(ns.db.chats) do
		local id = c.gaveUp
		if id and run.staleSig and run.staleSig[id] and not CheckSignal("sig", id) then run.staleSig[id] = nil end
		if id and FreshSignal("sig", id) then
			run.staleSig = run.staleSig or {}
			run.staleSig[id] = true
			TryLoadSlot("late")
			return true
		end
	end
	return false
end
ns.TryLoadSlot, ns.PollLate = TryLoadSlot, PollLate

-- Pull whatever bridge.js last wrote into Inbox.lua (the reload path).
local ApplyInbox

local function ProcessInbox()
	local inbox = ClaudeWoW_Inbox
	if type(inbox) ~= "table" then return end
	local stamp = tonumber(inbox.now)
	run.replay = { at = stamp and GetTime() - math.max(0, time() - stamp) or nil }
	local ok, err = pcall(ApplyInbox, inbox)
	run.replay = nil
	if not ok then error(err, 0) end
end

ApplyInbox = function(inbox)
	if type(inbox.cwd) == "string" and inbox.cwd ~= "" then run.bridgeCwd = inbox.cwd end
	if inbox.cancel == true then run.bridgeCancel = true end
	local inboxStamp = tonumber(inbox.now)
	if inboxStamp and time() - inboxStamp <= Q.INBOX_FRESH_SECONDS then run.bridgeOpenUrl = inbox.openUrl == true end
	if type(inbox.agent) == "string" and inbox.agent ~= "" then run.bridgeAgent = inbox.agent end
	if type(inbox.agents) == "table" and #inbox.agents > 0 then run.bridgeAgents = inbox.agents end
	if type(inbox.plugin) == "string" and inbox.plugin ~= "" then run.bridgePlugin = inbox.plugin end
	if type(inbox.plugins) == "table" and #inbox.plugins > 0 then run.bridgePlugins = inbox.plugins end
	ClaudeWoW.ApplyEfforts(inbox)
	ClaudeWoW.ApplyLive(inbox.live)
	ClaudeWoW.ApplySessions(inbox.sessions, inbox.now)
	ClaudeWoW.ApplyProjects(inbox.projects, inbox.home)
	ClaudeWoW.ApplySkills(inbox.skills)
	run.bridgeDiscord = inbox.discord == true
	ClaudeWoW.ApplyMirror(inbox.mirror)
	ClaudeWoW.ApplyMcp((tonumber(inbox.now) or 0) >= time() - Q.INBOX_FRESH_SECONDS and inbox.mcp or nil)
	ClaudeWoW.ApplyContract((tonumber(inbox.now) or 0) >= time() - Q.INBOX_FRESH_SECONDS and inbox.contract or nil)
	ApplyTransport(inbox)
	ClaudeWoW.Version.Apply(inbox.bridge, inbox.now)
	ClaudeWoW.Version.ApplyDisk(inbox.addonDisk, inbox.now)
	ClaudeWoW.Version.ApplyClients(inbox.clients, inbox.now)
	Q.ApplyRuns(inbox)
	ns.ApplyReplies(inbox.replies)
	if inbox.restore then ns.ImportRestore(inbox.restore) end
	if inbox.map and ClaudeWoWMap then ClaudeWoWMap.Sync(inbox.map) end
	if inbox.achievements and ClaudeWoWAchievements then ClaudeWoWAchievements.Sync(inbox.achievements, inbox.now) end
	if inbox.goals and ClaudeWoWOrders then ClaudeWoWOrders.SyncInbox(inbox.goals, inbox.now) end
	if type(inbox.dm) == "table" then
		local stamp = tonumber(inbox.now)
		if stamp and time() - stamp <= Q.INBOX_FRESH_SECONDS then run.bridgeDm = true end
		if ClaudeWoWDM then ClaudeWoWDM.SyncInbox(inbox.dm) end
	end
	if inbox.widgets and ClaudeWoWWidgets then ClaudeWoWWidgets.Sync(inbox.widgets) end
	if ClaudeWoWTelemetry then ClaudeWoWTelemetry.SyncInbox(inbox.gs, inbox.now) end
end
ns.ProcessInbox = ProcessInbox
