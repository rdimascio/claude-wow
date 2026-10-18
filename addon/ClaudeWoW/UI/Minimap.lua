local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "UI\\Minimap.lua"

local ClaudeWoW = ns.ClaudeWoW
local ui, Q = ns.ui, ns.Q
local ActiveChat = ns.ActiveChat
local STATE_ICON = ns.STATE_ICON

Q.MINIMAP_NAME = "ClaudeWoWMinimapButton"
Q.MINIMAP_SIZE = 31
Q.MINIMAP_ANGLE_DEFAULT = 225
Q.MINIMAP_EDGE_PAD = 5
Q.MINIMAP_DIAGONAL_INSET = 10
Q.MINIMAP_ICON = "Interface\\AddOns\\ClaudeWoW\\MinimapIcon"
Q.MINIMAP_ICON_MASK = "Interface\\CharacterFrame\\TempPortraitAlphaMask"
Q.MINIMAP_ICON_INSET = { 0.05, 0.95, 0.05, 0.95 }
Q.MINIMAP_ICON_PRESSED = { 0, 1, 0, 1 }
Q.MINIMAP_PORTRAIT_INSET = { 0.2, 0.8, 0.2, 0.8 }
Q.MINIMAP_PORTRAIT_PRESSED = { 0.18, 0.82, 0.18, 0.82 }
Q.MINIMAP_BORDER = "Interface\\Minimap\\MiniMap-TrackingBorder"
Q.MINIMAP_BACKGROUND = "Interface\\Minimap\\UI-Minimap-Background"
Q.MINIMAP_HIGHLIGHT = "Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight"
Q.MINIMAP_HINT_COLOR = { 0.1, 1, 0.1 }
Q.MINIMAP_HINT_LEFT = "Left-click: open or close"
Q.MINIMAP_HINT_RIGHT = "Right-click: options"
Q.MINIMAP_ROUND_QUADRANTS = {
	ROUND = { true, true, true, true },
	SQUARE = { false, false, false, false },
	["CORNER-TOPLEFT"] = { false, false, false, true },
	["CORNER-TOPRIGHT"] = { false, false, true, false },
	["CORNER-BOTTOMLEFT"] = { false, true, false, false },
	["CORNER-BOTTOMRIGHT"] = { true, false, false, false },
	["SIDE-LEFT"] = { false, true, false, true },
	["SIDE-RIGHT"] = { true, false, true, false },
	["SIDE-TOP"] = { false, false, true, true },
	["SIDE-BOTTOM"] = { true, true, false, false },
	["TRICORNER-TOPLEFT"] = { false, true, true, true },
	["TRICORNER-TOPRIGHT"] = { true, false, true, true },
	["TRICORNER-BOTTOMLEFT"] = { true, true, false, true },
	["TRICORNER-BOTTOMRIGHT"] = { true, true, true, false },
}
Q.MINIMAP_LAYOUT_MAINLINE = { border = 50, background = 24, icon = 18, centered = true }
Q.MINIMAP_LAYOUT_CLASSIC = { border = 53, background = 20, backgroundX = 7, backgroundY = -5, icon = 17, iconX = 7, iconY = -6 }
Q.MINIMAP_DOT_SIZE = 8
Q.MINIMAP_DOT_X, Q.MINIMAP_DOT_Y = -2, 2
Q.MINIMAP_DOT_SUBLEVEL = 7
Q.MINIMAP_PULSE_LOW, Q.MINIMAP_PULSE_SECONDS = 0.15, 0.8
Q.MINIMAP_WORKING_GLOW = 0.4

function Q.MinimapButtonOn() return ns.db.settings.minimap ~= false end

function Q.MinimapAngle() return tonumber(ns.db.settings.minimapAngle) or Q.MINIMAP_ANGLE_DEFAULT end

function Q.MinimapShape()
	if type(GetMinimapShape) ~= "function" then return "ROUND" end
	local ok, shape = pcall(GetMinimapShape)
	return ok and Q.MINIMAP_ROUND_QUADRANTS[shape] and shape or "ROUND"
end

function Q.MinimapOffset(angle, width, height, shape)
	local radians = math.rad(angle)
	local x, y, quadrant = math.cos(radians), math.sin(radians), 1
	if x < 0 then quadrant = quadrant + 1 end
	if y > 0 then quadrant = quadrant + 2 end
	local w, h = width / 2 + Q.MINIMAP_EDGE_PAD, height / 2 + Q.MINIMAP_EDGE_PAD
	if Q.MINIMAP_ROUND_QUADRANTS[shape or "ROUND"][quadrant] then return x * w, y * h end
	local diagonalW = math.sqrt(2 * w * w) - Q.MINIMAP_DIAGONAL_INSET
	local diagonalH = math.sqrt(2 * h * h) - Q.MINIMAP_DIAGONAL_INSET
	return math.max(-w, math.min(x * diagonalW, w)), math.max(-h, math.min(y * diagonalH, h))
