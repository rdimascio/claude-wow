'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');
const P = require('../bridge/protocol');
const S = require('../bridge/service');
const Checks = require('../dev/doctor/checks');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'addon', 'ClaudeWoW');
const TOC_VERSION = /^##\s*Version:\s*(\S+)/m.exec(fs.readFileSync(path.join(ADDON, 'ClaudeWoW.toc'), 'utf8'))[1];
const PACKAGE_VERSION = require('../package.json').version;

const LOAD_COUNTER_STUB = `
STUB.loads = 0
local plainLoad = C_AddOns.LoadAddOn
C_AddOns.LoadAddOn = function(name)
  STUB.loads = STUB.loads + 1
  return plainLoad(name)
end
`;

function newVM({ prelude = '', beforeLogin = '' } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = code => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = expr => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  run(LOAD_COUNTER_STUB);
  if (prelude) run(prelude);
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'));
  run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  if (beforeLogin) run(beforeLogin);
  run('STUB.FireEvent("PLAYER_LOGIN")');
  return { run, evaluate, num: expr => Number(evaluate(expr)) };
}

const luaBridge = b => (b ? `, bridge = { version = "${b.version}", protoMin = ${b.protoMin}, protoMax = ${b.protoMax} }` : '');

function helloPoll(vm, bridge, nowLua = 'time()', extra = '') {
  vm.run('STUB.RunTimers()');
  const before = vm.num('STUB.loads');
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = ${nowLua}, cwd = "", replies = {}${luaBridge(bridge)}${extra} } end`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.ok(vm.num('STUB.loads') > before, 'the hello poll read a slot');
}

function slotPoll(vm, bridge, nowLua = 'time()', extra = '') {
  const before = vm.num('STUB.loads');
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = ${nowLua}, cwd = "", replies = {}${luaBridge(bridge)}${extra} } end`);
  vm.run('STUB.now = STUB.now + 601; STUB.Tick()');
  assert.equal(vm.num('STUB.loads'), before + 1, 'the idle poll read one slot');
}

function told(vm, needle) {
  vm.run(
    `STUB.found = 0; for _, c in ipairs(ClaudeWoWDB.chats) do for _, m in ipairs(c.history) do if m.role == "system" and m.text:find(${JSON.stringify(needle)}, 1, true) then STUB.found = STUB.found + 1 end end end`,
  );
  return vm.num('STUB.found');
}

const bridgeAt = (version, protoMin = P.PROTO_MIN, protoMax = P.PROTO_MAX) => ({ version, protoMin, protoMax });

test('a reload-mode message carries ver= and proto= in its outbox, so the bridge judges a session that never says hello', () => {
  const vm = newVM({ beforeLogin: `ClaudeWoW.Version.PROTO = ${P.PROTO + 1}` });
  vm.run('SlashCmdList.CLAUDE("config mode reload")');
  vm.run('ClaudeWoW.Send("via reload")');
  const out = name => vm.evaluate(`ClaudeWoWDB.outbox.${name}`);
  const saved = `ClaudeWoWDB = { ["outbox"] = { ["id"] = ${out('id')}, ["session"] = "${out('session')}", ["chat"] = "${out('chat')}", ["text"] = "${out('text')}", ["opts"] = "${out('opts')}" } }`;
  const job = P.parseOutbox(saved);
  assert.equal(job.addonVersion, TOC_VERSION);
  assert.equal(job.addonProto, P.PROTO + 1);
  assert.equal(job.text, 'via reload');
  const state = {};
  assert.equal(P.addonRefusal(state, job), '', 'no record yet');
  P.noteAddonVersion(state, job);
  assert.match(P.addonRefusal(state, job), /The companion app \(.*\) is too old for this addon/);
});

