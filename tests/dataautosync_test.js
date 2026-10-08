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
  for (const clientBuild of ['', 'nonsense', '9.9.9.9', '1.60.1.123456789', '1.60.1111.1', ` ${NEW}`])
    assert.deepEqual(DAS.decide({ clientBuild, dataDir, now: T0 }), { sync: false, reason: 'no-flavor' });
});

test('decide: a failed or unfinished attempt makes its flavor wait 6 hours whatever the build; a held lock waits 10 minutes; a success does not wait', async () => {
  const dataDir = await withData(OLD);
  const failed = { forever: { build: NEW, at: T0, result: 'failed' } };
  const early = DAS.decide({ clientBuild: NEW, dataDir, attempts: failed, now: T0 + DAS.RETRY_MS - 1 });
  assert.equal(early.sync, false);
  assert.equal(early.reason, 'backoff');
  assert.equal(early.retryAt, T0 + DAS.RETRY_MS);
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: failed, now: T0 + DAS.RETRY_MS }).sync, true);
  assert.equal(DAS.decide({ clientBuild: '1.60.1.70300', dataDir, attempts: failed, now: T0 + HOUR }).reason, 'backoff');
  assert.equal(DAS.decide({ clientBuild: ERA, dataDir, attempts: failed, now: T0 + HOUR }).sync, true);
  const running = { forever: { build: NEW, at: T0, result: 'running' } };
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: running, now: T0 + HOUR }).reason, 'backoff');
  const locked = { forever: { build: NEW, at: T0, result: 'locked' } };
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: locked, now: T0 + DAS.LOCKED_RETRY_MS - 1 }).retryAt, T0 + DAS.LOCKED_RETRY_MS);
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: locked, now: T0 + DAS.LOCKED_RETRY_MS }).sync, true);
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: { forever: { build: '1.60.1.100', at: T0, result: 'ok' } }, now: T0 + 1 }).sync, true);
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: { forever: { at: T0 + HOUR } }, now: T0 }).sync, true);
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: { forever: { at: 'soon' } }, now: T0 }).sync, true);
  assert.equal(DAS.decide({ clientBuild: NEW, dataDir, attempts: { [`forever@${NEW}`]: { at: T0 } }, now: T0 + HOUR }).sync, true);
});

