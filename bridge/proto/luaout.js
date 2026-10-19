'use strict';

const MC = require('../mcpconfig');
const { pad3, luaStr, LATE_IN_MAX, OPEN_RESULTS } = require('./util');
const { SEMVER_RE, BUILD_RE, tocField, tocLuaFiles } = require('./versions');
const { DEFAULT_TRANSPORT, transportName, screenshotLevels, stripCodec } = require('./transport');
const { luaMacros } = require('./macros');
const { luaMap } = require('./map');
const { luaWidgets } = require('./widgets');

function slotNumber(id, slots) {
  return ((id - 1) % slots) + 1;
}

const SIGNAL_CLEAR_AHEAD = 50;
function slotsToClearAhead(id, slots, keepIds = [], ahead = SIGNAL_CLEAR_AHEAD) {
  const reach = Math.min(ahead, Math.floor(slots / 2));
  const keep = new Set(keepIds.filter(Number.isFinite).map(k => slotNumber(k, slots)));
  keep.add(slotNumber(id, slots));
  const out = [];
  for (let j = 1; j <= reach; j++) {
    const s = slotNumber(id + j, slots);
    if (!keep.has(s)) out.push(s);
  }
  return out;
}

const MCP_HEALTH = ['connected', 'failed', 'needs-auth', 'pending', 'unknown'];

const FILE_HASH_RE = /^[0-9a-f]{8}$/;

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(text), 'utf8')) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

function addonDiskInfo(tocText) {
  const version = tocField(tocText, 'Version');
  const build = tocField(tocText, 'X-Build');
  const files = tocLuaFiles(tocText);
  return { version: SEMVER_RE.test(version) ? version : '', build: BUILD_RE.test(build) ? build : '', files: files.length, fileHash: fnv1a(files.join('\n')) };
}

function luaSession(s) {
  const f = [
    `id = ${luaStr(s.id || '')}`,
    `name = ${luaStr(s.name || '')}`,
    `cwd = ${luaStr(s.cwd || '')}`,
    `agent = ${luaStr(s.agent || '')}`,
    `at = ${Math.max(0, Math.floor(Number(s.at) || 0))}`,
  ];
  if (s.plugin) f.push(`plugin = ${luaStr(s.plugin)}`);
  if (s.chat) f.push(`chat = ${luaStr(s.chat)}`);
  if (s.live) f.push('live = true');
  if (s.running) f.push('running = true');
  if (s.title) f.push(`title = ${luaStr(s.title)}`);
  if (s.branch) f.push(`branch = ${luaStr(s.branch)}`);
  if (s.restart) f.push(`restart = ${luaStr(s.restart)}`);
  if (s.handoff) f.push('handoff = true');
  if (s.recap) f.push(`recap = ${luaStr(s.recap)}`);
  return `\t\t{ ${f.join(', ')} },`;
}

const ALIVE_MAX = 30;

const EFFORT_KEY_RE = /^[a-z0-9_-]{1,32}$/;
const EFFORT_VALUE_RE = /^[a-z]{0,16}$/;

function luaEffortRow(row) {
  if (!row || typeof row !== 'object') return null;
  const cells = Object.entries(row)
    .filter(([k, v]) => EFFORT_KEY_RE.test(k) && typeof v === 'string' && EFFORT_VALUE_RE.test(v))
    .map(([k, v]) => `[${luaStr(k)}] = ${luaStr(v)}`);
  return `{ ${cells.join(', ')} }`;
}

function luaEfforts(efforts, lock) {
  const out = [];
  if (efforts && typeof efforts === 'object') {
    const rows = Object.entries(efforts)
      .filter(([k]) => EFFORT_KEY_RE.test(k))
      .map(([k, row]) => [k, luaEffortRow(row)])
      .filter(([, row]) => row)
      .map(([k, row]) => `[${luaStr(k)}] = ${row}`);
    out.push(`\tefforts = { ${rows.join(', ')} },`);
  }
  const lockRow = luaEffortRow(lock);
  if (lockRow) out.push(`\teffortLock = ${lockRow},`);
  return out;
}

