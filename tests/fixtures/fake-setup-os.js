'use strict';
// Preloaded into a setup.js child by tests/setup_test.js: the two places setup
// reaches the operating system beyond files. Whether a game client runs comes
// from WOWGPT_FAKE_CLIENT_STATE (running, unknown or closed), and the service
// backend only appends what it was asked to do to WOWGPT_FAKE_SERVICE_LOG, so
// no test reaches launchctl, systemctl or the Startup folder.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const CP = require(path.join(root, 'bridge', 'clientproc'));
const SVC = require(path.join(root, 'bridge', 'service'));

const STATES = {
  running: { running: true, why: 'the game is running' },
  unknown: { running: null, why: 'the process list failed (fake)' },
  closed: { running: false, why: 'the game is closed' },
};
const want = process.env.WOWGPT_FAKE_CLIENT_STATE || 'closed';
CP.clientState = async folder => {
  fs.appendFileSync(process.env.WOWGPT_FAKE_SERVICE_LOG, `clientState ${folder}\n`);
  return STATES[want];
};

SVC.backend = () => ({
  kind: 'fake service',
  install: d => fs.appendFileSync(process.env.WOWGPT_FAKE_SERVICE_LOG, `install ${d.definition}\n`),
  probe: () => ({ loaded: true, pid: 0, state: 'running' }),
});
