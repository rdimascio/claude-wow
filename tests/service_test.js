// bridge/service.js, the `claude-wow service` command: the service definitions it
// writes (LaunchAgent plist, systemd unit, Windows Startup launcher), its
// argument parsing, the log rotation the supervisor runs, the pid file, and the
// bits that read launchctl back. Nothing here talks to launchd or systemd.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../bridge/service');

function scratch(name) {
  const dir = path.join(__dirname, 'tmp', 'service', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('argument parsing: the seven commands, -n and -f, and errors for anything else', () => {
  for (const c of S.COMMANDS) assert.equal(S.parseArgs([c]).cmd, c);
  assert.equal(S.parseArgs([]).cmd, 'help');
  assert.equal(S.parseArgs(['--help']).cmd, 'help');
  assert.match(S.parseArgs(['bogus']).error, /unknown service command "bogus"/);
  assert.deepEqual(S.parseArgs(['logs']).opts, { lines: 50, follow: false });
  assert.deepEqual(S.parseArgs(['logs', '-n', '10', '-f']).opts, { lines: 10, follow: true });
  assert.deepEqual(S.parseArgs(['logs', '-n200', '--follow']).opts, { lines: 200, follow: true });
  assert.match(S.parseArgs(['logs', '-n', 'ten']).error, /whole number/);
  assert.match(S.parseArgs(['status', '--verbose']).error, /unknown option "--verbose"/);
});

test('per-user folders per platform, none of them under /usr or Program Files', () => {
  const home = '/Users/p';
  const mac = S.dirs('darwin', {}, home);
  assert.equal(mac.definition, path.join(home, 'Library', 'LaunchAgents', 'io.claudewow.bridge.plist'));
  assert.equal(mac.logs, path.join(home, 'Library', 'Logs', 'claude-wow'));
  const lin = S.dirs('linux', {}, '/home/p');
  assert.equal(lin.definition, path.join('/home/p', '.config', 'systemd', 'user', 'claude-wow-bridge.service'));
  assert.equal(lin.logs, path.join('/home/p', '.local', 'state', 'claude-wow'));
  const xdg = S.dirs('linux', { XDG_STATE_HOME: '/st', XDG_CONFIG_HOME: '/cf' }, '/home/p');
  assert.equal(xdg.logs, path.join('/st', 'claude-wow'));
  assert.equal(xdg.definition, path.join('/cf', 'systemd', 'user', 'claude-wow-bridge.service'));
  const win = S.dirs('win32', { LOCALAPPDATA: 'C:\\U\\p\\AppData\\Local', APPDATA: 'C:\\U\\p\\AppData\\Roaming' }, 'C:\\U\\p');
  assert.ok(win.definition.includes('Startup') && win.definition.endsWith('Claude WoW bridge.vbs'));
  // The old name's service, which install and uninstall remove.
  assert.equal(S.oldDirs('darwin', {}, home).definition, path.join(home, 'Library', 'LaunchAgents', 'io.wowai.bridge.plist'));
  assert.equal(S.oldDirs('darwin', {}, home).label, 'io.wowai.bridge');
  assert.equal(S.oldDirs('linux', { XDG_CONFIG_HOME: '/cf' }, '/home/p').definition, path.join('/cf', 'systemd', 'user', 'wow-ai-bridge.service'));
  assert.equal(S.oldDirs('linux', {}, '/home/p').unit, 'wow-ai-bridge');
  assert.ok(S.oldDirs('win32', { APPDATA: 'C:\\U\\p\\AppData\\Roaming' }, 'C:\\U\\p').definition.endsWith('WoW AI bridge.vbs'));
  assert.notEqual(S.oldDirs('darwin', {}, home).definition, mac.definition);
  assert.notEqual(S.oldDirs('linux', {}, '/home/p').definition, lin.definition);
  assert.notEqual(S.oldDirs('win32', { APPDATA: 'C:\\U\\p\\AppData\\Roaming' }, 'C:\\U\\p').definition, win.definition);
  assert.ok(win.logs.startsWith('C:\\U\\p\\AppData\\Local'));
  assert.equal(S.pidFile(mac), path.join(mac.run, 'supervisor.pid'));
  assert.equal(S.serviceLogFile(mac), path.join(mac.logs, 'bridge.log'));
});

test('log rotation: nothing below the limit, then a shift of .1 .. .keep with the oldest dropped', () => {
  const dir = scratch('rotate');
  const file = path.join(dir, 'bridge.log');
  fs.writeFileSync(file, 'small\n');
  assert.equal(S.rotate(file, { maxBytes: 100, keep: 3 }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'small\n');
  assert.equal(S.rotate(path.join(dir, 'missing.log')), false, 'a missing file is not an error');
  for (let gen = 1; gen <= 5; gen++) {
    fs.writeFileSync(file, `gen${gen}\n`.repeat(30));
    assert.equal(S.rotate(file, { maxBytes: 100, keep: 3 }), true);
    assert.ok(!fs.existsSync(file), 'the current log moved aside');
  }
  assert.equal(fs.readFileSync(file + '.1', 'utf8').slice(0, 4), 'gen5');
  assert.equal(fs.readFileSync(file + '.2', 'utf8').slice(0, 4), 'gen4');
  assert.equal(fs.readFileSync(file + '.3', 'utf8').slice(0, 4), 'gen3');
  assert.ok(!fs.existsSync(file + '.4'), 'keep=3 means three old files');
});

test('RotatingLog appends and rotates itself once it passes the limit', () => {
  const dir = scratch('rotlog');
  const file = path.join(dir, 'service.log');
  const log = new S.RotatingLog(file, { maxBytes: 50, keep: 2 });
  log.write('a'.repeat(20) + '\n');
  log.write('b'.repeat(20) + '\n');
  assert.equal(fs.statSync(file).size, 42);
  log.write('c'.repeat(20) + '\n'); // crosses 50 -> rotated
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.statSync(file + '.1').size, 63);
  log.write(Buffer.from('after\n'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'after\n');
  const again = new S.RotatingLog(file, { maxBytes: 50, keep: 2 });
  assert.equal(again.size, 6, 'a new writer picks up the existing size');
});

const POSIX = process.platform !== 'win32';
const modeOf = file => fs.statSync(file).mode & 0o777;

function publicFile(file, text = 'x\n') {
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o644);
}

test('RotatingLog keeps the log, its folder and its archives private, and repairs old public ones', { skip: !POSIX }, () => {
  const dir = scratch('rotlogmode');
  const logs = path.join(dir, 'logs');
  const file = path.join(logs, 'bridge.log');
  fs.mkdirSync(logs, { mode: 0o755 });
  fs.chmodSync(logs, 0o755);
  publicFile(file);
  publicFile(file + '.1');
  publicFile(file + '.2');
  const log = new S.RotatingLog(file, { maxBytes: 50, keep: 2 });
  assert.equal(modeOf(logs), S.PRIVATE_DIR_MODE);
  assert.equal(modeOf(file), S.PRIVATE_FILE_MODE);
  assert.equal(modeOf(file + '.1'), S.PRIVATE_FILE_MODE);
  assert.equal(modeOf(file + '.2'), S.PRIVATE_FILE_MODE);
  log.write('a'.repeat(60) + '\n');
  assert.ok(!fs.existsSync(file));
  log.write('fresh\n');
  assert.equal(modeOf(file), S.PRIVATE_FILE_MODE, 'the log made after a rotation is private');
  assert.equal(modeOf(file + '.1'), S.PRIVATE_FILE_MODE);

  const fresh = path.join(dir, 'new', 'deeper', 'service.log');
  new S.RotatingLog(fresh).write('first\n');
  assert.equal(modeOf(path.dirname(fresh)), S.PRIVATE_DIR_MODE);
  assert.equal(modeOf(fresh), S.PRIVATE_FILE_MODE);

  const winLog = path.join(dir, 'win', 'bridge.log');
  fs.mkdirSync(path.dirname(winLog));
  publicFile(winLog);
  publicFile(winLog + '.1');
  new S.RotatingLog(winLog, { platform: 'win32' });
  assert.equal(modeOf(winLog), 0o644, 'Windows: no chmod');
  assert.equal(modeOf(winLog + '.1'), 0o644, 'Windows: no chmod');
});

test('rotation leaves a private archive even when the live log was public', { skip: !POSIX }, () => {
  const dir = scratch('rotatemode');
  const file = path.join(dir, 'bridge.log');
  publicFile(file, 'z'.repeat(200));
  assert.equal(S.rotate(file, { maxBytes: 100, keep: 3 }), true);
  assert.equal(modeOf(file + '.1'), S.PRIVATE_FILE_MODE);
});

test('the supervisor start repairs the service logs, the launchd log and the home bridge.log archives; Windows is left alone', { skip: !POSIX }, () => {
  const dir = scratch('securelogs');
  const d = { logs: path.join(dir, 'logs'), run: path.join(dir, 'run'), definition: path.join(dir, 'x.plist') };
  const home = path.join(dir, 'home');
  fs.mkdirSync(d.logs, { mode: 0o755 });
  fs.chmodSync(d.logs, 0o755);
  fs.mkdirSync(home, { mode: 0o755 });
  fs.chmodSync(home, 0o755);
  const bridgeLog = path.join(home, 'bridge.log');
  const files = [
    S.serviceLogFile(d),
    ...[1, 2, 3, 4, 5].map(i => `${S.serviceLogFile(d)}.${i}`),
    S.launchdLogFile(d),
    S.launchdLogFile(d) + '.1',
    bridgeLog,
    bridgeLog + '.5',
  ];
  for (const f of files) publicFile(f);

  S.secureServiceLogs(d, { platform: 'win32', bridgeLog });
  assert.equal(modeOf(d.logs), 0o755, 'Windows: no change');
  for (const f of files) assert.equal(modeOf(f), 0o644, `Windows: ${f} untouched`);

  S.secureServiceLogs(d, { platform: process.platform, bridgeLog });
  assert.equal(modeOf(d.logs), S.PRIVATE_DIR_MODE);
  for (const f of files) assert.equal(modeOf(f), S.PRIVATE_FILE_MODE, `${f} is private`);
  assert.equal(modeOf(home), 0o755, 'the home folder itself is not changed');

  const empty = { logs: path.join(dir, 'missing'), run: path.join(dir, 'missing'), definition: path.join(dir, 'y') };
  assert.doesNotThrow(() => S.secureServiceLogs(empty, { bridgeLog: path.join(dir, 'nope.log') }));
  assert.ok(!fs.existsSync(empty.logs), 'a start in a terminal does not create the service log folder');
});

test('pid file: written, read back, only its owner clears it, liveness check', () => {
  const dir = scratch('pid');
  const d = { run: dir, logs: dir, definition: path.join(dir, 'x') };
  S.writePid(d, { pid: process.pid, bridgePid: 0, started: 1000, mode: 'terminal' });
  const p = S.readPid(d);
  assert.equal(p.pid, process.pid);
  assert.equal(p.mode, 'terminal');
  assert.ok(p.written > 0);
  assert.ok(S.alive(process.pid));
  assert.ok(!S.alive(0));
  assert.ok(!S.alive(2147483000), 'a pid nobody has');
  S.clearPid(d, process.pid + 1);
  assert.ok(fs.existsSync(S.pidFile(d)), 'another process may not clear it');
  S.clearPid(d, process.pid);
  assert.ok(!fs.existsSync(S.pidFile(d)));
  assert.equal(S.readPid(d), null);
});

test('launchctl print is read for the pid and state; uptime and log tails format sensibly', () => {
  const text = `gui/501/io.claudewow.bridge = {
\tactive count = 1
\tpath = /Users/p/Library/LaunchAgents/io.claudewow.bridge.plist
\tstate = running
\tprogram = /opt/homebrew/bin/node
\tpid = 4242
\trunning = 1
}`;
  assert.deepEqual(S.parseLaunchctlPrint(text), { pid: 4242, state: 'running' });
  assert.deepEqual(S.parseLaunchctlPrint(''), { pid: 0, state: '' });
  assert.deepEqual(S.parseLaunchctlPrint('\tstate = not running\n'), { pid: 0, state: 'not' });
  assert.equal(S.formatUptime(5000), '5s');
  assert.equal(S.formatUptime(65000), '1m 5s');
  assert.equal(S.formatUptime(3600000 * 2 + 60000 * 13), '2h 13m');
  assert.equal(S.formatUptime(86400000 * 3 + 3600000), '3d 1h 0m');
  assert.equal(S.formatUptime(NaN), '?');
  const dir = scratch('tail');
  const file = path.join(dir, 'l.log');
  fs.writeFileSync(file, 'one\ntwo\nthree\n');
  assert.deepEqual(S.lastLines(file, 2), ['two', 'three']);
  assert.deepEqual(S.lastLines(file, 10), ['one', 'two', 'three']);
  assert.deepEqual(S.lastLines(file, 0), []);
  assert.deepEqual(S.lastLines(path.join(dir, 'nope'), 3), []);
});

test('the environment baked into the service puts node on PATH and drops nothing the agents need', () => {
  const env = S.agentEnv();
  assert.ok(env.PATH.split(path.delimiter).includes(path.dirname(process.execPath)));
  if (process.env.HOME) assert.equal(env.HOME, process.env.HOME);
});

test('status on a clean machine says not installed / not running and exits 3; help and bad input exit cleanly', () => {
  const lines = [];
  const dir = scratch('status');
  fs.writeFileSync(path.join(dir, 'bridge.log'), '');
  const code = S.status(
    { run: dir, logs: dir, definition: path.join(dir, 'io.claudewow.bridge.plist') },
    'darwin',
    l => lines.push(l),
    path.join(dir, 'state.json'),
    path.join(dir, 'config.json'),
  );
  assert.equal(code, 3);
  assert.match(lines.join('\n'), /installed : no/);
  assert.match(lines.join('\n'), /running   : no/);
  assert.match(lines.join('\n'), /versions  : no hello with versions yet/);
  const out = [];
  assert.equal(S.main(['help'], { out: l => out.push(l), err: () => {} }), 0);
  assert.match(out.join('\n'), /install\s+Run the bridge in the background/);
  const errs = [];
  assert.equal(S.main(['frobnicate'], { out: () => {}, err: l => errs.push(l) }), 2);
  assert.match(errs.join('\n'), /unknown service command/);
});

test('install refuses without a config.json rather than looping a broken service', () => {
  // An empty CLAUDE_WOW_HOME: no config there, whatever this machine has elsewhere.
  const home = scratch('nohome');
  const saved = process.env.CLAUDE_WOW_HOME;
  process.env.CLAUDE_WOW_HOME = home;
  try {
    const errs = [];
    assert.equal(S.main(['install'], { out: () => {}, err: l => errs.push(l) }), 1);
    assert.match(errs.join('\n'), /config\.json is missing/);
    assert.ok(errs.join('\n').includes(path.join(home, 'config.json')), 'names the file it looked for');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_WOW_HOME;
    else process.env.CLAUDE_WOW_HOME = saved;
  }
});

test("the old name's service is removed: its definition goes, its pid file is honoured, and nothing throws when it is absent", () => {
  // Windows backend: pure fs (no process of the old service is running here).
  const dir = scratch('oldwin');
  const old = { run: dir, definition: path.join(dir, 'Startup', 'WoW AI bridge.vbs') };
  assert.equal(S.backend('win32').removeOld(old), false, 'nothing to remove');
  fs.mkdirSync(path.dirname(old.definition), { recursive: true });
  fs.writeFileSync(old.definition, "' old launcher\r\n");
  fs.writeFileSync(S.pidFile(old), JSON.stringify({ pid: 2147483000, mode: 'service' })); // a pid nobody has: not killed, not an error
  assert.equal(S.backend('win32').removeOld(old), true);
  assert.ok(!fs.existsSync(old.definition), 'the old launcher is gone');
  // macOS backend: the plist is removed whatever launchctl says about a label that is not loaded.
  if (process.platform === 'darwin') {
    const mdir = scratch('oldmac');
    const mold = { label: 'io.wowai.bridge.test-' + process.pid, definition: path.join(mdir, 'io.wowai.bridge.plist'), run: mdir };
    assert.equal(S.backend('darwin').removeOld(mold), false);
    fs.writeFileSync(mold.definition, '<plist/>');
    assert.equal(S.backend('darwin').removeOld(mold), true);
    assert.ok(!fs.existsSync(mold.definition));
  }
  // Every backend has it, and install and uninstall call it before touching the new definition.
  for (const p of ['darwin', 'linux', 'win32']) assert.equal(typeof S.backend(p).removeOld, 'function', p);
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'service.js'), 'utf8');
  assert.equal((src.match(/this\.removeOld\(\)/g) || []).length, 6, 'three backends, install and uninstall each');
});