end

function Q.PlaceMinimapButton(button)
	local x, y = Q.MinimapOffset(Q.MinimapAngle(), Minimap:GetWidth(), Minimap:GetHeight(), Q.MinimapShape())
	button:ClearAllPoints()
	button:SetPoint("CENTER", Minimap, "CENTER", x, y)
end

function Q.CursorAngle()
	local mx, my = Minimap:GetCenter()
	local px, py = GetCursorPosition()
	if not (mx and my and px and py) then return nil end
	local scale = Minimap:GetEffectiveScale()
	local atan2 = math.atan2 or math.atan
	return math.deg(atan2(py / scale - my, px / scale - mx)) % 360
end

function Q.MinimapDragUpdate(button)
	local angle = Q.CursorAngle()
	if not angle then return end
	ns.db.settings.minimapAngle = angle
	Q.PlaceMinimapButton(button)
end

function Q.PlainStatus(c)
	local state = Q.StatusState(c)
	if state == "working" then return Q.STATUS_WORKING end
	if state == "connecting" then return Q.STATUS_CONNECTING end
	if state == "failed" then return Q.STATUS_NO_ANSWER end
	if state == "down" then return Q.STATUS_UNREACHABLE end
	if state == "reply" then return Q.STATUS_REPLY end
	return Q.STATUS_READY
end

function Q.MinimapTooltip(button)
	if button.dragging then return end
	local green = Q.MINIMAP_HINT_COLOR
	GameTooltip:SetOwner(button, "ANCHOR_LEFT")
	GameTooltip:SetText(ClaudeWoW.PRODUCT)
	GameTooltip:AddLine(Q.PlainStatus(ActiveChat()), 1, 1, 1, true)
	local activity = Q.ActivityText(Q.ChatActivity())
	if activity ~= "" then GameTooltip:AddLine(activity, 1, 0.82, 0, true) end
	Q.StatusTooltip()
	GameTooltip:AddLine(" ")
	GameTooltip:AddLine(Q.MINIMAP_HINT_LEFT, green[1], green[2], green[3])
	GameTooltip:AddLine(Q.MINIMAP_HINT_RIGHT, green[1], green[2], green[3])
	GameTooltip:Show()
end

function Q.MinimapClick(_, mouseButton)
	if mouseButton == "RightButton" then
		ClaudeWoW.ShowOptions()
	else
		ClaudeWoW.ToggleWorkspace()
	end
end

function Q.MinimapDragStart(button)
	button.dragging = true
	button:LockHighlight()
	Q.MinimapMouseDown(button)
	GameTooltip:Hide()
	button:SetScript("OnUpdate", Q.MinimapDragUpdate)
end

function Q.MinimapDragStop(button)
	button:SetScript("OnUpdate", nil)
	button.dragging = nil
	button:UnlockHighlight()
	Q.MinimapMouseUp(button)
	Q.PlaceMinimapButton(button)
end

function Q.MinimapLayout()
	if WOW_PROJECT_ID ~= nil and WOW_PROJECT_ID == WOW_PROJECT_MAINLINE then return Q.MINIMAP_LAYOUT_MAINLINE end
	return Q.MINIMAP_LAYOUT_CLASSIC
end

function Q.SetMinimapIcon(icon)
	local ok, found = pcall(icon.SetTexture, icon, Q.MINIMAP_ICON)
	if ok and found ~= false then return Q.MINIMAP_ICON end
	icon:SetTexture(Q.PORTRAIT)
	if type(icon.SetMask) == "function" then pcall(icon.SetMask, icon, Q.MINIMAP_ICON_MASK) end
	return Q.PORTRAIT
end

function Q.UpdateMinimapIconCoord(button)
	local portrait = button.iconFile == Q.PORTRAIT
	local rest = portrait and Q.MINIMAP_PORTRAIT_INSET or Q.MINIMAP_ICON_INSET
	local pressed = portrait and Q.MINIMAP_PORTRAIT_PRESSED or Q.MINIMAP_ICON_PRESSED
	local coords = button.isMouseDown and pressed or rest
	button.icon:SetTexCoord(coords[1], coords[2], coords[3], coords[4])
end

function Q.MinimapMouseDown(button)
	button.isMouseDown = true
	Q.UpdateMinimapIconCoord(button)
end

function Q.MinimapMouseUp(button)
	button.isMouseDown = false
	Q.UpdateMinimapIconCoord(button)
end

