'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const P = require('../bridge/protocol');
const PL = require('../bridge/plugins');
const roast = require('../bridge/plugins/roast');
const stream = require('../bridge/plugins/stream');

const RECAP = [
  'Death recap: a level 23 Night Elf Hunter just died in Duskwood - Darkshire.',
  'Hits taken in the last 10 s, oldest first:',
  '-0.2s Hogger (level 11): Melee 52, overkill 17 <- killing blow',
  "Damage taken: 52 from 1 source. Killing blow: Hogger's Melee.",
].join('\n');

const noop = () => {};

function fakeCore(scratch) {
  const calls = [];
  const core = {
    log: noop,
    tag: j => '#' + j.id,
    defaultCwd: '/some/project',
    options: id => (id === 'roast' ? { cwd: scratch } : {}),
    sessionFolder: () => '',
    fail: (job, text) => calls.push({ fail: text }),
    runAgent: (job, opts) => calls.push({ run: opts, text: job.text }),
  };
  return { core, calls };
}

test('the roast plugin: the stable instructions are in the system prompt, the recap is wrapped as a roast request, and talk-back is not', () => {
  const reg = PL.createRegistry();
  const p = reg.register(roast);
  assert.deepEqual(p.surfaces, [], 'a roast never marks the map or makes macros');
  assert.ok(p.tools.includes('two or three sentences'));
  assert.ok(p.tools.includes('Punch at the play, never at the person'));
  assert.ok(p.tools.includes('No slurs'));
  assert.ok(p.tools.includes('Name only the mobs, abilities, zones and levels that appear in the recap, spelled exactly as they appear there.'));
  const system = P.systemPrompt('Location: Duskwood', '', { tools: p.tools });
  assert.ok(system.includes(roast.TOOLS), 'the roast rules ride in the stable system prompt');

  assert.equal(roast.isRoast({ kind: 'roast', text: 'x' }), true);
  assert.equal(roast.isRoast({ text: RECAP }), true, 'a resend without the kind flag is still a recap');
  assert.equal(roast.isRoast({ text: 'lol unfair' }), false);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-'));
  const scratch = path.join(base, 'scratch');
  const { core, calls } = fakeCore(scratch);
  p.handle({ id: 1, kind: 'roast', text: RECAP }, core);
  assert.equal(calls[0].run.cwd, scratch, 'runs in a scratch folder, never a project');
  assert.ok(fs.existsSync(scratch));
  assert.ok(calls[0].text.startsWith('I just died. Roast this death'), calls[0].text);
  assert.ok(calls[0].text.endsWith(RECAP));
  const prompt = P.messagePrompt(calls[0].text, 'Location: Duskwood', { image: { width: 1280, height: 720 } });
  assert.ok(prompt.includes("screenshot of the player's screen") && prompt.endsWith(RECAP), 'vision attaches the way it does for any message');

  p.handle({ id: 2, text: 'that was lag and you know it' }, core);
  assert.equal(calls[1].text, 'that was lag and you know it', 'talking back is passed through as is');

  fs.writeFileSync(path.join(base, 'file'), '');
  core.options = () => ({ cwd: path.join(base, 'file', 'sub') });
  p.handle({ id: 3, kind: 'roast', text: RECAP }, core);
  assert.match(calls[2].fail, /could not create/);
  assert.match(p.banner({ cwd: scratch }), /roast on/);
  fs.rmSync(base, { recursive: true, force: true });
});

const FIXTURES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'roast', 'recaps.json'), 'utf8'));
const DONE = { status: 'done', text: 'Hogger clawed you so hard the overkill has its own respawn timer.', summary: 'Hogger sends his regards.' };

