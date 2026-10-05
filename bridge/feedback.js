'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'feedback.jsonl';
const ITEMS_MAX = 500;
const TEXT_MAX = 4000;
const NOTE_MAX = 1000;
const ADDON_MAX = 3000;
const LINE_PREVIEW = 90;

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? s.slice(0, max) : s;
}

function oneLine(text, max = LINE_PREVIEW) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function readItems(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const items = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item && typeof item === 'object' && Number.isInteger(item.n)) items.push(item);
    } catch {}
  }
  return items;
}

function writeItems(file, items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function createStore(dir, { now = Date.now } = {}) {
  const file = path.join(dir, FILE_NAME);

  function list({ status = '' } = {}) {
    const items = readItems(file);
    return status ? items.filter(i => i.status === status) : items;
  }

  function get(n) {
    return readItems(file).find(i => i.n === n) || null;
  }

  function add(fields) {
    const items = readItems(file);
    const n = items.reduce((m, i) => Math.max(m, i.n), 0) + 1;
    const item = {
      n,
      at: new Date(now()).toISOString(),
      status: 'open',
      kind: fields.kind === 'bug' ? 'bug' : 'wrong',
      chat: clip(fields.chat, 64),
      chatName: clip(fields.chatName, 120),
      replyId: Number.isInteger(fields.replyId) ? fields.replyId : null,
      cwd: clip(fields.cwd, 500),
      plugin: clip(fields.plugin, 40),
      agent: clip(fields.agent, 40),
      session: clip(fields.session, 120),
      prompt: clip(fields.prompt, TEXT_MAX),
      reply: clip(fields.reply, TEXT_MAX),
      note: clip(fields.note, NOTE_MAX),
      addon: clip(fields.addon, ADDON_MAX),
    };
    items.push(item);
    while (items.length > ITEMS_MAX) items.shift();
    writeItems(file, items);
    return item;
  }

  function close(n, why = '') {
    const items = readItems(file);
    const item = items.find(i => i.n === n);
    if (!item) return null;
    item.status = 'closed';
    item.closedAt = new Date(now()).toISOString();
    if (why) item.closedWhy = clip(why, NOTE_MAX);
    writeItems(file, items);
    return item;
  }

  return { file, list, get, add, close };
}

function describe(item, { full = false } = {}) {
  const head = `#${item.n} ${item.kind}${item.status === 'closed' ? ' (closed)' : ''}, ${String(item.at || '').slice(0, 16).replace('T', ' ')} UTC, ${item.plugin || 'chat'}${item.chatName ? ' "' + oneLine(item.chatName, 40) + '"' : ''}`;
  if (!full) return `${head}: ${oneLine(item.note || item.reply || item.prompt || '(no text)')}`;
  const lines = [head];
  if (item.note) lines.push(`note: ${item.note}`);
  if (item.cwd) lines.push(`folder: ${item.cwd}`);
  if (item.agent || item.session) lines.push(`agent: ${item.agent || '?'}${item.session ? ', session ' + item.session : ''}`);
  if (item.prompt) lines.push(`asked: ${oneLine(item.prompt, 400)}`);
  if (item.reply) lines.push(`answered: ${oneLine(item.reply, 600)}`);
  if (item.addon) lines.push(`addon state:\n${item.addon}`);
  return lines.join('\n');
}

function fixBrief(item) {
  return [
    `[Feedback item #${item.n} from ${FILE_NAME} in the claude-wow home folder, handed to you by the player]`,
    item.kind === 'bug' ? 'The player reported this bug in the claude-wow bridge or addon.' : 'The player marked this reply as wrong. Find out why the bridge, the addon or the prompt produced it, and fix the cause in this repository.',
    describe(item, { full: true }),
  ].join('\n');
}

module.exports = { FILE_NAME, ITEMS_MAX, createStore, describe, fixBrief, readItems };
