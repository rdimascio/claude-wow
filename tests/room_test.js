'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ROOM = require('../bridge/room');
const RP = require('../bridge/plugins/room');

function fakeSockets() {
  const made = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.closed = false;
      made.push(this);
    }
    emit(event) {
      this.onmessage({ data: JSON.stringify(event) });
    }
    close() {
      this.closed = true;
    }
  }
  return { FakeSocket, made };
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      pending.push(t);
      return t;
    },
    clearTimeout: t => {
      const i = pending.indexOf(t);
      if (i >= 0) pending.splice(i, 1);
    },
  };
}

const SNAPSHOT = {
  type: 'snapshot',
  snapshot: {
    agents: [{ id: 'assistant', displayName: 'Ari' }],
    channels: [
      { id: 'ch-ship', workspaceId: 'wow-ai', slug: 'ship', name: 'Ship', archived: false },
      { id: 'ch-old', workspaceId: 'wow-ai', slug: 'old', name: 'Old', archived: true },
      { id: 'ch-other', workspaceId: 'every', slug: 'ship', name: 'Ship', archived: false },
    ],
    threads: [
      { id: 't1', channelId: 'ch-ship', title: 'Deploy notes' },
      { id: 't2', channelId: 'ch-other', title: 'Not ours' },
      { id: 't3', channelId: 'ch-old', title: 'Archived' },
    ],
  },
};

function rig(conf = {}) {
  const { FakeSocket, made } = fakeSockets();
  const timers = fakeTimers();
  const logs = [];
  const got = [];
  const room = ROOM.createRoom({
    conf: { url: ROOM.DEFAULT_URL, workspace: 'wow-ai', channels: [], db: '/nowhere', ...conf },
    log: l => logs.push(l),
    onMessage: m => got.push(m),
    token: () => 'abcdef0123456789',
    WebSocketImpl: FakeSocket,
    timers,
  });
  return { room, made, timers, logs, got };
}

test('settings: off by default, needs a workspace, keeps the URL on loopback and only valid channel slugs', () => {
  assert.deepEqual(ROOM.settings(undefined), { enabled: false });
  assert.deepEqual(ROOM.settings({ enabled: false, workspace: 'wow-ai' }), { enabled: false });
  assert.match(ROOM.settings({ enabled: true }).error, /workspace/);
  const s = ROOM.settings({ enabled: true, workspace: 'wow-ai', channels: ['ship', 'Bad Slug', 3, 'ops-2'] });
  assert.equal(s.enabled, true);
  assert.equal(s.url, ROOM.DEFAULT_URL);
  assert.deepEqual(s.channels, ['ship', 'ops-2']);
  assert.equal(s.db, ROOM.DEFAULT_DB);
  assert.equal(ROOM.settings({ enabled: true, workspace: 'wow-ai', url: 'ws://10.0.0.5:4319/ws' }).url, ROOM.DEFAULT_URL, 'never a non-loopback host');
  assert.equal(ROOM.settings({ enabled: true, workspace: 'wow-ai', url: 'ws://127.0.0.1:5000/ws' }).url, 'ws://127.0.0.1:5000/ws');
});

test('a message in a followed channel becomes one game chat entry; other workspaces, archived channels and unknown threads are ignored', () => {
  const t = rig();
  t.room.connect();
  assert.equal(t.made.length, 1);
  assert.equal(t.made[0].url, `${ROOM.DEFAULT_URL}?token=abcdef0123456789`);
  t.made[0].emit(SNAPSHOT);
  assert.match(t.logs[0], /connected to agent-room, following 1 channel\(s\) of wow-ai/);
  const msg = (threadId, authorId, semantic, text = '') => ({
    type: 'message',
    threadId,
    message: { id: `m-${threadId}-${authorId}`, threadId, authorId, semantic, text },
  });
  t.made[0].emit(msg('t1', 'assistant', { kind: 'chat', text: 'Merged #172.' }));
  t.made[0].emit(msg('t1', 'human:U1', { kind: 'chat', text: 'ship it' }));
  t.made[0].emit(msg('t2', 'assistant', { kind: 'chat', text: 'other workspace' }));
  t.made[0].emit(msg('t3', 'assistant', { kind: 'chat', text: 'archived' }));
  t.made[0].emit(msg('t9', 'assistant', { kind: 'chat', text: 'unknown thread' }));
  assert.equal(t.got.length, 2);
  assert.deepEqual(t.got[0], {
    chat: ROOM.chatIdFor('ch-ship'),
    title: '#ship',
    thread: 'Deploy notes',
    id: 'm-t1-assistant',
    role: 'assistant',
    from: 'Ari',
    text: 'Merged #172.',
  });
  assert.equal(t.got[1].role, 'user');
  assert.equal(t.got[1].from, 'room');
  assert.match(ROOM.chatIdFor('ch-ship'), /^r[0-9a-f]{10}$/, 'the id the addon accepts for a room chat');
  t.made[0].emit({ type: 'thread', thread: { id: 't4', channelId: 'ch-ship', title: 'New task' } });
  t.made[0].emit(msg('t4', 'assistant', { kind: 'chat', text: 'started' }));
  assert.equal(t.got.length, 3, 'a thread made after the snapshot is followed too');
});

