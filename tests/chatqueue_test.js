'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CQ = require('../bridge/chatqueue');

const job = (id, chat = 'c1', session = 's') => ({ id, chat, session });

test('a chat keeps every waiting message in order, up to the limit, and a retried message is not queued twice', () => {
  const q = CQ.createChatQueue({ max: 3 });
  assert.equal(q.push('k', job(1)), 'queued');
  assert.equal(q.push('k', job(2)), 'queued');
  assert.equal(q.push('k', { ...job(2) }), 'present', 'the same session and id is one message');
  assert.equal(q.push('k', job(2, 'c1', 'other')), 'queued', 'the same id from another addon session is another message');
  assert.equal(q.push('k', job(4)), 'full');
  assert.deepEqual(
    q.jobs().map(j => j.id),
    [1, 2, 2],
  );
  assert.deepEqual(
    q.heads().map(([k, j]) => [k, j.id]),
    [['k', 1]],
  );
});

test('the head leaves first, a cancelled message leaves from anywhere, and an emptied chat disappears', () => {
  const q = CQ.createChatQueue();
  const a = job(1),
    b = job(2),
    c = job(3);
  for (const j of [a, b, c]) q.push('k', j);
  q.push('other', job(9, 'c2'));
  assert.equal(q.find('k', 2), b);
  assert.equal(q.remove('k', b), true);
  assert.equal(q.remove('k', b), false);
  assert.deepEqual(
    q.heads().map(([k, j]) => [k, j.id]),
    [
      ['k', 1],
      ['other', 9],
    ],
  );
  q.remove('k', a);
  q.remove('k', c);
  assert.deepEqual(q.keys(), ['other']);
  assert.equal(q.has('k', a), false);
});

test('dropping a deleted chat removes its messages from every key and returns them', () => {
  const q = CQ.createChatQueue();
  q.push('a:c1', job(1));
  q.push('b:c1', job(2));
  q.push('a:c2', job(3, 'c2'));
  const dropped = q.dropWhere(j => j.chat === 'c1');
  assert.deepEqual(dropped.map(j => j.id).sort(), [1, 2]);
  assert.deepEqual(q.keys(), ['a:c2']);
  q.clear();
  assert.deepEqual(q.jobs(), []);
});
