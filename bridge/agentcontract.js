'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const A = require('./agents');
const MC = require('./mcpconfig');
const R = require('./runtime');
const PR = require('./procs');

const FILE_NAME = 'agent-contract.json';
const PASS = 'pass';
const FAIL = 'fail';
const UNCHECKED = 'unchecked';

const ROWS = {
  claude: {
    C1: 'tool prefix is the server name with every character outside A-Z a-z 0-9 _ - replaced by _',
    C2: '--disallowedTools mcp__<prefix> removes every tool of a --mcp-config server, even an allowed one',
    C2u: 'the same for user, plugin and claude.ai servers (not probed: it needs your own servers)',
    C3: '${VAR} in --mcp-config env and args is expanded',
    C4: 'system/init mcp_servers entries have name, status and source',
  },
  codex: {
    X1: 'exec runs an MCP call when the server sets default_tools_approval_mode="approve"',
    X2a: '-c mcp_servers.<name>.enabled=false turns off a server from config.toml or an earlier -c',
    X2b: 'env_vars reaches the server and shell_environment_policy.exclude hides it from the shell',
  },
};
const OFF_ROWS = { claude: ['C1', 'C2'], codex: ['X2a'] };
const OFF_SOURCES = { claude: ['config', 'claude', 'claude.ai', 'plugin'], codex: ['codex'] };
const SECRET_ROWS = { codex: ['X2b'] };
const GATING_ROWS = { claude: OFF_ROWS.claude, codex: [...OFF_ROWS.codex, ...SECRET_ROWS.codex] };
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex' };

const CLAUDE_MODEL = 'haiku';
const CLAUDE_BUDGET_USD = 0.05;
const CODEX_MODEL = 'gpt-6-luna';
const PROBE_SERVER = 'a.b c';
const PROBE_PREFIX = 'a_b_c';
const CODEX_SERVER = 'contract';
const CODEX_OFF_SERVER = 'contract_off';
const ECHO_ENV = 'CONTRACT_MCP_ECHO';
const TOOL_ENV = 'CONTRACT_MCP_TOOL';
const ARG_ENV = 'CONTRACT_PROBE_ARG';
const VALUE_ENV = 'CONTRACT_PROBE_ENV';
const RUN_TIMEOUT_MS = 120000;
const VERSION_TIMEOUT_MS = 10000;
const STDOUT_MAX = 1024 * 1024;
const VERSION_RE = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const nonce = tag => `${tag}_${crypto.randomBytes(5).toString('hex')}`;
const agentName = id => AGENT_NAMES[id] || id;

function parseVersion(text) {
  const m = VERSION_RE.exec(String(text || ''));
  return m ? m[0] : '';
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function which(name, { env = process.env, platform = process.platform, exists = isFile } = {}) {
  const file = String(name || '');
  if (!file) return '';
  if (path.isAbsolute(file)) return exists(file) ? file : '';
  if (file.includes('/') || file.includes('\\')) return exists(path.resolve(file)) ? path.resolve(file) : '';
  const exts = platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  for (const dir of String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean))
    for (const ext of exts) {
      const f = path.join(dir, file + ext);
      if (exists(f)) return f;
    }
  return '';
}

function binaryOf(cmd, opts) {
  if (!cmd || !cmd.found) return '';
  const args = Array.isArray(cmd.args) ? cmd.args : [];
  return which(args.length ? args[0] : cmd.file, opts);
}

