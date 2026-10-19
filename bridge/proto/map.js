'use strict';

const fs = require('fs');
const { luaStr, cleanText } = require('./util');

const MAP_KINDS = new Set(['ore', 'herb', 'quest', 'turnin', 'kill', 'loot', 'object', 'explore', 'npc', 'trainer', 'vendor', 'dungeon', 'flight', 'poi']);
const MAP_LIMITS = { layers: 12, pointsPerLayer: 400, totalPoints: 1500, label: 80, title: 80 };

function validateMapCommand(c, why = []) {
  if (!c || typeof c !== 'object') {
    why.push('not an object');
    return null;
  }
  if (c.op === 'clearall') return { op: 'clearall' };
  const layer = String(c.layer ?? '');
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(layer)) {
    why.push(`bad layer name "${layer.slice(0, 40)}"`);
    return null;
  }
  if (c.op === 'clear') return { op: 'clear', layer };
  if (c.op !== 'set') {
    why.push(`unknown op "${String(c.op).slice(0, 20)}"`);
    return null;
  }
  if (!Array.isArray(c.points)) {
    why.push(`layer ${layer}: points must be an array`);
    return null;
  }
  const points = [];
  for (const p of c.points.slice(0, MAP_LIMITS.pointsPerLayer)) {
    const m = Number(p && p.m),
      x = Number(p && p.x),
      y = Number(p && p.y);
    if (!Number.isInteger(m) || m <= 0 || m > 99999 || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    points.push({
      m,
      x: Math.round(Math.min(100, Math.max(0, x)) * 100) / 100,
      y: Math.round(Math.min(100, Math.max(0, y)) * 100) / 100,
      label: cleanText(p.label, MAP_LIMITS.label),
      kind: MAP_KINDS.has(p.kind) ? p.kind : 'poi',
    });
  }
  if (c.points.length > MAP_LIMITS.pointsPerLayer) why.push(`layer ${layer}: kept the first ${MAP_LIMITS.pointsPerLayer} points`);
  if (points.length < c.points.slice(0, MAP_LIMITS.pointsPerLayer).length) why.push(`layer ${layer}: dropped invalid points`);
  if (!points.length) {
    why.push(`layer ${layer}: no valid points`);
    return null;
  }
  return { op: 'set', layer, title: cleanText(c.title || layer, MAP_LIMITS.title), ordered: !!c.ordered, loop: !!c.loop, points };
}

function newMap(epoch) {
  return { epoch: epoch || Math.random().toString(36).slice(2, 10), version: 0, layers: {} };
}

function applyMapCommands(map, cmds, now = Date.now()) {
  const notes = [];
  let changed = false;
  for (const raw of cmds || []) {
    const why = [];
    const c = validateMapCommand(raw, why);
    notes.push(...why);
    if (!c) continue;
    if (c.op === 'clearall') {
      if (Object.keys(map.layers).length) {
        map.layers = {};
        changed = true;
      }
      notes.push('cleared all layers');
    } else if (c.op === 'clear') {
      if (map.layers[c.layer]) {
        delete map.layers[c.layer];
        changed = true;
        notes.push(`cleared layer ${c.layer}`);
      }
    } else {
      map.layers[c.layer] = { title: c.title, ordered: c.ordered, loop: c.loop, points: c.points, t: now };
      changed = true;
      notes.push(`layer ${c.layer}: ${c.points.length} point(s)`);
    }
  }
  const total = () => Object.values(map.layers).reduce((s, l) => s + l.points.length, 0);
  const names = () => Object.keys(map.layers).sort((a, b) => map.layers[a].t - map.layers[b].t);
  while (Object.keys(map.layers).length > MAP_LIMITS.layers || total() > MAP_LIMITS.totalPoints) {
    const old = names()[0];
    delete map.layers[old];
    notes.push(`dropped old layer ${old} (map full)`);
    changed = true;
  }
  if (changed) map.version = (map.version || 0) + 1;
  return { changed, notes };
}

function extractMapBlocks(text) {
  const cmds = [],
    errors = [];
  const stripped = String(text ?? '')
    .replace(/```wowmap[^\n]*\n([\s\S]*?)```/g, (_, body) => {
      const src = body.trim();
      try {
        const v = JSON.parse(src);
        cmds.push(...(Array.isArray(v) ? v : [v]));
      } catch {
        for (const line of src.split('\n')) {
          if (!line.trim()) continue;
          try {
            cmds.push(JSON.parse(line));
          } catch {
            errors.push('unreadable wowmap line: ' + line.trim().slice(0, 60));
          }
        }
      }
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: stripped, cmds, errors };
}

function parseSideFile(kind, src) {
  const cmds = [],
    errors = [];
  for (const line of String(src || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      cmds.push(JSON.parse(line));
    } catch {
      errors.push(`unreadable ${kind} file line`);
    }
  }
  return { cmds, errors };
}

function readSideFile(kind, file, { read = f => fs.readFileSync(f, 'utf8'), remove = f => fs.unlinkSync(f) } = {}) {
  let src = '';
  let unreadable = '';
  try {
    src = read(file);
  } catch (e) {
    if (e.code !== 'ENOENT') unreadable = e.code || e.message;
  }
  try {
    remove(file);
  } catch {}
  return { ...parseSideFile(kind, src), unreadable };
}

function parseMapFile(src) {
  return parseSideFile('map', src);
}

function luaMap(map) {
  const lines = ['\tmap = {', `\t\tepoch = ${luaStr(map.epoch)},`, `\t\tversion = ${Number(map.version) || 0},`];
  if (map.char) lines.push(`\t\tchar = ${luaStr(map.char)},`);
  lines.push('\t\tlayers = {');
  for (const [name, l] of Object.entries(map.layers || {})) {
    lines.push(
      `\t\t\t{ name = ${luaStr(name)}, title = ${luaStr(l.title)}, ordered = ${l.ordered ? 'true' : 'false'}, loop = ${l.loop ? 'true' : 'false'}, points = {`,
    );
    for (const p of l.points) lines.push(`\t\t\t\t{ ${p.m}, ${p.x}, ${p.y}, ${luaStr(p.label)}, ${luaStr(p.kind)} },`);
    lines.push('\t\t\t} },');
  }
  lines.push('\t\t},', '\t},');
  return lines.join('\n');
}

module.exports = {
  MAP_LIMITS,
  validateMapCommand,
  newMap,
  applyMapCommands,
  extractMapBlocks,
  parseSideFile,
  readSideFile,
  parseMapFile,
  luaMap,
};
