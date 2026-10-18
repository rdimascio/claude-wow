'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createVM } = require('./lua/vm');
const { dumpCommands } = require('./lua/commands');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'commands.json'), 'utf8'));

const NON_VERB_ROWS = [
  '/claude <text>',
  '/claude -c [text]',
  '/claude -r [id|name|n] [text]',
  '/claude -r all',
  '/claude -n <name> [text]',
  '/claude --model <model> [text]',
  '/claude --effort <level> [text]',
  '/claude --project <name|path|none> [text]',
  '/claude --permission-mode <mode>',
  '/claude --add-dir <path> [text]',
  '/claude --agent <name> [text]',
  '/r <text>',
  '/w <agent> <text>',
  '/claude config [key] [value]',
];

function newVM() {
  const vm = createVM();
  vm.loadAddon();
  vm.login();
  return vm;
}

const lines = s => (s === '' ? [] : s.split('\n'));

test('the registry derives the help page, the verb tables, the config keys and every argument check exactly as the hand-written tables did', () => {
  assert.deepEqual(dumpCommands(newVM()), FIXTURE);
});

test('every verb /claude, /claude-wow or /claude config accepts has an argument checker and a runner, and every module verb has its subcommands and module', () => {
  const vm = newVM();
  vm.run(
    `local ns = ...
    local bad = {}
    for _, e in ipairs(ns.Commands) do
      if e.args ~= nil and type(e.run) ~= "function" then bad[#bad + 1] = e.verb .. ": args without run" end
      if e.module and (type(e.module) ~= "table" or type(e.moduleRun) ~= "function") then bad[#bad + 1] = e.verb .. ": module without moduleRun" end
      if (e.verbs or e.config) and e.args == nil and not e.module then bad[#bad + 1] = e.verb .. ": accepted without args or module" end
      if e.config and e.config.retired == nil and type(e.config.help) ~= "string" then bad[#bad + 1] = e.verb .. ": config key without help" end
    end
    COMMANDS_BAD = table.concat(bad, "\\n")
    COMMANDS_N = #ns.Commands`,
    { ns: true },
  );
  assert.deepEqual(lines(vm.evaluate('COMMANDS_BAD')), []);
  assert.equal(vm.num('COMMANDS_N'), FIXTURE.commandVerbs.length + 3, 'every argument-taking verb, plus the bare toggle, dm and stream');
});

test('every help row names a verb in the registry that carries its row, or is one of the documented flag, whisper and config rows', () => {
  const vm = newVM();
  vm.run(
    `local ns = ...
    local byVerb = {}
    for _, e in ipairs(ns.Commands) do byVerb[e.verb] = e end
    local bad, literal, verbs = {}, {}, {}
    for _, section in ipairs(ns.HelpLayout) do
      for _, item in ipairs(section.rows or {}) do
        if type(item) == "table" then
          literal[#literal + 1] = item[1]
        elseif not (byVerb[item] and type(byVerb[item].help) == "table") then
          bad[#bad + 1] = item
        else
          verbs[#verbs + 1] = item
        end
      end
    end
    for _, e in ipairs(ns.Commands) do
      if e.help then
        local shown = false
        for _, v in ipairs(verbs) do if v == e.verb then shown = true end end
        if not shown then bad[#bad + 1] = e.verb .. " has a help row the page never shows" end
      end
    end
    HELP_BAD = table.concat(bad, "\\n")
    HELP_LITERAL = table.concat(literal, "\\n")`,
    { ns: true },
  );
  assert.deepEqual(lines(vm.evaluate('HELP_BAD')), []);
  assert.deepEqual(lines(vm.evaluate('HELP_LITERAL')), NON_VERB_ROWS);
});

test('the old table names still resolve for Help.lua, the Options page and the dev console', () => {
  const vm = newVM();
  vm.run(
    `local ns = ...
    local Cli = ns.Cli
    OLD_NAMES = table.concat({
      tostring(type(ns.ClaudeWoW.HELP)), tostring(type(Cli.CLAUDE_VERBS)), tostring(type(Cli.CONFIG_KEYS)), tostring(type(Cli.CONFIG_HELP)),
      tostring(type(Cli.CONFIG_DEV)), tostring(type(Cli.CONFIG_RETIRED)), tostring(type(Cli.CONFIG_ALIASES)), tostring(type(Cli.MODULE_SUBCOMMANDS)),
      tostring(type(Cli.MODULE_COMMANDS)), tostring(type(ns.ClaudeWoW.ParseCli)), tostring(type(ns.ClaudeWoW.RunCli)), tostring(type(ns.ClaudeWoW.Config)),
      tostring(type(ns.RunCommand)), tostring(type(Cli.IsCommand)),
    }, ",")`,
    { ns: true },
  );
  assert.equal(vm.evaluate('OLD_NAMES'), 'table,table,table,table,table,table,table,table,table,function,function,function,function,function');
});
