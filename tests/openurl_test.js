'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const OU = require('../bridge/openurl');
const P = require('../bridge/protocol');

const PR = 'https://github.com/o/r/pull/7';

const HOSTILE = [
  ['file URL', 'file:///etc/passwd'],
  ['file URL to a Windows program', 'file:///C:/Windows/System32/calc.exe'],
  ['javascript URL', 'javascript:alert(1)'],
  ['javascript URL in capitals', 'JAVASCRIPT:alert(1)'],
  ['data URL', 'data:text/html,hi'],
  ['vbscript URL', 'vbscript:msgbox(1)'],
  ['ftp URL', 'ftp://example.com/x'],
  ['custom scheme', 'steam://run/440'],
  ['custom scheme with a web lookalike', 'ms-settings:privacy'],
  ['scheme in capitals', 'HTTPS://EXAMPLE.COM/'],
  ['a dash first', '-a'],
  ['an option first', '--args=https://example.com'],
  ['a dash before the scheme', '-https://example.com'],
  ['a space inside', 'https://example.com/a b'],
  ['a leading space', ' https://example.com'],
  ['a tab inside', 'https://example.com/\tx'],
  ['a newline inside', 'https://example.com/\n-x'],
  ['a carriage return inside', 'https://example.com/\r'],
  ['a NUL byte', 'https://example.com/\x00'],
  ['a DEL byte', 'https://example.com/\x7f'],
  ['a non-ASCII host', 'https://\u0430pple.com/'],
  ['a backslash', 'https://example.com\\..\\x'],
  ['a backtick', 'https://example.com/`id`'],
  ['a double quote', 'https://example.com/"&calc'],
  ['a pipe', 'https://example.com/|calc'],
  ['a caret', 'https://example.com/^x'],
  ['angle brackets', 'https://example.com/<x>'],
  ['curly braces', 'https://example.com/{x}'],
  ['a user name', 'https://user@example.com/'],
  ['a user name and password', 'https://user:pw@example.com/'],
  ['a phishing user name', 'https://github.com@evil.example/'],
  ['no slashes after the scheme', 'https:example.com'],
  ['one slash after the scheme', 'http:/example.com'],
  ['no scheme', '//example.com/x'],
  ['a scheme alone', 'https://'],
  ['no host', 'http://:80/'],
  ['a host that does not parse', 'http://exa%mple.com/'],
  ['empty', ''],
  ['longer than 2048 characters', 'https://example.com/' + 'a'.repeat(2049 - 'https://example.com/'.length)],
  ['not text: a number', 42],
  ['not text: null', null],
  ['not text: an object', { toString: () => PR }],
];

test('checkUrl takes plain http and https links only, parsed with the WHATWG URL parser', () => {
  assert.deepEqual(OU.checkUrl(PR), { ok: true, href: PR });
  assert.deepEqual(OU.checkUrl('http://example.com'), { ok: true, href: 'http://example.com/' });
  assert.equal(OU.checkUrl('https://Example.COM/a?b=1&c=(2)#x').href, 'https://example.com/a?b=1&c=(2)#x');
  assert.equal(OU.checkUrl('https://linear.app/every/issue/PRD-8708/pandl-month').ok, true);
  assert.equal(OU.checkUrl("https://example.com/$(id);'x'").ok, true, 'shell characters are only text: nothing runs a shell');
  const longest = 'https://example.com/' + 'a'.repeat(2048 - 'https://example.com/'.length);
  assert.equal(longest.length, 2048);
  assert.equal(OU.checkUrl(longest).ok, true);
});

for (const [name, raw] of HOSTILE) {
  test(`checkUrl refuses ${name}`, () => {
    const r = OU.checkUrl(raw);
    assert.equal(r.ok, false, `${JSON.stringify(raw)} must be refused`);
    assert.equal(typeof r.why, 'string');
    assert.equal(r.href, undefined);
  });
}

