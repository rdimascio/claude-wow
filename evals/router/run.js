'use strict';

const fs = require('fs');
const path = require('path');
const RT = require('../../bridge/router');
const S = require('./score');

const HERE = __dirname;
const DEFAULT_CASES = path.join(HERE, 'cases.jsonl');
const DEFAULT_PROJECTS = path.join(HERE, 'projects.json');
const DEFAULT_OUT = path.join(HERE, 'results');
const DEFAULT_CONCURRENCY = 4;
const EVAL_TIMEOUT_MS = 10000;
const RETRY_STATUSES = new Set(['http-429', 'http-529']);
const MAX_ATTEMPTS = 6;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30000;
const EXIT_NO_KEY = 2;
const EXIT_BAD_INPUT = 3;
const REQUIRED_KEYS = ['id', 'text', 'expected', 'why', 'difficulty'];
const SECRET_PATTERNS = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\b(?:sk|pk|ts|ghp|gho|xox[abp])[-_][A-Za-z0-9-_]{12,}/i,
  /\b[A-Fa-f0-9]{32,}\b/,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\/Users\/[A-Za-z0-9._-]+/,
];

function parseJsonl(text) {
  const out = [];
  String(text || '').split('\n').forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try { out.push(JSON.parse(s)); } catch (e) { throw new Error(`cases line ${i + 1}: ${e.message}`); }
  });
  return out;
}

function loadRegistry(file = DEFAULT_PROJECTS) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = (Array.isArray(data.projects) ? data.projects : []).map(p => ({
    name: p.name,
    path: `eval:${p.name}`,
    remote: '',
    lastCommit: p.lastCommit || '',
    readme: p.readme || '',
    aliases: Array.isArray(p.aliases) ? p.aliases : [],
  }));
  return RT.registryFor(list);
}

function validateCases(cases, registry) {
  const errors = [];
  const names = new Set([...registry.map(p => p.key), RT.NO_PROJECT]);
  const ids = new Set();
  for (const c of cases) {
    const where = c && c.id ? c.id : JSON.stringify(c).slice(0, 40);
    for (const k of REQUIRED_KEYS) if (c[k] === undefined || c[k] === '') errors.push(`${where}: missing ${k}`);
    if (ids.has(c.id)) errors.push(`${where}: duplicate id`);
    ids.add(c.id);
    const e = c.expected || {};
    if (!S.ROUTE_NAMES.includes(e.route)) errors.push(`${where}: unknown route ${e.route}`);
    if (!names.has(e.project)) errors.push(`${where}: project ${e.project} is not in the registry`);
    for (const p of c.also_ok_projects || []) if (!names.has(p)) errors.push(`${where}: also_ok project ${p} is not in the registry`);
    if (typeof e.needs_fresh !== 'boolean') errors.push(`${where}: needs_fresh must be a boolean`);
    if (typeof e.risky_edit !== 'boolean') errors.push(`${where}: risky_edit must be a boolean`);
    if (e.route === 'lore' && !S.LORE_KIND_NAMES.includes(e.lore_kind)) errors.push(`${where}: lore case needs a lore_kind`);
    if (e.route !== 'lore' && e.lore_kind !== undefined) errors.push(`${where}: lore_kind only on lore cases`);
    if (!S.DIFFICULTIES.includes(c.difficulty)) errors.push(`${where}: difficulty ${c.difficulty}`);
    const blob = `${c.text}\n${c.context || ''}\n${c.previous ? c.previous.folder : ''}`;
    for (const re of SECRET_PATTERNS) if (re.test(blob)) errors.push(`${where}: looks like a secret, email or private path (${re})`);
  }
  return errors;
}

function loadCases(file = DEFAULT_CASES) {
  return parseJsonl(fs.readFileSync(file, 'utf8'));
}

function recordingFetch(base, sink) {
  return async (url, init) => {
    const res = await base(url, init);
    sink.status = res ? res.status : 0;
    const headers = res && res.headers;
    sink.retryAfter = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
    if (!res || !res.ok) return res;
    const json = await res.json();
    sink.usage = json && json.usage ? json.usage : null;
    sink.model = json && typeof json.model === 'string' ? json.model : '';
    return { ok: true, status: res.status, headers, json: async () => json };
  };
}

function retryDelay(attempt, retryAfter) {
  const seconds = retryAfter === null || retryAfter === undefined || String(retryAfter).trim() === '' ? NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(BACKOFF_MAX_MS, seconds * 1000);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function classifyWithRetry(input, { key, fetchImpl = globalThis.fetch, url, timeoutMs = EVAL_TIMEOUT_MS, sleep = realSleep, maxAttempts = MAX_ATTEMPTS, now } = {}) {
  const usage = [];
  let result;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts++;
    const sink = {};
    const opts = { key, fetchImpl: recordingFetch(fetchImpl, sink), timeoutMs };
    if (url) opts.url = url;
    if (now) opts.now = now;
    result = await RT.classify(input, opts);
    if (sink.usage) usage.push({ ...sink.usage, model: sink.model || result.model || '' });
    if (!RETRY_STATUSES.has(result.fallback) || attempts >= maxAttempts) break;
    await sleep(retryDelay(attempts, sink.retryAfter));
  }
  return { result, attempts, usage };
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}

function inputFor(c, registry) {
  const prev = c.previous || {};
  return { text: c.text, context: c.context || '', previous: { route: prev.route || '', folder: prev.folder || '' }, registry };
}

