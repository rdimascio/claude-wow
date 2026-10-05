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
