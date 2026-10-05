'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { makeRoot, gameRunner, fixtureFetch, FOREVER_BUILD: BUILD } = require('./helpers');
const D = require('../../bridge/datasync');

const ROOT = makeRoot('gamedata');
const withGame = gameRunner(ROOT);

test('a wowdata server that fails to start is logged and named in the reply', async () => {
  const beforeLaunch = async sb => {
    await D.sync({ dataDir: path.join(sb.home, 'data'), build: BUILD, fetch: fixtureFetch });
  };
  await withGame({ plugin: 'ask', beforeLaunch }, async h => {
    const failed = await h.client.say('[[mcp-fail wowdata]] where is the vale roost');
    await h.bridge.waitForLine(/MCP server\(s\) not connected: wowdata \(failed\)/);
    assert.match(failed.text, /game data server \(wowdata\) did not start \(failed\)/);
    const fine = await h.client.say('where is the vale roost');
    assert.doesNotMatch(fine.text, /did not start/);
  });
});
