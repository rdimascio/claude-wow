'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('router');
const withGame = gameRunner(ROOT);
const KEY = 'e2e-fake-typesafe-key-7f3a';

function answer(route) {
  const routes = ['lore', 'web', 'code', 'live', 'game', 'chat'];
  const probabilities = Object.fromEntries(routes.map(r => [r, r === route ? 0.9 : 0.02]));
  return {
    model: 'jev-fake',
    answers: {
      route: { type: 'choice', choice: route, probabilities, confidence: 0.86 },
      'lore.kind': { type: 'choice', choice: 'other', probabilities: { quest: 0, item: 0, npc: 0, zone: 0, 'class-spell': 0, profession: 0, other: 1 }, confidence: 1 },
      needs_fresh: { type: 'noul', noul: 0.1 },
      risky_edit: { type: 'noul', noul: 0.2 },
      'code.project': { type: 'choice', choice: 'demo', probabilities: { demo: 0.9, none: 0.1 }, confidence: 0.8 },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function fakeRouter() {
  const requests = [];
  let delayMs = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer('code')));
      }, delayMs);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    requests,
    setDelay: ms => { delayMs = ms; },
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  })));
}

function seedProject(sb) {
  const repo = path.join(sb.user, 'Projects', 'demo');
  fs.mkdirSync(path.join(repo, '.git', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Demo project for the router\n');
}

async function slashAndWait(h, line) {
  const id = h.client.lastSeq() + 1;
  h.client.slash(line);
  return h.client.waitFor(() => {
    const c = h.client.activeChat();
    return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role !== 'user');
  }, { timeoutMs: 60000, label: `the reply to ${line}` });
}

function shadowLines(sb) {
  try { return fs.readFileSync(path.join(sb.home, 'router.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

test('shadow mode: a bare message takes its normal path, the router logs its pick, explicit input skips it, a slow router never delays a reply', async () => {
  const fake = await fakeRouter();
  try {
    await withGame({ beforeLaunch: seedProject, env: { TYPESAFE_API_KEY: KEY }, router: { mode: 'shadow', url: fake.url } }, async h => {
      await h.bridge.waitForLine(/router: shadow, key from TYPESAFE_API_KEY/, { timeoutMs: 10000 });
      await h.bridge.waitForLine(/router: 1 project\(s\) in /, { timeoutMs: 10000 });
      await h.client.connect();

      const r = await h.client.say('fix the failing test in demo');
      assert.match(r.text, /fix the failing test in demo/);
      await h.client.waitFor(() => shadowLines(h.sb).length === 1, { timeoutMs: 10000, label: 'one shadow line' });
      const [line] = shadowLines(h.sb);
      assert.equal(line.route, 'code');
      assert.equal(line.project, 'demo');
      assert.equal(line.decision, 'run');
      assert.deepEqual(line.taken, { plugin: 'claude-code', why: 'default' });
      assert.equal(line.msg.head, 'fix the failing test in demo');
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0].auth, `Bearer ${KEY}`);
      assert.equal(fake.requests[0].body.model, 'jev-latest');
      assert.equal(fake.requests[0].body.state.message, 'fix the failing test in demo');
      assert.deepEqual(fake.requests[0].body.state.projects.map(p => p.name), ['demo']);
      assert.equal(h.agentCalls().length, 1, 'the agent ran once, on the old path');

      await slashAndWait(h, '/claude -c --model opus explicit please');
      assert.equal(h.agentCalls().length, 2);
      assert.equal(fake.requests.length, 1, 'explicit input made no router call');
      assert.equal(shadowLines(h.sb).length, 1);

      fake.setDelay(3000);
      const started = Date.now();
      const slow = await slashAndWait(h, '/claude roast me');
      assert.match(slow.text, /roast me/);
      await h.client.waitFor(() => shadowLines(h.sb).length === 2, { timeoutMs: 10000, label: 'the timeout line' });
      const timeout = shadowLines(h.sb)[1];
      assert.equal(timeout.fallback, 'timeout');
      assert.equal(timeout.route, 'chat');
      assert.ok(timeout.latencyMs >= 700 && timeout.latencyMs < 3000, `latency ${timeout.latencyMs}`);
      assert.ok(Date.now() - started < 60000);

      const everything = [h.bridge.output, fs.readFileSync(h.sb.bridgeLog, 'utf8'), fs.readFileSync(path.join(h.sb.home, 'router.jsonl'), 'utf8'), fs.readFileSync(h.sb.config, 'utf8'), fs.readFileSync(h.sb.state, 'utf8')].join('\n');
      assert.ok(!everything.includes(KEY), 'the key never reaches a log, the config or the state');
    });
  } finally {
    await fake.close();
  }
});

test('with no key the router is off, says so once, and messages work as before', async () => {
  await withGame({ router: { mode: 'shadow', url: 'http://127.0.0.1:9/never' }, config: { router: { mode: 'shadow', url: 'http://127.0.0.1:9/never', keychain: { service: 'claude-wow-e2e-missing', account: 'none' } } } }, async h => {
    await h.bridge.waitForLine(/router: off, no TypeSafe key/, { timeoutMs: 15000 });
    await h.client.connect();
    const r = await h.client.say('hello there');
    assert.match(r.text, /hello there/);
    assert.equal(shadowLines(h.sb).length, 0);
    assert.equal((h.bridge.output.match(/router: off/g) || []).length, 1);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
