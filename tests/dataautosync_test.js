'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const DAS = require('../bridge/dataautosync');
const D = require('../bridge/datasync');
const GD = require('../bridge/gamedata');

const FIXTURES = path.join(__dirname, 'fixtures', 'wago');
const PRELOAD = path.join(__dirname, 'fixtures', 'fake-wago-fetch.js');
const REPO = path.join(__dirname, '..');
const OLD = '1.60.1.200';
const NEW = '1.60.1.70245';
const ERA = '1.15.9.70003';
const T0 = Date.parse('2026-10-07T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function scratch(name) {
  const dir = path.join(os.tmpdir(), `claude-wow-autosync-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fixtureFetch(url) {
  const u = new URL(url);
  const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname)[1];
  const headers = { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${table}.${u.searchParams.get('build')}.csv"` };
  return Promise.resolve(new Response(fs.readFileSync(path.join(FIXTURES, `${table}.csv`), 'utf8'), { status: 200, headers }));
}

async function withData(build, flavor = 'forever') {
  const dataDir = path.join(scratch('data'), 'data');
  if (build) await D.sync({ dataDir, flavor, build, fetch: fixtureFetch });
  return dataDir;
}

function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness({ dataDir, enabled = true, run, state = {}, now = () => T0 }) {
  const lines = [];
  let saves = 0;
  const calls = [];
  const sync = DAS.createAutoSync({
    enabled,
    dataDir,
    home: path.dirname(dataDir),
    state: () => state,
    save: () => {
      saves++;
    },
    log: line => lines.push(line),
    now,
    run: args => {
      calls.push(args);
      return run(args);
    },
  });
  return { sync, lines, calls, state, saves: () => saves };
}

test('settings: unset and true turn it on, false turns it off, anything else is ignored with a note', () => {
  assert.deepEqual(DAS.settings({}), { enabled: true, note: '' });
  assert.deepEqual(DAS.settings(undefined), { enabled: true, note: '' });
  assert.deepEqual(DAS.settings({ data: { autoSync: true } }), { enabled: true, note: '' });
  assert.deepEqual(DAS.settings({ data: { autoSync: false } }), { enabled: false, note: '' });
  for (const bad of ['no', 0, null, { on: true }]) {
    const s = DAS.settings({ data: { autoSync: bad } });
    assert.equal(s.enabled, true, JSON.stringify(bad));
    assert.match(s.note, /^data\.autoSync: .* is not true or false, so it is ignored and game data sync stays on$/);
  }
  assert.deepEqual(DAS.settings({ data: 'off' }), { enabled: true, note: '' });
  assert.ok(DAS.settings({ data: { autoSync: 'x'.repeat(500) } }).note.length < 160);
});

test('decide: exact data needs no sync; family, mismatch and no data do', async () => {
  const exact = await withData(NEW);
  assert.equal(GD.buildCheckFor(NEW, NEW), GD.BUILD_CHECK.exact);
  assert.deepEqual(DAS.decide({ clientBuild: NEW, dataDir: exact, now: T0 }), {
    flavor: 'forever',
    build: NEW,
    dataBuild: NEW,
    check: 'exact',
    sync: false,
    reason: 'exact',
  });
  const family = await withData(OLD);
  const f = DAS.decide({ clientBuild: NEW, dataDir: family, now: T0 });
  assert.equal(f.sync, true);
  assert.equal(f.check, 'family');
  assert.equal(f.dataBuild, OLD);
  const m = DAS.decide({ clientBuild: '1.60.2.10', dataDir: family, now: T0 });
  assert.equal(m.sync, true);
  assert.equal(m.check, GD.BUILD_CHECK.mismatch);
  const none = DAS.decide({ clientBuild: NEW, dataDir: await withData(null), now: T0 });
  assert.equal(none.sync, true);
  assert.equal(none.check, GD.BUILD_CHECK.noData);
  assert.equal(none.dataBuild, null);
});

test('decide: the client build picks the flavor, and a build of no known game is never synced', async () => {
  const dataDir = await withData(NEW);
  const era = DAS.decide({ clientBuild: ERA, dataDir, now: T0 });
  assert.equal(era.flavor, 'classic_era');
  assert.equal(era.sync, true, 'Forever data does not cover an Era client');
  assert.equal(era.check, GD.BUILD_CHECK.noData);
  for (const clientBuild of ['', 'nonsense', '9.9.9.9']) assert.deepEqual(DAS.decide({ clientBuild, dataDir, now: T0 }), { sync: false, reason: 'no-flavor' });
});

