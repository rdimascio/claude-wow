'use strict';

class DumpError extends Error {}

const ESCAPES = Object.freeze({ '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a', "'": "'", '"': '"', '\\': '\\' });
const NUMBER = /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i;
const IDENT = /^[a-z_][a-z0-9_]*$/i;

function tableColumns(text, table) {
  if (!IDENT.test(table)) throw new DumpError(`bad table name ${JSON.stringify(table)}`);
  const head = `CREATE TABLE \`${table}\` (`;
  const at = text.indexOf(head);
  if (at < 0) return null;
  const end = text.indexOf('\n)', at);
  if (end < 0) throw new DumpError(`${table}: CREATE TABLE has no end`);
  const columns = [];
  for (const line of text.slice(at + head.length, end).split('\n')) {
    const m = /^\s*`([^`]+)`\s/.exec(line);
    if (m) columns.push(m[1]);
  }
  return columns;
}

function scalar(raw, table) {
  if (raw === 'NULL') return null;
  if (!NUMBER.test(raw)) throw new DumpError(`${table}: unexpected value ${JSON.stringify(raw.slice(0, 40))}`);
  return Number(raw);
}

function* tuples(text, from, table) {
  let i = from;
  for (;;) {
    while (text[i] === ',' || text[i] === ' ') i++;
    if (text[i] === ';') return;
    if (text[i] !== '(') throw new DumpError(`${table}: expected a row at offset ${i}`);
    i++;
    const row = [];
    for (;;) {
      if (text[i] === "'") {
        let s = '';
        i++;
        for (;;) {
          const c = text[i];
          if (c === undefined) throw new DumpError(`${table}: unterminated string`);
          if (c === '\\') { s += ESCAPES[text[i + 1]] ?? text[i + 1]; i += 2; continue; }
          if (c === "'") {
            if (text[i + 1] === "'") { s += "'"; i += 2; continue; }
            i++;
            break;
          }
          s += c;
          i++;
        }
        row.push(s);
      } else {
        let j = i;
        while (text[j] !== ',' && text[j] !== ')' && j < text.length) j++;
        row.push(scalar(text.slice(i, j), table));
        i = j;
      }
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ')') { i++; break; }
      throw new DumpError(`${table}: malformed row at offset ${i}`);
    }
    yield row;
  }
}

function* rows(text, table, wanted) {
  const columns = tableColumns(text, table);
  if (!columns) throw new DumpError(`table ${table} is missing from the dump`);
  const index = wanted.map(c => {
    const k = columns.indexOf(c);
    if (k < 0) throw new DumpError(`${table}: column ${c} is missing; the dump layout changed`);
    return k;
  });
  if (text.includes(`INSERT INTO \`${table}\` (`)) throw new DumpError(`${table}: an INSERT names its columns, which this reader does not read`);
  const head = `INSERT INTO \`${table}\` VALUES `;
  let at = text.indexOf(head);
  while (at >= 0) {
    for (const row of tuples(text, at + head.length, table)) {
      if (row.length !== columns.length) throw new DumpError(`${table}: a row has ${row.length} values for ${columns.length} columns`);
      yield Object.fromEntries(wanted.map((c, k) => [c, row[index[k]]]));
    }
    at = text.indexOf(head, at + head.length);
  }
}

module.exports = { DumpError, tableColumns, rows };
