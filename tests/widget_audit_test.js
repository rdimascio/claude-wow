'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../dev/widget-audit');

const FIXTURE = path.join(__dirname, 'fixtures', 'widget-audit', 'ClaudeWoW.lua');

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { out: line => out.push(line), err: line => err.push(line) } };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'widget-audit-'));
}

test('parseDump reads the globals the addon saved, past other tables and a quoted table name', () => {
  const dump = A.parseDump(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(dump.version, '1.15.9');
  assert.equal(dump.build, '64000');
  assert.equal(dump.interface, 11509);
  assert.equal(dump.at, 1790000000);
  assert.equal(dump.total, 11);
  assert.equal(dump.saved, 11);
  assert.equal(dump.admittedCount, 6);
  assert.equal(dump.refusedCount, 5);
  assert.equal(dump.truncated, false);
  assert.deepEqual(dump.admitted, ['C_Fake.GetThing', 'GameFontNormal', 'GetTime', 'PlaySound', 'UnitHealth', 'UnitSelectRole']);
  assert.deepEqual(dump.refused, ['C_Fake.DropThing', 'C_Map.GetBestMapForUnit', 'GetSecretThing', 'IsAuditReady', 'UnitSetRole']);
});

test('parseDump reads the unindented CRLF layout the headless dev client writes', () => {
  const text = [
    '',
    'ClaudeWoWDB = {',
    '["chats"] = {',
    '{',
    '["id"] = 1,',
    '},',
    '},',
    '}',
    'ClaudeWoWWidgetDB = {',
    '["globals"] = {',
    '["admitted"] = {',
    '"GetTime",',
    '},',
    '["refused"] = {',
    '"SetThing",',
    '},',
    '["truncated"] = true,',
    '["version"] = "1.15.9",',
    '},',
    '}',
    '',
  ].join('\r\n');
  const dump = A.parseDump(text);
  assert.deepEqual(dump.admitted, ['GetTime']);
  assert.deepEqual(dump.refused, ['SetThing']);
  assert.equal(dump.truncated, true);
  assert.equal(dump.build, '?');
});

test('parseDump returns null with no widget table or no globals, and throws on a broken table', () => {
  assert.equal(A.parseDump(''), null);
  assert.equal(A.parseDump('ClaudeWoWDB = {\n}\n'), null);
  assert.equal(A.parseDump('ClaudeWoWWidgetDB = {\n\t["removed"] = {\n\t},\n}\n'), null);
  assert.equal(A.parseDump('ClaudeWoWWidgetDB = {\n\t["globals"] = "x",\n}\n'), null);
  assert.equal(A.parseDump('ClaudeWoWWidgetDB = {\n\t["globals"] = {\n\t},\n'), null);
  assert.throws(() => A.parseDump('ClaudeWoWWidgetDB = {\n\t["globals"] = {{{\n}\n'), /cannot parse ClaudeWoWWidgetDB/);
});

test('the audit flags admitted writers and refused getters', () => {
  const report = A.audit(A.parseDump(fs.readFileSync(FIXTURE, 'utf8')));
  assert.deepEqual(report.admittedWriters, ['PlaySound', 'UnitSelectRole']);
  assert.deepEqual(report.missedGetters, ['C_Map.GetBestMapForUnit', 'GetSecretThing', 'IsAuditReady']);
  assert.equal(report.missedFonts, undefined);
  assert.deepEqual(report.client, { version: '1.15.9', build: '64000', interface: 11509, at: 1790000000 });
  assert.deepEqual(report.counts, { total: 11, saved: 11, admitted: 6, refused: 5, truncated: false });
});

test('verbs come from the member after a C_ namespace or a Unit prefix', () => {
  assert.equal(A.verbOf('C_Map.GetBestMapForUnit'), 'Get');
  assert.equal(A.verbOf('UnitSetRole'), 'Set');
  assert.equal(A.verbOf('UnitHealth'), 'Health');
  assert.equal(A.verbOf('Unit'), 'Unit');
  assert.equal(A.verbOf('GetTime'), 'Get');
  assert.equal(A.verbOf('debugprofilestop'), '');
  assert.equal(A.looksLikeWriter('C_Container.UseContainerItem'), true);
  assert.equal(A.looksLikeWriter('UnitHealth'), false);
  assert.equal(A.looksLikeGetter('UnitHealth'), true);
  assert.equal(A.looksLikeGetter('UnitSetRole'), false);
  assert.equal(A.looksLikeGetter('C_Fake.DropThing'), false);
});

test('the text report names the client and lists each section', () => {
  const report = A.audit(A.parseDump(fs.readFileSync(FIXTURE, 'utf8')));
  const text = A.formatReport(report, FIXTURE);
  assert.match(text, /^widget allowlist audit: .*ClaudeWoW\.lua$/m);
  assert.match(text, /^client 1\.15\.9 \(64000\), interface 11509, dumped 2026-09-21T/m);
  assert.match(text, /^11 of 11 names saved: 6 a widget can use, 5 it cannot$/m);
  assert.doesNotMatch(text, /was cut/);
  assert.match(text, /admitted names that look like writers or actions \(check each\): 2\n {2}PlaySound\n {2}UnitSelectRole/);
  assert.match(text, /refused names that look like display getters \(candidates to admit\): 3\n {2}C_Map\.GetBestMapForUnit/);
  assert.doesNotMatch(text, /font objects/);
});

test('a long section is cut unless --all, a cut dump says so, and a bad time is unknown', () => {
  const names = Array.from({ length: 70 }, (_, i) => `GetThing${String(i).padStart(2, '0')}`);
  const report = A.audit({
    version: '1',
    build: '2',
    interface: 3,
    at: 9e15,
    total: 9000,
    saved: 6000,
    admittedCount: 0,
    refusedCount: 9000,
    truncated: true,
    admitted: [],
    refused: names,
  });
  const cut = A.formatReport(report, 'f');
  assert.match(cut, /dumped unknown time/);
  assert.match(cut, /the dump was cut at 6000 names/);
  assert.match(cut, /GetThing59\n {2}\.\.\. 10 more \(--all lists them\)/);
  assert.doesNotMatch(cut, /GetThing60/);
  const all = A.formatReport(report, 'f', Infinity);
  assert.match(all, /GetThing69$/m);
  assert.doesNotMatch(all, /more \(--all/);
});

test('main reports a named file as text or JSON and exits 0', () => {
  const text = capture();
  assert.equal(A.main([FIXTURE], text.io), 0);
  assert.equal(text.err.length, 0);
  assert.match(text.out.join('\n'), /admitted names that look like writers/);
  const json = capture();
  assert.equal(A.main([FIXTURE, '--json'], json.io), 0);
  const parsed = JSON.parse(json.out.join('\n'));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].file, FIXTURE);
});

