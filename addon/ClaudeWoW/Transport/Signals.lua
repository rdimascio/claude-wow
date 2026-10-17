local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Transport\\Signals.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, ui, Q = ns.run, ns.ui, ns.Q
local FmtDur, Trim = ns.FmtDur, ns.Trim
local ActiveChat = ns.ActiveChat
local ScreenshotMode = ns.ScreenshotMode

local SLOT_COUNT = 200
local SLOT_PREFIX = "ClaudeWoW_S"
local ACT_MAX = 60 -- heartbeat files per message (act/NNN/01..60.wav)
local PRESENCE_MAX = 2000
local Presence = { RINGS = { "a", "b" }, STALL_SECONDS = 150, ROOT = "Interface\\AddOns\\ClaudeWoW_Runtime\\", LEGACY_ROOT = "Interface\\AddOns\\ClaudeWoW\\" }
Presence.root = Presence.ROOT
local POLL_SCHEDULE = { 5, 10, 16, 24, 34, 46, 60, 80, 100, 130, 160, 200, 240, 300 }
local POLL_TAIL = 60
local CONNECT_WAIT = 15 -- seconds the Connect button waits for the bridge before giving up
local IDLE_POLL_SECONDS = 600 -- without the sound channel, spend one slot this often while idle to check the bridge
ns.Presence, ns.SLOT_COUNT, ns.PRESENCE_MAX, ns.IDLE_POLL_SECONDS = Presence, SLOT_COUNT, PRESENCE_MAX, IDLE_POLL_SECONDS

local function SlotName(i) return string.format("%s%03d", SLOT_PREFIX, i) end

local function SlotNumber(id) return ((id - 1) % SLOT_COUNT) + 1 end
ns.SlotName, ns.SlotNumber = SlotName, SlotNumber

---------------------------------------------------------------------------
-- Signals and slots (in)
---------------------------------------------------------------------------

local signalAvailable = type(PlaySoundFile) == "function"
local signalStats = { checks = 0, hits = 0, lastHit = nil }
ns.signalStats = signalStats
function ns.SignalAvailable() return signalAvailable end

function Presence.Probe(path)
	if not signalAvailable or not ns.db.settings.signal then return nil end
	signalStats.checks = signalStats.checks + 1
	local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
	if not ok then
		signalAvailable = false
		signalStats.error = tostring(willPlay)
		return nil
	end
	if willPlay and handle then pcall(StopSound, handle) end
	if willPlay then
		signalStats.hits = signalStats.hits + 1
		signalStats.lastHit = GetTime()
	end
	return willPlay and true or false
end

local function SoundValid(path) return Presence.Probe(path) == true end

function Presence.Fired(path) return Presence.Probe(path) == false end

local function CheckSignal(kind, id)
	if run.signalUnreliable then return false end
	return Presence.Fired(string.format("%s%s\\%03d.wav", Presence.root, kind, SlotNumber(id)))
end

local function NoteStaleSignals(id)
	local rec = run.outbound[id]
	if not rec then return end
	rec.staleAck = CheckSignal("ack", id) or nil
	if CheckSignal("sig", id) then
		run.staleSig = run.staleSig or {}
		run.staleSig[id] = true
	end
end

local function FreshSignal(kind, id)
	if kind == "sig" and run.staleSig and run.staleSig[id] then return false end
	return CheckSignal(kind, id)
end

local function ActPath(id, k) return string.format("%sact\\%03d\\%02d.wav", Presence.root, SlotNumber(id), k) end

local function StartActivity(chat, id)
	local a = { next = 1, count = 0, startedAt = GetTime() }
	if Presence.Fired(ActPath(id, 1)) then a.unreliable = true end
	run.act = run.act or {}
	run.act[chat.id] = a
end

local function PollActivity(chat)
	local a = run.act and run.act[chat.id]
	if not a or a.unreliable or not chat.pendingId then return false end
	local moved = false
	for _ = 1, 3 do
		if a.next > ACT_MAX then break end
		if not Presence.Fired(ActPath(chat.pendingId, a.next)) then break end
		a.count = a.count + 1
		a.next = a.next + 1
		a.last = GetTime()
		moved = true
	end
	if moved then Q.NoteLife(chat) end
	return moved
end

function Q.ActivityAtLogin(chat)
	local a = { next = 1, count = 0, startedAt = GetTime() }
	while a.next <= ACT_MAX and Presence.Fired(ActPath(chat.pendingId, a.next)) do
		a.next, a.count = a.next + 1, a.count + 1
	end
	return a
end

local function NotedBridge(at)
	if run.replay then
		at = run.replay.at
		if not at then return end
	end
	at = at or GetTime()
	if not run.bridgeSeen or at > run.bridgeSeen then run.bridgeSeen = at end
	run.pixelFailed = nil
