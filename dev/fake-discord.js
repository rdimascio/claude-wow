'use strict';
const fs = require('fs');

const RECORD = process.env.CLAUDE_WOW_FAKE_DISCORD;
const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord\.com|discordapp\.com)\/api\/webhooks\//;

if (RECORD && typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (!WEBHOOK.test(target)) return realFetch(url, init);
    let body = null;
    try {
      body = JSON.parse(init.body);
    } catch {}
    fs.appendFileSync(RECORD, JSON.stringify({ url: target, method: init.method || 'GET', body, pid: process.pid, at: Date.now() }) + '\n');
    const status = Number(process.env.CLAUDE_WOW_FAKE_DISCORD_STATUS) || 200;
    return new Response(JSON.stringify({ id: String(Date.now()) }), { status, headers: { 'content-type': 'application/json' } });
  };
}
