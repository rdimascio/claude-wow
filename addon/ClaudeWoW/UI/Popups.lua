local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "UI\\Popups.lua"

local ClaudeWoW = ns.ClaudeWoW
local run, Q, Cli, Whisper = ns.run, ns.Q, ns.Cli, ns.Whisper
local Display, Trim = ns.Display, ns.Trim
local FindChat, ActiveChat = ns.FindChat, ns.ActiveChat

StaticPopupDialogs["CLAUDEWOW_FOLDER"] = {
	text = "Project for this chat\n\nType a full path, a path that starts with ~, or a folder name inside %s.\nLeave it empty for no project. A change starts a new session with the agent.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 320,
	maxLetters = 250,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.cwd or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if not (chat and box) then return end
		Cli.KeepPlayerRoute(chat)
		if Cli.IsNoProject(box:GetText()) then
			Cli.PickProject(chat, "none")
		else
			ClaudeWoW.SetFolder(box:GetText(), chat)
		end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_FOLDER"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box) box:GetParent():Hide() end,
}

Q.PROJECT_BASE_UNKNOWN = "the companion app's folder"

function ClaudeWoW.FolderPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_FOLDER", run.bridgeCwd or Q.PROJECT_BASE_UNKNOWN, nil, { id = c.id, cwd = c.cwd })
end

StaticPopupDialogs["CLAUDEWOW_AGENT"] = {
	text = "Agent for this chat\n\nOne of: %s.\nEmpty = the companion app's default (%s). Changing it starts a fresh session.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 200,
	maxLetters = 32,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.agent or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if chat and box then ClaudeWoW.SetAgent(Trim(box:GetText() or "") == "" and "default" or box:GetText(), chat) end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_AGENT"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box) box:GetParent():Hide() end,
}

-- Agent dialog for a chat (the active one when no id is given).
function ClaudeWoW.AgentPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show(
		"CLAUDEWOW_AGENT",
		ns.AgentList(),
		run.bridgeAgent and ns.AgentName(run.bridgeAgent) or "unknown until connected",
		{ id = c.id, agent = c.agent or "" }
	)
end

StaticPopupDialogs["CLAUDEWOW_PLUGIN"] = {
	text = "Plugin for this chat\n\nOne of: %s.\nEmpty = the companion app's default (%s). Changing it starts a fresh session.",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	editBoxWidth = 200,
	maxLetters = 32,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.plugin or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		if chat and box then ClaudeWoW.SetPlugin(Trim(box:GetText() or "") == "" and "default" or box:GetText(), chat) end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_PLUGIN"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box) box:GetParent():Hide() end,
}

-- Plugin dialog for a chat (the active one when no id is given).
function ClaudeWoW.PluginPrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_PLUGIN", ns.PluginList(), ns.BridgePluginName(), { id = c.id, plugin = c.plugin or "" })
end

StaticPopupDialogs["CLAUDEWOW_RENAME"] = {
	text = "Rename this chat",
	button1 = OKAY,
	button2 = CANCEL,
	hasEditBox = 1,
	maxLetters = 24,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnShow = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		if box then
			box:SetText(data and data.name or "")
			box:HighlightText()
			box:SetFocus()
		end
	end,
	OnAccept = function(dialog, data)
		local box = dialog.GetEditBox and dialog:GetEditBox() or dialog.editBox
		local chat = data and FindChat(data.id)
		local name = box and Trim(box:GetText() or "") or ""
		if chat and name ~= "" then
			chat.name = name:sub(1, 24)
			chat.titleFor = nil
			Whisper.Retitle(chat)
			ClaudeWoW.Render()
		end
	end,
	EditBoxOnEnterPressed = function(box)
		local dialog = box:GetParent()
		StaticPopupDialogs["CLAUDEWOW_RENAME"].OnAccept(dialog, dialog.data)
		dialog:Hide()
	end,
	EditBoxOnEscapePressed = function(box) box:GetParent():Hide() end,
}

-- Rename dialog for a chat (the active one when no id is given).
function ClaudeWoW.RenamePrompt(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_RENAME", nil, nil, { id = c.id, name = c.name })
end
ClaudeWoW.RenameActive = ClaudeWoW.RenamePrompt

-- The trash can on a chat row asks first; /claude-wow delete does not.
StaticPopupDialogs["CLAUDEWOW_DELETE"] = {
	text = 'Delete chat "%s"?\n\nIts transcript goes away (the last chat is cleared instead of removed).',
	button1 = "Delete",
	button2 = CANCEL,
	showAlert = true,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data and FindChat(data.id) then ClaudeWoW.DeleteChat(data.id) end
	end,
}

function ClaudeWoW.ConfirmDelete(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_DELETE", Display(c.name), nil, { id = c.id })
end

StaticPopupDialogs["CLAUDEWOW_CLEAR"] = {
	text = 'Clear the messages in "%s"?\n\nThe chat and its session stay; only the transcript shown here goes away.',
	button1 = "Clear",
	button2 = CANCEL,
	showAlert = true,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data and FindChat(data.id) then ClaudeWoW.ClearChat(data.id) end
	end,
}

function ClaudeWoW.ConfirmClear(id)
	local c = (id and FindChat(id)) or ActiveChat()
	if not c then return end
	StaticPopup_Show("CLAUDEWOW_CLEAR", Display(c.name), nil, { id = c.id })
end

StaticPopupDialogs["CLAUDEWOW_MACRO"] = {
	text = "%s",
	button1 = "Create Macro",
	button2 = CANCEL,
	timeout = 0,
	whileDead = true,
	hideOnEscape = true,
	OnAccept = function(dialog, data)
		if data then ClaudeWoW.InstallMacro(data, true) end
	end,
}

function Q.ShowMacroPopup(text, m, index)
	StaticPopupDialogs["CLAUDEWOW_MACRO"].button1 = index and "Update Macro" or "Create Macro"
	StaticPopup_Show("CLAUDEWOW_MACRO", text, nil, m)
end
