'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const MC = require('../bridge/mcpconfig');
const A = require('../bridge/agents');
const P = require('../bridge/protocol');
const GM = require('../bridge/goalsmcp');

const RESERVED = ['wowdata', 'wowgoals', 'wowfactory'];
const SECRET = 'ghp_value_that_must_never_leave_the_env';

function parsed(raw, env = {}) {
  const lines = [];
  const mcp = MC.parse(raw, { reserved: RESERVED, log: (...p) => lines.push(p.join(' ')), env });
  return { mcp, lines };
}

const SAMPLE = {
  servers: {
    github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], envVars: ['GITHUB_TOKEN'], allow: '*', default: true },
    notion: { type: 'http', url: 'https://mcp.notion.com/mcp', allow: { claude: ['notion-search', 'notion-fetch'], codex: ['search'] }, default: true },
    linear: { type: 'http', url: 'https://mcp.linear.app/mcp', bearerTokenEnvVar: 'LINEAR_KEY', allow: ['list_issues'], default: true },
    quiet: { command: 'node', args: ['q.js'], allow: ['*'] },
  },
};

function claudeArgv(agentCfg, plan, mcpConfig = '') {
  const scoped = MC.scopeAllowed(agentCfg, plan);
  const cfg = P.withRunDeniedRules(P.withRunOnlyRules(scoped.agentCfg, plan ? plan.allowRules : []), scoped.denied);
  return A.AGENTS.claude.args({ cfg, resume: '', system: 'sys', images: [], mcpConfig, strictMcpConfig: !!(plan && plan.strict) });
}

test('an absent mcp key changes nothing: no plan, the same agent config object, the same argv and MCP JSON as an empty mcp block', () => {
  assert.equal(MC.parse(undefined), null);
  assert.equal(MC.forClaude(null), null);
  const agentCfg = { allowedTools: ['WebSearch', 'mcp__notion'], deniedTools: ['Bash'] };
  assert.equal(MC.scopeAllowed(agentCfg, null).agentCfg, agentCfg);
  const bridgeOnly = GM.mcpConfig({ wowdata: { type: 'stdio', command: 'node', args: ['d.js'] } });
  const before = claudeArgv(agentCfg, null, '/tmp/m.json');
  for (const empty of [{}, { servers: {} }, { servers: {}, strict: false }]) {
    const plan = MC.forClaude(parsed(empty).mcp);
    assert.deepEqual(claudeArgv(agentCfg, plan, '/tmp/m.json'), before, JSON.stringify(empty));
    assert.equal(GM.mcpConfig({ ...plan.servers, wowdata: { type: 'stdio', command: 'node', args: ['d.js'] } }), bridgeOnly);
  }
  assert.ok(!before.includes('--strict-mcp-config'));
});

test('alwaysLoad is passed through so Claude does not defer the tools behind tool search', () => {
  const plan = MC.forClaude(
    parsed({ servers: { s: { command: 'x', alwaysLoad: true, default: true }, h: { type: 'http', url: 'https://h', alwaysLoad: false, default: true } } }).mcp,
  );
  assert.deepEqual(plan.servers, { s: { type: 'stdio', command: 'x', args: [], alwaysLoad: true }, h: { type: 'http', url: 'https://h' } });
});

test('servers translate to Claude --mcp-config entries with ${VAR} references, and only default servers load', () => {
  const { mcp, lines } = parsed(SAMPLE, { GITHUB_TOKEN: SECRET, LINEAR_KEY: SECRET });
  assert.deepEqual(lines, []);
  const plan = MC.forClaude(mcp);
  assert.deepEqual(plan.servers, {
    github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
    notion: { type: 'http', url: 'https://mcp.notion.com/mcp' },
    linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_KEY}' } },
  });
  assert.deepEqual(plan.names, ['github', 'notion', 'linear']);
  assert.deepEqual(plan.allowRules, ['mcp__github', 'mcp__notion__notion-search', 'mcp__notion__notion-fetch', 'mcp__linear__list_issues']);
  assert.equal(plan.strict, false);
});

