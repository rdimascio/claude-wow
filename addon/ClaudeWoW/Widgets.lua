local ADDON_NAME = ...
local W = {}
ClaudeWoWWidgets = W

local DENIED_NAMES = {
	"CastSpell", "CastSpellByName", "CastSpellByID", "CastShapeshiftForm", "CastPetAction",
	"UseAction", "UseItemByName", "UseInventoryItem", "UseContainerItem", "UseToy", "UseToyByName",
	"RunMacro", "RunMacroText", "RunBinding", "RunScript",
	"TargetUnit", "TargetNearestEnemy", "TargetNearestFriend", "TargetLastTarget", "TargetLastEnemy", "ClearTarget",
	"AssistUnit", "FocusUnit", "InteractUnit", "FollowUnit",
	"AttackTarget", "StartAttack", "StopAttack", "PetAttack", "PetFollow",
	"SpellStopCasting", "SpellStopTargeting", "SpellTargetUnit", "CancelShapeshiftForm", "CancelUnitBuff",
	"JumpOrAscendStart", "MoveForwardStart", "MoveBackwardStart", "StrafeLeftStart", "StrafeRightStart",
	"TurnLeftStart", "TurnRightStart", "ToggleAutoRun", "ToggleRun", "SitStandOrDescendStart",
	"PickupAction", "PlaceAction", "PickupSpell", "PickupItem", "PickupMacro", "PickupContainerItem",
	"PickupInventoryItem", "DeleteCursorItem", "EquipItemByName",
	"SendChatMessage", "SendAddonMessage", "BNSendWhisper", "DoEmote", "SendMail", "ChatEdit_SendText", "ChatEdit_ParseText",
	"InviteUnit", "UninviteUnit", "LeaveParty", "AcceptGroup", "AcceptTrade", "InitiateTrade",
	"BuyMerchantItem", "RepairAllItems", "PlaceAuctionBid", "SetRaidTarget",
	"CreateMacro", "EditMacro", "DeleteMacro",
	"SetBinding", "SetBindingClick", "SetBindingSpell", "SetBindingItem", "SetBindingMacro", "SaveBindings",
	"SetCVar", "ConsoleExec", "ReloadUI", "Logout", "Quit", "ForceQuit",
	"LoadAddOn", "EnableAddOn", "DisableAddOn", "SlashCmdList", "hooksecurefunc", "securecall", "securecallfunction", "secureexecuterange",
	"loadstring", "load", "getfenv", "setfenv", "getglobal", "setglobal", "rawget", "rawset", "debug",
	"CombatLogGetCurrentEventInfo",
}
W.DENIED_NAMES = DENIED_NAMES

local RESTRICTED_EVENTS = {
	"COMBAT_LOG_EVENT", "COMBAT_LOG_EVENT_UNFILTERED", "COMBAT_LOG_APPLY_FILTER_SETTINGS", "COMBAT_LOG_REFILTER_ENTRIES",
	"MINIMAP_PING", "UNIT_PING_PIN_ADDED", "UNIT_PING_PIN_REMOVED",
}
W.RESTRICTED_EVENTS = RESTRICTED_EVENTS

local RESTRICTED = {}
for _, name in ipairs(RESTRICTED_EVENTS) do RESTRICTED[name] = true end

local DENIED = {}
for _, name in ipairs(DENIED_NAMES) do DENIED[name] = true end

local wdb
local running = {}
local failures = {}
local containers = {}

local function Print(msg)
	if ClaudeWoW and ClaudeWoW.Print then
		ClaudeWoW.Print(msg, "Claude WoW ui")
	else
		print("|cff66ccff[Claude WoW ui]|r " .. msg)
	end
end

local function Report(msg)
	Print(msg)
	if ClaudeWoW and ClaudeWoW.SystemNote then ClaudeWoW.SystemNote("UI widget " .. msg) end
end

local function DB()
	if not wdb then
		ClaudeWoWWidgetDB = ClaudeWoWWidgetDB or {}
		wdb = ClaudeWoWWidgetDB
		wdb.removed = wdb.removed or {}
		wdb.data = wdb.data or {}
	end
	return wdb
end

local function Items()
	local set = DB().set
	return set and set.items or {}
end

