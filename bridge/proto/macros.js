'use strict';

const { luaStr } = require('./util');

const MACRO_LIMITS = { name: 16, body: 255, perReply: 6 };
const MACRO_RE = /```wowmacro([^\n]*)\n([\s\S]*?)```/g;
const RISKY_MACRO_RE = /^\s*\/(run|script|click|console|dump)\b/im;

const firstChars = (s, max) => Array.from(s).slice(0, max).join('');

function parseMacroHeader(rest) {
  let name = String(rest || '');
  let icon = null,
    scope = 'account';
  name = name.replace(/\bicon\s*=\s*("?)([^\s"]+)\1/i, (_, q, v) => {
    icon = v;
    return ' ';
  });
  name = name.replace(/\bscope\s*=\s*("?)(\w+)\1/i, (_, q, v) => {
    scope = /^char/i.test(v) ? 'character' : 'account';
    return ' ';
  });
  name = name.replace(/\bname\s*=\s*"([^"]*)"/i, (_, v) => ` ${v} `);
  return { name, icon, scope };
}

function extractMacros(text) {
  const macros = [],
    notes = [];
  const out = String(text ?? '').replace(MACRO_RE, (_, header, rawBody) => {
    const h = parseMacroHeader(header);
    const name = firstChars(
      h.name
        .replace(/["|\x00-\x1f\x7f]/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
      MACRO_LIMITS.name,
    );
    const body = String(rawBody)
      .replace(/\r/g, '')
      .split('\n')
      .map(l => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/^\n+|\n+$/g, '');
    const readable = `Macro "${name || '?'}":\n${body}`;
    const bytes = Buffer.byteLength(body, 'utf8');
    if (!name) {
      notes.push('a macro without a name was not offered as a button');
      return readable;
    }
    if (!body) {
      notes.push(`macro "${name}" is empty`);
      return readable;
    }
    if (bytes > MACRO_LIMITS.body) {
      notes.push(`macro "${name}" is ${bytes} bytes, over the game's ${MACRO_LIMITS.body}; not offered as a button`);
      return readable;
    }
    if (macros.length >= MACRO_LIMITS.perReply) {
      notes.push(`only the first ${MACRO_LIMITS.perReply} macros get a button`);
      return readable;
    }
    let icon = null;
    if (h.icon && /^\d{1,9}$/.test(h.icon)) icon = Number(h.icon);
    else if (h.icon && /^[A-Za-z0-9_]{1,64}$/.test(h.icon)) icon = h.icon;
    macros.push({ name, body, icon, char: h.scope === 'character', risky: RISKY_MACRO_RE.test(body) });
    return readable;
  });
  return { text: out, macros, notes: [...new Set(notes)] };
}

function stripMacroBlocks(text) {
  return String(text ?? '')
    .replace(MACRO_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function luaMacros(macros) {
  return `\t\t\tmacros = { ${macros.map(m => `{ name = ${luaStr(m.name)}, body = ${luaStr(m.body)}, icon = ${m.icon == null ? 'nil' : typeof m.icon === 'number' ? m.icon : luaStr(m.icon)}, char = ${m.char ? 'true' : 'false'}, risky = ${m.risky ? 'true' : 'false'} }`).join(', ')} },`;
}

module.exports = {
  MACRO_LIMITS,
  extractMacros,
  stripMacroBlocks,
  luaMacros,
};