function readVersion(cmd, { env = process.env, spawn = PR.spawnChild, onChild = () => {}, timeoutMs = VERSION_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let out = '';
    let child;
    try {
      child = spawn(cmd.file, [...(cmd.args || []), '--version'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve('');
      return;
    }
    onChild(child);
    const timer = setTimeout(() => PR.killTree(child, { graceMs: 0 }), timeoutMs);
    const take = d => {
      if (out.length < 4000) out += String(d);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', () => {});
    child.on('close', () => {
      clearTimeout(timer);
      resolve(parseVersion(out));
    });
  });
}

function readContract(file, readText = f => fs.readFileSync(f, 'utf8')) {
  try {
    const json = JSON.parse(readText(file));
    return isObject(json) ? json : {};
  } catch {
    return {};
  }
}

const IDENTITY_KEYS = ['mtimeMs', 'ctimeMs', 'ino', 'size'];

function identityOf(realpath, st) {
  const id = { realpath };
  for (const k of IDENTITY_KEYS) id[k] = Number(st && st[k]);
  return id;
}

function readIdentity(bin, { realpath = p => fs.realpathSync.native(p), stat = p => fs.statSync(p) } = {}) {
  try {
    const real = realpath(bin);
    return identityOf(real, stat(real));
  } catch {
    return null;
  }
}

function sameIdentity(entry, id) {
  return (
    isObject(entry) &&
    isObject(id) &&
    typeof entry.realpath === 'string' &&
    entry.realpath === id.realpath &&
    IDENTITY_KEYS.every(k => Number.isFinite(entry[k]) && entry[k] === id[k])
  );
}

const measured = (agentId, rows) => (GATING_ROWS[agentId] || []).every(r => rows[r] === PASS || rows[r] === FAIL);

function evaluate(agentId, base, entry, version) {
  const matched =
    isObject(entry) &&
    isObject(entry.rows) &&
    typeof entry.version === 'string' &&
    entry.version !== '' &&
    sameIdentity(entry, base.identity) &&
    (version === undefined || version === entry.version);
  const rows = matched ? { ...entry.rows } : {};
  return {
    agent: agentId,
    path: base.path,
    realpath: base.identity.realpath,
    version: version || (matched ? entry.version : ''),
    matched,
    checked: matched && measured(agentId, rows),
    rows,
  };
}

function createTracker({
  file,
  log = () => {},
  realpath = p => fs.realpathSync.native(p),
  stat = p => fs.statSync(p),
  version = readVersion,
  readText,
  which: whichOpts,
} = {}) {
  const versions = new Map();
  const bases = {};
  const kids = new Set();
  const said = new Set();
  function evaluateAgent(agentId, all) {
    const base = bases[agentId];
    const s = evaluate(agentId, base, all[agentId], versions.get(base.key));
    if (!s.checked && !said.has(base.key)) {
      said.add(base.key);
      log(
        `contract: ${agentName(agentId)} at ${base.identity.realpath} is not checked against the MCP behaviors the bridge relies on; run claude-wow agents check. Only a measured fail turns anything off.`,
      );
    }
    return s;
  }
  function status(agentId, cmd, env) {
    if (!ROWS[agentId]) return null;
    const bin = binaryOf(cmd, whichOpts);
    if (!bin) return null;
    const identity = readIdentity(bin, { realpath, stat });
    if (!identity) return null;
    const key = [agentId, identity.realpath, ...IDENTITY_KEYS.map(k => identity[k])].join('\n');
    bases[agentId] = { path: bin, identity, key };
    if (!versions.has(key)) {
      versions.set(key, undefined);
      const onChild = child => {
        kids.add(child);
        child.once('close', () => kids.delete(child));
      };
      Promise.resolve(version(cmd, { env, onChild })).then(
        v => versions.set(key, v || ''),
        () => versions.set(key, ''),
      );
    }
    return evaluateAgent(agentId, readContract(file, readText));
  }
  function current() {
    const all = readContract(file, readText);
    return Object.fromEntries(Object.keys(bases).map(id => [id, evaluateAgent(id, all)]));
  }
  return { status, current, children: () => [...kids] };
}

function failedRows(s, rows) {
  if (!s || !s.matched) return [];
  return (rows || []).filter(r => s.rows[r] === FAIL);
}

function offReason(s) {
  const failed = failedRows(s, OFF_ROWS[s && s.agent]);
  if (!failed.length) return '';
  const name = agentName(s.agent);
  return `${name} ${s.version} failed ${failed.join(' and ')} in claude-wow agents check, so it may still load an MCP server a chat turns off. The bridge does not run a chat that turns a server off: use /claude mcp default, or update ${name} and run claude-wow agents check again.`;
}

function secretReason(s) {
  const failed = failedRows(s, SECRET_ROWS[s && s.agent]);
  if (!failed.length) return '';
  const name = agentName(s.agent);
  return `${name} ${s.version} failed ${failed.join(' and ')} in claude-wow agents check, so its shell may see an MCP server's secret. The bridge does not run a ${name} chat with a server that takes a secret: turn that server off for this chat, or update ${name} and run claude-wow agents check again.`;
}

function refusal(s, { off = false, secrets = false } = {}) {
  return (off && offReason(s)) || (secrets && secretReason(s)) || '';
}

function slotField(statuses, { codexConfig = false } = {}) {
  const out = {};
  for (const [id, s] of Object.entries(statuses || {})) {
    if (!s || !ROWS[id]) continue;
    const reason = offReason(s);
    const sources = id === 'codex' && codexConfig ? [...OFF_SOURCES.codex, 'config'] : OFF_SOURCES[id];
    out[id] = { version: s.version || '', checked: !!s.checked, off: !reason, reason, sources };
  }
  return out;
}

function lineEvents(onEvent) {
  let buffer = '';
  return chunk => {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (isObject(ev)) onEvent(ev);
      } catch {}
    }
  };
}