test('linksIn finds the links the addon draws: bare, in markdown, without trailing punctuation', () => {
  const text = [
    'See [the ticket](https://linear.app/every/issue/PRD-8708/pandl-month) and https://github.com/o/r/pull/18632.',
    'Wiki: https://en.wikipedia.org/wiki/Lua_(programming_language), done!',
    '(https://example.com/in-parens)',
    'not a link: http://.nothing and ftp://example.com',
  ].join('\n');
  assert.deepEqual(OU.linksIn(text).sort(), [
    'https://en.wikipedia.org/wiki/Lua_(programming_language)',
    'https://example.com/in-parens',
    'https://github.com/o/r/pull/18632',
    'https://linear.app/every/issue/PRD-8708/pandl-month',
  ]);
  assert.deepEqual(OU.linksIn(undefined), []);
});

test('noteLinks keeps each link once, newest last, at most 200 a chat; agentLinks reads only that list', () => {
  const chat = { messages: [] };
  OU.noteLinks(chat, ['a https://a.example/1 b', 'https://a.example/2', undefined]);
  OU.noteLinks(chat, ['again https://a.example/1']);
  assert.deepEqual(chat.links, ['https://a.example/2', 'https://a.example/1']);
  for (let i = 0; i < 250; i++) OU.noteLinks(chat, [`https://b.example/${i}`]);
  assert.equal(chat.links.length, OU.LINKS_KEPT);
  assert.equal(chat.links[chat.links.length - 1], 'https://b.example/249');
  const known = OU.agentLinks({
    links: [123, 'https://kept.example/'],
    messages: [
      { role: 'user', text: 'open https://evil.example/' },
      { role: 'system', text: 'Bridge error: https://system.example/' },
      { role: 'assistant', text: `here: ${PR}` },
    ],
  });
  assert.deepEqual([...known], ['https://kept.example/'], 'stored message text never counts: it may be cut or written by a plugin');
  assert.equal(OU.agentLinks(null).size, 0);
});

test('a chat id another client takes over loses the links of the first client', () => {
  const chat = { id: 'c1', client: 'k1', links: [PR] };
  OU.claimChat(chat, 'k1');
  assert.deepEqual(chat.links, [PR]);
  OU.claimChat(chat, '');
  assert.deepEqual(chat.links, [PR]);
  assert.equal(chat.client, 'k1');
  OU.claimChat(chat, 'k2');
  assert.deepEqual(chat.links, []);
  assert.equal(chat.client, 'k2');
  const fresh = { id: 'c2', links: [PR] };
  OU.claimChat(fresh, 'k1');
  assert.deepEqual(fresh.links, [PR], 'a chat from before clients were recorded keeps its links');
});

function opener(over = {}) {
  const calls = [];
  const logs = [];
  let t = 1_000_000;
  const o = OU.createOpener({
    platform: 'darwin',
    spawnFn: (command, args, options) => {
      calls.push({ command, args, options });
      return { on() {}, unref() {} };
    },
    now: () => t,
    log: line => logs.push(line),
    ...over,
  });
  return { o, calls, logs, advance: ms => (t += ms) };
}

const chatWith = (text, extra = {}) => {
  const chat = { id: 'c1', messages: [{ role: 'assistant', text }], ...extra };
  OU.noteLinks(chat, [text]);
  return chat;
};
const job = (text, extra = {}) => ({ kind: 'url', chat: 'c1', session: 's', id: 5, text, via: 'pixel', client: 'k1', ...extra });

test('an agent link opens with no shell: open on macOS, xdg-open on Linux, rundll32 on Windows', async () => {
  const cases = [
    ['darwin', {}, '/usr/bin/open', [PR]],
    ['linux', {}, 'xdg-open', [PR]],
    ['win32', { SystemRoot: 'D:\\Win' }, 'D:\\Win\\System32\\rundll32.exe', ['url.dll,FileProtocolHandler', PR]],
    ['win32', {}, 'C:\\Windows\\System32\\rundll32.exe', ['url.dll,FileProtocolHandler', PR]],
  ];
  for (const [platform, env, command, args] of cases) {
    const { o, calls } = opener({ platform, env });
    assert.equal(o.available, true);
    const r = await o.request(job(PR), chatWith(`see ${PR}.`));
    assert.equal(r.opened, true, r.text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, command);
    assert.deepEqual(calls[0].args, args);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.ok(!/cmd(\.exe)?$/i.test(calls[0].command) && !calls[0].args.some(a => /^\/c$/i.test(a)), 'never cmd /c start');
  }
});

