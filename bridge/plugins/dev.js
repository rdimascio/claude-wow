'use strict';

const fs = require('fs');
const path = require('path');
const PR = require('../procs');
const FB = require('../feedback');

const ID = 'dev';
const REPLY_MAX = 6000;
const OUTPUT_CAP = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 20000;
const GH_TIMEOUT_MS = 15000;
const DOCTOR_TIMEOUT_MS = 90000;
const TEST_TIMEOUT_MS = 20 * 60000;
const HEARTBEAT_MS = 30000;
const LOG_LINES_DEFAULT = 40;
const LOG_LINES_MAX = 200;
const LOG_TAIL_BYTES = 512 * 1024;
const GAME_LOG_TAIL_BYTES = 1024 * 1024;
const LUA_ERRORS_SHOWN = 5;
const LUA_ERROR_LINES = 12;
const TEST_TAIL_LINES = 60;
const DIFF_STAT_MAX = 1500;
const NOTE_MAX = 4000;
const ADDON_ERRORS_MARK = '\n--- addon errors ---\n';

const HELP = [
  'Dev tools for the folder of this chat. Each one runs on the bridge PC and does not use the agent.',
  '/claude dev status: branch, ahead and behind, changed files, recent commits, the open PR and its checks',
  '/claude dev diff [path]: the uncommitted diff',
  '/claude dev log [lines] [text]: the end of bridge.log, only lines with the text when given',
  '/claude dev run: the last agent run in this chat (session, time, cost, tools, errors) and the command to resume it in a terminal',
  '/claude dev test [args]: the test command (plugins.dev.testCommand, else npm test)',
  '/claude dev doctor: the health check (dev/doctor.js in this folder)',
  '/claude dev errors: Lua errors from the game log and the addon',
  '/claude wrong [#reply] [note]: mark the last reply in this chat (or reply #n) as wrong',
  '/claude bug <text>: report a bug with the addon state attached',
  '/claude dev feedback [close <n> | fix <n>]: the open wrong-reply and bug reports',
  'The agent in this chat sees the output of the last dev command with your next message.',
].join('\n');

function capText(text, max = REPLY_MAX) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return s.slice(0, max - 40).replace(/\n[^\n]*$/, '') + `\n... (${s.length - max + 40} more characters cut)`;
}

