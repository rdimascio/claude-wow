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
const V = require('../bridge/vision');
const { SPLIT_UTF8_TEXT } = require('../dev/fake-claude');

const ROOT = path.join(os.tmpdir(), `claude-wow-unit-chatownership-${process.pid}`);
const POSIX = process.platform !== 'win32';
const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;
const OPEN_FILE = 0o644;
const OPEN_DIR = 0o755;
const SESSION_NAME = 'ownership';
const SLOTS = 20;

const coverageEnv = process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};
const modeOf = file => fs.statSync(file).mode & 0o777;
const inflightIds = h => Object.values(h.state().inflight || {}).map(r => r.id);
const keptMessages = (h, chat) => ((h.transcripts().chats || {})[chat] || { messages: [] }).messages;
const visionFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(V.isVisionFile) : []);
const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let seq = 0;
async function withGame(opts, fn) {
  const h = await H.start(`u${++seq}`, { root: ROOT, slots: SLOTS, ...opts, env: { ...coverageEnv, ...opts.env } });
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
      LP.lineReader(() => {}),
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
    reply: (chatId, text) => sock.write(LP.encode({ type: 'reply', call: 1, chat_id: chatId, text })),
    close,
  };
}

test('deleting chats drops a queued vision message with its screenshot and ends a running run that then writes nothing back', async () => {
  await withGame({ config: { maxParallel: 1, vision: { keep: 1 } } }, async h => {
    await h.client.connect();
    const tmp = path.join(h.sb.home, 'tmp');
    const runningChat = h.client.activeChat().id;
    const runningId = h.client.lastSeq() + 1;
    h.client.send('work on this [[hang]]');
    await h.client.waitFor(() => inflightIds(h).includes(runningId), { label: 'the run in flight' });
    const run = await h.client.waitFor(() => h.agentCalls().at(-1), { label: 'the agent process to start' });

    h.client.runLua('ClaudeWoW.NewChat("Queued")');
    const queuedChat = h.client.activeChat().id;
    const queuedId = h.client.lastSeq() + 1;
    h.client.runLua('ClaudeWoW.Send("look at this", nil, { vision = true })');
    await h.bridge.waitForLine(new RegExp(`#${queuedId}@\\S+ queued \\(1 running\\)`));
    assert.equal(visionFiles(tmp).length, 1, 'the queued message holds its screenshot');

    h.client.runLua(`ClaudeWoW.DeleteChat(${JSON.stringify(queuedChat)})`);
    await h.bridge.waitForLine(new RegExp(`#${queuedId}@\\S+ dropped: its chat was deleted before it started`));
    await h.client.waitFor(() => !(h.state().queued || []).some(j => j.id === queuedId), { label: 'the queue entry gone from state.json' });
    assert.deepEqual(visionFiles(tmp), [], 'the dropped message took its screenshot with it');

    h.client.runLua(`ClaudeWoW.DeleteChat(${JSON.stringify(runningChat)})`);
    await h.bridge.waitForLine(new RegExp(`#${runningId}@\\S+ its chat was deleted; ending it and everything it started`));
    await h.client.waitFor(() => !isAlive(run.pid), { timeoutMs: 15000, label: "the deleted chat's agent process to end" });
    await h.bridge.waitForLine(new RegExp(`#${runningId}@\\S+ error`));
    const st = h.state();
    assert.equal(st.sessions[`chat:${runningChat}`], undefined, 'the deleted chat has no agent session to resume');
    assert.equal((st.sessionCwd || {})[`chat:${runningChat}`], undefined);
    assert.deepEqual(inflightIds(h), []);
    assert.equal(h.transcripts().chats[runningChat], undefined, 'no transcript comes back for the deleted chat');
    assert.equal(h.transcripts().chats[queuedChat], undefined);
    assert.equal(h.agentCalls().length, 1, 'the dropped message never ran');
  });
});

test('a late live answer for a deleted chat is dropped and stays out of the chat that reuses its id', async () => {
  await withGame({ config: { plugins: { default: 'claude-code', live: { pickupMs: 50, pickupPollMs: 50 } } } }, async h => {
    await h.client.connect();
    const session = await connectLiveSession(h);
    try {
      const chat = h.client.activeChat().id;
      const chatId = `${h.client.db().session}:${chat}`;
      const liveId = h.client.lastSeq() + 1;
      h.client.send('@live are you there');
      await h.bridge.waitForLine(new RegExp(`#${liveId}@\\S+ "${SESSION_NAME}" showed no sign of it`));
      await h.client.waitFor(() => !h.client.activeChat().pendingId, { label: 'the chat free again' });

      h.client.runLua(`ClaudeWoW.DeleteChat(${JSON.stringify(chat)})`);
      await h.bridge.waitForLine(new RegExp(`forgot chat ${chat}`));
      await h.client.say('@claude-code a fresh start');

      session.reply(chatId, 'the stale live answer');
      await h.bridge.waitForLine(new RegExp(`#${liveId}@\\S+ late reply dropped: its chat was deleted`));
      const texts = keptMessages(h, chat).map(m => m.text);
      assert.ok(texts.length > 0, 'the reused chat keeps its new messages');
      assert.ok(!texts.some(t => t.includes('the stale live answer')), `the reused chat has no stale answer: ${JSON.stringify(texts)}`);
    } finally {
      session.close();
    }
  });
});

test('agent output split inside a character stays whole in the reply and in the error', async () => {
  await withGame({}, async h => {
    await h.client.say('[[split-unicode]]');
    const chat = h.client.activeChat().id;
    const reply = keptMessages(h, chat).find(m => m.role === 'assistant');
    assert.ok(reply && reply.text.includes(SPLIT_UTF8_TEXT), `the reply is whole: ${reply && reply.text}`);
    assert.ok(!reply.text.includes('�'));
    await h.client.say('[[split-stderr]]');
    const failure = keptMessages(h, chat).find(m => m.role === 'system');
    assert.ok(failure && failure.text.includes(SPLIT_UTF8_TEXT), `the error output is whole: ${failure && failure.text}`);
  });
});

test(
  'existing open state, transcripts, log and tmp are made private at start, and a folder that cannot be fixed is logged',
  { skip: !POSIX && 'POSIX modes' },
  async () => {
    let tmp = '';
    const beforeLaunch = sb => {
      tmp = path.join(sb.home, 'tmp');
      fs.mkdirSync(tmp, { recursive: true });
      fs.chmodSync(tmp, OPEN_DIR);
      for (const file of [sb.state, sb.transcripts, sb.bridgeLog]) {
        if (!fs.existsSync(file)) fs.writeFileSync(file, file.endsWith('.json') ? '{}' : '');
        fs.chmodSync(file, OPEN_FILE);
      }
      const loop = path.join(sb.home, 'uijobs');
      fs.symlinkSync(loop, loop);
    };
    await withGame({ beforeLaunch }, async h => {
      await h.client.connect();
      await h.bridge.waitForLine(/could not make \S+uijobs private/);
      assert.equal(modeOf(tmp), PRIVATE_DIR, 'tmp is private');
      for (const file of [h.sb.state, h.sb.transcripts, h.sb.bridgeLog]) assert.equal(modeOf(file), PRIVATE_FILE, `${path.basename(file)} is private`);
    });
  },
);

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
