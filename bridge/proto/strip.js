'use strict';

const MC = require('../mcpconfig');
const { fromHex, baseName, resolveCwd, sameFolder, LATE_IN_MAX, OPEN_RESULTS } = require('./util');
const { ADDON, RUNTIME_ADDON, SHIPPED_INBOX_PATH, OLD_ADDONS, OLD_ADDON_PATH, OLD_SAVED_FILE, TOC_INTERFACE, OLD_TOC_INTERFACES } = require('./util');
const { SEMVER_RE } = require('./versions');
const { FALLBACK_REASONS } = require('./transport');

function chatKey(job) {
  return `${job.session || ''}:${job.chat || 'default'}`;
}
function sessKey(job) {
  return job.chat ? 'chat:' + job.chat : chatKey(job);
}

function alreadyHandled(state, job) {
  const key = job.session || '';
  const h = state.handled[key];
  if (!h) return key === '' && job.id <= state.lastId;
  return !!h[job.id];
}

function markHandled(state, job, now = Date.now()) {
  const key = job.session || '';
  const h = (state.handled[key] = state.handled[key] || {});
  h[job.id] = 1;
  const ids = Object.keys(h);
  if (ids.length > 1000) for (const k of ids.slice(0, ids.length - 1000)) delete h[k];
  if (job.via !== 'discord') state.lastId = Math.max(state.lastId, job.id);
  (state.seen = state.seen || {})[key] = now;
}

const RECENT_ACKS_MAX = 24;
const RECENT_ACK_MS = 10 * 60 * 1000;

function noteAck(acks, job, now = Date.now(), result = null) {
  const id = Number(job && job.id);
  if (!Number.isInteger(id) || id <= 0) return acks;
  const session = String((job && job.session) || '');
  const same = a => a.id === id && a.session === session;
  const prev = acks.find(same);
  const entry = { session, id, at: now };
  const open = result && OPEN_RESULTS.includes(result.open) ? result : prev && prev.open ? prev : null;
  if (open) {
    entry.open = open.open;
    if (open.open === 'refused') entry.why = String(open.why || '').slice(0, 80);
  }
  const kept = acks.filter(a => now - a.at < RECENT_ACK_MS && !same(a));
  return [...kept, entry].slice(-RECENT_ACKS_MAX);
}

function recentAcks(acks, now = Date.now()) {
  return acks.filter(a => now - a.at < RECENT_ACK_MS);
}

const MONTH_MS = 30 * 24 * 3600 * 1000;
function pruneStale(state, transcripts, now = Date.now(), maxAgeMs = MONTH_MS) {
  let removed = 0;
  state.seen = state.seen || {};
  for (const key of Object.keys(state.handled || {})) {
    if (key === '') continue;
    if (!state.seen[key]) {
      state.seen[key] = now;
      continue;
    }
    if (now - state.seen[key] > maxAgeMs) {
      delete state.handled[key];
      delete state.seen[key];
      removed++;
    }
  }
  for (const key of Object.keys(state.seen)) {
    if (!(state.handled || {})[key] && now - state.seen[key] > maxAgeMs) {
      delete state.seen[key];
    }
  }
  for (const [tok, t] of Object.entries((transcripts && transcripts.tokens) || {})) {
    if (now - t > maxAgeMs) {
      delete transcripts.tokens[tok];
      removed++;
    }
  }
  return removed;
}

function noteUsage(state, key, { usage, fresh, agent, startedAt, now = Date.now() } = {}) {
  const all = (state.sessionUsage = state.sessionUsage || {});
  const prev = !fresh && all[key] ? all[key] : null;
  const rec = { turns: (prev ? prev.turns || 0 : 0) + 1, agent: agent || '', at: now, since: prev && prev.since ? prev.since : startedAt || now };
  const u = usage && Number.isFinite(usage.context) && usage.context > 0 ? usage : null;
  if (u) {
    rec.context = Math.round(u.context);
    if (Number.isFinite(u.window) && u.window > 0) rec.window = u.window;
    else if (prev && prev.window) rec.window = prev.window;
  } else if (prev && prev.context) {
    rec.context = prev.context;
    if (prev.window) rec.window = prev.window;
  }
  if (prev && prev.cost !== undefined) rec.cost = prev.cost;
  if (usage && Number.isFinite(usage.cost)) rec.cost = usage.costIsSessionTotal ? usage.cost : (rec.cost || 0) + usage.cost;
  if ((usage && usage.costUnknown) || (prev && prev.costUnknown)) rec.costUnknown = true;
  all[key] = rec;
  return rec;
}

function usageFields(rec) {
  if (!rec) return {};
  const f = {};
  if (rec.context > 0) f.ctx = rec.context;
  if (rec.turns > 0) f.turns = rec.turns;
  if (rec.window > 0) f.window = rec.window;
  if (rec.since > 0) f.since = Math.floor(rec.since / 1000);
  if (rec.cost !== undefined && !rec.costUnknown) f.cost = Math.round(rec.cost * 10000) / 10000;
  return f;
}

