'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const DH = require('../../bridge/chathub');
const { startFakeDiscord, GUILD } = require('../../dev/fake-discord-api');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('discord');
const withGame = gameRunner(ROOT);
const TOKEN = 'e2e-discord-bot-token';
const APP = '800000000000000001';
const CHANNEL = '800000000000000002';
const OWNER = '800000000000000003';
const STRANGER = '800000000000000004';

let msgSeq = 0;
const msgId = () => String(820000000000000000n + BigInt(++msgSeq));

async function setup(sb, fake) {
  const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
  cfg.discord = { enabled: true, applicationId: APP, channelId: CHANNEL, userIds: [OWNER], apiUrl: fake.url, gateway: false };
  fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
}

async function webhookUrl(h) {
  const file = path.join(h.sb.home, DH.WEBHOOK_FILE);
  await h.client.waitFor(() => fs.existsSync(file), { timeoutMs: 20000, label: 'the Discord webhook file' });
  return JSON.parse(fs.readFileSync(file, 'utf8')).url;
}

async function deliver(url, data, token = TOKEN) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-discord-gateway-token': token },
    body: JSON.stringify({ type: 'GATEWAY_MESSAGE_CREATE', timestamp: Date.now(), data }),
  });
  return res.status;
}

const message = ({ channel = CHANNEL, author = OWNER, content, thread = false, bot = false, webhook = false }) => ({
  id: msgId(),
  channel_id: channel,
  guild_id: GUILD,
  ...(thread ? { channel_type: 11 } : {}),
  content,
  timestamp: new Date().toISOString(),
  author: { id: author, username: author === OWNER ? 'owner' : 'someone', bot },
  ...(webhook ? { webhook_id: '1' } : {}),
  mentions: [],
  attachments: [],
});

const textPosts = (fake, threadId) =>
  fake
    .posts()
    .filter(c => !threadId || c.url === `/channels/${threadId}/messages`)
    .map(c => c.body.content);

test('a Discord message starts a coding chat that answers in its thread, a follow-up resumes the same session, and strangers, bots and a wrong token run nothing', async () => {
  const fake = await startFakeDiscord({ channelId: CHANNEL });
  try {
    await withGame({ env: { [DH.TOKEN_ENV]: TOKEN }, beforeLaunch: sb => setup(sb, fake), run: false }, async h => {
      const url = await webhookUrl(h);
      assert.equal(await deliver(url, message({ content: 'fix the build' })), 200);
      await h.client.waitFor(() => textPosts(fake).some(t => /echo \(turn 1\): fix the build/.test(t)), { timeoutMs: 30000, label: 'the reply in Discord' });
      h.client.start();
      await h.client.connect();
      await h.bridge.waitForLine(/game context updated/, { timeoutMs: 20000 });
      const [threadId] = [...fake.threads.keys()];
      assert.ok(threadId, 'the adapter opened a thread for the message');
      const first = h.agentCalls().find(c => c.prompt.includes('fix the build'));
      assert.ok(!first.envNames.some(k => /DISCORD/.test(k)), 'the bot token never reaches the agent');
      const denied = first.argv.slice(first.argv.indexOf('--disallowedTools') + 1);
      assert.ok(
        denied.some(r => r.startsWith('Read(') && r.includes(DH.TOKEN_FILE)),
        'agent runs are denied Read on the token file',
      );

      assert.equal(await deliver(url, message({ channel: threadId, thread: true, content: 'and the tests' })), 200);
      await h.client.waitFor(() => textPosts(fake, threadId).some(t => /echo \(turn 2\): and the tests/.test(t)), {
        timeoutMs: 30000,
        label: 'the follow-up reply',
      });
      const second = h.agentCalls().find(c => c.prompt.includes('and the tests'));
      assert.equal(second.resume, first.session, 'the follow-up resumes the same agent session, though the game reported its context in between');

      const calls = h.agentCalls().length;
      await deliver(url, message({ author: STRANGER, content: 'rm -rf everything' }));
      await deliver(url, message({ content: 'bot says hi', bot: true }));
      await deliver(url, message({ content: 'webhook says hi', webhook: true }));
      assert.equal(await deliver(url, message({ content: 'forged' }), 'wrong-token'), 401);
      await h.bridge.waitForLine(/discord: a message from user 800000000000000004 was ignored/, { timeoutMs: 10000 });
      await new Promise(r => setTimeout(r, 1500));
      assert.equal(h.agentCalls().length, calls, 'no run for a stranger, a bot, a webhook or a forged event');
      for (const p of fake.calls.filter(c => c.method === 'POST')) assert.equal(p.auth, `Bot ${TOKEN}`);
      assert.ok(!h.bridge.output.includes(TOKEN), 'the token is never logged');
    });
  } finally {
    await fake.close();
  }
});

