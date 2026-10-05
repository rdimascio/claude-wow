'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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

const FAKE_DISCORD = path.join(__dirname, '..', '..', 'dev', 'fake-discord.js');

const posts = file => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l));
  } catch {
    return [];
  }
};

const withNotify =
  (extra = {}) =>
  async sb => {
    const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
    cfg.notify = { minRunSeconds: 0 };
    Object.assign(cfg.plugins, extra);
    fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
  };

const discordEnv = record => ({ [NT.SECRET_ENV]: HOOK, NODE_OPTIONS: `--require ${FAKE_DISCORD}`, CLAUDE_WOW_FAKE_DISCORD: record });

const freshRecord = name => {
  const record = path.join(ROOT, `discord-${name}-${process.pid}.jsonl`);
  fs.rmSync(record, { force: true });
  return record;
};

const assertQuiet = (record, project) => {
  for (const p of posts(record)) {
    assert.equal(p.url, `${HOOK}?wait=true`);
    assert.equal(p.method, 'POST');
    assert.deepEqual(p.body.allowed_mentions, { parse: [] });
    const text = JSON.stringify(p.body);
    assert.ok(!text.includes(project), `no project folder in ${text}`);
    assert.ok(!/what changed|boom|babysit|curl/.test(text), `no chat text in ${text}`);
  }
};

const titlesOf = record => posts(record).map(p => p.body.embeds[0].title);

test('a finished, blocked and failed coding run each post one Discord message that pings nobody and names no chat or folder', async () => {
  const record = freshRecord('runs');
  await withGame({ env: discordEnv(record), beforeLaunch: withNotify() }, async h => {
    const waitPosts = (n, label) => h.client.waitFor(() => posts(record).length >= n, { timeoutMs: 30000, label });
    await h.client.say('what changed on this branch');
    await waitPosts(1, 'the finished-run post');
    await h.client.say('[[bash curl https://example.com]]');
    await waitPosts(2, 'the blocked-run post');
    await h.client.say('[[error boom]]');
    await waitPosts(3, 'the failed-run post');
    assert.deepEqual(titlesOf(record), ['Claude finished', 'Claude needs a permission', 'Claude run failed']);
    assertQuiet(record, path.basename(h.sb.project));
    await h.bridge.stop();
    assert.equal(posts(record).length, 3, 'nothing more after the bridge stops');
  });
});

test('a factory result that comes back late posts that it waits in game', async () => {
  const record = freshRecord('late');
  await withGame({ env: discordEnv(record), beforeLaunch: withNotify({ 'claude-code': { factory: { enabled: true, skills: ['babysit-pr'] } } }) }, async h => {
    await h.client.say('[[mcp-call wowfactory factory_dispatch {"skill":"babysit-pr","args":"12"}]]');
    await h.client.waitFor(() => titlesOf(record).includes('A result is waiting in game'), { timeoutMs: 30000, label: 'the late result post' });
    const late = posts(record).find(p => p.body.embeds[0].title === 'A result is waiting in game');
    assert.match(late.body.embeds[0].description, /Send any message in the chat to fetch it\./);
    assert.equal(titlesOf(record).filter(t => t === 'A result is waiting in game').length, 1);
    assertQuiet(record, path.basename(h.sb.project));
  });
});
