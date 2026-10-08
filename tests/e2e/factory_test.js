'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('../../bridge/factory');
const { makeRoot, gameRunner, isAlive } = require('./helpers');

const ROOT = makeRoot('factory');
const withGame = gameRunner(ROOT);
const DISPATCHER_MODEL = 'claude-haiku-4-5-20251001';

const listAfter = (argv, flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith('--'); j++) out.push(argv[j]);
  return out;
};

const withFactory = async sb => {
  const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
  cfg.plugins['claude-code'] = {
    agents: { claude: { model: DISPATCHER_MODEL, effort: 'low' } },
    factory: { enabled: true, skills: ['babysit-pr', 'fresh-eyes'], model: 'opus', models: { 'fresh-eyes': { model: 'claude-fable-5-1', effort: 'high' } } },
  };
  fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
};

const runsOf = h => {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.sb.home, 'factory', 'runs.json'), 'utf8')).runs;
  } catch {
    return [];
  }
};

const hidden = text => text.replace(/\[/g, '\\u005b').replace(/\]/g, '\\u005d');

test('a coding chat with the factory on is a cheap dispatcher: it starts an allowlisted skill as a background claude run, refuses others, and the result reaches the chat', async () => {
  await withGame({ beforeLaunch: withFactory }, async h => {
    const refused = await h.client.say('[[mcp-call wowfactory factory_dispatch {"skill":"implementation-engineer","args":"x"}]]');
    assert.match(
      refused.text,
      /^mcp factory_dispatch error: "implementation-engineer" is not a factory skill this bridge may run\. Allowed: babysit-pr, fresh-eyes\./,
    );
    assert.equal(runsOf(h).length, 0, 'a refused skill starts nothing');

    const dispatcher = h.agentCalls().at(-1);
    assert.equal(listAfter(dispatcher.argv, '--model')[0], DISPATCHER_MODEL, 'plugins.claude-code.agents.claude.model applies to the coding plugin');
    assert.equal(listAfter(dispatcher.argv, '--effort')[0], 'low');
    const denied = listAfter(dispatcher.argv, '--disallowedTools');
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'Bash', 'Skill', 'Agent']) assert.ok(denied.includes(tool), `${tool} is denied to the dispatcher`);
    const allowed = listAfter(dispatcher.argv, '--allowedTools');
    for (const rule of F.RUN_RULES) assert.ok(allowed.includes(rule), `${rule} is a run-only rule`);
    assert.ok(dispatcher.mcpConfig.mcpServers.wowfactory, 'the dispatcher gets the factory server');
    assert.ok(!dispatcher.mcpConfig.mcpServers.wowgoals, 'and not the goal tools');
    assert.ok(!/wowfactory/.test(fs.readFileSync(h.sb.config, 'utf8')), 'no rule is ever saved');

    const started = await h.client.say('[[mcp-call wowfactory factory_dispatch {"skill":"fresh-eyes","args":"PR 42"}]]');
    const id = (/^mcp factory_dispatch ok: Started factory run ([0-9a-f]{8}): \/fresh-eyes PR 42/.exec(started.text) || [])[1];
    assert.ok(id, started.text);
    await h.bridge.waitForLine(new RegExp(`factory: run ${id} /fresh-eyes done`), { timeoutMs: 30000 });
    const child = h.agentCalls().find(c => c.prompt === '/fresh-eyes PR 42');
    assert.ok(child, 'the skill ran as its own claude run with the prompt on stdin');
    assert.equal(listAfter(child.argv, '--model')[0], 'claude-fable-5-1');
    assert.equal(listAfter(child.argv, '--effort')[0], 'high');
    assert.ok(!child.argv.includes('--mcp-config'));
    assert.ok(!listAfter(child.argv, '--disallowedTools').includes('Edit'), 'the skill run keeps its edit tools');
    assert.equal(fs.realpathSync(child.cwd), fs.realpathSync(h.sb.project), "in the chat's folder");
    const run = runsOf(h).find(r => r.id === id);
    assert.equal(run.status, 'done');
    assert.ok(run.costUsd > 0);
    await h.bridge.waitForLine(/late reply delivered/, { timeoutMs: 15000 });

    const status = await h.client.say(`[[mcp-call wowfactory factory_status {"runId":"${id}"}]]`);
    assert.match(status.text, new RegExp(`/fresh-eyes PR 42: done after .*Factory run ${id}`));
    await h.client.waitFor(() => JSON.stringify(h.client.db()).includes(`Factory run ${id}, model`), {
      timeoutMs: 20000,
      label: 'the late result in the chat',
    });
  });
});

test('a coding run whose factory server is down logs it and notes it once, though a background subagent sends a second init', async () => {
  await withGame({ beforeLaunch: withFactory }, async h => {
    const r = await h.client.say('[[mcp-fail wowfactory]] [[background-agent PROBE-AGENT-OK]] [[reply the build is fixed]]');
    assert.equal(r.role, 'assistant');
    const call = h.agentCalls().find(c => c.directives['background-agent']);
    assert.ok(call, 'the run reached the agent');
    assert.equal(call.disableBackgroundTasks, null, 'the subagent runs in the background, so the agent sends two init events');
    assert.ok(call.mcpConfig.mcpServers.wowfactory, 'the run has the factory server');
    const downLines = h.bridge.output.split('\n').filter(l => l.includes('MCP server(s) not connected: wowfactory (failed)'));
    assert.equal(downLines.length, 1, 'the down server is logged once per run');
    const note = 'The factory tools server (wowfactory) did not start (failed), so no factory run was started by this message.';
    assert.equal(r.text.split(note).length - 1, 1, 'the reply carries the note once');
  });
});

test('a factory run is ended when the bridge stops, and the run is recorded as killed', { skip: process.platform === 'win32' }, async () => {
  await withGame({ beforeLaunch: withFactory }, async h => {
    const started = await h.client.say(`[[mcp-call wowfactory factory_dispatch {"skill":"babysit-pr","args":"${hidden('[[hang]]')}"}]]`);
    assert.match(started.text, /^mcp factory_dispatch ok: Started factory run/, started.text);
    const child = await h.client.waitFor(() => h.agentCalls().find(c => c.prompt === '/babysit-pr [[hang]]'), { label: 'the factory run to start' });
    assert.ok(isAlive(child.pid));
    await h.bridge.stop();
    assert.ok(!isAlive(child.pid), 'the skill run died with the bridge');
    assert.equal(runsOf(h).at(-1).status, 'killed');
    assert.match(h.bridge.output, /ending \d+ child process/);
  });
});
