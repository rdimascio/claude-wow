'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('devtools');
const withGame = gameRunner(ROOT);

function gitProject(sb) {
  const git = (...args) => execFileSync('git', args, { cwd: sb.project, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'first commit');
  fs.writeFileSync(path.join(sb.project, 'README.md'), '# sandbox project\nchanged\n');
}

function answerTo(h, id, label) {
  return h.client.waitFor(() => {
    const c = h.client.activeChat();
    return c && !c.pendingId && (c.history || []).find(m => m.id === id && m.role !== 'user');
  }, { timeoutMs: 60000, label });
}

async function slash(h, line) {
  const id = h.client.lastSeq() + 1;
  h.client.slash(line);
  return answerTo(h, id, line);
}

async function say(h, text) {
  const id = h.client.lastSeq() + 1;
  h.client.slash(`/claude -c ${text}`);
  return answerTo(h, id, text);
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
    const items = fs.readFileSync(path.join(h.sb.home, 'feedback.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(items.length, 1);
    assert.equal(items[0].note, 'that is a hunter quest');
    assert.match(items[0].prompt, /how do I tame a bear/);
    assert.equal(items[0].reply, reply.text);
    const list = await slash(h, '/claude dev feedback');
    assert.match(list.text, /^1 open item:\n#1 wrong/);
  });
});
