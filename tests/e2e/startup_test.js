'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner, H } = require('./helpers');

const ROOT = makeRoot('startup');
const withGame = gameRunner(ROOT);

test('a client whose interface version no longer matches the slots tells the player why replies stopped', async () => {
  await withGame({ tocInterface: '16002' }, async h => {
    await h.client.waitFor(() => h.client.prints().some(p => /INTERFACE_VERSION.*tocInterface to 16001/.test(p)), {
      timeoutMs: 20000,
      label: 'a message about the slot version',
    });
  });
});

test('a corrupt state.json is kept aside and reported, not silently reset', async () => {
  await withGame({ beforeLaunch: sb => fs.writeFileSync(sb.state, '{"sessions": {"x": ') }, async h => {
    await h.bridge.waitForLine(/state\.json.*(corrupt|unreadable|not valid)/i, { timeoutMs: 5000 });
    assert.ok(fs.readdirSync(h.sb.home).some(f => /^state\.json\.corrupt/.test(f)));
  });
});

test('a default folder inside the bridge home is refused for ~/wowgpt', async () => {
  const setCwd = sb => {
    const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
    fs.writeFileSync(sb.config, JSON.stringify({ ...cfg, defaultCwd: sb.home }));
  };
  await withGame({ beforeLaunch: setCwd }, async h => {
    await h.bridge.waitForLine(/default folder .* refused: it is inside the bridge home folder/, { timeoutMs: 8000 });
    assert.ok(fs.statSync(path.join(h.sb.user, 'wowgpt')).isDirectory(), 'the fallback folder is created');
  });
});

test('a default folder that is the home folder is refused', async () => {
  const setCwd = sb => {
    const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
    fs.writeFileSync(sb.config, JSON.stringify({ ...cfg, defaultCwd: sb.user }));
  };
  await withGame({ beforeLaunch: setCwd }, async h => {
    await h.bridge.waitForLine(/default folder .* refused: it is the home folder or a disk root/, { timeoutMs: 8000 });
  });
});

test('a second bridge on the same home refuses to start', async () => {
  await withGame({}, async h => {
    const second = new H.BridgeProcess(h.sb);
    second.start();
    await second.waitForLine(/already running/i, { timeoutMs: 8000 }).finally(() => second.stop());
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
