'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const luaparse = require('luaparse');
const CLI = require('../bridge/clients');
const SIG = require('../bridge/signals');
const MH = require('../bridge/maphold');
const P = require('../bridge/protocol');
const { createPublisher, addonSessionOfKey, REPLIES_KEPT, REPLY_KEEP_MS, INBOX_GLOBAL, SLOT_GLOBAL } = require('../bridge/publisher');

const SLOTS = 3;
const START = 1700000000000;
const TOC = '## Interface: 11509\n## Version: 0.5.0\n## X-Build: 0123456789ab\nCore/Namespace.lua\nClaudeWoW.lua\n';

function luaUnescape(s) {
  return s.replace(/\\(\d{1,3}|.)/g, (_, e) => (/^\d/.test(e) ? String.fromCharCode(Number(e)) : e === 'n' ? '\n' : e));
}

function value(node) {
  if (node.type === 'TableConstructorExpression') {
    const out = {};
    const arr = [];
    for (const f of node.fields) {
      if (f.type === 'TableKeyString') out[f.key.name] = value(f.value);
      else arr.push(value(f.value));
    }
    return arr.length ? arr : out;
  }
  if (node.type === 'StringLiteral') return luaUnescape(node.raw.slice(1, -1));
  if (node.type === 'NumericLiteral') return node.value;
  if (node.type === 'BooleanLiteral') return node.value;
  return null;
}

function readSlot(src, globalName) {
  const ast = luaparse.parse(src, { luaVersion: '5.1' });
  const assign = ast.body.find(n => n.type === 'AssignmentStatement' && n.variables[0].name === globalName);
  assert.ok(assign, globalName + ' assignment present');
  return value(assign.init[0]);
}

function slotPath(addons, i) {
  return path.join(addons, `ClaudeWoW_S${P.pad3(i)}`, 'Inbox.lua');
}

