// The bridge's outbound transport, end to end against a fake home and a fake
// agent: a new install starts on the screenshot transport; when the addon
// reports that it cannot take the screenshot (a "shot" in the reload outbox,
// which is how a client without Screenshot() reaches a bridge that is not
// watching the screen), the bridge falls back to the pixel capture at once,
// says so in the log, remembers it in state.json, and names it in the slot
// files (the addon's /claude-wow diag shows the note) and in its banner at the
// next start; an explicit capture.mode always wins over that memory.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BRIDGE = path.join(__dirname, '..', 'bridge', 'bridge.js');

function scratch(name) {
  const dir = path.join(os.tmpdir(), `claude-wow-transport-${name}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A home folder with a config that points every game-side path into the same
// scratch tree: the addon folder with its signal folders and one installed slot
// (the bridge writes slot files only when ClaudeWoW_S001/Inbox.lua exists), the
// SavedVariables file, a project folder, and an agent that answers at once.
function fakeInstall(dir, capture = {}) {
  const home = path.join(dir, 'home');
  const client = path.join(dir, 'client');
  const addons = path.join(client, 'Interface', 'AddOns');
  const project = path.join(dir, 'project');
  for (const d of ['sig', 'ack', 'act', 'presence']) fs.mkdirSync(path.join(addons, 'ClaudeWoW_Runtime', d), { recursive: true });
  fs.mkdirSync(path.join(addons, 'ClaudeWoW'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW', 'ClaudeWoW.toc'), '## Interface: 16001\n');
  fs.mkdirSync(path.join(addons, 'ClaudeWoW_S001'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'ClaudeWoW_SlotData = nil\n');
  fs.mkdirSync(path.join(client, 'Screenshots'), { recursive: true });
  const savedDir = path.join(client, 'WTF', 'Account', 'ACCT', 'SavedVariables');
  fs.mkdirSync(savedDir, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const agent = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(agent, "process.stdout.write(JSON.stringify({ type: 'result', result: 'pong', session_id: 'sess-1' }) + '\\n');\n");
  const cfg = {
    addonDir: addons,
    savedVariablesFile: path.join(savedDir, 'ClaudeWoW.lua'),
    inboxFile: path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua'),
    defaultCwd: project,
    slots: 1,
    agent: 'claude',
    agents: { claude: { path: agent } },
    plugins: { default: 'claude-code' },
    gameContext: false,
    primerFile: '',
    capture: { enabled: true, ...capture },
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
  return { home, addons, saved: cfg.savedVariablesFile, project, cfg };
}

// What the game writes on /reload with a message waiting: the reload outbox,
// here from an addon on the screenshot transport in a client without Screenshot().
function outbox(id, text, shot) {
  const hex = s => Buffer.from(s, 'utf8').toString('hex');
  return `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = ${id},\n["session"] = "sess1",\n["chat"] = "chat1",\n["text"] = "${hex(text)}",\n["cwd"] = "",\n${shot ? `["shot"] = "${shot}",\n` : ''}["t"] = 1,\n},\n}\n`;
}

function runOnce(home, project, extra = []) {
  const r = spawnSync(process.execPath, [BRIDGE, '--once', '--project', project, ...extra], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_WOW_HOME: home },
    timeout: 60000,
  });
  return { ...r, out: r.stdout + r.stderr };
}

test('a new install starts on the screenshot transport; the addon reporting shot=missing makes the bridge fall back to pixels, say so, remember it and name it in the slot files', () => {
  const dir = scratch('fallback');
  const { home, addons, saved, project } = fakeInstall(dir);
  fs.writeFileSync(saved, outbox(7, 'ping', 'missing'));

  const r = runOnce(home, project);
  assert.equal(r.status, 0, r.out);
  // The banner: the default transport, named as such.
  assert.match(r.out, /^ {2}capture {2}: screenshot transport \(the default; no screen capture, no permissions, no python\): /m, r.out);
  // The report arrived (through the reload outbox) and the bridge switched, in plain words.
  assert.match(r.out, /#7@sess1 TRANSPORT FALLBACK: the addon reports shot=missing: the game client has no Screenshot\(\) function\./, r.out);
  assert.match(r.out, /switching from the screenshot transport to the pixel capture \(deprecated; it needs /, r.out);
  assert.match(
    r.out,
    /remembered in .*state\.json: the next start goes straight to the pixel transport\. To choose for good, set capture\.mode in .*config\.json to "pixel" \(no more note\) or "screenshot" \(try again\)\./,
    r.out,
  );
  // The message itself was still handled (the reload path carried it).
  assert.match(r.out, /#7@sess1 \(reload\) \[claude-code\] Claude starting in /, r.out);
  assert.match(r.out, /#7@sess1 done \(/, r.out);
  // Remembered.
  const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  assert.equal(state.transportFallback.reason, 'missing');
  assert.equal(state.transportFallback.session, 'sess1');
  assert.ok(Date.now() - state.transportFallback.at < 60000);
  // The slot files and Inbox.lua say pixel, with the note the addon shows in /claude-wow diag.
  for (const f of [path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua')]) {
    const lua = fs.readFileSync(f, 'utf8');
    assert.match(lua, /^\ttransport = "pixel",$/m, f);
    assert.match(
      lua,
      /^\ttransportNote = "pixel transport, fallen back to since \d{4}-\d\d-\d\d \d\d:\d\d UTC because the game client has no Screenshot\(\) function; the pixel capture is deprecated: set capture\.mode in config\.json to \\"pixel\\" to keep it without this note, or to \\"screenshot\\" to try the screenshot transport again",$/m,
      f,
    );
    assert.ok(!/^\tstrip = /m.test(lua), 'no screenshot strip levels on the pixel transport');
  }
  // The log file has the same lines.
  assert.match(fs.readFileSync(path.join(home, 'bridge.log'), 'utf8'), /TRANSPORT FALLBACK/);

  // The next start, nothing pending: straight to the pixel transport, and the banner says why.
  const again = runOnce(home, project);
  assert.equal(again.status, 0, again.out);
  assert.match(
    again.out,
    /^ {2}capture {2}: pixel transport, DEPRECATED \(FALLBACK: pixel transport, fallen back to since .* because the game client has no Screenshot\(\) function; /m,
    again.out,
  );
  assert.match(again.out, /nothing pending/);
  assert.match(fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8'), /^\ttransportNote = /m, 'the note stays in the slot files');

  // The same report again is not news: nothing switches, nothing is logged about it.
  fs.writeFileSync(saved, outbox(8, 'ping again', 'missing'));
  const third = runOnce(home, project);
  assert.equal(third.status, 0, third.out);
  assert.ok(!/TRANSPORT FALLBACK/.test(third.out), third.out);
  assert.match(third.out, /#8@sess1 done \(/, third.out);

  // An explicit capture.mode in config.json wins over the memory: "screenshot" tries again...
  // (a message in the outbox each time, so the run publishes slot files; a --once with nothing pending writes none)
  const cfgFile = path.join(home, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.capture.mode = 'screenshot';
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  fs.writeFileSync(saved, outbox(10, 'hello again', ''));
  const explicit = runOnce(home, project);
  assert.equal(explicit.status, 0, explicit.out);
  assert.match(explicit.out, /^ {2}capture {2}: screenshot transport \(capture\.mode in config\.json\): /m, explicit.out);
  assert.match(explicit.out, /#10@sess1 done \(/, explicit.out);
  const back = fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
  assert.match(back, /^\ttransport = "screenshot",$/m, back);
  assert.ok(!/transportNote/.test(back), 'no note on the transport the config chose');
  // ...and falls back again, this run, when the addon still cannot shoot; the config is named as the reason it will keep trying.
  fs.writeFileSync(saved, outbox(11, 'still no shots', 'failed'));
  const retry = runOnce(home, project);
  assert.equal(retry.status, 0, retry.out);
  assert.match(retry.out, /#11@sess1 TRANSPORT FALLBACK: the addon reports shot=failed: the game client reported SCREENSHOT_FAILED on every try\./, retry.out);
  assert.match(
    fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8'),
    /^\ttransportNote = "pixel transport, fallen back to since .* because the game client reported SCREENSHOT_FAILED on every try; /m,
  );
  assert.match(
    retry.out,
    /capture\.mode is "screenshot" in .*config\.json, so every start tries the screenshot transport first and falls back again/,
    retry.out,
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).transportFallback.reason, 'failed');
  // ..."pixel" is simply the pixel transport, deprecated, without the note.
  cfg.capture.mode = 'pixel';
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  fs.writeFileSync(saved, outbox(12, 'on pixels', ''));
  const pixel = runOnce(home, project);
  assert.equal(pixel.status, 0, pixel.out);
  assert.match(pixel.out, /#12@sess1 done \(/, pixel.out);
  assert.match(
    pixel.out,
    /^ {2}capture {2}: pixel transport, DEPRECATED \(capture\.mode in config\.json; kept only until Screenshot\(\) is confirmed on Windows and Linux\/Wine\): /m,
    pixel.out,
  );
  assert.ok(!/transportNote/.test(fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8')), 'no note when the pixel transport was chosen');
  // A bad mode is refused with the file name, exit 2 (the supervisor does not loop on it).
  cfg.capture.mode = 'gif';
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const bad = runOnce(home, project);
  assert.equal(bad.status, 2, bad.out);
  assert.match(bad.out, /"capture\.mode": "gif" in .*config\.json is not one of pixel, screenshot\./);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('agents.claude.maxCostUsd end to end: the run gets --max-budget-usd, a key the agent cannot take is logged, a budget stop is the reply', () => {
  const dir = scratch('costcap');
  const { home, saved, project, cfg } = fakeInstall(dir);
  const argvFile = path.join(dir, 'argv.json');
  const stop = {
    type: 'result',
    subtype: 'error_max_budget_usd',
    is_error: true,
    terminal_reason: 'budget_exhausted',
    errors: ['Reached maximum budget ($0.5)'],
    session_id: 'sess-1',
  };
  fs.writeFileSync(
    cfg.agents.claude.path,
    `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(stop) + '\n')});\nprocess.exitCode = 1;\n`,
  );
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ ...cfg, agents: { claude: { ...cfg.agents.claude, maxCostUsd: 0.5 }, codex: { maxCostUsd: 2 } } }),
  );
  fs.writeFileSync(saved, outbox(9, 'ping', ''));
  const r = runOnce(home, project);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Codex has no cost cap, so agents\.codex\.maxCostUsd is ignored\./, r.out);
  assert.ok(!/agents\.claude\.maxCostUsd/.test(r.out), 'a valid cap is not logged as a problem');
  assert.match(r.out, /^ {2}claude {3}: .*, cost cap \$0\.5 per message\]$/m, r.out);
  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '0.5');
  assert.match(r.out, /#9@sess1 done \(/, r.out);
  const transcript = fs.readFileSync(path.join(home, 'transcripts.json'), 'utf8');
  assert.ok(transcript.includes('"Stopped: this message hit the $0.50 cost cap."'), transcript);
  assert.ok(!transcript.includes('Bridge error'), 'the player set the cap, so the reply is not a bridge error');
  fs.rmSync(dir, { recursive: true, force: true });
});

function mcpAgent(file, record, result) {
  fs.writeFileSync(
    file,
    `const fs = require('fs');\nconst a = process.argv.slice(2);\nconst i = a.indexOf('--mcp-config');\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: a, mcp: i >= 0 ? fs.readFileSync(a[i + 1], 'utf8') : null }));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(result) + '\n')});\n`,
  );
}

function outboxWithAllow(id, text, rules) {
  const hex = s => Buffer.from(s, 'utf8').toString('hex');
  return `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = ${id},\n["session"] = "sess1",\n["chat"] = "chat1",\n["text"] = "${hex(text)}",\n["cwd"] = "",\n["allow"] = "${hex(rules.join('\x1F'))}",\n["t"] = 1,\n},\n}\n`;
}

test('an absent mcp key and an empty mcp block give the same argv and the same MCP config', () => {
  const dir = scratch('mcp-absent');
  const { home, saved, project, cfg } = fakeInstall(dir);
  const record = path.join(dir, 'run.json');
  mcpAgent(cfg.agents.claude.path, record, { type: 'result', result: 'pong', session_id: 'sess-1' });
  const runs = [];
  for (const mcp of [undefined, {}, { servers: {}, strict: false }]) {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(mcp === undefined ? cfg : { ...cfg, mcp }));
    fs.rmSync(path.join(home, 'state.json'), { force: true });
    fs.writeFileSync(saved, outbox(20, 'ping', ''));
    const r = runOnce(home, project);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /#20@sess1 done \(/, r.out);
    runs.push(JSON.parse(fs.readFileSync(record, 'utf8')));
  }
  assert.ok(!runs[0].argv.includes('--strict-mcp-config'));
  assert.deepEqual(runs[1], runs[0]);
  assert.deepEqual(runs[2], runs[0]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mcp.servers end to end: servers reach --mcp-config with ${VAR} only, strict is logged and passed, a reserved name is refused, and a tool outside allow is never offered nor persisted', () => {
  const dir = scratch('mcp-servers');
  const { home, saved, project, cfg } = fakeInstall(dir);
  const userHome = path.join(dir, 'user');
  fs.mkdirSync(userHome, { recursive: true });
  fs.writeFileSync(path.join(userHome, '.claude.json'), JSON.stringify({ mcpServers: { mobbin: { type: 'http', url: 'https://m' } } }));
  const secret = 'ghp_e2e_secret_value_never_written';
  const record = path.join(dir, 'run.json');
  mcpAgent(cfg.agents.claude.path, record, {
    type: 'result',
    result: 'pong',
    session_id: 'sess-1',
    permission_denials: [
      { tool_name: 'mcp__notion__create_page', tool_use_id: 't1', tool_input: {} },
      { tool_name: 'mcp__slack__post', tool_use_id: 't2', tool_input: {} },
    ],
  });
  const withMcp = {
    ...cfg,
    agents: { claude: { ...cfg.agents.claude, allowedTools: ['WebSearch', 'mcp__notion', 'mcp__notion__notion-create-pages'] } },
    mcp: {
      strict: true,
      servers: {
        notion: { type: 'http', url: 'https://mcp.notion.com/mcp', allow: { claude: ['notion-search'] }, default: true },
        github: { command: 'npx', args: ['-y', 'server-github'], envVars: ['GITHUB_TOKEN'], allow: '*', default: true },
        wowdata: { command: 'node', args: ['fake.js'], default: true },
      },
    },
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(withMcp));
  fs.writeFileSync(saved, outbox(21, 'ping', ''));
  const env = { HOME: userHome, USERPROFILE: userHome, CLAUDE_CONFIG_DIR: '', GITHUB_TOKEN: secret };
  const run = () =>
    spawnSync(process.execPath, [BRIDGE, '--once', '--project', project], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_WOW_HOME: home, ...env },
      timeout: 60000,
    });
  const first = run();
  const out = first.stdout + first.stderr;
  assert.equal(first.status, 0, out);
  assert.match(out, /mcp\.servers\.wowdata: "wowdata" is a bridge server name \(wowdata, wowgoals, wowfactory\); this server is skipped/, out);
  assert.match(out, /mcp: notion \(on by default\), github \(on by default\); strict: /, out);
  assert.match(out, /mcp\.strict: Claude runs stop loading at least these servers of your own: user:mobbin, and claude\.ai connectors/, out);
  assert.match(
    out,
    /#21@sess1 mcp: mcp__notion__create_page was denied; its server is off for this chat or the tool is outside its allow list, so it is not offered to allow/,
    out,
  );
  assert.match(out, /mcp: allowed tool rules that mcp\.servers does not allow are left out of Claude runs: mcp__notion, mcp__notion__notion-create-pages/, out);
  const { argv, mcp } = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.ok(argv.includes('--strict-mcp-config'), argv.join(' '));
  const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
  assert.ok(allowed.includes('mcp__notion__notion-search') && allowed.includes('mcp__github'), allowed.join(' '));
  assert.ok(!allowed.includes('mcp__notion') && !allowed.includes('mcp__notion__notion-create-pages'), allowed.join(' '));
  assert.ok(argv.slice(argv.indexOf('--disallowedTools')).includes('mcp__notion__notion-create-pages'));
  assert.deepEqual(JSON.parse(mcp).mcpServers, {
    notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    github: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
  });
  const inbox = fs.readFileSync(path.join(cfg.addonDir, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
  assert.match(inbox, /denied = \{ "mcp__slack__post" \},/, inbox);
  assert.ok(!inbox.includes('mcp__notion__create_page'), inbox);

  fs.writeFileSync(saved, outboxWithAllow(22, 'go on', ['mcp__notion__create_page', 'mcp__slack__post']));
  const second = run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const saved2 = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.ok(saved2.agents.claude.allowedTools.includes('mcp__slack__post'), JSON.stringify(saved2.agents.claude));
  assert.ok(!saved2.agents.claude.allowedTools.includes('mcp__notion__create_page'), JSON.stringify(saved2.agents.claude));
  const secondArgv = JSON.parse(fs.readFileSync(record, 'utf8')).argv;
  assert.ok(!secondArgv.slice(secondArgv.indexOf('--allowedTools'), secondArgv.indexOf('--disallowedTools')).includes('mcp__notion__create_page'));

  for (const f of [record, path.join(home, 'config.json'), path.join(home, 'state.json'), path.join(home, 'transcripts.json')])
    assert.ok(!fs.readFileSync(f, 'utf8').includes(secret), f);
  assert.ok(!(first.stdout + first.stderr + second.stdout + second.stderr).includes(secret));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('per-chat MCP end to end: discovered servers are listed, a chat turns one off and on, and the run health reaches the slot files', () => {
  const dir = scratch('mcp-chat');
  const { home, saved, project, cfg, addons } = fakeInstall(dir);
  const userHome = path.join(dir, 'user');
  fs.mkdirSync(userHome, { recursive: true });
  fs.writeFileSync(path.join(userHome, '.claude.json'), JSON.stringify({ mcpServers: { mobbin: { type: 'http', url: 'https://m' } } }));
  const argvFile = path.join(dir, 'argv.json');
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-1',
    mcp_servers: [
      { name: 'linear', status: 'needs-auth', source: 'dynamic' },
      { name: 'mobbin', status: 'connected', source: 'user' },
      { name: 'claude.ai Slack', status: 'connected', source: 'claudeai' },
      { name: 'wowdata', status: 'connected', source: 'dynamic' },
      { name: 'wowgoals', status: 'connected', source: 'dynamic' },
    ],
  };
  const done = { type: 'result', result: 'pong', session_id: 'sess-1' };
  fs.writeFileSync(
    cfg.agents.claude.path,
    `require('fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(init) + '\n' + JSON.stringify(done) + '\n')});\n`,
  );
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      ...cfg,
      mcp: {
        servers: {
          notion: { type: 'http', url: 'https://mcp.notion.com/mcp', allow: '*', default: true },
          linear: { type: 'http', url: 'https://mcp.linear.app/mcp', allow: ['list_issues'] },
        },
      },
    }),
  );
  const hex = s => Buffer.from(s, 'utf8').toString('hex');
  const other = path.join(dir, 'other-repo');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, '.mcp.json'), JSON.stringify({ mcpServers: { 'repo-srv': { command: 'node', args: ['x.js'] } } }));
  const send = (id, choice, cwd = '') =>
    fs.writeFileSync(
      saved,
      `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = ${id},\n["session"] = "sess1",\n["chat"] = "chat1",\n["text"] = "${hex('ping')}",\n["cwd"] = "${hex(cwd)}",\n["opts"] = "${hex(`mcp=${choice}`)}",\n["t"] = 1,\n},\n}\n`,
    );
  const env = { ...process.env, CLAUDE_WOW_HOME: home, HOME: userHome, USERPROFILE: userHome, CLAUDE_CONFIG_DIR: '' };
  const run = () => spawnSync(process.execPath, [BRIDGE, '--once', '--project', project], { encoding: 'utf8', env, timeout: 60000 });

  send(31, '+linear,-notion,-mobbin');
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /#31@sess1 .* \[mcp linear\]/);
  let argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
  assert.ok(allowed.includes('mcp__linear__list_issues') && !allowed.includes('mcp__notion'), allowed.join(' '));
  const denied = argv.slice(argv.indexOf('--disallowedTools') + 1);
  assert.ok(denied.includes('mcp__notion') && denied.includes('mcp__mobbin'), 'the config server and the discovered one the chat left off are denied');
  assert.ok(!denied.includes('mcp__claude_ai_Slack'), 'untouched: not denied');
  const slot = fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
  assert.match(
    slot,
    /^\tmcp = \{ \{ id = "notion", label = "notion", src = "config", on = true, health = "unknown" \}, \{ id = "linear", label = "linear", src = "config", on = false, health = "needs-auth" \}, \{ id = "mobbin", label = "mobbin", src = "claude", on = true, health = "connected" \}, \{ id = "claude_ai_Slack", label = "Slack", src = "claude\.ai", on = true, health = "connected" \} \},$/m,
    slot,
  );
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8')).mcpSeen.claude_ai_Slack, 'what Claude reported is kept for the next start');

  send(32, '-claude_ai_Slack');
  assert.equal(run().status, 0);
  argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.ok(argv.slice(argv.indexOf('--disallowedTools') + 1).includes('mcp__claude_ai_Slack'), 'a connector the last run reported can be turned off');

  send(33, '-*');
  assert.equal(run().status, 0);
  argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  const allOff = argv.slice(argv.indexOf('--disallowedTools') + 1);
  assert.ok(allOff.includes('mcp__mobbin') && allOff.includes('mcp__claude_ai_Slack') && allOff.includes('mcp__notion'), allOff.join(' '));
  assert.ok(!allOff.includes('mcp__wowdata'), 'all off never denies a bridge server the last run reported: ' + allOff.join(' '));

  send(34, '-*', other);
  assert.equal(run().status, 0);
  argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.ok(
    argv.slice(argv.indexOf('--disallowedTools') + 1).includes('mcp__repo-srv'),
    "all off also covers a server in the chat folder's .mcp.json that no run reported yet",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a C2 fail in agent-contract.json refuses a run whose mcp= choice turns a server off, before the agent starts, and the slot files carry the contract', () => {
  const dir = scratch('mcp-contract');
  const { home, saved, project, cfg, addons } = fakeInstall(dir);
  const userHome = path.join(dir, 'user');
  fs.mkdirSync(userHome, { recursive: true });
  fs.writeFileSync(path.join(userHome, '.claude.json'), JSON.stringify({ mcpServers: { mobbin: { type: 'http', url: 'https://m' } } }));
  const calls = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(
    cfg.agents.claude.path,
    `const a = process.argv.slice(2);\nrequire('fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + '\\n');\nif (a.includes('--version')) { console.log('2.1.290 (Claude Code)'); process.exit(0); }\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ type: 'result', result: 'pong', session_id: 'sess-1' }) + '\n')});\n`,
  );
  const real = fs.realpathSync.native(cfg.agents.claude.path);
  const reason = /Claude Code 2\.1\.290 failed C2 in claude-wow agents check, so it may still load an MCP server a chat turns off\./;
  fs.writeFileSync(
    path.join(home, 'agent-contract.json'),
    JSON.stringify({
      claude: {
        path: cfg.agents.claude.path,
        realpath: real,
        mtimeMs: fs.statSync(real).mtimeMs,
        version: '2.1.290',
        at: new Date().toISOString(),
        rows: { C1: 'pass', C2: 'fail', C2u: 'unchecked', C3: 'pass', C4: 'pass' },
      },
    }),
  );
  const hex = s => Buffer.from(s, 'utf8').toString('hex');
  const send = (id, opts) =>
    fs.writeFileSync(
      saved,
      `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = ${id},\n["session"] = "sess1",\n["chat"] = "chat1",\n["text"] = "${hex('ping')}",\n["cwd"] = "",\n${opts ? `["opts"] = "${hex(opts)}",\n` : ''}["t"] = 1,\n},\n}\n`,
    );
  const env = { ...process.env, CLAUDE_WOW_HOME: home, HOME: userHome, USERPROFILE: userHome, CLAUDE_CONFIG_DIR: '' };
  const run = () => spawnSync(process.execPath, [BRIDGE, '--once', '--project', project], { encoding: 'utf8', env, timeout: 60000 });
  const agentRuns = () =>
    fs.existsSync(calls)
      ? fs
          .readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map(l => JSON.parse(l))
          .filter(a => a.includes('-p'))
      : [];

  send(41, 'mcp=-mobbin');
  const r = run();
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1, out);
  assert.match(out, new RegExp(`#41@sess1 contract: ${reason.source}`), out);
  assert.equal(agentRuns().length, 0, 'the agent never started');
  const transcript = fs.readFileSync(path.join(home, 'transcripts.json'), 'utf8');
  assert.match(transcript, reason, transcript);
  const slot = fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8');
  assert.match(slot, /^\tcontract = \{ claude = \{ version = "2\.1\.290", checked = true, off = false, reason = "Claude Code 2\.1\.290 failed C2 /m, slot);

  send(42, '');
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout + ok.stderr, /#42@sess1 done \(/);
  assert.equal(agentRuns().length, 1, 'a chat that turns nothing off still runs');

  fs.writeFileSync(path.join(home, 'agent-contract.json'), '{}');
  send(43, 'mcp=-mobbin');
  const unchecked = run();
  const uOut = unchecked.stdout + unchecked.stderr;
  assert.match(uOut, /contract: Claude Code at .* is not checked against the MCP behaviors the bridge relies on; run claude-wow agents check\./, uOut);
  assert.match(uOut, /#43@sess1 done \(/, 'not checked turns nothing off');
  assert.equal(agentRuns().length, 2);
  assert.match(
    fs.readFileSync(path.join(addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8'),
    /^\tcontract = \{ claude = \{ version = "[0-9.]*", checked = false, off = true, reason = "" \}(, | \},$)/m,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
