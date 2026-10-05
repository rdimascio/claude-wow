'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../../dev/harness');
const P = require('../../bridge/protocol');
const SIG = require('../../bridge/signals');
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

function sessionCostByAgent(h) {
  const calls = h.agentCalls();
  const last = calls[calls.length - 1];
  return JSON.parse(fs.readFileSync(path.join(h.sb.agentState, `${last.session}.json`), 'utf8')).total.costUSD;
}

function replyTo(h, id) {
  const c = h.client.activeChat();
  if (!c || c.pendingId) return null;
  return (c.history || []).find(m => m.id === id && m.role !== 'user') || null;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function switchingLock(h) {
  const lockFile = path.join(h.sb.home, 'deploy.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now(), command: 'dev deploy', token: 'e2e', phase: 'switching' }));
  return lockFile;
}

const listAfter = (argv, flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !String(argv[j]).startsWith('--'); j++) out.push(argv[j]);
  return out;
};

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

function signalFiles(addons) {
  const root = SIG.runtimeRoot(addons);
  const out = [];
  const pending = ['ack', 'sig', 'act'].map(d => path.join(root, d));
  while (pending.length) {
    const dir = pending.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) pending.push(path.join(dir, e.name));
      else out.push(path.relative(root, path.join(dir, e.name)));
    }
  }
  return out.sort();
}

function slotBodies(addons) {
  return fs.readdirSync(addons).filter(n => /^ClaudeWoW_S\d{3}$/.test(n)).map(n => fs.readFileSync(path.join(addons, n, 'Inbox.lua'), 'utf8'));
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

module.exports = {
  makeRoot, gameRunner, sessionCostByAgent, isAlive, replyTo, H,
  switchingLock, listAfter, fixtureFetch, FOREVER_BUILD,
  ERA, ERA_CLIENT, TWO_CLIENTS, signalFiles, slotBodies, withEra,
};
