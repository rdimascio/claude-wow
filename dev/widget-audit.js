#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const luaparse = require('luaparse');
const H = require('../bridge/home');
const CLI = require('../bridge/clients');

const TABLE_NAME = 'ClaudeWoWWidgetDB';
const SHOWN_DEFAULT = 60;

const WRITER_VERBS = new Set([
  'Abandon',
  'Accept',
  'Add',
  'Assist',
  'Attack',
  'Bid',
  'Buy',
  'Cancel',
  'Cast',
  'Claim',
  'Clear',
  'Click',
  'Close',
  'Complete',
  'Confirm',
  'Craft',
  'Create',
  'Decline',
  'Delete',
  'Demote',
  'Deposit',
  'Destroy',
  'Disable',
  'Do',
  'Drop',
  'Edit',
  'Enable',
  'Equip',
  'Execute',
  'Focus',
  'Follow',
  'Hide',
  'Ignore',
  'Initiate',
  'Interact',
  'Invite',
  'Jump',
  'Kick',
  'Learn',
  'Leave',
  'Load',
  'Logout',
  'Move',
  'Mute',
  'Open',
  'Pickup',
  'Place',
  'Play',
  'Post',
  'Promote',
  'Purchase',
  'Quit',
  'Register',
  'Release',
  'Remove',
  'Repair',
  'Report',
  'Request',
  'Reset',
  'Retrieve',
  'Run',
  'Save',
  'Select',
  'Sell',
  'Send',
  'Set',
  'Show',
  'Split',
  'Start',
  'Stop',
  'Strafe',
  'Submit',
  'Swap',
  'Switch',
  'Take',
  'Target',
  'Toggle',
  'Track',
  'Trigger',
  'Turn',
  'Unequip',
  'Unignore',
  'Uninvite',
  'Unlearn',
  'Unload',
  'Unmute',
  'Unregister',
  'Untrack',
  'Use',
  'Withdraw',
]);
const GETTER_VERBS = new Set(['Get', 'Is', 'Has', 'Can', 'Does', 'Are', 'Should', 'Find']);

function tableSource(text, name = TABLE_NAME) {
  const start = new RegExp(`^${name}\\s*=\\s*\\{`, 'm').exec(String(text || ''));
  if (!start) return '';
  const rest = text.slice(start.index);
  const end = /^\}\r?$/m.exec(rest.slice(start[0].length));
  if (!end) return '';
  return rest.slice(0, start[0].length + end.index + 1);
}

function valueOf(node) {
  if (!node) return undefined;
  switch (node.type) {
    case 'StringLiteral':
      return node.value;
    case 'NumericLiteral':
      return node.value;
    case 'BooleanLiteral':
      return node.value;
    case 'NilLiteral':
      return null;
    case 'UnaryExpression':
      return node.operator === '-' ? -valueOf(node.argument) : undefined;
    case 'TableConstructorExpression':
      return tableOf(node);
    default:
      return undefined;
  }
}

function tableOf(node) {
  const list = [];
  const map = {};
  let keyed = false;
  for (const field of node.fields) {
    if (field.type === 'TableValue') list.push(valueOf(field.value));
    else if (field.type === 'TableKey') {
      keyed = true;
      map[String(valueOf(field.key))] = valueOf(field.value);
    } else if (field.type === 'TableKeyString') {
      keyed = true;
      map[field.key.name] = valueOf(field.value);
    }
  }
  if (!keyed) return list;
  list.forEach((v, i) => (map[String(i + 1)] = v));
  return map;
}