function spawnRun(file, args, { input = '', env, cwd, timeoutMs = RUN_TIMEOUT_MS, stopWhen = () => false, onChild = () => {} } = {}) {
  return new Promise(resolve => {
    const events = [];
    let stdout = '';
    let stderr = '';
    let stopped = false;
    let timedOut = false;
    let child;
    try {
      child = PR.spawnChild(file, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ events, stdout, code: null, stopped, timedOut, stderr: e.message });
      return;
    }
    onChild(child);
    const stop = () => PR.killTree(child, { graceMs: 2000 });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.on('error', e => {
      stderr += e.message;
    });
    const feed = lineEvents(ev => {
      events.push(ev);
      if (!stopped && stopWhen(ev)) {
        stopped = true;
        stop();
      }
    });
    child.stdout.on('data', d => {
      if (stdout.length < STDOUT_MAX) stdout += String(d);
      feed(d);
    });
    child.stderr.on('data', d => {
      if (stderr.length < 4000) stderr += String(d);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ events, stdout, code, stopped, timedOut, stderr });
    });
  });
}

function fixtureCommand(runtime) {
  const [command, args] = R.scriptCommand('contract-mcp', [], runtime);
  return { command, args };
}

function writePrivate(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
}

const initOf = events => events.find(e => e.type === 'system' && e.subtype === 'init') || null;
const toolsOf = init => (init && Array.isArray(init.tools) ? init.tools.filter(t => typeof t === 'string') : []);
const serverOf = (init, name) => (init && Array.isArray(init.mcp_servers) ? init.mcp_servers.find(s => isObject(s) && s.name === name) || null : null);

