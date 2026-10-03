#!/usr/bin/env node
'use strict';
// Creates the reply-slot addons and signal files that the no-reload transport needs.
// WoW only indexes addon folders and files at launch, so run this once, then restart
// the game. Safe to re-run: existing files are left alone.

const fs = require('fs');
const path = require('path');
const G = require('./gamefs');
const SIG = require('./signals');
const P = require('./protocol');
const CLI = require('./clients');
const CL = require('./chatlog');

const HOME = require('./home').resolve();
const cfg = JSON.parse(fs.readFileSync(HOME.config, 'utf8'));
const N = cfg.slots || SIG.DEFAULT_SLOTS;
const ACT = cfg.actMax || SIG.DEFAULT_ACT_MAX;
const PRESENCE = cfg.presenceMax || SIG.DEFAULT_PRESENCE_MAX;
const clients = CLI.clientsOf(cfg);

let state = {};
try { state = JSON.parse(fs.readFileSync(HOME.state, 'utf8')); } catch {}

if (!clients.length) {
  console.error('config.json names no WoW client (no "clients" and no addonDir); run setup first');
  process.exit(1);
}

let failed = 0;
function ensure(file, content, counts, { replaceWhenDifferent = false } = {}) {
  if (fs.existsSync(file)) {
    if (replaceWhenDifferent && fs.readFileSync(file, 'utf8') !== content) { G.writeFile(file, content); counts.updated++; return; }
    counts.kept++;
    return;
  }
  G.mkdir(path.dirname(file));
  G.writeFile(file, content);
  counts.made++;
}

function install(client) {
  const addons = client.addonDir;
  const iface = client.tocInterface;
  const tag = clients.length > 1 ? `${client.label}: ` : '';
  if (!fs.existsSync(path.join(addons, P.ADDON, P.ADDON + '.toc'))) {
    console.error(`${tag}${P.ADDON} addon not found under ${addons}`);
    failed++;
    return;
  }
  const counts = { made: 0, kept: 0, updated: 0 };
  for (let i = 1; i <= N; i++) {
    const name = 'ClaudeWoW_S' + String(i).padStart(3, '0');
    const dir = path.join(addons, name);
    ensure(path.join(dir, name + '.toc'), [
      '## Interface: ' + iface,
      '## Title: Claude WoW slot ' + String(i).padStart(3, '0'),
      '## Notes: Reply slot for Claude WoW. Load-on-demand; leave it enabled.',
      '## LoadOnDemand: 1',
      '## Dependencies: ClaudeWoW',
      '',
      'Inbox.lua',
      '',
    ].join('\n'), counts, { replaceWhenDifferent: true });
    ensure(path.join(dir, 'Inbox.lua'), 'ClaudeWoW_SlotData = nil\n', counts);
  }

  const saved = CLI.legacyStateFor(state, CLI.allClients(cfg), client.key);
  const runtime = SIG.prepareRuntime(addons, { slots: N, actMax: ACT, presence: saved.presence || null, presenceMax: PRESENCE, tocInterface: iface, removeLegacy: true });
  counts.made += runtime.made;
  counts.updated += runtime.updated;

  const perms = G.repair(addons);
  if (perms.fixed) console.log(`${tag}permissions: ${perms.fixed} of ${perms.checked} file(s) and folder(s) under the ClaudeWoW addon folders set to 0777 to match the game install (Battle.net error 2113)`);
  for (const f of perms.failed) console.log(`${tag}permissions: could not chmod ${f}`);
  console.log(`${tag}slots: ${N}  files created: ${counts.made}  updated: ${counts.updated}  already present: ${counts.kept}  signal files armed: ${runtime.armed}  stale signal files removed: ${runtime.cleaned}`);
  console.log(`${tag}runtime: ${SIG.runtimeRoot(addons)}`);
  console.log(`${tag}presence: ring ${runtime.presence.state.ring} at ${runtime.presence.state.at} of ${PRESENCE}, the other ring armed`);
  if (runtime.legacyRemoved) console.log(`${tag}migrate: removed ${runtime.legacyRemoved} old signal folder(s) from ${path.join(addons, P.ADDON)}; ${SIG.RESTART_NOTE}`);
  if (counts.made > 0 || counts.updated > 0 || runtime.armed > 0) {
    const running = CL.clientRunning(client.dir);
    const who = clients.length > 1 ? client.label : 'WoW';
    if (running === true) console.log(`${tag}restart: ${who} is running now. Fully quit and relaunch it so it sees the new files: the game only sees files that existed when it started.`);
    else if (running === false) console.log(`${tag}restart: ${who} is not running; it sees the new files at its next launch.`);
    else console.log(`${tag}Now fully quit and relaunch ${who} so it sees the new files: the game only sees files that existed when it started.`);
  }
}

for (const client of clients) install(client);
if (failed) process.exit(1);
