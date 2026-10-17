'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVM } = require('./lua/vm');

const ADDON_FILES = ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua', 'Map.lua', 'Achievements.lua'];

const SOUND_STUB = `
STUB.soundFiles, STUB.soundKits = {}, {}
function PlaySoundFile(path, channel)
	table.insert(STUB.soundFiles, tostring(path))
	if STUB.sounds[path] then return true, 1 end
	return false
end
function PlaySound(kit, channel) table.insert(STUB.soundKits, kit) return true end
`;

function newVM({ beforeLogin = '' } = {}) {
  const vm = createVM();
  vm.run(SOUND_STUB);
  vm.loadAddon(ADDON_FILES);
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  if (beforeLogin) vm.run(beforeLogin);
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
  const prints = () => {
    vm.run('RESULT = table.concat(STUB.prints, "\\n")');
    return vm.evaluate('RESULT') || '';
  };
  return { ...vm, prints };
}

const NOW = 'time()';
const entry = (seq, id, title, ageSeconds = 5) =>
  `{ seq = ${seq}, id = "${id}", title = "${title}", text = "t ${id}", points = 10, icon = "Interface\\\\Icons\\\\INV_Misc_Note_01", at = ${NOW} - ${ageSeconds} }`;
const earned = (id, title) =>
  `{ id = "${id}", title = "${title}", text = "t ${id}", points = 10, icon = "Interface\\\\Icons\\\\INV_Misc_Note_01", at = ${NOW} - 5, count = 1 }`;
const payload = (seq, recent, earnedList = []) =>
  `{ seq = ${seq}, points = ${earnedList.length * 10}, total = 14, recent = { ${recent.join(', ')} }, earned = { ${earnedList.join(', ')} } }`;

test('toasts queue one after another and fade out on their own', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWAchievements.Sync(${payload(2, [entry(2, 'b', 'Second'), entry(1, 'a', 'First')])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'First', 'oldest first');
  assert.equal(vm.evaluate('ClaudeWoWAchievements.Pending()'), '1');
  vm.run('local f = ClaudeWoWAchievementToast; f.scripts.OnUpdate(f, 0.2)');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'First');
  vm.run('local f = ClaudeWoWAchievementToast; f.scripts.OnUpdate(f, 10)');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'Second');
  vm.run('local f = ClaudeWoWAchievementToast; f.scripts.OnUpdate(f, 10)');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWAchievements.Pending()'), '0');
});

test('the toast is headed Azeroth Companion, sits above the roll frame, and never prints the game wording', () => {
  const vm = newVM();
  vm.run(`ClaudeWoWAchievements.Sync(${payload(1, [entry(1, 'a', 'First')])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.header.text'), 'Azeroth Companion');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.native'), null, 'no template here: the drawn frame');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.rel == UIParent'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.point'), 'BOTTOM');
  assert.match(vm.prints(), /New achievement: \|cffffd100\[First\]\|r, 10 points\./);
  assert.doesNotMatch(vm.prints(), /You have earned the achievement/);
  vm.run('ClaudeWoWRollFrame = CreateFrame("Frame", "ClaudeWoWRollFrame", UIParent)');
  vm.run('local f = ClaudeWoWAchievementToast; f.scripts.OnUpdate(f, 10)');
  vm.run(`ClaudeWoWAchievements.Sync(${payload(2, [entry(2, 'b', 'Second')])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'Second');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.point'), 'BOTTOM');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.rel == ClaudeWoWRollFrame'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.relPoint'), 'TOP');
  assert.ok(Number(vm.evaluate('ClaudeWoWAchievementToast.y')) > 0, 'with a gap');
  vm.run('ClaudeWoWRollFrame:Hide(); local f = ClaudeWoWAchievementToast; f.scripts.OnUpdate(f, 10)');
  vm.run(`ClaudeWoWAchievements.Sync(${payload(3, [entry(3, 'c', 'Third')])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'Third');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.rel == UIParent'), 'true', 'a hidden roll frame is not the anchor');
});

const ALERT_TEMPLATE_STUB = `
C_XMLUtil = { GetTemplateInfo = function(n) if n == "AchievementAlertFrameTemplate" then return {} end end }
STUB.templatesUsed = {}
local plainCreateFrame = CreateFrame
function CreateFrame(kind, name, parent, template)
  if template then table.insert(STUB.templatesUsed, template) end
  return plainCreateFrame(kind, name, parent, template)
end
`;

test('the toast never uses the game achievement alert template, even when the client has it', () => {
  const vm = newVM({ beforeLogin: ALERT_TEMPLATE_STUB });
  vm.run('STUB.templatesUsed = {}');
  vm.run(`ClaudeWoWAchievements.Sync(${payload(1, [entry(1, 'a', 'First')])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.template'), 'BackdropTemplate');
  assert.equal(vm.evaluate('table.concat(STUB.templatesUsed, ",")'), 'BackdropTemplate', 'no alert template is created');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.header.text'), 'Azeroth Companion');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'First');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.text.text'), 't a');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.points.text'), '10');
  vm.run('local f = ClaudeWoWAchievementToast; f.scripts.OnMouseUp(f)');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.shown'), 'false', 'a click dismisses');
});

test('/claude config achievements off silences the toasts, the list still works', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("config achievements off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.toasts'), 'false');
  vm.run(`ClaudeWoWAchievements.Sync(${payload(1, [entry(1, 'leeroy', 'Leeroy Jenkins')], [earned('leeroy', 'Leeroy Jenkins')])})`);
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast'), null, 'no toast frame at all');
  assert.equal(vm.evaluate('#STUB.soundKits'), '0');
  vm.run('SlashCmdList.CLAUDE("config achievements")');
  const out = vm.prints();
  assert.match(out, /Achievements: 1 of 14 earned, 10 points\. Toasts are off/);
  assert.match(out, /\[Leeroy Jenkins\]\|r 10 pts - t leeroy/);
  vm.run('SlashCmdList.CLAUDE("config toasts on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.toasts'), 'true');
  vm.run('SlashCmdList.CLAUDE("config achievements test")');
  assert.equal(vm.evaluate('ClaudeWoWAchievementToast.title.text'), 'Achievement Unlocked');
});

test('an empty list says how to earn one, and free text starting with the word is a message', () => {
  const vm = newVM();
  vm.run('SlashCmdList.CLAUDE("config achievements")');
  assert.match(vm.prints(), /Achievements: 0 of 0 earned, 0 points\. Toasts are on/);
  assert.match(vm.prints(), /None yet/);
  vm.run('STUB.prints = {}');
  vm.run('SlashCmdList.CLAUDE("config achievements are a fun idea, add some")');
  assert.doesNotMatch(vm.prints(), /Achievements:/);
});
