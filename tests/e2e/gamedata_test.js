'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner, listAfter, fixtureFetch, FOREVER_BUILD: BUILD } = require('./helpers');
const D = require('../../bridge/datasync');

const ROOT = makeRoot('gamedata');
const withGame = gameRunner(ROOT);

test('ask runs get the wowdata server and its run-only rule; coding runs do not; config.json is untouched', async () => {
  let dataDir = '';
  const beforeLaunch = async sb => {
    dataDir = path.join(sb.home, 'data');
    await D.sync({ dataDir, build: BUILD, fetch: fixtureFetch });
  };
  await withGame({ plugin: 'ask', beforeLaunch }, async h => {
    await h.client.say('where is the vale roost');
    const [askRun] = h.agentCalls();
    const config = askRun.mcpConfig;
    const server = config.mcpServers.wowdata;
    assert.equal(server.alwaysLoad, true);
    assert.ok(path.isAbsolute(server.command), server.command);
    const [dataFlag, dataArg, buildFlag, clientBuild] = server.args.slice(-4);
    assert.deepEqual([dataFlag, dataArg, buildFlag], ['--data', dataDir, '--client-build']);
    assert.ok(D.isBuild(clientBuild) && clientBuild.startsWith('1.60.1.'), `the client build from the game context: ${clientBuild}`);
    assert.ok(listAfter(askRun.argv, '--allowedTools').includes('mcp__wowdata'));
    assert.ok(!askRun.argv.includes('--strict-mcp-config'));
    await h.bridge.waitForLine(/wowdata 1\.60\.1\.200/);

    await h.client.say('@claude-code list the files');
    const codingRun = h.agentCalls()[1];
    assert.ok(!codingRun.argv.includes('--mcp-config'), 'the coding plugin runs without it');
    assert.ok(!listAfter(codingRun.argv, '--allowedTools').includes('mcp__wowdata'));
    assert.ok(!fs.readFileSync(h.sb.config, 'utf8').includes('mcp__wowdata'), 'the rule is never saved');
  });
});

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
