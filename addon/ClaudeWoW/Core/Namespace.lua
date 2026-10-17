local ADDON_NAME, ns = ...

ns.files = {}
ns.files[#ns.files + 1] = "Core\\Namespace.lua"

ns.ADDON_NAME = ADDON_NAME
ns.PRODUCT = "Azeroth Companion"
ns.PREFIX = "|cff66ccff[" .. ns.PRODUCT .. "]|r "
ns.LINK_PREFIX = "addon:claudewow:"

function ns.ToHex(s)
	return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end))
end

function ns.Wire(s)
	local value = tostring(s or "")
	return (value:gsub("[\30\31]", " "))
end

function ns.Display(s) return (tostring(s or ""):gsub("|", "¦")) end

function ns.Trim(s) return (s:gsub("^%s+", ""):gsub("%s+$", "")) end

function ns.Link(action, arg, label, hex)
	return "|H" .. ns.LINK_PREFIX .. action .. (arg and (":" .. arg) or "") .. "|h|cff" .. (hex or "7ec8ff") .. "[" .. ns.Display(label) .. "]|r|h"
end

function ns.Flat(s) return (ns.Display(s):gsub("%s*\n%s*", " ")) end

function ns.FmtDur(sec)
	sec = math.floor(sec or 0)
	if sec < 60 then return sec .. "s" end
	if sec < 3600 then return math.floor(sec / 60) .. "m" .. string.format("%02d", sec % 60) .. "s" end
	return math.floor(sec / 3600) .. "h" .. string.format("%02d", math.floor(sec / 60) % 60) .. "m"
end

function ns.FmtTokens(n)
	n = tonumber(n) or 0
	if n < 1000 then return tostring(math.floor(n + 0.5)) end
	if n < 1000000 then return string.format("%.1fk", n / 1000) end
	return string.format("%.1fM", n / 1000000)
end

function ns.FmtElapsed(sec)
	sec = math.max(0, math.floor(sec or 0))
	if sec < 60 then return sec .. "s" end
	if sec < 3600 then return math.floor(sec / 60) .. "m " .. string.format("%02d", sec % 60) .. "s" end
	return math.floor(sec / 3600) .. "h " .. string.format("%02d", math.floor(sec / 60) % 60) .. "m"
end

function ns.ParseTokens(text)
	local num, unit = tostring(text or ""):lower():match("^(%d+%.?%d*)([km]?)$")
	if not num then return nil end
	local n = tonumber(num)
	if not n then return nil end
	if unit == "k" then
		n = n * 1000
	elseif unit == "m" then
		n = n * 1000000
	end
	return math.floor(n + 0.5)
end

function ns.Contains(list, v)
	for _, x in ipairs(list or {}) do
		if x == v then return true end
	end
	return false
end

function ns.Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	return (function(ok, ...)
		if ok then return ... end
	end)(pcall(fn, ...))
end

function ns.Money(copper)
	copper = tonumber(copper) or 0
	local g, s, c = math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100
	if g > 0 then return g .. "g " .. s .. "s " .. c .. "c" end
	if s > 0 then return s .. "s " .. c .. "c" end
	return c .. "c"
end

local FNV_OFFSET, FNV_PRIME_LOW, TWO_24, TWO_32 = 2166136261, 403, 16777216, 4294967296

local function Xor8(a, b)
	local r, bit = 0, 1
	for _ = 1, 8 do
		local x, y = a % 2, b % 2
		if x ~= y then r = r + bit end
		a, b, bit = math.floor(a / 2), math.floor(b / 2), bit * 2
	end
	return r
end

function ns.Fnv1a(text)
	local hash = FNV_OFFSET
	for i = 1, #text do
		local low = hash % 256
		hash = hash - low + Xor8(low, text:byte(i))
		hash = (hash * FNV_PRIME_LOW + (hash % 256) * TWO_24) % TWO_32
	end
	return string.format("%04x%04x", math.floor(hash / 65536), hash % 65536)
end

function ns.FileHash() return ns.Fnv1a(table.concat(ns.files, "\n")) end
