'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVM } = require('./lua/vm');

const ADDON_FILES = ['Codec.lua', 'Inbox.lua', 'WoWGPT.lua', 'Map.lua', 'Achievements.lua'];

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
  vm.run('STUB.FireEvent("ADDON_LOADED", "WoWGPT")');
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
  vm.run(`WoWGPTAchievements.Sync(${payload(2, [entry(2, 'b', 'Second'), entry(1, 'a', 'First')])})`);
  assert.equal(vm.evaluate('WoWGPTAchievementToast.title.text'), 'First', 'oldest first');
  assert.equal(vm.evaluate('WoWGPTAchievements.Pending()'), '1');
  vm.run('local f = WoWGPTAchievementToast; f.scripts.OnUpdate(f, 0.2)');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.title.text'), 'First');
  vm.run('local f = WoWGPTAchievementToast; f.scripts.OnUpdate(f, 10)');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.title.text'), 'Second');
  vm.run('local f = WoWGPTAchievementToast; f.scripts.OnUpdate(f, 10)');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.shown'), 'false');
  assert.equal(vm.evaluate('WoWGPTAchievements.Pending()'), '0');
});

test('the toast is headed WoWGPT, sits above the roll frame, and never prints the game wording', () => {
  const vm = newVM();
  vm.run(`WoWGPTAchievements.Sync(${payload(1, [entry(1, 'a', 'First')])})`);
  assert.equal(vm.evaluate('WoWGPTAchievementToast.header.text'), 'WoWGPT');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.native'), null, 'no template here: the drawn frame');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.rel == UIParent'), 'true');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.point'), 'BOTTOM');
  assert.match(vm.prints(), /New achievement: \|cffffd100\[First\]\|r, 10 points\./);
  assert.doesNotMatch(vm.prints(), /You have earned the achievement/);
  vm.run('WoWGPTRollFrame = CreateFrame("Frame", "WoWGPTRollFrame", UIParent)');
  vm.run('local f = WoWGPTAchievementToast; f.scripts.OnUpdate(f, 10)');
  vm.run(`WoWGPTAchievements.Sync(${payload(2, [entry(2, 'b', 'Second')])})`);
  assert.equal(vm.evaluate('WoWGPTAchievementToast.title.text'), 'Second');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.point'), 'BOTTOM');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.rel == WoWGPTRollFrame'), 'true');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.relPoint'), 'TOP');
  assert.ok(Number(vm.evaluate('WoWGPTAchievementToast.y')) > 0, 'with a gap');
  vm.run('WoWGPTRollFrame:Hide(); local f = WoWGPTAchievementToast; f.scripts.OnUpdate(f, 10)');
  vm.run(`WoWGPTAchievements.Sync(${payload(3, [entry(3, 'c', 'Third')])})`);
  assert.equal(vm.evaluate('WoWGPTAchievementToast.title.text'), 'Third');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.rel == UIParent'), 'true', 'a hidden roll frame is not the anchor');
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
  vm.run(`WoWGPTAchievements.Sync(${payload(1, [entry(1, 'a', 'First')])})`);
  assert.equal(vm.evaluate('WoWGPTAchievementToast.template'), 'BackdropTemplate');
  assert.equal(vm.evaluate('table.concat(STUB.templatesUsed, ",")'), 'BackdropTemplate', 'no alert template is created');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.header.text'), 'WoWGPT');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.title.text'), 'First');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.text.text'), 't a');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.points.text'), '10');
  vm.run('local f = WoWGPTAchievementToast; f.scripts.OnMouseUp(f)');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.shown'), 'false', 'a click dismisses');
});

test('/wowgpt config achievements off silences the toasts, the list still works', () => {
  const vm = newVM();
  vm.run('SlashCmdList.WOWGPT("config achievements off")');
  assert.equal(vm.evaluate('WoWGPTDB.settings.toasts'), 'false');
  vm.run(`WoWGPTAchievements.Sync(${payload(1, [entry(1, 'leeroy', 'Leeroy Jenkins')], [earned('leeroy', 'Leeroy Jenkins')])})`);
  assert.equal(vm.evaluate('WoWGPTAchievementToast'), null, 'no toast frame at all');
  assert.equal(vm.evaluate('#STUB.soundKits'), '0');
  vm.run('SlashCmdList.WOWGPT("config achievements")');
  const out = vm.prints();
  assert.match(out, /Achievements: 1 of 14 earned, 10 points\. Toasts are off/);
  assert.match(out, /\[Leeroy Jenkins\]\|r 10 pts - t leeroy/);
  vm.run('SlashCmdList.WOWGPT("config toasts on")');
  assert.equal(vm.evaluate('WoWGPTDB.settings.toasts'), 'true');
  vm.run('SlashCmdList.WOWGPT("config achievements test")');
  assert.equal(vm.evaluate('WoWGPTAchievementToast.title.text'), 'Achievement Unlocked');
});

test('an empty list says how to earn one, and free text starting with the word is a message', () => {
  const vm = newVM();
  vm.run('SlashCmdList.WOWGPT("config achievements")');
  assert.match(vm.prints(), /Achievements: 0 of 0 earned, 0 points\. Toasts are on/);
  assert.match(vm.prints(), /None yet/);
  vm.run('STUB.prints = {}');
  vm.run('SlashCmdList.WOWGPT("config achievements are a fun idea, add some")');
  assert.doesNotMatch(vm.prints(), /Achievements:/);
});
