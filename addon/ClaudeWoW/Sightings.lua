local ADDON_NAME = ...
local S = {}
ClaudeWoWSightings = S

S.EXACT_ROLES = {
	GOSSIP_SHOW = "gossip",
	MERCHANT_SHOW = "vendor",
	TRAINER_SHOW = "trainer",
	QUEST_GREETING = "quest",
	QUEST_DETAIL = "quest",
	QUEST_PROGRESS = "quest",
	QUEST_COMPLETE = "quest",
	TAXIMAP_OPENED = "flight",
	BANKFRAME_OPENED = "bank",
	AUCTION_HOUSE_SHOW = "auction",
	PET_STABLE_SHOW = "stable",
}
S.NEAR_UNITS = { PLAYER_TARGET_CHANGED = "target", UPDATE_MOUSEOVER_UNIT = "mouseover" }
S.NPC_GUID_TYPES = { Creature = true, Vehicle = true }
S.CONTEXT_MAX = 4
S.CONTEXT_NAME_MAX = 24
S.PERCENT = 100
S.MAX_NPCS = 2000

local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d = pcall(fn, ...)
	if ok then return a, b, c, d end
end

function S.DB()
	ClaudeWoWNpcDB = type(ClaudeWoWNpcDB) == "table" and ClaudeWoWNpcDB or {}
	local db = ClaudeWoWNpcDB
	db.npcs = db.npcs or {}
	db.flights = db.flights or {}
	return db
end

function S.PlayerSpot()
	if not C_Map then return nil end
	local mapId = Try(C_Map.GetBestMapForUnit, "player")
	if type(mapId) ~= "number" then return nil end
	local pos = Try(C_Map.GetPlayerMapPosition, mapId, "player")
	if type(pos) ~= "table" or type(pos.x) ~= "number" or type(pos.y) ~= "number" then return nil end
	if pos.x == 0 and pos.y == 0 then return nil end
	return mapId, pos.x * S.PERCENT, pos.y * S.PERCENT
end

function S.NpcId(guid)
	if type(guid) ~= "string" then return nil end
	local kind, _, _, _, _, id = strsplit("-", guid)
	if not S.NPC_GUID_TYPES[kind] then return nil end
	return tonumber(id)
end

function S.Skip(unit)
	return (Try(UnitCanAttack, "player", unit) or Try(UnitPlayerControlled, unit)) and true or false
end

function S.LastSeen(npc)
	local latest = 0
	for _, spot in pairs(npc.spots) do latest = math.max(latest, spot.seen or 0) end
	return latest
end

function S.Prune(npcs)
	local ids = {}
	for id in pairs(npcs) do table.insert(ids, id) end
	if #ids <= S.MAX_NPCS then return end
	table.sort(ids, function(a, b) return S.LastSeen(npcs[a]) < S.LastSeen(npcs[b]) end)
	for i = 1, #ids - S.MAX_NPCS do npcs[ids[i]] = nil end
end

function S.Record(unit, role)
	local id = S.NpcId(Try(UnitGUID, unit))
	if not id then return nil end
	if role == nil and S.Skip(unit) then return nil end
	local name = Try(UnitName, unit)
	if type(name) ~= "string" or name == "" then return nil end
	local mapId, x, y = S.PlayerSpot()
	if not mapId then return nil end
	local npcs = S.DB().npcs
	local isNew = npcs[id] == nil
	local npc = npcs[id] or { spots = {} }
	npcs[id] = npc
	npc.name = name
	local spot = npc.spots[mapId]
	local exact = role ~= nil
	if spot and spot.exact and not exact then return spot end
	spot = { x = math.floor(x * 10 + 0.5) / 10, y = math.floor(y * 10 + 0.5) / 10, exact = exact or nil, role = role or (spot and spot.role), seen = time() }
	npc.spots[mapId] = spot
	if isNew then S.Prune(npcs) end
	return spot
end

function S.RecordFlights()
	if not (C_TaxiMap and C_TaxiMap.GetAllTaxiNodes) then return end
	local mapId = Try(GetTaxiMapID)
	if type(mapId) ~= "number" then return end
	local nodes = Try(C_TaxiMap.GetAllTaxiNodes, mapId)
	if type(nodes) ~= "table" then return end
	local flights = {}
	for _, node in ipairs(nodes) do
		if type(node.name) == "string" and type(node.position) == "table" and node.position.x then
			flights[node.name] = { x = math.floor(node.position.x * S.PERCENT * 10 + 0.5) / 10, y = math.floor(node.position.y * S.PERCENT * 10 + 0.5) / 10 }
		end
	end
	S.DB().flights[mapId] = flights
end

function S.Nearby(mapId, px, py, limit)
	local out = {}
	for _, npc in pairs(S.DB().npcs) do
		local spot = npc.spots[mapId]
		if spot then
			local d = (spot.x - px) ^ 2 + (spot.y - py) ^ 2
			table.insert(out, { name = npc.name, x = spot.x, y = spot.y, exact = spot.exact, d = d })
		end
	end
	table.sort(out, function(a, b)
		if (a.exact and true or false) ~= (b.exact and true or false) then return a.exact and true or false end
		return a.d < b.d
	end)
	for i = (limit or #out) + 1, #out do out[i] = nil end
	return out
end

function S.ContextLine(mapId, px, py)
	if type(mapId) ~= "number" or not px then return nil end
	local near = S.Nearby(mapId, px, py, S.CONTEXT_MAX)
	if #near == 0 then return nil end
	local parts = {}
	for _, n in ipairs(near) do
		table.insert(parts, string.format("%s %.1f,%.1f%s", n.name:sub(1, S.CONTEXT_NAME_MAX), n.x, n.y, n.exact and "" or "~"))
	end
	return "NPCs seen on this map (talked-to first, then closest; ~ = approximate): " .. table.concat(parts, "; ")
end

local events = CreateFrame("Frame")
for event in pairs(S.EXACT_ROLES) do events:RegisterEvent(event) end
for event in pairs(S.NEAR_UNITS) do events:RegisterEvent(event) end
events:RegisterEvent("NAME_PLATE_UNIT_ADDED")
events:RegisterEvent("ADDON_LOADED")
events:SetScript("OnEvent", function(_, event, arg1)
	if event == "ADDON_LOADED" then
		if arg1 == ADDON_NAME then S.DB() end
		return
	end
	local role = S.EXACT_ROLES[event]
	if role then
		S.Record("npc", role)
		if event == "TAXIMAP_OPENED" then S.RecordFlights() end
	elseif event == "NAME_PLATE_UNIT_ADDED" then
		S.Record(arg1)
	elseif S.NEAR_UNITS[event] then
		S.Record(S.NEAR_UNITS[event])
	end
end)
