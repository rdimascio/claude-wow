'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const NT = require('../bridge/notify');

const HOOK = 'https://discord.com/api/webhooks/123456/AbC-def_9';

function fakeFetch(respond = () => ({ ok: true, status: 200 })) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(url, init);
  };
  return { fetch, calls };
}

test('the webhook secret is read once and removed from the environment every agent run inherits', () => {
  const env = { [NT.SECRET_ENV]: ` ${HOOK} `, PATH: '/bin' };
  assert.equal(NT.takeSecret(env), HOOK);
  assert.deepEqual(Object.keys(env), ['PATH']);
  assert.equal(NT.takeSecret(env), '');
});

test('a run ends as failed on error, blocked when a tool was denied, else done', () => {
  assert.equal(NT.runEvent('error', [{ tool: 'Bash' }]), 'failed');
  assert.equal(NT.runEvent('done', [{ tool: 'Bash' }]), 'blocked');
  assert.equal(NT.runEvent('done', []), 'done');
  assert.equal(NT.runEvent('done', undefined), 'done');
});

test('only a Discord webhook URL is accepted; the query string is dropped', () => {
  assert.deepEqual(NT.webhookUrl(HOOK + '?thread_id=9'), { url: HOOK });
  assert.equal(NT.webhookUrl('https://ptb.discord.com/api/webhooks/1/x').url, 'https://ptb.discord.com/api/webhooks/1/x');
  assert.equal(NT.webhookUrl('https://discordapp.com/api/webhooks/1/x/').url, 'https://discordapp.com/api/webhooks/1/x');
  for (const bad of [
    'http://discord.com/api/webhooks/1/x',
    'https://evil.com/api/webhooks/1/x',
    'https://discord.com.evil.com/api/webhooks/1/x',
    'https://discord.com/api/webhooks/x/y',
    'https://discord.com/api/users/1/x',
    'not a url',
  ]) {
    const r = NT.webhookUrl(bad);
    assert.equal(r.url, '', bad);
    assert.ok(r.error, bad);
  }
  assert.deepEqual(NT.webhookUrl(''), { url: '' });
});

test('settings: the environment wins over config, an error names its source, and the defaults are plain detail and 60 s', () => {
  const both = NT.settings({ discord: { webhookUrl: 'https://discord.com/api/webhooks/9/z' } }, HOOK);
  assert.equal(both.url, HOOK);
  assert.equal(both.detail, 'plain');
  assert.equal(both.minRunSeconds, 60);
  assert.match(NT.settings({ discord: { webhookUrl: 'https://x.com/a' } }).error, /^notify\.discord\.webhookUrl is not a Discord webhook URL/);
  assert.match(NT.settings({}, 'https://x.com/a').error, new RegExp(`^${NT.SECRET_ENV} `));
  assert.equal(NT.settings({ detail: 'named', minRunSeconds: 0 }).detail, 'named');
  assert.equal(NT.settings({ minRunSeconds: 0 }).minRunSeconds, 0);
  assert.equal(NT.settings({ minRunSeconds: -5 }).minRunSeconds, 60);
  assert.equal(NT.redact(HOOK), 'webhook .../ef_9');
});

test('the payload pings nobody, carries no chat name or folder unless detail is named, and never a game token or markdown', () => {
  const fields = { character: '@everyone Thrall', chat: 'fix {item:2589} for **PRD-1**', cwd: '/Users/me/secret-repo', ms: 125000 };
  const plain = NT.payload('done', fields, 'plain');
  assert.deepEqual(plain.allowed_mentions, { parse: [] });
  const text = JSON.stringify(plain);
  assert.ok(!text.includes('secret-repo') && !text.includes('PRD-1'), text);
  assert.match(plain.embeds[0].description, /^Character: everyone Thrall\nTime: 2m 5s$/);
  const named = NT.payload('done', fields, 'named').embeds[0].description;
  assert.match(named, /Chat: fix for PRD-1/);
  assert.match(named, /Project: secret-repo/);
  assert.ok(!named.includes('{item'));
  assert.match(NT.payload('late', {}, 'plain').embeds[0].description, /Send any message in the chat to fetch it\./);
  assert.ok(!/Time:/.test(NT.payload('late', { ms: 5000 }).embeds[0].description));
});