test('allow: "*" and ["*"] allow the whole server, a list allows only its tools, per-agent lists take the claude list, and no list allows nothing', () => {
  const plan = MC.forClaude(
    parsed({
      servers: {
        a: { command: 'x', allow: '*', default: true },
        b: { command: 'x', allow: ['one', '*'], default: true },
        c: { command: 'x', allow: ['one', 'two', 'one'], default: true },
        d: { command: 'x', allow: { codex: ['one'] }, default: true },
        e: { command: 'x', default: true },
        f: { command: 'x', allow: ['one'] },
      },
    }).mcp,
  );
  assert.deepEqual(plan.allowRules, ['mcp__a', 'mcp__b', 'mcp__c__one', 'mcp__c__two']);
  assert.equal(plan.blocks('mcp__a__anything'), false);
  assert.equal(plan.blocks('mcp__c__one'), false);
  assert.equal(plan.blocks('mcp__c__three'), true);
  assert.equal(plan.blocks('mcp__c'), true);
  assert.equal(plan.blocks('mcp__c__*'), true);
  assert.equal(plan.blocks('mcp__d__one'), true);
  assert.equal(plan.blocks('mcp__e__anything'), true);
  assert.equal(plan.blocks('mcp__f__two'), true, 'a server off by default can still load from Claude settings; its allow list still holds');
  assert.equal(plan.blocks('mcp__f__one'), false);
  assert.ok(!('f' in plan.servers));
  assert.equal(plan.blocks('mcp__other__tool'), false);
  assert.equal(plan.blocks('WebSearch'), false);
});

test('rules the player already allowed for a scoped server are left out of the run; exact tool rules become run denies, server-wide ones are dropped', () => {
  const plan = MC.forClaude(parsed(SAMPLE).mcp);
  const agentCfg = {
    allowedTools: ['WebSearch', 'mcp__notion', 'mcp__notion__notion-search', 'mcp__notion__notion-create-pages', 'mcp__notion__*', 'mcp__github__x'],
    deniedTools: ['Bash'],
  };
  const scoped = MC.scopeAllowed(agentCfg, plan);
  assert.deepEqual(scoped.agentCfg.allowedTools, ['WebSearch', 'mcp__notion__notion-search', 'mcp__github__x']);
  assert.deepEqual(scoped.denied, ['mcp__notion__notion-create-pages']);
  assert.deepEqual(scoped.dropped, ['mcp__notion', 'mcp__notion__notion-create-pages', 'mcp__notion__*']);
  const argv = claudeArgv(agentCfg, plan);
  const allowed = argv.slice(argv.indexOf('--allowedTools') + 1, argv.indexOf('--disallowedTools'));
  assert.ok(!allowed.includes('mcp__notion'), allowed.join(' '));
  assert.ok(allowed.includes('mcp__notion__notion-fetch'));
  const denied = argv.slice(argv.indexOf('--disallowedTools') + 1, argv.indexOf('--append-system-prompt'));
  assert.deepEqual(denied, ['Bash', 'mcp__notion__notion-create-pages']);
});

test('--strict-mcp-config is passed only with mcp.strict true', () => {
  const on = MC.forClaude(parsed({ ...SAMPLE, strict: true }).mcp);
  const off = MC.forClaude(parsed({ ...SAMPLE, strict: false }).mcp);
  assert.equal(on.strict, true);
  assert.ok(claudeArgv({}, on, '/tmp/m.json').includes('--strict-mcp-config'));
  assert.ok(!claudeArgv({}, off, '/tmp/m.json').includes('--strict-mcp-config'));
  assert.ok(!claudeArgv({}, MC.forClaude(parsed(SAMPLE).mcp), '/tmp/m.json').includes('--strict-mcp-config'));
  assert.ok(
    !A.AGENTS.claude.args({ cfg: { strictMcpConfig: true }, resume: '', system: '', images: [], mcpConfig: '' }).includes('--strict-mcp-config'),
    'a config key cannot turn strict on',
  );
  const bad = parsed({ servers: {}, strict: 'yes' });
  assert.equal(bad.mcp.strict, false);
  assert.match(bad.lines[0], /^mcp\.strict in config\.json must be true or false; "yes" is ignored/);
});