function judgeClaude(first, second, nonces) {
  const rows = Object.fromEntries(Object.keys(ROWS.claude).map(r => [r, UNCHECKED]));
  const notes = [];
  const init = initOf(first.events);
  if (!init) {
    notes.push(
      `the first run printed no system/init event${first.timedOut ? ' before the time limit' : ''}${first.stderr ? `: ${first.stderr.trim().slice(0, 300)}` : ''}`,
    );
    return { rows, notes };
  }
  const entry = serverOf(init, PROBE_SERVER);
  rows.C4 = entry && typeof entry.status === 'string' && typeof entry.source === 'string' ? PASS : FAIL;
  if (rows.C4 === FAIL)
    notes.push(`init mcp_servers has no entry {name, status, source} for "${PROBE_SERVER}": ${JSON.stringify(init.mcp_servers || null).slice(0, 300)}`);
  const tools = toolsOf(init);
  const alpha = tools.find(t => /^mcp__.+__alpha$/.test(t));
  if (!alpha) {
    notes.push(`the fixture server's tools are not in init (its status: ${entry ? entry.status : 'not listed'})`);
    return { rows, notes };
  }
  const prefix = alpha.slice('mcp__'.length, -'__alpha'.length);
  rows.C1 = prefix === PROBE_PREFIX && tools.includes(`mcp__${PROBE_PREFIX}__beta`) ? PASS : FAIL;
  if (rows.C1 === FAIL) notes.push(`"${PROBE_SERVER}" got the tool prefix mcp__${prefix}__, not mcp__${PROBE_PREFIX}__`);
  rows.C3 = tools.includes(`mcp__${prefix}__${nonces.env}`) && tools.includes(`mcp__${prefix}__${nonces.arg}`) ? PASS : FAIL;
  if (rows.C3 === FAIL) notes.push('a ${VAR} in the server env or args reached the server unexpanded');
  const init2 = second ? initOf(second.events) : null;
  if (!init2) {
    notes.push('the second run (with the deny rule) printed no system/init event');
    return { rows, notes };
  }
  const leaked = toolsOf(init2).filter(t => t.startsWith(`mcp__${prefix}__`));
  const entry2 = serverOf(init2, PROBE_SERVER);
  if (leaked.length) {
    rows.C2 = FAIL;
    notes.push(`with --disallowedTools mcp__${prefix} these tools stayed: ${leaked.join(', ')}`);
  } else if (entry2 && entry2.status === 'connected') rows.C2 = PASS;
  else notes.push(`the fixture server was ${entry2 ? entry2.status : 'not listed'} in the second run, so its missing tools prove nothing`);
  return { rows, notes, prefix };
}

async function probeClaude({ cmd, run = spawnRun, fixture = fixtureCommand(), env = process.env, dir, model = CLAUDE_MODEL } = {}) {
  const nonces = { arg: nonce('arg'), env: nonce('env') };
  const config = path.join(dir, 'claude-mcp.json');
  writePrivate(
    config,
    JSON.stringify({
      mcpServers: {
        [PROBE_SERVER]: {
          type: 'stdio',
          command: fixture.command,
          args: [...fixture.args, 'alpha', 'beta', '${' + ARG_ENV + '}'],
          env: { [TOOL_ENV]: '${' + VALUE_ENV + '}' },
        },
      },
    }),
  );
  const base = [
    ...(cmd.args || []),
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    config,
    '--model',
    model,
    '--max-budget-usd',
    String(CLAUDE_BUDGET_USD),
    '--allowedTools',
    `mcp__${PROBE_PREFIX}__alpha`,
  ];
  const runEnv = A.AGENTS.claude.env({ ...env, [ARG_ENV]: nonces.arg, [VALUE_ENV]: nonces.env });
  const opts = { input: 'Reply with the single word ok.', env: runEnv, cwd: dir, stopWhen: ev => ev.type === 'system' && ev.subtype === 'init' };
  const first = await run(cmd.file, base, opts);
  const prefix = (toolsOf(initOf(first.events)).find(t => /^mcp__.+__alpha$/.test(t)) || `mcp__${PROBE_PREFIX}__alpha`).slice(
    'mcp__'.length,
    -'__alpha'.length,
  );
  const second = initOf(first.events) ? await run(cmd.file, [...base, '--disallowedTools', `mcp__${prefix}`], opts) : null;
  const judged = judgeClaude(first, second, nonces);
  const results = [first, second].filter(Boolean).flatMap(r => r.events.filter(e => e.type === 'result'));
  const usd = results.reduce((sum, e) => sum + (Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : 0), 0);
  const cost = results.length ? `$${usd.toFixed(4)} reported by Claude Code` : 'none reported: both runs stop at the init event, before the model answers';
  return { rows: judged.rows, notes: judged.notes, cost };
}