test('notify posts with wait=true, skips runs shorter than minRunSeconds but never a late result, and an off notifier sends nothing', async () => {
  const f = fakeFetch();
  const n = NT.createNotifier({ url: HOOK, minRunSeconds: 60, fetch: f.fetch });
  assert.equal(n.notify('done', { ms: 59000 }), false);
  assert.equal(n.notify('failed', {}), false, 'no run time: not sent');
  assert.equal(n.notify('blocked', { ms: 61000 }), true);
  assert.equal(n.notify('late', {}), true);
  assert.equal(n.notify('nonsense', { ms: 1e9 }), false);
  await n.flush();
  assert.deepEqual(
    f.calls.map(c => c.url),
    [`${HOOK}?wait=true`, `${HOOK}?wait=true`],
  );
  assert.deepEqual(
    f.calls.map(c => c.body.embeds[0].title),
    ['Claude needs a permission', 'A result is waiting in game'],
  );
  assert.equal(f.calls[0].init.method, 'POST');
  const off = NT.createNotifier({ url: '', fetch: f.fetch });
  assert.equal(off.enabled, false);
  assert.equal(off.notify('late', {}), false);
});

test('a failed or thrown send is logged without the secret and never throws', async () => {
  const logs = [];
  const bad = NT.createNotifier({ url: HOOK, minRunSeconds: 0, fetch: async () => ({ ok: false, status: 429 }), log: l => logs.push(l) });
  bad.notify('done', { ms: 1 });
  await bad.flush();
  const thrown = NT.createNotifier({
    url: HOOK,
    minRunSeconds: 0,
    fetch: async () => {
      throw new Error('offline');
    },
    log: l => logs.push(l),
  });
  thrown.notify('done', { ms: 1 });
  await thrown.flush();
  assert.equal(logs.length, 2);
  assert.match(logs[0], /HTTP 429/);
  assert.match(logs[1], /offline/);
  for (const l of logs) assert.ok(!l.includes('AbC-def'), l);
});

test('flush waits for a send in flight, and gives up after its limit', async () => {
  let release;
  const n = NT.createNotifier({
    url: HOOK,
    minRunSeconds: 0,
    fetch: () =>
      new Promise(r => {
        release = () => r({ ok: true });
      }),
  });
  n.notify('done', { ms: 1 });
  const t0 = Date.now();
  await n.flush(50);
  assert.ok(Date.now() - t0 >= 40, 'waited up to the limit');
  let done = false;
  const flushing = n.flush(5000).then(() => {
    done = true;
  });
  release();
  await flushing;
  assert.equal(done, true);
});

test('claude-wow notify test sends one message, or says why it cannot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-notify-'));
  const home = { config: path.join(dir, 'config.json') };
  const out = [];
  const f = fakeFetch();
  fs.writeFileSync(home.config, JSON.stringify({ notify: { discord: { webhookUrl: HOOK } } }));
  assert.equal(await NT.main(['test'], { home, env: {}, fetch: f.fetch, out: l => out.push(l) }), 0);
  assert.equal(f.calls.length, 1);
  assert.match(out.at(-1), /^Sent a test message to webhook \.\.\.\/ef_9\.$/);
  fs.writeFileSync(home.config, JSON.stringify({}));
  assert.equal(await NT.main(['test'], { home, env: {}, fetch: f.fetch, out: l => out.push(l) }), 2);
  assert.match(out.at(-1), /^No webhook:/);
  const failing = fakeFetch(() => ({ ok: false, status: 401 }));
  assert.equal(await NT.main(['test'], { home, env: { [NT.SECRET_ENV]: HOOK }, fetch: failing.fetch, out: l => out.push(l) }), 1);
  assert.match(out.at(-1), /HTTP 401/);
  fs.rmSync(dir, { recursive: true, force: true });
});
