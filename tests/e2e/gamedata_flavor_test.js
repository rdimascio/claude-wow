'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner, listAfter, fixtureFetch, FOREVER_BUILD: BUILD } = require('./helpers');
const D = require('../../bridge/datasync');

const ROOT = makeRoot('gamedata-flavor');
const withGame = gameRunner(ROOT);

const ERA_FIXTURES = path.join(__dirname, '..', 'fixtures', 'wago-era');
const ERA_CLIENT = { version: '1.15.9', build: '70003', interface: 11509 };

function eraFetch(url) {
  const u = new URL(url);
  if (u.pathname === '/api/builds') return Promise.resolve(new Response(fs.readFileSync(path.join(ERA_FIXTURES, 'builds.json'), 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } }));
  const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
  const headers = { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` };
  return Promise.resolve(new Response(fs.readFileSync(path.join(ERA_FIXTURES, `${table}.csv`), 'utf8'), { status: 200, headers }));
}

test('a Classic Era client gets the Classic Era data server, never the Forever one', async () => {
  const beforeLaunch = async sb => {
    const dataDir = path.join(sb.home, 'data');
    await D.sync({ dataDir, build: BUILD, fetch: fixtureFetch });
    await D.sync({ dataDir, flavor: 'classic_era', fetch: eraFetch });
  };
  await withGame({ plugin: 'ask', client: ERA_CLIENT, tocInterface: ERA_CLIENT.interface, beforeLaunch }, async h => {
    await h.client.say('where is the vale roost');
    const [askRun] = h.agentCalls();
    const server = askRun.mcpConfig.mcpServers.wowdata;
    assert.deepEqual(server.args.slice(-2), ['--client-build', '1.15.9.70003']);
    await h.bridge.waitForLine(/wowdata 1\.15\.9\.300 classic_era/);
  });
});

test('a Classic Era client with only Forever data synced runs without a data server and says which sync it needs', async () => {
  const beforeLaunch = async sb => {
    await D.sync({ dataDir: path.join(sb.home, 'data'), build: BUILD, fetch: fixtureFetch });
  };
  await withGame({ plugin: 'ask', client: ERA_CLIENT, tocInterface: ERA_CLIENT.interface, beforeLaunch }, async h => {
    await h.client.say('hello');
    await h.client.say('hello again');
    for (const run of h.agentCalls()) {
      assert.deepEqual(Object.keys(run.mcpConfig.mcpServers), ['wowgoals'], 'no Forever answers for an Era client');
      assert.ok(!listAfter(run.argv, '--allowedTools').includes('mcp__wowdata'));
    }
    assert.equal(h.bridge.output.match(/wowdata: no synced game data for Classic Era under .*\(claude-wow data sync --flavor classic_era\)/g).length, 1);
  });
});

test('with no synced data, ask runs go without the server and the bridge says why once', async () => {
  await withGame({ plugin: 'ask' }, async h => {
    await h.client.say('hello');
    await h.client.say('hello again');
    for (const run of h.agentCalls()) {
      assert.deepEqual(Object.keys(run.mcpConfig.mcpServers), ['wowgoals']);
      assert.ok(!listAfter(run.argv, '--allowedTools').includes('mcp__wowdata'));
    }
    assert.equal(h.bridge.output.match(/wowdata: no synced game data/g).length, 1);
  });
});
