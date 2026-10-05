'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const LP = require('../../bridge/liveproto');
const { makeRoot, gameRunner, isAlive } = require('./helpers');

const ROOT = makeRoot('liveownership');
const withGame = gameRunner(ROOT);
const SESSION_NAME = 'ownership';

const inflightIds = h => Object.values(h.state().inflight || {}).map(r => r.id);

async function connectLiveSession(h) {
  const listener = spawn(process.execPath, ['-e', 'setInterval(Object,1e9)', '--', LP.DEV_FLAG, LP.CHANNEL_ARG], { stdio: 'ignore' });
  const token = await h.client.waitFor(() => LP.readToken(h.sb.home), { label: 'the live token' });
  const received = [];
  const sock = net.connect(LP.endpoint(h.sb.home));
  sock.on('error', () => {});
  sock.on('data', LP.lineReader(msg => received.push(msg)));
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  const nonce = LP.nonce();
  sock.write(LP.encode({ type: 'hello', nonce, proof: LP.proof(token, 'client', nonce), name: SESSION_NAME, cwd: h.sb.project, pid: process.pid, ppid: listener.pid }));
  await h.bridge.waitForLine(new RegExp(`session "${SESSION_NAME}" connected.*, listening`));
  return {
    received,
    reply: (chatId, text) => sock.write(LP.encode({ type: 'reply', call: 1, chat_id: chatId, text })),
    close: () => { sock.destroy(); listener.kill('SIGKILL'); },
  };
}

test('a live reply that lands after a cancel leaves the agent run that took over the chat tracked and cancellable', async () => {
  await withGame({ config: { plugins: { default: 'claude-code', live: { pickupMs: 0 } } } }, async h => {
    await h.client.connect();
    const session = await connectLiveSession(h);
    try {
      const chatId = `${h.client.db().session}:${h.client.activeChat().id}`;
      const liveId = h.client.lastSeq() + 1;
      h.client.send('@live are you there');
      await h.bridge.waitForLine(new RegExp(`#${liveId}@\\S+ sent to "${SESSION_NAME}" as chat_id`));
      await h.client.waitFor(() => session.received.some(m => m.type === 'message'), { label: 'the message at the live session' });
      h.client.slash('/claude cancel');
      await h.bridge.waitForLine(new RegExp(`cancel for #${liveId}: nothing is running for that message`));
      await h.client.waitFor(() => !h.client.activeChat().pendingId, { label: 'the chat free again' });

      const runId = h.client.lastSeq() + 1;
      h.client.send('@claude-code take over [[hang]]');
      await h.client.waitFor(() => inflightIds(h).includes(runId), { label: 'the agent run in flight' });
      const run = await h.client.waitFor(() => h.agentCalls().at(-1), { label: 'the agent process to start' });

      session.reply(chatId, 'the late live answer');
      await h.bridge.waitForLine(new RegExp(`#${liveId}@\\S+ done`));
      assert.deepEqual(inflightIds(h), [runId], 'the finished live job leaves the agent run in state.json inflight');

      h.client.slash('/claude cancel');
      await h.bridge.waitForLine(new RegExp(`#${runId}@\\S+ cancelled from the game; ending it`));
      await h.client.waitFor(() => !isAlive(run.pid), { timeoutMs: 15000, label: 'the agent process to end' });
    } finally {
      session.close();
    }
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
