'use strict';
const fsPromises = require('fs').promises;
const path = require('path');

const SUPPORTED_PLATFORMS = ['darwin', 'win32', 'linux'];
const PS_TIMEOUT_MS = 10000;
const POWERSHELL_TIMEOUT_MS = 20000;
const LIST_MAX_BUFFER = 16 * 1024 * 1024;
const WINDOWS_BEGIN = 'cwps begin';
const WINDOWS_END = 'cwps end';
const WINDOWS_ROW = /^p ([A-Za-z0-9+/=]*),([A-Za-z0-9+/=]*)$/;
const WOW_PROCESS_NAME = /^wow/i;
const WOW_EXE_BASENAME = /^wow[\w-]*\.exe$/i;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_LONG_PATH_PREFIX = /^\\\\\?\\/;
const NUMERIC = /^\d+$/;
const KERNEL_RELEASE_FILE = '/proc/sys/kernel/osrelease';
const WSL_KERNEL = /microsoft|wsl/i;
const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'];
const WINDOWS_DRIVE_MOUNT = /^\/mnt\/[a-z](\/|$)/i;

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'function B([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }',
  `'${WINDOWS_BEGIN}'`,
  "Get-CimInstance Win32_Process | ForEach-Object { 'p ' + (B $_.Name) + ',' + (B $_.ExecutablePath) }",
  `'${WINDOWS_END}'`,
].join('; ');

function cleanSupported(platform) {
  return SUPPORTED_PLATFORMS.includes(platform);
}

const RUNNING = { running: true, why: 'the game is running' };
const CLOSED = { running: false, why: 'the game is closed' };
const unknown = (why) => ({ running: null, why });

