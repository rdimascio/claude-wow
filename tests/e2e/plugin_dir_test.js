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
const BAD_VALUE_NOTE = 'plugins.ask.claudePlugin must be true or false; "yes" is ignored, so ask runs do not load the claude-wow Claude Code plugin.';
const EXTRA_ARGS_NOTE =
  'agents.claude.extraArgs has --plugin-dir, so every chat and factory Claude run loads that plugin, coding chats too; move it to plugins.ask.claudePlugin: true, which loads the claude-wow plugin into ask runs only.';

const askFolder = name => path.join(ROOT, `ask-${name}`);
const pluginsConfig = (dflt, claudePlugin = true, name = dflt) => ({ plugins: { default: dflt, ask: { cwd: askFolder(name), claudePlugin } } });
const countLines = (text, line) => text.split('\n').filter(l => l.endsWith(line)).length;
const isAskRun = (call, name) => fs.realpathSync(call.cwd) === fs.realpathSync(askFolder(name));

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
    assert.equal(call.argv.filter(a => a === '--plugin-dir').length, 1, 'the bridge passes the plugin once');
    assert.ok(fs.existsSync(path.join(call.argv[i + 1], '.claude-plugin', 'plugin.json')), 'the plugin is on disk where the bridge points');
    assert.equal(countLines(fs.readFileSync(h.sb.bridgeLog, 'utf8'), EXTRA_ARGS_NOTE), 0, 'no extraArgs note without --plugin-dir there');
  });
});

test('an ask run with plugins.ask.claudePlugin false gets no plugin but still runs subagents in the foreground', async () => {
  await withGame({ plugin: 'ask', config: pluginsConfig('ask', false, 'off') }, async h => {
    const r = await h.client.say('mark my route [[background-agent PROBE-AGENT-OK]] [[reply the route is on your map]]');
    assert.equal(r.text, 'the route is on your map');
    const call = h.agentCalls().find(c => c.directives['background-agent']);
    assert.ok(call, 'the run reached the agent');
    assert.ok(isAskRun(call, 'off'), 'the run is an ask run');
    assert.ok(!call.argv.includes('--plugin-dir'), 'claudePlugin false keeps the plugin off an ask run');
    assert.equal(call.disableBackgroundTasks, '1', 'an ask run runs subagents in the foreground with or without the plugin');
  });
});

test('a plugins.ask.claudePlugin value that is not a boolean is logged once at start and loads no plugin', async () => {
  await withGame({ plugin: 'ask', config: pluginsConfig('ask', 'yes', 'bad') }, async h => {
    const r = await h.client.say('hello [[reply hi]]');
    assert.equal(r.text, 'hi');
    const call = h.agentCalls().at(-1);
    assert.ok(isAskRun(call, 'bad'), 'the run is an ask run');
    assert.ok(!call.argv.includes('--plugin-dir'));
    assert.equal(countLines(fs.readFileSync(h.sb.bridgeLog, 'utf8'), BAD_VALUE_NOTE), 1, 'the bad value is named once in bridge.log');
  });
});

test('--plugin-dir left in agents.claude.extraArgs is logged once at start, and an ask run gets it once, not a second time', async () => {
  const extraDir = path.join(ROOT, 'own-plugin');
  const config = { ...pluginsConfig('ask', true, 'extra'), agents: { claude: { path: FAKE_AGENT, extraArgs: ['--plugin-dir', extraDir] } } };
  await withGame({ plugin: 'ask', config }, async h => {
    const r = await h.client.say('hello [[reply hi]]');
    assert.equal(r.text, 'hi');
    const call = h.agentCalls().at(-1);
    assert.ok(isAskRun(call, 'extra'), 'the run is an ask run');
    assert.equal(call.argv.filter(a => a === '--plugin-dir').length, 1, 'the plugin dir is passed once');
    assert.equal(call.argv[call.argv.indexOf('--plugin-dir') + 1], extraDir, 'the one from extraArgs is kept');
    assert.equal(countLines(fs.readFileSync(h.sb.bridgeLog, 'utf8'), EXTRA_ARGS_NOTE), 1, 'the old form is named once in bridge.log');
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