test('the definition runs node + supervisor.js from a checkout, and the binary alone from the home folder when the bridge is one', () => {
  const R = require('../bridge/runtime');
  const checkout = { compiled: false, execPath: '/opt/homebrew/bin/node', root: '/Users/p/claude-wow' };
  const binary = { compiled: true, execPath: '/Users/p/.local/bin/claude-wow', root: '/build/machine/claude-wow' };
  assert.deepEqual(S.program(checkout), {
    node: '/opt/homebrew/bin/node',
    script: path.join('/Users/p/claude-wow', 'bridge', 'supervisor.js'),
    cwd: '/Users/p/claude-wow',
  });
  const b = S.program(binary);
  assert.equal(b.node, '/Users/p/.local/bin/claude-wow');
  assert.equal(b.script, '', 'no script: the binary is the supervisor');
  assert.equal(b.cwd, require('../bridge/home').resolve().dir, 'the home folder, which bridge.js treats like the repo');
  assert.equal(S.program().node, process.execPath);
  assert.equal(S.program().script, path.join(R.ROOT, 'bridge', 'supervisor.js'));

  const d = S.dirs('darwin', {}, '/Users/p');
  const plist = S.definition('darwin', d, binary);
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/Users\/p\/\.local\/bin\/claude-wow<\/string>\s*<\/array>/, 'one argument, no script');
  assert.ok(!/supervisor\.js/.test(plist));
  assert.match(
    S.definition('darwin', d, checkout),
    /<string>\/opt\/homebrew\/bin\/node<\/string>\s*<string>[\\/]Users[\\/]p[\\/]claude-wow[\\/]bridge[\\/]supervisor\.js<\/string>/,
  );
  assert.match(S.definition('linux', S.dirs('linux', {}, '/home/p'), binary), /^ExecStart="\/Users\/p\/\.local\/bin\/claude-wow"$/m);
  assert.match(
    S.definition('win32', S.dirs('win32', {}, 'C:\\Users\\p'), { ...binary, execPath: 'C:\\Users\\p\\bin\\claude-wow.exe' }),
    /sh\.Run """C:\\Users\\p\\bin\\claude-wow\.exe""", 0, False/,
  );
  assert.match(S.launchdPlist({ node: '/n', script: '', cwd: '/c', logFile: '/l' }), /<array>\s*<string>\/n<\/string>\s*<\/array>/);
  assert.match(S.systemdUnit({ node: '/n', script: '', cwd: '/c' }), /^ExecStart="\/n"$/m);
});