function tokensLabel(n) {
  n = Number(n) || 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}

const SETTING_RE = /^[A-Za-z0-9._:[\]-]{1,80}$/;
const RESUME_REF_RE = /^[A-Za-z0-9._-]{1,80}$/;
const ADD_DIRS_MAX = 8;
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'default', 'dontAsk', 'plan'];

function permissionModeName(raw) {
  const want = String(raw || '')
    .trim()
    .toLowerCase();
  return PERMISSION_MODES.find(m => m.toLowerCase() === want) || '';
}

const PRESENCE_TEST_RESULTS = ['passed', 'failed'];
const LATE_CREATE_RESULTS = ['seen', 'unseen'];

function parseFlags(flags) {
  const out = { newSession: false, hello: false, forget: false, context: false, vision: false, allow: [], agent: '' };
  for (const tok of String(flags || '').split(';')) {
    if (tok === 'n') out.newSession = true;
    else if (tok === 'h') out.hello = true;
    else if (tok === 'd') out.forget = true;
    else if (tok === 'c') out.context = true;
    else if (tok === 't') out.title = true;
    else if (tok === 'v') out.vision = true;
    else if (tok.startsWith('allow='))
      out.allow.push(
        ...tok
          .slice(6)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean),
      );
    else if (tok.startsWith('once='))
      (out.allowOnce = out.allowOnce || []).push(
        ...tok
          .slice(5)
          .split(',')
          .map(s => s.trim())
          .filter(Boolean),
      );
    else if (tok.startsWith('agent=')) out.agent = tok.slice(6).trim().toLowerCase();
    else if (tok.startsWith('cancel=')) {
      const n = Number(tok.slice(7));
      if (Number.isInteger(n) && n > 0) out.cancel = n;
    } else if (tok.startsWith('plugin=')) {
      const p = tok.slice(7).trim().toLowerCase();
      if (p) out.plugin = p;
    } else if (tok.startsWith('kind=')) {
      const k = tok.slice(5).trim().toLowerCase();
      if (/^[a-z][a-z0-9-]*$/.test(k)) out.kind = k;
    } else if (tok.startsWith('model=')) {
      const v = tok.slice(6).trim();
      if (SETTING_RE.test(v)) out.model = v;
    } else if (tok.startsWith('effort=')) {
      const v = tok.slice(7).trim().toLowerCase();
      if (SETTING_RE.test(v)) out.effort = v;
    } else if (tok.startsWith('pm=')) {
      const v = permissionModeName(tok.slice(3));
      if (v) out.permissionMode = v;
    } else if (tok.startsWith('dirs=')) {
      const dirs = fromHex(tok.slice(5).trim())
        .split('\x1F')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, ADD_DIRS_MAX);
      if (dirs.length) out.addDirs = dirs;
    } else if (tok === 'discord=link') {
      out.discordLink = true;
    } else if (tok.startsWith('mcp=')) {
      out.mcp = MC.parseChoice(tok.slice(4));
    } else if (tok.startsWith('resume=')) {
      const v = tok.slice(7).trim();
      if (RESUME_REF_RE.test(v)) out.resume = v;
    } else if (tok.startsWith('char=')) {
      const v = fromHex(tok.slice(5).trim()).trim();
      if (v && v.length <= 64 && !/[\x00-\x1f\x7f\s]/.test(v)) out.reportedChar = v;
    } else if (tok.startsWith('live=')) {
      const v = fromHex(tok.slice(5).trim()).trim().slice(0, 80);
      if (v) out.liveTarget = v;
    } else if (tok.startsWith('shot=')) {
      const s = tok.slice(5).trim().toLowerCase();
      if (FALLBACK_REASONS[s]) out.shot = s;
    } else if (tok.startsWith('pt=')) {
      const v = tok.slice(3).trim().toLowerCase();
      if (PRESENCE_TEST_RESULTS.includes(v)) out.presenceTest = v;
    } else if (tok.startsWith('lc=')) {
      const v = tok.slice(3).trim().toLowerCase();
      if (LATE_CREATE_RESULTS.includes(v)) out.lateCreate = v;
    } else if (tok.startsWith('probe=')) {
      const v = tok.slice(6).trim().toLowerCase();
      if (/^[0-9a-z]{4,16}$/.test(v)) out.probe = v;
    } else if (tok.startsWith('ver=')) {
      const v = tok.slice(4).trim();
      if (SEMVER_RE.test(v)) out.addonVersion = v;
    } else if (tok.startsWith('proto=')) {
      const v = tok.slice(6).trim();
      if (/^\d{1,6}$/.test(v) && Number(v) > 0) out.addonProto = Number(v);
    }
  }
  return out;
}

const CHAT_ID_RE = /^[0-9a-zA-Z]*$/;

