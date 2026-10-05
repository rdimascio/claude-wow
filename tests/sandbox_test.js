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
  ])
    assert.throws(() => SB.assertSafe(p, home), /refusing/, p);
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
    fs.writeFileSync(
      path.join(home, 'Library', 'LaunchAgents', 'io.claudewow.bridge.plist'),
      '<key>WorkingDirectory</key>\n<string>/srv/live-checkout</string>',
    );
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

test('an explicit empty agentPath is kept so the bridge finds the real CLI; no agentPath means the fake agent', () => {
  const L = SB.layout(path.join(ROOT, 'agent-path'));
  assert.equal(SB.buildConfig(L, { agentPath: '' }).agents.claude.path, '');
  assert.equal(SB.buildConfig(L, {}).agents.claude.path, SB.FAKE_AGENT);
  assert.equal(SB.buildConfig(L, { agentPath: '/opt/x/claude' }).agents.claude.path, '/opt/x/claude');
});

test("a bridge started with the sandbox environment can read a live session's command line", () => {
  const { spawnSync } = require('child_process');
  const liveproto = path.join(SB.REPO, 'bridge', 'liveproto.js');
  const readOwnCommandLine = `require(${JSON.stringify(liveproto)}).commandLine(process.pid).then(line => process.stdout.write(String(line)))`;
  const r = spawnSync(process.execPath, ['-e', readOwnCommandLine], {
    env: SB.envFor(SB.layout(path.join(ROOT, 'cmdline-env'))),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.match(r.stdout, /node|bun/i, `the command line read with the sandbox environment: ${r.stdout}${r.stderr}`);
});

test('a plain reopen of a --real-agent sandbox goes back to the fake agent; a custom path is kept', () => {
  const sb = SB.create('real-then-plain', { root: ROOT, agentPath: '' });
  try {
    assert.equal(sb.cfg.agents.claude.path, '');
    const plain = SB.open('real-then-plain', { root: ROOT, keepAddon: true });
    assert.equal(plain.cfg.agents.claude.path, SB.FAKE_AGENT);
    assert.equal(JSON.parse(fs.readFileSync(plain.config, 'utf8')).agents.claude.path, SB.FAKE_AGENT);
    SB.writeConfig(plain, { agents: Object.assign({}, plain.cfg.agents, { claude: Object.assign({}, plain.cfg.agents.claude, { path: '/opt/x/claude' }) }) });
    assert.equal(SB.open('real-then-plain', { root: ROOT, keepAddon: true }).cfg.agents.claude.path, '/opt/x/claude');
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});

test('reopening a sandbox refreshes the shipped addon and slots but keeps SavedVariables, transcripts, config and project', () => {
  const sb = SB.create('refresh', { root: ROOT });
  try {
    const lua = path.join(sb.addons, 'ClaudeWoW', 'ClaudeWoW.lua');
    const leftover = path.join(sb.addons, 'ClaudeWoW', 'Removed.lua');
    const slotToc = path.join(sb.addons, 'ClaudeWoW_S007', 'ClaudeWoW_S007.toc');
    const shipped = fs.readFileSync(path.join(SB.REPO, 'addon', 'ClaudeWoW', 'ClaudeWoW.lua'), 'utf8');
    fs.writeFileSync(lua, '-- STALE');
    fs.writeFileSync(leftover, '-- gone from the repo');
    fs.writeFileSync(slotToc, 'stale toc');
    fs.writeFileSync(sb.saved, 'ClaudeWoWDB = { kept = true }\n');
    fs.writeFileSync(sb.transcripts, '{"kept":true}\n');
    fs.writeFileSync(path.join(sb.project, 'notes.txt'), 'kept');
    SB.writeConfig(sb, { slots: 60 });

    const kept = SB.open('refresh', { root: ROOT, keepAddon: true });
    assert.equal(kept.installed, null);
    assert.equal(fs.readFileSync(lua, 'utf8'), '-- STALE', 'keepAddon leaves the old snapshot');
    assert.equal(fs.readFileSync(slotToc, 'utf8'), 'stale toc');

    const reopened = SB.open('refresh', { root: ROOT });
    assert.ok(fs.readFileSync(lua, 'utf8') === shipped, 'the shipped ClaudeWoW.lua is copied again');
    assert.ok(!fs.existsSync(leftover), 'a file no longer shipped is removed');
    assert.match(fs.readFileSync(slotToc, 'utf8'), /## Interface: 16001/);
    assert.match(reopened.installed, /slots: 60/);
    assert.equal(fs.readFileSync(sb.saved, 'utf8'), 'ClaudeWoWDB = { kept = true }\n');
    assert.equal(fs.readFileSync(sb.transcripts, 'utf8'), '{"kept":true}\n');
    assert.equal(fs.readFileSync(path.join(sb.project, 'notes.txt'), 'utf8'), 'kept');
    assert.equal(reopened.cfg.slots, 60);
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