test('decide: a client build older than the data, or the same build written another way, never syncs', async () => {
  const dataDir = await withData(NEW);
  for (const clientBuild of [OLD, '1.60.1.70244', '1.60.0.99999', '1.60.1.070245']) {
    const d = DAS.decide({ clientBuild, dataDir, now: T0 });
    assert.equal(d.sync, false, clientBuild);
    assert.equal(d.reason, 'not-newer', clientBuild);
  }
  assert.equal(DAS.decide({ clientBuild: '1.60.1.70246', dataDir, now: T0 }).sync, true);
  assert.equal(DAS.decide({ clientBuild: '1.60.2.1', dataDir, now: T0 }).sync, true);
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
  assert.deepEqual(h.state.dataSync, { forever: { build: NEW, at: T0, result: 'running' } });
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
  assert.equal(h.state.dataSync.forever.result, 'ok');
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

test('observe: a failed sync makes its flavor wait 6 hours, also after a restart, then tries again', async () => {
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
  assert.equal(state.dataSync.forever.result, 'failed');
  assert.match(state.dataSync.forever.error, /HTTP 404/);
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
  const entry = { build: NEW, at: T0, result: 'running' };
  const state = { dataSync: { forever: { ...entry } } };
  const h = harness({ dataDir, state, now: () => T0 + HOUR, run: async () => ({ ok: true }) });
  assert.equal(h.sync.observe(NEW).reason, 'backoff');
  await new Promise(r => setImmediate(r));
  assert.equal(h.calls.length, 0);
  assert.deepEqual(state.dataSync, { forever: entry });
});

test('observe: a sync that exits 0 without moving current to that build is a failed attempt', async () => {
  const dataDir = await withData(OLD);
  const h = harness({ dataDir, run: async () => ({ ok: true, message: 'nothing to do' }) });
  const r = h.sync.observe(NEW);
  assert.deepEqual(await r.done, { ok: false, message: `the sync ended, but ${NEW} is not the current forever data` });
  assert.equal(h.state.dataSync.forever.result, 'failed');
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
  assert.equal(h.state.dataSync.forever.result, 'failed');
});

function syncingRun(dataDir) {
  return async ({ build }) => {
    await D.sync({ dataDir, build, fetch: fixtureFetch });
    return { ok: true, code: 0 };
  };
}

test('observe: two clients of one flavor on different builds sync only forward, and the newest build stays current', async () => {
  const NEWER = '1.60.1.70300';
  const newestFirst = await withData(OLD);
  const a = harness({ dataDir: newestFirst, run: syncingRun(newestFirst) });
  await a.sync.observe(NEWER).done;
  for (let k = 0; k < 4; k++) {
    assert.equal(a.sync.observe(NEW).reason, 'not-newer');
    assert.equal(a.sync.observe(NEWER).reason, 'exact');
  }
  await new Promise(r => setImmediate(r));
  assert.deepEqual(
    a.calls.map(c => c.build),
    [NEWER],
  );
  assert.equal(D.readCurrent(D.flavorDir(newestFirst, 'forever')).build, NEWER);
  const olderFirst = await withData(OLD);
  const b = harness({ dataDir: olderFirst, run: syncingRun(olderFirst) });
  await b.sync.observe(NEW).done;
  await b.sync.observe(NEWER).done;
  for (let k = 0; k < 4; k++) {
    assert.equal(b.sync.observe(NEW).reason, 'not-newer');
    assert.equal(b.sync.observe(NEWER).reason, 'exact');
  }
  await new Promise(r => setImmediate(r));
  assert.deepEqual(
    b.calls.map(c => c.build),
    [NEW, NEWER],
  );
  assert.equal(D.readCurrent(D.flavorDir(olderFirst, 'forever')).build, NEWER);
});

test('observe: a flood of forged builds makes at most one attempt per flavor per 6 hours and never resets the wait', async () => {
  const dataDir = await withData(OLD);
  let clock = T0;
  const state = {};
  const h = harness({ dataDir, state, now: () => clock, run: async () => ({ ok: false, code: 1, message: 'HTTP 404' }) });
  const first = h.sync.observe('1.60.1.80000');
  await first.done;
  const kept = JSON.parse(JSON.stringify(state.dataSync));
  for (let k = 1; k <= 40; k++) {
    clock = T0 + k * 60 * 1000;
    const d = h.sync.observe(`1.60.1.${80000 + k}`);
    assert.equal(d.reason, 'backoff', `forged build ${k}`);
  }
  await new Promise(r => setImmediate(r));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(state.dataSync, kept);
  assert.deepEqual(Object.keys(state.dataSync), ['forever']);
  assert.equal(h.sync.observe(ERA).sync, true, 'the other flavor has its own wait');
  clock = T0 + DAS.RETRY_MS;
  const again = h.sync.observe(NEW);
  assert.equal(again.sync, true);
  await again.done;
  assert.deepEqual(Object.keys(state.dataSync).sort(), ['classic_era', 'forever']);
});

test('observe: a sync that finds the lock held (exit 3) is tried again after 10 minutes, not 6 hours', async () => {
  const dataDir = await withData(OLD);
  let clock = T0;
  const h = harness({ dataDir, now: () => clock, run: async () => ({ ok: false, code: D.LOCKED_EXIT, message: 'another data sync is running (pid 1)' }) });
  assert.deepEqual(await h.sync.observe(NEW).done, { ok: false, message: 'another data sync is running (pid 1)' });
  assert.equal(h.state.dataSync.forever.result, 'locked');
  assert.match(h.lines[1], /^data sync: forever 1\.60\.1\.70245 waits, another data sync holds the lock \(.*\); next try after 2026-10-07T12:10:00\.000Z$/);
  clock = T0 + DAS.LOCKED_RETRY_MS - 1;
  assert.equal(h.sync.observe(NEW).reason, 'backoff');
  clock = T0 + DAS.LOCKED_RETRY_MS;
  const again = h.sync.observe(NEW);
  assert.equal(again.sync, true);
  await again.done;
  assert.equal(h.calls.length, 2);
});

test('the run timeout ends a sync before its lock counts as stale', () => {
  assert.ok(DAS.RUN_TIMEOUT_MS > 0);
  assert.ok(DAS.RUN_TIMEOUT_MS < D.LOCK_STALE_MS);
});

test('observe: off in the config, no data folder or no client build starts nothing', async () => {
  const dataDir = await withData(OLD);
  const off = harness({ dataDir, enabled: false, run: async () => ({ ok: true }) });
  assert.equal(off.sync.observe(NEW), null);
  const noDir = harness({ dataDir: '', run: async () => ({ ok: true }) });
  assert.equal(noDir.sync.observe(NEW), null);
  const noBuild = harness({ dataDir, run: async () => ({ ok: true }) });
  assert.equal(noBuild.sync.observe(''), null);
  await new Promise(r => setImmediate(r));
  assert.deepEqual([off.calls.length, noDir.calls.length, noBuild.calls.length], [0, 0, 0]);
  assert.deepEqual([off.state, noDir.state, noBuild.state], [{}, {}, {}]);
  assert.deepEqual([off.saves(), noDir.saves(), noBuild.saves()], [0, 0, 0]);
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
  assert.equal(state.dataSync.forever.result, 'ok');
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

test('prune keeps one valid entry per known flavor and drops the rest', () => {
  const attempts = { broken: null, forever: { at: T0 }, classic_era: { at: 'x' }, [`forever@${NEW}`]: { at: T0 }, __proto__x: { at: T0 } };
  DAS.prune(attempts);
  assert.deepEqual(attempts, { forever: { at: T0 } });
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

test('runSync: a real data sync child that finds the lock held exits 3 and changes nothing', async () => {
  const home = scratch('home');
  const dataDir = path.join(home, 'data');
  await D.sync({ dataDir, build: OLD, fetch: fixtureFetch });
  const lock = D.acquireLock(D.flavorDir(dataDir, 'forever'));
  try {
    const result = await DAS.runSync({ flavor: 'forever', build: NEW, home, env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(PRELOAD)}` } });
    assert.equal(result.ok, false);
    assert.equal(result.code, D.LOCKED_EXIT);
    assert.match(result.message, /another data sync is running/);
  } finally {
    lock.release();
  }
  assert.equal(D.readCurrent(D.flavorDir(dataDir, 'forever')).build, OLD);
});

test('runCli sets the exit code from the command, and a thrown error exits 1 with one line', async t => {
  const written = [];
  t.mock.method(process.stderr, 'write', s => {
    written.push(s);
    return true;
  });
  const before = process.exitCode;
  try {
    await D.runCli(['x'], async argv => (argv[0] === 'x' ? 7 : 0));
    assert.equal(process.exitCode, 7);
    await D.runCli([], async () => {
      throw new Error('boom');
    });
    assert.equal(process.exitCode, 1);
    assert.deepEqual(written, ['data sync failed: boom\n']);
  } finally {
    process.exitCode = before;
  }
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
