'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const TIMEOUT_MS = 800;
const KEYCHAIN_TIMEOUT_MS = 10000;
const DEFAULT_KEYCHAIN = { service: 'org.ellie.assistant', account: 'decision.typesafe' };
const MODES = ['off', 'shadow', 'execute'];
const THRESHOLDS = { run: 0.85, notice: 0.6, risky: 0.5 };
const CODE_PERMISSION_MODE = 'acceptEdits';
const RISKY_PERMISSION_MODE = 'default';
const MESSAGE_MAX = 2000;
const CONTEXT_MAX = 900;
const PROJECT_LIMIT = 40;
const HEAD_CHARS = 80;
const NO_PROJECT = 'none';

const ROUTES = {
  lore: 'A factual question about World of Warcraft game content that a game database or wiki can answer: a quest, an item, an NPC, a zone, a class or spell, a profession, a drop, or where something is in the world.',
  web: 'A question that needs information from outside the game data or newer than it: patch notes, news, the current state of the game, auction prices, guides on websites, or real-world topics.',
  code: 'A request about software on the player\'s computer: a code project or repository, a bug, a failing test, a build, a commit, a pull request, or a deploy.',
  live: 'The player speaks to a Claude Code terminal session that is already open and running, or asks to continue the work that session is doing ("tell my session", "in the terminal").',
  game: 'Help to do something inside the game client for the player\'s own character: write a macro or keybind, set up the interface or an addon, plan or mark a route on the map, or explain a game mechanic for their situation.',
  chat: 'Conversation or anything else: banter, jokes, a roast, opinions, feelings, or a general question that fits none of the other routes.',
};

const ROUTE_PLUGIN = { lore: 'ask', web: 'ask', game: 'ask', chat: 'ask', code: 'claude-code', live: 'live' };

const LORE_KINDS = {
  quest: 'A quest: where it starts, its steps, its reward, or its chain.',
  item: 'An item: gear, a consumable, a recipe, where it drops, or its stats.',
  npc: 'An NPC or a creature: where it is, what it sells, what it drops.',
  zone: 'A zone, a dungeon, a raid, a city, or a place in the world.',
  'class-spell': 'A class, a talent, a spell, or an ability.',
  profession: 'A profession: skill-up, recipes, gathering nodes, trainers.',
  other: 'Any other game topic, or the message is not about game content.',
};

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

function oneLine(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function resolveMode(routerCfg, hasKey) {
  const raw = String((routerCfg && routerCfg.mode) || '').trim().toLowerCase();
  const requested = MODES.includes(raw) ? raw : 'shadow';
  if (requested === 'off') return { mode: 'off', requested, reason: 'router.mode is off' };
  if (!hasKey) return { mode: 'off', requested, reason: 'no TypeSafe key' };
  if (requested === 'execute') return { mode: 'shadow', requested, reason: 'execute is reserved for phase 2; running as shadow' };
  return { mode: 'shadow', requested, reason: '' };
}

function keychainItem(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    const slash = s.indexOf('/');
    if (slash > 0) return { service: s.slice(0, slash), account: s.slice(slash + 1) };
    return { service: DEFAULT_KEYCHAIN.service, account: s };
  }
  if (raw && typeof raw === 'object' && raw.account) {
    return { service: String(raw.service || DEFAULT_KEYCHAIN.service), account: String(raw.account) };
  }
  return { ...DEFAULT_KEYCHAIN };
}

function keychainError(err, stderr) {
  if (err && err.killed) return 'the Keychain read timed out (a Keychain prompt may be waiting)';
  if (err && err.code === 'ENOENT') return 'the security command was not found';
  if (err && err.code === 44) return 'the Keychain item was not found';
  const first = String(stderr || '').split('\n').map(s => s.trim()).find(Boolean);
  return first ? `security failed: ${first}` : `security failed (exit ${err && err.code})`;
}

function readKey({ env = process.env, routerCfg = {}, platform = process.platform, run = execFile, timeoutMs = KEYCHAIN_TIMEOUT_MS } = {}) {
  const fromEnv = String(env.TYPESAFE_API_KEY || '').trim();
  if (fromEnv) return Promise.resolve({ key: fromEnv, source: 'TYPESAFE_API_KEY' });
  if (platform !== 'darwin') return Promise.resolve({ key: '', source: '', error: 'TYPESAFE_API_KEY is not set (the Keychain is macOS only)' });
  const item = keychainItem(routerCfg.keychain);
  const source = `keychain ${item.service}/${item.account}`;
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    try {
      run('security', ['find-generic-password', '-s', item.service, '-a', item.account, '-w'], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) return finish({ key: '', source, error: keychainError(err, stderr) });
        const key = String(stdout || '').trim();
        finish(key ? { key, source } : { key: '', source, error: 'the Keychain item is empty' });
      });
    } catch (e) {
      finish({ key: '', source, error: keychainError(e, '') });
    }
  });
}

