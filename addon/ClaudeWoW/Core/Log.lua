local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Core\\Log.lua"

function ns.Print(msg) print(ns.PREFIX .. msg) end

function ns.Say(msg)
	if ClaudeWoW and type(ClaudeWoW.Print) == "function" then return ClaudeWoW.Print(msg) end
	ns.Print(msg)
end
