'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SB = require('../dev/sandbox');
const P = require('../bridge/protocol');
const { WowClient } = require('../dev/wow/client');
const { gameRunner, withEra, ERA } = require('./e2e/helpers');

const ROOT = path.join(os.tmpdir(), `claude-wow-client-test-${process.pid}`);
const SHARED_NAME = 't1';
let shared = null;

function sandbox() {
  shared = shared || SB.create(SHARED_NAME, { root: ROOT, extraClients: [ERA], tocInterface: P.TOC_INTERFACE });
  return shared;
}

function launched(opts = {}) {
  const sb = sandbox();
  return { sb, client: new WowClient(sb, opts).launch() };
}

function withAddonFile(sb, name, body, fn) {
  const file = path.join(sb.addons, 'ClaudeWoW', name);
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  fs.writeFileSync(file, body);
  try {
    return fn();
  } finally {
    if (before) fs.writeFileSync(file, before);
    else fs.rmSync(file, { force: true });
  }
}

function withSaved(sb, body, fn) {
  const before = fs.existsSync(sb.saved) ? fs.readFileSync(sb.saved) : null;
  fs.writeFileSync(sb.saved, body);
  try {
    return fn();
  } finally {
    if (before) fs.writeFileSync(sb.saved, before);
    else fs.rmSync(sb.saved, { force: true });
  }
}

const SHARED_GAME = { root: ROOT, open: true, keep: true, bridge: false };

function failOnEvent(event, message) {
  return `local f = CreateFrame("Frame"); f:RegisterEvent("${event}"); f:SetScript("OnEvent", function() error("${message}") end)`;
}

