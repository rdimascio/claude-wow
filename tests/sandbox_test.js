'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SB = require('../dev/sandbox');

const ROOT = path.join(os.tmpdir(), `claude-wow-sandbox-test-${process.pid}`);

test('assertSafe refuses every live install path and anything that contains one', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const home = '/Users/someone';
  for (const p of [
    '/Users/someone/.claude-wow',
    '/Users/someone/.claude-wow/state.json',
    '/Users/someone/Library/LaunchAgents/io.claudewow.bridge.plist',
    '/Users/someone/Library/Logs/claude-wow/bridge.log',
    '/Users/someone/.claude/projects/x.jsonl',
    '/Applications/World of Warcraft/_classic_beta_/WTF',
    '/Users/someone',
    '/',
  ]) assert.throws(() => SB.assertSafe(p, home), /refusing/, p);
  assert.equal(SB.assertSafe('/Users/someone/code/wow-ai/.dev/sandboxes/a', home), '/Users/someone/code/wow-ai/.dev/sandboxes/a');
});

test('a sandbox name cannot leave its root', () => {
  for (const bad of ['../../../wow-ai', '..', '.', 'a/b', '']) assert.throws(() => SB.sandboxDir(ROOT, bad), /refusing sandbox/, bad);
  assert.equal(SB.sandboxDir(ROOT, 'ok-1.two'), path.join(ROOT, 'ok-1.two'));
});

test('the live checkout named by the LaunchAgent is a forbidden root', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-home-'));
  try {
    fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'io.claudewow.bridge.plist'), '<key>WorkingDirectory</key>\n<string>/srv/live-checkout</string>');
    assert.deepEqual(SB.liveCheckouts(home), ['/srv/live-checkout']);
    assert.throws(() => SB.assertSafe('/srv/live-checkout/bridge', home), /refusing/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install-slots rewrites slot .toc files when tocInterface changes', () => {
  const { spawnSync } = require('child_process');
  const sb = SB.create('iface', { root: ROOT });
  try {
    const toc = path.join(sb.addons, 'ClaudeWoW_S007', 'ClaudeWoW_S007.toc');
    assert.match(fs.readFileSync(toc, 'utf8'), /## Interface: 16001/);
    SB.writeConfig(sb, { tocInterface: '16002' });
    const r = spawnSync(process.execPath, [path.join(SB.REPO, 'bridge', 'install-slots.js')], { env: sb.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /updated: 201/, 'the 200 slot tocs and the runtime toc');
    assert.match(fs.readFileSync(toc, 'utf8'), /## Interface: 16002/);
    assert.match(fs.readFileSync(path.join(sb.addons, 'ClaudeWoW_Runtime', 'ClaudeWoW_Runtime.toc'), 'utf8'), /## Interface: 16002/);
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});

test('a sandbox never points the stream plugin at the real overlay service', () => {
  const sb = SB.create('stream-inert', { root: ROOT, config: { plugins: { default: 'ask', stream: { url: 'http://127.0.0.1:4466' } } } });
  try {
    for (const cfg of [sb.cfg, SB.open('stream-inert', { root: ROOT }).cfg, SB.writeConfig(sb, { plugins: { stream: { url: 'http://127.0.0.1:4466/' } } })]) {
      assert.equal(cfg.plugins.stream.enabled, false);
      assert.doesNotMatch(String(cfg.plugins.stream.url), /:4466\b/);
    }
    assert.doesNotMatch(fs.readFileSync(sb.config, 'utf8'), /4466/);
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
