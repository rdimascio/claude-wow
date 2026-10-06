'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BACKGROUND_LAUNCH_TEXT } = require('../../dev/fake-claude');
const { FAKE_AGENT, REPO } = require('../../dev/sandbox');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('plugindir');
const withGame = gameRunner(ROOT);
const PLUGIN_DIR = path.join(REPO, 'assets', 'plugins', 'claude-wow');

test('agents.claude.extraArgs hands the bundled plugin to an ask run, and a background subagent launch notice is not the answer', async () => {
  const config = { agents: { claude: { path: FAKE_AGENT, extraArgs: ['--plugin-dir', PLUGIN_DIR] } } };
  await withGame({ plugin: 'ask', config }, async h => {
    const r = await h.client.say('mark my route [[background-agent PROBE-AGENT-OK]] [[reply the route is on your map]]');
    assert.equal(r.role, 'assistant');
    assert.equal(r.text, 'the route is on your map');
    assert.ok(!r.text.includes(BACKGROUND_LAUNCH_TEXT));
    const call = h.agentCalls().find(c => c.directives['background-agent']);
    assert.ok(call, 'the run reached the agent');
    const i = call.argv.indexOf('--plugin-dir');
    assert.ok(i >= 0, 'the run got --plugin-dir');
    assert.equal(call.argv[i + 1], PLUGIN_DIR);
    assert.equal(call.argv.filter(a => a === '--plugin-dir').length, 1, 'the bridge passes the plugin once');
    const relative = path.relative(REPO, PLUGIN_DIR);
    assert.ok(fs.existsSync(path.join(REPO, relative, '.claude-plugin', 'plugin.json')));
    assert.ok(
      !fs.existsSync(path.join(call.cwd, relative, '.claude-plugin', 'plugin.json')),
      'a relative plugin path does not resolve from the run folder, so the path must be absolute',
    );
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