test('/claude discord links a game chat to a new thread with a recap, game replies post there, and a Discord message in that thread reaches the same chat', async () => {
  const fake = await startFakeDiscord({ channelId: CHANNEL });
  try {
    await withGame({ env: { [DH.TOKEN_ENV]: TOKEN }, beforeLaunch: sb => setup(sb, fake) }, async h => {
      await h.client.say('plan the refactor');
      await h.client.waitFor(() => h.client.luaValue('ClaudeWoW and 1') === '1', { label: 'the addon' });
      const id = h.client.lastSeq() + 1;
      h.client.slash('/claude discord');
      const linked = await h.client.waitFor(
        () => {
          const c = h.client.activeChat();
          return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role !== 'user');
        },
        { timeoutMs: 30000, label: 'the link reply' },
      );
      assert.match(linked.text, /^Linked\./);
      const [threadId] = [...fake.threads.keys()];
      assert.ok(threadId);
      assert.ok(
        textPosts(fake, threadId).some(t => /You: plan the refactor/.test(t)),
        'the recap is in the thread',
      );

      await h.client.say('now do step one');
      await h.client.waitFor(() => textPosts(fake, threadId).some(t => /echo \(turn 2\): now do step one/.test(t)), {
        timeoutMs: 30000,
        label: 'the game reply in Discord',
      });

      const url = await webhookUrl(h);
      await deliver(url, message({ channel: threadId, thread: true, content: 'from my phone' }));
      await h.client.waitFor(() => textPosts(fake, threadId).some(t => /echo \(turn 3\): from my phone/.test(t)), {
        timeoutMs: 30000,
        label: 'the Discord reply',
      });
      const chatId = h.client.activeChat().id;
      const fromPhone = h.agentCalls().find(c => c.prompt.includes('from my phone'));
      const fromGame = h.agentCalls().find(c => c.prompt.includes('now do step one'));
      assert.equal(fromPhone.resume, fromGame.session, 'the same agent session');
      assert.ok(h.state().discordLinks[chatId], 'the link is saved by chat id');

      await h.client.say('back in game');
      const history = h.client.activeChat().history.map(m => `${m.role}|${m.text}`);
      const phone = history.indexOf('user|(Discord) from my phone');
      assert.ok(phone >= 0, `the Discord message is in the game chat: ${JSON.stringify(history.slice(-6))}`);
      assert.ok(
        history.slice(phone).some(t => /^assistant\|echo \(turn 3\): from my phone/.test(t)),
        'and so is its reply',
      );
      assert.equal(history.filter(t => t === 'user|(Discord) from my phone').length, 1, 'shown once');
    });
  } finally {
    await fake.close();
  }
});

test('/runs from Discord answers at once while the chat is still running, instead of waiting behind the run', async () => {
  const fake = await startFakeDiscord({ channelId: CHANNEL });
  const withFactory = async sb => {
    await setup(sb, fake);
    const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
    cfg.plugins['claude-code'] = { factory: { enabled: true, skills: ['babysit-pr'] } };
    fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
  };
  try {
    await withGame({ env: { [DH.TOKEN_ENV]: TOKEN }, beforeLaunch: withFactory, run: false }, async h => {
      const url = await webhookUrl(h);
      await deliver(url, message({ content: 'warm up' }));
      await h.client.waitFor(() => textPosts(fake).some(t => /warm up/.test(t)), { timeoutMs: 30000, label: 'the first reply' });
      const [threadId] = [...fake.threads.keys()];
      await deliver(url, message({ channel: threadId, thread: true, content: '[[sleep 8]] long work' }));
      await h.client.waitFor(() => h.agentCalls().some(c => c.prompt.includes('long work')), { label: 'the long run to start' });
      await deliver(url, message({ channel: threadId, thread: true, content: '/runs' }));
      await h.client.waitFor(() => textPosts(fake, threadId).some(t => /^No factory runs yet\./.test(t)), {
        timeoutMs: 6000,
        label: 'the /runs answer during the run',
      });
      assert.ok(!textPosts(fake, threadId).some(t => /long work/.test(t)), 'the long run had not finished yet');
      await h.bridge.waitForLine(/\/runs answered while the chat is busy/, { timeoutMs: 5000 });
    });
  } finally {
    await fake.close();
  }
});