end

local function PresencePath(ring, k) return string.format("%spresence\\%s\\%04d.wav", Presence.root, ring, k) end

local function FindPresenceHead(ring, pathOf, max)
	local lo, hi = 1, (max or PRESENCE_MAX) + 1
	while lo < hi do
		local mid = math.floor((lo + hi) / 2)
		if SoundValid((pathOf or PresencePath)(ring, mid)) then
			hi = mid
		else
			lo = mid + 1
		end
	end
	return lo
end

function Presence.Channel() return signalAvailable and ns.db ~= nil and ns.db.settings.signal and true or false end

function Presence.State()
	if run.presence then return run.presence end
	local p = { heads = {}, loginHeads = {}, staleRing = {}, beats = 0, test = "pending" }
	for _, ring in ipairs(Presence.RINGS) do
		p.heads[ring] = FindPresenceHead(ring)
		p.loginHeads[ring] = p.heads[ring]
	end
	run.presence = p
	return p
end

function Presence.Passed(p, why)
	if p.test == "passed" then return end
	p.test = "passed"
	p.testWhy = why
	p.testAt = GetTime()
end

local function PollPresence(limit)
	if not Presence.Channel() then return end
	local p = Presence.State()
	for _, ring in ipairs(Presence.RINGS) do
		for _ = 1, limit or 3 do
			local k = p.heads[ring]
			if k > PRESENCE_MAX or not Presence.Fired(PresencePath(ring, k)) then break end
			p.heads[ring] = k + 1
			p.beats = p.beats + 1
			p.lastBeat = GetTime()
			Presence.Passed(p, "a launch-time file read missing after the bridge deleted it")
			NotedBridge()
		end
	end
end

Presence.NEWS_MAX = 500
Presence.NEWS_GAP_SECONDS = 30
Presence.NEWS_SLOT_RESERVE = 50

function Presence.NewsPath(ring, k) return string.format("%snews\\%s\\%04d.wav", Presence.root, ring, k) end

function Presence.News()
	if run.news then return run.news end
	local n = { heads = {}, fired = 0 }
	for _, ring in ipairs(Presence.RINGS) do
		n.heads[ring] = FindPresenceHead(ring, Presence.NewsPath, Presence.NEWS_MAX)
	end
	run.news = n
	return n
end

function Presence.PollNews(limit)
	if not Presence.Channel() then return false end
	local n = Presence.News()
	local fired = false
	for _, ring in ipairs(Presence.RINGS) do
		for _ = 1, limit or 3 do
			local k = n.heads[ring]
			if k > Presence.NEWS_MAX or not Presence.Fired(Presence.NewsPath(ring, k)) then break end
			n.heads[ring] = k + 1
			n.fired = n.fired + 1
			fired = true
		end
	end
	return fired
end

function Presence.FreeSlots()
	local free = 0
	for i = 1, SLOT_COUNT do
		if not C_AddOns.IsAddOnLoaded(SlotName(i)) then free = free + 1 end
	end
	return free
end

function Presence.Check(info, bridgeNow)
	if type(info) ~= "table" or type(info.ring) ~= "string" or type(info.at) ~= "number" then return end
	run.bridgePresence = info
	if not Presence.Channel() then return end
	local p = Presence.State()
	PollPresence(PRESENCE_MAX)
	local head = p.heads[info.ring]
	if not head then return end
	if head <= info.at then
		if p.test ~= "passed" then
			p.test = "failed"
			p.testWhy = "presence/" .. info.ring .. string.format("/%04d.wav", head) .. " still reads present after the bridge deleted it"
			p.testAt = GetTime()
		else
			p.staleRing[info.ring] = "a file the bridge deleted still reads present"
		end
	elseif head > PRESENCE_MAX and info.at < PRESENCE_MAX then
		p.staleRing[info.ring] = "the bridge beats on files this client did not see at launch"
	elseif
		p.test == "passed"
		and type(bridgeNow) == "number"
		and time() - bridgeNow < 90
		and GetTime() - (p.lastBeat or p.testAt or GetTime()) > Presence.STALL_SECONDS
	then
		p.staleRing[info.ring] = "the bridge is up but its beats stopped reaching this client"
	end
	if type(info.probe) == "string" and run.lateProbe and info.probe == run.lateProbe.token and run.lateProbe.result == nil then
		run.lateProbe.result = SoundValid(Presence.root .. "ctl\\probe-" .. info.probe .. ".wav") and "seen" or "unseen"
	end
end

local function PresenceWorks()
	if not Presence.Channel() then return false end
	local p = run.presence
	if not p or p.test ~= "passed" then return false end
	local current = run.bridgePresence and run.bridgePresence.ring
	if current and p.staleRing[current] then return false end
	for _, ring in ipairs(Presence.RINGS) do
		if p.heads[ring] <= PRESENCE_MAX and not p.staleRing[ring] then return true end
	end
	return false