test('decide: an attempt for that flavor and build waits 6 hours; another build or flavor does not wait', async () => {
  const dataDir = await withData(OLD);
  const attempts = { [DAS.attemptKey('forever', NEW)]: { at: T0, result: 'failed' } };
  const early = DAS.decide({ clientBuild: NEW, dataDir, attempts, now: T0 + DAS.RETRY_MS - 1 });
  assert.equal(early.sync, false);
  assert.equal(early.reason, 'backoff');
  assert.equal(early.retryAt, T0 + DAS.RETRY_MS);
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts, now: T0 + DAS.RETRY_MS }).sync, true);
  assert.equal(DAS.decide({ clientBuild: '1.60.1.70300', dataDir, attempts, now: T0 + HOUR }).sync, true);
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: { 'classic_era@1.60.1.70245': { at: T0 } }, now: T0 + HOUR }).sync, true);
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: { [DAS.attemptKey('forever', NEW)]: { at: T0 + HOUR } }, now: T0 }).sync, true);
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: { [DAS.attemptKey('forever', NEW)]: { at: 'soon' } }, now: T0 }).sync, true);
});

test('decide: a flavor with a sync going is busy', async () => {
  const dataDir = await withData(OLD);
  const d = DAS.decide({ clientBuild: NEW, dataDir, busy: new Set(['forever']), now: T0 });
  assert.equal(d.sync, false);
  assert.equal(d.reason, 'busy');
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, busy: new Set(['classic_era']), now: T0 }).sync, true);
});

test('observe: one sync per flavor at a time, records the attempt before it starts, and logs the attempt and the result', async () => {
  const dataDir = await withData(OLD);
  const gate = deferred();
  const h = harness({ dataDir, run: () => gate.promise });
  const first = h.sync.observe(NEW, ' from Forever');
  assert.equal(first.sync, true);
  assert.deepEqual(h.state.dataSync, { [`forever@${NEW}`]: { at: T0, result: 'running' } });
  assert.equal(h.saves(), 1);
  assert.equal(h.sync.observe(NEW).reason, 'busy');
  assert.equal(h.sync.observe('1.60.1.70300').reason, 'busy');
  await new Promise(r => setImmediate(r));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].flavor, 'forever');
  assert.deepEqual(h.calls[0].build, NEW);
  assert.equal(h.calls[0].home, path.dirname(dataDir));
  assert.deepEqual([...h.sync.busy()], [['forever', NEW]]);
  await D.sync({ dataDir, build: NEW, fetch: fixtureFetch });
  gate.resolve({ ok: true, message: 'done' });
  assert.deepEqual(await first.done, { ok: true, message: 'done' });
  assert.equal(h.state.dataSync[`forever@${NEW}`].result, 'ok');
  assert.deepEqual([...h.sync.busy()], []);
  assert.deepEqual(h.lines, [
    `data sync: client ${NEW} from Forever has forever data ${OLD} (family); syncing forever ${NEW} from wago.tools in the background`,
    `data sync: forever ${NEW} is current; the next game data lookup uses it`,
  ]);
  assert.equal(h.sync.observe(NEW).reason, 'exact');
  assert.equal(h.calls.length, 1);
});

test('observe: Forever and Classic Era clients sync independently', async () => {
  const dataDir = await withData(OLD);
  const gates = { forever: deferred(), classic_era: deferred() };
  const h = harness({ dataDir, run: ({ flavor }) => gates[flavor].promise });
  const forever = h.sync.observe(NEW);
  const era = h.sync.observe(ERA);
  assert.equal(forever.sync, true);
  assert.equal(era.sync, true);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(h.calls.map(c => [c.flavor, c.build]).sort(), [
    ['classic_era', ERA],
    ['forever', NEW],
  ]);
  gates.classic_era.resolve({ ok: false, message: 'HTTP 404' });
  await era.done;
  assert.deepEqual([...h.sync.busy()], [['forever', NEW]]);
  gates.forever.resolve({ ok: true });
  await forever.done;
});

test('observe: a failed sync waits 6 hours for that build, also after a restart, then tries again', async () => {
  const dataDir = await withData(OLD);
  let clock = T0;
  const state = {};
  const h = harness({
    dataDir,
    state,
    now: () => clock,
    run: async () => ({ ok: false, message: 'https://wago.tools/db2/UiMap/csv?build=1.60.1.70245: HTTP 404' }),
  });
  const r = h.sync.observe(NEW);
  assert.deepEqual(await r.done, { ok: false, message: 'https://wago.tools/db2/UiMap/csv?build=1.60.1.70245: HTTP 404' });
  assert.equal(state.dataSync[`forever@${NEW}`].result, 'failed');
  assert.match(state.dataSync[`forever@${NEW}`].error, /HTTP 404/);
  assert.match(h.lines[1], /^data sync: forever 1\.60\.1\.70245 failed \(.*HTTP 404\); the data in use stays, next try after 2026-10-07T18:00:00\.000Z$/);
  clock = T0 + HOUR;
  assert.equal(h.sync.observe(NEW).reason, 'backoff');
  const restarted = harness({ dataDir, state: JSON.parse(JSON.stringify(state)), now: () => clock, run: async () => ({ ok: true }) });
  assert.equal(restarted.sync.observe(NEW).reason, 'backoff');
  assert.equal(restarted.calls.length, 0);
  clock = T0 + DAS.RETRY_MS;
  const again = restarted.sync.observe(NEW);
  assert.equal(again.sync, true);
  await again.done;
  assert.equal(restarted.calls.length, 1);
});

