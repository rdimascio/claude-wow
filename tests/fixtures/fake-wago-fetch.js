'use strict';
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'wago');
const WAGO = 'https://wago.tools';
const REQUEST_LOG = process.env.CLAUDE_WOW_FAKE_WAGO_LOG || '';
const HANG_BUILDS = new Set(String(process.env.CLAUDE_WOW_FAKE_WAGO_HANG || '').split(',').filter(Boolean));
const MISSING_BUILDS = new Set(String(process.env.CLAUDE_WOW_FAKE_WAGO_MISSING || '').split(',').filter(Boolean));
const realFetch = globalThis.fetch;

function served(body, headers) {
  return new Response(body, { status: 200, headers });
}

globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.origin !== WAGO) return realFetch(url, init);
  if (REQUEST_LOG) fs.appendFileSync(REQUEST_LOG, `${u.pathname}${u.search}\n`);
  if (u.pathname === '/api/builds') return served(fs.readFileSync(path.join(FIXTURES, 'builds.json'), 'utf8'), { 'content-type': 'application/json' });
  const table = /^\/db2\/(\w+)\/csv$/.exec(u.pathname);
  const build = u.searchParams.get('build') || '';
  if (HANG_BUILDS.has(build)) {
    if (REQUEST_LOG) fs.appendFileSync(REQUEST_LOG, `hang ${process.pid}\n`);
    setInterval(() => {}, 60000);
    return new Promise(() => {});
  }
  if (!table || MISSING_BUILDS.has(build)) return new Response('no such build', { status: 404, headers: { 'content-type': 'text/plain' } });
  return served(fs.readFileSync(path.join(FIXTURES, `${table[1]}.csv`), 'utf8'), {
    'content-type': 'text/csv',
    'content-disposition': `attachment; filename="${table[1]}.${build}.csv"`,
  });
};
