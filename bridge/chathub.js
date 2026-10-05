'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const TOKEN_ENV = 'CLAUDE_WOW_DISCORD_BOT_TOKEN';
const TOKEN_FILE = 'discord.token';
const WEBHOOK_FILE = 'discord-webhook.json';
const API_BASE = 'https://discord.com/api/v10';
const CHUNK_MAX = 1900;
const PROGRESS_EVERY_MS = 3000;
const GATEWAY_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = [5000, 30000, 300000];
const SNOWFLAKE = /^\d{5,25}$/;
const TOKEN_RE = /\{(?:item|spell|quest|skill|faction|map|npc|achievement):[^}]*\}/gi;
const BODY_MAX = 1 << 20;

function settings(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  if (d.enabled !== true) return { enabled: false };
  const userIds = Array.isArray(d.userIds) ? d.userIds.map(String).filter(id => SNOWFLAKE.test(id)) : [];
  const missing = [];
  if (!SNOWFLAKE.test(String(d.applicationId || ''))) missing.push('discord.applicationId');
  if (!SNOWFLAKE.test(String(d.channelId || ''))) missing.push('discord.channelId');
  if (!userIds.length) missing.push('discord.userIds (at least one Discord user id)');
  if (missing.length) return { enabled: false, error: `Discord is off: set ${missing.join(', ')} in config.json.` };
  return {
    enabled: true,
    applicationId: String(d.applicationId),
    publicKey: /^[0-9a-f]{64}$/i.test(String(d.publicKey || '')) ? String(d.publicKey) : '0'.repeat(64),
    channelId: String(d.channelId),
    userIds,
    apiUrl: typeof d.apiUrl === 'string' && /^https?:\/\//.test(d.apiUrl) ? d.apiUrl.replace(/\/+$/, '') : API_BASE,
    gateway: d.gateway !== false,
  };
}

function takeToken(env, home) {
  const fromEnv = typeof env[TOKEN_ENV] === 'string' ? env[TOKEN_ENV].trim() : '';
  delete env[TOKEN_ENV];
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(path.join(home, TOKEN_FILE), 'utf8').trim();
  } catch {
    return '';
  }
}

function clean(text) {
  return String(text || '')
    .replace(TOKEN_RE, '')
    .replace(/@(everyone|here)\b/g, '@​$1')
    .replace(/<@([!&]?\d+)>/g, '<@​$1>');
}

function splitText(text, max = CHUNK_MAX) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim() || !out.length) out.push(rest);
  return out;
}

