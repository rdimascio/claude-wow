'use strict';
const fs = require('fs');
const path = require('path');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ADDON_NAME = 'ClaudeWoW';
const ADDON_DIR = path.join(__dirname, '..', '..', 'addon', ADDON_NAME);
const STUB_FILE = path.join(__dirname, '..', 'wow_stub.lua');
const LOGIN = 'STUB.FireEvent("ADDON_LOADED", "ClaudeWoW"); STUB.FireEvent("PLAYER_LOGIN")';

function tocFiles(dir = ADDON_DIR, name = ADDON_NAME) {
  return fs
    .readFileSync(path.join(dir, name + '.toc'), 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.endsWith('.lua') && !l.startsWith('#'))
    .map(l => l.replace(/\\/g, '/'));
}

function tocFilesUpTo(last, files = tocFiles()) {
  const at = files.indexOf(last);
  if (at < 0) throw new Error(last + ' is not in ' + ADDON_NAME + '.toc');
  return files.slice(0, at + 1);
}

const isShared = (f, files = tocFiles()) => f.includes('/') && files.indexOf(f) < files.indexOf('ClaudeWoW.lua');

const coreFiles = () => tocFiles().filter(f => f.startsWith('Core/'));

function sharedFilesBefore(file, files = tocFiles()) {
  const at = files.indexOf(file);
  return (at < 0 ? files : files.slice(0, at)).filter(f => isShared(f, files));
}

function createVM({ stub = true, utf8 = true } = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  lua.lua_newtable(L);
  const nsRef = lauxlib.luaL_ref(L, lua.LUA_REGISTRYINDEX);
  const decode = utf8 ? v => to_jsstring(v) : v => Buffer.from(v).toString('latin1');
  const loaded = new Set();

  const fail = what => {
    const raw = lua.lua_tostring(L, -1);
    const message = raw ? to_jsstring(raw) : 'a non-string error value';
    lua.lua_pop(L, 1);
    throw new Error(what + ': ' + message);
  };

  const run = (code, { chunk, args = [], ns = false } = {}) => {
    const buf = to_luastring(code);
    const status = chunk ? lauxlib.luaL_loadbuffer(L, buf, buf.length, to_luastring('@' + chunk)) : lauxlib.luaL_loadstring(L, buf);
    if (status !== lua.LUA_OK) fail('Lua load');
    for (const arg of args) lua.lua_pushstring(L, to_luastring(String(arg)));
    if (ns) lua.lua_rawgeti(L, lua.LUA_REGISTRYINDEX, nsRef);
    if (lua.lua_pcall(L, args.length + (ns ? 1 : 0), 0, 0) !== lua.LUA_OK) fail('Lua error');
  };

  const evaluate = expr => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : decode(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };

  const num = expr => Number(evaluate(expr));

  const loadOne = file => {
    run(fs.readFileSync(path.join(ADDON_DIR, file), 'utf8'), { chunk: 'addon/' + file, args: [ADDON_NAME], ns: true });
    loaded.add(file);
  };

  const loadFile = file => {
    if (!isShared(file)) for (const shared of sharedFilesBefore(file)) if (!loaded.has(shared)) loadOne(shared);
    loadOne(file);
  };

  const loadAddon = (files = tocFiles()) => {
    for (const f of files) loadFile(f);
  };

  const login = () => run(LOGIN);

  if (stub) run(fs.readFileSync(STUB_FILE, 'utf8'), { chunk: 'tests/wow_stub.lua' });

  return { L, run, evaluate, num, loadFile, loadAddon, login };
}

module.exports = { ADDON_NAME, ADDON_DIR, LOGIN, createVM, tocFiles, tocFilesUpTo, coreFiles };