async function until(pred, label) {
  const deadline = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

test('Lua errors from before a reload and from logout handlers are still reported after the reload', () => {
  const { client } = launched();
  assert.deepEqual(client.errors(), []);
  client.runLua(failOnEvent('DEV_TEST_EVENT', 'event broke'));
  client.runLua('DEV.Fire("DEV_TEST_EVENT")');
  client.runLua(failOnEvent('PLAYER_LOGOUT', 'logout broke'));
  client.reload();
  const errors = client.errors();
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.match(errors[0], /event broke/);
  assert.match(errors[1], /logout broke/);
  assert.throws(() => client.assertHealthy('the addon'), /the addon raised Lua errors:[\s\S]*event broke/);
});

test('Lua errors are still reported after the client quits', () => {
  const { client } = launched();
  client.runLua(failOnEvent('PLAYER_LOGOUT', 'logout broke'));
  client.quit();
  assert.equal(client.errors().length, 1);
  assert.match(client.errors()[0], /logout broke/);
});

test('a key handler that raises is reported as a Lua error', () => {
  const { client } = launched();
  client.runLua('local f = CreateFrame("Frame"); f:SetScript("OnKeyDown", function() error("key broke") end); f:Show()');
  client.pressKey('SPACE');
  assert.equal(client.errors().length, 1);
  assert.match(client.errors()[0], /key broke/);
});

test('a frame step that throws makes assertHealthy fail', async () => {
  const { client } = launched({ frameMs: 10 });
  try {
    client.runLua('DEV.RunFrame = function() error("frame broke") end');
    client.start();
    await until(() => client.fatal, 'the step to fail');
  } finally {
    client.stop();
  }
  assert.deepEqual(client.errors(), []);
  assert.throws(() => client.assertHealthy(), /frame broke/);
});

test('an addon file created after launch is not read, even after /reload, while a launch-time file reads its new contents', () => {
  const { sb, client } = launched();
  const probe = '(function() local ok, why = DEV.RunAddonFile("ClaudeWoW", "Late.lua"); return tostring(ok) .. ":" .. tostring(why) end)()';
  withAddonFile(sb, 'Late.lua', 'LATE_LOADED = true', () => {
    assert.equal(client.luaValue(probe), 'false:MISSING_FILE Late.lua');
    assert.equal(client.luaValue('LATE_LOADED'), null);
    assert.equal(client.luaValue('HOST_read("Interface/AddOns/ClaudeWoW/Late.lua")'), null);
    client.reload();
    assert.equal(client.luaValue(probe), 'false:MISSING_FILE Late.lua');
  });
  withAddonFile(sb, 'Codec.lua', 'CHANGED_AFTER_LAUNCH = 1', () => {
    assert.equal(client.luaValue('HOST_read("Interface/AddOns/ClaudeWoW/Codec.lua")'), 'CHANGED_AFTER_LAUNCH = 1');
  });
});

test('with the live file index a file created after launch is read', () => {
  const { sb, client } = launched({ fileIndex: 'live' });
  withAddonFile(sb, 'Late.lua', 'LATE_LOADED = true', () => {
    client.runLua('DEV.RunAddonFile("ClaudeWoW", "Late.lua")');
    assert.equal(client.luaValue('LATE_LOADED'), 'true');
  });
});

test('a disabled ClaudeWoW does not load and its SavedVariables are left alone', () => {
  const sb = sandbox();
  const saved = 'ClaudeWoWDB = { kept = true }\r\n';
  withSaved(sb, saved, () => {
    const client = new WowClient(sb, { disabled: ['ClaudeWoW'] }).launch();
    assert.equal(client.luaValue('ClaudeWoW'), null);
    assert.equal(client.luaValue('ClaudeWoWDB'), null);
    assert.equal(client.luaValue('IsAddOnLoaded("ClaudeWoW")'), 'false');
    client.reload();
    client.quit();
    assert.equal(fs.readFileSync(sb.saved, 'utf8'), saved);
    assert.deepEqual(client.errors(), []);
  });
});

test('ClaudeWoW whose TOC lists no matching interface loads only with out-of-date addons allowed', () => {
  const sb = sandbox();
  const stale = new WowClient(sb, { interface: 16002 }).launch();
  assert.equal(stale.luaValue('IsAddOnLoaded("ClaudeWoW")'), 'false');
  assert.equal(stale.luaValue('ClaudeWoW'), null);
  const allowed = new WowClient(sb, { interface: 16002, loadOutOfDate: true }).launch();
  assert.equal(allowed.luaValue('IsAddOnLoaded("ClaudeWoW")'), 'true');
  assert.notEqual(allowed.luaValue('ClaudeWoW'), null);
});

test('a ClaudeWoW whose TOC lists a missing file fails the launch and names the file', () => {
  const sb = sandbox();
  const file = path.join(sb.addons, 'ClaudeWoW', 'Widgets.lua');
  const before = fs.readFileSync(file);
  fs.rmSync(file);
  try {
    assert.throws(() => new WowClient(sb).launch(), /ClaudeWoW did not load: MISSING_FILE Widgets\.lua/);
  } finally {
    fs.writeFileSync(file, before);
  }
});

test('gameRunner fails a test whose addon raised a Lua error before a reload', async () => {
  const withGame = gameRunner(ROOT);
  sandbox();
  await assert.rejects(
    withGame({ ...SHARED_GAME, run: false }, async h => {
      h.client.runLua(failOnEvent('DEV_TEST_EVENT', 'event broke'));
      h.client.runLua('DEV.Fire("DEV_TEST_EVENT")');
      h.client.reload();
    }),
    /the addon raised Lua errors:[\s\S]*event broke/,
  );
});

test('gameRunner fails a test whose client step threw', async () => {
  const withGame = gameRunner(ROOT);
  sandbox();
  await assert.rejects(
    withGame({ ...SHARED_GAME, client: { frameMs: 10 } }, async h => {
      h.client.runLua('DEV.RunFrame = function() error("frame broke") end');
      await until(() => h.client.fatal, 'the step to fail');
    }),
    /frame broke/,
  );
});

test('withEra fails a test whose Era addon raised a Lua error before a reload', async () => {
  const sb = sandbox();
  await assert.rejects(
    withEra({ sb }, async client => {
      client.runLua(failOnEvent('PLAYER_LOGOUT', 'logout broke'));
      client.reload();
    }),
    /the Era addon raised Lua errors:[\s\S]*logout broke/,
  );
});

test('withEra fails a test whose Era client step threw', async () => {
  const sb = sandbox();
  await assert.rejects(
    withEra(
      { sb },
      async client => {
        client.runLua('DEV.RunFrame = function() error("frame broke") end');
        await until(() => client.fatal, 'the step to fail');
      },
      { frameMs: 10 },
    ),
    /frame broke/,
  );
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
