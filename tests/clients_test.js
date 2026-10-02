'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CLI = require('../bridge/clients');
const P = require('../bridge/protocol');
const SIG = require('../bridge/signals');

const ROOT = path.resolve(os.tmpdir(), 'claude-wow-clients-test');
const FOREVER = path.join(ROOT, 'World of Warcraft', '_classic_beta_');
const ERA = path.join(ROOT, 'World of Warcraft', '_classic_era_');
const addonsOf = dir => path.join(dir, 'Interface', 'AddOns');
const savedOf = (dir, account, name = P.ADDON) => path.join(dir, 'WTF', 'Account', account, 'SavedVariables', name + '.lua');

function legacyConfig(dir = FOREVER, extra = {}) {
  return {
    addonDir: addonsOf(dir),
    savedVariablesFile: savedOf(dir, 'ACCT#1'),
    inboxFile: SIG.runtimeInbox(addonsOf(dir)),
    tocInterface: P.TOC_INTERFACE,
    capture: { processName: 'World of Warcraft' },
    ...extra,
  };
}

test('a single-client config from before clients[] reads as one client with the same paths the bridge used', () => {
  const [c, ...rest] = CLI.clientsOf(legacyConfig());
  assert.deepEqual(rest, []);
  assert.equal(c.key, path.resolve(FOREVER));
  assert.equal(c.label, '_classic_beta_');
  assert.equal(c.product, 'wow_classic_beta');
  assert.equal(c.account, 'ACCT#1');
  assert.equal(c.addonDir, addonsOf(FOREVER));
  assert.equal(c.inboxFile, SIG.runtimeInbox(addonsOf(FOREVER)));
  assert.equal(c.savedVariablesFile, savedOf(FOREVER, 'ACCT#1'));
  assert.equal(c.screenshotDir, path.join(FOREVER, 'Screenshots'));
  assert.equal(c.chatLogFile, path.join(FOREVER, 'Logs', 'WoWChatLog.txt'));
  assert.equal(c.processName, 'World of Warcraft');
  assert.equal(c.tocInterface, P.TOC_INTERFACE);
});

test('an old config naming a renamed addon is read with the new names, as the bridge did', () => {
  const cfg = legacyConfig(FOREVER, {
    inboxFile: path.join(addonsOf(FOREVER), 'WoWAI', 'Inbox.lua'),
    savedVariablesFile: savedOf(FOREVER, 'ACCT#1', 'WoWAI'),
  });
  const [c] = CLI.clientsOf(cfg);
  assert.equal(c.inboxFile, SIG.runtimeInbox(addonsOf(FOREVER)), 'an inbox in an old addon folder is redirected');
  assert.equal(c.savedVariablesFile, savedOf(FOREVER, 'ACCT#1'));
  const shipped = CLI.clientsOf(legacyConfig(FOREVER, { inboxFile: path.join(addonsOf(FOREVER), P.ADDON, 'Inbox.lua') }))[0];
  assert.equal(shipped.inboxFile, SIG.runtimeInbox(addonsOf(FOREVER)), 'an inbox in the shipped folder is redirected');
  const custom = CLI.clientsOf(legacyConfig(FOREVER, { capture: { screenshotDir: '/elsewhere/shots' } }))[0];
  assert.equal(custom.screenshotDir, path.resolve('/elsewhere/shots'));
});

test('clients[] derives every path from dir and the account, and its entries win over the old keys', () => {
  const cfg = { ...legacyConfig(ERA), clients: [{ dir: FOREVER, account: 'A#1' }, { dir: ERA, account: 'B#2', tocInterface: '11509', processName: 'World of Warcraft Classic' }] };
  const [forever, era] = CLI.clientsOf(cfg);
  assert.equal(forever.dir, FOREVER);
  assert.equal(forever.savedVariablesFile, savedOf(FOREVER, 'A#1'));
  assert.equal(forever.inboxFile, SIG.runtimeInbox(addonsOf(FOREVER)));
  assert.equal(forever.processName, 'World of Warcraft', 'the capture default fills what an entry leaves out');
  assert.equal(forever.tocInterface, P.TOC_INTERFACE);
  assert.equal(era.savedVariablesFile, savedOf(ERA, 'B#2'));
  assert.equal(era.tocInterface, '11509');
  assert.equal(era.processName, 'World of Warcraft Classic');
  assert.equal(CLI.clientsOf(cfg).length, 2, 'the old addonDir is not read as a third client');
});

