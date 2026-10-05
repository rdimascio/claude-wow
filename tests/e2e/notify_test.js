'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const NT = require('../../bridge/notify');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('notify');
const withGame = gameRunner(ROOT);
const HOOK = 'https://discord.com/api/webhooks/123456/e2e-secret-token';

const quietNotify = async sb => {
  const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
  cfg.notify = { minRunSeconds: 999999 };
  fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
};

test('the Discord webhook secret given to the bridge never reaches an agent run, and the banner shows it redacted', async () => {
  await withGame({ env: { [NT.SECRET_ENV]: HOOK }, beforeLaunch: quietNotify }, async h => {
    await h.client.say('best race for a rogue');
    const call = h.agentCalls().at(-1);
    assert.ok(Array.isArray(call.envNames) && call.envNames.includes('PATH'), 'the fake agent recorded its environment');
    assert.ok(
      !call.envNames.some(k => /DISCORD|WEBHOOK/.test(k)),
      `no webhook variable in the agent env: ${call.envNames.filter(k => /DISCORD|WEBHOOK/.test(k))}`,
    );
    assert.match(h.bridge.output, /notify {3}: discord on \(webhook \.\.\.\/oken\), runs over 999999s, plain/);
    assert.ok(!h.bridge.output.includes('e2e-secret-token'), 'the secret is not printed');
  });
});
