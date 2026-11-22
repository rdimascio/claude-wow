local _, ns = ...
if not ns.Try then return end
ns.files[#ns.files + 1] = "Core\\Log.lua"

function ns.Print(msg) print(ns.PREFIX .. msg) end

function ns.Say(msg)
	if WoWGPT and type(WoWGPT.Print) == "function" then return WoWGPT.Print(msg) end
	ns.Print(msg)
end