function errorCode(e) {
  return String((e && e.code) || 'error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 24) || 'error';
}

function trimSeparators(p) {
  return String(p).replace(/[\\/]+$/, '');
}

async function folderCandidates(folder, fsApi) {
  const configured = trimSeparators(folder);
  const found = [configured];
  try {
    const real = trimSeparators(await fsApi.realpath(configured));
    if (real && !found.includes(real)) found.push(real);
  } catch {}
  return found;
}

function windowsKey(p) {
  return String(p).replace(WINDOWS_LONG_PATH_PREFIX, '').replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
}

function insideWindowsFolder(file, folders) {
  const f = windowsKey(file);
  return folders.some(folder => f === windowsKey(folder) || f.startsWith(windowsKey(folder) + '\\'));
}

function insidePosixFolder(file, folders) {
  const f = String(file);
  return folders.some(folder => f === folder || f.startsWith(folder + '/'));
}

function runText(file, args, timeout) {
  return new Promise((resolve, reject) => {
    require('child_process').execFile(file, args, { encoding: 'utf8', timeout, maxBuffer: LIST_MAX_BUFFER, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

async function listOutput(run, file, args, timeout) {
  try {
    return { out: String(await run(file, args, timeout)) };
  } catch (e) {
    return { failed: unknown(`the process list failed (${errorCode(e)})`) };
  }
}

async function darwinState(folders, run) {
  const { out, failed } = await listOutput(run, 'ps', ['-axo', 'command='], PS_TIMEOUT_MS);
  if (failed) return failed;
  const lines = out.split('\n').filter(line => line.trim());
  if (!lines.length) return unknown('the process list was empty');
  return lines.some(line => folders.some(folder => line.includes(folder + '/'))) ? RUNNING : CLOSED;
}

function decodeBase64(text) {
  return Buffer.from(text, 'base64').toString('utf8');
}

function parseWindowsList(out) {
  const lines = String(out).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== WINDOWS_BEGIN || lines[lines.length - 1] !== WINDOWS_END) return null;
  const rows = [];
  for (const line of lines.slice(1, -1)) {
    const m = WINDOWS_ROW.exec(line);
    if (!m) return null;
    rows.push({ name: decodeBase64(m[1]), exe: decodeBase64(m[2]) });
  }
  return rows.length ? rows : null;
}

async function windowsState(folders, run) {
  const { out, failed } = await listOutput(run, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], POWERSHELL_TIMEOUT_MS);
  if (failed) return failed;
  const rows = parseWindowsList(out);
  if (!rows) return unknown('the process list could not be read');
  if (rows.some(row => row.exe && insideWindowsFolder(row.exe, folders))) return RUNNING;
  if (rows.some(row => !row.exe && WOW_PROCESS_NAME.test(row.name))) return unknown('a WoW process hides its path');
  return CLOSED;
}

function gone(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ESRCH');
}

function posixKey(p) {
  return trimSeparators(String(p).replace(/\\/g, '/')).toLowerCase();
}

function wineExeInside(arg, folders) {
  const winPath = posixKey(arg.slice(2));
  return folders.some(folder => {
    const unix = posixKey(folder);
    for (let at = unix.indexOf('/'); at >= 0; at = unix.indexOf('/', at + 1)) {
      const tail = unix.slice(at);
      if (tail !== '' && tail !== '/' && winPath.startsWith(tail + '/')) return true;
    }
    return false;
  });
}

function namesWowExe(arg) {
  return WOW_EXE_BASENAME.test(path.win32.basename(arg));
}

async function commandArgs(dir, fsApi) {
  return String(await fsApi.readFile(`${dir}/cmdline`, 'utf8')).split('\0').filter(Boolean);
}

function argsPlaceGame(args, folders) {
  return args.some(arg => (arg.startsWith('/') && insidePosixFolder(arg, folders)) || (WINDOWS_ABSOLUTE.test(arg) && wineExeInside(arg, folders)));
}

async function ownProcessState(pid, folders, fsApi) {
  const dir = `/proc/${pid}`;
  if (insidePosixFolder(await fsApi.readlink(`${dir}/exe`), folders)) return RUNNING;
  if (insidePosixFolder(await fsApi.readlink(`${dir}/cwd`), folders)) return RUNNING;
  const args = await commandArgs(dir, fsApi);
  if (argsPlaceGame(args, folders)) return RUNNING;
  if (args.some(namesWowExe)) return unknown('a WoW exe runs that the bridge cannot place in a folder');
  return CLOSED;
}

async function foreignProcessState(pid, folders, fsApi) {
  const args = await commandArgs(`/proc/${pid}`, fsApi);
  if (argsPlaceGame(args, folders) || args.some(namesWowExe)) return unknown('a process of another user may be the game');
  return CLOSED;
}

async function exists(file, fsApi) {
  try {
    await fsApi.stat(file);
    return true;
  } catch (e) {
    if (gone(e)) return false;
    throw e;
  }
}

async function linuxEnvironment(folders, fsApi) {
  if (folders.some(folder => WINDOWS_DRIVE_MOUNT.test(folder))) return unknown('the client folder is on a Windows drive (/mnt/<letter>), where the game runs outside this Linux');
  let release;
  try { release = String(await fsApi.readFile(KERNEL_RELEASE_FILE, 'utf8')); } catch (e) { return unknown(`cannot read ${KERNEL_RELEASE_FILE} (${errorCode(e)})`); }
  if (WSL_KERNEL.test(release)) return unknown('the bridge runs in WSL, where the game runs on Windows');
  for (const marker of CONTAINER_MARKERS) {
    try {
      if (await exists(marker, fsApi)) return unknown('the bridge runs in a container, where the game runs outside');
    } catch (e) {
      return unknown(`cannot check ${marker} (${errorCode(e)})`);
    }
  }
  return null;
}

async function linuxState(folders, fsApi, uid) {
  if (!Number.isInteger(uid)) return unknown('no user id');
  const outside = await linuxEnvironment(folders, fsApi);
  if (outside) return outside;
  let entries;
  try { entries = await fsApi.readdir('/proc'); } catch (e) { return unknown(`cannot read /proc (${errorCode(e)})`); }
  let state = CLOSED;
  for (const entry of entries) {
    if (!NUMERIC.test(entry)) continue;
    try {
      const own = (await fsApi.stat(`/proc/${entry}`)).uid === uid;
      const one = own ? await ownProcessState(entry, folders, fsApi) : await foreignProcessState(entry, folders, fsApi);
      if (one.running === true) return one;
      if (one.running === null && state.running === false) state = one;
    } catch (e) {
      if (gone(e)) continue;
      return unknown(`cannot read a process in /proc (${errorCode(e)})`);
    }
  }
  return state;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

async function clientState(folder, { platform = process.platform, listProcesses, run, fs: fsApi = fsPromises, uid = currentUid() } = {}) {
  if (!cleanSupported(platform)) return unknown(`no process check on ${platform}`);
  if (!folder || !trimSeparators(folder)) return unknown('no client folder');
  const runner = listProcesses ? async () => listProcesses() : (run || runText);
  try {
    const folders = await folderCandidates(folder, fsApi);
    if (platform === 'darwin') return await darwinState(folders, runner);
    if (platform === 'win32') return await windowsState(folders, runner);
    return await linuxState(folders, fsApi, uid);
  } catch (e) {
    return unknown(`the process check failed (${errorCode(e)})`);
  }
}

async function clientRunning(folder, opts) {
  return (await clientState(folder, opts)).running;
}

module.exports = { SUPPORTED_PLATFORMS, WINDOWS_SCRIPT, cleanSupported, clientState, clientRunning, parseWindowsList, runText };