function fence(body, lang = '') {
  const text = String(body || '').replace(/```/g, "'''").replace(/\s+$/, '');
  return text ? '```' + lang + '\n' + text + '\n```' : '';
}

function lastLines(text, n) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function runCommand(file, args, { cwd, timeoutMs = GIT_TIMEOUT_MS, env, onTick, onSpawn, spawn = PR.spawnChild } = {}) {
  return new Promise(resolve => {
    let out = '';
    let err = '';
    let done = false;
    let timedOut = false;
    let child;
    const settle = r => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(ticker);
      resolve({ out, err, timedOut, ...r });
    };
    try {
      child = spawn(file, args, { cwd, env: env || process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e && e.message || e), missing: e && e.code === 'ENOENT', timedOut: false });
      return;
    }
    if (onSpawn) onSpawn(child);
    const timer = setTimeout(() => { timedOut = true; PR.killTree(child); }, timeoutMs);
    const ticker = onTick ? setInterval(onTick, HEARTBEAT_MS) : null;
    child.stdout.on('data', d => { if (out.length < OUTPUT_CAP) out += d.toString('utf8'); });
    child.stderr.on('data', d => { if (err.length < OUTPUT_CAP) err += d.toString('utf8'); });
    child.on('error', e => settle({ code: -1, err: String(e && e.message || e), missing: e && e.code === 'ENOENT' }));
    child.on('close', code => settle({ code: code === null ? -1 : code }));
  });
}

function parseArgs(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return { command: (words[0] || 'help').toLowerCase(), args: words.slice(1), rest: String(text || '').trim().replace(/^\S+\s*/, '') };
}

function splitAddonErrors(rest) {
  const at = rest.indexOf(ADDON_ERRORS_MARK.trim());
  if (at < 0) return { rest: rest.trim(), addon: '' };
  return { rest: rest.slice(0, at).trim(), addon: rest.slice(at + ADDON_ERRORS_MARK.trim().length).trim() };
}

function branchLine(header) {
  const m = /^## (.+)$/.exec(header || '');
  if (!m) return '';
  const raw = m[1];
  if (raw.startsWith('No commits yet on ')) return `branch ${raw.slice(18)} (no commits yet)`;
  const [names, counts] = raw.split(' [');
  const [branch, upstream] = names.split('...');
  const parts = [`branch ${branch}`];
  parts.push(upstream ? `tracking ${upstream}` : 'no upstream');
  if (counts) parts.push(counts.replace(/\]$/, ''));
  return parts.join(', ');
}

function checksLine(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return 'no checks';
  const tally = {};
  for (const c of rollup) {
    const s = String(c.conclusion || c.state || c.status || 'PENDING').toUpperCase();
    const key = s === 'SUCCESS' || s === 'NEUTRAL' || s === 'SKIPPED' ? 'passed' : s === 'FAILURE' || s === 'ERROR' || s === 'TIMED_OUT' || s === 'CANCELLED' || s === 'ACTION_REQUIRED' ? 'failed' : 'pending';
    tally[key] = (tally[key] || 0) + 1;
  }
  const failed = rollup.filter(c => /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED/i.test(String(c.conclusion || c.state || ''))).map(c => c.name || c.context).filter(Boolean);
  return ['failed', 'pending', 'passed'].filter(k => tally[k]).map(k => `${tally[k]} ${k}`).join(', ') + (failed.length ? ` (${failed.slice(0, 4).join(', ')})` : '');
}

async function gitRoot(cwd, run) {
  const r = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (r.missing) return { error: 'git is not installed on the bridge PC.' };
  if (r.code !== 0) return { error: `${cwd} is not in a git repository.` };
  return { root: r.out.trim() };
}

async function status(ctx) {
  const { cwd, run } = ctx;
  const g = await gitRoot(cwd, run);
  if (g.error) return g.error;
  const [st, lg, pr] = await Promise.all([
    run('git', ['status', '--porcelain=v1', '--branch'], { cwd }),
    run('git', ['log', '-3', '--format=%h %s (%cr)'], { cwd }),
    run('gh', ['pr', 'view', '--json', 'number,title,url,state,isDraft,statusCheckRollup'], { cwd, timeoutMs: GH_TIMEOUT_MS }),
  ]);
  const lines = st.out.replace(/\s+$/, '').split('\n').filter(Boolean);
  const header = lines[0] && lines[0].startsWith('## ') ? lines.shift() : '';
  const out = [`${path.basename(g.root)}: ${branchLine(header) || 'unknown branch'}`];
  out.push(lines.length ? `${lines.length} changed file${lines.length === 1 ? '' : 's'}:` : 'working tree clean');
  if (lines.length) out.push(fence(lines.slice(0, 30).join('\n') + (lines.length > 30 ? `\n... ${lines.length - 30} more` : '')));
  if (lg.code === 0 && lg.out.trim()) out.push('recent commits:', fence(lg.out.trim()));
  if (pr.code === 0) {
    try {
      const p = JSON.parse(pr.out);
      out.push(`PR #${p.number} ${p.isDraft ? 'draft' : String(p.state || '').toLowerCase()}: ${p.title}`, p.url, `checks: ${checksLine(p.statusCheckRollup)}`);
    } catch { out.push('PR: gh gave an unreadable answer'); }
  } else if (pr.missing) {
    out.push('PR: gh is not installed on the bridge PC');
  } else if (/no pull requests found/i.test(pr.err)) {
    out.push('PR: none for this branch');
  } else {
    out.push(`PR: ${(pr.err.trim().split('\n')[0] || (pr.timedOut ? 'gh timed out' : 'gh failed')).slice(0, 200)}`);
  }
  return out.join('\n');
}

