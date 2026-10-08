'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner, fixtureFetch, isAlive, FOREVER_BUILD: OLD } = require('./helpers');
const D = require('../../bridge/datasync');

const ROOT = makeRoot('data-autosync');
const withGame = gameRunner(ROOT);
const PRELOAD = path.join(__dirname, '..', 'fixtures', 'fake-wago-fetch.js');
const NEW = '1.60.1.70245';
const NEW_CLIENT = { version: '1.60.1', build: '70245' };

function fakeSource(name, extra = {}) {
  fs.mkdirSync(ROOT, { recursive: true });
  const requests = path.join(ROOT, `${name}-requests.log`);
  const builds = path.join(ROOT, `${name}-builds.json`);
  fs.writeFileSync(builds, JSON.stringify({ wow_cn_beta: [OLD, NEW].map(version => ({ product: 'wow_cn_beta', version })) }));
  return {
    requests,
    env: { NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`, CLAUDE_WOW_FAKE_WAGO_LOG: requests, CLAUDE_WOW_FAKE_WAGO_BUILDS: builds, ...extra },
  };
}

function syncArgv(requests) {
  return fs
    .readFileSync(requests, 'utf8')
    .split('\n')
    .filter(l => l.startsWith('argv ') && l.includes('"sync"'))
    .map(l => JSON.parse(l.slice(5)));
}

function oldData(sb) {
  return D.sync({ dataDir: path.join(sb.home, 'data'), build: OLD, fetch: fixtureFetch });
}

function count(text, re) {
  return (text.match(new RegExp(re.source, 'g')) || []).length;
}

test('a client on a newer build starts one background sync from the source, and the next ask run uses the new build', async () => {
  const source = fakeSource('newer');
  const opts = { plugin: 'ask', client: NEW_CLIENT, config: { data: { autoSync: true } }, env: source.env, beforeLaunch: oldData };
  await withGame(opts, async h => {
    await h.bridge.waitForLine(
      /data sync: client 1\.60\.1\.70245 has forever data 1\.60\.1\.200 \(family\); syncing the newest forever build from wago\.tools/,
      {
        from: 0,
        timeoutMs: 30000,
      },
    );
    await h.bridge.waitForLine(/data sync: forever 1\.60\.1\.70245 is current; the next game data lookup uses it/, { from: 0, timeoutMs: 60000 });
    const root = D.flavorDir(path.join(h.sb.home, 'data'), 'forever');
    assert.equal(D.readCurrent(root).build, NEW);
    assert.ok(fs.readFileSync(source.requests, 'utf8').includes(`/db2/ItemSparse/csv?build=${NEW}`));
    assert.deepEqual(syncArgv(source.requests), [['sync', '--flavor', 'forever']], 'the client build is a trigger, never an argument');
    assert.equal(h.state().dataSync.forever.result, 'ok');
    await h.client.say('where is the vale roost');
    const [askRun] = h.agentCalls();
    assert.deepEqual(askRun.mcpConfig.mcpServers.wowdata.args.slice(-2), ['--client-build', NEW]);
    await h.bridge.waitForLine(/wowdata 1\.60\.1\.70245 forever/, { from: 0 });
    assert.equal(count(h.bridge.output, /data sync: client /), 1, 'exact data starts no second sync');
  });
});

test('with a non-boolean autoSync (ignored, logged once), a build the source does not have yet fails once, keeps the old data, and a restart does not try again', async () => {
  const source = fakeSource('missing', { CLAUDE_WOW_FAKE_WAGO_MISSING: NEW });
  const opts = { plugin: 'ask', client: NEW_CLIENT, config: { data: { autoSync: 'yes' } }, env: source.env, beforeLaunch: oldData };
  await withGame(opts, async h => {
    await h.bridge.waitForLine(/data sync: forever failed \(.*HTTP 404\); the data in use stays, next try after /, {
      from: 0,
      timeoutMs: 60000,
    });
    assert.equal(D.readCurrent(D.flavorDir(path.join(h.sb.home, 'data'), 'forever')).build, OLD);
    assert.equal(h.state().dataSync.forever.result, 'failed');
    assert.equal(count(h.bridge.output, /data\.autoSync: "yes" is not true or false, so it is ignored and game data sync stays on/), 1);
    await h.bridge.restart();
    await h.client.say('where is the vale roost');
    await h.bridge.waitForLine(/wowdata 1\.60\.1\.200 forever/);
    assert.equal(count(h.bridge.output, /data sync: client /), 1, 'the 6 hour wait survives the restart');
  });
});

test('stopping the bridge ends a sync that is still running', async () => {
  const source = fakeSource('hang', { CLAUDE_WOW_FAKE_WAGO_HANG: NEW });
  const opts = { client: NEW_CLIENT, config: { data: { autoSync: true } }, env: source.env, beforeLaunch: oldData };
  await withGame(opts, async h => {
    await h.bridge.waitForLine(/data sync: client 1\.60\.1\.70245 has forever data/, { from: 0, timeoutMs: 30000 });
    let pid = 0;
    for (let k = 0; k < 200 && !pid; k++) {
      const m = /^hang (\d+)$/m.exec(fs.existsSync(source.requests) ? fs.readFileSync(source.requests, 'utf8') : '');
      if (m) pid = Number(m[1]);
      else await new Promise(res => setTimeout(res, 50));
    }
    assert.ok(pid > 0, 'the sync child asked the source and hangs');
    assert.ok(isAlive(pid));
    await h.bridge.stop();
    for (let k = 0; k < 100 && isAlive(pid); k++) await new Promise(res => setTimeout(res, 50));
    assert.equal(isAlive(pid), false, 'the bridge ended its sync child on the way out');
    assert.equal(D.readCurrent(D.flavorDir(path.join(h.sb.home, 'data'), 'forever')).build, OLD);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