function codexItems(events) {
  return events.filter(e => e.type === 'item.completed' && isObject(e.item)).map(e => e.item);
}

function judgeCodexCall(result, secret) {
  const rows = { X1: UNCHECKED, X2b: UNCHECKED };
  const notes = [];
  const items = codexItems(result.events);
  const call = items.find(i => i.type === 'mcp_tool_call' && i.server === CODEX_SERVER);
  const callText = call ? JSON.stringify(call.result === undefined ? null : call.result) : '';
  if (!call) notes.push(`Codex made no call to the ${CODEX_SERVER} server${result.timedOut ? ' before the time limit' : ''}, so X1 is not known`);
  else if (call.status === 'completed' && !call.error && callText.includes('echo=')) rows.X1 = PASS;
  else {
    rows.X1 = FAIL;
    notes.push(`the MCP call did not complete: ${JSON.stringify(call.error || call.status || null).slice(0, 300)}`);
  }
  const shells = items.filter(i => i.type === 'command_execution' && String(i.command || '').includes(ECHO_ENV));
  const finished = shells.filter(i => typeof i.exit_code === 'number' && i.status !== 'declined');
  if (shells.some(i => String(i.aggregated_output || '').includes(secret))) {
    rows.X2b = FAIL;
    notes.push(`the shell printed ${ECHO_ENV} although shell_environment_policy.exclude names it`);
  } else if (rows.X1 === PASS && !callText.includes(secret)) {
    rows.X2b = FAIL;
    notes.push(`env_vars did not pass ${ECHO_ENV} to the server`);
  } else if (rows.X1 === PASS && finished.length) rows.X2b = PASS;
  else notes.push('X2b needs both the MCP call and a finished shell command that reads the secret');
  if (items.some(i => i.type === 'mcp_tool_call' && i.server === CODEX_OFF_SERVER))
    notes.push(`Codex called the ${CODEX_OFF_SERVER} server, which enabled=false turned off`);
  return { rows, notes };
}

function judgeCodexList(result, own) {
  let list = null;
  try {
    list = JSON.parse(result.stdout || '');
  } catch {}
  if (!Array.isArray(list))
    return { X2a: UNCHECKED, notes: [`codex mcp list --json printed no list${result.stderr ? `: ${result.stderr.trim().slice(0, 300)}` : ''}`] };
  const enabled = name => {
    const e = list.find(s => isObject(s) && s.name === name);
    return e ? e.enabled : undefined;
  };
  if (enabled(CODEX_SERVER) !== true)
    return { X2a: UNCHECKED, notes: [`the ${CODEX_SERVER} server defined with -c is not listed as enabled, so X2a has nothing to compare with`] };
  const stayed = [CODEX_OFF_SERVER, ...own].filter(n => enabled(n) !== false);
  if (stayed.length) return { X2a: FAIL, notes: [`enabled=false did not turn off: ${stayed.join(', ')}`] };
  return { X2a: PASS, notes: [] };
}