test('observe: a sync that never ended (a crash) still counts as an attempt after a restart', async () => {
  const dataDir = await withData(OLD);
  const state = { dataSync: { [`forever@${NEW}`]: { at: T0, result: 'running' } } };
  const h = harness({ dataDir, state, now: () => T0 + HOUR, run: async () => ({ ok: true }) });
  assert.equal(h.sync.observe(NEW).reason, 'backoff');
  assert.equal(h.calls.length, 0);
});

test('observe: a sync that exits 0 without moving current to that build is a failed attempt', async () => {
  const dataDir = await withData(OLD);
  const h = harness({ dataDir, run: async () => ({ ok: true, message: 'nothing to do' }) });
  const r = h.sync.observe(NEW);
  assert.deepEqual(await r.done, { ok: false, message: `the sync ended, but ${NEW} is not the current forever data` });
  assert.equal(h.state.dataSync[`forever@${NEW}`].result, 'failed');
  assert.match(h.lines[1], /failed \(the sync ended, but 1\.60\.1\.70245 is not the current forever data\)/);
});

test('observe: a run that throws is a failed attempt, and the flavor is free again', async () => {
  const dataDir = await withData(OLD);
  const h = harness({
    dataDir,
    run: () => {
      throw new Error('spawn EACCES');
    },
  });
  const r = h.sync.observe(NEW);
  assert.deepEqual(await r.done, { ok: false, message: 'spawn EACCES' });
  assert.deepEqual([...h.sync.busy()], []);
  assert.equal(h.state.dataSync[`forever@${NEW}`].result, 'failed');
});

test('observe: off in the config, no data folder or no client build starts nothing', async () => {
  const dataDir = await withData(OLD);
  const off = harness({ dataDir, enabled: false, run: async () => ({ ok: true }) });
  assert.equal(off.sync.observe(NEW), null);
  assert.equal(off.calls.length, 0);
  assert.deepEqual(off.state, {});
  const noDir = harness({ dataDir: '', run: async () => ({ ok: true }) });
  assert.equal(noDir.sync.observe(NEW), null);
  const noBuild = harness({ dataDir, run: async () => ({ ok: true }) });
  assert.equal(noBuild.sync.observe(''), null);
  assert.equal(noDir.calls.length + noBuild.calls.length, 0);
});

test('observe: a bad dataSync value in the state is replaced, and a failed save is logged', async () => {
  const dataDir = await withData(OLD);
  const state = { dataSync: ['junk'] };
  const lines = [];
  const sync = DAS.createAutoSync({
    dataDir,
    home: path.dirname(dataDir),
    state: () => state,
    save: () => {
      throw new Error('disk full');
    },
    log: l => lines.push(l),
    now: () => T0,
    run: async () => {
      await D.sync({ dataDir, build: NEW, fetch: fixtureFetch });
      return { ok: true };
    },
  });
  await sync.observe(NEW).done;
  assert.equal(state.dataSync[`forever@${NEW}`].result, 'ok');
  assert.ok(lines.includes('data sync: could not save the attempt (disk full)'));
});

test('observe: the running sync child is listed for shutdown until it closes', async () => {
  const dataDir = await withData(OLD);
  const lines = [];
  const sync = DAS.createAutoSync({
    dataDir,
    home: path.dirname(dataDir),
    state: () => ({}),
    log: l => lines.push(l),
    run: args => DAS.runSync({ ...args, command: [process.execPath, ['-e', 'setTimeout(() => {}, 30000)']] }),
  });
  const r = sync.observe(NEW);
  for (let k = 0; k < 100 && sync.children().length === 0; k++) await new Promise(res => setTimeout(res, 10));
  const [child] = sync.children();
  assert.ok(child && child.pid > 0, 'the child is listed while it runs');
  child.kill('SIGKILL');
  assert.equal((await r.done).ok, false);
  assert.deepEqual(sync.children(), []);
});

test('prune keeps the newest attempts only and drops broken ones', () => {
  const attempts = { broken: null, alsoBroken: { at: 'x' } };
  for (let k = 0; k < DAS.ATTEMPTS_KEPT + 4; k++) attempts[`forever@1.60.1.${k}`] = { at: T0 + k };
  DAS.prune(attempts);
  const keys = Object.keys(attempts);
  assert.equal(keys.length, DAS.ATTEMPTS_KEPT);
  assert.ok(!keys.includes('broken'));
  assert.ok(!keys.includes('forever@1.60.1.0'));
  assert.ok(keys.includes(`forever@1.60.1.${DAS.ATTEMPTS_KEPT + 3}`));
});