test('a bad entry is skipped with one log line each and never stops the others', () => {
  const { mcp, lines } = parsed({
    servers: {
      wowdata: { command: 'x', default: true },
      wowgoals: { command: 'x', default: true },
      two__parts: { command: 'x', default: true },
      'has.dot': { command: 'x', default: true },
      _lead: { command: 'x', default: true },
      nocmd: { default: true },
      badtype: { type: 'sse', url: 'https://x' },
      badurl: { type: 'http', url: 'ftp://x' },
      typo: { command: 'x', alow: ['a'] },
      httpenv: { type: 'http', url: 'https://x', envVars: ['A'] },
      badenv: { command: 'x', envVars: ['NOT-A-NAME'] },
      badtool: { command: 'x', allow: ['ok', 'no spaces'] },
      badagent: { command: 'x', allow: { gemini: ['a'] } },
      baddefault: { command: 'x', default: 'yes' },
      badalways: { command: 'x', alwaysLoad: 1 },
      notobj: 'npx thing',
      good: { command: 'x', allow: ['a'], default: true },
    },
  });
  assert.deepEqual(
    mcp.servers.map(s => s.name),
    ['good'],
  );
  assert.equal(lines.length, 16, lines.join('\n'));
  assert.ok(
    lines.every(l => /; this server is skipped$/.test(l)),
    lines.join('\n'),
  );
  assert.match(lines[0], /^mcp\.servers\.wowdata: "wowdata" is a bridge server name \(wowdata, wowgoals, wowfactory\); this server is skipped$/);
  assert.match(lines[1], /^mcp\.servers\.wowgoals: "wowgoals" is a bridge server name/);
  assert.match(lines[2], /^mcp\.servers\.two__parts: the name must be letters and digits, joined by single - or _/);
  assert.match(lines[8], /^mcp\.servers\.typo\.alow is not a key of a stdio server/);
  assert.equal(MC.forClaude(mcp).allowRules.join(), 'mcp__good__a');
  const junk = parsed('npx');
  assert.deepEqual(junk.mcp, { servers: [], strict: false });
  assert.equal(junk.lines.length, 1);
});

test('no env value reaches the run: the log names a missing variable, argv and the MCP JSON carry only ${NAME}', () => {
  const missing = parsed(SAMPLE, {});
  assert.deepEqual(missing.lines, [
    "mcp.servers.github: GITHUB_TOKEN is not set in the bridge's environment, so a Claude server gets the literal text ${GITHUB_TOKEN} and a Codex server gets nothing",
    "mcp.servers.linear: LINEAR_KEY is not set in the bridge's environment, so a Claude server gets the literal text ${LINEAR_KEY} and a Codex server gets nothing",
  ]);
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, LINEAR_KEY: process.env.LINEAR_KEY };
  Object.assign(process.env, { GITHUB_TOKEN: SECRET, LINEAR_KEY: SECRET });
  let mcp, lines, json, argv;
  try {
    ({ mcp, lines } = parsed(SAMPLE, process.env));
    const plan = MC.forClaude(mcp);
    json = GM.mcpConfig(plan.servers);
    argv = claudeArgv({}, plan, '/tmp/m.json');
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
  for (const out of [json, JSON.stringify(argv), JSON.stringify(mcp), lines.join('\n'), MC.summary(mcp)]) assert.ok(!out.includes(SECRET), out);
  assert.match(json, /"GITHUB_TOKEN":"\$\{GITHUB_TOKEN\}"/);
  assert.match(json, /"Authorization":"Bearer \$\{LINEAR_KEY\}"/);
});

test('a scoped tool the run was denied is never offered in the roll, a tool of an unscoped server still is', () => {
  const plan = MC.forClaude(parsed(SAMPLE).mcp);
  const result = {
    type: 'result',
    result: 'done',
    session_id: 's',
    permission_denials: [
      { tool_name: 'mcp__notion__create_page', tool_use_id: 't1', tool_input: {} },
      { tool_name: 'mcp__slack__post', tool_use_id: 't2', tool_input: {} },
    ],
  };
  const guarded = A.claudeParser({ cwd: '/p', granted: { rules: [], dirs: [] }, neverOffer: [], neverOfferIf: plan.blocks }).feed(result);
  assert.deepEqual(guarded.denied, ['mcp__slack__post']);
  const unguarded = A.claudeParser({ cwd: '/p', granted: { rules: [], dirs: [] }, neverOffer: [] }).feed(result);
  assert.deepEqual(unguarded.denied, ['mcp__notion__create_page', 'mcp__slack__post']);
});

