'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner, fixtureFetch, FOREVER_BUILD: BUILD } = require('./helpers');
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