test('an entry without an account has no reload outbox, a disabled one is listed but not served, and the same folder twice is one client', () => {
  const cfg = { clients: [{ dir: FOREVER }, { dir: FOREVER + path.sep, account: 'X' }, { dir: ERA, enabled: false }, { account: 'no dir' }, null] };
  const all = CLI.allClients(cfg);
  assert.deepEqual(all.map(c => c.label), ['_classic_beta_', '_classic_era_']);
  assert.equal(all[0].savedVariablesFile, '', 'no account, no SavedVariables file to poll');
  assert.equal(all[1].enabled, false);
  assert.deepEqual(CLI.clientsOf(cfg).map(c => c.label), ['_classic_beta_']);
  assert.deepEqual(CLI.clientsOf({}), []);
  assert.deepEqual(CLI.clientsOf({ clients: [] , addonDir: addonsOf(ERA) }).map(c => c.label), ['_classic_era_'], 'an empty clients[] falls back to the old keys');
});

test('migrateConfig moves the old keys into clients[0], keeps only what cannot be derived, and is idempotent', () => {
  const cfg = legacyConfig(FOREVER, { defaultCwd: '/code' });
  cfg.capture.screenshotDir = '/elsewhere/shots';
  assert.deepEqual(CLI.migrateConfig(cfg), ['clients']);
  assert.deepEqual(cfg.clients, [{ dir: FOREVER, account: 'ACCT#1', processName: 'World of Warcraft', screenshotDir: '/elsewhere/shots' }]);
  for (const k of CLI.LEGACY_KEYS) assert.equal(k in cfg, false, k);
  assert.equal(cfg.capture.screenshotDir, undefined);
  assert.equal(cfg.defaultCwd, '/code');
  assert.deepEqual(CLI.clientsOf(cfg)[0].savedVariablesFile, savedOf(FOREVER, 'ACCT#1'), 'the migrated entry resolves to the same file');
  assert.deepEqual(CLI.migrateConfig(cfg), [], 'a second run changes nothing');
  const odd = legacyConfig(FOREVER, { addonDir: '/custom/AddOns', savedVariablesFile: '/custom/saved.lua' });
  CLI.migrateConfig(odd);
  assert.equal(odd.clients[0].addonDir, '/custom/AddOns', 'an addonDir that is not <dir>/Interface/AddOns is kept');
  assert.equal(odd.clients[0].savedVariablesFile, '/custom/saved.lua', 'a SavedVariables path that names no account is kept');
  const both = { clients: [{ dir: ERA }], addonDir: addonsOf(FOREVER) };
  assert.deepEqual(CLI.migrateConfig(both), ['clients'], 'leftover old keys next to clients[] are dropped');
  assert.deepEqual(both.clients, [{ dir: ERA }]);
  assert.equal(both.addonDir, undefined);
});

test('upsertClient adds a new folder, updates a known one in place, and keeps a disabled entry disabled', () => {
  const cfg = { clients: [{ dir: FOREVER, account: 'A' }] };
  assert.equal(CLI.upsertClient(cfg, { dir: ERA, account: 'B' }), 'added');
  assert.equal(CLI.upsertClient(cfg, { dir: FOREVER + path.sep, account: 'A' }), 'same');
  assert.equal(CLI.upsertClient(cfg, { dir: FOREVER, account: 'C', processName: 'World of Warcraft' }), 'updated');
  assert.deepEqual(cfg.clients, [{ dir: FOREVER, account: 'C', processName: 'World of Warcraft' }, { dir: ERA, account: 'B' }]);
  cfg.clients[1].enabled = false;
  assert.equal(CLI.upsertClient(cfg, { dir: ERA, account: 'B' }), 'same');
  assert.equal(cfg.clients[1].enabled, false);
  assert.equal(CLI.upsertClient(cfg, { dir: ERA, account: 'B', enabled: true }), 'updated');
  assert.equal(cfg.clients[1].enabled, undefined, 'enabled is the default, so it is not written');
});