function luaTable(globalName, records, opts = {}) {
  const now = opts.now || Date.now();
  const agents = Array.isArray(opts.agents) ? opts.agents : [];
  const plugins = Array.isArray(opts.plugins) ? opts.plugins : [];
  const transport = transportName(opts.transport) || DEFAULT_TRANSPORT;
  const lines = [
    '-- Written by the claude-wow bridge (bridge/bridge.js). Do not edit by hand.',
    `${globalName} = {`,
    `\tts = ${luaStr(new Date(now).toISOString())},`,
    `\tnow = ${Math.floor(now / 1000)},`,
    `\tcwd = ${luaStr(opts.cwd || '')},`,
    `\tagent = ${luaStr(opts.agent || '')},`,
    `\tagents = { ${agents.map(luaStr).join(', ')} },`,
    `\tplugin = ${luaStr(opts.plugin || '')},`,
    `\tplugins = { ${plugins.map(luaStr).join(', ')} },`,
    `\ttransport = ${luaStr(transport)},`,
    '\tcancel = true,',
    '\treplies = {',
  ];
  if (opts.openUrl === true) lines.splice(lines.length - 1, 0, '\topenUrl = true,');
  if (transport === 'screenshot') {
    const lv = screenshotLevels(opts.levels);
    lines.splice(lines.length - 1, 0, `\tstrip = { on = ${lv.on}, off = ${lv.off}, codec = ${stripCodec(opts.codec)} },`);
    const cl = opts.chatlog;
    if (cl && cl.enabled === true && Number.isInteger(cl.line) && Number.isInteger(cl.filler) && /^[0-9a-f]{32}$/.test(String(cl.key || ''))) {
      lines.splice(lines.length - 1, 0, `\tchatlog = { line = ${cl.line}, filler = ${cl.filler}, key = "${cl.key}"${cl.show ? ', show = true' : ''} },`);
    }
  }
  if (opts.transportNote) lines.splice(lines.length - 1, 0, `\ttransportNote = ${luaStr(opts.transportNote)},`);
  const efforts = luaEfforts(opts.efforts, opts.effortLock);
  if (efforts.length) lines.splice(lines.length - 1, 0, ...efforts);
  if (opts.bridge && typeof opts.bridge === 'object') {
    const b = opts.bridge;
    lines.splice(
      lines.length - 1,
      0,
      `\tbridge = { version = ${luaStr(b.version)}, protoMin = ${Math.floor(Number(b.protoMin)) || 0}, protoMax = ${Math.floor(Number(b.protoMax)) || 0} },`,
    );
  }
  if (opts.addonDisk && typeof opts.addonDisk === 'object' && opts.addonDisk.version) {
    const d = opts.addonDisk;
    const files = FILE_HASH_RE.test(d.fileHash || '') ? `, files = ${Math.floor(Number(d.files)) || 0}, fileHash = ${luaStr(d.fileHash)}` : '';
    lines.splice(lines.length - 1, 0, `\taddonDisk = { version = ${luaStr(d.version)}, build = ${luaStr(d.build || '')}${files} },`);
  }
  if (Array.isArray(opts.clients)) {
    const rows = opts.clients
      .filter(c => c && typeof c === 'object')
      .map(c => {
        const f = [
          `name = ${luaStr(c.name || '')}`,
          `version = ${luaStr(c.version || '')}`,
          `build = ${luaStr(BUILD_RE.test(String(c.build || '')) ? c.build : '')}`,
          `heard = ${Math.max(0, Math.floor(Number(c.heard) || 0))}`,
        ];
        if (c.here) f.push('here = true');
        if (c.last) f.push('last = true');
        return `{ ${f.join(', ')} }`;
      });
    lines.splice(lines.length - 1, 0, `\tclients = { ${rows.join(', ')} },`);
  }
  if (opts.live && typeof opts.live === 'object') {
    const sessions = Array.isArray(opts.live.sessions) ? opts.live.sessions : [];
    lines.splice(lines.length - 1, 0, `\tlive = { sessions = { ${sessions.map(luaStr).join(', ')} }, start = ${luaStr(opts.live.start || '')} },`);
  }
  if (Array.isArray(opts.sessions)) {
    lines.splice(lines.length - 1, 0, '\tsessions = {', ...opts.sessions.map(luaSession), '\t},');
  }
  if (Array.isArray(opts.projects)) {
    const rows = opts.projects.filter(p => p && p.path).map(p => `{ path = ${luaStr(p.path)}, label = ${luaStr(p.label || '')} }`);
    lines.splice(lines.length - 1, 0, `\tprojects = { ${rows.join(', ')} },`);
  }
  if (Array.isArray(opts.mcp)) {
    const label = v =>
      String(v || '')
        .replace(/[\x00-\x1f|]/g, '')
        .slice(0, 64);
    const rows = opts.mcp
      .filter(e => e && /^[A-Za-z0-9_-]{1,64}$/.test(String(e.id || '')) && MC.SOURCES.includes(e.src))
      .map(
        e =>
          `{ id = ${luaStr(e.id)}, label = ${luaStr(label(e.label) || e.id)}, src = ${luaStr(e.src)}, on = ${e.on ? 'true' : 'false'}, health = ${luaStr(MCP_HEALTH.includes(e.health) ? e.health : 'unknown')} }`,
      );
    lines.splice(lines.length - 1, 0, `\tmcp = { ${rows.join(', ')} },`);
  }
  if (opts.contract && typeof opts.contract === 'object') {
    const rows = Object.entries(opts.contract)
      .filter(([id, c]) => /^[a-z]{1,16}$/.test(id) && c && typeof c === 'object')
      .map(([id, c]) => {
        const sources = (Array.isArray(c.sources) ? c.sources : []).filter(src => MC.SOURCES.includes(src)).map(luaStr);
        return `${id} = { version = ${luaStr(String(c.version || '').slice(0, 40))}, checked = ${c.checked ? 'true' : 'false'}, off = ${c.off === false ? 'false' : 'true'}, reason = ${luaStr(String(c.reason || '').slice(0, 400))}, sources = { ${sources.join(', ')} } }`;
      });
    lines.splice(lines.length - 1, 0, `\tcontract = { ${rows.join(', ')} },`);
  }
  if (opts.home) lines.splice(lines.length - 1, 0, `\thome = ${luaStr(opts.home)},`);
  if (Array.isArray(opts.skills) && opts.skills.length) {
    lines.splice(lines.length - 1, 0, `\tskills = { ${opts.skills.map(luaStr).join(', ')} },`);
  }
  if (opts.discord === true) lines.splice(lines.length - 1, 0, '\tdiscord = true,');
  if (Array.isArray(opts.mirror) && opts.mirror.length) {
    const rows = opts.mirror
      .filter(m => m && m.chat && Number.isInteger(m.seq))
      .map(
        m =>
          `\t\t{ chat = ${luaStr(m.chat)}, seq = ${m.seq}, role = ${luaStr(m.role)}, text = ${luaStr(m.text)}, agent = ${luaStr(m.agent || '')}, denied = { ${(m.denied || []).map(luaStr).join(', ')} }${m.room === true ? `, room = true, title = ${luaStr(m.title || '')}, from = ${luaStr(m.from || '')}` : ''} },`,
      );
    lines.splice(lines.length - 1, 0, '\tmirror = {', ...rows, '\t},');
  }
  if (Array.isArray(opts.acks)) {
    const acks = opts.acks.filter(a => a && Number.isInteger(a.id) && a.id > 0);
    const ackLua = a => {
      const f = [`session = ${luaStr(a.session || '')}`, `id = ${a.id}`];
      if (OPEN_RESULTS.includes(a.open)) f.push(`open = ${luaStr(a.open)}`);
      if (a.open === 'refused' && a.why) f.push(`why = ${luaStr(String(a.why).slice(0, 80))}`);
      return `{ ${f.join(', ')} }`;
    };
    lines.splice(lines.length - 1, 0, `\tacks = { ${acks.map(ackLua).join(', ')} },`);
  }
  if (Number.isInteger(opts.runLimit) && opts.runLimit > 0) lines.splice(lines.length - 1, 0, `\trunLimit = ${opts.runLimit},`);
  if (Array.isArray(opts.alive)) {
    const alive = opts.alive.filter(a => a && Number.isInteger(a.id) && a.id > 0).slice(0, ALIVE_MAX);
    lines.splice(
      lines.length - 1,
      0,
      `\talive = { ${alive.map(a => `{ session = ${luaStr(a.session || '')}, id = ${a.id}, since = ${Math.max(0, Math.floor(Number(a.since) || 0))} }`).join(', ')} },`,
    );
  }
  if (opts.presence && typeof opts.presence === 'object') {
    const pr = opts.presence;
    lines.splice(
      lines.length - 1,
      0,
      `\tsignals = ${luaStr(pr.scheme || 'armed')},`,
      `\tpresence = { ring = ${luaStr(pr.ring || '')}, at = ${Math.max(0, Math.floor(Number(pr.at) || 0))}, n = ${Math.max(0, Math.floor(Number(pr.n) || 0))}, probe = ${luaStr(pr.probe || '')} },`,
    );
  }
  for (const r of records) {
    lines.push('\t\t{');
    lines.push(`\t\t\tchat = ${luaStr(r.chat || '')},`);
    lines.push(`\t\t\tid = ${Number(r.id) || 0},`);
    lines.push(`\t\t\tstatus = ${luaStr(r.status)},`);
    lines.push(`\t\t\ttext = ${luaStr(r.text)},`);
    lines.push(`\t\t\tcwd = ${luaStr(r.cwd || '')},`);
    lines.push(`\t\t\tsession = ${luaStr(r.session || '')},`);
    lines.push(`\t\t\tagent = ${luaStr(r.agent || '')},`);
    if (typeof r.token === 'string' && r.token) lines.push(`\t\t\ttoken = ${luaStr(r.token)},`);
    if (r.plugin) lines.push(`\t\t\tplugin = ${luaStr(r.plugin)},`);
    if (r.summary) lines.push(`\t\t\tsummary = ${luaStr(r.summary)},`);
    if (r.title) lines.push(`\t\t\ttitle = ${luaStr(r.title)},`);
    if (r.title && Number(r.titleFor) > 0) lines.push(`\t\t\ttitleFor = ${Math.floor(Number(r.titleFor))},`);
    if (r.status === 'working' && Number.isInteger(r.steps) && r.steps > 0) lines.push(`\t\t\tsteps = ${r.steps},`);
    if (r.late) lines.push('\t\t\tlate = true,');
    if (r.late && Number.isSafeInteger(r.lateSeq) && r.lateSeq > 0) lines.push(`\t\t\tlateSeq = ${r.lateSeq},`);
    if (r.lateOk) lines.push('\t\t\tlateOk = true,');
    if (r.lateOk && Number.isInteger(r.lateIn) && r.lateIn > 0 && r.lateIn <= LATE_IN_MAX) lines.push(`\t\t\tlateIn = ${r.lateIn},`);
    if (Number(r.ctx) > 0) lines.push(`\t\t\tctx = ${Math.round(Number(r.ctx))},`);
    if (Number(r.turns) > 0) lines.push(`\t\t\tturns = ${Math.round(Number(r.turns))},`);
    if (Number(r.window) > 0) lines.push(`\t\t\twindow = ${Math.round(Number(r.window))},`);
    if (Number(r.since) > 0) lines.push(`\t\t\tsince = ${Math.floor(Number(r.since))},`);
    if (Number.isFinite(Number(r.cost)) && r.cost !== undefined && r.cost !== null && r.cost !== '') lines.push(`\t\t\tcost = ${Number(r.cost)},`);
    if (Array.isArray(r.denied) && r.denied.length) {
      lines.push(`\t\t\tdenied = { ${r.denied.map(luaStr).join(', ')} },`);
    }
    if (Array.isArray(r.macros) && r.macros.length) lines.push(luaMacros(r.macros));
    lines.push('\t\t},');
  }
  lines.push('\t},');
  if (opts.map) lines.push(luaMap(opts.map));
  if (opts.achievementsLua) lines.push(opts.achievementsLua);
  if (opts.goalsLua) lines.push(opts.goalsLua);
  if (opts.dmLua) lines.push(opts.dmLua);
  if (opts.gsLua) lines.push(opts.gsLua);
  if (opts.widgets) lines.push(luaWidgets(opts.widgets));
  const restore = opts.restore;
  if (restore) {
    lines.push('\trestore = {', `\t\ttoken = ${luaStr(restore.token)},`);
    if (restore.char) lines.push(`\t\tchar = ${luaStr(restore.char)},`);
    lines.push('\t\tchats = {');
    for (const c of restore.chats) {
      lines.push(
        '\t\t\t{',
        `\t\t\t\tid = ${luaStr(c.id)},`,
        `\t\t\t\tname = ${luaStr(c.name)},`,
        `\t\t\t\tcwd = ${luaStr(c.cwd)},`,
        `\t\t\t\tplugin = ${luaStr(c.plugin || '')},`,
      );
      if (Number(c.ctx) > 0) lines.push(`\t\t\t\tctx = ${Math.round(Number(c.ctx))},`);
      if (Number(c.turns) > 0) lines.push(`\t\t\t\tturns = ${Math.round(Number(c.turns))},`);
      if (Number(c.since) > 0) lines.push(`\t\t\t\tsince = ${Math.floor(Number(c.since))},`);
      if (Number.isFinite(Number(c.cost)) && c.cost !== undefined && c.cost !== null && c.cost !== '') lines.push(`\t\t\t\tcost = ${Number(c.cost)},`);
      lines.push('\t\t\t\tmessages = {');
      for (const m of c.messages) {
        lines.push(
          `\t\t\t\t\t{ role = ${luaStr(m.role)}, id = ${Number(m.id) || 0}, t = ${Number(m.t) || 0}, agent = ${luaStr(m.agent || '')}, text = ${luaStr(m.text)} },`,
        );
      }
      lines.push('\t\t\t\t},', '\t\t\t},');
    }
    lines.push('\t\t},', '\t},');
  }
  lines.push('}', '');
  return lines.join('\n');
}

const SILENT_WAV = (() => {
  const rate = 8000,
    samples = 80;
  const b = Buffer.alloc(44 + samples);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples, 40);
  b.fill(128, 44);
  return b;
})();

module.exports = {
  pad3,
  luaStr,
  slotNumber,
  SIGNAL_CLEAR_AHEAD,
  slotsToClearAhead,
  FILE_HASH_RE,
  fnv1a,
  addonDiskInfo,
  luaSession,
  luaTable,
  SILENT_WAV,
};