async function runCases(cases, { registry, classify, concurrency = DEFAULT_CONCURRENCY, onProgress = () => {} } = {}) {
  let done = 0;
  return pool(cases, concurrency, async c => {
    const out = await classify(inputFor(c, registry), c);
    done++;
    onProgress(done, cases.length, c, out.result);
    return { case: c, result: out.result, attempts: out.attempts || 1, usage: out.usage || [] };
  });
}

function parseArgs(argv) {
  const args = { cases: DEFAULT_CASES, projects: DEFAULT_PROJECTS, out: DEFAULT_OUT, concurrency: DEFAULT_CONCURRENCY, timeoutMs: EVAL_TIMEOUT_MS, limit: 0, only: [], keychain: '', quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--cases') args.cases = path.resolve(v());
    else if (a === '--projects') args.projects = path.resolve(v());
    else if (a === '--out') args.out = path.resolve(v());
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(v()) || DEFAULT_CONCURRENCY);
    else if (a === '--timeout') args.timeoutMs = Math.max(1, Number(v()) || EVAL_TIMEOUT_MS);
    else if (a === '--limit') args.limit = Math.max(0, Number(v()) || 0);
    else if (a === '--only') args.only.push(...String(v()).split(',').filter(Boolean));
    else if (a === '--keychain') args.keychain = v();
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--validate') args.validateOnly = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function bridgeKeychainSetting() {
  try {
    const H = require('../../bridge/home');
    const cfg = JSON.parse(fs.readFileSync(H.resolve().config, 'utf8'));
    return cfg && cfg.router && cfg.router.keychain ? cfg.router.keychain : '';
  } catch { return ''; }
}

async function resolveKey({ env = process.env, keychain = '', readKey = RT.readKey } = {}) {
  const routerCfg = {};
  const setting = keychain || bridgeKeychainSetting();
  if (setting) routerCfg.keychain = setting;
  return readKey({ env, routerCfg });
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

const HELP = `usage: npm run eval:router -- [--concurrency 4] [--timeout 10000] [--limit N] [--only r001,r002] [--keychain service/account] [--cases file] [--projects file] [--out dir] [--validate]`;

async function main(argv = process.argv.slice(2), { out = console.log, err = console.error, env = process.env, fetchImpl = globalThis.fetch, readKey = RT.readKey } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { err(e.message); err(HELP); return EXIT_BAD_INPUT; }
  if (args.help) { out(HELP); return 0; }
  const registry = loadRegistry(args.projects);
  let cases = loadCases(args.cases);
  const errors = validateCases(cases, registry);
  if (errors.length) { for (const e of errors) err(`invalid case: ${e}`); return EXIT_BAD_INPUT; }
  if (args.validateOnly) { out(`${cases.length} case(s) valid against ${registry.length} project(s)`); return 0; }
  if (args.only.length) cases = cases.filter(c => args.only.includes(c.id));
  if (args.limit) cases = cases.slice(0, args.limit);

  const found = await resolveKey({ env, keychain: args.keychain, readKey });
  if (!found.key) {
    err(`eval:router: no TypeSafe key, so no calls were made. Set TYPESAFE_API_KEY or pass --keychain service/account (${found.source || 'TYPESAFE_API_KEY'}: ${found.error || 'not found'}).`);
    return EXIT_NO_KEY;
  }
  out(`eval:router: ${cases.length} case(s), ${registry.length} project(s), key from ${found.source}, concurrency ${args.concurrency}, timeout ${args.timeoutMs} ms`);

  const startedAt = new Date();
  const rows = await runCases(cases, {
    registry,
    concurrency: args.concurrency,
    classify: input => classifyWithRetry(input, { key: found.key, fetchImpl, timeoutMs: args.timeoutMs }),
    onProgress: (done, total, c, r) => {
      if (!args.quiet) out(`  ${String(done).padStart(3)}/${total} ${c.id} ${r.fallback ? 'fallback ' + r.fallback : r.route + ' ' + r.confidence}${r.route === c.expected.route ? '' : '  (expected ' + c.expected.route + ')'}`);
    },
  });
  const model = [...new Set(rows.map(r => r.result.model).filter(Boolean))].join(', ');
  const meta = { startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), model, timeoutMs: args.timeoutMs, productionTimeoutMs: RT.TIMEOUT_MS, concurrency: args.concurrency, cases: path.relative(process.cwd(), args.cases), registry: registry.map(p => p.key) };
  const report = S.score(rows, meta);
  if (args.timeoutMs > RT.TIMEOUT_MS) {
    const prod = S.score(S.applyTimeout(rows, RT.TIMEOUT_MS), meta);
    report.production = { timeoutMs: RT.TIMEOUT_MS, routeAccuracy: prod.route.accuracy, fallback: prod.fallback, thresholds: prod.thresholds.overall };
  }
  report.rows = rows.map(r => ({ id: r.case.id, attempts: r.attempts, usage: r.usage, result: r.result }));
  fs.mkdirSync(args.out, { recursive: true });
  const base = path.join(args.out, stamp(startedAt));
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n');
  const md = S.toMarkdown(report);
  fs.writeFileSync(`${base}.md`, md);
  out('');
  out(md.split('\n## Route accuracy by difficulty')[0].trim());
  out(`\nwrote ${base}.json\nwrote ${base}.md`);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
}

module.exports = {
  DEFAULT_CASES, DEFAULT_PROJECTS, EVAL_TIMEOUT_MS, MAX_ATTEMPTS, EXIT_NO_KEY, EXIT_BAD_INPUT, SECRET_PATTERNS,
  parseJsonl, loadRegistry, validateCases, loadCases, recordingFetch, retryDelay, classifyWithRetry, pool, inputFor, runCases, parseArgs, resolveKey, main,
};