test('claudeOwnServers lists the user, local, project and enabled plugin servers that strict mode stops loading', () => {
  const home = '/h';
  const cwd = '/proj';
  const files = {
    [path.join(home, '.claude.json')]: { mcpServers: { mobbin: {}, 'claude-wow': {} }, projects: { [cwd]: { mcpServers: { localone: {} } } } },
    [path.join(cwd, '.mcp.json')]: { mcpServers: { 'claude-wow': {} } },
    [path.join(home, '.claude', 'settings.json')]: { enabledPlugins: { 'playwright@official': true, 'off@official': false, 'local-off@official': true } },
    [path.join(cwd, '.claude', 'settings.json')]: { enabledPlugins: { 'proj@official': true } },
    [path.join(cwd, '.claude', 'settings.local.json')]: { enabledPlugins: { 'local-off@official': false } },
    [path.join(home, '.claude', 'plugins', 'installed_plugins.json')]: {
      plugins: {
        'playwright@official': [{ installPath: '/pp' }],
        'off@official': [{ installPath: '/po' }],
        'local-off@official': [{ installPath: '/pl' }],
        'proj@official': [{ installPath: '/pj' }],
      },
    },
    [path.join('/pj', '.claude-plugin', 'plugin.json')]: { mcpServers: ['./cfg/servers.json', { inline: { command: 'x' } }] },
    [path.resolve('/pj', './cfg/servers.json')]: { mcpServers: { fromfile: { command: 'x' } } },
    [path.join('/pl', '.mcp.json')]: { gone: { command: 'npx' } },
    [path.join('/pp', '.mcp.json')]: { playwright: { command: 'npx' } },
    [path.join('/po', '.mcp.json')]: { hidden: { command: 'npx' } },
  };
  const own = MC.claudeOwnServers({ home, configDir: '', cwd, read: f => files[f] || null });
  assert.deepEqual(own, [
    'user:mobbin',
    'user:claude-wow',
    'local:localone',
    'project:claude-wow',
    'plugin:playwright:playwright',
    'plugin:proj:fromfile',
    'plugin:proj:inline',
  ]);
  assert.deepEqual(MC.claudeOwnServers({ home, configDir: '', cwd, read: () => null }), []);
});

test('Codex: default servers become -c mcp_servers entries with names of env vars, the codex allow list, auto-approval, and their env vars hidden from the shell', () => {
  const entries = MC.forCodex(parsed(SAMPLE, { GITHUB_TOKEN: SECRET, LINEAR_KEY: SECRET }).mcp);
  assert.deepEqual(
    entries.map(e => e.name),
    ['github', 'notion', 'linear'],
  );
  const c = (server, kv) => ['-c', `mcp_servers.${server}.${kv}`];
  assert.deepEqual(MC.codexArgs(entries), [
    ...c('github', 'command="npx"'),
    ...c('github', 'args=["-y","@modelcontextprotocol/server-github"]'),
    ...c('github', 'env_vars=["GITHUB_TOKEN"]'),
    ...c('github', 'enabled=true'),
    ...c('github', 'default_tools_approval_mode="approve"'),
    ...c('notion', 'url="https://mcp.notion.com/mcp"'),
    ...c('notion', 'enabled=true'),
    ...c('notion', 'enabled_tools=["search"]'),
    ...c('notion', 'default_tools_approval_mode="approve"'),
    ...c('linear', 'url="https://mcp.linear.app/mcp"'),
    ...c('linear', 'bearer_token_env_var="LINEAR_KEY"'),
    ...c('linear', 'enabled=true'),
    ...c('linear', 'enabled_tools=["list_issues"]'),
    ...c('linear', 'default_tools_approval_mode="approve"'),
    '-c',
    'shell_environment_policy.exclude=["GITHUB_TOKEN","LINEAR_KEY"]',
  ]);
  assert.equal(MC.forCodex(null).length, 0);
  assert.deepEqual(MC.codexArgs([]), []);
  assert.deepEqual(MC.codexArgs([{ name: 'd', server: { type: 'stdio', command: 'node', args: [] } }]).slice(-2), [
    '-c',
    'mcp_servers.d.default_tools_approval_mode="approve"',
  ]);
});

test('Codex: every value is a TOML string, so a number-looking argument, quotes, backslashes and a lone surrogate survive', () => {
  const args = MC.codexArgs([
    {
      name: 's',
      server: { type: 'stdio', command: 'C:\\Tools\\srv.exe', args: ['007', '1e3', 'say "hi"', 'true', 'a\u007fb', 'x\ud800y'] },
      envVars: [],
      enabledTools: [],
    },
  ]);
  assert.deepEqual(args, [
    '-c',
    'mcp_servers.s.command="C:\\\\Tools\\\\srv.exe"',
    '-c',
    'mcp_servers.s.args=["007","1e3","say \\"hi\\"","true","a\\u007fb","x\ufffdy"]',
    '-c',
    'mcp_servers.s.enabled=true',
    '-c',
    'mcp_servers.s.enabled_tools=[]',
    '-c',
    'mcp_servers.s.default_tools_approval_mode="approve"',
  ]);
});

