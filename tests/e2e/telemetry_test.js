'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const SB = require('../../dev/sandbox');
const SIG = require('../../bridge/signals');
const TL = require('../../bridge/telemetry');
const { encodePng, luaQuote } = require('../../dev/wow/client');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('telemetry');
const withGame = gameRunner(ROOT);
const RECORDS = 300;
const PER_FRAME = 20;
const CELL = 4;
const CELLS = 200;
const WIDTH = 1920;
const HEIGHT = 1080;
const SLOTS = 200;
const CHARACTER = 'Testchar-TestRealm';

function spentSlots(sb, kind) {
  const out = [];
  for (let slot = 1; slot <= SLOTS; slot++) if (!fs.existsSync(SIG.signalFile(sb.addons, kind, slot))) out.push(slot);
  return out;
}

const slotOfId = n => ((n - 1) % SLOTS) + 1;

function addonRecordTracker(h) {
  let unsettled = new Set();
  let trackedTo = 0;
  const catchUp = () => {
    for (let id = trackedTo + 1; id <= h.client.lastSeq(); id++) unsettled.add(id);
    trackedTo = Math.max(trackedTo, h.client.lastSeq());
  };
  return {
    unsettled: () => {
      catchUp();
      return [...unsettled];
    },
    settled: ids => {
      for (const id of ids) unsettled.delete(id);
    },
    skipTo: lastSeq => {
      catchUp();
      trackedTo = lastSeq;
    },
  };
}

function messageIds(h) {
  const ids = new Set();
  for (const chat of h.client.db().chats || []) {
    for (const m of chat.history || []) if (m.role === 'user' && Number.isInteger(m.id)) ids.add(m.id);
  }
  return ids;
}

const anyChatWaiting = h => (h.client.db().chats || []).some(chat => chat.pendingId);

async function settleAddonRecords(h, tracker) {
  await h.bridge.waitForLine(/hello from session /);
  const ids = await h.client.waitFor(
    () => {
      const acks = spentSlots(h.sb, 'ack');
      const sigs = spentSlots(h.sb, 'sig');
      const pending = tracker.unsettled();
      const messages = messageIds(h);
      const unanswered = pending.filter(id => messages.has(id) && !sigs.includes(slotOfId(id)));
      return pending.every(id => acks.includes(slotOfId(id))) && unanswered.length === 0 && !anyChatWaiting(h) ? pending : null;
    },
    { timeoutMs: 30000, label: 'the bridge to ack every record the addon sent and to answer every message and quiet record among them' },
  );
  tracker.settled(ids);
}

function quietClient(h) {
  h.client.runLua('ClaudeWoWDB.stream = ClaudeWoWDB.stream or {}; ClaudeWoWDB.stream.follow = false');
}

function assertSpends(h, { session, before, kind, messageId, issuedFrom, issuedTo, logFrom }) {
  const spent = spentSlots(h.sb, kind).filter(s => !before.includes(s));
  const own = slotOfId(messageId);
  assert.ok(spent.includes(own), `the message spent its ${kind} file`);
  const log = h.bridge.output.slice(logFrom);
  for (const s of spent.filter(x => x !== own)) {
    const real = [];
    for (let r = issuedFrom; r <= issuedTo; r++) {
      if (r !== messageId && slotOfId(r) === s && (new RegExp(`(?<!gs )#${r}@${session}[ :]`).test(log) || /hello from session /.test(log))) real.push(r);
    }
    assert.ok(real.length, `${kind} slot ${s} was spent by a record the addon itself sent (ids ${issuedFrom}..${issuedTo}), never by a gs seq`);
  }
  return spent;
}

function gsRecord(session, seq) {
  const money = String(1000 + seq);
  const hash = String(seq).padStart(8, '0');
  return [session, '', String(seq), '', 'kind=gs', CHARACTER, `gs1\nmoney:${hash}:${money}`].join('\x1F');
}

function stripCells(client, payload) {
  return client
    .luaValue(
      `(function() local c = ClaudeWoW_Codec.Encode(0, ${luaQuote(payload)}, 1); local t = {}; for i = 1, #c do t[i] = c[i] end; return table.concat(t, ",") end)()`,
    )
    .split(',')
    .map(Number);
}

function writeShot(sb, client, payload, n) {
  const cells = stripCells(client, payload);
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  cells.forEach((v, i) => {
    const r = Math.floor(i / CELLS),
      c = i % CELLS;
    const lv = [(v >> 2) & 1, (v >> 1) & 1, v & 1].map(b => (b ? 255 : 0));
    for (let y = 0; y < CELL; y++)
      for (let x = 0; x < CELL; x++) {
        const o = ((r * CELL + y) * WIDTH + c * CELL + x) * 3;
        rgb[o] = lv[0];
        rgb[o + 1] = lv[1];
        rgb[o + 2] = lv[2];
      }
  });
  const file = path.join(sb.screenshots, `WoWScrnShot_010199_${String(n).padStart(6, '0')}.png`);
  fs.writeFileSync(SB.assertSafe(file), encodePng(WIDTH, HEIGHT, rgb));
  return file;
}

async function sendRecords(h, session, seqs, frameNo) {
  for (let i = 0; i < seqs.length; i += PER_FRAME) {
    const payload = seqs
      .slice(i, i + PER_FRAME)
      .map(seq => gsRecord(session, seq))
      .join('\x1E');
    const file = writeShot(h.sb, h.client, payload, frameNo++);
    await h.client.waitFor(() => !fs.existsSync(file), { timeoutMs: 20000, label: `the bridge to read ${path.basename(file)}` });
  }
  return frameNo;
}