test('verdicts: equal, the older side by semver, different builds, either side out of the protocol range, and an old addon', () => {
  const b = bridgeAt('1.4.0', 2, 3);
  const cases = [
    [{ version: '1.4.0', proto: 2 }, 'equal', false],
    [{ version: '1.3.9', proto: 2 }, 'addon-older', false],
    [{ version: '1.10.0', proto: 3 }, 'bridge-older', false],
    [{ version: '1.4.0-beta', proto: 2 }, 'differs', false],
    [{ version: '1.4.0', proto: 1 }, 'update-addon', true],
    [{ version: '1.4.0', proto: 4 }, 'update-bridge', true],
    [{ version: '', proto: null }, 'update-addon', true],
  ];
  for (const [addon, verdict, refuse] of cases) {
    const v = P.versionVerdict(addon, b);
    assert.equal(v.verdict, verdict, JSON.stringify(addon));
    assert.equal(v.refuse, refuse, JSON.stringify(addon));
    assert.equal(v.text === '', verdict === 'equal', JSON.stringify(addon));
  }
  assert.equal(
    P.versionVerdict({ version: '', proto: null }, bridgeAt('1.4.0', 1, 1)).verdict,
    'unknown',
    'an addon from before the handshake speaks protocol 1',
  );
  assert.match(P.versionVerdict({ version: '1.4.0', proto: 1 }, b).text, /CurseForge.*claude-wow setup, then type \/reload\./);
  assert.match(P.versionVerdict({ version: '1.4.0', proto: 4 }, b).text, /brew upgrade claude-wow.*claude-wow service restart/);
});

test('the addon says the same words as the bridge for every verdict', () => {
  const cases = [
    [bridgeAt(TOC_VERSION), 'equal'],
    [bridgeAt('99.0.0'), 'addon-older'],
    [bridgeAt('0.0.1'), 'bridge-older'],
    [bridgeAt(TOC_VERSION + '-dev'), 'differs'],
    [bridgeAt(TOC_VERSION, P.PROTO + 1, P.PROTO + 2), 'update-addon'],
  ];
  const vm = newVM();
  for (const [b, verdict] of cases) {
    vm.run(`STUB.v, STUB.t = ClaudeWoW.Version.Verdict({ version = "${b.version}", protoMin = ${b.protoMin}, protoMax = ${b.protoMax} })`);
    const js = P.versionVerdict({ version: TOC_VERSION, proto: P.PROTO }, b);
    assert.equal(js.verdict, verdict);
    assert.equal(vm.evaluate('STUB.v'), js.verdict, b.version);
    assert.equal(vm.evaluate('STUB.t'), js.text, b.version);
  }
  vm.run('ClaudeWoW.Version.PROTO = 5');
  vm.run('STUB.v, STUB.t = ClaudeWoW.Version.Verdict({ version = "1.0.0", protoMin = 1, protoMax = 4 })');
  const js = P.versionVerdict({ version: TOC_VERSION, proto: 5 }, bridgeAt('1.0.0', 1, 4));
  assert.equal(vm.evaluate('STUB.v'), 'update-bridge');
  assert.equal(vm.evaluate('STUB.t'), js.text);
});

test('the bridge refuses a session whose hello is outside its protocol range and runs the rest', () => {
  const state = {};
  const b = bridgeAt('1.4.0', 2, 3);
  P.noteAddonVersion(state, { session: 'old', addonVersion: '1.0.0', addonProto: 1 }, b, 1);
  P.noteAddonVersion(state, { session: 'new', addonVersion: '2.0.0', addonProto: 4 }, b, 2);
  P.noteAddonVersion(state, { session: 'ok', addonVersion: '1.3.0', addonProto: 3 }, b, 3);
  P.noteAddonVersion(state, { session: 'legacy' }, b, 4);
  assert.match(
    P.addonRefusal(state, { session: 'old' }, b),
    /This addon \(1\.0\.0, protocol 1\) is too old for the companion app \(1\.4\.0, protocol 2 to 3\)/,
  );
  assert.match(
    P.addonRefusal(state, { session: 'new' }, b),
    /The companion app \(1\.4\.0, protocol 2 to 3\) is too old for this addon \(2\.0\.0, protocol 4\)/,
  );
  assert.equal(P.addonRefusal(state, { session: 'ok' }, b), '', 'only semver differs: no refusal');
  assert.match(P.addonRefusal(state, { session: 'legacy' }, b), /version unknown, protocol 1/, 'an addon without the token is protocol 1');
  assert.equal(P.addonRefusal(state, { session: 'never-said-hello' }, b), '', 'no hello on record: no refusal');
  assert.equal(P.addonRefusal(state, { session: 'old' }, bridgeAt('1.5.0', 1, 3)), '', 'a widened bridge re-judges the stored hello');
  assert.equal(state.addons.legacy.proto, null);
});

