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

async function darwinRunning(folders, run) {
  const out = String(await run('ps', ['-axo', 'command='], PS_TIMEOUT_MS));
  const lines = out.split('\n').filter(line => line.trim());
  if (!lines.length) return null;
  return lines.some(line => folders.some(folder => line.includes(folder + '/')));
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

async function windowsRunning(folders, run) {
  const rows = parseWindowsList(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT], POWERSHELL_TIMEOUT_MS));
  if (!rows) return null;
  if (rows.some(row => row.exe && insideWindowsFolder(row.exe, folders))) return true;
  if (rows.some(row => !row.exe && WOW_PROCESS_NAME.test(row.name))) return null;
  return false;
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

async function linuxProcessVerdict(pid, folders, fsApi) {
  const dir = `/proc/${pid}`;
  const exe = await fsApi.readlink(`${dir}/exe`);
  if (insidePosixFolder(exe, folders)) return true;
  const cwd = await fsApi.readlink(`${dir}/cwd`);
  if (insidePosixFolder(cwd, folders)) return true;
  const args = String(await fsApi.readFile(`${dir}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  for (const arg of args) {
    if (arg.startsWith('/') && insidePosixFolder(arg, folders)) return true;
    if (WINDOWS_ABSOLUTE.test(arg) && wineExeInside(arg, folders)) return true;
  }
  const unplacedWowExe = args.some(arg => !arg.startsWith('/') && !WINDOWS_ABSOLUTE.test(arg) && WOW_EXE_BASENAME.test(path.win32.basename(arg)));
  return unplacedWowExe ? null : false;
}

async function linuxRunning(folders, fsApi, uid) {
  if (!Number.isInteger(uid)) return null;
  let verdict = false;
  for (const entry of await fsApi.readdir('/proc')) {
    if (!NUMERIC.test(entry)) continue;
    try {
      if ((await fsApi.stat(`/proc/${entry}`)).uid !== uid) continue;
      const one = await linuxProcessVerdict(entry, folders, fsApi);
      if (one === true) return true;
      if (one === null) verdict = null;
    } catch (e) {
      if (gone(e)) continue;
      return null;
    }
  }
  return verdict;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

async function clientRunning(folder, { platform = process.platform, listProcesses, run, fs: fsApi = fsPromises, uid = currentUid() } = {}) {
  if (!cleanSupported(platform) || !folder || !trimSeparators(folder)) return null;
  const runner = listProcesses ? async () => listProcesses() : (run || runText);
  try {
    const folders = await folderCandidates(folder, fsApi);
    if (platform === 'darwin') return await darwinRunning(folders, runner);
    if (platform === 'win32') return await windowsRunning(folders, runner);
    return await linuxRunning(folders, fsApi, uid);
  } catch {
    return null;
  }
}

module.exports = { SUPPORTED_PLATFORMS, WINDOWS_SCRIPT, cleanSupported, clientRunning, parseWindowsList, runText };