test('per-client state: the old top-level ring moves to the first client once, and each client keeps its own', () => {
  const clients = CLI.clientsOf({ clients: [{ dir: FOREVER }, { dir: ERA }] });
  const state = { presence: { ring: 'b', at: 7 }, presenceTest: { result: 'failed' }, chatLogWrites: [50000], lastId: 9 };
  assert.deepEqual(CLI.legacyStateFor(state, clients, clients[0].key).presence, { ring: 'b', at: 7 }, 'read before the move');
  assert.deepEqual(CLI.legacyStateFor(state, clients, clients[1].key), {}, 'the second client never inherits the old ring');
  assert.equal(CLI.adoptLegacyState(state, clients), true);
  assert.deepEqual(state.clients[clients[0].key], { presence: { ring: 'b', at: 7 }, presenceTest: { result: 'failed' }, chatLogWrites: [50000] });
  assert.equal(state.clients[clients[1].key], undefined);
  for (const k of CLI.STATE_KEYS) assert.equal(state[k], undefined, k);
  assert.equal(state.lastId, 9, 'dedupe state stays where it was');
  assert.equal(CLI.adoptLegacyState(state, clients), false);
  CLI.clientState(state, clients[1].key).presence = { ring: 'a', at: 3 };
  state.presence = { ring: 'a', at: 1999 };
  CLI.adoptLegacyState(state, clients);
  assert.deepEqual(state.clients[clients[0].key].presence, { ring: 'b', at: 7 }, 'a client that already has its own ring keeps it');
  assert.deepEqual(state.clients[clients[1].key].presence, { ring: 'a', at: 3 });
  assert.equal(CLI.adoptLegacyState({ presence: { ring: 'a' } }, []), false, 'no client, nothing to move to');
});

test('lastSpoke picks the client heard last, ignores dates no Date can hold, and noteHeard keeps the highest id per client', () => {
  const clients = CLI.clientsOf({ clients: [{ dir: FOREVER }, { dir: ERA }] });
  const state = {};
  assert.equal(CLI.lastSpoke(state, clients), null);
  CLI.noteHeard(state, clients[0].key, { now: 1000, id: 5 });
  CLI.noteHeard(state, clients[1].key, { now: 2000, hello: true, id: 2 });
  assert.equal(CLI.lastSpoke(state, clients).label, '_classic_era_');
  CLI.noteHeard(state, clients[0].key, { now: 3000, id: 4 });
  assert.equal(CLI.lastSpoke(state, clients).label, '_classic_beta_');
  assert.equal(state.clients[clients[0].key].lastId, 5, 'a lower id does not lower lastId');
  assert.equal(state.clients[clients[1].key].hello, 2000);
  CLI.noteHeard(state, clients[1].key, { now: 3000, id: 7.5 });
  assert.equal(state.clients[clients[1].key].lastId, 2, 'a fractional id is not an id');
  state.clients[clients[1].key].heard = 9e15;
  assert.equal(CLI.heardAt(state, clients[1].key), 0);
  assert.equal(CLI.lastSpoke(state, clients).label, '_classic_beta_');
});

test('recordsFor routes each reply only to the client its message came from, newest last, capped', () => {
  const a = CLI.keyOf(FOREVER), b = CLI.keyOf(ERA);
  const records = [{ id: 1, client: a }, { id: 1, client: b }, { id: 2, client: a }, { id: 3 }, null, { id: 4, client: a }];
  assert.deepEqual(CLI.recordsFor(records, a).map(r => r.id), [1, 2, 4]);
  assert.deepEqual(CLI.recordsFor(records, b).map(r => r.id), [1]);
  assert.deepEqual(CLI.recordsFor(records, a, 2).map(r => r.id), [2, 4]);
  assert.deepEqual(CLI.recordsFor(records, CLI.keyOf('/nowhere')), [], 'a record without a known client goes nowhere');
});

