local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Transport\\Strip.lua"

local run = ns.run
local Wire = ns.Wire
local Codec = ClaudeWoW_Codec

local STRIP_TRIES = 3 -- re-show an unacknowledged message this many times before falling back
local CELL, CELLS_PER_ROW, MAX_ROWS = 4, 200, 48
local STRIP_SECONDS = 40 -- max per message; it leaves the strip as soon as the bridge acknowledges
local RS, US = "\30", "\31" -- record / unit separators in the strip payload
ns.STRIP_TRIES, ns.STRIP_SECONDS, ns.RS, ns.US = STRIP_TRIES, STRIP_SECONDS, RS, US

---------------------------------------------------------------------------
-- Pixel strip (out)
---------------------------------------------------------------------------

local strip
local cellPool = {}

local function EnsureStrip()
	if strip then return strip end
	strip = CreateFrame("Frame", "ClaudeWoWStrip", UIParent)
	strip:SetFrameStrata("TOOLTIP")
	strip:SetFrameLevel(10000)
	-- Scale so that one UI unit is exactly one physical pixel (see Blizzard's PixelUtil).
	local physH = 1080
	if GetPhysicalScreenSize then
		local _, h = GetPhysicalScreenSize()
		physH = h or physH
	end
	if strip.SetIgnoreParentScale then strip:SetIgnoreParentScale(true) end
	strip:SetScale(768 / physH)
	strip:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
	strip:SetSize(CELLS_PER_ROW * CELL, MAX_ROWS * CELL)
	strip:Hide()
	return strip
end

local function HideStrip()
	if strip then strip:Hide() end
	run.stripShown = nil
end

-- Which codec the strip is drawn with (see Codec.lua) and the two levels, 0..255,
-- its channels span. Codec 1 at full primaries, except on the screenshot
-- transport, where the bridge asked for levels of its own (see StripLevels): a
-- screenshot is bit-exact, so dark levels read as well as bright ones and the
-- strip all but disappears. Codec 2 (2 px cells, four levels a channel between
-- the same two numbers) only when that bridge asked for it.
local function StripCodec()
	local lv = ns.db and ns.db.settings.mode == "pixel" and ns.db.settings.transport == "screenshot" and ns.db.settings.stripLevels
	if type(lv) == "table" and type(lv.on) == "number" and type(lv.off) == "number" then return lv.codec == 2 and 2 or 1, lv.on, lv.off end
	return 1, 255, 0
end

local function ShowStrip(id, payload)
	local codec, on, off = StripCodec()
	local geo = Codec.GEOMETRY[codec]
	local cells = Codec.Encode(id % 65536, payload, codec)
	local s = EnsureStrip()
	local rows = math.ceil(#cells / geo.cells)
	local total = rows * geo.cells
	local levels = codec == 2 and Codec.DenseLevels(on, off) or nil
	for i = 1, total do
		local t = cellPool[i]
		if not t then
			t = s:CreateTexture(nil, "OVERLAY")
			cellPool[i] = t
		end
		-- A texture is laid out for one codec; a switch (the bridge changed its
		-- mind, or an older saved setting) places it again.
		if t.codec ~= codec then
			t:SetSize(geo.cell, geo.cell)
			local c = (i - 1) % geo.cells
			local r = math.floor((i - 1) / geo.cells)
			t:ClearAllPoints()
			t:SetPoint("TOPLEFT", s, "TOPLEFT", c * geo.cell, -r * geo.cell)
			t.codec = codec
		end
		local v = cells[i] or 0
		if codec == 2 then
			local cr, cg, cb = Codec.DenseCellColor(v)
			t:SetColorTexture(levels[cr + 1] / 255, levels[cg + 1] / 255, levels[cb + 1] / 255, 1)
		else
			local cr, cg, cb = Codec.CellColor(v)
			t:SetColorTexture((off + cr * (on - off)) / 255, (off + cg * (on - off)) / 255, (off + cb * (on - off)) / 255, 1)
		end
		t:Show()
	end
	for i = total + 1, #cellPool do
		cellPool[i]:Hide()
	end
	s:Show()
	run.stripShown = true
end
ns.EnsureStrip, ns.HideStrip, ns.StripCodec, ns.ShowStrip = EnsureStrip, HideStrip, StripCodec, ShowStrip

-- Record: session, chat, id, cwd, flags, name, [context,] text. Several records
-- per frame. The context field is only present when the flags carry "c", so the
-- bridge can tell it from a separator inside the text.
local function RecordFor(id, rec)
	local flags = Wire(rec.flags)
	-- The bridge wants screenshots and this record cannot be shot (no
	-- Screenshot() in this client, or SCREENSHOT_FAILED on every try): tell the
	-- bridge, and it falls back to the pixel capture (bridge.js fallbackToPixel;
	-- the reload outbox says it too).
	local shot = ns.NoScreenshot() and "missing" or (rec.shotFailed and "failed") or nil
	if shot then flags = flags == "" and ("shot=" .. shot) or (flags .. ";shot=" .. shot) end
	local report = ns.Presence.Report and ns.Presence.Report() or ""
	if report ~= "" then flags = flags == "" and report or (flags .. ";" .. report) end
	local fields = { Wire(ns.db.session), Wire(rec.chat), tostring(id), Wire(rec.cwd), flags, Wire(rec.name) }
	if rec.ctx ~= nil then
		fields[5] = flags == "" and "c" or (flags .. ";c")
		table.insert(fields, Wire(rec.ctx))
	end
	table.insert(fields, Wire(rec.text))
	return table.concat(fields, US)
end
ns.RecordFor = RecordFor
