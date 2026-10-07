'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeRoot, gameRunner, sentId } = require('./helpers');

const ROOT = makeRoot('devtools');
const withGame = gameRunner(ROOT);

function gitProject(sb) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: sb.project,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'first commit');
  fs.writeFileSync(path.join(sb.project, 'README.md'), '# sandbox project\nchanged\n');
}

function answerTo(h, id, label) {
  return h.client.waitFor(
    () => {
      const c = h.client.activeChat();
      return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role !== 'user');
    },
    { timeoutMs: 60000, label },
  );
}

async function slash(h, line) {
  h.client.slash(line);
  return answerTo(h, sentId(h.client), line);
}

async function say(h, text) {
  h.client.slash(`/claude -c ${text}`);
  return answerTo(h, sentId(h.client), text);
}

test('/claude dev status, diff and run answer from the bridge without an agent run, and the next message carries the output', async () => {
  await withGame({ beforeLaunch: gitProject }, async h => {
    await h.client.connect();
    const help = await slash(h, '/claude dev');
    assert.match(help.text, /Dev tools for the folder of this chat/);
    assert.equal(h.agentCalls().length, 0, 'no agent run for a dev command');

    const status = await slash(h, '/claude dev status');
    assert.match(status.text, /^project: branch main/);
    assert.match(status.text, /1 changed file/);
    assert.match(status.text, /first commit/);

    const diff = await slash(h, '/claude dev diff');
    assert.match(diff.text, /\+changed/);

    const reply = await say(h, 'what changed?');
    assert.match(reply.text, /what changed/);
    const call = h.agentCalls().at(-1);
    assert.match(call.prompt, /\[Output of "\/claude dev diff" that the player ran in this chat just before this message\]/);
    assert.equal(h.agentCalls().length, 1);

    const again = await say(h, 'and now?');
    assert.match(again.text, /and now/);
    assert.doesNotMatch(h.agentCalls().at(-1).prompt, /Output of "\/claude dev/, 'the note goes with one message only');

    const run = await slash(h, '/claude dev run');
    assert.match(run.text, /^claude/);
    assert.match(run.text, /done, exit 0/);
    assert.match(run.text, /claude --resume /);
  });
});

test('/claude wrong files the last agent reply in feedback.jsonl, and /claude dev feedback lists it', async () => {
  await withGame({}, async h => {
    await h.client.connect();
    const reply = await say(h, 'how do I tame a bear');
    assert.match(reply.text, /tame a bear/);
    const marked = await slash(h, '/claude wrong that is a hunter quest');
    assert.match(marked.text, /^Marked as wrong: #1\./);
    const items = fs
      .readFileSync(path.join(h.sb.home, 'feedback.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l));
    assert.equal(items.length, 1);
    assert.equal(items[0].note, 'that is a hunter quest');
    assert.match(items[0].prompt, /how do I tame a bear/);
    assert.equal(items[0].reply, reply.text);
    const list = await slash(h, '/claude dev feedback');
    assert.match(list.text, /^1 open item:\n#1 wrong/);
  });
});

const SS = require('../../bridge/sessions');
const OLD = 'f02436b8-8a5f-4c05-823e-bef25f88ff7b';

function seedSession(sb) {
  const dir = path.join(sb.user, '.claude', 'projects', SS.projectSlug(sb.project));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${OLD}.jsonl`),
    [
      { type: 'user', cwd: sb.project, sessionId: OLD },
      { type: 'ai-title', aiTitle: 'Fix the build', sessionId: OLD },
    ]
      .map(l => JSON.stringify(l))
      .join('\n') + '\n',
  );
  fs.writeFileSync(path.join(sb.agentState, `${OLD}.json`), JSON.stringify({ id: OLD, turns: 4, total: {}, created: Date.now() - 3600000 }));
}

test('a dev command in a chat attached with /claude -r leaves the session to resume with the next message', async () => {
  await withGame({ beforeLaunch: seedSession }, async h => {
    await h.client.connect();
    h.client.slash(`/claude -r ${OLD}`);
    await h.client.waitFor(() => (h.client.activeChat() || {}).resumeId === OLD, { label: 'the chat to attach' });
    const status = await slash(h, '/claude dev run');
    assert.match(status.text, /No agent run in this chat/);
    assert.equal(h.client.activeChat().resumeId, OLD, 'the dev reply keeps the resume id');
    const typed = await say(h, '@dev run');
    assert.match(typed.text, /No agent run in this chat/);
    const chatId = h.client.activeChat().id;
    assert.equal(h.state().sessions[`chat:${chatId}`], undefined, 'a typed @dev with resume= adopts nothing for the dev plugin');
    assert.equal(SS.sessionPluginOf(h.state(), OLD), '', 'and records no plugin for the session');
    const reply = await say(h, 'carry on');
    assert.match(reply.text, /carry on/);
    const call = h.agentCalls().at(-1);
    assert.equal(call.argv[call.argv.indexOf('--resume') + 1], OLD);
  });
});

test('/claude cancel ends a long dev test and frees the chat', async () => {
  const slow = ['node', '-e', 'setTimeout(() => {}, 120000)'];
  await withGame({ config: { plugins: { dev: { testCommand: slow } } } }, async h => {
    await h.client.connect();
    h.client.slash('/claude dev test');
    const id = sentId(h.client);
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ dev test starting in `));
    await new Promise(r => setTimeout(r, 1500));
    h.client.slash('/claude cancel');
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ cancelled from the game; ending it`));
    await h.bridge.waitForLine(new RegExp(`#${id}@\\S+ error`));
    const reply = await say(h, 'after the cancel');
    assert.match(reply.text, /after the cancel/);
    assert.doesNotMatch(h.agentCalls().at(-1).prompt, /Output of "\/claude dev/);
  });
});