async function probeCodex({
  cmd,
  run = spawnRun,
  fixture = fixtureCommand(),
  env = process.env,
  dir,
  model = CODEX_MODEL,
  own = MC.codexOwnServers().filter(n => /^[A-Za-z0-9_-]{1,64}$/.test(n)),
} = {}) {
  const secret = nonce('secret');
  const server = { type: 'stdio', command: fixture.command, args: [...fixture.args, 'ping'] };
  const defined = MC.codexArgs([
    { name: CODEX_SERVER, server, envVars: [ECHO_ENV], bearerTokenEnvVar: '', enabledTools: null },
    { name: CODEX_OFF_SERVER, server, envVars: [], bearerTokenEnvVar: '', enabledTools: null },
  ]);
  const off = MC.codexArgs([CODEX_OFF_SERVER, ...own].map(name => ({ name, off: true })));
  const listed = await run(cmd.file, [...(cmd.args || []), ...defined, ...off, 'mcp', 'list', '--json'], { env, cwd: dir, timeoutMs: VERSION_TIMEOUT_MS * 3 });
  const list = judgeCodexList(listed, own);
  const args = [
    ...(cmd.args || []),
    ...defined,
    ...off,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    dir,
    '--sandbox',
    'read-only',
    '-m',
    model,
    '-c',
    'model_reasoning_effort=low',
    '-',
  ];
  const prompt = `This is an automated check. Call the MCP tool mcp__${CODEX_SERVER}__ping (server ${CODEX_SERVER}, tool ping) once. Then run this shell command exactly once: printenv ${ECHO_ENV}. Then reply with the single word done.`;
  const result = await run(cmd.file, args, { input: prompt, env: { ...env, [ECHO_ENV]: secret }, cwd: dir });
  const call = judgeCodexCall(result, secret);
  const usage = result.events.filter(e => e.type === 'turn.completed' && isObject(e.usage)).map(e => e.usage);
  const sum = k => usage.reduce((n, u) => n + (Number(u[k]) || 0), 0);
  const cost = usage.length
    ? `${sum('input_tokens')} input tokens (${sum('cached_input_tokens')} cached), ${sum('output_tokens')} output tokens on ${model}; Codex reports no price`
    : 'no usage reported';
  const offCalled = codexItems(result.events).some(i => i.type === 'mcp_tool_call' && i.server === CODEX_OFF_SERVER);
  return { rows: { X1: call.rows.X1, X2a: offCalled ? FAIL : list.X2a, X2b: call.rows.X2b }, notes: [...list.notes, ...call.notes], cost };
}

const PROBES = { claude: probeClaude, codex: probeCodex };

function writeContract(file, id, entry, readText) {
  const all = readContract(file, readText);
  all[id] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const USAGE = 'claude-wow agents check [--agent claude|codex]   probe the MCP behaviors the bridge relies on, with one short run per check';
const EXIT = { ok: 0, failed: 1, usage: 2, unchecked: 3, interrupted: 130 };

function parseCheckArgs(argv) {
  if (argv[0] !== 'check') return { code: argv[0] === '--help' || argv[0] === '-h' ? EXIT.ok : EXIT.usage };
  let only = '';
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--help' || a === '-h') return { code: EXIT.ok };
    if (a !== '--agent') return { code: EXIT.usage, error: `unknown option "${a}"` };
    const v = argv[++k];
    if (!ROWS[v]) return { code: EXIT.usage, error: `--agent needs one of ${Object.keys(ROWS).join(', ')}${v === undefined ? '' : `, not "${v}"`}` };
    only = v;
  }
  return { only };
}

function mergeRows(prior, identity, version, rows) {
  const merged = { ...rows };
  const kept = [];
  if (isObject(prior) && isObject(prior.rows) && prior.version === version && sameIdentity(prior, identity))
    for (const [row, v] of Object.entries(prior.rows))
      if (v === FAIL && merged[row] === UNCHECKED) {
        merged[row] = FAIL;
        kept.push(row);
      }
  return { rows: merged, kept };
}

