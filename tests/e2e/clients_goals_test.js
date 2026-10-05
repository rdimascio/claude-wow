'use strict';
const test = require('node:test');
const { makeRoot, gameRunner, TWO_CLIENTS: TWO, withEra, askFromA, assertGoalToolsFollowLastReport } = require('./helpers');

const ROOT = makeRoot('clients-goals');
const withGame = gameRunner(ROOT);

test('an ask run from client A gets goal tools only when A reported last, also when B reported another character', async () => {
  await withGame(TWO, async h => {
    await h.client.connect();
    await withEra(h, async era => {
      await era.connect();
      const r = await askFromA(h, era, 'goal check another character');
      assertGoalToolsFollowLastReport(r, 'Erachar-TestRealm in _classic_era_');
    }, { afterAddonLoad: 'UnitName = function(unit) if unit == "player" then return "Erachar" end end' });
  });
});
