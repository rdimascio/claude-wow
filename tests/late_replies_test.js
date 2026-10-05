'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const H = require('../dev/harness');
const LP = require('../bridge/liveproto');

const ROOT = path.join(os.tmpdir(), `claude-wow-unit-latereplies-${process.pid}`);
const SESSION_NAME = 'latereplies';
const SLOTS = 20;
const SPEED = 8;
const PERMISSION_TIMEOUT_MS = 1500;

const coverageEnv = process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};

let seq = 0;
async function withGame(opts, fn) {
  const h = await H.start(`l${++seq}`, { root: ROOT, slots: SLOTS, ...opts, env: { ...coverageEnv, ...opts.env } });
  try {
    await fn(h);
    assert.deepEqual(h.client.errors(), [], 'the addon raised no Lua errors');
  } catch (e) {
    e.message += `\n--- bridge output (tail) ---\n${h.bridge.output.slice(-2500)}`;
    throw e;
  } finally {
    await h.close();
  }
}

async function connectLiveSession(h) {
  const listener = spawn(process.execPath, ['-e', 'setInterval(Object,1e9)', '--', LP.DEV_FLAG, LP.CHANNEL_ARG], { stdio: 'ignore' });
  const received = [];
  let sock = null;
  const close = () => {
    if (sock) sock.destroy();
    listener.kill('SIGKILL');
  };
  try {
    const token = await h.client.waitFor(() => LP.readToken(h.sb.home), { label: 'the live token' });
    sock = net.connect(LP.endpoint(h.sb.home));
    sock.on('error', () => {});
    sock.on(
      'data',
      LP.lineReader(msg => received.push(msg)),
    );
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    const nonce = LP.nonce();
    sock.write(
      LP.encode({ type: 'hello', nonce, proof: LP.proof(token, 'client', nonce), name: SESSION_NAME, cwd: h.sb.project, pid: process.pid, ppid: listener.pid }),
    );
    await h.bridge.waitForLine(new RegExp(`session "${SESSION_NAME}" connected.*, listening`));
  } catch (e) {
    close();
    throw e;
  }
  return {
    received,
    reply: (chatId, text, messageId) => sock.write(LP.encode({ type: 'reply', call: 1, chat_id: chatId, message_id: messageId, text })),
    ask: requestId =>
      sock.write(
        LP.encode({
          type: 'permission_request',
          request_id: requestId,
          tool_name: 'Bash',
          description: 'Create a file',
          input_preview: '{"command":"touch x"}',
        }),
      ),
    close,
  };
}

const shown = (h, text) => ((h.client.activeChat() || {}).history || []).filter(m => m.role === 'assistant' && m.text === text).length;

test('two late live answers that land before the addon reads a slot both show in the chat, the older one too, once each', async () => {
  const config = { plugins: { default: 'claude-code', live: { pickupMs: 50, pickupPollMs: 50 } } };
  await withGame({ client: { speed: SPEED }, speed: SPEED, config }, async h => {
    await h.client.connect();
    const session = await connectLiveSession(h);
    try {
      const chatId = `${h.client.db().session}:${h.client.activeChat().id}`;
      const stall = async text => {
        const id = h.client.lastSeq() + 1;
        h.client.send(`@live ${text}`);
        await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ "${SESSION_NAME}" showed no sign of it`));
        await h.client.waitFor(() => !h.client.activeChat().pendingId, { label: `#${id} failed in the chat` });
        return id;
      };
      const first = await stall('first');
      const second = await stall('second');
      session.reply(chatId, 'answer to second', String(second));
      session.reply(chatId, 'answer to first', String(first));
      await h.bridge.waitForLine(new RegExp(`#${first}@\\S+ late reply delivered`));
      await h.client.waitFor(() => shown(h, 'answer to second') && shown(h, 'answer to first'), { label: 'both late answers in the chat' });
      await new Promise(r => setTimeout(r, 4000));
      assert.equal(shown(h, 'answer to second'), 1);
      assert.equal(shown(h, 'answer to first'), 1);
    } finally {
      session.close();
    }
  });
});

test("after a permission roll times out, the session's answer reaches an idle addon without another message", async () => {
  const config = { plugins: { default: 'claude-code', live: { pickupMs: 0, permissionTimeoutMs: PERMISSION_TIMEOUT_MS } } };
  await withGame({ client: { speed: SPEED }, speed: SPEED, config }, async h => {
    await h.client.connect();
    h.client.runLua('ClaudeWoWDB.settings.lootRoll = false');
    const session = await connectLiveSession(h);
    try {
      const chatId = `${h.client.db().session}:${h.client.activeChat().id}`;
      const id = h.client.lastSeq() + 1;
      h.client.send('@live touch a file');
      await h.client.waitFor(() => session.received.some(m => m.type === 'message'), { label: 'the message at the live session' });
      session.ask('abcde');
      await h.client.waitFor(() => !h.client.activeChat().pendingId, { label: 'the roll prompt in the chat' });
      await h.client.waitFor(() => session.received.some(m => m.type === 'permission' && m.behavior === 'deny'), { label: 'the timeout denial' });
      session.reply(chatId, 'Denied, so I left it.', String(id));
      await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ late reply delivered`));
      await h.client.waitFor(() => shown(h, 'Denied, so I left it.'), { timeoutMs: 20000, label: 'the late answer in the chat' });
      assert.ok(!h.client.activeChat().pendingId, 'no message was sent to fetch it');
    } finally {
      session.close();
    }
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