local function FindItem(name)
	for _, item in ipairs(Items()) do
		if item.name == name then return item end
	end
end

local unpackValues = unpack or table.unpack

local SHARED_LIBRARIES = { "math", "string", "table", "bit", "coroutine" }

local LUA_FUNCTIONS = {
	"assert", "error", "ipairs", "next", "pairs", "pcall", "select", "tonumber", "tostring", "type", "unpack",
	"xpcall", "setmetatable", "rawequal", "print", "date", "time", "difftime",
	"strsplit", "strjoin", "strtrim", "strconcat", "format", "tinsert", "tremove", "tContains", "tDeleteItem", "wipe", "sort",
	"floor", "ceil", "abs", "max", "min", "mod", "sqrt", "random", "strlower", "strupper", "strlen", "strsub",
	"strfind", "strmatch", "strrep", "strbyte", "strchar", "strrev", "gsub", "gmatch", "tostringall",
	"CopyTable", "Mixin", "CreateFromMixins", "CreateColor",
}

local GAME_FUNCTIONS = {
	"GetTime", "debugprofilestop", "GetFramerate", "GetNetStats", "GetServerTime", "GetGameTime", "GetLocale", "GetBuildInfo",
	"GetMoney", "GetCoinText", "GetCoinTextureString", "GetMoneyString", "BreakUpLargeNumbers", "AbbreviateLargeNumbers", "SecondsToTime",
	"GetZoneText", "GetRealZoneText", "GetSubZoneText", "GetMinimapZoneText", "GetZonePVPInfo", "GetInstanceInfo", "GetRealmName",
	"GetPlayerFacing", "GetUnitSpeed", "GetCursorPosition", "GetScreenWidth", "GetScreenHeight", "GetPhysicalScreenSize",
	"GetSpellInfo", "GetSpellCooldown", "GetSpellTexture", "GetSpellCount", "GetSpellBonusDamage", "GetSpellBonusHealing",
	"GetItemInfo", "GetItemInfoInstant", "GetItemCount", "GetItemIcon", "GetItemCooldown", "GetItemQualityColor",
	"GetInventoryItemLink", "GetInventoryItemID", "GetInventoryItemTexture", "GetInventoryItemDurability", "GetInventorySlotInfo",
	"GetContainerNumSlots", "GetContainerNumFreeSlots", "GetContainerItemInfo", "GetContainerItemLink",
	"GetCombatRating", "GetCritChance", "GetRangedCritChance", "GetSpellCritChance", "GetDodgeChance", "GetParryChance",
	"GetBlockChance", "GetHitModifier", "GetManaRegen", "GetPowerRegen", "GetHaste",
	"GetNumGroupMembers", "GetNumSubgroupMembers", "GetRaidRosterInfo", "GetXPExhaustion", "GetRestState",
	"GetComboPoints", "GetShapeshiftForm", "GetShapeshiftFormInfo", "GetNumShapeshiftForms", "GetTotemInfo",
	"GetActionCooldown", "GetActionInfo", "GetActionTexture", "GetActionCount", "HasAction", "IsUsableAction", "IsActionInRange",
	"GetNumQuestLogEntries", "GetQuestLogTitle", "GetNumSkillLines", "GetSkillLineInfo", "GetWatchedFactionInfo",
	"GetNumFactions", "GetFactionInfo", "GetGuildInfo", "GetPetHappiness", "GetPetExperience",
	"GetNumTalentTabs", "GetTalentTabInfo", "GetTalentInfo", "GetClassColor",
	"InCombatLockdown", "IsInGroup", "IsInRaid", "IsInInstance", "IsInGuild", "IsResting", "IsMounted", "IsFlying", "IsSwimming",
	"IsFalling", "IsStealthed", "IsIndoors", "IsOutdoors", "IsSpellKnown", "IsPlayerSpell", "IsUsableSpell", "IsCurrentSpell",
	"IsSpellInRange", "IsItemInRange", "IsAutoRepeatSpell", "IsEquippedItem", "IsShiftKeyDown", "IsControlKeyDown",
	"IsAltKeyDown", "IsModifierKeyDown", "IsMouseButtonDown", "HasFullControl", "CheckInteractDistance", "HasPetUI",
	"PlaySound", "PlaySoundFile",
}

