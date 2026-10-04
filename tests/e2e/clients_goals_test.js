'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRoot, gameRunner, ERA, TWO_CLIENTS: TWO, withEra } = require('./helpers');

const ROOT = makeRoot('clients-goals');
const withGame = gameRunner(ROOT);

async function askFromA(h, era, text) {
  era.slash('/claude config context on');
  await era.say(`warm up before ${text}`);
  await h.client.say(`@ask ${text}`);
  const out = h.bridge.output;
  const start = out.lastIndexOf('[ask] Claude starting');
  assert.ok(start > 0, 'the ask run started');
  const before = out.slice(0, start);
  const lastContext = /\((_classic_\w+_)\) game context updated[^\n]*\n(?![\s\S]*game context updated)/.exec(before);
  assert.ok(lastContext, 'both clients reported a context before the run');
  const startLine = out.slice(start, out.indexOf('\n', start));
  const between = before.slice(lastContext.index);
  return { lastFrom: lastContext[1], granted: startLine.includes('[wowgoals for this run]'), refusal: /wowgoals: another client reported its game context after this one \(([^)]*)\)/.exec(between) };
}

for (const [name, afterAddonLoad, theirs] of [
  ['another character', 'UnitName = function(unit) if unit == "player" then return "Erachar" end end', 'Erachar-TestRealm in _classic_era_'],
  ['a character with the same name and realm', '', 'Testchar-TestRealm in _classic_era_'],
]) {
  test(`an ask run from client A gets goal tools only when A reported last, also when B reported ${name}`, async () => {
    await withGame(TWO, async h => {
      await h.client.connect();
      await withEra(h, async era => {
        await era.connect();
        const r = await askFromA(h, era, `goal check ${name}`);
        if (r.lastFrom === ERA) {
          assert.equal(r.granted, false, 'B reported last, so A\'s run has no goal server');
          assert.ok(r.refusal, 'and the bridge says why');
          assert.equal(r.refusal[1], theirs);
        } else {
          assert.equal(r.lastFrom, '_classic_beta_');
          assert.equal(r.granted, true, 'A reported last, so A\'s run keeps its goal tools');
          assert.equal(r.refusal, null);
        }
      }, afterAddonLoad ? { afterAddonLoad } : {});
    });
  });
}
