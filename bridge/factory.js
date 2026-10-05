'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PR = require('./procs');
const A = require('./agents');
const GM = require('./goalsmcp');

const SERVER_NAME = 'wowfactory';
const SCRIPT = 'factory-mcp';
const TOOL = Object.freeze({ dispatch: 'factory_dispatch', status: 'factory_status' });
const TOOL_NAMES = Object.freeze([TOOL.dispatch, TOOL.status]);
const SERVER_RULE = `mcp__${SERVER_NAME}`;
const fullToolName = tool => `${SERVER_RULE}__${tool}`;
const RUN_RULES = Object.freeze(TOOL_NAMES.map(fullToolName));
const DEFAULT_SKILLS = Object.freeze(['every-ai-lead', 'babysit-prs', 'babysit-pr', 'merge-train', 'implementation-engineer', 'adversarial-review', 'factory-intake', 'fresh-eyes', 'review-prs']);
const DISPATCHER_DENIED = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Skill', 'Agent', 'Task']);
const DEFAULT_MODEL = 'opus';
const DEFAULT_MAX_RUNNING = 2;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const KEEP_RUNS = 50;
const STATUS_LIST = 5;
const SKILL_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const SETTING_RE = /^[A-Za-z0-9._:\[\]-]{1,80}$/;
const RUN_ID_RE = /^[0-9a-f]{8}$/;
const ARGS_MAX = 2000;
const SUMMARY_LINES = 40;
const SUMMARY_CHARS = 4000;
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const RUN_SYSTEM = 'This run was started from an in-game World of Warcraft chat through the claude-wow bridge. Nobody watches it and nobody can answer a question: decide and go on, or stop and say what blocks you. End with a summary that names the URL of every pull request you opened or changed; a merge or run report may be as long as it needs, up to about 40 lines. The summary is shown in a game window that does not render Markdown: write plain sentences, with no bold, no backticks, no headings and no Markdown links; a list item starts with "- ".';
const OFF_TEXT = 'The connection to the claude-wow bridge closed, so the factory tools are off for the rest of this run; the call did nothing.';

function pickSetting(v, fallback) {
  return typeof v === 'string' && SETTING_RE.test(v.trim()) ? v.trim() : fallback;
}

function positive(v, fallback) {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function settings(options) {
  const f = options && options.factory && typeof options.factory === 'object' ? options.factory : null;
  if (!f || f.enabled !== true) return { enabled: false };
  const listed = Array.isArray(f.skills) ? f.skills.map(s => String(s).trim()) : [...DEFAULT_SKILLS];
  const skills = [...new Set(listed.filter(s => SKILL_RE.test(s)))];
  const raw = f.models && typeof f.models === 'object' && !Array.isArray(f.models) ? f.models : {};
  const models = {};
  for (const [skill, v] of Object.entries(raw)) {
    if (!skills.includes(skill)) continue;
    if (typeof v === 'string') models[skill] = { model: pickSetting(v, ''), effort: '' };
    else if (v && typeof v === 'object') models[skill] = { model: pickSetting(v.model, ''), effort: pickSetting(v.effort, '') };
  }
  return {
    enabled: true,
    skills,
    models,
    model: pickSetting(f.model, DEFAULT_MODEL),
    effort: pickSetting(f.effort, ''),
    permissionMode: pickSetting(f.permissionMode, ''),
    allowedTools: Array.isArray(f.allowedTools) ? f.allowedTools.map(String).filter(Boolean) : [],
    maxRunning: positive(f.maxRunning, DEFAULT_MAX_RUNNING),
    timeoutMs: positive(f.timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

function modelFor(conf, skill) {
  const own = conf.models[skill] || {};
  return { model: own.model || conf.model, effort: own.effort || conf.effort };
}

function dispatcherRules(conf) {
  return [
    'This chat is a dispatcher into the software factory, not a coding session. Never edit files, run commands or write code yourself: Edit, Write, Bash, Skill and Agent are off in this chat.',
    'For each message do exactly one of these: call factory_dispatch with one skill from the list below and its arguments; ask one short question back when you cannot tell which skill or which arguments; or answer a question about factory runs with factory_status.',
    `Skills you may dispatch: ${conf.skills.length ? conf.skills.join(', ') : '(none configured)'}.`,
    'Arguments are what the skill works on: a PR number or URL, a ticket id, or the request in plain words. Pass them as the args string and do not add anything the player did not ask for.',
    'The skill runs in the background as its own Claude Code run on its own model. After a dispatch, reply in one or two short sentences with the run id, and do not wait for it. The result comes back to this chat when the run ends, and factory_status shows it at any time.',
    `If the ${SERVER_NAME} tools are not in your tool list, say that the factory is off on this bridge because the live socket is not listening, and do nothing else.`,
  ].join('\n');
}

function toolSchemas(skills) {
  const skill = { type: 'string', description: 'The factory skill to run, exactly as listed.' };
  if (Array.isArray(skills) && skills.length) skill.enum = [...skills];
  return [
    {
      name: TOOL.dispatch,
      description: 'Start one factory skill as a background Claude Code run in this chat\'s project folder. Returns the run id at once; the run goes on after this turn ends.',
      inputSchema: {
        type: 'object',
        properties: {
          skill,
          args: { type: 'string', description: 'What the skill works on: a PR number or URL, a ticket id, or the request in plain words. Empty for none.' },
        },
        required: ['skill'],
        additionalProperties: false,
      },
    },
    {
      name: TOOL.status,
      description: 'The state of factory runs: running, done or failed, how long, the cost, the first lines of the result and any pull request URLs. Without runId: the latest runs.',
      inputSchema: {
        type: 'object',
        properties: { runId: { type: 'string', description: 'A run id from factory_dispatch.' } },
        additionalProperties: false,
      },
    },
  ];
}

function isRunToolRule(rule) {
  return String(rule || '').trim().startsWith(SERVER_RULE);
}

function launchConfig({ runId, token, socket, skills = [], runtime } = {}) {
  return GM.launchConfig({ runId, token, socket, runtime, script: SCRIPT, extraArgs: ['--skills', skills.join(',')] });
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function cleanArgs(raw) {
  return String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, ' ').trim();
}

function resultEvent(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.includes('"result"')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev && ev.type === 'result') return ev;
    } catch {}
  }
  return null;
}

function plainLine(line) {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[*+]\s+/, '- ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim();
}

function cutAtBoundary(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('. ') + 1);
  const wordEnd = head.lastIndexOf(' ');
  const end = sentenceEnd > max / 2 ? sentenceEnd : wordEnd > 0 ? wordEnd : max;
  return head.slice(0, end).trimEnd() + ' ...';
}

