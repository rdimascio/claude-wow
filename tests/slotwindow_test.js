'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SW = require('../bridge/slotwindow');
const CLI = require('../bridge/clients');

const tokenOf = key => String(key).split(':')[0];
const rec = (id, extra = {}) => ({ chat: 'c' + id, id, status: 'done', text: 'r' + id, client: 'wow', ...extra });

test('place: a new record for an old chat moves to the end of the window', () => {
  const live = new Map();
  SW.place(live, 'tok:a', rec(1));
  SW.place(live, 'tok:b', rec(2));
  SW.place(live, 'tok:c', rec(3));
  SW.place(live, 'tok:a', rec(4));
  const ids = SW.windowRecords(live, tokenOf).map(r => r.id);
  assert.deepEqual(ids, [2, 3, 4]);
});

test('windowRecords: every record carries the addon session token of its key', () => {
  const live = new Map();
  SW.place(live, 'abc:chat1', rec(1));
  SW.place(live, 'xyz:chat2', rec(2));
  assert.deepEqual(SW.windowRecords(live, tokenOf).map(r => r.token), ['abc', 'xyz']);
});

test('the slot window keeps the newest 30 records in publish order', () => {
  const live = new Map();
  for (let i = 1; i <= 40; i++) SW.place(live, 'tok:chat' + i, rec(i));
  SW.place(live, 'tok:chat5', rec(41));
  const window = CLI.recordsFor(SW.windowRecords(live, tokenOf), 'wow');
  assert.equal(window.length, 30);
  const expected = [];
  for (let i = 12; i <= 41; i++) if (i !== 5) expected.push(i);
  assert.deepEqual(window.map(r => r.id), expected);
  assert.equal(window[window.length - 1].chat, 'c41');
});

test('restoreAfterPublish: three plain publishes that carried the restore drop it', () => {
  let pending = { token: 't', chats: [] };
  pending = SW.restoreAfterPublish(pending, { refresh: false, restoreSent: true });
  pending = SW.restoreAfterPublish(pending, { refresh: false, restoreSent: true });
  assert.ok(pending);
  pending = SW.restoreAfterPublish(pending, { refresh: false, restoreSent: true });
  assert.equal(pending, null);
});

test('restoreAfterPublish: a publish that did not carry the restore keeps it', () => {
  const pending = { token: 't', chats: [] };
  for (let i = 0; i < 5; i++) assert.equal(SW.restoreAfterPublish(pending, { refresh: false, restoreSent: false }), pending);
  assert.equal(pending.published, undefined);
});

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
