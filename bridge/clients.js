'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const SIG = require('./signals');

const LEGACY_KEYS = Object.freeze(['addonDir', 'savedVariablesFile', 'inboxFile']);
const ENTRY_KEYS = Object.freeze(['dir', 'account', 'processName', 'tocInterface', 'addonDir', 'savedVariablesFile', 'inboxFile', 'screenshotDir', 'enabled']);
const STATE_KEYS = Object.freeze(['presence', 'presenceTest', 'chatLogWrites']);
const LABEL_RE = /^[\w .-]{1,40}$/;
const CLIENTS_MAX = 8;

const trimSep = p => String(p || '').replace(/[\\/]+$/, '');
const keyOf = dir => (trimSep(dir) ? path.resolve(trimSep(dir)) : '');
const sameDir = (a, b) => !!keyOf(a) && keyOf(a) === keyOf(b);
const labelOf = dir => path.basename(trimSep(dir)) || trimSep(dir);
const dirOfAddons = addonDir => (trimSep(addonDir) ? path.dirname(path.dirname(trimSep(addonDir))) : '');
const addonDirFor = dir => path.join(dir, 'Interface', 'AddOns');
const savedFileFor = (dir, account) => (account ? path.join(dir, 'WTF', 'Account', account, 'SavedVariables', P.ADDON + '.lua') : '');

function accountOf(savedFile) {
  const m = /[\\/]WTF[\\/]Account[\\/]([^\\/]+)[\\/]SavedVariables[\\/][^\\/]+$/.exec(String(savedFile || ''));
  return m ? m[1] : '';
}

function productFor(dir) {
  const flavor = labelOf(dir);
  if (flavor === '_retail_') return 'wow';
  return 'wow' + flavor.replace(/_+$/, '');
}

function usableInbox(file) {
  return !!file && !P.OLD_ADDON_PATH.test(file) && !P.SHIPPED_INBOX_PATH.test(file);
}

function legacyEntry(cfg) {
  if (!cfg || !trimSep(cfg.addonDir)) return null;
  const cap = cfg.capture || {};
  const entry = { dir: dirOfAddons(cfg.addonDir), addonDir: trimSep(cfg.addonDir) };
  if (cfg.savedVariablesFile) entry.savedVariablesFile = String(cfg.savedVariablesFile);
  if (cfg.inboxFile) entry.inboxFile = String(cfg.inboxFile);
  if (cap.processName) entry.processName = String(cap.processName);
  if (cap.screenshotDir) entry.screenshotDir = String(cap.screenshotDir);
  return entry;
}

function rawEntries(cfg) {
  if (cfg && Array.isArray(cfg.clients) && cfg.clients.length) return cfg.clients.filter(e => e && typeof e === 'object');
  const legacy = legacyEntry(cfg);
  return legacy ? [legacy] : [];
}

function resolveEntry(entry, cfg = {}) {
  const dir = trimSep(entry.dir) || dirOfAddons(entry.addonDir);
  if (!dir) return null;
  const cap = cfg.capture || {};
  const addonDir = trimSep(entry.addonDir) || addonDirFor(dir);
  const saved = String(entry.savedVariablesFile || '').replace(P.OLD_SAVED_FILE, P.ADDON + '.lua');
  const account = String(entry.account || '') || accountOf(saved);
  return {
    key: keyOf(dir),
    dir,
    label: labelOf(dir),
    product: productFor(dir),
    account,
    addonDir,
    inboxFile: usableInbox(entry.inboxFile) ? String(entry.inboxFile) : SIG.runtimeInbox(addonDir),
    savedVariablesFile: saved || savedFileFor(dir, account),
    processName: String(entry.processName || cap.processName || 'WowB'),
    tocInterface: String(entry.tocInterface || cfg.tocInterface || P.TOC_INTERFACE),
    screenshotDir: entry.screenshotDir ? path.resolve(String(entry.screenshotDir)) : path.join(dir, 'Screenshots'),
    chatLogFile: path.join(dir, 'Logs', 'WoWChatLog.txt'),
    enabled: entry.enabled !== false,
  };
}