function Q.BuildMinimapButton()
	if ui.minimap then return ui.minimap end
	if type(Minimap) ~= "table" then return nil end
	local layout = Q.MinimapLayout()
	local button = CreateFrame("Button", Q.MINIMAP_NAME, Minimap)
	button:SetSize(Q.MINIMAP_SIZE, Q.MINIMAP_SIZE)
	button:SetFrameStrata("MEDIUM")
	button:SetFrameLevel(8)
	button:RegisterForClicks("AnyUp")
	button:RegisterForDrag("LeftButton")
	button:SetHighlightTexture(Q.MINIMAP_HIGHLIGHT)

	local border = button:CreateTexture(nil, "OVERLAY")
	border:SetSize(layout.border, layout.border)
	border:SetTexture(Q.MINIMAP_BORDER)
	border:SetPoint("TOPLEFT", button, "TOPLEFT", 0, 0)
	button.border = border

	local background = button:CreateTexture(nil, "BACKGROUND")
	background:SetSize(layout.background, layout.background)
	background:SetTexture(Q.MINIMAP_BACKGROUND)
	local icon = button:CreateTexture(nil, "ARTWORK")
	icon:SetSize(layout.icon, layout.icon)
	button.iconFile = Q.SetMinimapIcon(icon)
	if layout.centered then
		background:SetPoint("CENTER", button, "CENTER", 0, 0)
		icon:SetPoint("CENTER", button, "CENTER", 0, 0)
	else
		background:SetPoint("TOPLEFT", button, "TOPLEFT", layout.backgroundX, layout.backgroundY)
		icon:SetPoint("TOPLEFT", button, "TOPLEFT", layout.iconX, layout.iconY)
	end
	button.background, button.icon = background, icon
	button.isMouseDown = false
	Q.UpdateMinimapIconCoord(button)
	Q.BuildMinimapSignal(button)

	button:SetScript("OnClick", Q.MinimapClick)
	button:SetScript("OnDragStart", Q.MinimapDragStart)
	button:SetScript("OnDragStop", Q.MinimapDragStop)
	button:SetScript("OnMouseDown", Q.MinimapMouseDown)
	button:SetScript("OnMouseUp", Q.MinimapMouseUp)
	button:SetScript("OnEnter", Q.MinimapTooltip)
	button:SetScript("OnLeave", function() GameTooltip:Hide() end)
	ui.minimap = button
	Q.PlaceMinimapButton(button)
	Q.ApplyMinimapButton()
	return button
end

function Q.BuildMinimapSignal(button)
	local glow = button:CreateTexture(nil, "OVERLAY")
	glow:SetAllPoints(button)
	glow:SetTexture(Q.MINIMAP_HIGHLIGHT)
	glow:SetBlendMode("ADD")
	glow:Hide()
	button.glow = glow
	local ok, pulse = pcall(function()
		local g = glow:CreateAnimationGroup()
		local fade = g:CreateAnimation("Alpha")
		fade:SetFromAlpha(1)
		fade:SetToAlpha(Q.MINIMAP_PULSE_LOW)
		fade:SetDuration(Q.MINIMAP_PULSE_SECONDS)
		fade:SetOrder(1)
		local back = g:CreateAnimation("Alpha")
		back:SetFromAlpha(Q.MINIMAP_PULSE_LOW)
		back:SetToAlpha(1)
		back:SetDuration(Q.MINIMAP_PULSE_SECONDS)
		back:SetOrder(2)
		g:SetLooping("REPEAT")
		return g
	end)
	if ok then button.pulse = pulse end
	local dot = button:CreateTexture(nil, "OVERLAY", nil, Q.MINIMAP_DOT_SUBLEVEL)
	dot:SetSize(Q.MINIMAP_DOT_SIZE, Q.MINIMAP_DOT_SIZE)
	dot:SetPoint("BOTTOMRIGHT", button, "BOTTOMRIGHT", Q.MINIMAP_DOT_X, Q.MINIMAP_DOT_Y)
	dot:SetTexture(STATE_ICON.unknown)
	button.dot = dot
	ui.minimapDot = dot
end

function Q.MinimapSignal()
	if ui.frame and ui.frame:IsShown() then return "idle" end
	local unread, working = Q.ChatActivity()
	if unread > 0 then return "reply" end
	if working > 0 then return "working" end
	return "idle"
end

function Q.UpdateMinimapSignal()
	local button = ui.minimap
	if not (button and button.glow and ns.db) then return end
	local signal = Q.MinimapSignal()
	button.signal = signal
	if signal == "reply" then
		button.glow:SetAlpha(1)
		button.glow:Show()
		if button.pulse and not button.pulse:IsPlaying() then button.pulse:Play() end
		return
	end
	if button.pulse then button.pulse:Stop() end
	button.glow:SetAlpha(Q.MINIMAP_WORKING_GLOW)
	button.glow:SetShown(signal == "working")
end

function Q.ApplyMinimapButton()
	if not ui.minimap then return end
	ui.minimap:SetShown(Q.MinimapButtonOn())
	ClaudeWoW.UpdateDot()
	Q.UpdateMinimapSignal()
end
