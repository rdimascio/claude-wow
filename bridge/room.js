'use strict';
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_URL = 'ws://127.0.0.1:4319/ws';
const DEFAULT_DB = path.join(os.homedir(), '.agent-room', 'bot.sqlite');
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 60000;
const SNAPSHOT_DEADLINE_MS = 15000;
const TEXT_MAX = 1500;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SLACK_THREAD_RE = /^slack:(C[A-Z0-9]{1,29}):/;
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
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-readonly', db, "select value from meta where key = 'web_token'"], { encoding: 'utf8', timeout: 5000 }, (err, out) => {
      const token = String(out || '').trim();
      if (err || !/^[0-9a-f]{16,64}$/.test(token)) reject(new Error(`no room token in ${db} (start agent-room once so it makes one)`));
      else resolve(token);
    });
  });
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

function createRoom({
  conf,
  log,
  onMessage,
  onStatus = () => {},
  token = () => readToken(conf.db),
  WebSocketImpl = globalThis.WebSocket,
  timers = { setTimeout, clearTimeout },
}) {
  const channels = new Map();
  const threads = new Map();
  const agents = new Map();
  let socket = null;
  let retryMs = RETRY_MIN_MS;
  let retryTimer = null;
  let stopped = false;
  let connected = false;
  let lastError = '';
  let lastBadFrame = '';
  let deadline = null;

  function followed(channel) {
    if (!channel || channel.workspaceId !== conf.workspace || channel.archived) return false;
    return conf.channels.length === 0 || conf.channels.includes(channel.slug);
  }

  function apply(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'snapshot' && event.snapshot) {
      const snap = event.snapshot;
      if (![snap.channels, snap.threads, snap.agents].every(Array.isArray)) {
        badFrame('a snapshot without channel, thread and agent lists');
        return;
      }
      channels.clear();
      threads.clear();
      agents.clear();
      for (const c of snap.channels) if (c && c.id) channels.set(c.id, c);
      for (const t of snap.threads) if (t && t.id) threads.set(t.id, t);
      for (const a of snap.agents) if (a && a.id) agents.set(a.id, a);
      if (!connected) log(`room: connected to agent-room, following ${[...channels.values()].filter(followed).length} channel(s) of ${conf.workspace}`);
      if (deadline) timers.clearTimeout(deadline);
      deadline = null;
      const back = !connected;
      connected = true;
      lastError = '';
      retryMs = RETRY_MIN_MS;
      if (back) onStatus(true);
      return;
    }
    if (event.type === 'channel' && event.channel) channels.set(event.channel.id, event.channel);
    else if (event.type === 'thread' && event.thread) threads.set(event.thread.id, event.thread);
    else if (event.type === 'slack_message' && event.message) {
      const slack = SLACK_THREAD_RE.exec(String(event.threadId || ''));
      if (!slack || event.project !== conf.workspace) return;
      deliver(event.message, { chat: chatIdFor(`slack:${slack[1]}`), title: `Slack ${slack[1]}`, thread: '', via: 'Slack' });
    } else if (event.type === 'message' && event.message) {
      const thread = threads.get(event.threadId);
      const channel = thread && channels.get(thread.channelId);
      if (!followed(channel)) return;
      deliver(event.message, { chat: chatIdFor(channel.id), title: `#${channel.slug}`, thread: thread.title || '', via: 'room' });
    }
  }

  function deliver(message, target) {
    const human = String(message.authorId || '').startsWith('human:');
    const agent = !human && agents.get(message.authorId);
    onMessage({
      chat: target.chat,
      title: target.title,
      thread: target.thread,
      id: String(message.id || ''),
      role: human ? 'user' : message.semantic && message.semantic.kind === 'system' ? 'system' : 'assistant',
      from: human ? target.via : (agent && agent.displayName) || '',
      text: messageText(message),
    });
  }

  function fail(why) {
    if (why !== lastError) log(`room: ${why}; retrying every ${RETRY_MAX_MS / 1000} s at most`);
    lastError = why;
    if (connected) onStatus(false);
    connected = false;
  }

  function badFrame(why) {
    if (why !== lastBadFrame) log(`room: ignored ${why}`);
    lastBadFrame = why;
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
    Promise.resolve()
      .then(() => token())
      .then(open, e => {
        fail(`cannot read the agent-room token (${e && e.message ? e.message : e})`);
        schedule();
      });
  }

  function open(secret) {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocketImpl(`${conf.url}?token=${secret}&slack=1`);
    } catch (e) {
      fail(`cannot open ${conf.url} (${e && e.message ? e.message : e})`);
      schedule();
      return;
    }
    socket = ws;
    if (deadline) timers.clearTimeout(deadline);
    deadline = timers.setTimeout(() => {
      deadline = null;
      if (socket !== ws || connected) return;
      badFrame('a connection that sent no snapshot within 15 s');
      try {
        ws.close();
      } catch {}
      if (socket === ws) ws.onclose();
    }, SNAPSHOT_DEADLINE_MS);
    if (deadline && deadline.unref) deadline.unref();
    ws.onmessage = msg => {
      if (typeof msg.data !== 'string') return badFrame('a frame that is not text');
      let event;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return badFrame('a frame that is not JSON');
      }
      try {
        apply(event);
      } catch (e) {
        badFrame(`an event that could not be applied (${e && e.message ? e.message : e})`);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (deadline) timers.clearTimeout(deadline);
      deadline = null;
      if (stopped) return;
      fail(`lost ${conf.url}`);
      schedule();
    };
  }

  function stop() {
    stopped = true;
    if (retryTimer) timers.clearTimeout(retryTimer);
    if (deadline) timers.clearTimeout(deadline);
    retryTimer = null;
    deadline = null;
    if (socket)
      try {
        socket.close();
      } catch {}
    socket = null;
  }

  return { connect, stop, apply, status: () => ({ connected, error: lastError }) };
}

module.exports = { DEFAULT_URL, DEFAULT_DB, TEXT_MAX, SNAPSHOT_DEADLINE_MS, settings, readToken, chatIdFor, messageText, createRoom };