test('Codex: the overrides go before exec, no env value reaches argv, and no mcp means the argv of before', () => {
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = SECRET;
  try {
    const overrides = MC.codexArgs(MC.forCodex(parsed(SAMPLE, process.env).mcp));
    const argv = A.AGENTS.codex.args({ cfg: {}, resume: 'thread-1', cwd: '/p', images: [], codexMcpArgs: overrides });
    const at = argv.indexOf('exec');
    assert.ok(overrides.length > 0 && at > 0);
    assert.deepEqual(argv.slice(0, at), overrides);
    assert.deepEqual(argv.slice(at), A.AGENTS.codex.args({ cfg: {}, resume: 'thread-1', cwd: '/p', images: [] }));
    assert.ok(!JSON.stringify(argv).includes(SECRET));
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('Codex: a server named like one in ~/.codex/config.toml is left out, since Codex would merge its url, auth and env into ours', () => {
  const toml = [
    '[mcp_servers.mobbin]',
    'url = "https://api.mobbin.com/mcp"',
    '[mcp_servers."quoted-one".env]',
    "  [ mcp_servers . 'single' ]",
    'mcp_servers.dotted.command = "x"',
    '[projects."/x"]',
    '# [mcp_servers.commented]',
  ].join('\n');
  const own = MC.codexOwnServers({ home: '/h', codexHome: '', readText: f => (f === path.join('/h', '.codex', 'config.toml') ? toml : '') });
  assert.deepEqual(own.sort(), ['dotted', 'mobbin', 'quoted-one', 'single']);
  assert.deepEqual(MC.codexOwnServers({ codexHome: '/ch', readText: f => (f === path.join('/ch', 'config.toml') ? '[mcp_servers.a]' : '') }), ['a']);
  assert.deepEqual(
    MC.codexOwnServers({
      readText: () => {
        throw new Error('ENOENT');
      },
    }),
    [],
  );
  const mcp = parsed(SAMPLE).mcp;
  assert.deepEqual(
    MC.forCodex(mcp, { own: ['notion'] }).map(e => e.name),
    ['github', 'linear'],
  );
});

test('per chat: mcp= carries overrides (+id, -id, -* for all off), a bad id is dropped, and at most 16 count', () => {
  const hex = s => Buffer.from(s, 'utf8').toString('hex');
  assert.equal(P.parseFlags('agent=claude').mcp, undefined, 'no token: the defaults');
  assert.deepEqual(P.parseFlags('mcp=-*').mcp, { allOff: true, on: [], off: [] });
  assert.deepEqual(P.parseFlags('mcp=+notion,-claude_ai_Slack,notion,-bad id,+a.b,-notion').mcp, { allOff: false, on: ['notion'], off: ['claude_ai_Slack'] });
  assert.equal(P.parseFlags(`mcp=${Array.from({ length: 20 }, (_, i) => `-s${i}`).join(',')}`).mcp.off.length, 17, 'all off plus 16 changes');
  assert.equal(P.parseFlags(`mcp=-*,${Array.from({ length: 20 }, (_, i) => `+s${i}`).join(',')}`).mcp.on.length, 16);
  const outbox = `ClaudeWoWDB = {\n["outbox"] = {\n["id"] = 3,\n["session"] = "s",\n["chat"] = "c",\n["text"] = "${hex('hi')}",\n["cwd"] = "",\n["opts"] = "${hex('mcp=-github')}",\n["t"] = 1,\n},\n}\n`;
  assert.deepEqual(P.parseOutbox(outbox).mcp, { allOff: false, on: [], off: ['github'] }, 'reload mode carries it too');

  const mcp = parsed(SAMPLE).mcp;
  const choice = v => MC.parseChoice(v);
  assert.deepEqual(
    MC.forClaude(mcp, { choice: choice('+quiet,-linear') }).names,
    ['github', 'notion', 'quiet'],
    'a chat can turn on a server that is off by default, and off one that is on',
  );
  const none = MC.forClaude(mcp, { choice: choice('-*,+github') });
  assert.deepEqual(none.names, ['github']);
  assert.equal(none.blocks('mcp__notion__notion-search'), true, 'a server the chat turned off is never offered, even a tool its allow list names');
  assert.deepEqual(none.offRules, ['mcp__notion', 'mcp__linear', 'mcp__quiet'], "and it is denied, so a same-name server of Claude's own settings is off too");
  assert.deepEqual(MC.forClaude(mcp).names, ['github', 'notion', 'linear']);
  assert.deepEqual(MC.forClaude(mcp).offRules, [], 'no choice: nothing extra is denied');
  assert.deepEqual(MC.forClaude(mcp, { choice: choice('+notion') }).offRules, [], 'a server off by default and untouched is not denied');

  const seen = ['mobbin', 'claude_ai_Slack', 'plugin_Notion_notion', 'notion'];
  const off = MC.discoveredOff(choice('-claude_ai_Slack,-notion'), seen, ['notion']);
  assert.deepEqual(off.rules, ['mcp__claude_ai_Slack'], 'a discovered server the chat turned off is denied; a configured name is left to forClaude');
  assert.equal(off.blocks('mcp__claude_ai_Slack__post'), true);
  assert.equal(off.blocks('mcp__mobbin__search'), false);
  assert.deepEqual(MC.discoveredOff(choice('-*,+mobbin'), seen, []).rules, ['mcp__claude_ai_Slack', 'mcp__plugin_Notion_notion', 'mcp__notion']);
  assert.deepEqual(MC.discoveredOff(undefined, seen, []).rules, [], 'no choice: Claude loads them as it always did');

  assert.deepEqual(
    MC.forCodex(mcp, { choice: choice('+quiet,-linear') }).map(e => e.name),
    ['github', 'notion', 'quiet'],
  );
  const own = MC.forCodex(mcp, { choice: choice('-notion,-mobbin,+node_repl'), own: ['notion', 'mobbin', 'elsewhere', 'node_repl'] });
  assert.deepEqual(
    own.map(e => e.name),
    ['github', 'linear', 'notion', 'mobbin', 'node_repl'],
    "a config.toml name is not defined again; Codex's own servers the chat turned off or on get enabled=false or true",
  );
  assert.deepEqual(MC.codexArgs(own.slice(-3)), [
    '-c',
    'mcp_servers.notion.enabled=false',
    '-c',
    'mcp_servers.mobbin.enabled=false',
    '-c',
    'mcp_servers.node_repl.enabled=true',
  ]);
  assert.deepEqual(
    MC.forCodex(null, { choice: choice('-*'), own: ['my.srv', 'ok'] }),
    [{ name: 'ok', off: true }],
    'a name that is not a plain id never reaches argv',
  );
  assert.deepEqual(MC.codexArgs([{ name: 'mobbin', off: true }]), ['-c', 'mcp_servers.mobbin.enabled=false']);
  assert.deepEqual(MC.forCodex(null, { own: ['mobbin'] }), [], 'no choice and no mcp key: Codex is untouched');
  assert.deepEqual(A.unsupportedSettings('grok', { mcp: choice('-x') }), ['mcp choice']);
  assert.deepEqual(A.unsupportedSettings('claude', { mcp: choice('-x') }), []);
  assert.equal(A.withChatSettings({}, 'claude', { mcp: choice('-x') }).mcp, undefined, 'the choice drives the server list, not an agent config key');
});

test('catalog: config servers first, then what Claude reported or its files list, then Codex; ids are rule prefixes and labels are readable', () => {
  const seen = MC.noteSeen({}, [
    { name: 'claude.ai Slack', status: 'connected', source: 'claudeai' },
    { name: 'plugin:Notion:notion', status: 'needs-auth', source: 'plugin' },
    { name: 'plugin:engineering:google calendar', status: 'failed', source: 'plugin' },
    { name: 'notion', status: 'connected', source: 'dynamic' },
    { name: 'wowdata', status: 'connected', source: 'dynamic' },
    { name: 'removed-from-config', status: 'connected', source: 'dynamic' },
    { name: 'mobbin', status: 'connected', source: 'user' },
  ]);
  MC.seedSeen(seen, ['user:mobbin', 'project:claude-wow', 'plugin:playwright:playwright']);
  const list = MC.catalog({ mcp: parsed(SAMPLE).mcp, seen, codexOwn: ['mobbin', 'node_repl'], reserved: ['wowdata'] });
  assert.deepEqual(list, [
    { id: 'github', label: 'github', src: 'config', on: true, health: 'unknown' },
    { id: 'notion', label: 'notion', src: 'config', on: true, health: 'connected' },
    { id: 'linear', label: 'linear', src: 'config', on: true, health: 'unknown' },
    { id: 'quiet', label: 'quiet', src: 'config', on: false, health: 'unknown' },
    { id: 'claude-wow', label: 'claude-wow', src: 'claude', on: true, health: 'unknown' },
    { id: 'plugin_engineering_google_calendar', label: 'google calendar (engineering)', src: 'plugin', on: true, health: 'failed' },
    { id: 'mobbin', label: 'mobbin', src: 'claude', on: true, health: 'connected' },
    { id: 'plugin_Notion_notion', label: 'Notion', src: 'plugin', on: true, health: 'needs-auth' },
    { id: 'plugin_playwright_playwright', label: 'playwright', src: 'plugin', on: true, health: 'unknown' },
    { id: 'claude_ai_Slack', label: 'Slack', src: 'claude.ai', on: true, health: 'connected' },
    { id: 'node_repl', label: 'node_repl', src: 'codex', on: true, health: 'unknown' },
  ]);
  const many = {};
  for (let i = 0; i < 70; i++) MC.noteSeen(many, [{ name: `s${i}`, status: 'connected', source: 'project' }], { cwd: `/p${i}`, now: i });
  assert.equal(Object.keys(many).length, 64, 'the seen list is bounded, oldest out');
  assert.ok(!many.s0 && many.s69);

  const lua = P.luaTable('X', [], {
    mcp: [
      { id: 'claude_ai_Slack', label: 'Slack|cff', src: 'claude.ai', on: true, health: 'connected' },
      { id: 'linear', label: 'linear', src: 'config', on: false, health: 'weird' },
      { id: 'bad id', label: 'x', src: 'claude', on: true, health: 'connected' },
      { id: 'x', label: 'x', src: 'elsewhere', on: true, health: 'connected' },
    ],
  });
  assert.match(
    lua,
    /^\tmcp = \{ \{ id = "claude_ai_Slack", label = "Slackcff", src = "claude.ai", on = true, health = "connected" \}, \{ id = "linear", label = "linear", src = "config", on = false, health = "unknown" \} \},$/m,
  );
  assert.match(P.luaTable('X', [], { mcp: [] }), /^\tmcp = \{ {2}\},$/m, 'a new bridge with no servers says so');
  assert.ok(!/mcp =/.test(P.luaTable('X', [], {})));
});

test('health: the Claude init event reports every server with its status', () => {
  const r = A.claudeParser().feed({
    type: 'system',
    subtype: 'init',
    mcp_servers: [{ name: 'notion', status: 'connected' }, { name: 'linear', status: 'needs-auth' }, { status: 'failed' }],
  });
  assert.deepEqual(r.mcpStatus, [
    { name: 'notion', status: 'connected', source: '' },
    { name: 'linear', status: 'needs-auth', source: '' },
  ]);
  assert.deepEqual(r.mcpDown, [
    { name: 'linear', status: 'needs-auth' },
    { name: '?', status: 'failed' },
  ]);
});

test('the seen list follows the latest report: a server gone from Claude is dropped, one from another folder is kept', () => {
  const seen = MC.seedSeen({}, ['user:mobbin', 'project:repo-a', 'plugin:p:gone'], { cwd: '/a' });
  assert.deepEqual(Object.keys(seen).sort(), ['mobbin', 'plugin_p_gone', 'repo-a']);
  MC.noteSeen(
    seen,
    [
      { name: 'repo-b', status: 'connected', source: 'project' },
      { name: 'claude.ai Slack', status: 'connected', source: 'claudeai' },
    ],
    { cwd: '/b', now: 5 },
  );
  assert.deepEqual(
    Object.keys(seen).sort(),
    ['claude_ai_Slack', 'repo-a', 'repo-b'],
    'user and plugin servers not reported again are gone; folder /a keeps its own',
  );
  MC.noteSeen(seen, [{ name: 'wowdata', status: 'connected', source: 'dynamic' }], { cwd: '/b', now: 6 });
  assert.ok(seen.claude_ai_Slack, 'a report with only our own servers (strict mode) drops nothing');
});
