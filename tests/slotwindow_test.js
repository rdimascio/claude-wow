'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SW = require('../bridge/slotwindow');

test('republishQueued: the queue republish is an urgent refresh that never uses up the restore', () => {
  const calls = [];
  let pending = { token: 't', chats: [] };
  const publishNow = (urgent = true, { refresh = false } = {}) => {
    calls.push({ urgent, refresh });
    pending = SW.restoreAfterPublish(pending, { refresh, restoreSent: true });
  };
  for (let i = 0; i < SW.RESTORE_PUBLISHES + 2; i++) SW.republishQueued(publishNow);
  assert.equal(calls.length, SW.RESTORE_PUBLISHES + 2);
  for (const c of calls) assert.deepEqual(c, { urgent: true, refresh: true });
  assert.ok(pending);
  assert.equal(pending.published, undefined);
  for (let i = 0; i < SW.RESTORE_PUBLISHES; i++) publishNow();
  assert.equal(pending, null);
});

test('late records: one key per answer, numbers rise even when the clock does not, and each chat keeps only its newest', () => {
  assert.equal(SW.lateKey('tok:c1', 42), 'tok:c1#late#42');
  assert.equal(SW.nextLateSeq(0, 1000.7), 1000);
  assert.equal(SW.nextLateSeq(1000, 1000), 1001, 'two answers in one millisecond get two numbers');
  assert.equal(SW.nextLateSeq(5000, 1000), 5001, 'a clock that steps back never reuses a number');
  assert.equal(SW.nextLateSeq(undefined, 0), 1);

  const live = new Map();
  SW.place(live, 'tok:c1#late', { id: 1 });
  SW.place(live, 'tok:c1', { id: 2 });
  for (let i = 1; i <= 5; i++) SW.place(live, SW.lateKey('tok:c1', i), { id: 10 + i });
  SW.place(live, SW.lateKey('tok:c10', 9), { id: 99 });
  SW.place(live, SW.lateKey('tok:c2', 1), { id: 50 });
  const kept = Object.fromEntries([...live.keys()].map(k => [k, { at: 1 }]));
  const dropped = SW.trimLate(live, 'tok:c1', SW.LATE_KEPT_PER_CHAT, kept);
  assert.deepEqual(dropped, ['tok:c1#late', SW.lateKey('tok:c1', 1)], 'the oldest go first, the legacy single key with them');
  assert.deepEqual(
    [...live.keys()],
    ['tok:c1', ...[2, 3, 4, 5].map(i => SW.lateKey('tok:c1', i)), SW.lateKey('tok:c10', 9), SW.lateKey('tok:c2', 1)],
    'the chat reply and other chats (also a chat id that starts the same) stay',
  );
  assert.deepEqual(Object.keys(kept), [...live.keys()], 'the replies kept in state.json lose the same records');
  assert.deepEqual(SW.trimLate(live, 'tok:c1', SW.LATE_KEPT_PER_CHAT), []);
});
