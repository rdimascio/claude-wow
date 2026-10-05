'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('percharacter');
const withGame = gameRunner(ROOT);

const MAIN = 'Testchar-TestRealm';
const ALT = 'Helen-TestRealm';

test('a route from a run that ends after the player switched characters lands on the character that asked', async () => {
  await withGame({}, async h => {
    await h.client.say('hello');
    await h.bridge.waitForLine(/game context updated: Character: Testchar/);
    h.client.send('draw it [[sleep 4]] [[map skins]]');
    await h.bridge.waitForLine(/starting in/, { timeoutMs: 20000 });
    h.client.runLua('UnitName = function(unit) if unit == "player" then return "Helen" end end');
    h.client.runLua('ClaudeWoW.NewChat("alt")');
    await h.client.say('who am I now');
    await h.bridge.waitForLine(/game context updated: Character: Helen/);
    await h.client.waitFor(() => ((h.state().maps || {})[MAIN] || { layers: {} }).layers.skins, { timeoutMs: 30000, label: 'the route on the main' });
    const alt = (h.state().maps || {})[ALT];
    assert.ok(!alt || !alt.layers.skins, "the alt that was playing when the run ended never gets the main's route");
  });
});
