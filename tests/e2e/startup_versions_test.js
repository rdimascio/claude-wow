'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeRoot, gameRunner } = require('./helpers');
const P = require('../../bridge/protocol');
const PKG = require('../../package.json');

const ROOT = makeRoot('startup-versions');
const withGame = gameRunner(ROOT);

test('the hello carries the addon version and protocol: equal versions stay silent, and diag and state.json show both', async () => {
  await withGame({}, async h => {
    const rec = await h.client.waitFor(() => Object.values(h.state().addons || {})[0], { timeoutMs: 30000, label: 'the hello versions in state.json' });
    assert.equal(rec.version, PKG.version);
    assert.equal(rec.proto, P.PROTO);
    assert.equal(rec.bridge, PKG.version);
    assert.equal(rec.verdict, 'equal');
    await h.client.waitFor(() => h.client.diag().includes(`versions: addon ${PKG.version} (protocol ${P.PROTO}), bridge ${PKG.version} (protocol ${P.PROTO}), verdict: equal`), { timeoutMs: 30000, label: 'diag with both versions' });
    assert.ok(!h.client.prints().some(p => /older than|too old/.test(p)), 'no version line for equal versions');
  });
});

test('an addon on a newer protocol than the bridge gets an error reply naming the bridge as the side to update, and no agent runs', async () => {
  await withGame({ client: { afterAddonLoad: `ClaudeWoW.Version.PROTO = ${P.PROTO + 1}` } }, async h => {
    await h.client.waitFor(() => (Object.values(h.state().addons || {})[0] || {}).verdict === 'update-bridge', { timeoutMs: 30000, label: 'the hello judged update-bridge' });
    const r = await h.client.say('are you there');
    assert.match(r.text, new RegExp(`The bridge \\(.*\\) is too old for this addon \\(.*protocol ${P.PROTO + 1}\\)\\. The bridge refuses messages until you update it: run brew upgrade claude-wow`));
    assert.equal(h.agentCalls().length, 0, 'the message never reached an agent');
    await h.bridge.waitForLine(/refused: The bridge/, { timeoutMs: 5000 });
    const lines = (h.client.activeChat().history || []).filter(m => m.role === 'system' && /is too old for this addon/.test(m.text || '') && m.id !== r.id);
    assert.equal(lines.length, 1, 'the addon said it once itself');
  });
});

test('a reload-mode session that never says hello is judged from its outbox and refused across a protocol mismatch', async () => {
  await withGame({ client: { afterAddonLoad: `ClaudeWoW.Version.PROTO = ${P.PROTO + 1}; ClaudeWoW.SayHello = function() end` } }, async h => {
    h.client.slash('/claude config mode reload');
    h.client.send('through the outbox');
    await h.bridge.waitForLine(/refused: The bridge/, { timeoutMs: 30000 });
    const rec = await h.client.waitFor(() => Object.values(h.state().addons || {})[0], { timeoutMs: 10000, label: 'the versions saved in state.json' });
    assert.equal(rec.proto, P.PROTO + 1);
    assert.equal(rec.verdict, 'update-bridge');
    assert.equal(h.agentCalls().length, 0, 'the message never reached an agent');
  });
});

test('new addon files installed while the game runs: the addon asks for /reload once, and after it the loaded build matches the disk', async () => {
  await withGame({}, async h => {
    const tocFile = require('path').join(h.sb.addons, 'ClaudeWoW', 'ClaudeWoW.toc');
    const before = P.addonDiskInfo(fs.readFileSync(tocFile, 'utf8'));
    assert.match(before.build, P.BUILD_RE, 'the sandbox install stamps a build');
    await h.client.say('before the update');
    assert.ok(!h.client.prints().some(p => /Type \/reload/.test(p)) && !JSON.stringify(h.client.activeChat().history).includes('Type /reload'), 'nothing to reload yet');
    fs.writeFileSync(tocFile, P.tocWithBuild(fs.readFileSync(tocFile, 'utf8'), 'cccccccccccc'));
    await h.client.say('after the update');
    const asked = () => (h.client.activeChat().history || []).filter(m => m.role === 'system' && /New addon files are installed \(.*build cccccccccccc\)\. Type \/reload/.test(m.text || '')).length;
    await h.client.waitFor(() => asked() === 1, { timeoutMs: 30000, label: 'the /reload line' });
    await h.client.say('one more');
    assert.equal(asked(), 1, 'said once');
    h.client.reload();
    await h.client.waitFor(() => /addon files loaded: \S+ build cccccccccccc, on disk: \S+ build cccccccccccc/.test(h.client.diag()), { timeoutMs: 30000, label: 'diag after the reload' });
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