async function diff(ctx) {
  const { cwd, run, args } = ctx;
  const g = await gitRoot(cwd, run);
  if (g.error) return g.error;
  const scope = args.length ? ['--', ...args] : [];
  const [stat, body, untracked] = await Promise.all([
    run('git', ['diff', 'HEAD', '--stat', ...scope], { cwd }),
    run('git', ['diff', 'HEAD', ...scope], { cwd }),
    run('git', ['ls-files', '--others', '--exclude-standard', ...scope], { cwd }),
  ]);
  if (stat.code !== 0) return `git diff failed: ${stat.err.trim().split('\n')[0]}`;
  const newFiles = untracked.out.trim().split('\n').filter(Boolean);
  if (!stat.out.trim() && !newFiles.length) return `No uncommitted changes${args.length ? ' in ' + args.join(' ') : ''}.`;
  const out = [];
  if (stat.out.trim()) out.push(fence(capText(stat.out.trim(), DIFF_STAT_MAX)));
  if (newFiles.length) out.push(`untracked: ${newFiles.slice(0, 20).join(', ')}${newFiles.length > 20 ? ` and ${newFiles.length - 20} more` : ''}`);
  const head = out.join('\n');
  const room = REPLY_MAX - head.length - 200;
  if (body.out.trim() && room > 200) {
    const cut = body.out.length > room;
    out.push(fence(cut ? body.out.slice(0, room).replace(/\n[^\n]*$/, '') : body.out, 'diff'));
    if (cut) out.push(`The diff is cut at ${room} characters. Use /claude dev diff <path> for one file.`);
  }
  return out.join('\n');
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally { fs.closeSync(fd); }
}

function logTail(ctx) {
  const { args, core } = ctx;
  let n = LOG_LINES_DEFAULT;
  const words = [...args];
  if (words.length && /^\d+$/.test(words[0])) n = Math.min(LOG_LINES_MAX, Math.max(1, Number(words.shift())));
  const filter = words.join(' ').toLowerCase();
  const file = core.logFile;
  let text;
  try { text = readTail(file, LOG_TAIL_BYTES); } catch (e) { return `Cannot read ${file}: ${e.message}`; }
  let lines = text.replace(/\s+$/, '').split('\n');
  if (filter) lines = lines.filter(l => l.toLowerCase().includes(filter));
  const shown = lines.slice(-n);
  if (!shown.length) return filter ? `No line with "${filter}" in the end of ${file}.` : `${file} is empty.`;
  const room = REPLY_MAX - 200;
  let body = shown.join('\n');
  if (body.length > room) body = body.slice(body.length - room).replace(/^[^\n]*\n/, '');
  return `${file}, last ${shown.length} line${shown.length === 1 ? '' : 's'}${filter ? ` with "${filter}"` : ''}:\n${fence(body)}`;
}

function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

function resumeCommand(r) {
  if (!r.session) return '';
  if (r.agent === 'claude') return `cd ${JSON.stringify(r.cwd || '.')} && claude --resume ${r.session}`;
  if (r.agent === 'codex') return `cd ${JSON.stringify(r.cwd || '.')} && codex resume ${r.session}`;
  return '';
}

function runReport(ctx) {
  const r = ctx.core.lastRun(ctx.job);
  if (!r) return 'No agent run in this chat since the bridge started keeping run records.';
  const now = ctx.now();
  const lines = [
    `${r.agent || 'agent'}${r.model ? ' ' + r.model : ''}${r.effort ? ', effort ' + r.effort : ''} in ${r.cwd || '?'}`,
    `${r.status}${r.code !== undefined && r.code !== null ? `, exit ${r.code}` : ''}, ${agoText(r.ms || 0)} long, ended ${agoText(now - (r.at || now))} ago`,
    `session ${r.session || 'none'}${r.resumed ? ' (resumed)' : ' (new)'}`,
  ];
  const usage = [r.turns && `turn ${r.turns}`, r.ctx && `context ${r.ctx} tokens`, typeof r.cost === 'number' && `~$${r.cost.toFixed(2)} API so far`].filter(Boolean);
  if (usage.length) lines.push(usage.join(', '));
  if (Array.isArray(r.denied) && r.denied.length) lines.push(`denied: ${r.denied.join(', ')}`);
  if (Array.isArray(r.tools) && r.tools.length) lines.push(`last steps (${r.steps || r.tools.length} in all):`, fence(r.tools.join('\n')));
  if (r.stderr) lines.push('stderr:', fence(r.stderr));
  const cmd = resumeCommand(r);
  if (cmd) lines.push('resume it in a terminal (quit this chat\'s runs first):', fence(cmd));
  return lines.join('\n');
}

