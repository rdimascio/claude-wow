'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROTO = 1;
const PROTO_MIN = PROTO;
const PROTO_MAX = PROTO;
const LEGACY_PROTO = 1;
const SEMVER_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.+-]{1,24})?$/;
const ADDON_VERSIONS_MAX = 8;
const MAX_DATE_MS = 8.64e15;

function bridgeVersion() {
  try {
    return require('../../package.json').version;
  } catch {
    return '0.0.0';
  }
}

function bridgeInfo(version = bridgeVersion()) {
  return { version: SEMVER_RE.test(String(version)) ? String(version) : '0.0.0', protoMin: PROTO_MIN, protoMax: PROTO_MAX };
}

function semverTriple(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a, b) {
  const x = semverTriple(a),
    y = semverTriple(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function protoRange(bridge) {
  return bridge.protoMin === bridge.protoMax ? String(bridge.protoMin) : `${bridge.protoMin} to ${bridge.protoMax}`;
}

const ADDON_UPDATE_HOW = 'update the addon in the CurseForge app or run claude-wow setup, then type /reload.';
const BRIDGE_UPDATE_HOW = 'run brew upgrade claude-wow or the installer again, then claude-wow service restart.';

function versionVerdict(addon, bridge = bridgeInfo()) {
  const proto = Number.isInteger(addon && addon.proto) ? addon.proto : LEGACY_PROTO;
  const version = addon && SEMVER_RE.test(String(addon.version || '')) ? String(addon.version) : '';
  const mine = `${version || 'version unknown'}, protocol ${proto}`;
  const theirs = `${bridge.version}, protocol ${protoRange(bridge)}`;
  if (proto < bridge.protoMin) {
    return {
      verdict: 'update-addon',
      refuse: true,
      text: `This addon (${mine}) is too old for the companion app (${theirs}). The companion app refuses messages until you update the addon: ${ADDON_UPDATE_HOW}`,
    };
  }
  if (proto > bridge.protoMax) {
    return {
      verdict: 'update-bridge',
      refuse: true,
      text: `The companion app (${theirs}) is too old for this addon (${mine}). It refuses messages until you update it: ${BRIDGE_UPDATE_HOW}`,
    };
  }
  if (!version) return { verdict: 'unknown', refuse: false, text: '' };
  if (version === bridge.version) return { verdict: 'equal', refuse: false, text: '' };
  const order = compareSemver(version, bridge.version);
  if (order === -1)
    return {
      verdict: 'addon-older',
      refuse: false,
      text: `This addon (${version}) is older than the companion app (${bridge.version}). They still work together; update the addon when you can.`,
    };
  if (order === 1)
    return {
      verdict: 'bridge-older',
      refuse: false,
      text: `The companion app (${bridge.version}) is older than this addon (${version}). They still work together; update the companion app when you can.`,
    };
  return {
    verdict: 'differs',
    refuse: false,
    text: `This addon (${version}) and the companion app (${bridge.version}) are different builds. They still work together.`,
  };
}

function noteAddonVersion(state, job, bridge = bridgeInfo(), now = Date.now()) {
  const all = (state.addons = state.addons && typeof state.addons === 'object' ? state.addons : {});
  const addon = { version: job.addonVersion || '', proto: Number.isInteger(job.addonProto) ? job.addonProto : null };
  const v = versionVerdict(addon, bridge);
  const key = String(job.session || '');
  const prev = all[key];
  all[key] = { ...addon, bridge: bridge.version, protoMin: bridge.protoMin, protoMax: bridge.protoMax, verdict: v.verdict, at: now };
  const keep = Object.entries(all)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, ADDON_VERSIONS_MAX)
    .map(([k]) => k);
  for (const k of Object.keys(all)) if (!keep.includes(k)) delete all[k];
  return { ...v, changed: !prev || prev.verdict !== v.verdict || prev.version !== addon.version || prev.bridge !== bridge.version };
}

function addonRefusal(state, job, bridge = bridgeInfo()) {
  const rec = state.addons && state.addons[String(job.session || '')];
  if (!rec) return '';
  const v = versionVerdict(rec, bridge);
  return v.refuse ? v.text : '';
}

function latestAddonVersion(state) {
  const recs = Object.values((state && state.addons) || {}).filter(r => r && typeof r === 'object');
  return recs.sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
}

function versionsSummary(state) {
  const r = latestAddonVersion(state);
  if (!r) return 'no hello with versions yet';
  const proto = Number.isInteger(r.proto) ? r.proto : `${LEGACY_PROTO} assumed`;
  const range = Number.isInteger(r.protoMin) && Number.isInteger(r.protoMax) ? protoRange(r) : '?';
  return `addon ${r.version || 'unknown'} (protocol ${proto}), bridge ${r.bridge || 'unknown'} (protocol ${range}): ${r.verdict || 'unknown'}${Number.isFinite(r.at) && Math.abs(r.at) <= MAX_DATE_MS ? ', at the last hello ' + new Date(r.at).toISOString() : ''}`;
}

function installedSummary(bridge = bridgeInfo()) {
  return `this install is bridge ${bridge.version} (protocol ${protoRange(bridge)})`;
}

const BUILD_RE = /^[0-9a-f]{12}$/;

function addonBuild(files) {
  const h = crypto.createHash('sha256');
  const sorted = files.filter(f => !/\.toc$/i.test(f.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const f of sorted) h.update(f.name).update('\0').update(f.data).update('\0');
  return h.digest('hex').slice(0, 12);
}

function tocField(text, key) {
  const m = new RegExp(`^##\\s*${key}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'm').exec(String(text || ''));
  return m ? m[1] : '';
}

function tocWithBuild(text, build) {
  const body = String(text || '').replace(/^##\s*X-Build:.*\r?\n?/m, '');
  const line = `## X-Build: ${build}`;
  return /^##\s*Version:.*$/m.test(body) ? body.replace(/^(##\s*Version:.*?)(\r?)$/m, `$1$2\n${line}$2`) : `${line}\n${body}`;
}

function tocLuaFiles(tocText) {
  return String(tocText || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.endsWith('.lua') && !l.startsWith('#'));
}

function addonFiles(dir, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    const sub = rel ? `${rel}/${name}` : name;
    if (fs.statSync(path.join(dir, sub)).isDirectory()) out.push(...addonFiles(dir, sub));
    else out.push(sub);
  }
  return out;
}

module.exports = {
  PROTO,
  PROTO_MIN,
  PROTO_MAX,
  LEGACY_PROTO,
  SEMVER_RE,
  ADDON_VERSIONS_MAX,
  MAX_DATE_MS,
  bridgeVersion,
  bridgeInfo,
  compareSemver,
  versionVerdict,
  noteAddonVersion,
  addonRefusal,
  latestAddonVersion,
  versionsSummary,
  installedSummary,
  BUILD_RE,
  addonBuild,
  tocField,
  tocWithBuild,
  tocLuaFiles,
  addonFiles,
};
