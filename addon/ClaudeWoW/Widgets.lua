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
local skipped = {}

W.POPUP = "CLAUDEWOW_WIDGET"
W.TITLE_MAX = 60

local function Print(msg)
	if ClaudeWoW and ClaudeWoW.Print then
		ClaudeWoW.Print(msg)
	else
		print("|cff66ccff[Azeroth Companion]|r " .. msg)
	end
end

local function Quiet(ctx)
	return type(ctx) == "table" and ctx.quiet == true
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
		wdb.approved = type(wdb.approved) == "table" and wdb.approved or {}
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
	"GetUnitName", "GetRaidTargetIndex",
}

local DATA_TABLES = { "RAID_CLASS_COLORS", "CLASS_ICON_TCOORDS", "ITEM_QUALITY_COLORS", "FACTION_BAR_COLORS", "PowerBarColor", "Enum", "SOUNDKIT" }

local TEMPLATES = {
	"BackdropTemplate", "TooltipBackdropTemplate", "TooltipBorderedFrameTemplate", "BasicFrameTemplate", "BasicFrameTemplateWithInset",
	"InsetFrameTemplate", "UIPanelButtonTemplate", "UIPanelCloseButton", "UICheckButtonTemplate", "InputBoxTemplate",
	"OptionsSliderTemplate", "UIPanelScrollFrameTemplate", "GameTooltipTemplate",
}
W.TEMPLATES = TEMPLATES

local FRAME_KINDS = {
	"Frame", "Button", "CheckButton", "Slider", "StatusBar", "ScrollFrame", "EditBox", "Cooldown", "ColorSelect",
	"MessageFrame", "ScrollingMessageFrame", "SimpleHTML", "Model", "PlayerModel", "DressUpModel", "GameTooltip",
}
W.FRAME_KINDS = FRAME_KINDS

local FONT_GETTERS = {
	"GetFont", "GetTextColor", "GetShadowColor", "GetShadowOffset", "GetJustifyH", "GetJustifyV", "GetSpacing", "GetObjectType",
}

local REGION_CONSTRUCTORS = { "CreateFontString", "CreateTexture", "CreateMaskTexture", "CreateLine", "CreateAnimationGroup" }

local TOOLTIP_METHODS = {
	"SetOwner", "ClearLines", "AddLine", "AddDoubleLine", "AddTexture", "SetText", "Show", "Hide", "IsShown", "NumLines",
	"SetUnit", "SetUnitAura", "SetUnitBuff", "SetUnitDebuff", "SetSpellByID", "SetItemByID", "SetHyperlink",
	"SetInventoryItem", "SetBagItem", "SetMinimumWidth", "SetPoint", "ClearAllPoints",
}

local TIMER_CONSTRUCTORS = { "NewTicker", "NewTimer" }

local UNIT_WRITER_VERBS ={ "Set", "Switch", "Clear", "Popup", "Frame", "Select", "Toggle", "Use", "Cast", "Target" }

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
local FRAME_KIND = NameSet(FRAME_KINDS)
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

local UNPRINTABLE_ERROR = "an error that cannot be shown as text"

local function ErrorText(err)
	local ok, text = pcall(tostring, err)
	if ok and type(text) == "string" then return text end
	return UNPRINTABLE_ERROR
end

