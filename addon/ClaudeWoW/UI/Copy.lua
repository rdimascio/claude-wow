local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "UI\\Copy.lua"

local ClaudeWoW = ns.ClaudeWoW
local ui = ns.ui

-- Copy box (/claude-wow copy): a selectable EditBox with the last reply pre-highlighted for Ctrl+C.
function ClaudeWoW.ShowCopy(text)
	if not ui.copy then
		local cf = CreateFrame("Frame", "ClaudeWoWCopy", UIParent, "BackdropTemplate")
		cf:SetSize(560, 320)
		cf:SetPoint("CENTER")
		cf:SetFrameStrata("FULLSCREEN_DIALOG")
		cf:SetMovable(true)
		cf:SetClampedToScreen(true)
		cf:EnableMouse(true)
		cf:RegisterForDrag("LeftButton")
		cf:SetScript("OnDragStart", cf.StartMoving)
		cf:SetScript("OnDragStop", cf.StopMovingOrSizing)
		cf:SetBackdrop(ns.BACKDROP)
		cf:SetBackdropColor(0.05, 0.05, 0.07, 0.97)
		cf:SetBackdropBorderColor(0.6, 0.6, 0.6, 1)
		tinsert(UISpecialFrames, "ClaudeWoWCopy")

		local t = cf:CreateFontString(nil, "OVERLAY", "GameFontNormal")
		t:SetPoint("TOPLEFT", cf, "TOPLEFT", 14, -12)
		t:SetText("Text is selected - press Ctrl+C, then Esc")

		local x = CreateFrame("Button", nil, cf, "UIPanelCloseButton")
		x:SetPoint("TOPRIGHT", cf, "TOPRIGHT", -4, -4)

		local sc = CreateFrame("ScrollFrame", "ClaudeWoWCopyScroll", cf, "UIPanelScrollFrameTemplate")
		sc:SetPoint("TOPLEFT", cf, "TOPLEFT", 14, -36)
		sc:SetPoint("BOTTOMRIGHT", cf, "BOTTOMRIGHT", -32, 14)
		local eb = CreateFrame("EditBox", "ClaudeWoWCopyBox", sc)
		eb:SetMultiLine(true)
		eb:SetAutoFocus(false)
		eb:SetFontObject(ChatFontNormal)
		eb:SetMaxLetters(0)
		eb:SetSize(500, 260)
		eb:SetScript("OnEscapePressed", function() cf:Hide() end)
		sc:SetScrollChild(eb)
		sc:HookScript("OnSizeChanged", function(self, w) eb:SetWidth(w) end)
		ui.copy, ui.copyBox = cf, eb
	end
	ui.copyBox:SetText(text)
	ui.copy:Show()
	ui.copyBox:SetFocus()
	ui.copyBox:HighlightText()
end