test('slotClients and describe name each client with its installed build, mark this one and the last speaker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-clients-'));
  try {
    const a = path.join(dir, '_classic_beta_');
    const b = path.join(dir, '_classic_era_');
    fs.mkdirSync(path.join(addonsOf(a), P.ADDON), { recursive: true });
    fs.writeFileSync(path.join(addonsOf(a), P.ADDON, P.ADDON + '.toc'), '## Version: 1.2.3\n## X-Build: aaaaaaaaaaaa\n');
    const clients = CLI.clientsOf({ clients: [{ dir: a }, { dir: b }] });
    const state = {};
    CLI.noteHeard(state, clients[1].key, { now: 5000000 });
    const rows = CLI.slotClients(clients, state, clients[0].key);
    assert.deepEqual(rows, [
      { name: '_classic_beta_', version: '1.2.3', build: 'aaaaaaaaaaaa', heard: 0, here: true, last: false },
      { name: '_classic_era_', version: '', build: '', heard: 5000, here: false, last: true },
    ]);
    const lines = CLI.describe(clients, state, { now: 5000000 + 180000 });
    assert.equal(lines[0], `_classic_beta_: addon 1.2.3 build aaaaaaaaaaaa, not heard yet (${a})`);
    assert.equal(lines[1], `_classic_era_: addon not installed, heard 3 min ago, spoke last (${b})`);
    const odd = CLI.slotClients(CLI.clientsOf({ clients: [{ dir: path.join(dir, 'wow|"x') }] }), {}, '');
    assert.match(odd[0].name, /^[\w .-]+$/, 'a folder name the addon would refuse is made safe');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('accountOf reads the account from POSIX and Windows SavedVariables paths', () => {
  assert.equal(CLI.accountOf('/g/_classic_era_/WTF/Account/84831040#1/SavedVariables/ClaudeWoW.lua'), '84831040#1');
  assert.equal(CLI.accountOf('C:\\WoW\\_classic_\\WTF\\Account\\ABC\\SavedVariables\\ClaudeWoW.lua'), 'ABC');
  assert.equal(CLI.accountOf('/custom/saved.lua'), '');
  assert.equal(CLI.productFor('/x/_classic_era_'), 'wow_classic_era');
  assert.equal(CLI.productFor('/x/_retail_'), 'wow');
});

test('adoptLegacyState copies the old context to the first client listed, disabled or not, and leaves the global one', () => {
  const all = CLI.allClients({ clients: [{ dir: FOREVER, enabled: false }, { dir: ERA }] });
  const state = { context: { text: 'Character: A', at: 1 }, presence: { ring: 'b', at: 3 } };
  CLI.adoptLegacyState(state, all);
  assert.deepEqual(state.clients[all[0].key].context, { text: 'Character: A', at: 1 });
  assert.deepEqual(state.clients[all[0].key].presence, { ring: 'b', at: 3 }, 'the disabled first entry keeps its ring');
  assert.equal(state.clients[all[1].key], undefined, 'the enabled second client gets neither');
  assert.deepEqual(state.context, { text: 'Character: A', at: 1 });
  state.context = { text: 'Character: B', at: 2 };
  CLI.adoptLegacyState(state, all);
  assert.equal(state.clients[all[0].key].context.text, 'Character: A', 'a later global context is not copied again');
});

test('contextText: a known client reads only its own context, never the shared one; no client reads the shared one', () => {
  const a = CLI.keyOf(FOREVER), b = CLI.keyOf(ERA);
  const state = { context: { text: 'shared' }, clients: { [a]: { context: { text: 'mine' } }, [b]: { context: null } } };
  assert.equal(CLI.contextText(state, a), 'mine');
  assert.equal(CLI.contextText(state, b), '', 'a client that cleared its context gets none, not the other client\'s');
  assert.equal(CLI.contextText(state, CLI.keyOf('/never/heard')), '', 'a client that never sent one gets none');
  assert.equal(CLI.contextText(state, ''), 'shared');
  assert.equal(CLI.contextText({}, ''), '');
});