test('300 gs records whose seqs overlap the message ids spend no ack or sig file, leave lastId alone, and a message sent between them is answered', async () => {
  await withGame({}, async h => {
    h.client.runLua('ClaudeWoWTelemetry.Take = function() return nil end');
    quietClient(h);
    const first = await h.client.say('before the telemetry');
    assert.match(first.text, /before the telemetry/);
    await h.bridge.waitForLine(/game context updated: Character: Testchar/);
    const tracker = addonRecordTracker(h);
    const issuedFrom = h.client.lastSeq() + 1;
    const logFrom = h.bridge.output.length;
    await settleAddonRecords(h, tracker);
    h.client.runLua('ClaudeWoW.Connect()');
    const session = h.client.db().session;
    const ackBefore = spentSlots(h.sb, 'ack');
    const sigBefore = spentSlots(h.sb, 'sig');
    const lastIdBefore = h.state().lastId;
    assert.ok(lastIdBefore < RECORDS, `message ids (${lastIdBefore}) sit inside the gs seq range, the case a shared id space would break`);

    const seqs = Array.from({ length: RECORDS }, (_, i) => i + 1);
    let frameNo = await sendRecords(h, session, seqs.slice(0, RECORDS / 2), 1);
    const between = await h.client.say('sent between the records');
    assert.match(between.text, /sent between the records/, 'the real message was not taken for a duplicate');
    assert.ok(between.id <= RECORDS / 2, `its id ${between.id} was already used as a gs seq`);
    frameNo = await sendRecords(h, session, seqs.slice(RECORDS / 2), frameNo);

    const snapFile = path.join(h.sb.home, 'goals', CHARACTER, TL.SNAPSHOT_FILE);
    const snap = await h.client.waitFor(
      () => {
        try {
          const s = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
          return s.seq === RECORDS ? s : null;
        } catch {
          return null;
        }
      },
      { timeoutMs: 20000, label: 'the snapshot at seq 300' },
    );
    assert.deepEqual(snap.sections.money.value, { copper: 1000 + RECORDS });
    assert.equal(snap.session, session);
    const events = fs
      .readFileSync(path.join(h.sb.home, 'goals', CHARACTER, TL.EVENTS_FILE), 'utf8')
      .trim()
      .split('\n');
    assert.equal(events.length, RECORDS - 1, 'one money event per record after the baseline');

    const slotB = ((between.id - 1) % SLOTS) + 1;
    await settleAddonRecords(h, tracker);
    const issuedTo = h.client.lastSeq();
    assertSpends(h, { session, before: ackBefore, kind: 'ack', messageId: between.id, issuedFrom, issuedTo, logFrom });
    const sigs = spentSlots(h.sb, 'sig').filter(s => !sigBefore.includes(s));
    for (const s of sigs.filter(x => x !== slotB))
      assert.ok(
        Array.from({ length: issuedTo - issuedFrom + 1 }, (_, k) => issuedFrom + k).some(id => id !== between.id && slotOfId(id) === s),
        `sig slot ${s} belongs to a record the addon itself sent`,
      );
    const state = h.state();
    assert.ok(
      state.lastId >= between.id && state.lastId <= issuedTo,
      `lastId ${state.lastId} is an id the addon sent (${issuedFrom}..${issuedTo}), never a gs seq up to ${RECORDS}`,
    );
    assert.ok(
      Object.keys(state.handled[session]).every(id => Number(id) <= issuedTo),
      'no gs seq in the message dedupe map',
    );
    assert.equal(h.agentCalls().length, 2, 'no gs record ever reached an agent');
    assert.doesNotMatch(h.bridge.output, /gs1/, 'no gs text was logged or run as a prompt');
    const published = new RegExp(
      `\\{ character = "${CHARACTER}", session = "${session}", seq = ${RECORDS}, hashes = \\{ money = "${String(RECORDS).padStart(8, '0')}" \\} \\}`,
    );
    await h.client.say('publish the slots');
    await h.client.waitFor(() => published.test(fs.readFileSync(path.join(h.sb.addons, 'ClaudeWoW_S001', 'Inbox.lua'), 'utf8')), {
      timeoutMs: 45000,
      label: 'the slot files to publish the gs hashes',
    });
  });
});

test('the real addon sends its game state on a telemetry-only screenshot once the bridge advertises gs, and the bridge keeps it', async () => {
  await withGame({}, async h => {
    await h.client.say('hello');
    const snapFile = path.join(h.sb.home, 'goals', CHARACTER, TL.SNAPSHOT_FILE);
    const snap = await h.client.waitFor(
      () => {
        try {
          const s = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
          return s.sections.level ? s : null;
        } catch {
          return null;
        }
      },
      { timeoutMs: 60000, label: 'the first gs record in snapshot.json' },
    );
    assert.equal(snap.session, h.client.db().session);
    assert.deepEqual(snap.sections.level.value, { level: 23, xp: 1234, xpMax: 5000 });
    assert.deepEqual(snap.sections.zone.value, { mapID: 1431 });
    assert.ok(Array.isArray(snap.sections.cap.value.missing));
    await h.bridge.waitForLine(/telemetry: Testchar-TestRealm's game client is missing /);
    assert.equal(h.agentCalls().length, 1);
  });
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