function testCommand(cwd, options, args) {
  const own = options && options.testCommand;
  if (Array.isArray(own) && own.length && own.every(a => typeof a === 'string')) return { file: own[0], args: [...own.slice(1), ...args], label: [...own, ...args].join(' ') };
  if (typeof own === 'string' && own.trim()) return { shell: own.trim(), extra: args, label: [own.trim(), ...args].join(' ') };
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch {}
  if (!pkg || !pkg.scripts || !pkg.scripts.test) return null;
  const npmArgs = ['test', ...(args.length ? ['--', ...args] : [])];
  return { file: 'npm', args: npmArgs, label: ['npm', ...npmArgs].join(' ') };
}

const SAFE_ARG_RE = /^[A-Za-z0-9_./:=@+,-]+$/;

function platformCommand(c, platform = process.platform) {
  if (c.shell) return platform === 'win32' ? { file: 'cmd.exe', args: ['/d', '/s', '/c', [c.shell, ...c.extra].join(' ')] } : { file: '/bin/sh', args: ['-c', c.shell + ' "$@"', 'sh', ...c.extra] };
  if (platform === 'win32' && /^(npm|npx|yarn|pnpm)$/.test(c.file)) return { file: 'cmd.exe', args: ['/d', '/s', '/c', [c.file, ...c.args].join(' ')] };
  return { file: c.file, args: c.args };
}

function testSummary(out) {
  const lines = String(out || '').split('\n');
  const totals = lines.map(l => /^(?:#|ℹ) ((?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) .*)$/.exec(l.trim())).filter(Boolean).map(m => m[1]);
  const failing = lines.filter(l => /^\s*(?:not ok \d+|✖ )/.test(l)).map(l => l.trim()).filter((l, i, all) => all.indexOf(l) === i).slice(0, 15);
  return { totals, failing };
}

async function test(ctx) {
  const { cwd, args, core, job, run } = ctx;
  const unsafe = args.find(a => !SAFE_ARG_RE.test(a));
  if (unsafe) return `"${unsafe}" has characters the test command does not take. Use letters, digits and . / : = @ + , - _ only.`;
  const c = testCommand(cwd, core.options(ID), args);
  if (!c) return `No test command for ${cwd}: no package.json with a test script. Set plugins.dev.testCommand in config.json.`;
  const started = ctx.now();
  core.progress(job, `running ${c.label} in ${cwd}`);
  const p = platformCommand(c);
  const r = await run(p.file, p.args, { cwd, timeoutMs: TEST_TIMEOUT_MS, onTick: () => { core.beat(job); core.progress(job, `running ${c.label}, ${agoText(ctx.now() - started)} so far`); } });
  if (r.missing) return `${c.file} is not installed on the bridge PC (or not on the bridge's PATH).`;
  const all = r.out + (r.err ? '\n' + r.err : '');
  const { totals, failing } = testSummary(all);
  const verdict = r.timedOut ? `stopped after ${agoText(TEST_TIMEOUT_MS)}` : r.code === 0 ? 'passed' : `failed (exit ${r.code})`;
  const out = [`${c.label}: ${verdict} in ${agoText(ctx.now() - started)}`];
  if (totals.length) out.push(totals.join(', '));
  if (failing.length) out.push('failing:', fence(failing.join('\n')));
  if (r.code !== 0 || r.timedOut) out.push('end of the output:', fence(lastLines(all, TEST_TAIL_LINES)));
  return out.join('\n');
}

function doctorNode(core) {
  return path.basename(process.execPath).toLowerCase().startsWith('node') ? process.execPath : (core.options(ID).node || 'node');
}

async function doctor(ctx) {
  const { cwd, core, job, run } = ctx;
  const g = await gitRoot(cwd, run);
  const root = g.root || cwd;
  const script = path.join(root, 'dev', 'doctor.js');
  if (!fs.existsSync(script)) return `No dev/doctor.js in ${root}. The doctor runs from a claude-wow checkout: switch this chat to it with /claude cd.`;
  core.progress(job, 'running the doctor');
  const r = await run(doctorNode(core), [script, '--json'], { cwd: root, timeoutMs: DOCTOR_TIMEOUT_MS, onTick: () => core.beat(job) });
  let report;
  try { report = JSON.parse(r.out); } catch {
    return `The doctor gave no report (exit ${r.code}${r.timedOut ? ', timed out' : ''}).${r.err.trim() ? '\n' + fence(lastLines(r.err, 20)) : ''}`;
  }
  const mark = { ok: 'ok', warn: 'WARN', fail: 'FAIL' };
  const out = [`doctor: ${report.status}`];
  for (const c of report.checks || []) {
    out.push(`${mark[c.status] || c.status} ${c.title}: ${c.summary}`);
    if (c.status === 'ok') continue;
    for (const p of (c.problems || []).slice(0, 3)) out.push(`  - ${p.what}${p.fix ? `\n    fix: ${p.fix}` : ''}`);
  }
  return out.join('\n');
}

function luaErrors(text) {
  const lines = String(text || '').split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\[E\]\[Lua\]|Lua Error/i.test(lines[i])) continue;
    const block = [lines[i].trim()];
    for (let j = i + 1; j < lines.length && block.length < LUA_ERROR_LINES; j++) {
      if (/^\d+\/\d+ \d+:\d+:\d+/.test(lines[j]) || !lines[j].trim()) break;
      block.push(lines[j].trimEnd());
    }
    found.push(block.join('\n'));
  }
  return found;
}

