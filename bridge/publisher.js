'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./protocol');
const CLI = require('./clients');
const SW = require('./slotwindow');
const G = require('./gamefs');
const SIG = require('./signals');
const PUBR = require('./publishretry');

const REPLIES_KEPT = 10;
const REPLY_KEEP_MS = 24 * 60 * 60 * 1000;
const FINAL_STATUSES = new Set(['done', 'error']);
const DEFAULT_PROGRESS_WRITE_MS = 3000;
const INBOX_GLOBAL = 'ClaudeWoW_Inbox';
const SLOT_GLOBAL = 'ClaudeWoW_SlotData';

const systemTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t) };

function addonSessionOfKey(key) {
  return String(key).split(':')[0];
}

function slotInbox(addonDir, slot) {
  return path.join(addonDir, `${P.ADDON}_S${P.pad3(slot)}`, 'Inbox.lua');
}

function createPublisher({
  state,
  live,
  cfg = {},
  log,
  saveState,
  slots,
  clients,
  titleOf = () => null,
  map = null,
  fields = {},
  perClient = {},
  write = G.atomicWrite,
  timers = systemTimers,
  now = Date.now,
}) {
  const runtimes = clients.runtimes;
  const rtOf = key => runtimes.get(key) || null;
  const inLabel = clients.inLabel || (() => '');
  const defaultClient = clients.defaultClient || (() => clients.list[0] || null);
  const clientStateOf = client => CLI.clientState(state, client.key);
  const field = (name, ...args) => (typeof fields[name] === 'function' ? fields[name](...args) : undefined);
  const per = (name, client) => (typeof perClient[name] === 'function' ? perClient[name](client) : undefined);

  let lastPublish = 0;
  let publishTimer = null;
  let pendingRestore = null;
  const mapLuaSizes = new Map();
  const publishRetry = PUBR.createPublishRetry({ write, log, republish: () => publishNow(true, { refresh: true }) });

  function restoreFor(client) {
    return pendingRestore && (!pendingRestore.client || pendingRestore.client === client.key) ? pendingRestore : null;
  }

  function offerRestore(bundle) {
    pendingRestore = bundle;
  }

  function mapLuaSize(layers) {
    const hit = mapLuaSizes.get(layers);
    if (hit && hit.version === layers.version && hit.epoch === layers.epoch) return hit.size;
    const size = P.luaMap(layers).length;
    mapLuaSizes.set(layers, { version: layers.version, epoch: layers.epoch, size });
    return size;
  }

  function slotMap(client, urgent) {
    if (!map) return null;
    const key = clientStateOf(client).char || map.characterKeyOf(CLI.contextText(state, client.key));
    const layers = map.mapFor(key);
    if (!key && !Object.keys(layers.layers).length) return null;
    return map.share.inSlots({ urgent, size: mapLuaSize(layers), progressMax: map.progressMax }) ? layers : null;
  }

  function addonOnDisk(client) {
    const r = rtOf(client.key);
    const toc = path.join(client.addonDir, P.ADDON, P.ADDON + '.toc');
    try {
      const st = fs.statSync(toc);
      const key = `${st.mtimeMs}:${st.size}:${st.ino}`;
      if (r.diskCache.key !== key) r.diskCache = { key, info: P.addonDiskInfo(fs.readFileSync(toc, 'utf8')) };
      return r.diskCache.info;
    } catch {
      return null;
    }
  }

  function sharedSlotFields(urgent) {
    const widgets = field('widgets', urgent);
    const transportNote = field('transportNote');
    const achievementsLua = field('achievementsLua');
    const liveInfo = field('live');
    const goalsLua = field('goalsLua');
    let dmLua = '';
    try {
      dmLua = field('dmLua');
    } catch (e) {
      log(`campaign: slot field dm left out (${e && e.message ? e.message : e})`);
    }
    let gsLua = '';
    try {
      gsLua = field('gsLua');
    } catch (e) {
      log(`telemetry: slot field gs left out (${e && e.message ? e.message : e})`);
    }
    return {
      live: liveInfo,
      sessions: field('sessions'),
      projects: field('projects'),
      mcp: field('mcp'),
      contract: field('contract'),
      home: os.homedir(),
      skills: field('skills'),
      discord: field('discord'),
      mirror: field('mirror'),
      cwd: field('cwd'),
      agent: field('agent'),
      agents: field('agents'),
      efforts: field('efforts'),
      effortLock: field('effortLock'),
      plugin: field('plugin'),
      plugins: field('plugins'),
      widgets,
      transport: field('transport'),
      levels: field('levels'),
      codec: field('codec'),
      transportNote,
      achievementsLua,
      goalsLua,
      dmLua,
      gsLua,
      openUrl: field('openUrl'),
      bridge: field('bridge'),
    };
  }

  function slotFile(globalName, records, shared, client) {
    const r = rtOf(client.key);
    const rows = CLI.slotClients(clients.list, state, client.key, { diskOf: addonOnDisk });
    return P.luaTable(globalName, records, {
      ...shared,
      restore: restoreFor(client),
      chatlog: per('chatlog', client),
      acks: P.recentAcks(r.acks),
      presence: per('presence', client),
      addonDisk: addonOnDisk(client),
      clients: rows,
      runLimit: perClient.runLimit,
      alive: per('alive', client),
    });
  }

  function slotsInstalled(client) {
    return fs.existsSync(slotInbox(client.addonDir, 1));
  }

  function publishClient(r, records, shared) {
    const c = r.client;
    const batch = publishRetry.begin(c.key);
    const inboxError = batch.write(c.inboxFile, slotFile(INBOX_GLOBAL, records, shared, c));
    if (inboxError && !batch.locked()) {
      batch.end();
      if (!r.warnedNoAddon) {
        r.warnedNoAddon = true;
        log(G.publishFailureNote(c.inboxFile, c.label, inboxError));
      }
      return false;
    }
    const installed = slotsInstalled(c);
    if (installed) {
      const body = slotFile(SLOT_GLOBAL, records, shared, c);
      for (let i = 1; i <= slots; i++) batch.write(slotInbox(c.addonDir, i), body);
    }
    batch.end(inLabel(c));
    return installed;
  }

  function publishNow(urgent = true, { refresh = false } = {}) {
    lastPublish = now();
    const all = SW.windowRecords(live, addonSessionOfKey);
    const shared = sharedSlotFields(urgent);
    let restoreSent = false;
    for (const r of runtimes.values()) {
      if (publishClient(r, CLI.recordsFor(all, r.client.key), { ...shared, map: slotMap(r.client, urgent) }) && restoreFor(r.client)) restoreSent = true;
    }
    pendingRestore = SW.restoreAfterPublish(pendingRestore, { refresh, restoreSent });
  }

  function keepReply(key, record) {
    const kept = state.replies && typeof state.replies === 'object' ? state.replies : {};
    const had = Object.prototype.hasOwnProperty.call(kept, key);
    delete kept[key];
    if (FINAL_STATUSES.has(record.status)) kept[key] = { at: now(), record };
    else if (!had) return;
    const keys = Object.keys(kept);
    for (const old of keys.slice(0, Math.max(0, keys.length - REPLIES_KEPT))) delete kept[old];
    if (Object.keys(kept).length) state.replies = kept;
    else delete state.replies;
    try {
      saveState();
    } catch (e) {
      log(`could not save the latest reply to state.json (${e.message})`);
    }
  }

  function restoreReplies() {
    const kept = state.replies && typeof state.replies === 'object' ? state.replies : {};
    const at = now();
    const fresh = {};
    for (const [key, entry] of Object.entries(kept)) {
      const r = entry && entry.record;
      if (!r || typeof r !== 'object' || !FINAL_STATUSES.has(r.status) || !Number.isInteger(r.id) || !(at - entry.at < REPLY_KEEP_MS)) continue;
      if (!rtOf(r.client)) {
        const fallback = defaultClient();
        if (!fallback) continue;
        r.client = fallback.key;
      }
      fresh[key] = entry;
      live.set(key, r);
    }
    const restored = Object.keys(fresh).length;
    if (restored !== Object.keys(kept).length) {
      if (restored) state.replies = fresh;
      else delete state.replies;
      saveState();
    }
    if (restored)
      log(`republishing ${restored} finished repl${restored === 1 ? 'y' : 'ies'} from before the restart, so a reply the game has not read yet is not lost`);
  }

  function publish(key, record, urgent) {
    const named = titleOf(key);
    if (named && !record.title) {
      record.title = named.title;
      record.titleFor = named.id;
    }
    SW.place(live, key, record);
    keepReply(key, record);
    if (urgent) {
      if (publishTimer) {
        timers.clearTimeout(publishTimer);
        publishTimer = null;
      }
      publishNow();
      return;
    }
    const wait = (cfg.progressWriteMs || DEFAULT_PROGRESS_WRITE_MS) - (now() - lastPublish);
    if (wait <= 0) publishNow(false);
    else if (!publishTimer)
      publishTimer = timers.setTimeout(() => {
        publishTimer = null;
        publishNow(false);
      }, wait);
  }

  function setSignalFile(file, on) {
    if (on) SIG.fire(file);
    else SIG.arm(file);
  }

  function signal(client, kind, id, on) {
    if (!client) return;
    setSignalFile(SIG.signalFile(client.addonDir, kind, P.slotNumber(id, slots)), on);
  }

  return {
    publish,
    publishNow,
    keepReply,
    restoreReplies,
    sharedSlotFields,
    slotFile,
    slotMap,
    addonOnDisk,
    slotsInstalled,
    signal,
    setSignalFile,
    restoreFor,
    offerRestore,
    pendingRestore: () => pendingRestore,
    lastPublishAt: () => lastPublish,
  };
}

module.exports = { createPublisher, addonSessionOfKey, REPLIES_KEPT, REPLY_KEEP_MS, FINAL_STATUSES, INBOX_GLOBAL, SLOT_GLOBAL };