function uniqueProjectKeys(projects) {
  const taken = new Set([NO_PROJECT]);
  return projects.map(p => {
    const base = String(p.name || path.basename(p.path || '') || 'project');
    let key = base;
    if (taken.has(key)) key = `${base} (${path.basename(path.dirname(p.path || '')) || 'root'})`;
    let n = 2;
    while (taken.has(key)) key = `${base} ${n++}`;
    taken.add(key);
    return { ...p, key };
  });
}

function registryFor(projects, limit = PROJECT_LIMIT) {
  const list = Array.isArray(projects) ? projects.filter(p => p && p.path) : [];
  const sorted = [...list].sort((a, b) => String(b.lastCommit || '').localeCompare(String(a.lastCommit || '')));
  return uniqueProjectKeys(sorted.slice(0, limit));
}

function projectSummary(p) {
  const parts = [p.readme || '', p.aliases && p.aliases.length ? `also called ${p.aliases.join(', ')}` : ''].filter(Boolean);
  return parts.join('; ') || 'a git repository with no README';
}

function buildState({ text, context, previous, registry }) {
  return {
    message: oneLine(text, MESSAGE_MAX),
    game_context: String(context || '').slice(0, CONTEXT_MAX),
    previous: {
      route: (previous && previous.route) || 'none',
      folder: (previous && previous.folder) || '',
    },
    projects: registry.map(p => ({
      name: p.key,
      summary: projectSummary(p),
      last_activity: String(p.lastCommit || '').slice(0, 10),
    })),
  };
}

function buildQuestions(registry) {
  const questions = {
    route: {
      type: 'choice',
      instructions: 'The player typed `message` into an AI chat window inside World of Warcraft. `game_context` describes their character. `previous.route` is how their last message in this chat was handled. Which handler should answer `message`?',
      criteria: { ...ROUTES },
    },
    'lore.kind': {
      type: 'choice',
      instructions: 'Suppose `message` asks about World of Warcraft game content. What kind of game content is it about?',
      criteria: { ...LORE_KINDS },
    },
    needs_fresh: {
      type: 'noul',
      instructions: 'Does a good answer to `message` depend on information that changes over time or is newer than a stored game database: patch notes, recent changes, prices, news, or today\'s events?',
    },
    risky_edit: {
      type: 'noul',
      instructions: 'Does `message` ask to change files, run commands, commit, push, deploy, or delete something on the player\'s computer or in a repository?',
    },
  };
  if (registry.length) {
    const criteria = {};
    for (const p of registry) criteria[p.key] = projectSummary(p);
    criteria[NO_PROJECT] = 'The message is not about any of these projects, or not about code at all.';
    questions['code.project'] = {
      type: 'choice',
      instructions: 'Suppose `message` is about software. Which project in `projects` is it about? `previous.folder` is the folder this chat worked in last.',
      criteria,
    };
  }
  return questions;
}

function buildRequest(input) {
  const registry = input.registry || [];
  return { model: MODEL, state: buildState({ ...input, registry }), questions: buildQuestions(registry) };
}

function isProbabilityMap(obj, keys) {
  if (!obj || typeof obj !== 'object') return false;
  return keys.every(k => typeof obj[k] === 'number' && Number.isFinite(obj[k]));
}

function choiceAnswer(answer, options) {
  if (!answer || answer.type !== 'choice' || !options.includes(answer.choice)) return null;
  if (!isProbabilityMap(answer.probabilities, options)) return null;
  const confidence = Number(answer.confidence);
  return { choice: answer.choice, probabilities: answer.probabilities, confidence: Number.isFinite(confidence) ? confidence : null };
}

function noulAnswer(answer) {
  if (!answer || answer.type !== 'noul') return null;
  const v = Number(answer.noul);
  return Number.isFinite(v) ? v : null;
}

function round(n, digits = 3) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function roundMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = round(v);
  return out;
}

