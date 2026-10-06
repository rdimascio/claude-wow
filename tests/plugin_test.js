'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AS = require('../bridge/assets');
const DM = require('../bridge/datamcp');
const P = require('../bridge/protocol');

const ROOT = path.join(__dirname, '..');
const PLUGIN_REL = 'assets/plugins/claude-wow';
const PLUGIN = path.join(ROOT, PLUGIN_REL);
const AGENTS_DIR = path.join(PLUGIN, 'agents');
const WOWDATA_PREFIX = 'mcp__wowdata__';
const WOWDATA_TOOLS = new Set(DM.TOOLS.map(t => WOWDATA_PREFIX + t.name));
const BUILT_IN_TOOLS = new Set(['Read', 'WebSearch', 'WebFetch']);
const NEVER_FOR_AGENTS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];
const NEVER_WITH_WOWDATA = ['Bash', 'WebFetch'];
const MODELS = new Set(['sonnet', 'opus', 'haiku']);

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

function parseAgent(file) {
  const src = fs.readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(src);
  assert.ok(m, `${path.basename(file)} opens with a frontmatter block`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z-]+):\s*(.*)$/.exec(line);
    assert.ok(kv, `${path.basename(file)}: one key per frontmatter line, got "${line}"`);
    meta[kv[1]] = kv[2].trim();
  }
  const tools =
    meta.tools === undefined
      ? null
      : meta.tools
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
  return { file, name: path.basename(file, '.md'), meta, tools, body: m[2] };
}

function agents() {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => parseAgent(path.join(AGENTS_DIR, f)));
}

function agentNamed(name) {
  const a = agents().find(x => x.name === name);
  assert.ok(a, `the plugin has the ${name} agent`);
  return a;
}

test('the plugin manifest names claude-wow at the bridge version and the plugin holds agents only, with no MCP server or hook', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'claude-wow');
  assert.equal(manifest.version, pkg.version);
  for (const key of ['mcpServers', 'hooks', 'lspServers', 'commands']) assert.equal(manifest[key], undefined, `no ${key} in the manifest`);
  assert.deepEqual(fs.readdirSync(PLUGIN).sort(), ['.claude-plugin', 'agents']);
  assert.deepEqual(
    agents().map(a => a.name),
    ['wow-code', 'wow-planner'],
  );
});

test('the binary embeds every plugin file, so a release install has the plugin on disk', () => {
  const onDisk = filesUnder(PLUGIN)
    .map(f => path.relative(ROOT, f).split(path.sep).join('/'))
    .sort();
  const embedded = AS.FILES.filter(f => f.startsWith(PLUGIN_REL + '/')).sort();
  assert.deepEqual(embedded, onDisk);
  assert.equal(AS.dir(PLUGIN_REL), PLUGIN);
});

test('every agent names itself, says when to use it, pins a model and lists its tools', () => {
  for (const a of agents()) {
    assert.equal(a.meta.name, a.name, `${a.name}: name matches the file`);
    assert.ok(a.meta.description && a.meta.description.length > 40, `${a.name}: has a description`);
    assert.ok(MODELS.has(a.meta.model), `${a.name}: model ${a.meta.model} is a measured alias`);
    assert.ok(Array.isArray(a.tools) && a.tools.length > 0, `${a.name}: tools are listed, not inherited`);
    assert.ok(!a.tools.includes('*'), `${a.name}: no wildcard tool`);
  }
});

test('agents get no Write, Edit or Bash and never see the map file', () => {
  for (const a of agents()) {
    for (const t of NEVER_FOR_AGENTS) assert.ok(!a.tools.includes(t), `${a.name} must not get ${t}`);
    assert.doesNotMatch(a.body + a.meta.description, /CLAUDE_WOW_MAP_FILE/, `${a.name} is not told about the map file`);
  }
});

test('agents that read wowdata get no Bash and no WebFetch', () => {
  const readers = agents().filter(a => a.tools.some(t => t.startsWith(WOWDATA_PREFIX)));
  assert.ok(
    readers.some(a => a.name === 'wow-planner'),
    'wow-planner reads wowdata',
  );
  for (const a of readers) for (const t of NEVER_WITH_WOWDATA) assert.ok(!a.tools.includes(t), `${a.name} reads wowdata and must not get ${t}`);
});

test('every agent tool is a known built-in or a real wowdata tool under the name the bridge gives the server', () => {
  for (const a of agents()) {
    for (const t of a.tools) {
      if (t.startsWith('mcp__')) assert.ok(WOWDATA_TOOLS.has(t), `${a.name}: ${t} is not a wowdata tool`);
      else assert.ok(BUILT_IN_TOOLS.has(t), `${a.name}: ${t} is not an allowed built-in`);
    }
  }
});

test('wow-code carries the wowmacro contract, and its example is a macro the bridge offers as a button', () => {
  const a = agentNamed('wow-code');
  assert.match(a.meta.description, /wowmacro/);
  assert.match(a.meta.description, /verbatim/);
  const r = P.extractMacros(a.body);
  assert.equal(r.macros.length, 1, 'one example macro');
  assert.deepEqual(r.notes, []);
  assert.equal(r.macros[0].name, 'Charge');
});

test('wow-planner carries the wowmap contract, its example is a valid map command, and its kinds are the bridge kinds', () => {
  const a = agentNamed('wow-planner');
  assert.match(a.meta.description, /wowmap/);
  assert.match(a.meta.description, /verbatim/);
  const r = P.extractMapBlocks(a.body);
  assert.deepEqual(r.errors, []);
  assert.equal(r.cmds.length, 1, 'one example command');
  const why = [];
  const cmd = P.validateMapCommand(r.cmds[0], why);
  assert.deepEqual(why, []);
  assert.equal(cmd.op, 'set');
  assert.equal(cmd.points[0].kind, 'flight');
  const kinds = /kind is one of ([a-z, ]+)\./.exec(a.body);
  assert.ok(kinds, 'the body lists the kinds');
  for (const kind of kinds[1].split(',').map(s => s.trim())) {
    const point = P.validateMapCommand({ op: 'set', layer: 'k', points: [{ m: 1, x: 1, y: 1, kind }] });
    assert.equal(point.points[0].kind, kind, `${kind} is a bridge map kind`);
  }
});
