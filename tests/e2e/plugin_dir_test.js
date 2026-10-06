'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BACKGROUND_LAUNCH_TEXT } = require('../../dev/fake-claude');
const { REPO } = require('../../dev/sandbox');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('plugindir');
const withGame = gameRunner(ROOT);
const PLUGIN_DIR = path.join(REPO, 'assets', 'plugins', 'claude-wow');

const pluginsConfig = dflt => ({ plugins: { default: dflt, ask: { cwd: path.join(ROOT, `ask-${dflt}`), claudePlugin: true } } });

test('plugins.ask.claudePlugin hands the bundled plugin to an ask run, with subagents in the foreground', async () => {
  await withGame({ plugin: 'ask', config: pluginsConfig('ask') }, async h => {
    const r = await h.client.say('mark my route [[background-agent PROBE-AGENT-OK]] [[reply the route is on your map]]');
    assert.equal(r.role, 'assistant');
    assert.equal(r.text, 'the route is on your map');
    const call = h.agentCalls().find(c => c.directives['background-agent']);
    assert.ok(call, 'the run reached the agent');
    assert.equal(call.disableBackgroundTasks, '1', 'an ask run runs subagents in the foreground');
    const i = call.argv.indexOf('--plugin-dir');
    assert.ok(i >= 0, 'the run got --plugin-dir');
    assert.equal(call.argv[i + 1], PLUGIN_DIR);
    assert.ok(path.isAbsolute(call.argv[i + 1]));
    assert.equal(call.argv.filter(a => a === '--plugin-dir').length, 1, 'the bridge passes the plugin once');
    assert.ok(fs.existsSync(path.join(call.argv[i + 1], '.claude-plugin', 'plugin.json')), 'the plugin is on disk where the bridge points');
  });
});

test('a coding run gets neither the plugin nor foreground subagents, and a background launch notice is not the answer', async () => {
  await withGame({ plugin: 'claude-code', config: pluginsConfig('claude-code') }, async h => {
    const r = await h.client.say('fix the build [[background-agent PROBE-AGENT-OK]] [[reply the build is fixed]]');
    assert.equal(r.role, 'assistant');
    assert.equal(r.text, 'the build is fixed');
    assert.ok(!r.text.includes(BACKGROUND_LAUNCH_TEXT));
    const call = h.agentCalls().find(c => c.directives['background-agent']);
    assert.ok(call, 'the run reached the agent');
    assert.ok(!fs.realpathSync(call.cwd).startsWith(fs.realpathSync(ROOT) + path.sep + 'ask-'), 'the run is a coding run, not an ask run');
    assert.ok(!call.argv.includes('--plugin-dir'), 'a coding run never gets the claude-wow plugin');
    assert.equal(call.disableBackgroundTasks, null, 'a coding run keeps background tasks');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