end

ClaudeWoW.PresenceWorks = PresenceWorks
ClaudeWoW.Presence = Presence

function Presence.Scheme()
	if not Presence.Channel() then return "slot polls only (sound channel unusable)" end
	local p = run.presence
	if not p then return "not started" end
	if p.test == "failed" then return "slot polls only (self-test failed: " .. tostring(p.testWhy) .. ")" end
	if p.test ~= "passed" then
		local seen = false
		for _, ring in ipairs(Presence.RINGS) do
			if p.loginHeads[ring] <= PRESENCE_MAX then seen = true end
		end
		if not seen then return "slot polls only (no presence file existed when the game started: run setup, then restart WoW)" end
		return "slot polls until the self-test passes (pending: waiting for a bridge-driven deletion)"
	end
	if PresenceWorks() then return "beats (self-test passed: " .. tostring(p.testWhy) .. ")" end
	local current = run.bridgePresence and run.bridgePresence.ring
	local why = current and p.staleRing[current]
	return "slot polls only (self-test passed, but " .. (type(why) == "string" and why or "no presence ring this client can see is left") .. ": restart WoW)"
end

function Presence.Report()
	local out = {}
	local p = run.presence
	if p and (p.test == "passed" or p.test == "failed") then table.insert(out, "pt=" .. p.test) end
	if run.lateProbe and run.lateProbe.result then table.insert(out, "lc=" .. run.lateProbe.result) end
	return table.concat(out, ";")
end

local function PresenceWindows()
	if PresenceWorks() then return 90, 300 end
	return IDLE_POLL_SECONDS + 120, IDLE_POLL_SECONDS * 2 + 120
end

-- Returns state ("ok" | "stale" | "down" | "unknown"), a color and a description.
function ClaudeWoW.BridgeState()
	local seen = run.bridgeSeen
	if not seen then return "unknown", 0.6, 0.6, 0.6, "Companion app: not seen yet this session" end
	local age = GetTime() - seen
	local okFor, staleFor = PresenceWindows()
	if age < okFor then
		return "ok", 0.2, 0.9, 0.3, "Companion app: connected (seen " .. FmtDur(age) .. " ago)"
	elseif age < staleFor then
		return "stale", 0.95, 0.8, 0.2, "Companion app: last seen " .. FmtDur(age) .. " ago"
	end
	return "down", 0.9, 0.25, 0.25, "Companion app: not seen for " .. FmtDur(age) .. ". Is it running?"
end
ns.SoundValid, ns.CheckSignal, ns.NoteStaleSignals, ns.FreshSignal = SoundValid, CheckSignal, NoteStaleSignals, FreshSignal
ns.StartActivity, ns.PollActivity, ns.NotedBridge, ns.PollPresence = StartActivity, PollActivity, NotedBridge, PollPresence
ns.PresenceWorks, ns.PresenceWindows = PresenceWorks, PresenceWindows

-- Same icons the friends list uses for online / away / busy / offline.
local STATE_ICON = {
	ok = "Interface\\FriendsFrame\\StatusIcon-Online",
	stale = "Interface\\FriendsFrame\\StatusIcon-Away",
	down = "Interface\\FriendsFrame\\StatusIcon-DnD",
	unknown = "Interface\\FriendsFrame\\StatusIcon-Offline",
}

function ClaudeWoW.UpdateDot()
	local state, _, _, _, tip = ClaudeWoW.BridgeState()
	if run.pixelFailed then state = "down" end
	for _, dot in pairs({ ui.dot, ui.minimapDot }) do
		dot:SetTexture(STATE_ICON[state] or STATE_ICON.unknown)
		dot.tip = tip
	end
end

-- Connected = the bridge has been seen recently. In pixel mode, sending needs this;
-- until then the Connect button takes the Send button's place. The reload
-- transport has no idea whether the bridge is there, so it never gates.
function ClaudeWoW.IsConnected()
	if not ns.db or ns.db.settings.mode ~= "pixel" then return true end
	return ClaudeWoW.BridgeState() == "ok" and not run.pixelFailed
end

-- Connect button: say hello to the bridge (it acks, refreshes the slots and
-- offers a restore), ignoring SayHello's throttle so a click always does something.
-- `manual` is the button itself (Send calls this too, for a message typed while
-- disconnected): a deliberate click may take one screenshot even while shots
-- are paused; the automatic path never does, or a dark bridge would still get
-- a file per message typed.
function ClaudeWoW.Connect(manual)
	if ns.db.settings.mode ~= "pixel" then
		ns.SafeReload()
		return
	end
	run.lastHelloAt = nil
	run.pixelFailed = nil
	run.connectFailed = nil
	run.connectingAt = GetTime()
	if manual == true and ScreenshotMode() then run.shotOverride = true end
	ClaudeWoW.SayHello()
