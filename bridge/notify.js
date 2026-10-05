'use strict';
const path = require('path');

const SECRET_ENV = 'CLAUDE_WOW_DISCORD_WEBHOOK';
const URL_RE = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/;
const DEFAULT_MIN_RUN_SECONDS = 60;
const SEND_TIMEOUT_MS = 10000;
const FLUSH_MS = 2000;
const TOKEN_RE = /\{(?:item|spell|quest|skill|faction|map|npc|achievement):[^}]*\}/gi;
const FIELD_MAX = 100;
const EVENTS = Object.freeze({
  done: { title: 'Claude finished', color: 0x3ba55d },
  failed: { title: 'Claude run failed', color: 0xed4245 },
  blocked: { title: 'Claude needs a permission', color: 0xfaa61a },
  late: { title: 'A result is waiting in game', color: 0x5865f2 },
});
const TIMED_EVENTS = new Set(['done', 'failed', 'blocked']);

function runEvent(status, denied) {
  if (status === 'error') return 'failed';
  return Array.isArray(denied) && denied.length ? 'blocked' : 'done';
}

function takeSecret(env = process.env) {
  const value = typeof env[SECRET_ENV] === 'string' ? env[SECRET_ENV].trim() : '';
  delete env[SECRET_ENV];
  return value;
}

function webhookUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { url: '' };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { url: '', error: 'is not a URL' };
  }
  const bare = `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, '');
  return URL_RE.test(bare) ? { url: bare } : { url: '', error: 'is not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)' };
}

function settings(notify, secret = '') {
  const n = notify && typeof notify === 'object' ? notify : {};
  const configured = n.discord && typeof n.discord === 'object' ? n.discord.webhookUrl : '';
  const picked = webhookUrl(secret || configured);
  const min = Number(n.minRunSeconds);
  return {
    url: picked.url,
    error: picked.error ? `${secret ? SECRET_ENV : 'notify.discord.webhookUrl'} ${picked.error}` : '',
    minRunSeconds: Number.isFinite(min) && min >= 0 ? min : DEFAULT_MIN_RUN_SECONDS,
    detail: n.detail === 'named' ? 'named' : 'plain',
  };
}

function redact(url) {
  return url ? `webhook .../${String(url).slice(-4)}` : 'no webhook';
}

function clean(text, max = FIELD_MAX) {
  const s = String(text || '')
    .replace(TOKEN_RE, '')
    .replace(/[@`*_~|>#[\]()<]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 3).trimEnd() + '...' : s;
}

function duration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function payload(event, fields = {}, detail = 'plain') {
  const kind = EVENTS[event];
  const lines = [];
  if (fields.character) lines.push(`Character: ${clean(fields.character, 40)}`);
  if (detail === 'named' && fields.chat) lines.push(`Chat: ${clean(fields.chat)}`);
  if (detail === 'named' && fields.cwd) lines.push(`Project: ${clean(path.basename(String(fields.cwd)), 60)}`);
  if (TIMED_EVENTS.has(event) && Number.isFinite(fields.ms)) lines.push(`Time: ${duration(fields.ms)}`);
  if (Number.isFinite(fields.cost)) lines.push(`Cost: $${fields.cost.toFixed(2)}`);
  if (event === 'late') lines.push('Send any message in the chat to fetch it.');
  return {
    allowed_mentions: { parse: [] },
    embeds: [{ title: kind.title, description: lines.join('\n') || kind.title, color: kind.color }],
  };
}

function createNotifier({ url = '', minRunSeconds = DEFAULT_MIN_RUN_SECONDS, detail = 'plain', fetch = globalThis.fetch, log = () => {} } = {}) {
  const pending = new Set();

  async function post(event, body) {
    let timer;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      const res = await fetch(`${url}?wait=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res || !res.ok) log(`notify: discord ${event} not sent (${redact(url)}, HTTP ${res ? res.status : 'none'})`);
    } catch (e) {
      log(`notify: discord ${event} not sent (${redact(url)}, ${e && e.name === 'AbortError' ? 'timed out' : e && e.message ? e.message : e})`);
    } finally {
      clearTimeout(timer);
    }
  }

  function notify(event, fields = {}) {
    if (!url || !EVENTS[event] || typeof fetch !== 'function') return false;
    if (TIMED_EVENTS.has(event) && !(Number(fields.ms) >= minRunSeconds * 1000)) return false;
    const sent = post(event, payload(event, fields, detail));
    pending.add(sent);
    sent.finally(() => pending.delete(sent));
    return true;
  }

  function flush(ms = FLUSH_MS) {
    if (!pending.size) return Promise.resolve();
    return Promise.race([Promise.allSettled([...pending]), new Promise(r => setTimeout(r, ms).unref?.())]);
  }

  return { notify, flush, enabled: !!url };
}

async function main(argv, deps = {}) {
  const out = deps.out || (line => process.stdout.write(line + '\n'));
  if (argv[0] !== 'test') {
    out(`claude-wow notify test   send one test message to the Discord webhook in notify.discord.webhookUrl or ${SECRET_ENV}`);
    return argv[0] ? 2 : 0;
  }
  const home = deps.home || require('./home').resolve();
  let cfg = {};
  try {
    cfg = JSON.parse(require('fs').readFileSync(home.config, 'utf8'));
  } catch (e) {
    out(`Cannot read ${home.config} (${e.message}).`);
    return 2;
  }
  const conf = settings(cfg.notify, takeSecret(deps.env || process.env));
  if (conf.error) {
    out(conf.error);
    return 2;
  }
  if (!conf.url) {
    out(`No webhook: set notify.discord.webhookUrl in ${home.config} or ${SECRET_ENV}.`);
    return 2;
  }
  const failures = [];
  const notifier = createNotifier({ ...conf, minRunSeconds: 0, fetch: deps.fetch || globalThis.fetch, log: line => failures.push(line) });
  notifier.notify('done', { ms: 0, character: 'notify test' });
  await notifier.flush(SEND_TIMEOUT_MS + 1000);
  if (failures.length) {
    failures.forEach(line => out(line));
    return 1;
  }
  out(`Sent a test message to ${redact(conf.url)}.`);
  return 0;
}

module.exports = { SECRET_ENV, EVENTS, DEFAULT_MIN_RUN_SECONDS, runEvent, takeSecret, webhookUrl, settings, redact, clean, payload, createNotifier, main };