local DATA_TABLES = { "RAID_CLASS_COLORS", "CLASS_ICON_TCOORDS", "ITEM_QUALITY_COLORS", "FACTION_BAR_COLORS", "PowerBarColor", "Enum", "SOUNDKIT" }

local TEMPLATES = {
	"BackdropTemplate", "TooltipBackdropTemplate", "TooltipBorderedFrameTemplate", "BasicFrameTemplate", "BasicFrameTemplateWithInset",
	"InsetFrameTemplate", "UIPanelButtonTemplate", "UIPanelCloseButton", "UICheckButtonTemplate", "InputBoxTemplate",
	"OptionsSliderTemplate", "UIPanelScrollFrameTemplate", "GameTooltipTemplate",
}
W.TEMPLATES = TEMPLATES

local TOOLTIP_METHODS = {
	"SetOwner", "ClearLines", "AddLine", "AddDoubleLine", "AddTexture", "SetText", "Show", "Hide", "IsShown", "NumLines",
	"SetUnit", "SetUnitAura", "SetUnitBuff", "SetUnitDebuff", "SetSpellByID", "SetItemByID", "SetHyperlink",
	"SetInventoryItem", "SetBagItem", "SetMinimumWidth", "SetPoint", "ClearAllPoints",
}

local UNIT_WRITER_VERBS = { "Set", "Switch", "Clear", "Popup", "Frame", "Select", "Toggle", "Use", "Cast", "Target" }

local READ_ONLY_MEMBER_PATTERNS = { "^Get%u", "^Is%u", "^Has%u", "^Can%u", "^Does%u", "^Find%u", "^Are%u", "^Should%u" }

local function NameSet(names)
	local set = {}
	for _, name in ipairs(names) do set[name] = true end
	return set
end

local SHARED_LIBRARY = NameSet(SHARED_LIBRARIES)
local LUA_FUNCTION = NameSet(LUA_FUNCTIONS)
local GAME_FUNCTION = NameSet(GAME_FUNCTIONS)
local DATA_TABLE = NameSet(DATA_TABLES)
local TEMPLATE = NameSet(TEMPLATES)
local UNIT_WRITER_VERB = NameSet(UNIT_WRITER_VERBS)

local function Blocked(name)
	return function()
		error(name .. " is not allowed in a widget: widgets are display-only", 2)
	end
end

local function IsReadOnlyMember(field)
	if type(field) ~= "string" then return false end
	for _, pattern in ipairs(READ_ONLY_MEMBER_PATTERNS) do
		if field:find(pattern) then return true end
	end
	return false
end

local function ShallowCopy(source)
	local copy = {}
	for key, value in pairs(source) do copy[key] = value end
	return copy
end

local function DeepCopy(source, seen)
	seen = seen or {}
	if seen[source] then return seen[source] end
	local copy = {}
	seen[source] = copy
	for key, value in pairs(source) do
		copy[key] = type(value) == "table" and DeepCopy(value, seen) or value
	end
	return copy
end

local function IsFontObject(value)
	local ok, kind = pcall(function() return value:GetObjectType() end)
	return ok and kind == "Font"
end

local function SafeGetMetatable(value)
	if type(value) == "table" then return getmetatable(value) end
	return nil
end

local function MapValues(map, ...)
	local count = select("#", ...)
	if count == 0 then return end
	local values = { ... }
	for i = 1, count do values[i] = map(values[i]) end
	return unpackValues(values, 1, count)
end

function W.Fail(widget, err)
	if widget.failed then return end
	widget.failed = true
	failures[widget.name] = { rev = widget.rev, err = tostring(err) }
	W.Stop(widget)
	Report(string.format("%s failed and was stopped: %s. /claude config ui run %s tries again; or ask the agent to fix it.", widget.name, tostring(err), widget.name))
end

local function Guarded(widget, fn)
	return function(...)
		if widget.stopped then return end
		local ok, err = pcall(fn, ...)
		if not ok then W.Fail(widget, err) end
	end
end

local function CheckEvent(event)
	if RESTRICTED[event] then error(tostring(event) .. " is not allowed in a widget: this client lets only the Blizzard UI register it", 3) end