end

-- One word for the connection state, so Tick can tell when it changed.
local function ConnectionKey()
	if ClaudeWoW.IsConnected() then return "ok" end
	if run.connectingAt or Q.LoginConnecting() then return "connecting" end
	if run.connectFailed or (run.loginChecked and not run.bridgeSeen) then return "failed" end
	return ClaudeWoW.BridgeState()
end

function Q.LoginConnecting() return run.startedAt ~= nil and not run.loginChecked and not run.bridgeSeen and not run.pixelFailed end

function Q.ConnectionKey() return ConnectionKey() end

-- Called every tick: time out a Connect attempt, and redraw when the state flips
-- (light, button, status line, placeholder) without redrawing every tick.
function ClaudeWoW.CheckConnection()
	if run.connectingAt then
		if ClaudeWoW.IsConnected() then
			run.connectingAt, run.connectFailed = nil, nil
			-- A message typed while disconnected goes out now, without a second click,
			-- as long as the same chat is still in front and free.
			local queued = run.sendOnConnect
			run.sendOnConnect = nil
			local c = queued and ActiveChat()
			if c and c.id == queued.chat and not c.pendingId then
				if ui.input and Trim(ui.input:GetText() or "") == queued.text then ui.input:SetText("") end
				ClaudeWoW.Send(queued.text, queued.allow, queued.opts)
			end
		elseif GetTime() - run.connectingAt > CONNECT_WAIT then
			run.connectingAt, run.connectFailed = nil, true
			run.sendOnConnect = nil -- the text is still in the box
			run.shotOverride = nil -- an unused click does not carry over to a later shot
		end
	elseif run.connectFailed and ClaudeWoW.IsConnected() then
		run.connectFailed = nil
	end
	local key = ConnectionKey()
	if key ~= run.connKey then
		run.connKey = key
		ClaudeWoW.Render()
	end
end

-- Swap Send and Connect depending on the state; part of UpdateStatus.
function ClaudeWoW.UpdateConnect()
	if not ui.connect or not ui.send then return end
	local connected = ClaudeWoW.IsConnected()
	local c = ActiveChat()
	local busy = connected and c ~= nil and c.pendingId ~= nil
	ui.send:SetShown(connected)
	ui.send:SetEnabled(not busy)
	if ui.effort then ui.effort:SetShown(connected) end
	if ui.stop then ui.stop:SetShown(busy) end
	ui.connect:SetShown(not connected)
	if connected then return end
	if run.connectingAt then
		ui.connect:SetText("Connecting...")
		ui.connect:Disable()
	else
		ui.connect:SetText(ClaudeWoW.BridgeState() == "stale" and "Reconnect" or "Connect")
		ui.connect:Enable()
	end
end

-- Prove the sound-file trick actually distinguishes empty from valid files on this
-- client before trusting it for presence, heartbeats and readiness signals.
local function SelfTestSignals()
	if not signalAvailable then
		signalStats.selftest = "PlaySoundFile missing"
		return
	end
	Presence.root = Presence.ROOT
	local missingLooksValid = SoundValid(Presence.ROOT .. "ctl\\absent.wav")
	local validLooksValid = SoundValid(Presence.ROOT .. "ctl\\valid.wav")
	if not missingLooksValid and not validLooksValid and SoundValid(Presence.LEGACY_ROOT .. "ctl\\valid.wav") then
		Presence.root = Presence.LEGACY_ROOT
		validLooksValid = true
	end
	if missingLooksValid then
		signalAvailable = false
		signalStats.selftest = "a missing file reports as playable"
	elseif not validLooksValid then
		signalAvailable = false
		signalStats.selftest = "a valid file reports as unplayable (files not indexed? restart WoW)"
	else
		signalStats.selftest = "passed"
		Presence.State()
	end
end
ns.STATE_ICON, ns.ConnectionKey, ns.SelfTestSignals = STATE_ICON, ConnectionKey, SelfTestSignals

local function FreeSlot()
	for i = 1, SLOT_COUNT do
		local name = SlotName(i)
		if not C_AddOns.IsAddOnLoaded(name) then return name end
	end
end

local function ScheduleNextPoll()
	local idx = (run.polls or 0) + 1
	local t = POLL_SCHEDULE[idx]
	if not t then t = POLL_SCHEDULE[#POLL_SCHEDULE] + POLL_TAIL * (idx - #POLL_SCHEDULE) end
	run.nextPollAt = (run.sentAt or GetTime()) + t
end
ns.FreeSlot, ns.ScheduleNextPoll = FreeSlot, ScheduleNextPoll