function errors(ctx) {
  const { core, job, addonErrors } = ctx;
  const out = [];
  const client = core.clientOf(job);
  if (client) {
    const file = path.join(client.dir, 'Logs', 'General.log');
    let text = null;
    try { text = readTail(file, GAME_LOG_TAIL_BYTES); } catch {}
    if (text === null) out.push(`No ${file}.`);
    else {
      const found = luaErrors(text);
      const at = (() => { try { return fs.statSync(file).mtime; } catch { return null; } })();
      out.push(found.length ? `${found.length} Lua error${found.length === 1 ? '' : 's'} in General.log (the game writes it when it exits${at ? ', last written ' + at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ''}), the last ${Math.min(LUA_ERRORS_SHOWN, found.length)}:` : 'No Lua error in General.log (the game writes it when it exits).');
      if (found.length) out.push(fence(found.slice(-LUA_ERRORS_SHOWN).join('\n\n')));
    }
  } else out.push('The bridge does not know which game client sent this.');
  out.push(addonErrors ? `From the addon, this UI session:\n${fence(addonErrors)}` : 'The addon caught no Lua error this UI session.');
  return out.join('\n');
}

function feedback(ctx) {
  const { args, core, job } = ctx;
  const store = core.feedback;
  const sub = (args[0] || 'list').toLowerCase();
  if (sub === 'close' || sub === 'fix') {
    const n = Number(args[1]);
    const item = Number.isInteger(n) ? store.get(n) : null;
    if (!item) return `No feedback item ${args[1] || ''}. /claude dev feedback lists them.`;
    if (sub === 'close') {
      store.close(n, args.slice(2).join(' '));
      return `Closed #${n}.`;
    }
    const brief = FB.fixBrief(item);
    ctx.setNote(brief);
    return `${FB.describe(item, { full: true })}\n\nThe agent in this chat gets this report with your next message. Say what to do, for example: fix it.`;
  }
  const open = store.list({ status: sub === 'all' ? '' : 'open' });
  if (!open.length) return sub === 'all' ? 'No feedback yet.' : 'No open feedback. /claude dev feedback all shows the closed ones too.';
  const shown = open.slice(-15);
  return [`${open.length} ${sub === 'all' ? '' : 'open '}item${open.length === 1 ? '' : 's'}${open.length > shown.length ? `, the last ${shown.length}` : ''}:`, ...shown.map(i => FB.describe(i)), 'fix <n> hands one to the agent in this chat; close <n> closes it.'].join('\n');
}

