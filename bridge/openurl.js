'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const KIND = 'url';
const MAX_LENGTH = 2048;
const URL_CHARS = "A-Za-z0-9\\-._~:/?#@!$&'()+,;=%";
const ONLY_URL_CHARS = new RegExp(`^[${URL_CHARS}]+$`);
const FIND_URLS = new RegExp(`https?://[${URL_CHARS}]+`, 'g');
const WEB_PREFIX = /^https?:\/\/[A-Za-z0-9-]/;
const TRAILING_PUNCTUATION = /[.,;:!?]/;
const MIN_GAP_MS = 2000;
const HOUR_MS = 3600000;
const PER_HOUR = 20;
const LINKS_KEPT = 200;
const LOGGED_INPUT_MAX = 120;

function isOpenRecord(job) {
  return !!job && job.kind === KIND;
}

function count(text, ch) {
  return text.split(ch).length - 1;
}

function splitTrail(found) {
  let url = found;
  for (;;) {
    const last = url.slice(-1);
    if (TRAILING_PUNCTUATION.test(last) || (last === ')' && count(url, ')') > count(url, '('))) url = url.slice(0, -1);
    else return url;
  }
}

function linksIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(FIND_URLS)) {
    const url = splitTrail(m[0]);
    if (WEB_PREFIX.test(url) && url.length <= MAX_LENGTH) out.add(url);
  }
  return [...out];
}

function refused(why) {
  return { ok: false, why };
}

function checkUrl(raw) {
  if (typeof raw !== 'string') return refused('not text');
  if (raw === '') return refused('empty');
  if (raw.length > MAX_LENGTH) return refused(`longer than ${MAX_LENGTH} characters`);
  if (raw.startsWith('-')) return refused('starts with -');
  if (/[\s\x00-\x1f\x7f]/.test(raw)) return refused('holds whitespace or control characters');
  if (!ONLY_URL_CHARS.test(raw)) return refused('holds characters a link never has');
  if (!WEB_PREFIX.test(raw)) return refused('not an http or https link');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return refused('not a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return refused('not an http or https link');
  if (!parsed.hostname) return refused('no host');
  if (parsed.username || parsed.password) return refused('carries a user name or password');
  if (parsed.href.length > MAX_LENGTH || !WEB_PREFIX.test(parsed.href)) return refused('not a plain web link once parsed');
  return { ok: true, href: parsed.href };
}

function noteLinks(chat, texts) {
  if (!chat || typeof chat !== 'object') return;
  const list = Array.isArray(chat.links) ? chat.links.filter(s => typeof s === 'string') : [];
  for (const text of texts) {
    for (const url of linksIn(text)) {
      const at = list.indexOf(url);
      if (at >= 0) list.splice(at, 1);
      list.push(url);
    }
  }
  while (list.length > LINKS_KEPT) list.shift();
  chat.links = list;
}

function agentLinks(chat) {
  const known = new Set();
  if (!chat || typeof chat !== 'object') return known;
  if (Array.isArray(chat.links)) for (const url of chat.links) if (typeof url === 'string') known.add(url);
  for (const m of Array.isArray(chat.messages) ? chat.messages : []) {
    if (m && m.role === 'assistant') for (const url of linksIn(m.text)) known.add(url);
  }
  return known;
}

function launcherFor(platform, env = process.env) {
  if (platform === 'darwin') return url => ({ command: '/usr/bin/open', args: [url] });
  if (platform === 'win32') {
    const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    return url => ({ command: path.win32.join(root, 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] });
  }
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return url => ({ command: 'xdg-open', args: [url] });
  return null;
}

function createLimiter({ now = Date.now, gapMs = MIN_GAP_MS, perHour = PER_HOUR } = {}) {
  const opened = [];
  return {
    take() {
      const t = now();
      while (opened.length && t - opened[0] >= HOUR_MS) opened.shift();
      if (opened.length && t - opened[opened.length - 1] < gapMs) return `one link every ${gapMs / 1000} s`;
      if (opened.length >= perHour) return `${perHour} links an hour`;
      opened.push(t);
      return '';
    },
  };
}

function recordingSpawn(file) {
  return (command, args, options) => {
    fs.appendFileSync(file, JSON.stringify({ command, args, shell: options.shell, at: Date.now() }) + '\n');
    return null;
  };
}

function shownInput(raw) {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const cut = text.length > LOGGED_INPUT_MAX ? text.slice(0, LOGGED_INPUT_MAX) + '...' : text;
  return JSON.stringify(cut.replace(/[^\x20-\x7e]/g, '?'));
}

function createOpener({ enabled = true, platform = process.platform, env = process.env, spawnFn = spawn, now = Date.now, log = () => {} } = {}) {
  const launch = launcherFor(platform, env);
  const limiter = createLimiter({ now });
  const available = enabled === true && !!launch;

  function request(job, chat) {
    const no = why => ({ opened: false, text: `open link refused (${why}): ${shownInput(job && job.text)}` });
    if (!available) return no(enabled === true ? `no browser launcher on ${platform}` : 'openLinks is off');
    if (!job || job.via === 'reload') return no('not a strip record');
    const checked = checkUrl(job.text);
    if (!checked.ok) return no(checked.why);
    if (!chat || !job.chat) return no('no such chat');
    if (chat.client && job.client && chat.client !== job.client) return no('the chat belongs to another client');
    if (!agentLinks(chat).has(job.text)) return no('not a link from a reply in this chat');
    const wait = limiter.take();
    if (wait) return no(`rate limit: ${wait}`);
    const { command, args } = launch(checked.href);
    try {
      const child = spawnFn(command, args, { stdio: 'ignore', detached: platform !== 'win32', windowsHide: true, shell: false });
      if (child && typeof child.on === 'function') child.on('error', e => log(`open link: ${command} failed (${e && e.message ? e.message : e})`));
      if (child && typeof child.unref === 'function') child.unref();
    } catch (e) {
      return { opened: false, text: `open link failed (${e && e.message ? e.message : e}): ${shownInput(checked.href)}` };
    }
    return { opened: true, text: `open link: ${shownInput(checked.href)} for chat ${shownInput(job.chat)}` };
  }

  return { available, request };
}

module.exports = {
  KIND,
  MAX_LENGTH,
  MIN_GAP_MS,
  PER_HOUR,
  LINKS_KEPT,
  isOpenRecord,
  linksIn,
  checkUrl,
  noteLinks,
  agentLinks,
  launcherFor,
  createLimiter,
  createOpener,
  recordingSpawn,
};