async function check(argv = [], deps = {}) {
  const out = deps.out || (line => console.log(line));
  const args = parseCheckArgs(argv);
  if (args.code !== undefined) {
    if (args.error) out(args.error);
    out(USAGE);
    return args.code;
  }
  const env = deps.env || process.env;
  const home = deps.home || require('./home').resolve(env);
  const file = path.join(home.dir, FILE_NAME);
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(home.config, 'utf8'));
  } catch {}
  const resolve = deps.resolveCommand || A.resolveCommand;
  const version = deps.version || readVersion;
  const idOpts = { realpath: deps.realpath, stat: deps.stat };
  const probes = deps.probes || PROBES;
  const now = deps.now || (() => Date.now());
  const signals = deps.signals || process;
  const kids = new Set();
  const track = child => {
    kids.add(child);
    child.once('close', () => kids.delete(child));
  };
  const baseRun = deps.run || spawnRun;
  const run = (file2, args2, opts = {}) => baseRun(file2, args2, { ...opts, onChild: track });
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    PR.killAll([...kids], { graceMs: 2000 }, () => {});
  };
  signals.on('SIGINT', stop);
  signals.on('SIGTERM', stop);
  let failed = false;
  let unchecked = false;
  let wrote = false;
  try {
    for (const id of args.only ? [args.only] : Object.keys(ROWS)) {
      if (interrupted) break;
      const cmd = resolve(id, A.agentConfig(cfg, id));
      const bin = cmd.found ? binaryOf(cmd, deps.which) : '';
      const identity = bin ? readIdentity(bin, idOpts) : null;
      if (!identity) {
        out(`${id}: not found (${cmd.note || 'no executable'}); skipped`);
        continue;
      }
      const agentEnv = A.AGENTS[id].env({ ...env });
      const ver = await version(cmd, { env: agentEnv, onChild: track });
      if (interrupted) break;
      out(`${id}: ${agentName(id)} ${ver || '(version unknown)'} at ${identity.realpath}`);
      const dir = fs.mkdtempSync(path.join(deps.tmpDir || os.tmpdir(), `claude-wow-contract-${id}-`));
      let r;
      try {
        r = await probes[id]({ cmd, env: agentEnv, dir, run, fixture: deps.fixture, own: deps.codexOwn });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      if (interrupted) break;
      const { rows, kept } = mergeRows(readContract(file)[id], identity, ver, r.rows);
      for (const [row, what] of Object.entries(ROWS[id])) out(`  ${row.padEnd(4)} ${rows[row].padEnd(9)} ${what}`);
      for (const note of r.notes) out(`  note: ${note}`);
      if (kept.length) out(`  note: kept the earlier fail of ${kept.join(', ')} for this same binary; only a measured pass clears it`);
      out(`  cost: ${r.cost}`);
      const checked = !!ver && measured(id, rows);
      if (Object.values(rows).includes(FAIL)) failed = true;
      if (!checked) {
        unchecked = true;
        const open = GATING_ROWS[id].filter(g => rows[g] === UNCHECKED);
        out(`  not checked: ${!ver ? 'the version is unknown' : `${open.join(', ')} measured nothing`}; run it again`);
      }
      writeContract(file, id, { path: bin, ...identity, version: ver, at: new Date(now()).toISOString(), checked, rows, cost: r.cost });
      wrote = true;
    }
  } finally {
    signals.removeListener('SIGINT', stop);
    signals.removeListener('SIGTERM', stop);
  }
  if (wrote) out(`wrote ${file}`);
  if (interrupted) {
    out('interrupted: the probe runs were stopped');
    return EXIT.interrupted;
  }
  if (failed) out('a failed row turns that behavior off in the bridge until a later check passes; see docs/AGENTS.md');
  return failed ? EXIT.failed : unchecked ? EXIT.unchecked : EXIT.ok;
}

function main(argv) {
  check(argv).then(
    code => {
      process.exitCode = code;
    },
    e => {
      process.stderr.write(`claude-wow agents check failed: ${e && e.message ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  FILE_NAME,
  ROWS,
  PROBE_SERVER,
  parseVersion,
  which,
  binaryOf,
  readVersion,
  identityOf,
  readIdentity,
  sameIdentity,
  createTracker,
  refusal,
  offReason,
  slotField,
  spawnRun,
  judgeClaude,
  judgeCodexCall,
  judgeCodexList,
  probeClaude,
  probeCodex,
  check,
  main,
};