test('channels: a configured slug list narrows what is followed', () => {
  const t = rig({ channels: ['ops'] });
  t.room.connect();
  t.made[0].emit(SNAPSHOT);
  t.made[0].emit({ type: 'message', threadId: 't1', message: { id: 'x', authorId: 'assistant', semantic: { kind: 'chat', text: 'hi' } } });
  assert.equal(t.got.length, 0);
});

test('messageText: approvals say where to answer, artifacts carry their body, long text is cut', () => {
  assert.equal(
    ROOM.messageText({ semantic: { kind: 'approval', question: 'Merge PR #18765 at 1a2b3c?', choices: ['Merge', 'Hold'] } }),
    'Asks: Merge PR #18765 at 1a2b3c? (Merge / Hold). Answer it in Slack or the room for now.',
  );
  assert.equal(ROOM.messageText({ semantic: { kind: 'decision', question: 'Merge?', chosen: 'Merge' } }), 'Decided: Merge?: Merge');
  assert.equal(ROOM.messageText({ semantic: { kind: 'artifact', title: 'Plan', body: 'Step one.' } }), 'Plan\n\nStep one.');
  assert.equal(ROOM.messageText({ semantic: { kind: 'table', title: 'Spend' } }), 'Spend (open the room to see it)');
  assert.equal(ROOM.messageText({ semantic: { kind: 'chart' }, text: '' }), 'chart (open the room to see it)');
  assert.equal(ROOM.messageText({ semantic: { kind: 'unknown' }, text: 'fallback' }), 'fallback');
  const long = ROOM.messageText({ semantic: { kind: 'chat', text: 'x'.repeat(ROOM.TEXT_MAX + 50) } });
  assert.equal(long.length, ROOM.TEXT_MAX);
  assert.ok(long.endsWith('...'));
});

test('a lost connection retries with backoff and logs each new failure once; stop ends the retries', () => {
  const t = rig();
  t.room.connect();
  t.made[0].emit(SNAPSHOT);
  t.made[0].onclose();
  assert.equal(t.timers.pending.length, 1);
  assert.equal(t.timers.pending[0].ms, 5000);
  t.timers.pending.shift().fn();
  assert.equal(t.made.length, 2);
  t.made[1].onclose();
  assert.equal(t.timers.pending[0].ms, 10000, 'the wait doubles');
  assert.equal(t.logs.filter(l => l.startsWith('room: lost')).length, 1, 'the same failure is logged once');
  t.timers.pending.shift().fn();
  t.made[2].emit(SNAPSHOT);
  assert.equal(t.room.status().connected, true);
  t.made[2].onclose();
  assert.equal(t.timers.pending[0].ms, 5000, 'a good connection resets the wait');
  t.room.stop();
  assert.equal(t.timers.pending.length, 0, 'stop cancels the pending retry');
  t.room.connect();
  assert.equal(t.made.length, 3, 'a stopped client never connects again');
});

test('stop closes a live socket', () => {
  const t = rig();
  t.room.connect();
  t.made[0].emit(SNAPSHOT);
  t.room.stop();
  assert.equal(t.made[0].closed, true);
});

test('a missing token is a logged failure that retries, not a crash', () => {
  const logs = [];
  const timers = fakeTimers();
  const room = ROOM.createRoom({
    conf: { url: ROOM.DEFAULT_URL, workspace: 'wow-ai', channels: [], db: '/nowhere' },
    log: l => logs.push(l),
    onMessage: () => {},
    token: () => {
      throw new Error('no room token');
    },
    WebSocketImpl: function NeverMade() {
      throw new Error('should not connect without a token');
    },
    timers,
  });
  room.connect();
  assert.match(logs[0], /cannot read the agent-room token \(no room token\)/);
  assert.equal(timers.pending.length, 1);
});

test('the room plugin answers a message typed in a room chat with the read-only text, without an agent run', () => {
  const replies = [];
  RP.handle({ id: 1 }, { log() {}, tag: () => '#1', reply: (job, text) => replies.push(text) });
  assert.deepEqual(replies, [RP.READ_ONLY_TEXT]);
  assert.equal(RP.match({ text: 'hi' }), false);
});
