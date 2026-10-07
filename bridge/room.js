'use strict';
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_URL = 'ws://127.0.0.1:4319/ws';
const DEFAULT_DB = path.join(os.homedir(), '.agent-room', 'bot.sqlite');
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 60000;
const TEXT_MAX = 1500;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const WORKSPACE_RE = /^[\w.-]{1,100}$/;

function settings(options) {
  const r = options && typeof options === 'object' ? options : {};
  if (r.enabled !== true) return { enabled: false };
  const url = typeof r.url === 'string' && /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/ws$/.test(r.url) ? r.url : DEFAULT_URL;
  const workspace = typeof r.workspace === 'string' && WORKSPACE_RE.test(r.workspace) ? r.workspace : '';
  const channels = Array.isArray(r.channels) ? r.channels.filter(s => typeof s === 'string' && SLUG_RE.test(s)) : [];
  if (!workspace) return { enabled: false, error: 'plugins.room.workspace must name the agent-room workspace (the repo folder name, for example "wow-ai")' };
  return { enabled: true, url, workspace, channels, db: typeof r.db === 'string' && r.db ? r.db : DEFAULT_DB };
}

function readToken(db) {
  const out = execFileSync('/usr/bin/sqlite3', ['-readonly', db, "select value from meta where key = 'web_token'"], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const token = out.trim();
  if (!/^[0-9a-f]{16,64}$/.test(token)) throw new Error(`no room token in ${db} (start agent-room once so it makes one)`);
  return token;
}

function chatIdFor(channelId) {
  return 'r' + crypto.createHash('sha256').update(String(channelId)).digest('hex').slice(0, 10);
}

function clip(text) {
  const s = String(text || '').trim();
  return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX - 3) + '...' : s;
}

function messageText(message) {
  const s = (message && message.semantic) || {};
  if (s.kind === 'approval') {
    const choices = Array.isArray(s.choices) && s.choices.length ? ` (${s.choices.join(' / ')})` : '';
    return clip(`Asks: ${s.question || ''}${choices}. Answer it in Slack or the room for now.`);
  }
  if (s.kind === 'decision') return clip(`Decided: ${s.question || ''}: ${s.chosen || ''}`);
  if (s.kind === 'artifact') return clip(`${s.title || 'Artifact'}\n\n${s.body || ''}`);
  if (s.kind === 'table' || s.kind === 'chart' || s.kind === 'plan') return clip(`${s.title || s.kind} (open the room to see it)`);
  if (s.kind === 'chat' || s.kind === 'system') return clip(s.text || message.text);
  return clip(message && message.text);
}

function createRoom({ conf, log, onMessage, token = () => readToken(conf.db), WebSocketImpl = globalThis.WebSocket, timers = { setTimeout, clearTimeout } }) {
  const channels = new Map();
  const threads = new Map();
  const agents = new Map();
  let socket = null;
  let retryMs = RETRY_MIN_MS;
  let retryTimer = null;
  let stopped = false;
  let connected = false;
  let lastError = '';

  function followed(channel) {
    if (!channel || channel.workspaceId !== conf.workspace || channel.archived) return false;
    return conf.channels.length === 0 || conf.channels.includes(channel.slug);
  }

  function apply(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'snapshot' && event.snapshot) {
      channels.clear();
      threads.clear();
      agents.clear();
      for (const c of event.snapshot.channels || []) channels.set(c.id, c);
      for (const t of event.snapshot.threads || []) threads.set(t.id, t);
      for (const a of event.snapshot.agents || []) agents.set(a.id, a);
      if (!connected) log(`room: connected to agent-room, following ${[...channels.values()].filter(followed).length} channel(s) of ${conf.workspace}`);
      connected = true;
      lastError = '';
      retryMs = RETRY_MIN_MS;
      return;
    }
    if (event.type === 'channel' && event.channel) channels.set(event.channel.id, event.channel);
    else if (event.type === 'thread' && event.thread) threads.set(event.thread.id, event.thread);
    else if (event.type === 'message' && event.message) {
      const thread = threads.get(event.threadId);
      const channel = thread && channels.get(thread.channelId);
      if (!followed(channel)) return;
      const message = event.message;
      const human = String(message.authorId || '').startsWith('human:');
      const agent = !human && agents.get(message.authorId);
      onMessage({
        chat: chatIdFor(channel.id),
        title: `#${channel.slug}`,
        thread: thread.title || '',
        id: String(message.id || ''),
        role: human ? 'user' : message.semantic && message.semantic.kind === 'system' ? 'system' : 'assistant',
        from: human ? 'room' : (agent && agent.displayName) || '',
        text: messageText(message),
      });
    }
  }

  function fail(why) {
    if (why !== lastError) log(`room: ${why}; retrying every ${RETRY_MAX_MS / 1000} s at most`);
    lastError = why;
    connected = false;
  }

  function schedule() {
    if (stopped || retryTimer) return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    if (retryTimer && retryTimer.unref) retryTimer.unref();
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }

  function connect() {
    if (stopped) return;
    if (typeof WebSocketImpl !== 'function') {
      fail('this runtime has no WebSocket');
      return;
    }
    let secret;
    try {
      secret = token();
    } catch (e) {
      fail(`cannot read the agent-room token (${e && e.message ? e.message : e})`);
      schedule();
      return;
    }
    let ws;
    try {
      ws = new WebSocketImpl(`${conf.url}?token=${secret}`);
    } catch (e) {
      fail(`cannot open ${conf.url} (${e && e.message ? e.message : e})`);
      schedule();
      return;
    }
    socket = ws;
    ws.onmessage = msg => {
      try {
        apply(JSON.parse(typeof msg.data === 'string' ? msg.data : String(msg.data)));
      } catch (e) {
        log(`room: an event could not be read (${e && e.message ? e.message : e})`);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (stopped) return;
      fail(`lost ${conf.url}`);
      schedule();
    };
  }

  function stop() {
    stopped = true;
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
    if (socket)
      try {
        socket.close();
      } catch {}
    socket = null;
  }

  return { connect, stop, apply, status: () => ({ connected, error: lastError }) };
}

module.exports = { DEFAULT_URL, DEFAULT_DB, TEXT_MAX, settings, readToken, chatIdFor, messageText, createRoom };
