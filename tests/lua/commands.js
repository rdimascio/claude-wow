'use strict';

const REST = [
  '',
  'on',
  'off',
  'copy',
  'all',
  'pixel',
  'reload',
  'summary',
  'full',
  'short',
  '100',
  '1k',
  'foo',
  'foo bar',
  'undo',
  'next',
  'ore on',
  'left',
  'on foo',
  'test',
  'list',
  'pane left',
  'quest x',
  'filter all',
  'show x',
  'nav x 3',
  'herb off',
  'follow on',
];

const CONFIG_REST = [
  '',
  'all',
  'ALL',
  'roll',
  'roll on',
  'ROLL ON',
  'roll maybe',
  'macro',
  'macro undo',
  'macro redo',
  'ctx on',
  'Ctx off',
  'context 1k',
  'toasts off',
  'toasts list',
  'achievements list',
  'bind anything at all',
  'foo',
  'ui',
  'ui dim 50',
  'ui list',
  'ui run x',
  'ui foo',
  'signal on',
  'plugin ask',
  'plugin a b',
  'echo 300',
  'probe chatlog 2048',
  'diag copy',
  'diag foo',
  'map',
  'map ore on',
  'dm',
  'new',
];

const luaList = list => '{' + list.map(s => JSON.stringify(s)).join(', ') + '}';

const DUMP_LUA = `
local ns = ...
local Cli, ClaudeWoW = ns.Cli, ns.ClaudeWoW
local REST = ${luaList(REST)}
local CONFIG_REST = ${luaList(CONFIG_REST)}

local function Str(s)
	s = s:gsub('[%c"\\\\]', function(ch)
		if ch == '"' then return '\\\\"' end
		if ch == "\\\\" then return "\\\\\\\\" end
		if ch == "\\n" then return "\\\\n" end
		if ch == "\\t" then return "\\\\t" end
		if ch == "\\r" then return "\\\\r" end
		return string.format("\\\\u%04x", ch:byte())
	end)
	return '"' .. s .. '"'
end

local function Keys(t)
	local ks = {}
	for k in pairs(t) do ks[#ks + 1] = k end
	table.sort(ks)
	return ks
end

local function Enc(v)
	local t = type(v)
	if t == "string" then return Str(v) end
	if t == "number" or t == "boolean" then return tostring(v) end
	if t == "nil" then return "null" end
	if #v > 0 or next(v) == nil then
		local parts = {}
		for i = 1, #v do parts[i] = Enc(v[i]) end
		return "[" .. table.concat(parts, ",") .. "]"
	end
	local parts = {}
	for _, k in ipairs(Keys(v)) do parts[#parts + 1] = Str(tostring(k)) .. ":" .. Enc(v[k]) end
	return "{" .. table.concat(parts, ",") .. "}"
end

local function Bools(t)
	local o = {}
	for k, v in pairs(t) do
		if v == true then o[#o + 1] = k end
	end
	table.sort(o)
	return o
end

local accepts = {}
for _, verb in ipairs(Cli.CommandVerbs()) do
	local row = {}
	for _, rest in ipairs(REST) do row[rest] = Cli.IsCommand(verb, rest) == true end
	accepts[verb] = row
end

local moduleAccepts, moduleSubcommands = {}, {}
for _, verb in ipairs(Keys(Cli.MODULE_SUBCOMMANDS)) do
	local row = {}
	for _, rest in ipairs(REST) do row[rest] = Cli.IsModuleCommand(verb, rest) == true end
	moduleAccepts[verb] = row
	moduleSubcommands[verb] = Keys(Cli.MODULE_SUBCOMMANDS[verb])
end

local configAccepts = {}
for _, rest in ipairs(CONFIG_REST) do configAccepts[rest] = Cli.IsConfig(rest) == true end

COMMANDS_DUMP = Enc({
	help = ClaudeWoW.HELP,
	rollHelp = ClaudeWoW.ROLL_HELP,
	commandVerbs = Cli.CommandVerbs(),
	claudeVerbs = Bools(Cli.CLAUDE_VERBS),
	configKeys = Cli.CONFIG_KEYS,
	configHelp = Cli.CONFIG_HELP,
	configDev = Bools(Cli.CONFIG_DEV),
	configRetired = Bools(Cli.CONFIG_RETIRED),
	configAliases = Cli.CONFIG_ALIASES,
	moduleSubcommands = moduleSubcommands,
	accepts = accepts,
	moduleAccepts = moduleAccepts,
	configAccepts = configAccepts,
})
`;

function dumpCommands(vm) {
  vm.run(DUMP_LUA, { ns: true });
  return JSON.parse(vm.evaluate('COMMANDS_DUMP'));
}

module.exports = { REST, CONFIG_REST, dumpCommands };