function createChatHub({ config, token, home, log = () => {}, links, onNewChat, onMessage, fetchImpl = globalThis.fetch }) {
  let bot = null;
  let discord = null;
  let server = null;
  let webhookUrl = '';
  let stopped = false;
  const abort = new AbortController();
  const progress = new Map();

  function allowed(message) {
    const raw = message.raw || {};
    if (message.author.isBot || message.author.isMe || raw.webhook_id) return false;
    return config.userIds.includes(String(message.author.userId));
  }

  async function onIncoming(thread, message) {
    if (!allowed(message)) {
      log(`discord: a message from user ${message.author.userId} was ignored (not on discord.userIds, or a bot)`);
      return;
    }
    const raw = message.raw || {};
    let link = links.byThread(thread.id);
    if (!link) {
      if (raw.channel_id !== config.channelId) {
        await thread.post('This thread is not linked to a chat any more.').catch(() => {});
        return;
      }
      const made = onNewChat(thread.id, message.text);
      if (made.error) {
        await thread.post(made.error).catch(() => {});
        return;
      }
      link = made;
      await thread.subscribe().catch(e => log(`discord: subscribe failed (${e.message})`));
    }
    onMessage({ chatId: link.chatId, text: link.text !== undefined ? link.text : message.text, threadId: thread.id });
  }

  function serve() {
    const secret = crypto.randomBytes(16).toString('hex');
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== `/discord/${secret}`) {
        res.statusCode = 404;
        return res.end();
      }
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > BODY_MAX) req.destroy();
        else chunks.push(c);
      });
      req.on('end', async () => {
        try {
          const request = new Request('http://127.0.0.1/discord', { method: 'POST', headers: { ...req.headers }, body: Buffer.concat(chunks) });
          const reply = await discord.handleWebhook(request, {
            waitUntil: p => Promise.resolve(p).catch(e => log(`discord: event failed (${e && e.message})`)),
          });
          res.statusCode = reply.status;
          res.end();
        } catch (e) {
          log(`discord: webhook request failed (${e && e.message})`);
          res.statusCode = 500;
          res.end();
        }
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        webhookUrl = `http://127.0.0.1:${server.address().port}/discord/${secret}`;
        const file = path.join(home, WEBHOOK_FILE);
        fs.writeFileSync(file, JSON.stringify({ url: webhookUrl, pid: process.pid }), { mode: 0o600 });
        resolve();
      });
    });
  }

  async function gatewayLoop() {
    let failures = 0;
    while (!stopped) {
      const begun = Date.now();
      try {
        let finished = Promise.resolve();
        await discord.startGatewayListener({ waitUntil: p => (finished = p) }, GATEWAY_MS, abort.signal, webhookUrl);
        await finished;
        failures = Date.now() - begun > 60000 ? 0 : failures + 1;
      } catch (e) {
        failures++;
        log(`discord: Gateway listener stopped (${e && e.message})`);
      }
      if (stopped) break;
      const wait = failures ? RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)] : 0;
      if (wait) {
        log(`discord: reconnecting to the Gateway in ${wait / 1000} s`);
        await new Promise(r => setTimeout(r, wait).unref());
      }
    }
  }

  async function start() {
    if (!token) return { ok: false, error: `Discord is off: no bot token (set ${TOKEN_ENV}, or put it in ${path.join(home, TOKEN_FILE)}).` };
    const { Chat } = await import('chat');
    const { createDiscordAdapter } = await import('@chat-adapter/discord');
    const { createMemoryState } = await import('@chat-adapter/state-memory');
    const logger = { debug() {}, info() {}, warn: m => log(`discord: ${m}`), error: m => log(`discord: ${m}`), child: () => logger };
    discord = createDiscordAdapter({
      botToken: token,
      applicationId: config.applicationId,
      publicKey: config.publicKey,
      apiUrl: config.apiUrl,
      respondToChannelIds: [config.channelId],
      logger,
    });
    bot = new Chat({ userName: 'claude-wow', adapters: { discord }, state: createMemoryState(), logger });
    bot.onNewMention(onIncoming);
    bot.onSubscribedMessage(onIncoming);
    await bot.initialize();
    for (const link of links.all())
      await bot
        .thread(link.threadId)
        .subscribe()
        .catch(() => {});
    await serve();
    if (config.gateway) gatewayLoop();
    return { ok: true };
  }

  async function rest(method, route, body) {
    const res = await fetchImpl(`${config.apiUrl}${route}`, {
      method,
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify({ ...body, allowed_mentions: { parse: [] } }) : undefined,
    });
    if (!res.ok) throw new Error(`Discord ${method} ${route.replace(/\d{5,}/g, 'N')}: HTTP ${res.status}`);
    return res.json();
  }

  async function createLink(name, recap) {
    const channel = await rest('GET', `/channels/${config.channelId}`);
    const opener = await rest('POST', `/channels/${config.channelId}/messages`, { content: clean(`Chat linked from the game: ${name}`).slice(0, CHUNK_MAX) });
    const made = await rest('POST', `/channels/${config.channelId}/messages/${opener.id}/threads`, { name: clean(name).slice(0, 90) || 'claude-wow chat' });
    const threadId = discord.encodeThreadId({ guildId: channel.guild_id, channelId: config.channelId, threadId: made.id });
    await bot.thread(threadId).subscribe();
    if (recap) await post(threadId, recap);
    return threadId;
  }

  async function post(threadId, text) {
    for (const chunk of splitText(clean(text))) await bot.thread(threadId).post(chunk);
  }

  function postTo(chatId, text) {
    const link = links.get(chatId);
    if (!link || !bot) return Promise.resolve(false);
    const sent = progress.get(chatId);
    progress.delete(chatId);
    const tidy = sent && sent.id ? discord.deleteMessage(link.threadId, sent.id).catch(() => {}) : Promise.resolve();
    return tidy
      .then(() => post(link.threadId, text))
      .then(() => true)
      .catch(e => {
        log(`discord: post to chat ${chatId} failed (${e.message})`);
        return false;
      });
  }

  function progressTo(chatId, text) {
    const link = links.get(chatId);
    if (!link || !bot) return;
    const now = Date.now();
    const cur = progress.get(chatId) || { id: '', at: 0, busy: false };
    if (cur.busy || now - cur.at < PROGRESS_EVERY_MS) return;
    cur.busy = true;
    cur.at = now;
    progress.set(chatId, cur);
    const body = clean(text).slice(0, CHUNK_MAX);
    const sending = cur.id ? discord.editMessage(link.threadId, cur.id, body) : discord.postMessage(link.threadId, body);
    sending
      .then(m => {
        if (!cur.id && m && m.id) cur.id = m.id;
      })
      .catch(e => log(`discord: progress for chat ${chatId} failed (${e.message})`))
      .finally(() => (cur.busy = false));
  }

  async function stop() {
    stopped = true;
    abort.abort();
    if (server) await new Promise(r => server.close(() => r()));
    try {
      fs.rmSync(path.join(home, WEBHOOK_FILE), { force: true });
    } catch {}
  }

  return { start, stop, createLink, postTo, progressTo, webhookUrl: () => webhookUrl };
}

module.exports = { TOKEN_ENV, TOKEN_FILE, WEBHOOK_FILE, CHUNK_MAX, settings, takeToken, clean, splitText, createChatHub };
