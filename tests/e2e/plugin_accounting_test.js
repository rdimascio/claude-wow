'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FAKE_AGENT } = require('../../dev/sandbox');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('pluginaccounting');
const withGame = gameRunner(ROOT);

const askFolder = name => path.join(ROOT, `ask-${name}`);
const pluginsConfig = (dflt, claudePlugin = true, name = dflt) => ({ plugins: { default: dflt, ask: { cwd: askFolder(name), claudePlugin } } });

test("a run with a subagent keeps the main model's context and window, and its cost is Claude Code's total", async () => {
  await withGame({ plugin: 'ask', config: pluginsConfig('ask', true, 'cost') }, async h => {
    const r = await h.client.say('plan my route [[background-agent PROBE-AGENT-OK]] [[reply the route is on your map]]');
    assert.equal(r.text, 'the route is on your map');
    const call = h.agentCalls().find(c => c.directives['background-agent']);
    const session = JSON.parse(fs.readFileSync(path.join(h.sb.agentState, `${call.session}.json`), 'utf8'));
    const usage = h.state().sessionUsage[`chat:${h.client.activeChat().id}`];
    assert.ok(usage, 'the chat has its usage');
    assert.equal(usage.cost, session.lastTotalCostUSD, "the cost is the result's total_cost_usd, subagent included");
    assert.equal(usage.window, 200000, "the window is the main model's, not the subagent's larger one");
    assert.equal(usage.context, 3 + 1500 + 20000, "the context is the main session's last message, not the subagent's");
  });
});

test('a --plugin-dir that Claude Code could not load is logged once per run, though a background subagent run reports it in two init events', async () => {
  const config = {
    ...pluginsConfig('claude-code', false, 'badplugin'),
    agents: { claude: { path: FAKE_AGENT, extraArgs: ['--plugin-dir', 'relative/missing-plugin'] } },
  };
  await withGame({ plugin: 'claude-code', config }, async h => {
    const r = await h.client.say('hello [[background-agent PROBE-AGENT-OK]] [[reply hi]]');
    assert.equal(r.text, 'hi');
    const call = h.agentCalls().at(-1);
    assert.equal(call.disableBackgroundTasks, null, 'the subagent runs in the background, so the run has two init events');
    const missing = path.join(fs.realpathSync(call.cwd), 'relative', 'missing-plugin');
    const line = `Claude Code could not load plugin(s): inline[0] (path-not-found: Path not found: ${missing} (commands))`;
    const log = fs.readFileSync(h.sb.bridgeLog, 'utf8');
    assert.equal(log.split('\n').filter(l => l.endsWith(line)).length, 1, `one line in bridge.log:\n${log.slice(-1500)}`);
    await h.client.say('again [[reply ok]]');
    const after = fs.readFileSync(h.sb.bridgeLog, 'utf8');
    assert.equal(after.split('\n').filter(l => l.endsWith(line)).length, 2, 'one line per run');
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