function allClients(cfg) {
  const seen = new Set();
  const out = [];
  for (const entry of rawEntries(cfg)) {
    const c = resolveEntry(entry, cfg);
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

function clientsOf(cfg) {
  return allClients(cfg).filter(c => c.enabled);
}

function compactEntry(entry) {
  const dir = trimSep(entry.dir) || dirOfAddons(entry.addonDir);
  const out = { dir };
  const saved = String(entry.savedVariablesFile || '').replace(P.OLD_SAVED_FILE, P.ADDON + '.lua');
  const account = String(entry.account || '') || accountOf(saved);
  if (account) out.account = account;
  if (entry.processName) out.processName = String(entry.processName);
  if (entry.tocInterface) out.tocInterface = String(entry.tocInterface);
  if (trimSep(entry.addonDir) && !sameDir(entry.addonDir, addonDirFor(dir))) out.addonDir = trimSep(entry.addonDir);
  if (saved && saved !== savedFileFor(dir, account)) out.savedVariablesFile = saved;
  const addonDir = out.addonDir || addonDirFor(dir);
  if (usableInbox(entry.inboxFile) && !sameDir(entry.inboxFile, SIG.runtimeInbox(addonDir))) out.inboxFile = String(entry.inboxFile);
  if (entry.screenshotDir && !sameDir(entry.screenshotDir, path.join(dir, 'Screenshots'))) out.screenshotDir = String(entry.screenshotDir);
  if (entry.enabled === false) out.enabled = false;
  return out;
}

function migrateConfig(cfg) {
  const notes = [];
  if (!Array.isArray(cfg.clients) || !cfg.clients.length) {
    const legacy = legacyEntry(cfg);
    cfg.clients = legacy ? [compactEntry(legacy)] : [];
    if (legacy) notes.push('clients');
  }
  let dropped = 0;
  for (const k of LEGACY_KEYS) if (k in cfg) { delete cfg[k]; dropped++; }
  if (dropped && !notes.length) notes.push('clients');
  if (cfg.capture && cfg.capture.screenshotDir && cfg.clients.length) {
    if (!cfg.clients[0].screenshotDir) cfg.clients[0].screenshotDir = cfg.capture.screenshotDir;
    delete cfg.capture.screenshotDir;
  }
  return notes;
}

function upsertClient(cfg, entry) {
  if (!Array.isArray(cfg.clients)) cfg.clients = [];
  const want = compactEntry(entry);
  const at = cfg.clients.findIndex(e => e && sameDir(e.dir || dirOfAddons(e.addonDir), want.dir));
  if (at < 0) {
    cfg.clients.push(want);
    return 'added';
  }
  const merged = compactEntry({ ...cfg.clients[at], ...want, enabled: entry.enabled === undefined ? cfg.clients[at].enabled : entry.enabled });
  if (JSON.stringify(merged) === JSON.stringify(cfg.clients[at])) return 'same';
  cfg.clients[at] = merged;
  return 'updated';
}

function clientState(state, key) {
  if (!state.clients || typeof state.clients !== 'object' || Array.isArray(state.clients)) state.clients = {};
  const k = String(key || '');
  if (!state.clients[k] || typeof state.clients[k] !== 'object') state.clients[k] = {};
  return state.clients[k];
}

function adoptLegacyState(state, clients) {
  const first = clients[0];
  if (!first) return false;
  let moved = false;
  for (const k of STATE_KEYS) {
    if (state[k] === undefined) continue;
    const cs = clientState(state, first.key);
    if (cs[k] === undefined) cs[k] = state[k];
    delete state[k];
    moved = true;
  }
  const cs = clientState(state, first.key);
  if (state.context && typeof state.context === 'object' && cs.context === undefined) {
    cs.context = { ...state.context };
    moved = true;
  }
  return moved;
}

function legacyStateFor(state, clients, key) {
  const cs = (state && state.clients && state.clients[key]) || {};
  const out = {};
  for (const k of STATE_KEYS) {
    if (cs[k] !== undefined) out[k] = cs[k];
    else if (clients[0] && clients[0].key === key && state && state[k] !== undefined) out[k] = state[k];
  }
  return out;
}

function noteHeard(state, key, { now = Date.now(), hello = false, id } = {}) {
  const cs = clientState(state, key);
  cs.heard = now;
  if (hello) cs.hello = now;
  if (Number.isInteger(id) && id > 0) cs.lastId = Math.max(Number(cs.lastId) || 0, id);
  return cs;
}

function contextText(state, key) {
  if (!key) return (state && state.context && typeof state.context.text === 'string' && state.context.text) || '';
  const own = state && state.clients && state.clients[key] && state.clients[key].context;
  return own && typeof own.text === 'string' ? own.text : '';
}

function heardAt(state, key) {
  const at = Number(state && state.clients && state.clients[key] && state.clients[key].heard);
  return Number.isFinite(at) && at > 0 && at <= P.MAX_DATE_MS ? at : 0;
}

function lastSpoke(state, clients) {
  let best = null;
  for (const c of clients) {
    const at = heardAt(state, c.key);
    if (at && (!best || at > best.at)) best = { client: c, at };
  }
  return best ? best.client : null;
}

function recordsFor(records, key, max = 30) {
  return records.filter(r => r && r.client === key).slice(-max);
}

function installedBuild(client, readText = file => fs.readFileSync(file, 'utf8')) {
  let text = null;
  try { text = readText(path.join(client.addonDir, P.ADDON, P.ADDON + '.toc')); } catch { text = null; }
  if (text === null || text === undefined) return null;
  return P.addonDiskInfo(text);
}

function slotClients(clients, state, here, { diskOf = installedBuild, max = CLIENTS_MAX } = {}) {
  const last = lastSpoke(state, clients);
  return clients.slice(0, max).map(c => {
    const disk = diskOf(c) || { version: '', build: '' };
    return {
      name: LABEL_RE.test(c.label) ? c.label : c.label.replace(/[^\w .-]/g, '_').slice(0, 40),
      version: disk.version,
      build: disk.build,
      heard: Math.floor(heardAt(state, c.key) / 1000),
      here: c.key === here,
      last: !!last && last.key === c.key,
    };
  });
}

function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function describe(clients, state, { now = Date.now(), diskOf = installedBuild } = {}) {
  const last = lastSpoke(state, clients);
  return clients.map(c => {
    const disk = diskOf(c);
    const at = heardAt(state, c.key);
    const build = !disk ? 'addon not installed' : `addon ${disk.version || 'version unknown'}${disk.build ? ' build ' + disk.build : ''}`;
    const heard = at ? `heard ${agoText(now - at)}${last && last.key === c.key ? ', spoke last' : ''}` : 'not heard yet';
    return `${c.label}: ${build}, ${heard} (${c.dir})`;
  });
}

module.exports = {
  LEGACY_KEYS, ENTRY_KEYS, STATE_KEYS, CLIENTS_MAX,
  keyOf, sameDir, labelOf, dirOfAddons, addonDirFor, savedFileFor, accountOf, productFor,
  legacyEntry, resolveEntry, allClients, clientsOf, compactEntry, migrateConfig, upsertClient,
  clientState, adoptLegacyState, legacyStateFor, contextText, noteHeard, heardAt, lastSpoke, recordsFor,
  installedBuild, slotClients, describe, agoText,
};
