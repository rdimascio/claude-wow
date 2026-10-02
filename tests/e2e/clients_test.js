'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../../bridge/protocol');
const SIG = require('../../bridge/signals');
const CLI = require('../../bridge/clients');
const { WowClient } = require('../../dev/wow/client');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('clients');
const withGame = gameRunner(ROOT);
const ERA = '_classic_era_';
const ERA_CLIENT = { interface: 11509, version: '1.15.9', build: '70003' };
const TWO = { extraClients: [ERA], tocInterface: P.TOC_INTERFACE };

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

async function withEra(h, fn) {
  const era = h.sb.clients.find(c => c.flavor === ERA);
  const client = new WowClient({ ...h.sb, ...era }, ERA_CLIENT);
  client.launch();
  client.start();
  try {
    await fn(client, era);
    assert.deepEqual(client.errors(), [], 'the Era addon raised no Lua errors');
  } finally {
    client.stop();
  }
}

test('a message from client B is answered in B, and never spends a signal or lands a reply in client A', async () => {
  await withGame({ ...TWO, run: false }, async h => {
    const forever = h.sb.clients[0];
    const eraAddons = h.sb.clients[1].addons;
    const ahead = [10, 11, 12];
    for (const addons of [forever.addons, eraAddons]) for (const s of ahead) fs.rmSync(SIG.signalFile(addons, 'ack', s));
    const armedBefore = signalFiles(forever.addons);
    assert.ok(armedBefore.length > 400, 'client A has its signal files armed');
    await withEra(h, async (era, eraDirs) => {
      const r = await era.say('only for era');
      for (const s of ahead) {
        assert.ok(fs.existsSync(SIG.signalFile(eraAddons, 'ack', s)), `B's ack ${s} ahead of its message is armed again`);
        assert.ok(!fs.existsSync(SIG.signalFile(forever.addons, 'ack', s)), `A's ack ${s} is left as it was`);
      }
      assert.match(r.text, /echo \(turn 1\): only for era/);
      await h.bridge.waitForLine(/strip #\d+ \((screenshot \S+|chat log) from _classic_era_/);
      assert.deepEqual(signalFiles(forever.addons), armedBefore, 'no ack, sig or act file of client A was spent');
      assert.ok(signalFiles(eraDirs.addons).length < armedBefore.length, 'client B spent its own signals');
      for (const body of slotBodies(forever.addons)) assert.doesNotMatch(body, /only for era/, 'no slot of client A carries the reply');
      assert.doesNotMatch(fs.readFileSync(SIG.runtimeInbox(forever.addons), 'utf8'), /only for era/);
      assert.ok(slotBodies(eraDirs.addons).some(b => /only for era/.test(b)), 'client B\'s slots carry it');
      assert.match(fs.readFileSync(SIG.runtimeInbox(eraDirs.addons), 'utf8'), /only for era/);
      const state = h.state();
      assert.ok(CLI.heardAt(state, CLI.keyOf(eraDirs.client)) > 0, 'the bridge heard client B');
      assert.equal(CLI.heardAt(state, CLI.keyOf(forever.client)), 0, 'and never client A');
      for (const c of h.sb.clients) assert.ok(h.clientState(c.client).presence, `${c.flavor} keeps a presence ring of its own`);
    });
  });
});

test('two clients running at once each get their own replies, and diag in each names both with the one that spoke last', async () => {
  await withGame(TWO, async h => {
    await withEra(h, async era => {
      const a = await h.client.say('from forever');
      const b = await era.say('from era');
      assert.match(a.text, /from forever/);
      assert.match(b.text, /from era/);
      assert.doesNotMatch(JSON.stringify(h.client.db().chats), /from era/, 'client A never shows client B\'s chat');
      assert.doesNotMatch(JSON.stringify(era.db().chats), /from forever/, 'client B never shows client A\'s chat');
      const diag = await era.waitFor(() => { const d = era.diag(); return /clients: .*_classic_era_ \(this client\)[^;]*spoke last/.test(d) && d; }, { timeoutMs: 20000, everyMs: 500, label: 'the clients line in diag' });
      assert.match(diag, /clients: _classic_beta_: \d+\.\d+\.\d+ build [0-9a-f]{12}, heard .* ago; _classic_era_ \(this client\): \d+\.\d+\.\d+ build [0-9a-f]{12}, heard .* ago, spoke last/);
    });
  });
});

test('each run gets the game context of the client its message came from, even when the other client spoke since', async () => {
  await withGame(TWO, async h => {
    await h.client.connect();
    await withEra(h, async era => {
      await era.connect();
      await h.bridge.waitForLine(/game context updated: .*/, { timeoutMs: 20000 });
      const a = await h.client.say('which game am I in');
      const b = await era.say('and this one');
      const calls = h.agentCalls();
      const promptOf = text => (calls.find(c => String(c.prompt || '').includes(text)) || {}).prompt || '';
      assert.match(promptOf('which game am I in'), /1\.60\.1/, 'client A\'s run carries A\'s build');
      assert.doesNotMatch(promptOf('which game am I in'), /1\.15\.9/, 'and not the build of B, which spoke after A');
      assert.match(promptOf('and this one'), /1\.15\.9/);
      assert.doesNotMatch(promptOf('and this one'), /1\.60\.1/);
      assert.match(a.text, /which game/);
      assert.match(b.text, /this one/);
    });
  });
});

test('a reload-mode message from client B is read from B\'s SavedVariables and answered in B\'s Inbox.lua only', async () => {
  await withGame({ ...TWO, run: false }, async h => {
    const forever = h.sb.clients[0];
    await withEra(h, async (era, eraDirs) => {
      await era.connect();
      era.slash('/claude config mode reload');
      const id = era.lastSeq() + 1;
      era.send('by reload in era');
      era.reload();
      await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ \\(reload\\)`), { timeoutMs: 20000 });
      await era.waitFor(() => /by reload in era/.test(fs.readFileSync(SIG.runtimeInbox(eraDirs.addons), 'utf8')), { timeoutMs: 30000, label: 'the reply in B\'s Inbox.lua' });
      assert.doesNotMatch(fs.readFileSync(SIG.runtimeInbox(forever.addons), 'utf8'), /by reload in era/);
      for (const body of slotBodies(forever.addons)) assert.doesNotMatch(body, /by reload in era/);
    });
  });
});