function W.Fail(widget, err)
	if widget.failed then return end
	widget.failed = true
	pcall(W.Stop, widget)
	local text = ErrorText(err)
	failures[widget.name] = { rev = widget.rev, err = text }
	Report(string.format("%s failed and was stopped: %s. /claude config ui run %s tries again; or ask the agent to fix it.", widget.name, text, widget.name))
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
	local fontRealOf = setmetatable({}, weakKeys)
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
		if foreignProxyOf[real] then return foreignProxyOf[real] end
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
		if type(value) ~= "table" then return value end
		return ownedRealOf[value] or fontRealOf[value] or value
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
		if handler == "OnEscapePressed" and type(real.SetAutoFocus) == "function" then
			local scripted = fn and ScriptHandler(fn)
			local escape = function(self, ...)
				real:ClearFocus()
				if scripted then return scripted(self, ...) end
			end
			originalOf[escape] = fn
			return real:SetScript(handler, escape)
		end
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
	function special.SetScrollChild(_, real, child)
		local childReal = type(child) == "table" and ownedRealOf[child]
		if not childReal or childReal == widget.frame then error("SetScrollChild needs a frame this widget made", 3) end
		return real:SetScrollChild(childReal)
	end
	function special.EnableKeyboard(_, real, enable)
		if enable then error("EnableKeyboard is not allowed in a widget: a widget must never take the keyboard", 3) end
		return real:EnableKeyboard(false)
	end
	function special.SetPropagateKeyboardInput(_, real, propagate)
		if real == widget.frame or not propagate then error("SetPropagateKeyboardInput is not allowed in a widget: a widget must never take the keyboard", 3) end
		return real:SetPropagateKeyboardInput(true)
	end
	function special.SetAutoFocus(_, real, auto)
		if auto then error("SetAutoFocus is not allowed in a widget: a widget must never take the keyboard", 3) end
		return real:SetAutoFocus(false)
	end
	function special.SetFocus()
		error("SetFocus is not allowed in a widget: a widget must never take the keyboard", 3)
	end
	for _, name in ipairs(REGION_CONSTRUCTORS) do
		special[name] = function(_, real, _, ...)
			return CallExported(real[name], real, nil, MapValues(Import, ...))
		end
	end
	function special.CreateAnimation(_, real, animationType, _, ...)
		return CallExported(real.CreateAnimation, real, animationType, nil, MapValues(Import, ...))
	end
	local CONTAINER_MOUSE_METHODS ={ "EnableMouse", "EnableMouseWheel", "SetMouseClickEnabled", "SetMouseMotionEnabled" }
	for _, name in ipairs(CONTAINER_MOUSE_METHODS) do
		special[name] = function(_, real, enable, ...)
			if real == widget.frame and enable then error(name .. " is not allowed on ui.frame: it covers the whole screen; use it on a child frame", 3) end
			return CallExported(real[name], real, enable, MapValues(Import, ...))
		end
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
		__newindex = function(proxy, key, value)
			local real = ownedRealOf[proxy]
			local kind = type(value)
			local scalar = kind ~= "function" and kind ~= "table" and kind ~= "userdata"
			if type(key) == "string" and scalar and type(real[key]) ~= "function" then
				real[key] = value
			else
				rawset(proxy, key, value)
			end
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

	function membrane.Font(real)
		local proxy = membrane.Foreign(real, FONT_GETTERS)
		fontRealOf[proxy] = real
		return proxy
	end

	membrane.container = Adopt(widget.frame)
	return membrane
end

local function NamespaceAdmits(field)
	return not DENIED[field] and IsReadOnlyMember(field)
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
			if not NamespaceAdmits(field) then return Blocked(namespaceName .. "." .. tostring(field)) end
			exported[field] = exported[field] or membrane.ExportFunction(value)
			return exported[field]
		end,
		__newindex = function() error(namespaceName .. " is read-only in a widget", 2) end,
		__metatable = false,
	})
end