function overlayServer() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
    });
    req.on('end', () => {
      bodies.push({ method: req.method, url: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Roast shown' }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, bodies, url: `http://127.0.0.1:${server.address().port}` })));
}

function overlayCore(streamOptions, scratch) {
  const logs = [];
  const core = {
    log: line => logs.push(line),
    tag: j => '#' + j.id,
    options: id => (id === 'stream' ? streamOptions : id === 'roast' ? { cwd: scratch } : {}),
    fail: () => {},
    runAgent: () => {},
  };
  return { core, logs };
}

test('roast overlay: every word of the line must be a number, a recap word or a plain word, so lowercase, hidden-character and title-case names are dropped', () => {
  const game = FIXTURES.gameRecap.recap;
  const line = summary => roast.overlayCommand(game, { status: 'done', text: 'Roast.', summary }).roast.text;
  assert.equal(line('hogger sends his regards.'), 'hogger sends his regards.', 'a recap name passes in any case');
  assert.equal(line('Duskwood ate you alive.'), 'Duskwood ate you alive.');
  assert.equal(line('hogger and van cleef send regards.'), undefined, 'a lowercase game name the recap does not have is dropped');
  assert.equal(line('next time, try orgrimmar.'), undefined);
  assert.equal(line('Hogger sends you to Under city.'), undefined, 'a place name spaced into two words is refused: "city" is not a plain word');
  assert.equal(line('Hogger taught you to run faster.'), 'Hogger taught you to run faster.', 'precondition: both words are plain');
  assert.equal(line('Hogger taught you to run​faster.'), undefined, 'a zero-width space is refused even between plain words');
  assert.equal(line('Hogger taught you to run⁠faster.'), undefined);
  assert.equal(line('Hogger says ‮ouch.'), undefined);
  assert.equal(line('ǅungeon time, Hogger.'), undefined, 'a title-case letter is not an escape hatch');
  assert.equal(line('Ｈｏｇｇｅｒ sends regards.'), 'Hogger sends regards.', 'fullwidth letters are NFKC-normalized before the check');
  assert.equal(line(`Hogger ${'ha '.repeat(120)}`), undefined, `longer than ${roast.ROAST_TEXT_MAX} characters`);
});

const ORDINARY_ROASTS = [
  DONE.text,
  'Hogger sends his regards.',
  'That fight ended before it even started.',
  'You saw the claw coming and still said yes.',
  'Kiting works better when you actually run away.',
  'Your guild will hear about this one.',
  'Twenty three levels of experience, zero levels of caution.',
  'Rend did the rest while you were busy losing.',
  'A level 11 bully just made a level 23 hero look silly.',
  'Next time, maybe bring a friend and a plan.',
  'Duskwood is spooky, but Hogger is scarier.',
  'Respect the claw. Always respect the claw.',
  'You lost to Hogger, which is honestly a rite of passage.',
  'Bold strategy: let the brute hit you first and hope he gets tired.',
  'That was not a pull, that was a donation.',
  'Your armor called in sick today.',
  'Somewhere, Hogger is telling this story at dinner.',
  'Pro tip: health bars go down faster when you stand still.',
  'The Night Elf Hunter forgot to bring a pet again.',
  'Absorbed 4, took 61, learned nothing.',
  'Even the healers in Darkshire saw that coming.',
  'You died doing what you loved: standing in the wrong place.',
  'Hogger did not even need the second hit.',
  'Imagine losing a staring contest to Hogger. Oh wait, you just did.',
  'That crit was personal.',
  'You pulled aggro and then pulled a disappearing act.',
  'Your corpse has seen more of Duskwood than you have.',
  'You attacked first, which was the problem.',
  'Hogger loves a good warm-up.',
  'She hit the ground and blamed herself, which is fair.',
  'Literally nobody saw that coming, except Hogger.',
  'Viewers are still laughing, haha.',
];

const fixtureData = () => require('../bridge/gamedata').openStore({ dataDir: path.join(__dirname, 'fixtures', 'wowdata'), clientBuild: '1.60.1.70124' });

test('roast overlay: a run of plain words that is a name in the synced data is refused, unless the recap has it; without data it is skipped and logged', async () => {
  const game = FIXTURES.gameRecap.recap;
  const outcome = summary => ({ status: 'done', text: 'Roast.', summary });
  const data = fixtureData();
  assert.deepEqual(roast.checkLine(game, outcome('Hogger sent you down the low road.'), data), {
    text: '',
    refused: 'game names not in the recap: low road (map)',
    phrasesNote: '',
  });
  assert.deepEqual(
    roast.checkLine(game, outcome('Hogger has quick hands.'), data).refused,
    'game names not in the recap: quick hands (spell taught by an item)',
    'a spell-book item name gives its spell as a phrase',
  );
  assert.equal(
    roast.checkLine(game, outcome('Hogger has quick feet.'), data).refused,
    'game names not in the recap: quick feet (spell taught by an item)',
    'a rune or tablet names its spell too',
  );
  assert.equal(
    roast.checkLine(game, outcome('Hogger made you see the stars.'), data).text,
    'Hogger made you see the stars.',
    'a rune or tablet remainder that starts with "the" is ordinary English',
  );
  assert.equal(
    roast.checkLine(game, outcome('Not your lucky day, Hogger won.'), data).text,
    'Not your lucky day, Hogger won.',
    'item names are not phrases: "Lucky Day" is an item in the fixture data',
  );
  assert.equal(
    roast.checkLine(game, outcome('That was a test run.'), data).text,
    'That was a test run.',
    'a junk row such as an area named "Test Run" is not indexed',
  );
  assert.equal(roast.checkLine(game, outcome('Hogger sent you down the low road.'), null).text, 'Hogger sent you down the low road.');
  assert.equal(
    roast.checkLine(game, outcome("Hogger's Rending Claw sends regards."), data).text,
    "Hogger's Rending Claw sends regards.",
    'the data has "Rending Claw", and so does the recap',
  );
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-phrase-'));
  try {
    const { core, logs } = overlayCore({ url: svc.url }, path.join(base, 'scratch'));
    const job = { id: 15, kind: 'roast', text: game };
    roast.handle(job, core);
    await roast.finished(job, outcome('Hogger sends his regards.'), core);
    assert.ok(
      logs.some(l =>
        l.endsWith(
          '#15 roast: No game data is synced for this build yet (claude-wow data sync). Multi-word game names were checked only against the short built-in list.',
        ),
      ),
      logs.join('\n'),
    );
    assert.ok(!logs.some(l => /try again|reference token/.test(l)), 'a log note carries no instructions meant for a refused text');
    core.gameData = () => data;
    const again = { id: 16, kind: 'roast', text: game };
    roast.handle(again, core);
    await roast.finished(again, outcome('Hogger sent you down the low road.'), core);
    assert.equal(svc.bodies[1].body.roast.text, undefined);
    assert.ok(
      logs.some(l => /#16 roast: line left off the card \(game names not in the recap: low road \(map\)\)/.test(l)),
      logs.join('\n'),
    );
  } finally {
    svc.server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

const IDIOM_ROASTS = [
  'Hot tip: do not do that again.',
  'Not used to losing, are you?',
  'That was the big one.',
  'That clip is pure gold.',
  'You forgot your lucky charm at home.',
  'Keep a close eye on Hogger next time.',
  'A bag of gold would not save you.',
  'Hogger got the last laugh.',
  'Better luck next time.',
  'Back to the start for you.',
  'Hogger called your bluff.',
  'Easy come, easy go.',
  'No pain, no gain.',
  'Time to hit the road.',
  'Hogger had the upper hand.',
  'That plan went up in smoke.',
  'Rest in pieces.',
  'You were in over your head.',
  'Not your lucky day, Hogger won.',
  'Mind the gap next time.',
  'You picked the wrong fight.',
  'That was a long day at work.',
];

function realDataStores() {
  const homeDir = process.env.CLAUDE_WOW_HOME;
  if (!homeDir) return [];
  const GDm = require('../bridge/gamedata');
  const dataDir = path.join(homeDir, 'data');
  return Object.keys(require('../bridge/datasync').FLAVORS)
    .map(flavor => GDm.openStore({ dataDir, flavor }))
    .filter(probe => probe.build)
    .map(probe => GDm.openStore({ dataDir, clientBuild: probe.build }));
}

const REAL_DATA = realDataStores();
if (!REAL_DATA.length)
  test('real synced data (opt-in, CLAUDE_WOW_HOME with data)', { skip: 'set CLAUDE_WOW_HOME to a home with synced data to run this' }, () => {});
for (const data of REAL_DATA) {
  test(`real synced ${data.flavor} data ${data.build}: ordinary and idiom roast lines show, known game phrases are refused`, () => {
    assert.equal(data.rowTrust, 'client-data');
    const game = FIXTURES.gameRecap.recap;
    const check = summary => roast.checkLine(game, { status: 'done', text: 'Roast.', summary }, data);
    const dropped = [...ORDINARY_ROASTS, ...IDIOM_ROASTS].filter(line => check(line).text !== line).map(line => `${line} -> ${check(line).refused}`);
    assert.deepEqual(dropped, [], dropped.join('\n'));
    for (const line of [
      'Next time, go to old town.',
      'You needed the mark of the wild.',
      'A gift of the wild would help.',
      'What a gold mine of a clip.',
      'Should have used chain heal.',
      'No victory rush for you.',
      'Try water walking next time.',
      'That was a raging blow.',
      'No healing rain could save you.',
      'Far sight would have helped.',
    ]) {
      assert.equal(check(line).text, '', line);
    }
    assert.equal(check('Hogger sends his regards.').phrasesNote, '', 'the real data indexed cleanly');
  });
}

test('roast overlay: talking back in the roast chat never reaches the card, even when it names places', async () => {
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-talkback-'));
  try {
    const { core } = overlayCore({ url: svc.url }, path.join(base, 'scratch'));
    const talk = { id: 13, kind: 'roast', text: 'tell me about Silverpine and Thrall' };
    roast.handle(talk, core);
    assert.equal(talk.recap, undefined, 'a typed line is not a recap, so it never becomes the name list');
    assert.equal(talk.text, 'tell me about Silverpine and Thrall', 'passed through as is');
    assert.equal(await roast.finished(talk, { status: 'done', text: 'Sure.', summary: 'Silverpine and Thrall send regards.' }, core), null);
    assert.equal(svc.bodies.length, 0, 'no card');
    const death = { id: 14, kind: 'roast', text: FIXTURES.gameRecap.recap };
    roast.handle(death, core);
    await roast.finished(death, DONE, core);
    assert.equal(svc.bodies.length, 1, 'precondition: a real recap in the same chat does send a card');
  } finally {
    svc.server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('roast overlay: the text is the TL;DR line, else the reply, without bridge notes either way, and never a bridge placeholder', () => {
  const recap = FIXTURES.gameRecap.recap;
  const line = outcome => roast.overlayCommand(recap, { status: 'done', ...outcome }).roast.text;
  assert.equal(line({ text: 'Hogger wins again.\n\n[bridge] a note', summary: '' }), 'Hogger wins again.');
  assert.equal(line({ text: 'Long roast.\n\nTL;DR: Hogger wins.\n\n[bridge] a note', summary: 'Hogger wins.\n\n[bridge] a note' }), 'Hogger wins.');
  assert.equal(line({ text: '[bridge] some map marks were left out.', summary: '' }), undefined);
  assert.equal(line({ text: '(Claude finished without a reply)', summary: '' }), undefined);
  assert.equal(line({ text: '', summary: '' }), undefined);
  assert.equal(roast.overlayCommand(recap, { status: 'error', text: 'Claude exited with code 1', summary: '' }).roast.text, undefined);
});

test('roast overlay: a placeholder zone, a cut recap and a killing blow the summary does not confirm give no names', () => {
  const unmapped = FIXTURES.unitCombatOnly.recap.replace('Duskwood - Darkshire', 'somewhere unmapped');
  assert.equal(roast.recapFacts(unmapped).zone, undefined);
  const lines = FIXTURES.gameRecap.recap.split('\n');
  const cut = lines.slice(0, -1).join('\n');
  assert.deepEqual(roast.recapFacts(cut), { zone: 'Duskwood - Darkshire' }, 'the summary line fell off the 900-byte cap');
  const forged = lines.map(l => l.replace("Killing blow: Hogger's Rending Claw.", "Killing blow: Hogger's Melee.")).join('\n');
  assert.deepEqual(roast.recapFacts(forged), { zone: 'Duskwood - Darkshire' });
  const unseen = FIXTURES.gameRecap.recap
    .replace(/Hogger \(level 11\): Rending Claw/, 'something unseen: an attack')
    .replace("Hogger's Rending Claw", "something unseen's an attack");
  assert.deepEqual(roast.recapFacts(unseen), { zone: 'Duskwood - Darkshire', overkill: 23 });
});

test('roast overlay: a finished roast POSTs one roast action to the stream url, reusing the stream plugin options', async () => {
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-overlay-'));
  try {
    const p = PL.createRegistry().register(roast);
    assert.equal(typeof p.finished, 'function', 'the registry keeps the finished hook');
    const { core, logs } = overlayCore({ url: svc.url + '/' }, path.join(base, 'scratch'));
    const job = { id: 5, kind: 'roast', text: FIXTURES.gameRecap.recap };
    p.handle(job, core);
    const result = await p.finished(job, DONE, core);
    assert.equal(result.ok, true);
    assert.deepEqual(svc.bodies, [{ method: 'POST', url: '/control', body: roast.overlayCommand(FIXTURES.gameRecap.recap, DONE) }]);
    assert.ok(
      logs.some(l => /#5 roast: overlay -> 200 Roast shown/.test(l)),
      logs.join('\n'),
    );

    for (const failed of [
      { status: 'error', text: 'Cancelled from the game.', summary: '' },
      { status: 'error', text: 'Claude exited with code 1 and no result.' },
      undefined,
    ]) {
      const retried = { id: 9, kind: 'roast', text: FIXTURES.gameRecap.recap };
      p.handle(retried, core);
      assert.equal(await p.finished(retried, failed, core), null);
    }
    assert.equal(svc.bodies.length, 1, 'a failed, cancelled or timed-out roast is not a death on the overlay: the retry is');
    assert.ok(
      logs.some(l => /#9 roast: overlay not told, the run ended with error/.test(l)),
      logs.join('\n'),
    );

    const talkBack = { id: 6, text: 'that was lag and you know it' };
    p.handle(talkBack, core);
    assert.equal(await p.finished(talkBack, DONE, core), null);
    assert.equal(svc.bodies.length, 1, 'talking back in the roast chat is not a death');
  } finally {
    svc.server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('roast overlay: plugins.stream.enabled false (and the sandbox options) send nothing; a service that is down is only logged', async () => {
  const svc = await overlayServer();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-overlay-'));
  try {
    for (const options of [{ enabled: false, url: svc.url }, { ...stream.INERT_OPTIONS }]) {
      const { core, logs } = overlayCore(options, path.join(base, 'scratch'));
      const job = { id: 7, kind: 'roast', text: FIXTURES.gameRecap.recap };
      roast.handle(job, core);
      assert.equal(await roast.finished(job, DONE, core), null);
      assert.ok(
        logs.some(l => /plugins\.stream\.enabled is false/.test(l)),
        logs.join('\n'),
      );
    }
    assert.equal(svc.bodies.length, 0, 'no request reaches the service');
  } finally {
    svc.server.close();
  }
  const port = await new Promise(resolve => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const { core, logs } = overlayCore({ url: `http://127.0.0.1:${port}` }, path.join(base, 'scratch'));
  const job = { id: 8, kind: 'roast', text: FIXTURES.gameRecap.recap };
  roast.handle(job, core);
  assert.equal(await roast.finished(job, DONE, core), null);
  assert.ok(
    logs.some(l => /overlay at http:\/\/127\.0\.0\.1:\d+ not reached/.test(l)),
    logs.join('\n'),
  );
  fs.rmSync(base, { recursive: true, force: true });
});

test(
  'roast overlay: a bridge that exits when idle (--inject) skips the hook and says so, instead of racing its own exit',
  { skip: process.platform === 'win32' && 'a .js agent path' },
  async () => {
    const svc = await overlayServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowai-roast-inject-'));
    try {
      const home = path.join(dir, 'home');
      const addons = path.join(dir, 'client', 'Interface', 'AddOns');
      for (const d of ['sig', 'ack', 'act', 'presence']) fs.mkdirSync(path.join(addons, 'ClaudeWoW_Runtime', d), { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      const agent = path.join(dir, 'fake-claude.js');
      const result = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Hogger again.\n\nTL;DR: Hogger sends his regards.',
        session_id: 'roast-inject',
      };
      fs.writeFileSync(
        agent,
        `process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(JSON.stringify(result) + '\n')}); });`,
      );
      fs.writeFileSync(
        path.join(home, 'config.json'),
        JSON.stringify({
          addonDir: addons,
          savedVariablesFile: path.join(dir, 'ClaudeWoW.lua'),
          inboxFile: path.join(addons, 'ClaudeWoW_Runtime', 'Inbox.lua'),
          defaultCwd: dir,
          slots: 1,
          agent: 'claude',
          agents: { claude: { path: agent } },
          titleModel: false,
          plugins: { default: 'roast', roast: { cwd: path.join(dir, 'scratch') }, stream: { url: svc.url } },
          gameContext: false,
          primerFile: '',
          capture: { enabled: false },
          timeoutMs: 60000,
        }),
      );
      const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'bridge', 'bridge.js'), '--inject', FIXTURES.gameRecap.recap, '--plugin', 'roast'], {
        env: { ...process.env, CLAUDE_WOW_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      bridge.stdout.on('data', d => {
        out += d;
      });
      bridge.stderr.on('data', d => {
        out += d;
      });
      const code = await new Promise(resolve => bridge.on('exit', resolve));
      assert.equal(code, 0, out);
      assert.match(out, /roast: finished hook skipped, this bridge exits when idle/, out);
      assert.equal(svc.bodies.length, 0, 'no half-sent roast');
    } finally {
      svc.server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