function summaryOf(text) {
  const lines = String(text || '').split('\n').map(plainLine).filter(Boolean).slice(0, SUMMARY_LINES);
  return cutAtBoundary(lines.join('\n'), SUMMARY_CHARS);
}

function prUrls(text) {
  return [...new Set(String(text || '').match(PR_URL_RE) || [])];
}

function describe(run, now) {
  const prompt = `/${run.skill}${run.args ? ' ' + run.args : ''}`;
  const took = duration((run.endedAt || now) - run.startedAt);
  const cost = Number.isFinite(run.costUsd) ? `, $${run.costUsd.toFixed(2)}` : '';
  const head = `${prompt.length > 80 ? prompt.slice(0, 80) + '...' : prompt}: ${run.status}${run.status === 'running' ? ` for ${took}` : ` after ${took}`}${cost}. Factory run ${run.id}, model ${run.model}.`;
  const body = [head];
  if (run.why) body.push(run.why);
  if (run.summary) body.push(run.summary);
  for (const url of run.prUrls || []) if (!run.summary || !run.summary.includes(url)) body.push(url);
  return body.join('\n');
}

function createFactory({ dir, log = () => {}, command, baseConfig, env, onDone = () => {}, now = Date.now, adopt = true, spawn = PR.spawnChild, killTree = PR.killTree } = {}) {
  const runsFile = path.join(dir, 'runs.json');
  const logsDir = path.join(dir, 'logs');
  const live = new Map();
  let runs = [];
  let stopping = false;

  function save() {
    runs = runs.slice(-KEEP_RUNS);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(runsFile, JSON.stringify({ runs }, null, 2), { mode: 0o600 });
      const kept = new Set(runs.map(r => path.basename(r.log)));
      for (const f of fs.readdirSync(logsDir)) if (!kept.has(f)) fs.rmSync(path.join(logsDir, f), { force: true });
    } catch (e) {
      if (e.code !== 'ENOENT') log(`factory: cannot save ${runsFile} (${e.message})`);
    }
  }

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
      runs = Array.isArray(data.runs) ? data.runs.filter(r => r && RUN_ID_RE.test(r.id)) : [];
    } catch { runs = []; }
    if (!adopt) return;
    let lost = 0;
    for (const r of runs) {
      if (r.status !== 'running') continue;
      r.status = 'lost';
      r.why = 'The bridge stopped while it ran, so its result is unknown. The log may still have it.';
      r.endedAt = r.endedAt || now();
      lost++;
    }
    if (lost) { log(`factory: ${lost} run(s) from before this bridge started are marked lost`); save(); }
  }

  function find(id) {
    return runs.find(r => r.id === id) || null;
  }

  function running() {
    return runs.filter(r => r.status === 'running' && live.has(r.id));
  }

  function refuse(text) {
    return { ok: false, text };
  }

  function dispatch(input, ctx) {
    const conf = ctx && ctx.conf;
    if (!conf || !conf.enabled) return refuse('The factory is off: plugins.claude-code.factory.enabled is not true in config.json.');
    if (stopping) return refuse('The bridge is stopping, so no factory run was started.');
    const skill = String((input && input.skill) || '').trim().replace(/^\//, '');
    if (!conf.skills.includes(skill)) {
      log(`factory: refused skill "${skill.slice(0, 64)}" (not in plugins.claude-code.factory.skills)`);
      return refuse(`"${skill.slice(0, 64)}" is not a factory skill this bridge may run. Allowed: ${conf.skills.join(', ') || 'none'}.`);
    }
    const args = cleanArgs(input && input.args);
    if (args.length > ARGS_MAX) return refuse(`The arguments are ${args.length} characters long; the limit is ${ARGS_MAX}.`);
    if (running().length >= conf.maxRunning) {
      return refuse(`${running().length} factory run(s) are going already, the limit set by plugins.claude-code.factory.maxRunning. Wait for one to end: ${running().map(r => r.id).join(', ')}.`);
    }
    const cwd = ctx.cwd;
    if (!cwd || !fs.existsSync(cwd)) return refuse(`The chat's folder does not exist: ${cwd || '(none)'}.`);
    const base = baseConfig();
    const cmd = command(base);
    if (!cmd.found) return refuse(`Claude Code is not installed on the bridge PC: ${cmd.note}.`);
    const picked = modelFor(conf, skill);
    const runCfg = {
      ...base,
      model: picked.model,
      effort: picked.effort,
      permissionMode: conf.permissionMode || base.permissionMode || 'acceptEdits',
      allowedTools: [...new Set([...(Array.isArray(base.allowedTools) ? base.allowedTools : []), ...conf.allowedTools])],
      addDirs: [],
    };
    const argv = [...cmd.args, ...A.AGENTS.claude.args({ cfg: runCfg, resume: '', system: RUN_SYSTEM, images: [], mcpConfig: '' })];
    let id;
    do { id = crypto.randomBytes(4).toString('hex'); } while (find(id));
    const logFile = path.join(logsDir, `${id}.log`);
    let fd;
    try {
      fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
      fd = fs.openSync(logFile, 'a', 0o600);
    } catch (e) {
      return refuse(`Could not open the run log ${logFile}: ${e.message}`);
    }
    let child;
    try {
      child = spawn(cmd.file, argv, { cwd, env: env(), windowsHide: true, stdio: ['pipe', fd, fd] });
    } catch (e) {
      fs.closeSync(fd);
      return refuse(`Could not start Claude Code (${cmd.file}): ${e.message}`);
    }
    fs.closeSync(fd);
    const run = { id, skill, args, cwd, model: picked.model, effort: picked.effort, status: 'running', startedAt: now(), endedAt: 0, pid: child.pid || 0, log: logFile, chat: String((ctx && ctx.label) || ''), costUsd: null, summary: '', prUrls: [], why: '' };
    runs.push(run);
    live.set(id, child);
    save();
    let ended = false;
    let stopReason = '';
    const timer = setTimeout(() => {
      stopReason = `It was stopped after ${duration(conf.timeoutMs)}, the limit set by plugins.claude-code.factory.timeoutMs.`;
      log(`factory: run ${id} timed out; ending it`);
      killTree(child);
    }, conf.timeoutMs);
    if (timer.unref) timer.unref();
    const end = (code, err) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      live.delete(id);
      let text = '';
      try { text = fs.readFileSync(logFile, 'utf8'); } catch {}
      const ev = resultEvent(text);
      const said = ev && typeof ev.result === 'string' ? ev.result : '';
      run.endedAt = now();
      run.costUsd = ev && Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : null;
      run.summary = summaryOf(said);
      run.prUrls = prUrls(said);
      if (stopping) { run.status = 'killed'; run.why = 'The bridge was stopped while it ran.'; }
      else if (stopReason) { run.status = 'failed'; run.why = stopReason; }
      else if (err) { run.status = 'failed'; run.why = `Claude Code did not start: ${err.message}`; }
      else if (ev && !ev.is_error) run.status = 'done';
      else { run.status = 'failed'; run.why = ev ? '' : `Claude Code exited with code ${code} and no result. See ${logFile}.`; }
      save();
      log(`factory: run ${id} /${skill} ${run.status} after ${duration(run.endedAt - run.startedAt)}${run.costUsd !== null ? `, $${run.costUsd.toFixed(2)}` : ''}`);
      if (!stopping) {
        try { onDone(run, ctx); } catch (e) { log(`factory: delivering run ${id} failed (${e.message})`); }
      }
    };
    child.on('error', err => end(null, err));
    child.on('close', code => end(code, null));
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(`/${skill}${args ? ' ' + args : ''}`);
    }
    log(`factory: run ${id} /${skill} started in ${cwd} [model ${picked.model}${picked.effort ? ', effort ' + picked.effort : ''}] for ${run.chat || 'a chat'}, log ${logFile}`);
    return { ok: true, text: `Started factory run ${id}: /${skill}${args ? ' ' + args : ''} in ${cwd} on model ${picked.model}. The result comes back to this chat when it ends; factory_status ${id} shows it before then.` };
  }

  function status(input) {
    const id = String((input && input.runId) || '').trim();
    if (id) {
      const run = RUN_ID_RE.test(id) ? find(id) : null;
      return run ? { ok: true, text: describe(run, now()) } : refuse(`There is no factory run ${id.slice(0, 20)}.`);
    }
    if (!runs.length) return { ok: true, text: 'No factory runs yet.' };
    const latest = runs.slice(-STATUS_LIST).reverse();
    return { ok: true, text: latest.map(r => describe(r, now())).join('\n\n') };
  }

  function call(tool, args, ctx) {
    if (tool === TOOL.dispatch) return dispatch(args, ctx);
    if (tool === TOOL.status) return status(args);
    return refuse(`${tool} is not a factory tool.`);
  }

  function children() {
    return [...live.values()];
  }

  function stop() {
    stopping = true;
  }

  load();
  return { dispatch, status, call, children, stop, runs: () => runs.map(r => ({ ...r })) };
}