test('lastLine: the last line of the output, without the failure prefix or control characters, capped', () => {
  assert.equal(DAS.lastLine('fetch a\nfetch b\n\ndata sync failed: HTTP 404\n'), 'HTTP 404');
  assert.equal(DAS.lastLine('bad\u0007bell‮'), 'bad bell');
  assert.equal(DAS.lastLine('x'.repeat(1000)).length, 300);
  assert.equal(DAS.lastLine(''), '');
});

test('syncCommand: the checkout runs datasync.js with this runtime; the binary runs its data subcommand', () => {
  const [file, args] = DAS.syncCommand('forever', NEW);
  assert.equal(file, process.execPath);
  assert.deepEqual(args, [path.join(REPO, 'bridge', 'datasync.js'), 'sync', '--flavor', 'forever', '--build', NEW]);
  assert.deepEqual(DAS.syncCommand('classic_era', ERA, { compiled: true, execPath: '/bin/claude-wow', root: '/x' }), [
    '/bin/claude-wow',
    ['data', 'sync', '--flavor', 'classic_era', '--build', ERA],
  ]);
  assert.throws(() => DAS.syncCommand('forever', '--force'), D.SyncError);
});

test('datasync.js runs as a script: help exits 0 without fetching', () => {
  const r = spawnSync(process.execPath, [path.join(REPO, 'bridge', 'datasync.js'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^claude-wow data sync/);
  const bad = spawnSync(process.execPath, [path.join(REPO, 'bridge', 'datasync.js'), 'sync', '--bogus'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('runSync: a real data sync child against a fake source switches the data, in the given home', async () => {
  const home = scratch('home');
  const requests = path.join(home, 'requests.log');
  const dataDir = path.join(home, 'data');
  await D.sync({ dataDir, build: OLD, fetch: fixtureFetch });
  const children = [];
  const result = await DAS.runSync({
    flavor: 'forever',
    build: NEW,
    home,
    onChild: c => children.push(c),
    env: { ...process.env, CLAUDE_WOW_HOME: '/nowhere', NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`, CLAUDE_WOW_FAKE_WAGO_LOG: requests },
  });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /current build 1\.60\.1\.70245 \(forever\)/);
  assert.equal(children.length, 1);
  assert.equal(D.readCurrent(D.flavorDir(dataDir, 'forever')).build, NEW);
  assert.ok(fs.existsSync(path.join(D.flavorDir(dataDir, 'forever'), OLD)), 'the old build stays on disk for readers that still have it open');
  assert.ok(fs.readFileSync(requests, 'utf8').includes(`/db2/ItemSparse/csv?build=${NEW}`));
});

test('runSync: a build the source does not have fails and leaves the old build current', async () => {
  const home = scratch('home');
  const dataDir = path.join(home, 'data');
  await D.sync({ dataDir, build: OLD, fetch: fixtureFetch });
  const result = await DAS.runSync({
    flavor: 'forever',
    build: NEW,
    home,
    env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}`, CLAUDE_WOW_FAKE_WAGO_MISSING: NEW },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.match(result.message, /HTTP 404/);
  assert.doesNotMatch(result.message, /^data sync failed/);
  assert.equal(D.readCurrent(D.flavorDir(dataDir, 'forever')).build, OLD);
});

test('runSync: a child that hangs is killed after the timeout; a command that cannot start fails', async () => {
  const killed = [];
  const hung = await DAS.runSync({
    home: scratch('home'),
    command: [process.execPath, ['-e', 'setInterval(() => {}, 1000)']],
    timeoutMs: 200,
    killTree: child => {
      killed.push(child.pid);
      child.kill('SIGKILL');
    },
  });
  assert.equal(hung.ok, false);
  assert.equal(killed.length, 1);
  assert.match(hung.message, /^no result after 0 minutes, so it was stopped$/);
  const missing = await DAS.runSync({ home: scratch('home'), command: [path.join(scratch('bin'), 'no-such-binary'), []] });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /ENOENT/);
  const silent = await DAS.runSync({ home: scratch('home'), command: [process.execPath, ['-e', 'process.exit(5)']] });
  assert.deepEqual(silent, { ok: false, code: 5, message: 'exit code 5' });
  const where = await DAS.runSync({ home: '/the/home', command: [process.execPath, ['-e', 'console.log(process.env.CLAUDE_WOW_HOME)']] });
  assert.deepEqual(where, { ok: true, code: 0, message: '/the/home' });
});

test.after(() => {
  for (const name of fs.readdirSync(os.tmpdir()))
    if (name.startsWith(`claude-wow-autosync-`) && name.includes(`-${process.pid}-`)) fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
});
