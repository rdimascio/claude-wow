'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { makeRoot, gameRunner } = require('./helpers');
const D = require('../../bridge/datasync');

const ROOT = makeRoot('codexmcp');
const withGame = gameRunner(ROOT);
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'wago');
const BUILD = '1.60.1.200';
const SECRET = 'codex_e2e_secret_value_never_on_argv';

function fixtureFetch(url) {
  const u = new URL(url);
  const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
  const headers = { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` };
  return Promise.resolve(new Response(fs.readFileSync(path.join(FIXTURES, `${table}.csv`), 'utf8'), { status: 200, headers }));
}

function fakeCodex(file, record) {
  const events = [
    { type: 'thread.started', thread_id: 'codex-thread-1' },
    { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'pong from codex' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
  ];
  fs.writeFileSync(
    file,
    `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume();\nprocess.stdin.on('end', () => process.stdout.write(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n') + '\n')}));\n`,
  );
}

function overrides(argv) {
  const out = {};
  argv.forEach((a, i) => {
    if (a !== '-c') return;
    const m = /^mcp_servers\.([^.]+)\.([^=]+)=(.*)$/s.exec(argv[i + 1]);
    if (m) (out[m[1]] = out[m[1]] || {})[m[2]] = JSON.parse(m[3]);
  });
  return out;
}

function callTool(server, name, args) {
  return new Promise((resolve, reject) => {
    const env = { HOME: process.env.HOME || '', PATH: process.env.PATH || '', TMPDIR: process.env.TMPDIR || '' };
    const child = spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          child.kill();
          resolve(msg.result);
        }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    child.on('error', reject);
    const send = m => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name, arguments: args } });
  });
}

test('an ask chat on Codex gets wowdata and the default mcp.servers as -c overrides with auto-approval, and no env value on argv', async () => {
  const record = path.join(ROOT, 'codex-argv.json');
  const fake = path.join(ROOT, 'fake-codex.js');
  fs.mkdirSync(ROOT, { recursive: true });
  fakeCodex(fake, record);
  const config = {
    agent: 'codex',
    agents: { codex: { path: fake } },
    mcp: {
      servers: {
        github: { command: 'npx', args: ['-y', 'server-github'], envVars: ['GITHUB_TOKEN'], allow: { claude: '*', codex: ['search_issues'] }, default: true },
        off: { command: 'npx', args: ['x'], allow: '*' },
        mobbin: { type: 'http', url: 'https://elsewhere.example/mcp', allow: '*', default: true },
      },
      allow: { node_repl: { codex: ['js'] } },
    },
  };
  const MOBBIN_TOML = '[mcp_servers.mobbin]\nurl = "https://api.mobbin.com/mcp"\nbearer_token_env_var = "MOBBIN_KEY"\n';
  let codexToml = '';
  const beforeLaunch = async sb => {
    await D.sync({ dataDir: path.join(sb.home, 'data'), build: BUILD, fetch: fixtureFetch });
    const codexHome = path.join(path.dirname(sb.home), 'user', '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    codexToml = path.join(codexHome, 'config.toml');
    fs.writeFileSync(codexToml, MOBBIN_TOML + '[mcp_servers.node_repl]\ncommand = "node"\n');
  };
  await withGame({ plugin: 'ask', config, beforeLaunch, env: { GITHUB_TOKEN: SECRET } }, async h => {
    const r = await h.client.say('what is item 501?');
    assert.equal(r.text, 'pong from codex');
    await h.bridge.waitForLine(/mcp\.servers\.mobbin: ~\/\.codex\/config\.toml has a server of the same name, .*so Codex runs leave this server out/);
    const started = await h.bridge.waitForLine(/Codex starting in .*wowdata 1\.60\.1\.200.*mcp github.*/);
    assert.ok(!started[0].includes('node_repl'), started[0]);
    const argv = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.ok(!JSON.stringify(argv).includes(SECRET));
    const servers = overrides(argv.slice(0, argv.indexOf('exec')));
    assert.deepEqual(Object.keys(servers), ['wowdata', 'github', 'node_repl']);
    assert.deepEqual(servers.node_repl, { enabled_tools: ['js'] }, 'mcp.allow reaches a config.toml server as enabled_tools only');
    assert.deepEqual(servers.github, {
      command: 'npx',
      args: ['-y', 'server-github'],
      env_vars: ['GITHUB_TOKEN'],
      enabled: true,
      enabled_tools: ['search_issues'],
      default_tools_approval_mode: 'approve',
    });
    assert.ok(argv.includes('shell_environment_policy.exclude=["GITHUB_TOKEN"]'), argv.join(' '));
    assert.equal(servers.wowdata.default_tools_approval_mode, 'approve');
    const result = await callTool(servers.wowdata, 'wow_item', { id: 501 });
    assert.match(JSON.stringify(result), /Fixture Blade/);

    fs.writeFileSync(codexToml, MOBBIN_TOML);
    const again = await h.client.say('and item 502?');
    assert.equal(again.text, 'pong from codex');
    const next = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.deepEqual(
      Object.keys(overrides(next.slice(0, next.indexOf('exec')))),
      ['wowdata', 'github'],
      'a server removed from config.toml while the bridge runs gets no -c table',
    );
  });
});
