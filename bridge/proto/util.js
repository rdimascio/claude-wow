'use strict';

const os = require('os');
const path = require('path');

const ADDON = 'ClaudeWoW';
const RUNTIME_ADDON = ADDON + '_Runtime';
const SHIPPED_INBOX_PATH = new RegExp('(^|[\\\\/])' + ADDON + '[\\\\/]Inbox\\.lua$');
const OLD_ADDONS = ['WoWAI', 'WoWClaude'];
const OLD_ADDON_PATH = new RegExp('(^|[\\\\/])(' + OLD_ADDONS.join('|') + ')([\\\\/]|$)');
const OLD_SAVED_FILE = new RegExp('(' + OLD_ADDONS.join('|') + ')\\.lua$');
const TOC_INTERFACE = '11509, 16001';
const OLD_TOC_INTERFACES = Object.freeze(['16001']);

function fromHex(hex) {
  return Buffer.from(hex || '', 'hex').toString('utf8');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

function isWindowsAbsolute(p) {
  const value = String(p || '');
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

function baseName(p) {
  return (
    String(p || '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || ''
  );
}

function comparableWindowsPath(p) {
  const normalized = path.win32.normalize(String(p || ''));
  return normalized.length > 3 ? normalized.replace(/[\\/]$/, '') : normalized;
}

const LATE_IN_MAX = 3600;

const OPEN_RESULTS = ['ok', 'refused'];

function resolveCwd(raw, base) {
  let p = String(raw || '').trim();
  if (!p) return base;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    p = path.join(os.homedir(), p.slice(1).replace(/^[\\/]+/, ''));
  }
  if (isWindowsAbsolute(p)) return path.win32.normalize(p);
  return path.resolve(base, p);
}

function sameFolder(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (isWindowsAbsolute(left) || isWindowsAbsolute(right)) {
    return comparableWindowsPath(left).toLowerCase() === comparableWindowsPath(right).toLowerCase();
  }
  return path.resolve(left) === path.resolve(right);
}

function luaStr(s) {
  return (
    '"' +
    String(s ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, c => '\\' + String(c.charCodeAt(0)).padStart(3, '0')) +
    '"'
  );
}

function cleanText(s, max) {
  return String(s ?? '')
    .replace(/[\x00-\x1f\x7f|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

module.exports = {
  ADDON,
  RUNTIME_ADDON,
  SHIPPED_INBOX_PATH,
  OLD_ADDONS,
  OLD_ADDON_PATH,
  OLD_SAVED_FILE,
  TOC_INTERFACE,
  OLD_TOC_INTERFACES,
  fromHex,
  pad3,
  isWindowsAbsolute,
  baseName,
  comparableWindowsPath,
  LATE_IN_MAX,
  OPEN_RESULTS,
  resolveCwd,
  sameFolder,
  luaStr,
  cleanText,
};