function gameFolder({ addon = true, slots = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-publisher-'));
  const addons = path.join(dir, 'Interface', 'AddOns');
  if (addon) {
    fs.mkdirSync(path.join(addons, 'ClaudeWoW'), { recursive: true });
    fs.writeFileSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.toc'), TOC);
    fs.mkdirSync(SIG.runtimeRoot(addons), { recursive: true });
  }
  if (addon && slots) {
    for (let i = 1; i <= SLOTS; i++) {
      fs.mkdirSync(path.dirname(slotPath(addons, i)), { recursive: true });
      fs.writeFileSync(slotPath(addons, i), '');
    }
  }
  return addons;
}

function fakeTimers() {
  const queue = [];
  let nextId = 1;
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      queue.push({ id, ms, fn });
      return id;
    },
    clearTimeout(id) {
      const i = queue.findIndex(t => t.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    fire() {
      const due = queue.splice(0);
      for (const t of due) t.fn();
    },
    pending: () => queue.map(t => t.ms),
  };
}

function harness({ folder = {}, map = null, fields = {}, cfg = {}, state = { lastId: 0, handled: {} }, defaultClient } = {}) {
  const addons = gameFolder(folder);
  const clients = CLI.clientsOf({ addonDir: addons });
  const runtimes = new Map(clients.map(c => [c.key, { client: c, acks: [], warnedNoAddon: false, diskCache: { key: '', info: null } }]));
  const live = new Map();
  const titles = new Map();
  const logs = [];
  const timers = fakeTimers();
  const clock = { now: START };
  let saves = 0;
  let saveError = null;
  const publisher = createPublisher({
    state,
    live,
    cfg,
    log: line => logs.push(line),
    saveState: () => {
      if (saveError) throw saveError;
      saves++;
    },
    slots: SLOTS,
    clients: { list: clients, runtimes, defaultClient: defaultClient || (() => clients[0]), inLabel: c => ` (${c.label})` },
    titleOf: key => titles.get(key) || null,
    map,
    fields: {
      cwd: () => 'C:\\proj',
      agent: () => 'claude',
      agents: () => ['claude', 'codex'],
      plugin: () => 'ask',
      plugins: () => ['ask', 'claude-code'],
      transport: () => 'screenshot',
      levels: () => ({ off: 0, on: 60 }),
      codec: () => 2,
      bridge: () => ({ version: '0.5.0', protoMin: 1, protoMax: 1 }),
      achievementsLua: () => '\tachievements = { "a" },',
      goalsLua: () => '\tgoals = { "g" },',
      dmLua: () => '\tdm = { "d" },',
      gsLua: () => '\tgs = { "s" },',
      openUrl: () => true,
      discord: () => false,
      mirror: () => [],
      ...fields,
    },
    perClient: {
      chatlog: () => ({ enabled: true, line: 100, filler: 200, key: 'a'.repeat(32), show: false }),
      presence: () => ({ scheme: 'armed', ring: 'a', at: 2, n: 5, probe: 'abcd' }),
      alive: () => [{ session: 'tokA', id: 7, since: 1 }],
      runLimit: 1800,
    },
    timers,
    now: () => clock.now,
  });
  const client = clients[0];
  const inbox = () => readSlot(fs.readFileSync(client.inboxFile, 'utf8'), INBOX_GLOBAL);
  const slot = i => readSlot(fs.readFileSync(slotPath(addons, i), 'utf8'), SLOT_GLOBAL);
  return {
    addons,
    client,
    runtimes,
    live,
    titles,
    logs,
    timers,
    clock,
    state,
    publisher,
    inbox,
    slot,
    saves: () => saves,
    failSaves(err) {
      saveError = err;
    },
  };
}

const record = (chat, id, status, text, client, extra = {}) => ({ chat, id, status, text, client, agent: 'claude', ...extra });

test('publishNow writes the inbox and every slot: both chats in order, the shared fields and the per-client fields', () => {
  const h = harness();
  const key = h.client.key;
  h.runtimes.get(key).acks = P.noteAck([], { id: 1, session: 'tokA' }, Date.now());
  h.publisher.publish('tokA:c1', record('c1', 1, 'done', 'first reply', key, { summary: 'done it' }), true);
  h.publisher.publish('tokA:c2', record('c2', 2, 'working', 'second', key, { steps: 2 }), true);

  const d = h.inbox();
  assert.ok(Math.abs(d.now - Date.now() / 1000) < 60, 'the slot clock is the real one, not the publish throttle clock');
  assert.equal(d.cwd, 'C:\\proj');
  assert.equal(d.agent, 'claude');
  assert.deepEqual(d.agents, ['claude', 'codex']);
  assert.equal(d.plugin, 'ask');
  assert.deepEqual(d.plugins, ['ask', 'claude-code']);
  assert.equal(d.transport, 'screenshot');
  assert.deepEqual(d.strip, { on: 60, off: 0, codec: 2 });
  assert.deepEqual(d.bridge, { version: '0.5.0', protoMin: 1, protoMax: 1 });
  assert.deepEqual(d.addonDisk, { version: '0.5.0', build: '0123456789ab', files: 2, fileHash: P.fnv1a('Core/Namespace.lua\nClaudeWoW.lua') });
  assert.equal(d.clients.length, 1);
  assert.equal(d.clients[0].here, true);
  assert.equal(d.clients[0].version, '0.5.0');
  assert.equal(d.runLimit, 1800);
  assert.deepEqual(d.alive, [{ session: 'tokA', id: 7, since: 1 }]);
  assert.deepEqual(d.acks, [{ session: 'tokA', id: 1 }]);
  assert.equal(d.chatlog.line, 100);
  assert.equal(d.presence.ring, 'a');
  assert.equal(d.signals, 'armed');
  assert.equal(d.home, os.homedir());
  assert.equal(d.openUrl, true);
  assert.deepEqual(d.achievements, ['a']);
  assert.deepEqual(d.goals, ['g']);
  assert.deepEqual(d.dm, ['d']);
  assert.deepEqual(d.gs, ['s']);
  assert.equal(d.replies.length, 2);
  assert.deepEqual(
    d.replies.map(r => [r.chat, r.id, r.status, r.text, r.token]),
    [
      ['c1', 1, 'done', 'first reply', 'tokA'],
      ['c2', 2, 'working', 'second', 'tokA'],
    ],
  );
  assert.equal(d.replies[0].summary, 'done it');
  assert.equal(d.replies[1].steps, 2);

  const bodies = [1, 2, 3].map(i => fs.readFileSync(slotPath(h.addons, i), 'utf8'));
  assert.equal(new Set(bodies).size, 1, 'every slot carries the same body');
  const s = h.slot(2);
  assert.equal(s.replies.length, 2);
  assert.equal(s.cwd, 'C:\\proj');
  assert.ok(bodies[0].startsWith(`-- Written by the claude-wow bridge (bridge/bridge.js). Do not edit by hand.\n${SLOT_GLOBAL} = {`));

  assert.deepEqual(Object.keys(h.state.replies), ['tokA:c1'], 'only the finished reply is kept');
  assert.equal(h.saves(), 1);
  assert.equal(h.publisher.lastPublishAt(), START);
  assert.deepEqual(h.logs, []);
});

test('the publisher ignores the inLabel and defaultClient defaults it is not given and still publishes', () => {
  const addons = gameFolder();
  const clients = CLI.clientsOf({ addonDir: addons });
  const runtimes = new Map(clients.map(c => [c.key, { client: c, acks: [], warnedNoAddon: false, diskCache: { key: '', info: null } }]));
  const state = { replies: { 'tokA:c1': { at: Date.now(), record: { id: 1, status: 'done', client: 'gone', chat: 'c1', text: 'x' } } } };
  const live = new Map();
  const pub = createPublisher({ state, live, log: () => {}, saveState: () => {}, slots: SLOTS, clients: { list: clients, runtimes } });
  pub.restoreReplies();
  assert.equal(live.get('tokA:c1').client, clients[0].key, 'the first client is the default');
  pub.publishNow();
  const d = readSlot(fs.readFileSync(clients[0].inboxFile, 'utf8'), INBOX_GLOBAL);
  assert.equal(d.transport, 'screenshot');
  assert.equal(d.replies.length, 1);
  assert.equal(d.cwd, '');
});

test('sharedSlotFields: a dm or gs source that throws is logged and left out; widgets follow the urgent flag', () => {
  const set = P.newWidgetSet('ep1');
  P.applyWidgetCommands(set, [{ op: 'set', name: 'w1', source: 'local ui = ...' }]);
  const h = harness({
    fields: {
      widgets: urgent => (urgent ? set : null),
      dmLua: () => {
        throw new Error('boom dm');
      },
      gsLua: () => {
        throw new Error('boom gs');
      },
    },
  });
  const urgent = h.publisher.sharedSlotFields(true);
  assert.equal(urgent.widgets, set);
  assert.equal(urgent.dmLua, '');
  assert.equal(urgent.gsLua, '');
  assert.equal(urgent.goalsLua, '\tgoals = { "g" },');
  assert.deepEqual(h.logs, ['campaign: slot field dm left out (boom dm)', 'telemetry: slot field gs left out (boom gs)']);
  assert.equal(h.publisher.sharedSlotFields(false).widgets, null);
  h.publisher.publishNow(true);
  const d = h.inbox();
  assert.equal(d.widgets.items[0].name, 'w1');
  assert.equal(d.dm, undefined);
  assert.equal(d.gs, undefined);
});

test('keepReply keeps final replies only, newest REPLIES_KEPT, and logs a save that fails', () => {
  const h = harness();
  const key = h.client.key;
  h.publisher.keepReply('tokA:c1', record('c1', 1, 'working', 'w', key));
  assert.equal(h.state.replies, undefined, 'a progress record for a chat without a kept reply changes nothing');
  assert.equal(h.saves(), 0);

  h.publisher.keepReply('tokA:c1', record('c1', 1, 'done', 'd', key));
  assert.equal(h.state.replies['tokA:c1'].at, START);
  assert.equal(h.saves(), 1);
  h.publisher.keepReply('tokA:c1', record('c1', 2, 'working', 'w2', key));
  assert.equal(h.state.replies, undefined, 'a new run on that chat drops the kept reply');
  assert.equal(h.saves(), 2);

  for (let i = 1; i <= REPLIES_KEPT + 2; i++) h.publisher.keepReply(`tokA:k${i}`, record(`k${i}`, i, i % 2 ? 'done' : 'error', 't', key));
  const kept = Object.keys(h.state.replies);
  assert.equal(kept.length, REPLIES_KEPT);
  assert.deepEqual(kept.slice(0, 2), ['tokA:k3', 'tokA:k4'], 'the two oldest are gone');

  h.failSaves(new Error('disk full'));
  h.publisher.keepReply('tokA:z', record('z', 99, 'done', 't', key));
  assert.deepEqual(h.logs, ['could not save the latest reply to state.json (disk full)']);
});

test('restoreReplies republishes kept final replies, drops stale or unfinished ones, and points an unknown client at the default', () => {
  const key = (() => harness().client.key)();
  const state = {
    replies: {
      'tokA:c1': { at: START - 1000, record: record('c1', 1, 'done', 'kept', key) },
      'tokA:c2': { at: START - REPLY_KEEP_MS, record: record('c2', 2, 'done', 'stale', key) },
      'tokA:c3': { at: START, record: record('c3', 3, 'working', 'unfinished', key) },
      'tokA:c4': { at: START, record: { chat: 'c4', id: 'x', status: 'done', text: 'bad id', client: key } },
      'tokB:c5': { at: START, record: record('c5', 5, 'error', 'other client', 'nope') },
      'tokB:c6': 'not an entry',
    },
  };
  const h = harness({ state });
  h.publisher.restoreReplies();
  assert.deepEqual([...h.live.keys()], ['tokA:c1', 'tokB:c5']);
  assert.equal(h.live.get('tokB:c5').client, h.client.key);
  assert.deepEqual(Object.keys(h.state.replies), ['tokA:c1', 'tokB:c5']);
  assert.equal(h.saves(), 1);
  assert.deepEqual(h.logs, ['republishing 2 finished replies from before the restart, so a reply the game has not read yet is not lost']);

  const quiet = harness();
  quiet.publisher.restoreReplies();
  assert.equal(quiet.live.size, 0);
  assert.equal(quiet.saves(), 0);
  assert.deepEqual(quiet.logs, []);

  const orphan = harness({ state: { replies: { 'tokB:c5': { at: START, record: record('c5', 5, 'done', 'o', 'nope') } } }, defaultClient: () => null });
  orphan.publisher.restoreReplies();
  assert.equal(orphan.live.size, 0);
  assert.equal(orphan.state.replies, undefined);
  assert.equal(orphan.saves(), 1);

  const one = harness({ state: { replies: { 'tokA:c1': { at: START, record: record('c1', 1, 'done', 'k', key) } } } });
  one.publisher.restoreReplies();
  assert.equal(one.saves(), 0, 'nothing dropped, nothing saved');
  assert.deepEqual(one.logs, ['republishing 1 finished reply from before the restart, so a reply the game has not read yet is not lost']);
});

test('publish: urgent writes at once, progress waits progressWriteMs on a timer, and an urgent publish clears the timer', () => {
  const h = harness({ cfg: { progressWriteMs: 1000 } });
  const key = h.client.key;
  h.titles.set('tokA:c1', { title: 'Realms', id: 1 });

  h.publisher.publish('tokA:c1', record('c1', 1, 'working', 'step 1', key), false);
  assert.equal(h.inbox().replies[0].text, 'step 1', 'the first progress record goes out at once: nothing was published for a long time');
  assert.equal(h.inbox().replies[0].title, 'Realms');
  assert.equal(h.inbox().replies[0].titleFor, 1);
  assert.deepEqual(h.timers.pending(), []);

  h.clock.now += 400;
  h.publisher.publish('tokA:c1', record('c1', 1, 'working', 'step 2', key), false);
  assert.equal(h.inbox().replies[0].text, 'step 1', 'throttled');
  assert.deepEqual(h.timers.pending(), [600]);
  h.publisher.publish('tokA:c1', record('c1', 1, 'working', 'step 3', key), false);
  assert.deepEqual(h.timers.pending(), [600], 'one timer at a time');
  h.timers.fire();
  assert.equal(h.inbox().replies[0].text, 'step 3');
  assert.deepEqual(h.timers.pending(), []);

  h.clock.now += 100;
  h.publisher.publish('tokA:c1', record('c1', 1, 'working', 'step 4', key), false);
  assert.deepEqual(h.timers.pending(), [900]);
  h.publisher.publish('tokA:c1', record('c1', 1, 'done', 'final', key, { title: 'Mine' }), true);
  assert.deepEqual(h.timers.pending(), [], 'the urgent publish cleared the timer');
  const d = h.inbox();
  assert.equal(d.replies[0].text, 'final');
  assert.equal(d.replies[0].title, 'Mine', 'a record with its own title keeps it');
  assert.equal(d.replies[0].titleFor, undefined);
  h.timers.fire();
  assert.equal(h.inbox().replies[0].text, 'final');
});

test('signal files: off arms the slot file, on fires it, and no client is a no-op', () => {
  const h = harness();
  const file = SIG.signalFile(h.addons, 'sig', P.slotNumber(5, SLOTS));
  assert.equal(path.basename(path.dirname(file)), 'sig');
  assert.ok(!fs.existsSync(file));
  h.publisher.signal(h.client, 'sig', 5, false);
  assert.ok(fs.existsSync(file), 'armed');
  assert.ok(fs.readFileSync(file).equals(P.SILENT_WAV));
  h.publisher.signal(h.client, 'sig', 5, true);
  assert.ok(!fs.existsSync(file), 'fired');
  h.publisher.signal(null, 'sig', 5, true);
  const ack = SIG.signalFile(h.addons, 'ack', 1);
  h.publisher.setSignalFile(ack, false);
  assert.ok(fs.existsSync(ack));
});

test('a restore bundle rides along for three publishes that carried it; a refresh publish does not count', () => {
  const h = harness();
  h.publisher.offerRestore({ token: 'tokA', char: 'Bob', chats: [{ id: 'c1', name: 'n', cwd: '', plugin: 'ask', messages: [] }], client: '' });
  assert.equal(h.publisher.restoreFor(h.client).token, 'tokA');
  assert.equal(h.publisher.restoreFor({ key: 'other' }).token, 'tokA', 'a bundle without a client goes to every client');
  h.publisher.publishNow();
  assert.equal(h.inbox().restore.token, 'tokA');
  assert.equal(h.inbox().restore.char, 'Bob');
  h.publisher.publishNow(true, { refresh: true });
  h.publisher.publishNow(true, { refresh: true });
  assert.ok(h.publisher.pendingRestore(), 'refresh publishes do not count');
  h.publisher.publishNow();
  assert.ok(h.publisher.pendingRestore());
  h.publisher.publishNow();
  assert.equal(h.publisher.pendingRestore(), null, 'dropped after the third publish that carried it');
  assert.equal(h.inbox().restore.token, 'tokA', 'that third publish still carried it');
  h.publisher.publishNow();
  assert.equal(h.inbox().restore, undefined);

  h.publisher.offerRestore({ token: 'tokB', chats: [], client: 'elsewhere' });
  assert.equal(h.publisher.restoreFor(h.client), null, 'a bundle for another client is not ours');
  h.publisher.publishNow();
  assert.ok(h.publisher.pendingRestore(), 'not sent, so not counted');
});

test('a missing addon folder is logged once and never throws; without slot folders only the inbox is written', () => {
  const none = harness({ folder: { addon: false } });
  none.publisher.publishNow();
  none.publisher.publishNow();
  assert.equal(none.logs.length, 1);
  assert.match(none.logs[0], /^publish: cannot write .*Inbox\.lua \(ENOENT\); addon not installed in /);
  assert.equal(none.publisher.slotsInstalled(none.client), false);
  assert.equal(none.publisher.addonOnDisk(none.client), null);
  assert.equal(none.runtimes.get(none.client.key).warnedNoAddon, true);

  const inboxOnly = harness({ folder: { slots: false } });
  inboxOnly.publisher.publishNow();
  assert.equal(inboxOnly.publisher.slotsInstalled(inboxOnly.client), false);
  assert.ok(fs.existsSync(inboxOnly.client.inboxFile));
  assert.ok(!fs.existsSync(slotPath(inboxOnly.addons, 1)));
  assert.deepEqual(inboxOnly.logs, []);
});

test('addonOnDisk reads the toc once per change', () => {
  const h = harness();
  const first = h.publisher.addonOnDisk(h.client);
  assert.equal(first.version, '0.5.0');
  assert.equal(h.publisher.addonOnDisk(h.client), first, 'cached by mtime, size and inode');
  const toc = path.join(h.addons, 'ClaudeWoW', 'ClaudeWoW.toc');
  fs.writeFileSync(toc, TOC.replace('0.5.0', '0.6.0') + 'Extra.lua\n');
  const st = fs.statSync(toc);
  fs.utimesSync(toc, st.atime, new Date(st.mtimeMs + 5000));
  const next = h.publisher.addonOnDisk(h.client);
  assert.equal(next.version, '0.6.0');
  assert.equal(next.files, 3);
});

test('slotMap: the character map rides along while shared, and on a progress publish only while small', () => {
  const state = { lastId: 0, handled: {}, maps: {} };
  const clock = { now: START };
  const share = MH.createMapShare({ state, shareMs: 1000, now: () => clock.now });
  const mapFor = key => MH.mapOf(state, key, P.newMap);
  const h = harness({ state, map: { mapFor, share, characterKeyOf: text => (text ? 'Bob-Realm' : ''), progressMax: 10 } });
  h.clock.now = clock.now;
  assert.equal(h.publisher.slotMap(h.client, true), null, 'no character and no layers: nothing');

  CLI.clientState(state, h.client.key).char = 'Bob-Realm';
  const layers = mapFor('Bob-Realm');
  P.applyMapCommands(layers, [{ op: 'set', layer: 'ore', points: [{ m: 1414, x: 10, y: 20, label: 'Copper', kind: 'ore' }] }]);
  share.touch();
  h.publisher.publishNow(true);
  const d = h.inbox();
  assert.equal(d.map.char, 'Bob-Realm');
  assert.equal(d.map.layers.length, 1);
  assert.equal(d.map.layers[0].name, 'ore');

  h.publisher.publishNow(false);
  assert.equal(h.inbox().map, undefined, 'a progress publish leaves out a map bigger than progressMax');
  assert.equal(h.publisher.slotMap(h.client, true), layers, 'the size is cached per version');

  clock.now += 2000;
  h.clock.now = clock.now;
  h.publisher.publishNow(true);
  assert.equal(h.inbox().map, undefined, 'the share window is over');
  share.hold();
  assert.equal(h.publisher.slotMap(h.client, true), layers, 'held for the game until it reads');

  delete CLI.clientState(state, h.client.key).char;
  state.context = '';
  assert.equal(h.publisher.slotMap(h.client, true), null, 'no character known and the context names none');
});

test('addonSessionOfKey takes the addon session token off a chat key', () => {
  assert.equal(addonSessionOfKey('tokA:c1'), 'tokA');
  assert.equal(addonSessionOfKey(':default'), '');
  assert.equal(addonSessionOfKey('plain'), 'plain');
});