test('a binary installed under <home>/releases makes a service that runs <home>/current/claude-wow, with no node and no release path in it', () => {
  const REL = require('../bridge/releases');
  const home = scratch('release-program');
  const l = REL.layout(home);
  fs.mkdirSync(REL.releaseDir(l, '0.5.0-abc'), { recursive: true });
  fs.writeFileSync(REL.releaseBinary(l, '0.5.0-abc'), 'bin');
  const fromRelease = { compiled: true, execPath: REL.releaseBinary(l, '0.5.0-abc'), root: '/build/machine/claude-wow' };
  const want = { node: REL.currentBinary(l), script: '', cwd: home };
  assert.deepEqual(S.program(fromRelease, home), want);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join('releases', '0.5.0-abc'), l.current);
    assert.deepEqual(S.program({ ...fromRelease, execPath: REL.currentBinary(l) }, home), want, 'run through the current symlink');
  }
  const elsewhere = { compiled: true, execPath: path.join(home, 'bin', 'claude-wow'), root: '/x' };
  assert.equal(S.program(elsewhere, home).node, elsewhere.execPath, 'a binary outside releases keeps its own path');
  assert.equal(
    S.program({ compiled: false, execPath: REL.releaseBinary(l, '0.5.0-abc'), root: '/repo' }, home).script,
    path.join('/repo', 'bridge', 'supervisor.js'),
    'a checkout is never a release',
  );
  const plist = S.definition('darwin', S.dirs('darwin', {}, '/Users/p'), fromRelease, home);
  assert.ok(plist.includes(`<string>${S.xmlEscape(REL.currentBinary(l))}</string>\n    </array>`), 'one argument: the current binary');
  assert.ok(plist.includes(`<key>WorkingDirectory</key>\n    <string>${S.xmlEscape(home)}</string>`));
  assert.ok(!plist.includes(`${path.sep}releases${path.sep}`), 'no release folder is baked in, so a flip of current is enough');
  const programArgs = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)[1];
  assert.equal((programArgs.match(/<string>/g) || []).length, 1, 'no node and no script before or after the binary');
  assert.match(
    plist,
    new RegExp(`<key>PATH</key>\\s*<string>${S.xmlEscape(l.current).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${path.delimiter}`),
    'PATH starts with the current folder',
  );
});

