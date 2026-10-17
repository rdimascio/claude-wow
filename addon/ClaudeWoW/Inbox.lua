local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Inbox.lua"

ClaudeWoW_Inbox = ClaudeWoW_Inbox or { id = 0, replies = {} }
