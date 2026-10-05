'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DH = require('../bridge/chathub');

const OK = { enabled: true, applicationId: '800000000000000001', channelId: '800000000000000002', userIds: ['800000000000000003'] };

test('Discord stays off unless enabled with an application, a channel and at least one allowed user', () => {
  assert.deepEqual(DH.settings({}), { enabled: false });
  assert.deepEqual(DH.settings({ ...OK, enabled: 'yes' }), { enabled: false });
  const empty = DH.settings({ ...OK, userIds: [] });
  assert.equal(empty.enabled, false);
  assert.match(empty.error, /discord\.userIds/);
  assert.match(DH.settings({ ...OK, userIds: ['not-an-id'] }).error, /discord\.userIds/);
  assert.match(DH.settings({ ...OK, channelId: 'x' }).error, /discord\.channelId/);
  const on = DH.settings(OK);
  assert.equal(on.enabled, true);
  assert.equal(on.apiUrl, 'https://discord.com/api/v10');
  assert.equal(on.gateway, true);
  assert.equal(DH.settings({ ...OK, apiUrl: 'file:///etc/passwd' }).apiUrl, 'https://discord.com/api/v10');
});

test('the bot token is taken from the environment and removed from it, else read from the home token file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-discord-'));
  const env = { [DH.TOKEN_ENV]: ' abc ', PATH: '/bin' };
  assert.equal(DH.takeToken(env, home), 'abc');
  assert.deepEqual(Object.keys(env), ['PATH']);
  assert.equal(DH.takeToken(env, home), '');
  fs.writeFileSync(path.join(home, DH.TOKEN_FILE), 'from-file\n', { mode: 0o600 });
  assert.equal(DH.takeToken({}, home), 'from-file');
  fs.rmSync(home, { recursive: true, force: true });
});

test('outbound text pings nobody and carries no game tokens', () => {
  assert.equal(DH.clean('@everyone look at {item:2589} and <@123456> or <@&99> @here'), '@​everyone look at  and <@​123456> or <@​&99> @​here');
});

test('a long reply is split under the Discord limit at line ends, and every character arrives', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i} `.padEnd(50, 'x'));
  const text = lines.join('\n');
  const chunks = DH.splitText(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= DH.CHUNK_MAX, `chunk of ${c.length}`);
  assert.equal(chunks.join('\n'), text);
  const oneLine = 'y'.repeat(6000);
  const hard = DH.splitText(oneLine);
  assert.equal(hard.join(''), oneLine);
  assert.ok(hard.every(c => c.length <= DH.CHUNK_MAX));
  assert.deepEqual(DH.splitText(''), ['']);
});