test('main exits 2 with a hint when a file is missing, has no dump, or cannot be parsed', () => {
  const dir = tempDir();
  try {
    const empty = path.join(dir, 'empty.lua');
    fs.writeFileSync(empty, 'ClaudeWoWWidgetDB = {\n}\n');
    const broken = path.join(dir, 'broken.lua');
    fs.writeFileSync(broken, 'ClaudeWoWWidgetDB = {\n\t["globals"] = {{{\n}\n');
    const r = capture();
    assert.equal(A.main([path.join(dir, 'missing.lua'), empty, broken], r.io), 2);
    assert.equal(r.out.length, 0);
    assert.match(r.err[0], /missing\.lua: cannot read \(ENOENT\)/);
    assert.match(r.err[1], /empty\.lua: no saved global names\. Type \/claude dev globals in game, then \/reload\./);
    assert.match(r.err[2], /broken\.lua: cannot parse ClaudeWoWWidgetDB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('main with no file reads every client in the bridge config, and says so when there is none', () => {
  const dir = tempDir();
  try {
    const game = path.join(dir, 'World of Warcraft', '_classic_era_');
    const saved = path.join(game, 'WTF', 'Account', 'ACC', 'SavedVariables', 'ClaudeWoW.lua');
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    fs.copyFileSync(FIXTURE, saved);
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const env = { CLAUDE_WOW_HOME: home };
    const none = capture();
    assert.equal(A.main([], { ...none.io, env }), 2);
    assert.match(none.err[0], /No SavedVariables file/);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ clients: [{ dir: game, account: 'ACC' }] }));
    assert.deepEqual(A.savedFiles(env), [saved]);
    const r = capture();
    assert.equal(A.main([], { ...r.io, env }), 0);
    assert.match(r.out[0], new RegExp(`^widget allowlist audit: ${saved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--help prints the usage and reads nothing', () => {
  const r = capture();
  assert.equal(A.main(['--help'], { ...r.io, env: { CLAUDE_WOW_HOME: path.join(os.tmpdir(), 'widget-audit-none') } }), 0);
  assert.equal(r.out[0], A.USAGE);
});
