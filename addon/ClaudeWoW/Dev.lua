local D = { errors = {}, caught = 0 }
ClaudeWoWDev = D

local ERRORS_KEPT = 20
local MESSAGE_MAX = 400
local STACK_MAX = 600
local STACK_LINES = 4
local OWN_FILES = "AddOns[\\/]ClaudeWoW"
local ATTACHMENT_MAX = 1400
local ERRORS_SHOWN = 8

local function Now()
	return type(time) == "function" and time() or 0
end

local function StackHere()
	if type(debugstack) ~= "function" then return "" end
	local ok, stack = pcall(debugstack, 3, 12, 0)
	return ok and type(stack) == "string" and stack or ""
end

function D.Keep(message, stack)
	local text = tostring(message or "")
	stack = stack or ""
	if not (text:find(OWN_FILES) or stack:find(OWN_FILES)) then return false end
	D.caught = D.caught + 1
	local at = Now()
	for _, e in ipairs(D.errors) do
		if e.message == text:sub(1, MESSAGE_MAX) then
			e.count = e.count + 1
			e.last = at
			return true
		end
	end
	table.insert(D.errors, { message = text:sub(1, MESSAGE_MAX), stack = stack:sub(1, STACK_MAX), count = 1, first = at, last = at })
	while #D.errors > ERRORS_KEPT do table.remove(D.errors, 1) end
	return true
end

function D.Install()
	if D.installed or type(seterrorhandler) ~= "function" or type(geterrorhandler) ~= "function" then return false end
	local previous = geterrorhandler()
	local mine = function(message, ...)
		pcall(D.Keep, message, StackHere())
		if type(previous) == "function" then return previous(message, ...) end
	end
	pcall(seterrorhandler, mine)
	D.installed = geterrorhandler() == mine or nil
	D.blocked = not D.installed or nil
	return D.installed == true
end

local function BugGrabberErrors()
	local bg = _G.BugGrabber
	if type(bg) ~= "table" or type(bg.GetDB) ~= "function" then return {} end
	local ok, list = pcall(bg.GetDB, bg)
	if not ok or type(list) ~= "table" then return {} end
	local out = {}
	for _, e in ipairs(list) do
		if type(e) == "table" then
			local message, stack = tostring(e.message or ""), tostring(e.stack or "")
			if message:find(OWN_FILES) or stack:find(OWN_FILES) then
				out[#out + 1] = { message = message:sub(1, MESSAGE_MAX), stack = stack:sub(1, STACK_MAX), count = tonumber(e.counter) or 1 }
			end
		end
	end
	return out
end

function D.All()
	if #D.errors > 0 or not D.blocked then return D.errors end
	return BugGrabberErrors()
end

local function StackHead(stack)
	local lines = {}
	for line in tostring(stack or ""):gmatch("[^\n]+") do
		if #lines >= STACK_LINES then break end
		if line:find(OWN_FILES) then lines[#lines + 1] = "  " .. line:gsub("^.-AddOns[\\/]", "") end
	end
	return table.concat(lines, "\n")
end

local function Short(message)
	return (tostring(message or ""):gsub("^.-AddOns[\\/]", ""))
end

function D.Report()
	local list = D.All()
	if #list == 0 then
		if D.installed then return "No Lua error from Azeroth Companion this UI session." end
		if D.blocked then return "No Lua error caught: another addon keeps the error handler to itself, and it lists no Azeroth Companion error. /claude dev errors reads the game's own log." end
		return "No Lua error caught: this client has no seterrorhandler, so the addon cannot catch them. /claude dev errors reads the game's own log."
	end
	local lines = { #list .. " Lua error" .. (#list == 1 and "" or "s") .. " from Azeroth Companion this UI session" .. (list == D.errors and (" (" .. D.caught .. " in all)") or ", from BugGrabber") .. ", newest last:" }
	for i = math.max(1, #list - ERRORS_SHOWN + 1), #list do
		local e = list[i]
		lines[#lines + 1] = (e.count > 1 and ("x" .. e.count .. " ") or "") .. Short(e.message)
		local head = StackHead(e.stack)
		if head ~= "" then lines[#lines + 1] = head end
	end
	lines[#lines + 1] = "/claude dev errors sends them to the bridge with the game's own log; /claude bug <text> files them as a bug."
	return table.concat(lines, "\n")
end

function D.Attachment(max)
	max = max or ATTACHMENT_MAX
	local parts = {}
	local used = 0
	local list = D.All()
	for i = #list, 1, -1 do
		local e = list[i]
		local part = (e.count > 1 and ("x" .. e.count .. " ") or "") .. Short(e.message)
		local head = StackHead(e.stack)
		if head ~= "" then part = part .. "\n" .. head end
		if used + #part + 1 > max then break end
		table.insert(parts, 1, part)
		used = used + #part + 1
	end
	return table.concat(parts, "\n")
end

function D.State()
	local lines = {}
	local cw = _G.ClaudeWoW
	local loaded = cw and cw.Version and cw.Version.LOADED
	if loaded then lines[#lines + 1] = "addon " .. tostring(loaded.version or "?") .. (loaded.build and loaded.build ~= "" and (" build " .. tostring(loaded.build)) or "") end
	if type(GetBuildInfo) == "function" then
		local ok, version, build = pcall(GetBuildInfo)
		if ok then lines[#lines + 1] = "client " .. tostring(version) .. " (" .. tostring(build) .. ")" end
	end
	local db = _G.ClaudeWoWDB
	if type(db) == "table" and type(db.settings) == "table" then lines[#lines + 1] = "mode " .. tostring(db.settings.mode) .. ", whisper " .. tostring(db.settings.whisper) end
	return table.concat(lines, "; ")
end

D.Install()
