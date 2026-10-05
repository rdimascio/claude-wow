'use strict';
const test = require('node:test');
const { makeRoot, gameRunner, TWO_CLIENTS: TWO, withEra, askFromA, assertGoalToolsFollowLastReport } = require('./helpers');

const ROOT = makeRoot('clients-goals-2');
const withGame = gameRunner(ROOT);

test('an ask run from client A gets goal tools only when A reported last, also when B reported a character with the same name and realm', async () => {
  await withGame(TWO, async h => {
    await h.client.connect();
    await withEra(h, async era => {
      await era.connect();
      const r = await askFromA(h, era, 'goal check a character with the same name and realm');
      assertGoalToolsFollowLastReport(r, 'Testchar-TestRealm in _classic_era_');
    });
  });
});
