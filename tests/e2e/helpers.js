'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../../dev/harness');
const P = require('../../bridge/protocol');
const { WowClient } = require('../../dev/wow/client');

function makeRoot(label) {
  return path.join(os.tmpdir(), `claude-wow-e2e-${label}-${process.pid}`);
}

function gameRunner(root) {
  let seq = 0;
  return async function withGame(opts, fn) {
    const h = await H.start(`t${++seq}`, Object.assign({ root }, opts));
    try {
      await fn(h);
      h.client.assertHealthy('the addon');
    } catch (e) {
      const tail = `\n--- bridge output (tail) ---\n${h.bridge.output.slice(-2500)}\n--- game prints (tail) ---\n${h.client.prints().slice(-8).join('\n')}`;
      e.message += tail;
      if (typeof e.stack === 'string') e.stack += tail;
      throw e;
    } finally {
      await h.close();
    }
  };
}

function replyTo(h, id) {
  const c = h.client.activeChat();
  if (!c || c.pendingId) return null;
  return (c.history || []).find(m => m.id === id && m.role !== 'user') || null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function switchingLock(h) {
  const lockFile = path.join(h.sb.home, 'deploy.lock');
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now(), command: 'dev deploy', token: 'e2e', phase: 'switching' }),
  );
  return lockFile;
}

const WAGO_FIXTURES = path.join(__dirname, '..', 'fixtures', 'wago');
const FOREVER_BUILD = '1.60.1.200';

function fixtureFetch(url) {
  const u = new URL(url);
  const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
  const headers = { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` };
  return Promise.resolve(new Response(fs.readFileSync(path.join(WAGO_FIXTURES, `${table}.csv`), 'utf8'), { status: 200, headers }));
}

const ERA = '_classic_era_';
const ERA_CLIENT = { interface: 11509, version: '1.15.9', build: '70003' };
const TWO_CLIENTS = { extraClients: [ERA], tocInterface: P.TOC_INTERFACE };

function slotBodies(addons) {
  return fs
    .readdirSync(addons)
    .filter(n => /^ClaudeWoW_S\d{3}$/.test(n))
    .map(n => fs.readFileSync(path.join(addons, n, 'Inbox.lua'), 'utf8'));
}

async function withEra(h, fn, opts = {}) {
  const era = h.sb.clients.find(c => c.flavor === ERA);
  const client = new WowClient({ ...h.sb, ...era }, { ...ERA_CLIENT, ...opts });
  client.launch();
  client.start();
  try {
    await fn(client, era);
    client.assertHealthy('the Era addon');
  } finally {
    client.stop();
  }
}

async function askFromA(h, era, text) {
  era.slash('/claude config context on');
  await era.say(`warm up before ${text}`);
  await h.client.say(`@ask ${text}`);
  const out = h.bridge.output;
  const start = out.lastIndexOf('[ask] Claude starting');
  assert.ok(start > 0, 'the ask run started');
  const before = out.slice(0, start);
  const lastContext = /\((_classic_\w+_)\) game context updated[^\n]*\n(?![\s\S]*game context updated)/.exec(before);
  assert.ok(lastContext, 'both clients reported a context before the run');
  const startLine = out.slice(start, out.indexOf('\n', start));
  const between = before.slice(lastContext.index);
  return {
    lastFrom: lastContext[1],
    granted: startLine.includes('[wowgoals for this run]'),
    refusal: /wowgoals: another client reported its game context after this one \(([^)]*)\)/.exec(between),
  };
}

function assertGoalToolsFollowLastReport(r, theirs) {
  if (r.lastFrom === ERA) {
    assert.equal(r.granted, false, "B reported last, so A's run has no goal server");
    assert.ok(r.refusal, 'and the bridge says why');
    assert.equal(r.refusal[1], theirs);
  } else {
    assert.equal(r.lastFrom, '_classic_beta_');
    assert.equal(r.granted, true, "A reported last, so A's run keeps its goal tools");
    assert.equal(r.refusal, null);
  }
}

module.exports = {
  makeRoot,
  gameRunner,
  isAlive,
  replyTo,
  H,
  switchingLock,
  fixtureFetch,
  FOREVER_BUILD,
  ERA,
  ERA_CLIENT,
  TWO_CLIENTS,
  slotBodies,
  withEra,
  askFromA,
  assertGoalToolsFollowLastReport,
};