test('status names every client in config.json with its installed build and which one spoke last', () => {
  const CLI = require('../bridge/clients');
  const dir = scratch('status-clients');
  const forever = path.join(dir, '_classic_beta_');
  const era = path.join(dir, '_classic_era_');
  fs.mkdirSync(path.join(era, 'Interface', 'AddOns', 'ClaudeWoW'), { recursive: true });
  fs.writeFileSync(path.join(era, 'Interface', 'AddOns', 'ClaudeWoW', 'ClaudeWoW.toc'), '## Version: 1.2.3\n## X-Build: abcdefabcdef\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ clients: [{ dir: forever }, { dir: era }] }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ clients: { [CLI.keyOf(era)]: { heard: Date.now() - 60000 } } }));
  const lines = [];
  fs.writeFileSync(path.join(dir, 'bridge.log'), '');
  S.status(
    { run: dir, logs: dir, definition: path.join(dir, 'none.plist') },
    'darwin',
    l => lines.push(l),
    path.join(dir, 'state.json'),
    path.join(dir, 'config.json'),
  );
  const at = lines.findIndex(l => l.startsWith('  clients   : '));
  assert.ok(at >= 0, lines.join('\n'));
  assert.equal(lines[at], `  clients   : _classic_beta_: addon not installed, not heard yet (${forever})`);
  assert.equal(lines[at + 1], `              _classic_era_: addon 1.2.3 build abcdefabcdef, heard 60 s ago, spoke last (${era})`);
  const none = [];
  S.status(
    { run: dir, logs: dir, definition: path.join(dir, 'none.plist') },
    'darwin',
    l => none.push(l),
    path.join(dir, 'state.json'),
    path.join(dir, 'missing.json'),
  );
  assert.ok(none.includes('  clients   : no config.json (claude-wow setup)'));
});

function fakeLaunchd({ teardownPolls = 3, bootstrapBroken = false, bootstrapRaces = false } = {}) {
  const state = { loaded: true, tearingDown: 0, calls: [], sleeps: 0 };
  const exec = (cmd, args) => {
    assert.equal(cmd, 'launchctl');
    const [sub] = args;
    state.calls.push(sub);
    if (sub === 'print') {
      if (state.loaded) return { ok: true, status: 0, out: 'state = running\npid = 4242\n' };
      if (state.tearingDown > 0) {
        state.tearingDown--;
        return { ok: true, status: 0, out: 'state = exiting\n' };
      }
      return { ok: false, status: 113, out: 'Could not find service "io.claudewow.bridge" in domain for port\n' };
    }
    if (sub === 'bootout') {
      state.loaded = false;
      state.tearingDown = teardownPolls;
      return { ok: true, status: 0, out: '' };
    }
    if (sub === 'bootstrap') {
      if (bootstrapRaces) {
        state.loaded = true;
        return { ok: false, status: 37, out: 'Bootstrap failed: 37: Operation already in progress\n' };
      }
      if (bootstrapBroken || state.loaded || state.tearingDown > 0) return { ok: false, status: 5, out: 'Bootstrap failed: 5: Input/output error\n' };
      state.loaded = true;
      return { ok: true, status: 0, out: '' };
    }
    if (sub === 'load') return { ok: true, status: 0, out: 'Load failed: 5: Input/output error\n' };
    throw new Error(`unexpected launchctl ${sub}`);
  };
  const b = Object.assign(Object.create(S.backend('darwin')), {
    exec,
    uid: () => 501,
    sleep: () => {
      state.sleeps++;
    },
    removeOld: () => false,
  });
  return { b, state };
}

test('install over a loaded LaunchAgent waits for bootout to finish, then ends loaded', () => {
  const dir = scratch('macinstall');
  const d = { logs: path.join(dir, 'logs'), run: path.join(dir, 'run'), definition: path.join(dir, 'LaunchAgents', `${S.LABEL}.plist`) };
  fs.mkdirSync(path.dirname(d.definition), { recursive: true });
  fs.writeFileSync(d.definition, '<plist>old</plist>');
  const { b, state } = fakeLaunchd({ teardownPolls: 3 });
  b.install(d);
  assert.equal(state.loaded, true, `the agent is loaded after install (calls: ${state.calls.join(' ')})`);
  assert.ok(state.calls.indexOf('bootout') < state.calls.indexOf('bootstrap'));
  assert.ok(!state.calls.includes('load'), 'no bootstrap ran while launchd was still tearing the old job down');
  assert.match(fs.readFileSync(d.definition, 'utf8'), /<key>Label<\/key>\s*<string>io\.claudewow\.bridge<\/string>/);
});

test('install makes the log folder and launchd.log private before launchd opens it, and repairs a public one', { skip: !POSIX }, () => {
  const dir = scratch('macinstallmode');
  const d = { logs: path.join(dir, 'logs'), run: path.join(dir, 'run'), definition: path.join(dir, 'LaunchAgents', `${S.LABEL}.plist`) };
  const { b } = fakeLaunchd();
  b.install(d);
  assert.equal(modeOf(d.logs), S.PRIVATE_DIR_MODE);
  assert.equal(modeOf(S.launchdLogFile(d)), S.PRIVATE_FILE_MODE, 'launchd appends to an existing file and keeps its mode');

  fs.chmodSync(d.logs, 0o755);
  publicFile(S.launchdLogFile(d), 'y'.repeat(2 * 1024 * 1024));
  publicFile(S.serviceLogFile(d));
  const again = fakeLaunchd();
  again.b.install(d);
  assert.equal(modeOf(d.logs), S.PRIVATE_DIR_MODE);
  assert.equal(modeOf(S.launchdLogFile(d)), S.PRIVATE_FILE_MODE);
  assert.equal(modeOf(S.launchdLogFile(d) + '.1'), S.PRIVATE_FILE_MODE, 'the rotated launchd log is private');
  assert.equal(modeOf(S.serviceLogFile(d)), S.PRIVATE_FILE_MODE);
});

test('systemd install makes the state folder and the service logs private', { skip: !POSIX }, () => {
  const dir = scratch('linuxinstallmode');
  const state = path.join(dir, 'state');
  const d = { logs: state, run: state, definition: path.join(dir, 'systemd', 'user', `${S.UNIT}.service`) };
  fs.mkdirSync(state, { mode: 0o755 });
  fs.chmodSync(state, 0o755);
  publicFile(S.serviceLogFile(d));
  publicFile(S.serviceLogFile(d) + '.3');
  const calls = [];
  const b = Object.assign(Object.create(S.backend('linux')), {
    exec: (cmd, args) => {
      assert.equal(cmd, 'systemctl');
      calls.push(args.join(' '));
      return { ok: true, status: 0, out: '' };
    },
    removeOld: () => false,
  });
  b.install(d);
  assert.ok(calls.includes(`--user enable --now ${S.UNIT}`));
  assert.equal(modeOf(state), S.PRIVATE_DIR_MODE);
  assert.equal(modeOf(S.serviceLogFile(d)), S.PRIVATE_FILE_MODE);
  assert.equal(modeOf(S.serviceLogFile(d) + '.3'), S.PRIVATE_FILE_MODE);
});

test('install fails loudly when launchd will not load the agent, even if the legacy load exits 0', () => {
  const dir = scratch('macinstallfail');
  const d = { logs: path.join(dir, 'logs'), run: path.join(dir, 'run'), definition: path.join(dir, 'LaunchAgents', `${S.LABEL}.plist`) };
  const { b, state } = fakeLaunchd({ bootstrapBroken: true });
  assert.throws(() => b.install(d), /launchctl could not load .*Bootstrap failed: 5/);
  assert.equal(state.loaded, false);
});

function fakeWindows({ alivePids = [], processes = {}, queryFails = false, killStatus = 0 } = {}) {
  const state = { queries: [], kills: [], launches: [] };
  const exec = (cmd, args) => {
    assert.equal(cmd, 'powershell.exe');
    const script = args[args.length - 1];
    if (script.includes('taskkill')) {
      const pid = Number(/taskkill\.exe \/PID (\d+)/.exec(script)[1]);
      state.kills.push({ pid, script });
      return { ok: killStatus === 0, status: killStatus, out: '' };
    }
    const pid = Number(/ProcessId=(\d+)/.exec(script)[1]);
    state.queries.push(pid);
    if (queryFails) return { ok: false, status: 1, out: 'Get-CimInstance : Access denied' };
    const proc = processes[pid];
    return { ok: true, status: 0, out: proc ? JSON.stringify(proc) + '\r\n' : '' };
  };
  const b = Object.assign(Object.create(S.backend('win32')), {
    exec,
    alive: pid => alivePids.includes(pid),
    program: () => ({ node: 'C:\\n\\node.exe', script: 'C:\\cw\\bridge\\supervisor.js', cwd: 'C:\\cw' }),
    launch: (node, args) => {
      state.launches.push([node, ...args]);
    },
  });
  return { b, state };
}

function winDirs(name, record) {
  const dir = scratch(name);
  const d = { run: dir, logs: dir, definition: path.join(dir, 'Startup', 'Claude WoW bridge.vbs') };
  if (record) fs.writeFileSync(S.pidFile(d), JSON.stringify(record));
  return d;
}

const STARTED = 1_700_000_000_000;
const SUPERVISOR = { created: STARTED - 400, command: '"C:\\n\\node.exe" "C:\\cw\\bridge\\supervisor.js"' };

test('Windows: a pid file whose pid now belongs to another program is stale, so stop kills nothing and start launches', () => {
  const record = { pid: 4242, bridgePid: 4243, started: STARTED, mode: 'service' };
  const reused = { created: STARTED + 3_600_000, command: '"C:\\Program Files\\Editor\\editor.exe"' };
  const stopD = winDirs('win-stale-stop', record);
  const { b, state } = fakeWindows({ alivePids: [4242], processes: { 4242: reused } });
  b.stop(stopD);
  assert.deepEqual(state.kills, [], 'no taskkill for a pid Windows gave to another program');
  assert.equal(S.readPid(stopD), null, 'the stale record is discarded');

  const startD = winDirs('win-stale-start', record);
  b.start(startD);
  assert.equal(state.launches.length, 1, 'start does not mistake the reused pid for a running service');
  assert.equal(S.readPid(startD), null);

  const probeD = winDirs('win-stale-probe', record);
  assert.deepEqual(b.probe(probeD), { loaded: false, pid: 0, state: 'stopped' });

  const oldD = winDirs('win-stale-old', record);
  fs.mkdirSync(path.dirname(oldD.definition), { recursive: true });
  fs.writeFileSync(oldD.definition, 'x');
  assert.equal(b.removeOld(oldD), true);
  assert.deepEqual(state.kills, [], "the old name's pid file is checked the same way");
  assert.equal(S.readPid(oldD), null);
});

test('Windows: a node process created after the record is stale even when its command line looks like the supervisor', () => {
  const record = { pid: 4242, started: STARTED, mode: 'service' };
  const d = winDirs('win-late-node', record);
  const { b, state } = fakeWindows({ alivePids: [4242], processes: { 4242: { ...SUPERVISOR, created: STARTED + S.CLOCK_SLACK_MS + 1 } } });
  b.stop(d);
  assert.deepEqual(state.kills, []);
});

test('Windows: the recorded supervisor is stopped with a kill that holds its handle and checks its start time again', () => {
  const record = { pid: 4242, bridgePid: 4243, started: STARTED, mode: 'service' };
  const d = winDirs('win-match', record);
  const { b, state } = fakeWindows({ alivePids: [4242], processes: { 4242: SUPERVISOR } });
  assert.deepEqual(b.probe(d), { loaded: true, pid: 4242, state: 'running' });
  b.start(d);
  assert.equal(state.launches.length, 0, 'a verified supervisor is already running');
  b.stop(d);
  assert.equal(state.kills.length, 1);
  assert.match(state.kills[0].script, /\$null = \$p\.Handle/);
  assert.ok(state.kills[0].script.includes(`-gt ${STARTED + S.CLOCK_SLACK_MS}`), state.kills[0].script);
  assert.equal(S.readPid(d), null);
});

test('Windows: when the kill finds another process behind the pid it is not an error; another taskkill failure is', () => {
  const record = { pid: 4242, started: STARTED, mode: 'service' };
  const changed = fakeWindows({ alivePids: [4242], processes: { 4242: SUPERVISOR }, killStatus: 3 });
  const d = winDirs('win-kill-changed', record);
  changed.b.stop(d);
  assert.equal(S.readPid(d), null);
  const broken = fakeWindows({ alivePids: [4242], processes: { 4242: SUPERVISOR }, killStatus: 1 });
  const d2 = winDirs('win-kill-broken', record);
  assert.throws(() => broken.b.stop(d2), /taskkill could not stop the supervisor \(pid 4242\)/);
  assert.equal(S.readPid(d2).pid, 4242, 'the record stays while the supervisor may still run');
});

test('Windows: when the identity cannot be read, stop and start fail closed and keep the record', () => {
  const record = { pid: 4242, started: STARTED, mode: 'service' };
  const d = winDirs('win-unknown', record);
  const { b, state } = fakeWindows({ alivePids: [4242], queryFails: true });
  assert.throws(() => b.stop(d), /could not confirm that pid 4242 is the bridge supervisor/);
  assert.throws(() => b.start(d), /could not confirm/);
  assert.deepEqual(state.kills, []);
  assert.deepEqual(state.launches, []);
  assert.equal(S.readPid(d).pid, 4242);
  assert.deepEqual(b.probe(d), { loaded: false, pid: 0, state: 'unverified' });
});

test('Windows: a record without a start time or with a hidden command line is never trusted', () => {
  const d = winDirs('win-legacy', { pid: 4242, mode: 'service' });
  const { b, state } = fakeWindows({ alivePids: [4242], processes: { 4242: SUPERVISOR } });
  assert.throws(() => b.stop(d), /could not confirm/);
  assert.deepEqual(state.kills, []);
  const hidden = fakeWindows({ alivePids: [4242], processes: { 4242: { created: SUPERVISOR.created, command: '' } } });
  const d2 = winDirs('win-hidden', { pid: 4242, started: STARTED, mode: 'service' });
  assert.throws(() => hidden.b.stop(d2), /could not confirm/);
  assert.deepEqual(hidden.state.kills, []);
});

test('Windows: a dead pid or a pid file that is not a number runs no command and is discarded', () => {
  const { b, state } = fakeWindows({ alivePids: [] });
  const d = winDirs('win-dead', { pid: 4242, started: STARTED, mode: 'service' });
  b.stop(d);
  assert.equal(S.readPid(d), null);
  const d2 = winDirs('win-junk', { pid: '4242; Stop-Computer', started: STARTED, mode: 'service' });
  b.start(d2);
  assert.deepEqual(state.queries, []);
  assert.deepEqual(state.kills, []);
  assert.equal(state.launches.length, 1);
  assert.throws(() => S.winProcessQuery('1; Stop-Computer'), /not a pid/);
  assert.throws(() => S.winVerifiedKill({ pid: 1 }), /no verified supervisor/);
});

test('Windows identity parsing: empty output is gone, junk is unknown, a match needs an early creation time and a supervisor command line', () => {
  assert.deepEqual(S.parseWinProcess(''), { state: 'gone' });
  assert.deepEqual(S.parseWinProcess('WARNING: something'), { state: 'unknown' });
  assert.deepEqual(S.parseWinProcess('{"created":5,"command":null}'), { state: 'found', created: 5, command: '' });
  const record = { pid: 1, started: STARTED };
  assert.equal(S.supervisorIdentity(record, { state: 'found', ...SUPERVISOR }), 'match');
  assert.equal(S.supervisorIdentity(record, { state: 'found', created: STARTED, command: 'C:\\Users\\p\\bin\\claude-wow.exe' }), 'match');
  assert.equal(S.supervisorIdentity(record, { state: 'found', created: STARTED, command: 'C:\\n\\node.exe C:\\other\\server.js' }), 'stale');
  assert.equal(S.supervisorIdentity(record, { state: 'found', created: STARTED + S.CLOCK_SLACK_MS + 1, command: SUPERVISOR.command }), 'stale');
  assert.equal(S.supervisorIdentity({ pid: 1 }, { state: 'found', ...SUPERVISOR }), 'unknown');
  assert.equal(S.supervisorIdentity(record, { state: 'gone' }), 'gone');
});

test('Windows status: a reused pid is not reported as the running supervisor', () => {
  const record = { pid: 4242, bridgePid: 4243, started: STARTED, mode: 'service' };
  const d = winDirs('win-status', record);
  fs.writeFileSync(path.join(d.logs, 'bridge.log'), '');
  const reused = fakeWindows({ alivePids: [4242, 4243], processes: { 4242: { created: STARTED + 60_000, command: 'editor.exe' } } });
  const lines = [];
  const code = S.status(d, 'win32', l => lines.push(l), path.join(d.run, 'state.json'), path.join(d.run, 'config.json'), reused.b);
  assert.equal(code, 3);
  assert.ok(lines.includes('  running   : no'), lines.join('\n'));
  const unknown = fakeWindows({ alivePids: [4242], queryFails: true });
  const lines2 = [];
  S.status(d, 'win32', l => lines2.push(l), path.join(d.run, 'state.json'), path.join(d.run, 'config.json'), unknown.b);
  assert.ok(
    lines2.some(l => /running   : unknown, pid 4242/.test(l)),
    lines2.join('\n'),
  );
});

test('Windows status: an installed service is verified once, so a pid reused between two checks is never reported as running', () => {
  const record = { pid: 4242, bridgePid: 4243, started: STARTED, mode: 'service' };
  const d = winDirs('win-status-installed', record);
  fs.mkdirSync(path.dirname(d.definition), { recursive: true });
  fs.writeFileSync(d.definition, 'x');
  fs.writeFileSync(path.join(d.logs, 'bridge.log'), '');
  const answers = [SUPERVISOR, { created: STARTED + 60_000, command: 'editor.exe' }];
  const { b, state } = fakeWindows({
    alivePids: [4242, 4243],
    processes: {
      get 4242() {
        return answers[Math.min(state.queries.length - 1, 1)];
      },
    },
  });
  const lines = [];
  const code = S.status(d, 'win32', l => lines.push(l), path.join(d.run, 'state.json'), path.join(d.run, 'config.json'), b);
  assert.equal(state.queries.length, 1, 'one identity query per status');
  assert.equal(code, 0);
  assert.ok(
    lines.some(l => /running   : yes, as the service: supervisor pid 4242/.test(l)),
    lines.join('\n'),
  );
  assert.ok(!lines.some(l => /no pid file yet/.test(l)), lines.join('\n'));
});

test('Windows install preflight: a terminal bridge blocks install only when its pid is verified as the supervisor', () => {
  const record = { pid: 4242, bridgePid: 4243, started: STARTED, mode: 'terminal' };
  const terminalProblems = (name, fake) => {
    const d = winDirs(name, record);
    return { d, problems: S.preflight(d, fake.b).filter(p => !/config\.json is missing/.test(p)) };
  };
  const reused = fakeWindows({ alivePids: [4242], processes: { 4242: { created: STARTED + 3_600_000, command: '"C:\\Program Files\\Editor\\editor.exe"' } } });
  assert.deepEqual(terminalProblems('win-pre-reused', reused).problems, [], 'a pid Windows gave to another program does not block install');
  assert.deepEqual(reused.state.queries, [4242]);
  const lateNode = fakeWindows({ alivePids: [4242], processes: { 4242: { ...SUPERVISOR, created: STARTED + S.CLOCK_SLACK_MS + 1 } } });
  assert.deepEqual(terminalProblems('win-pre-late', lateNode).problems, []);
  const running = fakeWindows({ alivePids: [4242], processes: { 4242: SUPERVISOR } });
  const match = terminalProblems('win-pre-match', running).problems;
  assert.equal(match.length, 1);
  assert.match(match[0], /already running in a terminal \(pid 4242\)/);
  const unreadable = fakeWindows({ alivePids: [4242], queryFails: true });
  const { d, problems } = terminalProblems('win-pre-unknown', unreadable);
  assert.equal(problems.length, 1, 'an unreadable identity still blocks install');
  assert.match(problems[0], /could not confirm whether pid 4242/);
  assert.ok(problems[0].includes(S.pidFile(d)), problems[0]);
  const dead = fakeWindows({ alivePids: [] });
  assert.deepEqual(terminalProblems('win-pre-dead', dead).problems, []);
  assert.deepEqual(dead.state.queries, [], 'a dead pid runs no query');
  const service = fakeWindows({ alivePids: [4242], processes: { 4242: SUPERVISOR } });
  const sd = winDirs('win-pre-service', { ...record, mode: 'service' });
  assert.deepEqual(
    S.preflight(sd, service.b).filter(p => !/config\.json is missing/.test(p)),
    [],
  );
  assert.deepEqual(service.state.queries, [], 'a service record is left to install');
});

test('install preflight off Windows: a live terminal pid blocks install, a dead one does not', () => {
  const d = winDirs('posix-pre', { pid: process.pid, started: STARTED, mode: 'terminal' });
  const terminal = ps => ps.filter(p => !/config\.json is missing/.test(p));
  assert.match(terminal(S.preflight(d, S.backend('linux')))[0], new RegExp(`terminal \\(pid ${process.pid}\\)`));
  fs.writeFileSync(S.pidFile(d), JSON.stringify({ pid: 2147483000, started: STARTED, mode: 'terminal' }));
  assert.deepEqual(terminal(S.preflight(d, S.backend('linux'))), []);
});

test('Windows orphaned agent run: only a process created before the run started and named by its marker is ended, through the verified kill', () => {
  const run = { pid: 5150, startedAt: STARTED, marker: 'claude.exe' };
  const agent = { created: STARTED - 200, command: '"C:\\Users\\p\\.local\\bin\\claude.exe" -p --output-format stream-json' };
  assert.equal(S.agentRunIdentity(run, { state: 'found', ...agent }), 'match');
  assert.equal(S.agentRunIdentity(run, { state: 'found', ...agent, command: 'C:\\Windows\\notepad.exe' }), 'stale');
  assert.equal(S.agentRunIdentity(run, { state: 'found', ...agent, created: STARTED + S.CLOCK_SLACK_MS + 1 }), 'stale');
  assert.equal(S.agentRunIdentity({ pid: 5150, startedAt: STARTED }, { state: 'found', ...agent }), 'unknown', 'no marker is never trusted');
  assert.equal(S.agentRunIdentity(run, { state: 'found', ...agent, command: '' }), 'unknown');
  assert.equal(S.agentRunIdentity(run, { state: 'gone' }), 'gone');

  const { b, state } = fakeWindows({ alivePids: [5150], processes: { 5150: agent } });
  assert.equal(S.endWinAgentRun(run, b.exec), 'ended');
  assert.equal(state.kills.length, 1);
  assert.match(state.kills[0].script, /\$null = \$p\.Handle/);
  assert.ok(state.kills[0].script.includes(`-gt ${STARTED + S.CLOCK_SLACK_MS}`), state.kills[0].script);

  const reused = fakeWindows({ alivePids: [5150], processes: { 5150: { created: STARTED + 60_000, command: 'C:\\Windows\\notepad.exe' } } });
  assert.equal(S.endWinAgentRun(run, reused.b.exec), 'stale');
  assert.deepEqual(reused.state.kills, [], 'a pid Windows gave to another program is left alone');

  const unreadable = fakeWindows({ alivePids: [5150], queryFails: true });
  assert.equal(S.endWinAgentRun(run, unreadable.b.exec), 'unknown');
  assert.deepEqual(unreadable.state.kills, [], 'no kill when the identity cannot be read');

  const changed = fakeWindows({ alivePids: [5150], processes: { 5150: agent }, killStatus: 3 });
  assert.equal(S.endWinAgentRun(run, changed.b.exec), 'stale');
  const broken = fakeWindows({ alivePids: [5150], processes: { 5150: agent }, killStatus: 1 });
  assert.equal(S.endWinAgentRun(run, broken.b.exec), 'failed');
  assert.equal(S.endWinAgentRun({ pid: '5150; Stop-Computer', startedAt: STARTED, marker: 'x' }, b.exec), 'gone');
});