function wrong(ctx) {
  const { args, core, job, rest } = ctx;
  let replyId = null;
  let note = rest;
  const ref = /^#(\d+)$/.exec(args[0] || '');
  if (ref) { replyId = Number(ref[1]); note = rest.replace(/^#\d+\s*/, ''); }
  const turn = core.lastTurn(job, replyId);
  if (!turn) return 'There is no reply in this chat to mark.';
  const item = core.feedback.add({
    kind: 'wrong', chat: job.chat, chatName: job.name || '', replyId: turn.id, cwd: job.cwd || '', plugin: turn.plugin || '', agent: turn.agent || '',
    session: turn.session || '', prompt: turn.prompt || '', reply: turn.reply || '', note,
  });
  return `Marked as wrong: #${item.n}${note ? '' : ' (add a note with /claude wrong <what was wrong>)'}. It is in ${core.feedback.file}; /claude dev feedback lists it.`;
}

function bug(ctx) {
  const { core, job, rest, addonErrors } = ctx;
  if (!rest && !addonErrors) return 'Say what went wrong: /claude bug <text>.';
  const turn = core.lastTurn(job, null);
  const item = core.feedback.add({
    kind: 'bug', chat: job.chat, chatName: job.name || '', replyId: turn ? turn.id : null, cwd: job.cwd || '', plugin: turn ? turn.plugin || '' : '', agent: turn ? turn.agent || '' : '',
    session: turn ? turn.session || '' : '', prompt: turn ? turn.prompt || '' : '', reply: turn ? turn.reply || '' : '', note: rest, addon: addonErrors,
  });
  return `Bug #${item.n} saved in ${core.feedback.file}. /claude dev feedback fix ${item.n} hands it to the agent in a chat for this repository.`;
}

const COMMANDS = {
  help: () => HELP,
  status,
  diff,
  log: logTail,
  run: runReport,
  test,
  doctor,
  errors,
  feedback,
  wrong,
  bug,
};

const NOTED = new Set(['status', 'diff', 'log', 'run', 'test', 'doctor', 'errors']);

function noteFor(command, rest, reply) {
  return capText(`[Output of "/claude dev ${command}${rest ? ' ' + rest : ''}" that the player ran in this chat just before this message]\n${reply}`, NOTE_MAX);
}

async function handleDev(job, core, deps = {}) {
  const { command, args, rest: raw } = parseArgs(job.text);
  const { rest, addon } = splitAddonErrors(raw);
  const restArgs = rest ? rest.split(/\s+/).filter(Boolean) : [];
  const fn = COMMANDS[command];
  core.accept(job);
  if (!fn) {
    core.reply(job, `Unknown dev command "${command}".\n${HELP}`);
    return;
  }
  core.claimRun(job);
  core.log(`${core.tag(job)} dev ${command} starting in ${core.resolveCwd(job)}`);
  const run = deps.run || runCommand;
  const ctx = {
    job, core, args: restArgs, rest, addonErrors: addon,
    cwd: core.resolveCwd(job),
    run: (file, args, opts = {}) => (job.cancelled ? Promise.resolve({ code: -1, out: '', err: '', timedOut: false, cancelled: true }) : run(file, args, { ...opts, onSpawn: child => core.runChild(job, child) })),
    now: deps.now || Date.now,
    setNote: text => core.setDevNote(job, text),
  };
  let text;
  try { text = await fn(ctx); }
  catch (e) {
    core.log(`${core.tag(job)} dev ${command}: ${e && e.stack ? e.stack : e}`);
    core.fail(job, `dev ${command} failed: ${e && e.message ? e.message : e}`);
    return;
  }
  if (job.cancelled) {
    core.fail(job, 'Cancelled from the game.');
    return;
  }
  const reply = capText(text);
  if (NOTED.has(command)) core.setDevNote(job, noteFor(command, rest, reply));
  core.log(`${core.tag(job)} dev ${command}${rest ? ' ' + rest.slice(0, 80) : ''}: ${reply.length} chars`);
  core.reply(job, reply);
}

const plugin = {
  id: ID,
  label: 'Dev tools',
  tools: '',
  surfaces: [],
  achievements: false,
  sessionless: true,
  banner: () => 'git status, diffs, logs, tests, doctor, Lua errors and feedback for the chat\'s folder (/claude dev help)',
  handle: (job, core) => handleDev(job, core),
};

module.exports = plugin;
module.exports.ID = ID;
module.exports.HELP = HELP;
module.exports.ADDON_ERRORS_MARK = ADDON_ERRORS_MARK;
module.exports.handleDev = handleDev;
module.exports.runCommand = runCommand;
module.exports.parseArgs = parseArgs;
module.exports.splitAddonErrors = splitAddonErrors;
module.exports.branchLine = branchLine;
module.exports.checksLine = checksLine;
module.exports.testCommand = testCommand;
module.exports.platformCommand = platformCommand;
module.exports.SAFE_ARG_RE = SAFE_ARG_RE;
module.exports.testSummary = testSummary;
module.exports.luaErrors = luaErrors;
module.exports.resumeCommand = resumeCommand;
module.exports.capText = capText;
module.exports.noteFor = noteFor;