function parseResponse(body, registry = []) {
  const answers = body && typeof body === 'object' ? body.answers : null;
  if (!answers || typeof answers !== 'object') return null;
  const route = choiceAnswer(answers.route, Object.keys(ROUTES));
  if (!route) return null;
  const lore = choiceAnswer(answers['lore.kind'], Object.keys(LORE_KINDS));
  let project = null;
  if (registry.length) {
    const pick = choiceAnswer(answers['code.project'], [...registry.map(p => p.key), NO_PROJECT]);
    if (pick && pick.choice !== NO_PROJECT) {
      const p = registry.find(r => r.key === pick.choice);
      project = { name: p.key, path: p.path, probability: round(pick.probabilities[pick.choice]) };
    } else if (pick) {
      project = { name: NO_PROJECT, path: '', probability: round(pick.probabilities[NO_PROJECT]) };
    }
  }
  return {
    route: route.choice,
    probabilities: roundMap(route.probabilities),
    confidence: round(route.confidence),
    project,
    loreKind: lore ? lore.choice : null,
    needsFresh: round(noulAnswer(answers.needs_fresh)),
    riskyEdit: round(noulAnswer(answers.risky_edit)),
    model: typeof body.model === 'string' ? body.model : '',
  };
}

function fallbackResult(reason, latencyMs) {
  return { route: 'chat', fallback: reason, latencyMs, probabilities: null, confidence: null, project: null, loreKind: null, needsFresh: null, riskyEdit: null, model: '' };
}

async function classify(input, { key, fetchImpl = globalThis.fetch, url = ENDPOINT, timeoutMs = TIMEOUT_MS, now = () => Date.now() } = {}) {
  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  if (!key) return fallbackResult('no-key', 0);
  if (typeof fetchImpl !== 'function') return fallbackResult('no-fetch', 0);
  const registry = input.registry || [];
  let body;
  try { body = JSON.stringify(buildRequest(input)); } catch { return fallbackResult('bad-request', elapsed()); }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!res || !res.ok) {
      if (res && typeof res.body === 'object' && res.body && typeof res.body.cancel === 'function') { try { await res.body.cancel(); } catch {} }
      return fallbackResult(`http-${res ? res.status : 0}`, elapsed());
    }
    const json = await res.json();
    const parsed = parseResponse(json, registry);
    if (!parsed) return fallbackResult('invalid-response', elapsed());
    return { ...parsed, fallback: '', latencyMs: elapsed() };
  } catch {
    return fallbackResult(timedOut ? 'timeout' : 'network', elapsed());
  } finally {
    clearTimeout(timer);
  }
}

function decide(result, { codePermissionMode = CODE_PERMISSION_MODE } = {}) {
  if (!result || result.fallback) return { action: 'chat', route: 'chat', why: result ? result.fallback : 'no-result' };
  const confidence = typeof result.confidence === 'number' ? result.confidence : 0;
  if (confidence < THRESHOLDS.notice) return { action: 'chat', route: 'chat', why: 'low-confidence' };
  const out = { action: confidence >= THRESHOLDS.run ? 'run' : 'run-notice', route: result.route, why: '' };
  if (result.route === 'code') out.permissionMode = (result.riskyEdit || 0) >= THRESHOLDS.risky ? RISKY_PERMISSION_MODE : codePermissionMode;
  return out;
}

const CONFIG_COMMAND_RE = /^\/claude(?:-wow)?\s+config(?:\s|$)/i;

function explicitReason(job, taken = {}) {
  if (!job) return 'no-job';
  if (job.resume) return 'resume';
  if (job.liveTarget) return 'live';
  if (job.cli) return 'cli-flags';
  if (job.agent) return 'agent';
  if (job.kind) return 'kind';
  if (job.model || job.effort || job.permissionMode || (Array.isArray(job.addDirs) && job.addDirs.length)) return 'chat-settings';
  if (taken.why === 'addressed') return 'addressed';
  if (job.plugin === 'live' || (taken.why === 'bound' && taken.plugin === 'live')) return 'live';
  if (job.cwd && String(job.cwd).trim()) return 'folder';
  if (CONFIG_COMMAND_RE.test(String(job.text || '').trim())) return 'config-command';
  return '';
}

function shadowEntry({ job, text, result, decision, taken, mode, requested, at = Date.now() }) {
  const entry = {
    t: new Date(at).toISOString(),
    chat: String((job && job.chat) || ''),
    id: job && job.id,
    msg: { hash: hashText(text), head: oneLine(text, HEAD_CHARS) },
    route: result.route,
    probabilities: result.probabilities,
    confidence: result.confidence,
    project: result.project ? result.project.name : null,
    projectProbability: result.project ? result.project.probability : null,
    loreKind: result.loreKind,
    needsFresh: result.needsFresh,
    riskyEdit: result.riskyEdit,
    latencyMs: result.latencyMs,
    fallback: result.fallback || null,
    decision: decision.action,
    wouldRoute: decision.route,
    permissionMode: decision.permissionMode || null,
    taken: { plugin: (taken && taken.plugin) || '', why: (taken && taken.why) || '' },
    mode,
  };
  if (requested && requested !== mode) entry.note = `router.mode ${requested} is reserved; logged as ${mode}`;
  return entry;
}