local function WidgetCreateFrame(widget, membrane)
	return function(kind, _, parent, template, id)
		if not FRAME_KIND[kind] then error(tostring(kind) .. " is not an allowed widget frame type: use " .. table.concat(FRAME_KINDS, ", "), 2) end
		CheckTemplates(template)
		local frame = CreateFrame(kind, nil, membrane.FrameParent(parent), template, id)
		if type(frame.SetAutoFocus) == "function" then
			frame:SetAutoFocus(false)
			frame:SetScript("OnEscapePressed", frame.ClearFocus)
		end
		widget.frames[#widget.frames + 1] = frame
		return membrane.Adopt(frame)
	end
end

local function TimerHandle(handle)
	local kind = type(handle)
	if kind ~= "table" and kind ~= "userdata" then return nil end
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
	for _, constructor in ipairs(TIMER_CONSTRUCTORS) do
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

local function FunctionAdmission(key)
	if DENIED[key] then return nil end
	if LUA_FUNCTION[key] then return "lua" end
	if GAME_FUNCTION[key] or IsUnitReader(key) then return "game" end
	return nil
end

local function Resolve(key, membrane)
	local value = _G[key]
	local kind = type(value)
	if kind == "string" or kind == "number" or kind == "boolean" then return value end
	if kind == "function" then
		local admission = FunctionAdmission(key)
		if admission == "lua" then return value end
		if admission == "game" then return membrane.ExportFunction(value) end
		return nil
	end
	if kind ~= "table" then return nil end
	if SHARED_LIBRARY[key] then return ShallowCopy(value) end
	if DATA_TABLE[key] then return DeepCopy(value) end
	if key:find("^C_%a") then return NamespaceProxy(key, value, membrane) end
	if IsFontObject(value) then return membrane.Font(value) end
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

local GLOBALS_MAX = 6000
W.GLOBALS_MAX = GLOBALS_MAX
local AUDITED_FUNCTION_PATTERNS = { "^Unit%u", "^Get%u", "^Is%u", "^Has%u", "^Can%u" }

local function MatchesAny(key, patterns)
	for _, pattern in ipairs(patterns) do
		if key:find(pattern) then return true end
	end
	return false
end

local TIMER_FUNCTION = NameSet(TIMER_CONSTRUCTORS)
TIMER_FUNCTION.After = true

local function AuditedFieldAdmits(key, field)
	if key == "C_Timer" then return TIMER_FUNCTION[field] == true end
	return NamespaceAdmits(field)
end

local function AuditNamespace(key, namespace, add)
	pcall(function()
		for field, member in pairs(namespace) do
			if type(field) == "string" and type(member) == "function" then add(key .. "." .. field, AuditedFieldAdmits(key, field)) end
		end
	end)
end

local function AuditedGlobals()
	local admitted, refused = {}, {}
	local function Add(name, admits)
		local list = admits and admitted or refused
		list[#list + 1] = name
	end
	for key, value in pairs(_G) do
		if type(key) == "string" and not key:find("^ClaudeWoW") then
			local kind = type(value)
			if kind == "function" then
				local admits = FunctionAdmission(key) ~= nil
				if admits or MatchesAny(key, AUDITED_FUNCTION_PATTERNS) then Add(key, admits) end
			elseif kind == "table" and key:find("^C_%a") then
				AuditNamespace(key, value, Add)
			elseif kind == "table" and IsFontObject(value) then
				Add(key, true)
			end
		end
	end
	table.sort(admitted)
	table.sort(refused)
	return admitted, refused
end

local function FirstNames(list, room)
	local kept = {}
	for i = 1, math.min(#list, math.max(room, 0)) do kept[i] = list[i] end
	return kept
end

local function ClientBuild()
	if type(GetBuildInfo) ~= "function" then return "?", "?", 0 end
	local ok, version, build, _, interface = pcall(GetBuildInfo)
	if not ok then return "?", "?", 0 end
	return tostring(version or "?"), tostring(build or "?"), tonumber(interface) or 0
end

function W.DumpGlobals()
	local admitted, refused = AuditedGlobals()
	local keptAdmitted = FirstNames(admitted, GLOBALS_MAX)
	local keptRefused = FirstNames(refused, GLOBALS_MAX - #keptAdmitted)
	local version, build, interface = ClientBuild()
	local refusedCount = #refused
	local total = #admitted + refusedCount
	local saved = #keptAdmitted + #keptRefused
	local dump = {
		version = version,
		build = build,
		interface = interface,
		at = type(time) == "function" and time() or 0,
		total = total,
		saved = saved,
		admittedCount = #admitted,
		refusedCount = refusedCount,
		truncated = saved < total,
		admitted = keptAdmitted,
		refused = keptRefused,
	}
	DB().globals = dump
	return dump
end

function W.GlobalsCommand(arg)
	local verb = (arg or ""):lower():match("^%s*(%S*)") or ""
	if verb == "clear" then
		DB().globals = nil
		return "Dropped the saved global names. /reload writes the change to disk."
	end
	if verb ~= "" then return "Usage: /claude dev globals saves the names widgets can and cannot use; /claude dev globals clear drops them." end
	local dump = W.DumpGlobals()
	return string.format(
		"Saved %d of %d global names (%d a widget can use, %d it cannot) for client %s (%s). /reload writes them to disk; then run npm run audit:widgets in the claude-wow checkout. /claude dev globals clear drops them.",
		dump.saved, dump.total, dump.admittedCount, dump.refusedCount, dump.version, dump.build
	)
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

local function Approved(item)
	local approval = DB().approved[item.name]
	return type(approval) == "table" and approval.rev == item.rev and approval.source == item.source
end

local function Approve(item)
	DB().approved[item.name] = { rev = item.rev, source = item.source }
	skipped[item.name] = nil
end

local function SameCode(item, data)
	return type(data) == "table" and item.rev == data.rev and item.source == data.source
end

local function Display(s)
	return (tostring(s or ""):gsub("|", "¦"))
end

function W.Start(item, announce)
	if not Approved(item) then return false end
	local widget = { name = item.name, title = item.title or item.name, rev = item.rev, source = item.source, frames = {}, timers = {}, containerScripts = {} }
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
		if not item or item.rev ~= widget.rev or item.source ~= widget.source or d.removed[name] == item.rev then
			W.Stop(widget)
			if not item and announce then Report(name .. " was removed by the agent.") end
		end
	end
	for name, rev in pairs(d.removed) do
		if not wanted[name] or wanted[name].rev ~= rev then d.removed[name] = nil end
	end
	for name in pairs(d.approved) do
		if not wanted[name] or not Approved(wanted[name]) then d.approved[name] = nil end
	end
	for _, item in ipairs(Items()) do
		local failure = failures[item.name]
		local failedThisRevision = failure and failure.rev == item.rev
		if not d.removed[item.name] and not running[item.name] and not failedThisRevision and Approved(item) then
			W.Start(item, announce)
		end
	end
	W.PromptNext()
end

function W.Waiting()
	local d = DB()
	local list = {}
	for _, item in ipairs(Items()) do
		if not Approved(item) and d.removed[item.name] ~= item.rev then list[#list + 1] = item end
	end
	return list
end

W.RETRY_SECONDS = 2

local function RetryLater()
	if W.retrying or not (C_Timer and C_Timer.After) then return end
	W.retrying = true
	C_Timer.After(W.RETRY_SECONDS, function()
		W.retrying = nil
		W.PromptNext()
	end)
end

function W.PromptNext()
	if W.asking or type(StaticPopup_Show) ~= "function" then return false end
	for _, item in ipairs(W.Waiting()) do
		if skipped[item.name] ~= item.rev then
			local data = { name = item.name, rev = item.rev, source = item.source }
			W.asking = data
			local dialog = StaticPopup_Show(W.POPUP, Display(item.title):sub(1, W.TITLE_MAX), nil, data)
			if dialog then return true end
			W.asking = nil
			RetryLater()
			return false
		end
	end
	return false
end

local function Current(data)
	if type(data) ~= "table" then return nil end
	local item = FindItem(data.name)
	if not item or not SameCode(item, data) or DB().removed[item.name] == item.rev then return nil end
	return item
end

function W.Approve(data, ctx)
	local item = Current(data)
	if not item then return false end
	Approve(item)
	failures[item.name] = nil
	if running[item.name] then W.Stop(running[item.name]) end
	return W.Start(item, not Quiet(ctx))
end

function W.Decline(data)
	local item = Current(data)
	if not item then return false end
	DB().removed[item.name] = item.rev
	if running[item.name] then W.Stop(running[item.name]) end
	Print(string.format("%s stays hidden. /claude config ui run %s shows it.", item.name, item.name))
	return true
end

function W.PopupHidden(data)
	local item = Current(data)
	if item and not Approved(item) then skipped[item.name] = item.rev end
	W.asking = nil
	if C_Timer and C_Timer.After then C_Timer.After(0, W.PromptNext) end
end

if type(StaticPopupDialogs) == "table" then
	StaticPopupDialogs[W.POPUP] = {
		text = "Show the agent's '%s' widget?",
		button1 = "Show",
		button2 = "Not Now",
		timeout = 0,
		whileDead = true,
		hideOnEscape = true,
		noCancelOnEscape = true,
		OnAccept = function(_, data) W.Approve(data) end,
		OnCancel = function(dialog, data, reason)
			if dialog and reason == "clicked" then W.Decline(data) end
		end,
		OnHide = function(dialog) W.PopupHidden(dialog and dialog.data) end,
	}
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
	if not Approved(item) then return "waiting" end
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
		Print(string.format("%s  %s  (%s%s, %d bytes)", item.name, item.title, status == "waiting" and "waiting for your OK" or status, err and (": " .. err) or "", #item.source))
	end
	Print("commands: /claude config ui list, /claude config ui remove <name>, /claude config ui run <name> (run also says yes to a waiting widget)")
end

function W.Remove(name, ctx)
	local item = FindItem(name)
	if not item then
		if not Quiet(ctx) then Print("no widget " .. tostring(name)) end
		return
	end
	DB().removed[name] = item.rev
	if running[name] then W.Stop(running[name]) end
	if Quiet(ctx) then return end
	Report(string.format("%s removed. It stays off until the agent sends a new version; /claude config ui run %s brings it back.", name, name))
end

function W.Run(name)
	local item = FindItem(name)
	if not item then Print("no widget " .. tostring(name)); return end
	DB().removed[name] = nil
	Approve(item)
	if running[name] then W.Stop(running[name]) end
	W.Start(item, true)
end

function W.Show(data, ctx)
	local item = type(data) == "table" and FindItem(data.name)
	if not item or not SameCode(item, data) then
		W.PromptNext()
		return false
	end
	DB().removed[item.name] = nil
	failures[item.name] = nil
	return W.Approve(data, ctx)
end

function W.Rows()
	local rows = {}
	for _, item in ipairs(Items()) do
		local status, err = W.Status(item.name)
		rows[#rows + 1] = { name = item.name, title = item.title, rev = item.rev, source = item.source, status = status, err = err }
	end
	return rows
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
