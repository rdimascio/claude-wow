'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVM } = require('./lua/vm');

const SOUND_STUB = `
VOICE = { played = {} }
local playSignalFile = PlaySoundFile
PlaySoundFile = function(file, channel)
  if type(file) == "number" then
    table.insert(VOICE.played, file)
    return true, 100 + #VOICE.played
  end
  return playSignalFile(file, channel)
end
StopSound = function() end
UnitRace = function() return "Human", "Human" end
UnitSex = function() return 2 end
STUB.played = {}
SOUNDKIT = { UI_EPICLOOT_TOAST = 31578, UI_NEED_ROLL_POSITIVE = 229319, LOOT_WINDOW_COIN_SOUND = 120, UI_NEED_ROLL_NEGATIVE = 229321 }
local SOUND_NAMES = {}
for name, id in pairs(SOUNDKIT) do SOUND_NAMES[id] = name end
function PlaySound(id) if SOUND_NAMES[id] then table.insert(STUB.played, SOUND_NAMES[id]) end end
`;

function newVM(savedVariables = '') {
  const vm = createVM();
  vm.run(SOUND_STUB);
  if (savedVariables) vm.run(savedVariables);
  vm.loadAddon();
  vm.login();
  vm.run('STUB.RunTimers()');
  vm.run('STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} } end');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  vm.run('VOICE.played = {}; STUB.played = {}');
  return vm;
}

test('loading every file in .toc order and logging in registers no event the client blocks, with default settings or with roast on', () => {
  const defaults = newVM();
  assert.equal(defaults.num('#STUB.actionBlocked'), 0, defaults.evaluate('table.concat(STUB.actionBlocked, "; ")'));
  defaults.run('SlashCmdList.CLAUDE("config roast on")');
  defaults.run('STUB.FireEvent("UNIT_COMBAT", "player", "WOUND", "", 40, 1); STUB.FireEvent("PLAYER_DEAD")');
  defaults.run('SlashCmdList.CLAUDE("config roast off")');
  assert.equal(defaults.num('#STUB.actionBlocked'), 0, defaults.evaluate('table.concat(STUB.actionBlocked, "; ")'));

  const roastOn = newVM('ClaudeWoWDB = { roast = { on = true } }');
  assert.equal(roastOn.evaluate('ClaudeWoWRoast.Listening()'), 'true');
  roastOn.run('STUB.FireEvent("PLAYER_ENTERING_WORLD"); STUB.FireEvent("UNIT_COMBAT", "player", "WOUND", "CRITICAL", 90, 4); STUB.FireEvent("PLAYER_DEAD")');
  assert.equal(roastOn.num('#STUB.actionBlocked'), 0, roastOn.evaluate('table.concat(STUB.actionBlocked, "; ")'));
});
