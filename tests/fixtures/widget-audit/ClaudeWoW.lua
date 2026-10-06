
ClaudeWoWDB = {
	["settings"] = {
		["mode"] = "pixel",
		["whisper"] = true,
	},
	["chats"] = {
		{
			["history"] = {
				{
					["role"] = "user",
					["text"] = "ClaudeWoWWidgetDB = {\n}",
				}, -- [1]
			},
		}, -- [1]
	},
}
ClaudeWoWMapDB = {
}
ClaudeWoWWidgetDB = {
	["removed"] = {
	},
	["globals"] = {
		["admitted"] = {
			"C_Fake.GetThing", -- [1]
			"GameFontNormal", -- [2]
			"GetTime", -- [3]
			"PlaySound", -- [4]
			"UnitHealth", -- [5]
			"UnitSelectRole", -- [6]
		},
		["refused"] = {
			"C_Fake.DropThing", -- [1]
			"C_Map.GetBestMapForUnit", -- [2]
			"GetSecretThing", -- [3]
			"IsAuditReady", -- [4]
			"UnitSetRole", -- [5]
		},
		["refusedFonts"] = {
			"OddFontObject", -- [1]
		},
		["version"] = "1.15.9",
		["build"] = "64000",
		["interface"] = 11509,
		["at"] = 1790000000,
		["total"] = 12,
		["saved"] = 12,
		["admittedCount"] = 6,
		["refusedCount"] = 6,
		["truncated"] = false,
	},
	["data"] = {
		["meter"] = {
			["x"] = -12.5,
		},
	},
}