test('the hello record says when it changed, and keeps at most the newest sessions', () => {
  const state = {};
  const b = bridgeAt('1.4.0', 1, 1);
  assert.equal(P.noteAddonVersion(state, { session: 's', addonVersion: '1.4.0', addonProto: 1 }, b, 1).changed, true);
  assert.equal(P.noteAddonVersion(state, { session: 's', addonVersion: '1.4.0', addonProto: 1 }, b, 2).changed, false);
  assert.equal(P.noteAddonVersion(state, { session: 's', addonVersion: '1.4.1', addonProto: 1 }, b, 3).changed, true);
  for (let i = 0; i < P.ADDON_VERSIONS_MAX + 4; i++) P.noteAddonVersion(state, { session: 'x' + i, addonVersion: '1.4.0', addonProto: 1 }, b, 10 + i);
  assert.equal(Object.keys(state.addons).length, P.ADDON_VERSIONS_MAX);
  assert.ok(state.addons['x' + (P.ADDON_VERSIONS_MAX + 3)], 'the newest is kept');
  assert.equal(state.addons.s, undefined, 'the oldest is dropped');
});

test('service status and the doctor show both versions and the verdict of the last hello', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wow-versions-'));
  try {
    const state = {};
    P.noteAddonVersion(state, { session: 's', addonVersion: '0.3.0', addonProto: 9 }, bridgeAt('0.4.0', 1, 1), Date.UTC(2026, 9, 2));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    const lines = [];
    fs.writeFileSync(path.join(dir, 'bridge.log'), '');
    S.status(
      { run: dir, logs: dir, definition: path.join(dir, 'none.plist') },
      'darwin',
      l => lines.push(l),
      path.join(dir, 'state.json'),
      path.join(dir, 'config.json'),
    );
    const line = lines.find(l => l.startsWith('  versions  :'));
    assert.match(line, /addon 0\.3\.0 \(protocol 9\), bridge 0\.4\.0 \(protocol 1\): update-bridge, at the last hello 2026-10-02T00:00:00\.000Z/);
    assert.match(line, new RegExp(`this install is bridge ${PACKAGE_VERSION.replace(/\./g, '\\.')}`));
    const r = Checks.checkVersions({ state });
    assert.equal(r.status, 'fail');
    assert.match(r.summary, /update-bridge/);
    assert.match(r.problems[0].what, /The companion app \(0\.4\.0, protocol 1\) is too old for this addon/);
    const fine = {};
    P.noteAddonVersion(fine, { session: 's', addonVersion: '0.4.0', addonProto: 1 }, bridgeAt('0.4.0', 1, 1), 5);
    assert.equal(Checks.checkVersions({ state: fine }).status, 'ok');
    assert.equal(Checks.checkVersions({ state: {} }).summary, `no hello with versions yet; this install is bridge ${PACKAGE_VERSION} (protocol ${P.PROTO})`);
    for (const at of ['yesterday', 1e20, undefined]) {
      assert.match(P.versionsSummary({ addons: { s: { ...fine.addons.s, at } } }), /: equal$/, `a bad time (${at}) in state.json does not throw`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bridge whose protocol range is above the addon: the addon is told to update, once', () => {
  const vm = newVM();
  helloPoll(vm, bridgeAt(TOC_VERSION, P.PROTO + 1, P.PROTO + 1));
  slotPoll(vm, bridgeAt(TOC_VERSION, P.PROTO + 1, P.PROTO + 1));
  assert.equal(told(vm, 'is too old for the companion app'), 1);
  assert.equal(told(vm, 'CurseForge app or run claude-wow setup'), 1);
});

const BUILD_A = 'aaaaaaaaaaaa';
const BUILD_B = 'bbbbbbbbbbbb';
const luaDisk = (version, build = '') => `, addonDisk = { version = "${version}", build = "${build}" }`;
const loadedAs = (version, build) => ({
  prelude: `STUB.addonMeta = { ClaudeWoW = { Version = ${version === null ? 'nil' : `"${version}"`}${build ? `, ["X-Build"] = "${build}"` : ''} } }`,
});

test('the build hash covers every shipped file but the toc, in any order', () => {
  const files = [
    { name: 'B.lua', data: Buffer.from('b') },
    { name: 'A.lua', data: Buffer.from('a') },
    { name: 'ClaudeWoW.toc', data: Buffer.from('x') },
  ];
  const build = P.addonBuild(files);
  assert.match(build, P.BUILD_RE);
  assert.equal(P.addonBuild([...files].reverse()), build);
  assert.equal(
    P.addonBuild(files.map(f => (f.name.endsWith('.toc') ? { ...f, data: Buffer.from('changed') } : f))),
    build,
    'the toc carries the build, so it is not in it',
  );
  assert.notEqual(P.addonBuild(files.map(f => (f.name === 'A.lua' ? { ...f, data: Buffer.from('a2') } : f))), build);
  assert.notEqual(P.addonBuild(files.map(f => (f.name === 'A.lua' ? { ...f, name: 'A2.lua' } : f))), build, 'a renamed file in the same order is a new build');
});

test('the toc gets one X-Build line after its Version line, and the bridge reads both back', () => {
  const toc = '## Interface: 11509\n## Version: 1.2.3\n## Title: X\nA.lua\n';
  const once = P.tocWithBuild(toc, BUILD_A);
  assert.equal(once, '## Interface: 11509\n## Version: 1.2.3\n## X-Build: aaaaaaaaaaaa\n## Title: X\nA.lua\n');
  assert.equal(P.tocWithBuild(once, BUILD_B), once.replace(BUILD_A, BUILD_B), 'a new install replaces the line');
  assert.equal(P.tocWithBuild(toc.replace(/\n/g, '\r\n'), BUILD_A), once.replace(/\n/g, '\r\n'), 'CRLF stays CRLF');
  assert.equal(P.tocWithBuild('A.lua\n', BUILD_A), '## X-Build: aaaaaaaaaaaa\nA.lua\n');
  assert.deepEqual(P.addonDiskInfo(once), { version: '1.2.3', build: BUILD_A });
  assert.deepEqual(P.addonDiskInfo(once.replace(/\n/g, '\r\n')), { version: '1.2.3', build: BUILD_A });
  assert.deepEqual(P.addonDiskInfo('## Version: x\n## X-Build: nothex\n'), { version: '', build: '' });
});

test('slot files carry the addon toc on disk, and none without a version', () => {
  assert.match(
    P.luaTable('ClaudeWoW_SlotData', [], { now: 1000, addonDisk: { version: '1.2.3', build: BUILD_A } }),
    /\taddonDisk = \{ version = "1\.2\.3", build = "aaaaaaaaaaaa" \},/,
  );
  assert.doesNotMatch(P.luaTable('ClaudeWoW_SlotData', [], { now: 1000, addonDisk: { version: '', build: '' } }), /addonDisk/);
  assert.doesNotMatch(P.luaTable('ClaudeWoW_SlotData', [], { now: 1000, addonDisk: null }), /addonDisk/);
});

test('a field written after this load but more than 5 minutes ago (a dark bridge) is skipped', () => {
  const vm = newVM(loadedAs('1.2.3', BUILD_A));
  helloPoll(vm, null, 'time()', luaDisk('1.2.3', BUILD_A));
  vm.run('STUB.now = STUB.now + 1200');
  slotPoll(vm, null, 'time() - 900', luaDisk('1.2.3', BUILD_B));
  assert.equal(vm.evaluate('ClaudeWoW.Version.Notice()'), null);
  slotPoll(vm, null, 'time()', luaDisk('1.2.3', BUILD_B));
  assert.equal(vm.evaluate('ClaudeWoW.Version.Notice()'), 'Addon update ready · 1.2.3 build bbbbbbbbbbbb', 'a fresh one is read');
});

test('new addon files show as an update bar with a Reload button, not as a message in the chat', () => {
  const vm = newVM(loadedAs('1.2.3', BUILD_A));
  vm.run('ClaudeWoW.Toggle(true)');
  helloPoll(vm, null, 'time()', luaDisk('1.2.3', BUILD_A));
  assert.equal(vm.evaluate('ClaudeWoWNoticeBar:IsShown()'), 'false', 'the build that is loaded shows no bar');
  slotPoll(vm, null, 'time()', luaDisk('1.2.4', BUILD_B));
  assert.equal(told(vm, 'New addon files'), 0, 'the transcript gets no system message');
  assert.equal(vm.evaluate('ClaudeWoWNoticeBar:IsShown()'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWNoticeBar.text:GetText()'), 'Addon update ready · 1.2.4');
  slotPoll(vm, null, 'time()', luaDisk('1.2.3', BUILD_B));
  assert.equal(
    vm.evaluate('ClaudeWoWNoticeBar.text:GetText()'),
    'Addon update ready · 1.2.3 build bbbbbbbbbbbb',
    'a new build of the loaded version names the build',
  );
  slotPoll(vm, null, 'time()', luaDisk('1.2.3', BUILD_A));
  assert.equal(vm.evaluate('ClaudeWoWNoticeBar:IsShown()'), 'false', 'the loaded build back on disk clears the bar');
  slotPoll(vm, null, 'time()', luaDisk('1.2.4', BUILD_B));
  assert.equal(vm.evaluate('ClaudeWoWNoticeBar:IsShown()'), 'true', 'and a later update shows it again');
  vm.run('ClaudeWoWNoticeReload.scripts.OnClick(ClaudeWoWNoticeReload)');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true', 'the button reloads the UI from the click');
});

test('a runtime folder installed after launch asks for a full restart, once', () => {
  const vm = newVM({ prelude: 'STUB.addonMissing = { ClaudeWoW_Runtime = true }' });
  helloPoll(vm, null, 'time()', luaDisk(TOC_VERSION));
  slotPoll(vm, null, 'time()', luaDisk(TOC_VERSION));
  assert.equal(told(vm, 'The ClaudeWoW_Runtime addon was installed after the game started. Fully quit and restart the game'), 1);
  const present = newVM();
  helloPoll(present, null, 'time()', luaDisk(TOC_VERSION));
  assert.equal(told(present, 'restart the game'), 0);
});

const luaClients = rows =>
  `, clients = { ${rows
    .map(
      r =>
        `{ ${Object.entries(r)
          .map(([k, v]) => `${k} = ${typeof v === 'string' && k !== 'heard' ? JSON.stringify(v) : v}`)
          .join(', ')} }`,
    )
    .join(', ')} }`;
const ERA = { name: '_classic_era_', version: '1.2.3', build: BUILD_A, heard: 'time() - 120', here: true, last: true };
const FOREVER = { name: '_classic_beta_', version: '1.2.2', build: BUILD_B, heard: 0 };
const clientsStatus = vm => vm.evaluate('ClaudeWoW.Version.ClientsStatus()');

test('the bridge writes one clients row per client, marks this one and the last speaker, and drops a malformed build', () => {
  const lua = P.luaTable('ClaudeWoW_SlotData', [], {
    now: 1000,
    clients: [
      { name: '_classic_era_', version: '1.2.3', build: BUILD_A, heard: 900.7, here: true, last: true },
      { name: '_classic_beta_', version: '', build: 'not-a-build', heard: -5 },
    ],
  });
  assert.match(
    lua,
    /\tclients = \{ \{ name = "_classic_era_", version = "1\.2\.3", build = "aaaaaaaaaaaa", heard = 900, here = true, last = true \}, \{ name = "_classic_beta_", version = "", build = "", heard = 0 \} \},/,
  );
  assert.match(P.luaTable('ClaudeWoW_SlotData', [], { now: 1000, clients: [] }), /\tclients = \{  \},/, 'a bridge with no client still sends the field');
  assert.doesNotMatch(P.luaTable('ClaudeWoW_SlotData', [], { now: 1000 }), /clients =/);
});

test('diag shows every client with its build, which one this is and which spoke last, from a slot read', () => {
  const vm = newVM();
  assert.equal(clientsStatus(vm), 'clients: not reported (an older bridge, or not heard yet)');
  helloPoll(vm, null, 'time()', luaClients([ERA, FOREVER]));
  assert.equal(
    clientsStatus(vm),
    'clients: _classic_era_ (this client): 1.2.3 build aaaaaaaaaaaa, heard 2m00s ago, spoke last; _classic_beta_: 1.2.2 build bbbbbbbbbbbb, not heard yet',
  );
  vm.run('SlashCmdList.CLAUDEWOW("diag")');
  assert.equal(told(vm, 'clients: _classic_era_ (this client): 1.2.3 build aaaaaaaaaaaa'), 1, 'the line is part of /claude diag');
  slotPoll(vm, null, 'time()', luaClients([]));
  assert.equal(clientsStatus(vm), "clients: none in the bridge's config.json", 'an explicit empty list replaces the old one');
});
