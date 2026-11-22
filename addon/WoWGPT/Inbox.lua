local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Inbox.lua"

WoWGPT_Inbox = WoWGPT_Inbox or { id = 0, replies = {} }