function jobsFromStrip(headerId, payload) {
  const jobs = [];
  for (const rec of String(payload).split('\x1E')) {
    const p = rec.split('\x1F');
    if (p.length >= 6 && !CHAT_ID_RE.test(p[1])) continue;
    if (p.length >= 7 && /^\d+$/.test(p[2])) {
      const flags = parseFlags(p[4]);
      const withCtx = flags.context && p.length >= 8;
      const job = { session: p[0], chat: p[1], id: Number(p[2]), cwd: p[3], ...flags, name: p[5], text: p.slice(withCtx ? 7 : 6).join('\x1F'), via: 'pixel' };
      if (withCtx) job.ctx = p[6];
      jobs.push(job);
    } else if (p.length === 6 && /^\d+$/.test(p[2])) {
      jobs.push({ session: p[0], chat: p[1], id: Number(p[2]), cwd: p[3], ...parseFlags(p[4]), name: '', text: p[5], via: 'pixel' });
    } else if (p.length === 4) {
      jobs.push({ session: p[0], chat: '', id: headerId, cwd: p[1], ...parseFlags(p[2]), text: p[3], via: 'pixel' });
    }
  }
  return jobs;
}

function parseOutbox(src) {
  const block = String(src || '').match(/\["outbox"\]\s*=\s*\{([^}]*)\}/);
  if (!block) return null;
  const b = block[1];
  const id = Number((b.match(/\["id"\]\s*=\s*(\d+)/) || [])[1]);
  if (!id) return null;
  const text = fromHex((b.match(/\["text"\]\s*=\s*"([0-9a-fA-F]*)"/) || [])[1]);
  const cwd = fromHex((b.match(/\["cwd"\]\s*=\s*"([0-9a-fA-F]*)"/) || [])[1]);
  const session = (b.match(/\["session"\]\s*=\s*"([0-9a-zA-Z]*)"/) || [])[1] || '';
  const chat = (b.match(/\["chat"\]\s*=\s*"([0-9a-zA-Z]*)"/) || [])[1] || '';
  const newSession = /\["newSession"\]\s*=\s*true/.test(b);
  const job = { id, session, chat, text, cwd, newSession, via: 'reload' };
  const ctx = b.match(/\["ctx"\]\s*=\s*"([0-9a-fA-F]*)"/);
  if (ctx) job.ctx = fromHex(ctx[1]);
  const agent = b.match(/\["agent"\]\s*=\s*"([0-9a-zA-Z_-]*)"/);
  if (agent && agent[1]) job.agent = agent[1].toLowerCase();
  const plugin = b.match(/\["plugin"\]\s*=\s*"([0-9a-zA-Z_-]*)"/);
  if (plugin && plugin[1]) job.plugin = plugin[1].toLowerCase();
  const allow = b.match(/\["allow"\]\s*=\s*"([0-9a-fA-F]*)"/);
  if (allow && allow[1]) job.allow = fromHex(allow[1]).split('\x1F').filter(Boolean);
  const allowOnce = b.match(/\["allowOnce"\]\s*=\s*"([0-9a-fA-F]*)"/);
  if (allowOnce && allowOnce[1]) job.allowOnce = fromHex(allowOnce[1]).split('\x1F').filter(Boolean);
  const shot = b.match(/\["shot"\]\s*=\s*"([a-z]*)"/);
  if (shot && FALLBACK_REASONS[shot[1]]) job.shot = shot[1];
  const opts = b.match(/\["opts"\]\s*=\s*"([0-9a-fA-F]*)"/);
  if (opts && opts[1]) {
    const f = parseFlags(fromHex(opts[1]));
    for (const k of ['model', 'effort', 'permissionMode', 'addDirs', 'mcp', 'resume', 'liveTarget', 'addonVersion', 'addonProto', 'reportedChar'])
      if (f[k] !== undefined) job[k] = f[k];
  }
  return job;
}

module.exports = {
  ADDON,
  RUNTIME_ADDON,
  SHIPPED_INBOX_PATH,
  OLD_ADDONS,
  OLD_ADDON_PATH,
  OLD_SAVED_FILE,
  TOC_INTERFACE,
  OLD_TOC_INTERFACES,
  fromHex,
  baseName,
  resolveCwd,
  sameFolder,
  LATE_IN_MAX,
  chatKey,
  sessKey,
  alreadyHandled,
  markHandled,
  RECENT_ACKS_MAX,
  RECENT_ACK_MS,
  noteAck,
  recentAcks,
  MONTH_MS,
  pruneStale,
  noteUsage,
  usageFields,
  tokensLabel,
  ADD_DIRS_MAX,
  PERMISSION_MODES,
  permissionModeName,
  PRESENCE_TEST_RESULTS,
  LATE_CREATE_RESULTS,
  parseFlags,
  CHAT_ID_RE,
  jobsFromStrip,
  parseOutbox,
};