function parseArgs(argv) {
  const opts = { socket: '', runId: '', skills: [] };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--socket') opts.socket = argv[++k] || '';
    else if (a === '--run') opts.runId = argv[++k] || '';
    else if (a === '--skills') opts.skills = String(argv[++k] || '').split(',').map(s => s.trim()).filter(s => SKILL_RE.test(s));
    else throw new Error(`unknown option ${JSON.stringify(a)}`);
  }
  return opts;
}

function spec(skills) {
  return {
    name: SERVER_NAME,
    tools: TOOL_NAMES,
    schemas: () => toolSchemas(skills),
    instructions: 'Start factory skills as background Claude Code runs and read their status. The claude-wow bridge owns the runs, and the grant ends when this chat run ends.',
    label: 'factory',
    offText: OFF_TEXT,
  };
}

function main(argv, deps = {}) {
  const stdin = deps.stdin || process.stdin;
  const stdout = deps.stdout || process.stdout;
  const env = deps.env || process.env;
  const log = deps.log || (line => process.stderr.write(`[claude-wow factory-mcp] ${line}\n`));
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(e.message); process.exitCode = 2; return null; }
  const token = String(env[GM.TOKEN_ENV] || '');
  const server = GM.createServer({ stdout, socket: opts.socket, runId: opts.runId, token, log, spec: spec(opts.skills) });
  server.connect();
  stdin.on('data', server.feed);
  stdin.on('end', () => { server.stop(); if (!deps.stdin) process.exit(0); });
  return server;
}

module.exports = {
  SERVER_NAME, SCRIPT, TOOL, TOOL_NAMES, SERVER_RULE, RUN_RULES, DEFAULT_SKILLS, DISPATCHER_DENIED, DEFAULT_MODEL, DEFAULT_MAX_RUNNING, DEFAULT_TIMEOUT_MS, RUN_SYSTEM, KEEP_RUNS,
  fullToolName, settings, modelFor, dispatcherRules, toolSchemas, isRunToolRule, launchConfig, duration, resultEvent, summaryOf, prUrls, describe, createFactory, parseArgs, spec, main,
};

if (require.main === module) main(process.argv.slice(2));