function listOf(value) {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string');
  if (value && typeof value === 'object')
    return Object.keys(value)
      .filter(k => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map(k => value[k])
      .filter(v => typeof v === 'string');
  return [];
}

function parseDump(text) {
  const source = tableSource(text);
  if (!source) return null;
  let ast;
  try {
    ast = luaparse.parse(source, { luaVersion: '5.1', encodingMode: 'pseudo-latin1', comments: false });
  } catch (e) {
    throw new Error(`cannot parse ${TABLE_NAME}: ${e.message}`);
  }
  const statement = ast.body[0];
  const db = statement && statement.init && valueOf(statement.init[0]);
  const globals = db && !Array.isArray(db) ? db.globals : null;
  if (!globals || typeof globals !== 'object' || Array.isArray(globals)) return null;
  return {
    version: String(globals.version ?? '?'),
    build: String(globals.build ?? '?'),
    interface: Number(globals.interface) || 0,
    at: Number(globals.at) || 0,
    total: Number(globals.total) || 0,
    saved: Number(globals.saved) || 0,
    admittedCount: Number(globals.admittedCount) || 0,
    refusedCount: Number(globals.refusedCount) || 0,
    truncated: globals.truncated === true,
    admitted: listOf(globals.admitted),
    refused: listOf(globals.refused),
  };
}

function memberOf(name) {
  const dot = name.indexOf('.');
  if (dot >= 0) return name.slice(dot + 1);
  if (/^Unit[A-Z]/.test(name)) return name.slice(4);
  return name;
}

function verbOf(name) {
  const m = /^[A-Z][a-z]*/.exec(memberOf(name));
  return m ? m[0] : '';
}

const looksLikeWriter = name => WRITER_VERBS.has(verbOf(name));
const looksLikeGetter = name => GETTER_VERBS.has(verbOf(name)) || (/^Unit[A-Z]/.test(name) && !looksLikeWriter(name));

function audit(dump) {
  return {
    client: { version: dump.version, build: dump.build, interface: dump.interface, at: dump.at },
    counts: { total: dump.total, saved: dump.saved, admitted: dump.admittedCount, refused: dump.refusedCount, truncated: dump.truncated },
    admittedWriters: dump.admitted.filter(looksLikeWriter),
    missedGetters: dump.refused.filter(looksLikeGetter),
  };
}

function section(title, names, shown) {
  const lines = [`${title}: ${names.length}`];
  const limit = shown === Infinity ? names.length : Math.min(names.length, shown);
  for (let i = 0; i < limit; i++) lines.push(`  ${names[i]}`);
  if (names.length > limit) lines.push(`  ... ${names.length - limit} more (--all lists them)`);
  return lines;
}

function formatReport(report, file, shown = SHOWN_DEFAULT) {
  const { client, counts } = report;
  const when = client.at > 0 && client.at <= 8.64e12 ? new Date(client.at * 1000).toISOString() : 'unknown time';
  const lines = [
    `widget allowlist audit: ${file}`,
    `client ${client.version} (${client.build}), interface ${client.interface}, dumped ${when}`,
    `${counts.saved} of ${counts.total} names saved: ${counts.admitted} a widget can use, ${counts.refused} it cannot`,
  ];
  if (counts.truncated) lines.push(`the dump was cut at ${counts.saved} names, so some refused names are missing below`);
  lines.push('');
  lines.push(...section('admitted names that look like writers or actions (check each)', report.admittedWriters, shown));
  lines.push(...section('refused names that look like display getters (candidates to admit)', report.missedGetters, shown));
  return lines.join('\n');
}

function savedFiles(env = process.env, home = undefined) {
  const homePaths = H.resolve(env, home);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(homePaths.config, 'utf8'));
  } catch {
    return [];
  }
  return CLI.clientsOf(cfg)
    .map(c => c.savedVariablesFile)
    .filter(Boolean);
}

function parseArgs(argv) {
  const opts = { json: false, all: false, files: [] };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else opts.files.push(path.resolve(arg));
  }
  return opts;
}

const USAGE = [
  'usage: npm run audit:widgets -- [ClaudeWoW.lua ...] [--all] [--json]',
  'Reads the names /claude dev globals saved in the account SavedVariables file and lists',
  'admitted names that look like writers, and refused names that look like display getters.',
  'With no file it reads every client in the bridge config.json.',
].join('\n');

function main(argv = process.argv.slice(2), { out = console.log, err = console.error, env = process.env, home } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  const files = opts.files.length ? opts.files : savedFiles(env, home);
  if (!files.length) {
    err('No SavedVariables file: pass one, or run claude-wow setup so config.json names the game client.');
    return 2;
  }
  let found = 0;
  const reports = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      err(`${file}: cannot read (${e.code || e.message})`);
      continue;
    }
    let dump;
    try {
      dump = parseDump(text);
    } catch (e) {
      err(`${file}: ${e.message}`);
      continue;
    }
    if (!dump) {
      err(`${file}: no saved global names. Type /claude dev globals in game, then /reload.`);
      continue;
    }
    found++;
    const report = audit(dump);
    if (opts.json) reports.push({ file, ...report });
    else out(formatReport(report, file, opts.all ? Infinity : SHOWN_DEFAULT));
  }
  if (opts.json && reports.length) out(JSON.stringify(reports, null, 2));
  return found ? 0 : 2;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseDump, audit, formatReport, tableSource, verbOf, looksLikeWriter, looksLikeGetter, savedFiles, USAGE };