function readLog(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return parseLog(text);
}

function parseLog(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

const CONFIDENCE_BUCKETS = [
  { label: '<0.60', test: c => c < THRESHOLDS.notice },
  { label: '0.60-0.85', test: c => c >= THRESHOLDS.notice && c < THRESHOLDS.run },
  { label: '0.85-0.95', test: c => c >= THRESHOLDS.run && c < 0.95 },
  { label: '>=0.95', test: c => c >= 0.95 },
];

function summarize(entries, { since = 0 } = {}) {
  const rows = entries.filter(e => e && (!since || Date.parse(e.t) >= since));
  const n = rows.length;
  const routes = {};
  for (const r of rows) routes[r.route] = (routes[r.route] || 0) + 1;
  const scored = rows.filter(r => !r.fallback && typeof r.confidence === 'number');
  const histogram = CONFIDENCE_BUCKETS.map(b => ({ label: b.label, count: scored.filter(r => b.test(r.confidence)).length }));
  const latencies = rows.filter(r => !r.fallback || r.fallback === 'timeout').map(r => Number(r.latencyMs)).filter(Number.isFinite).sort((a, b) => a - b);
  const fallbacks = rows.filter(r => r.fallback);
  const reasons = {};
  for (const r of fallbacks) reasons[r.fallback] = (reasons[r.fallback] || 0) + 1;
  const changed = rows.filter(r => !r.fallback && r.decision !== 'chat' && r.taken && r.taken.plugin && ROUTE_PLUGIN[r.wouldRoute] && ROUTE_PLUGIN[r.wouldRoute] !== r.taken.plugin).length;
  return {
    count: n,
    routes,
    histogram,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    fallbacks: fallbacks.length,
    fallbackRate: n ? fallbacks.length / n : 0,
    reasons,
    changed,
  };
}

function pct(part, whole) {
  return whole ? `${Math.round((part / whole) * 1000) / 10}%` : '0%';
}

function formatReport(s, { label = 'all time' } = {}) {
  if (!s.count) return `router: no routed messages (${label})`;
  const lines = [`router: ${s.count} routed message(s) (${label})`, '', 'route mix'];
  const order = Object.keys(ROUTES).filter(r => s.routes[r]).concat(Object.keys(s.routes).filter(r => !ROUTES[r]));
  for (const r of order) lines.push(`  ${r.padEnd(6)} ${String(s.routes[r]).padStart(5)}  ${pct(s.routes[r], s.count)}`);
  lines.push('', 'confidence (answered calls)');
  for (const b of s.histogram) lines.push(`  ${b.label.padEnd(10)} ${String(b.count).padStart(5)}`);
  lines.push('', `latency  p50 ${s.p50 === null ? '-' : s.p50 + ' ms'}, p95 ${s.p95 === null ? '-' : s.p95 + ' ms'}`);
  const reasons = Object.entries(s.reasons).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push(`fallback ${s.fallbacks} (${pct(s.fallbacks, s.count)})${reasons ? ': ' + reasons : ''}`);
  lines.push(`would change the path taken: ${s.changed} (${pct(s.changed, s.count)})`);
  return lines.join('\n');
}

function parseSince(raw, now = Date.now()) {
  const m = /^(\d+)\s*([hd])$/i.exec(String(raw || '').trim());
  if (!m) return 0;
  const hours = Number(m[1]) * (m[2].toLowerCase() === 'd' ? 24 : 1);
  return now - hours * 3600 * 1000;
}

function createRouter({ config = {}, env = process.env, platform = process.platform, logFile, projectsFile, log = () => {}, fetchImpl = globalThis.fetch, run = execFile, now = () => Date.now(), loadProjects } = {}) {
  const routerCfg = config && typeof config === 'object' ? config : {};
  const url = typeof routerCfg.url === 'string' && routerCfg.url ? routerCfg.url : ENDPOINT;
  const timeoutMs = Number(routerCfg.timeoutMs) > 0 ? Number(routerCfg.timeoutMs) : TIMEOUT_MS;
  const codePermissionMode = routerCfg.codePermissionMode || CODE_PERMISSION_MODE;
  const previous = new Map();
  let key = '';
  let mode = 'off';
  let requested = 'off';
  let status = 'not started';
  let registry = [];
  const pending = new Set();

  function setProjects(list) {
    registry = registryFor(list);
  }

  function readProjects() {
    if (typeof loadProjects === 'function') return setProjects(loadProjects());
    if (!projectsFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch { setProjects([]); }
  }

  async function init() {
    const pre = resolveMode(routerCfg, true);
    if (pre.mode === 'off') {
      mode = 'off'; requested = pre.requested; status = 'off (router.mode)';
      log('router: off (router.mode is "off")');
      return status;
    }
    const found = await readKey({ env, routerCfg, platform, run });
    key = found.key || '';
    const r = resolveMode(routerCfg, !!key);
    mode = r.mode; requested = r.requested;
    if (!key) {
      status = `off (no TypeSafe key: ${found.error || 'not found'})`;
      log(`router: off, no TypeSafe key (${found.source || 'TYPESAFE_API_KEY'}: ${found.error || 'not found'})`);
      return status;
    }
    readProjects();
    status = `${mode}${r.reason ? ' (' + r.reason + ')' : ''}, key from ${found.source}, ${registry.length} project(s)`;
    log(`router: ${status}; message text goes to TypeSafe`);
    return status;
  }

  function observe(job, opts = {}) {
    try { return start(job, opts); } catch (e) {
      log(`router: ${e && e.message ? e.message : e}`);
      return Promise.resolve(null);
    }
  }

  function start(job, { context = '', taken = {}, folder = '' } = {}) {
    if (mode === 'off') return Promise.resolve(null);
    const skip = explicitReason(job, taken);
    if (skip) {
      if (job) log(`#${job.id} router: skipped, explicit input (${skip})`);
      return Promise.resolve({ skipped: skip });
    }
    const text = String(job.text || '');
    const chat = String(job.chat || '');
    const prev = previous.get(chat) || {};
    const input = { text, context, previous: { route: prev.route || '', folder: folder || prev.folder || '' }, registry };
    const p = (async () => {
      const result = await classify(input, { key, fetchImpl, url, timeoutMs, now });
      const decision = decide(result, { codePermissionMode });
      previous.set(chat, { route: result.fallback ? prev.route || '' : result.route, folder: folder || prev.folder || '' });
      const entry = shadowEntry({ job, text, result, decision, taken, mode, requested, at: now() });
      if (logFile) {
        try {
          await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
          await fs.promises.appendFile(logFile, JSON.stringify(entry) + '\n');
        } catch (e) { log(`router: cannot write ${logFile} (${e.message})`); }
      }
      const conf = result.confidence === null ? '' : ` ${result.confidence}`;
      const proj = result.route === 'code' && result.project ? ` [${result.project.name}]` : '';
      log(`#${job.id} router ${mode}: ${result.fallback ? 'fallback ' + result.fallback : result.route + conf + proj} -> ${decision.action}, took ${taken.plugin || '?'} (${result.latencyMs} ms)`);
      return { entry, result, decision };
    })().catch(e => { log(`router: ${e && e.message ? e.message : e}`); return null; });
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  }

  return {
    init,
    observe,
    setProjects,
    reloadProjects: readProjects,
    settle: () => Promise.all([...pending]),
    get mode() { return mode; },
    get status() { return status; },
    get projectCount() { return registry.length; },
  };
}

function main(argv = process.argv.slice(2), out = console.log) {
  const H = require('./home');
  const home = H.resolve();
  const fileIdx = argv.indexOf('--file');
  const file = fileIdx >= 0 ? argv[fileIdx + 1] : path.join(home.dir, 'router.jsonl');
  const sinceIdx = argv.indexOf('--since');
  const sinceRaw = sinceIdx >= 0 ? argv[sinceIdx + 1] : '';
  const since = parseSince(sinceRaw);
  const s = summarize(readLog(file), { since });
  out(argv.includes('--json') ? JSON.stringify(s, null, 2) : formatReport(s, { label: since ? `last ${sinceRaw}` : 'all time' }) + `\n\nlog: ${file}`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ENDPOINT, MODEL, TIMEOUT_MS, DEFAULT_KEYCHAIN, MODES, THRESHOLDS, ROUTES, ROUTE_PLUGIN, LORE_KINDS, NO_PROJECT, PROJECT_LIMIT, HEAD_CHARS,
  hashText, resolveMode, keychainItem, readKey, registryFor, buildState, buildQuestions, buildRequest, parseResponse, classify, decide,
  explicitReason, shadowEntry, readLog, parseLog, percentile, summarize, formatReport, parseSince, createRouter, main,
};