test('the parsed href is what is opened, never the raw text', async () => {
  const { o, calls } = opener();
  const raw = 'https://Example.COM';
  assert.equal((await o.request(job(raw), chatWith(`go to ${raw} now`))).opened, true);
  assert.deepEqual(calls[0].args, ['https://example.com/']);
});

test('a link the bridge never sent in that chat is refused and nothing is spawned', async () => {
  const refusals = [
    ['in the player message only', job('https://evil.example/'), { id: 'c1', messages: [{ role: 'user', text: 'https://evil.example/' }] }],
    ['in a bridge error only', job('https://evil.example/'), { id: 'c1', messages: [{ role: 'system', text: 'https://evil.example/' }] }],
    [
      'in stored reply text but not in the links list',
      job('https://evil.example/'),
      { id: 'c1', messages: [{ role: 'assistant', text: 'https://evil.example/' }], links: [] },
    ],
    ['a link of chat A on a record for chat B', job(PR, { chat: 'c2' }), { id: 'c2', links: ['https://b.example/'] }],
    ['only a prefix of a reply link', job('https://github.com/o/r'), chatWith(PR)],
    ['a reply link with more after it', job(PR + '/files'), chatWith(PR)],
    ['a link from another chat', job(PR, { chat: 'c2' }), undefined],
    ['no chat on the record', job(PR, { chat: '' }), chatWith(PR)],
    ['the chat belongs to another client', job(PR, { client: 'k2' }), chatWith(PR, { client: 'k1' })],
    ['a record from the reload outbox', job(PR, { via: 'reload' }), chatWith(PR)],
  ];
  for (const [name, j, chat] of refusals) {
    const { o, calls } = opener();
    const r = await o.request(j, chat);
    assert.equal(r.opened, false, name);
    assert.match(r.text, /^open link refused \(/, name);
    assert.equal(calls.length, 0, `${name}: nothing spawned`);
  }
});

test('a link that passes the provenance check but not checkUrl is refused for the checkUrl reason, before anything else', async () => {
  const hostile = [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'steam://run/440',
    '-https://example.com',
    `${PR}\n-x`,
    'https://example.com/a b',
    'https://user:pw@example.com/',
    'https://example.com/' + 'a'.repeat(2100),
  ];
  for (const raw of hostile) {
    const { o, calls } = opener();
    const r = await o.request(job(raw), { id: 'c1', links: [raw] });
    assert.equal(r.opened, false, JSON.stringify(raw));
    assert.equal(r.why, OU.checkUrl(raw).why, JSON.stringify(raw));
    assert.notEqual(r.why, 'not a link from a reply in this chat');
    assert.equal(calls.length, 0);
  }
});

test('the refusal log line shows the input as one escaped, cut line', async () => {
  const { o } = opener();
  const r = await o.request(job('x\n\x1b[31m' + 'y'.repeat(500)), chatWith(''));
  assert.ok(!/[\n\x1b]/.test(r.text), r.text);
  assert.ok(r.text.length < 220, r.text);
});

test('a link from the transcript links list counts, also after the message text was cut', async () => {
  const { o, calls } = opener();
  const chat = { id: 'c1', messages: [{ role: 'assistant', text: PR.slice(0, 20) }], links: [PR] };
  assert.equal((await o.request(job(PR), chat)).opened, true);
  assert.equal(calls.length, 1);
});

test('rate limit: one link every 2 s and 20 an hour; refusals do not count', async () => {
  const { o, calls, advance } = opener();
  const chat = chatWith(Array.from({ length: 30 }, (_, i) => `https://x.example/${i}`).join(' '));
  assert.equal((await o.request(job('https://x.example/0'), chat)).opened, true);
  const soon = await o.request(job('https://x.example/1'), chat);
  assert.equal(soon.opened, false);
  assert.match(soon.text, /rate limit: one link every 2 s/);
  advance(1999);
  assert.equal((await o.request(job('https://x.example/1'), chat)).opened, false);
  advance(1);
  assert.equal((await o.request(job('https://x.example/1'), chat)).opened, true);
  assert.equal((await o.request(job('https://evil.example/'), chat)).opened, false);
  for (let i = 2; i < 20; i++) {
    advance(OU.MIN_GAP_MS);
    assert.equal((await o.request(job(`https://x.example/${i}`), chat)).opened, true, `open ${i}`);
  }
  advance(OU.MIN_GAP_MS);
  const capped = await o.request(job('https://x.example/20'), chat);
  assert.equal(capped.opened, false);
  assert.match(capped.text, /20 links an hour/);
  assert.equal(calls.length, OU.PER_HOUR);
  advance(3600000);
  assert.equal((await o.request(job('https://x.example/21'), chat)).opened, true, 'the hour window slides');
});

test('off by config, or on a platform with no launcher, the capability is not offered and nothing opens', async () => {
  for (const over of [{ enabled: false }, { platform: 'aix' }, { enabled: 'yes' }]) {
    const { o, calls } = opener(over);
    assert.equal(o.available, false);
    assert.equal((await o.request(job(PR), chatWith(PR))).opened, false);
    assert.equal(calls.length, 0);
  }
});

function fakeChild(emit) {
  const child = new EventEmitter();
  child.unref = () => {
    child.unrefed = true;
  };
  if (emit) setImmediate(() => emit(child));
  return child;
}

test('the result waits for the launcher: an error event is a refusal with a fixed reason, a spawn event is ok', async () => {
  const failing = OU.createOpener({ platform: 'linux', spawnFn: () => fakeChild(c => c.emit('error', new Error('spawn xdg-open ENOENT'))) });
  const r = await failing.request(job(PR), chatWith(PR));
  assert.equal(r.opened, false);
  assert.equal(r.why, OU.LAUNCH_FAILED);
  assert.match(r.text, /open link failed \(xdg-open: spawn xdg-open ENOENT\)/);
  let started;
  const ok = OU.createOpener({ platform: 'linux', spawnFn: () => (started = fakeChild(c => c.emit('spawn'))) });
  const r2 = await ok.request(job(PR), chatWith(PR));
  assert.equal(r2.opened, true);
  assert.equal(started.unrefed, true);
  assert.doesNotThrow(() => started.emit('error', new Error('late')), 'a late error after the start is swallowed');
});

test('with neither event within the start timeout the link counts as opened and a line is logged', async () => {
  const logs = [];
  const timers = [];
  const o = OU.createOpener({
    platform: 'darwin',
    log: l => logs.push(l),
    spawnFn: () => fakeChild(),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  const pending = o.request(job(PR), chatWith(PR));
  await new Promise(r => setImmediate(r));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, OU.START_TIMEOUT_MS);
  timers[0].fn();
  const r = await pending;
  assert.equal(r.opened, true);
  assert.match(logs[0], /no spawn or error event in 2000 ms; counted as opened/);
});

test('a spawn that throws is a refusal, not a crash', async () => {
  const t = OU.createOpener({
    platform: 'linux',
    spawnFn: () => {
      throw new Error('EACCES');
    },
  });
  const r = await t.request(job(PR), chatWith(PR));
  assert.equal(r.opened, false);
  assert.equal(r.why, OU.LAUNCH_FAILED);
  assert.match(r.text, /open link failed \(EACCES\)/);
});

test('chat ids that name Object.prototype members are dropped off the strip, and own-property reads keep inherited fields out', () => {
  for (const chat of ['__proto__', 'a-b', 'c.d', '../x']) {
    const payload = ['sess', chat, '9', '', 'kind=url', '', PR].join('\x1F');
    assert.deepEqual(P.jobsFromStrip(0, payload), [], chat);
  }
  assert.equal(P.jobsFromStrip(0, ['sess', 'abc123', '9', '', 'kind=url', '', PR].join('\x1F')).length, 1);
  assert.equal(OU.chatFor({}, 'constructor'), null, 'constructor parses as a chat id, but no transcript has it as its own');
  assert.equal(OU.chatFor({}, '__proto__'), null);
  assert.equal(OU.chatFor({ toString: 'x' }, 'toString'), null, 'an own field that is not a chat');
  const real = { id: 'c1', links: [PR] };
  assert.equal(OU.chatFor({ c1: real }, 'c1'), real);
  assert.equal(P.jobsFromStrip(0, ['sess', '', '9', '', 'kind=dm', 'Name-Realm', 'next'].join('\x1F')).length, 1, 'an empty chat stays valid');
  const inherited = Object.create({ links: [PR], client: 'k9' });
  assert.equal(OU.agentLinks(inherited).size, 0);
  OU.claimChat(inherited, 'k1');
  assert.equal(Object.hasOwn(inherited, 'client'), true);
  assert.equal(Object.prototype.client, undefined);
  assert.equal(Object.prototype.links, undefined);
});

test('a request whose chat resolves to Object.prototype is refused', async () => {
  const { o, calls } = opener();
  for (const chat of ['__proto__', 'constructor', 'hasOwnProperty']) {
    const r = await o.request(job(PR, { chat }), OU.chatFor({}, chat));
    assert.equal(r.opened, false, chat);
    assert.equal(r.why, 'no such chat', chat);
  }
  const borrowed = Object.assign(Object.create({ client: 'k2' }), { id: 'c1', links: [PR] });
  const owned = await o.request(job(PR, { client: 'k1' }), borrowed);
  assert.equal(owned.opened, true, 'an inherited client field is not the owner of the chat');
  calls.length = 0;
  Object.prototype.links = [PR];
  try {
    const r = await o.request(job(PR), {});
    assert.equal(r.opened, false, "an inherited links list is not the chat's");
  } finally {
    delete Object.prototype.links;
  }
  assert.equal(calls.length, 0);
});

test('recordingSpawn writes the launch instead of starting it', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openurl-')), 'opened.jsonl');
  const o = OU.createOpener({ platform: 'darwin', spawnFn: OU.recordingSpawn(file) });
  assert.equal((await o.request(job(PR), chatWith(PR))).opened, true);
  const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(line.command, '/usr/bin/open');
  assert.deepEqual(line.args, [PR]);
  assert.equal(line.shell, false);
});

test('isOpenRecord matches only kind=url, which parseFlags reads off the strip', () => {
  assert.equal(OU.isOpenRecord(job(PR)), true);
  assert.equal(OU.isOpenRecord({ kind: 'dm' }), false);
  assert.equal(OU.isOpenRecord(null), false);
  const [j] = P.jobsFromStrip(0, ['sess', 'c1', '9', '', 'kind=url', '', PR].join('\x1F'));
  assert.equal(j.kind, OU.KIND);
  assert.equal(j.text, PR);
  assert.equal(P.parseOutbox('["outbox"] = { ["id"] = 3, ["text"] = "", ["kind"] = "url" }').kind, undefined, 'the reload outbox never carries a kind');
});

test('the ack carries the open result for the addon: ok, or refused with a short reason', () => {
  let acks = P.noteAck([], { session: 's', id: 4 }, 1000, { open: 'refused', why: 'rate limit: ' + 'x'.repeat(200) });
  acks = P.noteAck(acks, { session: 's', id: 5 }, 1000, { open: 'ok' });
  acks = P.noteAck(acks, { session: 's', id: 6 }, 1000);
  acks = P.noteAck(acks, { session: 's', id: 4 }, 2000);
  const lua = P.luaTable('ClaudeWoW_SlotData', [], { acks, now: 2000 });
  assert.match(lua, /\{ session = "s", id = 4, open = "refused", why = "rate limit: x{68}" \}/, 'a repeated ack keeps its result: ' + lua);
  assert.match(lua, /\{ session = "s", id = 5, open = "ok" \}/);
  assert.match(lua, /\{ session = "s", id = 6 \}/);
  assert.doesNotMatch(P.luaTable('X', [], { acks: [{ session: 's', id: 7, at: 1, open: 'maybe', why: 'x' }] }), /open|why/);
});

test('the slot file offers the capability only when the bridge can open links', () => {
  const on = P.luaTable('ClaudeWoW_SlotData', [], { openUrl: true });
  assert.match(on, /\n\topenUrl = true,\n/);
  for (const v of [false, undefined, 'true', 1]) assert.doesNotMatch(P.luaTable('ClaudeWoW_SlotData', [], { openUrl: v }), /openUrl/);
});