end

local function CheckTemplates(template)
	if template == nil then return end
	if type(template) ~= "string" then error("a widget frame template must be a string", 3) end
	if template:find("Secure") then error("secure templates are not allowed in a widget: widgets are display-only", 3) end
	for name in template:gmatch("[^,%s]+") do
		if not TEMPLATE[name] then error(name .. " is not an allowed widget template: use " .. table.concat(TEMPLATES, ", "), 3) end
	end
end

local function NewMembrane(widget)
	local weakKeys = { __mode = "k" }
	local realOf = setmetatable({}, weakKeys)
	local ownedRealOf = setmetatable({}, weakKeys)
	local proxyOf = setmetatable({}, weakKeys)
	local foreignProxyOf = setmetatable({}, weakKeys)
	local originalOf = setmetatable({}, weakKeys)
	local membrane = {}
	local Adopt

	local function IsWidgetDescendant(real)
		local current = real
		for _ = 1, 64 do
			local hasParentGetter, getParent = pcall(function() return current.GetParent end)
			if not hasParentGetter or type(getParent) ~= "function" then return false end
			local ok, parent = pcall(getParent, current)
			if not ok or type(parent) ~= "table" then return false end
			if proxyOf[parent] then return true end
			current = parent
		end
		return false
	end

	local function ExportObject(real)
		if proxyOf[real] then return proxyOf[real] end
		if IsWidgetDescendant(real) then return Adopt(real) end
		return nil
	end

	local function IsPlainTable(value)
		return getmetatable(value) == nil and type(rawget(value, 0)) ~= "userdata"
	end

	local ExportWithin
	local function ExportPlainTable(source, copies)
		if copies[source] then return copies[source] end
		local copy = {}
		copies[source] = copy
		for key, value in pairs(source) do
			local exportedKey = ExportWithin(key, copies)
			if exportedKey ~= nil then copy[exportedKey] = ExportWithin(value, copies) end
		end
		return copy
	end

	ExportWithin = function(value, copies)
		local kind = type(value)
		if kind == "function" then return nil end
		if kind ~= "table" then return value end
		if realOf[value] ~= nil then return value end
		if proxyOf[value] then return proxyOf[value] end
		if IsPlainTable(value) then return ExportPlainTable(value, copies) end
		return ExportObject(value)
	end

	local function Export(value)
		return ExportWithin(value, {})
	end

	local function Import(value)
		if type(value) == "table" and realOf[value] ~= nil then return realOf[value] end
		return value
	end

	local function CallExported(fn, ...)
		return MapValues(Export, fn(...))
	end

	function membrane.ExportFunction(fn)
		return function(...)
			return CallExported(fn, MapValues(Import, ...))
		end
	end

	local function FrameParent(parent)
		if parent == nil then return widget.frame end
		local real = type(parent) == "table" and ownedRealOf[parent]
		if not real then error("a widget frame can only have ui.frame or another widget frame as its parent", 3) end
		return real
	end
	membrane.FrameParent = FrameParent

	local function ScriptHandler(fn)
		local guarded = Guarded(widget, function(...) return fn(MapValues(Export, ...)) end)
		originalOf[guarded] = fn
		return guarded
	end

	local function ContainerDispatcher(handler)
		return Guarded(widget, function(...)
			local list = widget.containerScripts[handler]
			if not list then return end
			for _, fn in ipairs(list) do fn(MapValues(Export, ...)) end
		end)
	end

	local function SetContainerScripts(real, handler, list)
		widget.containerScripts[handler] = list
		real:SetScript(handler, list and ContainerDispatcher(handler) or nil)
	end

	local special = {}
	function special.SetScript(_, real, handler, fn)
		if type(fn) ~= "function" and fn ~= nil then error("SetScript needs a function or nil", 3) end
		if real == widget.frame then return SetContainerScripts(real, handler, fn and { fn } or nil) end
		return real:SetScript(handler, fn and ScriptHandler(fn) or nil)
	end
	function special.HookScript(_, real, handler, fn)
		if type(fn) ~= "function" then error("HookScript needs a function", 3) end
		if real == widget.frame then
			local list = widget.containerScripts[handler] or {}
			list[#list + 1] = fn
			return SetContainerScripts(real, handler, list)
		end
		return real:HookScript(handler, ScriptHandler(fn))
	end
	function special.GetScript(_, real, handler)
		if real == widget.frame then
			local list = widget.containerScripts[handler]
			return list and list[1]
		end
		return originalOf[real:GetScript(handler)]
	end
	function special.RegisterEvent(_, real, event)
		CheckEvent(event)
		return Export(real:RegisterEvent(event))
	end
	function special.RegisterUnitEvent(_, real, event, ...)
		CheckEvent(event)
		return Export(real:RegisterUnitEvent(event, MapValues(Import, ...)))
	end
	function special.RegisterAllEvents()
		error("RegisterAllEvents is not allowed in a widget: register each event by name", 3)
	end
	function special.SetParent(_, real, parent)
		return real:SetParent(FrameParent(parent))
	end

	local methodCache = {}
	local function OwnedMethod(name)
		local method = methodCache[name]
		if method then return method end
		method = function(self, ...)
			local real = ownedRealOf[self]
			if real == nil then error(tostring(name) .. " needs a widget frame: call it with a colon", 2) end
			local handler = special[name]
			if handler then return handler(self, real, ...) end
			return CallExported(real[name], real, MapValues(Import, ...))
		end
		methodCache[name] = method
		return method
	end

	local ownedMeta = {
		__index = function(proxy, key)
			local value = ownedRealOf[proxy][key]
			local kind = type(value)
			if kind == "function" then return OwnedMethod(key) end
			if kind == "table" then return ExportObject(value) end
			return value
		end,
		__metatable = false,
	}

	Adopt = function(real)
		local proxy = proxyOf[real]
		if proxy then return proxy end
		proxy = setmetatable({}, ownedMeta)
		proxyOf[real] = proxy
		realOf[proxy] = real
		ownedRealOf[proxy] = real
		return proxy
	end
	membrane.Adopt = Adopt

	function membrane.Foreign(real, methods)
		local proxy = foreignProxyOf[real]
		if proxy then return proxy end
		local index = {}
		for _, name in ipairs(methods or {}) do
			index[name] = function(self, ...)
				if realOf[self] ~= real then error(name .. " needs the object it came from: call it with a colon", 2) end
				return CallExported(real[name], real, MapValues(Import, ...))
			end
		end
		proxy = setmetatable({}, {
			__index = index,
			__newindex = function() error("this game object is read-only in a widget", 2) end,
			__metatable = false,
		})
		foreignProxyOf[real] = proxy
		realOf[proxy] = real
		return proxy
	end

	membrane.container = Adopt(widget.frame)
	return membrane
end

local function NamespaceProxy(namespaceName, namespace, membrane)
	local exported = {}
	return setmetatable({}, {
		__index = function(_, field)
			if DENIED[field] then return Blocked(namespaceName .. "." .. tostring(field)) end
			local value = namespace[field]
			local kind = type(value)
			if kind == "table" then return nil end
			if kind ~= "function" then return value end
			if not IsReadOnlyMember(field) then return Blocked(namespaceName .. "." .. tostring(field)) end
			exported[field] = exported[field] or membrane.ExportFunction(value)
			return exported[field]
		end,
		__newindex = function() error(namespaceName .. " is read-only in a widget", 2) end,
		__metatable = false,
	})
end

local function WidgetCreateFrame(widget, membrane)
	return function(kind, _, parent, template, id)
		CheckTemplates(template)
		local frame = CreateFrame(kind, nil, membrane.FrameParent(parent), template, id)
		widget.frames[#widget.frames + 1] = frame
		return membrane.Adopt(frame)
	end
end

local function TimerHandle(handle)
	if type(handle) ~= "table" then return nil end
	local methods = {
		Cancel = function()
			if handle.Cancel then handle:Cancel() end
		end,
		IsCancelled = function()
			if handle.IsCancelled then return handle:IsCancelled() end
			return handle.cancelled == true
		end,
	}
	return setmetatable({}, { __index = methods, __newindex = function() end, __metatable = false })
end

local function WidgetTimers(widget)
	local timers = {}
	timers.After = function(delay, fn)
		C_Timer.After(delay, Guarded(widget, function() return fn() end))
	end
	for _, constructor in ipairs({ "NewTicker", "NewTimer" }) do
		if C_Timer[constructor] then
			timers[constructor] = function(delay, fn, iterations)
				local proxy
				local handle = C_Timer[constructor](delay, Guarded(widget, function() return fn(proxy) end), iterations)
				widget.timers[#widget.timers + 1] = handle
				proxy = TimerHandle(handle)
				return proxy
			end
		end
	end
	return setmetatable({}, {
		__index = timers,
		__newindex = function() error("C_Timer is read-only in a widget", 2) end,
		__metatable = false,
	})
end

local function IsUnitReader(key)
	if not key:find("^Unit%u%a*$") then return false end
	local verb = key:match("^Unit(%u%l*)")
	return not UNIT_WRITER_VERB[verb]
end

local function Resolve(key, membrane)
	local value = _G[key]
	local kind = type(value)
	if kind == "string" or kind == "number" or kind == "boolean" then return value end
	if kind == "function" then
		if LUA_FUNCTION[key] then return value end
		if GAME_FUNCTION[key] or IsUnitReader(key) then return membrane.ExportFunction(value) end
		return nil
	end
	if kind ~= "table" then return nil end
	if SHARED_LIBRARY[key] then return ShallowCopy(value) end
	if DATA_TABLE[key] then return DeepCopy(value) end
	if key:find("^C_%a") then return NamespaceProxy(key, value, membrane) end
	if key:find("Font") and IsFontObject(value) then return membrane.Foreign(value) end
	return nil
end

local function NewEnvironment(widget, membrane)
	local env = {}
	local resolved = {}
	local fixed = {
		CreateFrame = WidgetCreateFrame(widget, membrane),
		C_Timer = WidgetTimers(widget),
		UIParent = membrane.container,
		getmetatable = SafeGetMetatable,
	}
	if type(GameTooltip) == "table" then fixed.GameTooltip = membrane.Foreign(GameTooltip, TOOLTIP_METHODS) end
	setmetatable(env, {
		__index = function(_, key)
			if type(key) ~= "string" then return nil end
			if DENIED[key] then return Blocked(key) end
			if key == "_G" then return env end
			if key:match("^ClaudeWoW") then return nil end
			if fixed[key] ~= nil then return fixed[key] end
			if resolved[key] == nil then resolved[key] = Resolve(key, membrane) end
			return resolved[key]
		end,
		__metatable = false,
	})
	return env
end

local function Compile(source, name, env)
	local chunkName = "=widget " .. name
	if setfenv and loadstring then
		local chunk, err = loadstring(source, chunkName)
		if chunk then setfenv(chunk, env) end
		return chunk, err
	end
	return load(source, chunkName, "t", env)
end

local function Container(name)
	local frame = containers[name]
	if not frame then
		frame = CreateFrame("Frame", nil, UIParent)
		frame:SetAllPoints(UIParent)
		containers[name] = frame
	end
	return frame
end

local function WidgetData(name)
	local data = DB().data
	data[name] = data[name] or {}
	return data[name]
end

function W.Stop(widget)
	if widget.stopped then return end
	widget.stopped = true
	for _, handle in ipairs(widget.timers) do
		if handle and handle.Cancel then pcall(handle.Cancel, handle) end
	end
	for _, frame in ipairs(widget.frames) do
		pcall(frame.UnregisterAllEvents, frame)
		pcall(frame.SetScript, frame, "OnUpdate", nil)
		pcall(frame.Hide, frame)
	end
	local container = widget.frame
	pcall(container.UnregisterAllEvents, container)
	for handler in pairs(widget.containerScripts) do
		pcall(container.SetScript, container, handler, nil)
	end
	widget.containerScripts = {}
	container:Hide()
	if running[widget.name] == widget then running[widget.name] = nil end
end

function W.Start(item, announce)
	local widget = { name = item.name, title = item.title or item.name, rev = item.rev, frames = {}, timers = {}, containerScripts = {} }
	widget.frame = Container(item.name)
	widget.frame:Show()
	failures[item.name] = nil
	running[item.name] = widget
	local membrane = NewMembrane(widget)
	local chunk, compileError = Compile(item.source, item.name, NewEnvironment(widget, membrane))
	if not chunk then
		W.Fail(widget, compileError)
		return false
	end
	local api = {
		name = item.name,
		title = widget.title,
		frame = membrane.container,
		db = WidgetData(item.name),
		print = function(msg) Print(item.name .. ": " .. tostring(msg)) end,
	}
	local ok, err = pcall(chunk, api)
	if not ok then
		W.Fail(widget, err)
		return false
	end
	if announce then Report(string.format("%s is live: %s. /claude config ui lists widgets, /claude config ui remove %s removes it.", item.name, widget.title, item.name)) end
	return true
end

function W.Apply(announce)
	local d = DB()
	local wanted = {}
	for _, item in ipairs(Items()) do wanted[item.name] = item end
	for name, widget in pairs(running) do
		local item = wanted[name]
		if not item or item.rev ~= widget.rev or d.removed[name] == item.rev then
			W.Stop(widget)
			if not item and announce then Report(name .. " was removed by the agent.") end
		end
	end
	for name, rev in pairs(d.removed) do
		if not wanted[name] or wanted[name].rev ~= rev then d.removed[name] = nil end
	end
	for _, item in ipairs(Items()) do
		local failure = failures[item.name]
		local failedThisRevision = failure and failure.rev == item.rev
		if not d.removed[item.name] and not running[item.name] and not failedThisRevision then
			W.Start(item, announce)
		end
	end
end

function W.Sync(set)
	if type(set) ~= "table" or type(set.items) ~= "table" then return end
	local d = DB()
	local current = d.set
	if current and current.epoch == set.epoch and (tonumber(set.version) or 0) <= (tonumber(current.version) or 0) then return end
	local items = {}
	for _, item in ipairs(set.items) do
		if type(item) == "table" and type(item.name) == "string" and type(item.source) == "string" and type(item.rev) == "string" then
			items[#items + 1] = { name = item.name, title = type(item.title) == "string" and item.title or item.name, rev = item.rev, source = item.source }
		end
	end
	d.set = { epoch = set.epoch, version = tonumber(set.version) or 0, items = items }
	W.Apply(true)
end

function W.Status(name)
	local item = FindItem(name)
	if not item then return nil end
	if running[name] then return "running" end
	if DB().removed[name] == item.rev then return "removed" end
	local failure = failures[name]
	if failure and failure.rev == item.rev then return "failed", failure.err end
	return "stopped"
end

local function List()
	local items = Items()
	if #items == 0 then
		Print("no widgets yet. Ask the agent for one, e.g. /claude give me a small DPS meter")
		return
	end
	for _, item in ipairs(items) do
		local status, err = W.Status(item.name)
		Print(string.format("%s  %s  (%s%s, %d bytes)", item.name, item.title, status, err and (": " .. err) or "", #item.source))
	end
	Print("commands: /claude config ui list, /claude config ui remove <name>, /claude config ui run <name>")
end

function W.Remove(name)
	local item = FindItem(name)
	if not item then Print("no widget " .. tostring(name)); return end
	DB().removed[name] = item.rev
	if running[name] then W.Stop(running[name]) end
	Report(string.format("%s removed. It stays off until the agent sends a new version; /claude config ui run %s brings it back.", name, name))
end

function W.Run(name)
	local item = FindItem(name)
	if not item then Print("no widget " .. tostring(name)); return end
	DB().removed[name] = nil
	if running[name] then W.Stop(running[name]) end
	W.Start(item, true)
end

function W.Command(msg)
	DB()
	local cmd, rest = (msg or ""):match("^%s*(%S*)%s*(.-)%s*$")
	cmd = (cmd or ""):lower()
	if cmd == "remove" and rest ~= "" then W.Remove(rest)
	elseif cmd == "run" and rest ~= "" then W.Run(rest)
	else List() end
end

local events = CreateFrame("Frame")
events:RegisterEvent("ADDON_LOADED")
events:RegisterEvent("PLAYER_LOGIN")
events:SetScript("OnEvent", function(_, event, arg1)
	if event == "ADDON_LOADED" and arg1 == ADDON_NAME then
		DB()
	elseif event == "PLAYER_LOGIN" then
		DB()
		W.Apply(false)
	end
end)
