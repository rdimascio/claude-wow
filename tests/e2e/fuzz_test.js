'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRoot, gameRunner, replyTo } = require('./helpers');

const ROOT = makeRoot('fuzz');
const withGame = gameRunner(ROOT);
const SEED = (Number(process.env.CLAUDE_WOW_FUZZ_SEED) || Date.now() ^ (process.pid << 8)) >>> 0;
const EPISODES = Number(process.env.CLAUDE_WOW_FUZZ_EPISODES) || 8;

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['loot', 'quest', 'Hogger', 'Elwynn', 'mana', 'aggro', 'wipe', 'pull', 'zug', 'gg', 'lfg', 'brb'];
const ODD = ['|', '||', '\\', '"', "'", '%', '%s', '$', '{', '}', '<', '>', '&', '`', 'é', 'ñ', 'ü', '…', '—', '日本', 'Ж', '😀', '\t', '  '];

function fuzzer(seed) {
  const rand = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = list => list[int(0, list.length - 1)];
  const chance = p => rand() < p;
  const text = () => {
    const parts = [];
    for (let i = int(0, 30); i > 0; i--) parts.push(chance(0.3) ? pick(ODD) : pick(WORDS));
    return parts.join(chance(0.5) ? ' ' : '');
  };
  return { int, pick, chance, text };
}

function episodePlan(f, n) {
  const nonce = `n${n}x${f.int(1000, 9999)}`;
  const kind = f.pick(['plain', 'plain', 'plain', 'directives', 'directives', 'error', 'rate-limit']);
  let body = `${nonce} ${f.text()}`.slice(0, 220);
  if (kind === 'directives') {
    const d = [];
    if (f.chance(0.6)) d.push(`[[sleep ${(f.int(1, 15) / 10).toFixed(1)}]]`);
    if (f.chance(0.5)) d.push(`[[tools ${f.int(1, 3)}]]`);
    if (f.chance(0.3)) d.push(`[[think ${f.pick(WORDS)}]]`);
    if (f.chance(0.3)) d.push(`[[long ${f.int(10, 150)}]]`);
    body = `${d.join(' ')} ${body}`;
  }
  if (kind === 'error') body = `[[error E${nonce}]] ${body}`;
  if (kind === 'rate-limit') body = `[[rate-limit]] ${body}`;
  return {
    nonce, kind, body,
    newChat: f.chance(0.15),
    restartBefore: n > 0 && f.chance(0.1),
    reloadDuring: f.chance(0.2),
    moveDuring: f.chance(0.25),
    combatDuring: f.chance(0.2),
  };
}

test(`seeded fuzz: random messages, directives, reloads, restarts and combat each end in exactly one reply (CLAUDE_WOW_FUZZ_SEED=${SEED})`, async () => {
  const f = fuzzer(SEED);
  const plans = Array.from({ length: EPISODES }, (_, n) => episodePlan(f, n));
  const reloadAt = f.int(0, EPISODES - 1);
  plans[reloadAt].reloadDuring = true;
  if (EPISODES > 1) plans[f.int(1, EPISODES - 1)].restartBefore = true;
  const log = [];
  try {
    await withGame({}, async h => {
      const sent = [];
      let lastRestart = 0;
      for (const p of plans) {
        log.push(JSON.stringify(p));
        if (p.restartBefore) {
          await h.bridge.restart();
          lastRestart = Date.now();
        }
        await h.client.connect();
        if (p.newChat) h.client.runLua(`ClaudeWoW.NewChat("Fuzz ${p.nonce}")`);
        const id = h.client.lastSeq() + 1;
        h.client.send(p.body);
        sent.push({ id, chat: h.client.activeChat().id, plan: p });
        if (p.moveDuring) h.client.move(true);
        if (p.combatDuring) h.client.combat(true);
        if (p.reloadDuring) h.client.reload();
        if (p.moveDuring) h.client.move(false);
        if (p.combatDuring) h.client.combat(false);
        const reply = await h.client.waitFor(() => replyTo(h, id), { timeoutMs: 45000, label: `the reply to #${id} (${p.kind})` });
        if (p.kind === 'plain' || p.kind === 'directives') {
          assert.equal(reply.role, 'assistant', `#${id} ${p.kind}`);
          assert.ok(reply.text.includes(p.nonce), `#${id} echoes ${p.nonce}: ${reply.text.slice(0, 200)}`);
        } else {
          assert.equal(reply.role, 'system', `#${id} ${p.kind}`);
        }
      }
      const chats = h.client.db().chats;
      const used = new Set(sent.map(s => s.chat));
      for (const c of chats.filter(c => used.has(c.id))) assert.ok(!c.pendingId, `chat ${c.id} holds no pending message`);
      for (const s of sent) {
        const chat = chats.find(c => c.id === s.chat);
        const answers = (chat.history || []).filter(m => m.id === s.id && m.role !== 'user');
        assert.equal(answers.length, 1, `#${s.id} has exactly one answer`);
      }
      const fresh = () => h.screenshots().filter(n => fs.statSync(path.join(h.sb.screenshots, n)).mtimeMs >= lastRestart);
      const settleBy = Date.now() + 5000;
      while (fresh().length && Date.now() < settleBy) await new Promise(r => setTimeout(r, 100));
      assert.deepEqual(fresh(), [], 'no strip screenshot taken while the bridge ran is left behind');
    });
  } catch (e) {
    const replay = `\nreplay: CLAUDE_WOW_FUZZ_SEED=${SEED} CLAUDE_WOW_FUZZ_EPISODES=${EPISODES} node --test tests/e2e/fuzz_test.js\nepisodes:\n${log.join('\n')}`;
    e.message += replay;
    if (typeof e.stack === 'string') e.stack += replay;
    throw e;
  }
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
