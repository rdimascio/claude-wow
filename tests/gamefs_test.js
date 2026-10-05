'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../bridge/gamefs');

const posixOnly = { skip: process.platform === 'win32' };
const modeOf = file => fs.statSync(file).mode & 0o777;

function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `claude-wow-gamefs-${name}-`));
}

test('repair sets every file and folder under the ClaudeWoW addon folders to 0777 and nothing else', posixOnly, () => {
  const addons = scratch('repair');
  const presence = path.join(addons, 'ClaudeWoW_Runtime', 'presence');
  fs.mkdirSync(presence, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(presence, '0007.wav'), 'RIFF', { mode: 0o644 });
  fs.mkdirSync(path.join(addons, 'ClaudeWoW'), { mode: 0o755 });
  fs.mkdirSync(path.join(addons, 'ClaudeWoW_Runtimes'), { mode: 0o755 });
  fs.mkdirSync(path.join(addons, 'ClaudeWoW_S001'), { mode: 0o755 });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'x', { mode: 0o644 });
  fs.mkdirSync(path.join(addons, 'SomeOtherAddon'), { mode: 0o755 });
  fs.writeFileSync(path.join(addons, 'SomeOtherAddon', 'a.lua'), 'x', { mode: 0o644 });
  const first = G.repair(addons);
  assert.equal(first.fixed, first.checked);
  assert.ok(first.fixed >= 5);
  assert.deepEqual(first.failed, []);
  for (const f of [path.join(addons, 'ClaudeWoW'), path.join(addons, 'ClaudeWoW_Runtime'), presence, path.join(presence, '0007.wav'), path.join(addons, 'ClaudeWoW_S001'), path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua')]) {
    assert.equal(modeOf(f), 0o777, f);
  }
  assert.equal(modeOf(path.join(addons, 'ClaudeWoW_Runtimes')), 0o755, 'only the exact runtime folder name counts');
  assert.equal(modeOf(path.join(addons, 'SomeOtherAddon', 'a.lua')), 0o644, 'another addon is not touched');
  const again = G.repair(addons);
  assert.equal(again.fixed, 0);
  assert.deepEqual(G.repair(path.join(addons, 'missing')), { checked: 0, fixed: 0, failed: [] });
  fs.rmSync(addons, { recursive: true, force: true });
});
