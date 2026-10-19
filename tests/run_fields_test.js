'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createVM, ADDON_DIR, tocFiles, coreFiles } = require('./lua/vm');

const RUN_FIELD_RE = /\brun\.([A-Za-z_]+)/g;
const STATE_FILE = path.join(ADDON_DIR, 'Core', 'State.lua');

function usedRunFields() {
  const used = new Map();
  for (const file of tocFiles()) {
    const text = fs.readFileSync(path.join(ADDON_DIR, file), 'utf8');
    for (const m of text.matchAll(RUN_FIELD_RE)) {
      if (!used.has(m[1])) used.set(m[1], file);
    }
  }
  return used;
}

function declaredRunFields() {
  const vm = createVM();
  vm.loadAddon(coreFiles());
  vm.run('local ns = ...; local keys = {}; for k in pairs(ns.RUN_FIELDS) do keys[#keys + 1] = k end; table.sort(keys); RUN_FIELDS = table.concat(keys, ",")', {
    ns: true,
  });
  return vm.evaluate('RUN_FIELDS').split(',');
}

function sourceOrder() {
  const text = fs.readFileSync(STATE_FILE, 'utf8');
  const block = text.slice(text.indexOf('local RUN_FIELDS = {'));
  const body = block.slice(0, block.indexOf('\n}'));
  return [...body.matchAll(/^\t([A-Za-z_]+) = true,$/gm)].map(m => m[1]);
}

test('run fields: every field the addon sets on run is declared in RUN_FIELDS, and nothing else is', () => {
  const declared = declaredRunFields();
  const used = usedRunFields();
  const undeclared = [...used].filter(([name]) => !declared.includes(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(undeclared, [], 'add each new run field to RUN_FIELDS in Core/State.lua');
  const unused = declared.filter(name => !used.has(name));
  assert.deepEqual(unused, [], 'drop fields the addon no longer sets from RUN_FIELDS');
  const listed = sourceOrder();
  assert.deepEqual(listed, declared, 'RUN_FIELDS lists one field per line, in sorted order');
});
