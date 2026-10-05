'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const S = require('../bridge/service');

const WINDOWS_ONLY = { skip: process.platform !== 'win32' && 'runs the real PowerShell scripts, Windows only', timeout: 120000 };
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];
const STALE_BY_MS = 5000;
const EXIT_WAIT_MS = 15000;
const IDENTITY_CHANGED_EXIT = 3;

function scratch() {
  const dir = path.join(__dirname, 'tmp', 'service-windows');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeSupervisorScript(dir) {
  const file = path.join(dir, 'fake-supervisor.js');
  fs.writeFileSync(file, 'setInterval(() => {}, 1000);\n');
  return file;
}

function spawnFakeSupervisor(script) {
  const before = Date.now();
  const child = spawn(process.execPath, [script], { stdio: 'ignore', windowsHide: true });
  return { child, before, started: Date.now() };
}

function spawnOtherProgram() {
  return spawn('ping.exe', ['-n', '120', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
}

function exited(child, ms = EXIT_WAIT_MS) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function stillRunning(child) {
  return child.exitCode === null && child.signalCode === null && S.alive(child.pid);
}

function powershell(script) {
  return S.backend('win32').exec(POWERSHELL, [...POWERSHELL_ARGS, script]);
}

function cleanup(children) {
  for (const c of children)
    try {
      c.kill();
    } catch {}
}

test('Windows, real PowerShell: the identity query reads the creation time and command line of a live process', WINDOWS_ONLY, () => {
  const script = fakeSupervisorScript(scratch());
  const fake = spawnFakeSupervisor(script);
  try {
    const r = powershell(S.winProcessQuery(fake.child.pid));
    assert.ok(r.ok, `query failed: ${r.out} ${r.error || ''}`);
    const proc = S.parseWinProcess(r.out);
    assert.equal(proc.state, 'found', r.out);
    assert.ok(proc.command.includes('fake-supervisor.js'), proc.command);
    assert.ok(proc.created >= fake.before - S.CLOCK_SLACK_MS, `created ${proc.created} vs spawned after ${fake.before}`);
    assert.ok(proc.created <= fake.started + S.CLOCK_SLACK_MS, `created ${proc.created} vs spawned before ${fake.started}`);
  } finally {
    cleanup([fake.child]);
  }
});

test('Windows, real PowerShell: verify matches the recorded supervisor and rejects a later start time or another program', WINDOWS_ONLY, async () => {
  const script = fakeSupervisorScript(scratch());
  const staleStarted = Date.now() - STALE_BY_MS;
  const fake = spawnFakeSupervisor(script);
  const other = spawnOtherProgram();
  const gone = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  const win = S.backend('win32');
  try {
    assert.equal(win.verify({ pid: fake.child.pid, started: fake.started, mode: 'service' }), 'match');
    assert.equal(win.verify({ pid: fake.child.pid, started: staleStarted, mode: 'service' }), 'stale', 'created after the recorded start: a reused pid');
    assert.equal(win.verify({ pid: other.pid, started: Date.now(), mode: 'service' }), 'stale', 'another program behind the pid');
    assert.ok(await exited(gone), 'the short-lived child exits');
    assert.notEqual(win.verify({ pid: gone.pid, started: Date.now(), mode: 'service' }), 'match', 'a finished process is never the supervisor');
    const d = { run: path.join(__dirname, 'tmp', 'service-windows', 'run') };
    S.writePid(d, { pid: fake.child.pid, started: fake.started, mode: 'terminal' });
    assert.ok(
      S.preflight(d, 'win32').some(p => p.includes(`terminal (pid ${fake.child.pid})`)),
      'install is blocked by the verified terminal bridge',
    );
    S.writePid(d, { pid: fake.child.pid, started: staleStarted, mode: 'terminal' });
    assert.ok(!S.preflight(d, 'win32').some(p => p.includes(`pid ${fake.child.pid}`)), 'a reused pid does not block install');
  } finally {
    cleanup([fake.child, other, gone]);
  }
});

test('Windows, real PowerShell: the verified kill ends only the process whose start time matches', WINDOWS_ONLY, async () => {
  const script = fakeSupervisorScript(scratch());
  const staleStarted = Date.now() - STALE_BY_MS;
  const target = spawnFakeSupervisor(script);
  const bystander = spawnFakeSupervisor(script);
  const other = spawnOtherProgram();
  try {
    const refused = powershell(S.winVerifiedKill({ pid: target.child.pid, started: staleStarted }));
    assert.equal(refused.status, IDENTITY_CHANGED_EXIT, refused.out);
    assert.ok(stillRunning(target.child), 'a start time later than the record kills nothing');

    const killed = powershell(S.winVerifiedKill({ pid: target.child.pid, started: target.started }));
    assert.ok(killed.ok, `kill failed: ${killed.out} ${killed.error || ''}`);
    assert.ok(await exited(target.child), 'the verified process is ended');
    assert.ok(stillRunning(bystander.child), 'another copy of the same program is left alone');
    assert.ok(stillRunning(other), 'another program is left alone');

    const again = powershell(S.winVerifiedKill({ pid: target.child.pid, started: target.started }));
    assert.notEqual(again.status, 0, 'a pid that is gone is never reported as killed');
    assert.ok(stillRunning(bystander.child));
  } finally {
    cleanup([target.child, bystander.child, other]);
  }
});

test('Windows, real PowerShell: an orphaned agent run is ended only when its marker and start time match', WINDOWS_ONLY, async () => {
  const script = fakeSupervisorScript(scratch());
  const run = spawnFakeSupervisor(script);
  const other = spawnOtherProgram();
  try {
    assert.equal(S.endWinAgentRun({ pid: other.pid, startedAt: Date.now(), marker: 'fake-supervisor.js' }), 'stale');
    assert.ok(stillRunning(other));
    assert.equal(S.endWinAgentRun({ pid: run.child.pid, startedAt: run.before - STALE_BY_MS, marker: 'fake-supervisor.js' }), 'stale');
    assert.ok(stillRunning(run.child));
    assert.equal(S.endWinAgentRun({ pid: run.child.pid, startedAt: run.started, marker: 'fake-supervisor.js' }), 'ended');
    assert.ok(await exited(run.child));
    assert.ok(stillRunning(other));
  } finally {
    cleanup([run.child, other]);
  }
});
