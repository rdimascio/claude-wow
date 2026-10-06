'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const SB = require('../dev/sandbox');

const ROOT = path.join(os.tmpdir(), `claude-wow-fsbudget-test-${process.pid}`);
const SCRIPT = path.join(SB.REPO, 'bridge', 'install-slots.js');
const FS_CALLS_PER_SLOT_BUDGET = 601;

const COUNTER = `
const fs = require('fs');
let calls = 0;
for (const key of Object.keys(fs)) {
  const original = fs[key];
  if (!key.endsWith('Sync') || typeof original !== 'function') continue;
  fs[key] = function () { calls++; return original.apply(this, arguments); };
}
process.on('exit', () => process.stderr.write('FSCALLS ' + calls + '\\n'));
`;

function freshInstallCalls(sb, preload, slots) {
  SB.writeConfig(sb, { slots });
  for (const name of fs.readdirSync(sb.addons)) {
    if (/^ClaudeWoW_(S\d{3}|Runtime)$/.test(name)) fs.rmSync(path.join(sb.addons, name), { recursive: true, force: true });
  }
  const flag = typeof Bun !== 'undefined' ? '--preload' : '--require';
  const r = spawnSync(process.execPath, [flag, preload, SCRIPT], { env: sb.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const m = /FSCALLS (\d+)/.exec(r.stderr);
  assert.ok(m, r.stderr);
  return Number(m[1]);
}

test('a fresh install-slots spends a fixed number of fs calls per slot, so a per-file syscall added to gamefs fails here, not on a slow Windows runner', () => {
  const sb = SB.create('fsbudget', { root: ROOT, slots: 8 });
  const preload = path.join(ROOT, 'count-fs.js');
  fs.writeFileSync(preload, COUNTER);
  try {
    const small = freshInstallCalls(sb, preload, 8);
    const large = freshInstallCalls(sb, preload, 16);
    const perSlot = (large - small) / 8;
    assert.ok(perSlot > 0, `${small} -> ${large}`);
    assert.ok(perSlot <= FS_CALLS_PER_SLOT_BUDGET, `install-slots now spends ${perSlot} fs calls per slot; the budget is ${FS_CALLS_PER_SLOT_BUDGET}`);
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
