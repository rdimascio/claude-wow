// One GitHub repository name: bridge/repo.js REPO. Self-update, the
// installers, package.json and the Homebrew formula use it, and no shipped file
// names the project under another owner or name (wow-ai, a stale owner).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { REPO, REPO_URL, API_URL } = require('../bridge/repo');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const [OWNER, NAME] = REPO.split('/');
const PROJECT_NAMES = ['wowgpt', 'claude-wow', 'wow-ai', 'wow-claude'];
// The repository this project was forked from: the CHANGELOG's old compare links point there.
const UPSTREAM = 'chelinho139/wow-ai';
const TAP_REPO = `${OWNER}/homebrew-${NAME}`;
const REFERENCE =
  /(?:github\.com[/:]|githubusercontent\.com\/|api\.github\.com\/repos\/|brew (?:tap|install)(?: --HEAD)? )([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;
const SKIPPED = [/^tests\//, /^package-lock\.json$/, /\.(png|jpg|tga|blp)$/i];

function shippedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(f => f && !SKIPPED.some(re => re.test(f)) && fs.existsSync(path.join(ROOT, f)));
}

function projectReferences(text) {
  const found = [];
  for (const m of text.matchAll(REFERENCE)) {
    const owner = m[1];
    const name = m[2].replace(/\.git$/, '');
    if (owner === OWNER || PROJECT_NAMES.includes(name.toLowerCase())) found.push(`${owner}/${name}`);
  }
  return found;
}

test('REPO is owner/name and the URLs derive from it', () => {
  assert.match(REPO, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.equal(REPO_URL, `https://github.com/${REPO}`);
  assert.equal(API_URL, `https://api.github.com/repos/${REPO}`);
});

test('self-update, the installers, package.json and the formula use REPO', () => {
  assert.equal(require('../bridge/selfupdate').DEFAULT_API, API_URL);
  assert.equal(require('../package.json').repository.url, REPO_URL);
  const sh = read('install.sh');
  assert.equal(/^REPO=(.*)$/m.exec(sh)[1], REPO, 'install.sh REPO=');
  assert.match(sh, /^REPO_URL=\$\{WOWGPT_REPO:-\$\{CLAUDE_WOW_REPO:-https:\/\/github\.com\/\$REPO\}\}$/m, 'install.sh derives REPO_URL from REPO');
  const ps = read('install.ps1');
  const psDefaults = ps.split('\n').filter(l => !l.startsWith('#') && /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(l));
  assert.equal(psDefaults.length, 1, `install.ps1 names the repository on one line:\n${psDefaults.join('\n')}`);
  assert.ok(psDefaults[0].includes(`'${REPO_URL}'`), psDefaults[0]);
  const rb = read('homebrew/Formula/wowgpt.rb');
  assert.match(rb, new RegExp(`^  homepage "${REPO_URL}"$`, 'm'));
  assert.match(rb, new RegExp(`url "${REPO_URL}\\.git", branch: "main"`));
  assert.equal(rb.match(new RegExp(`url "${REPO_URL}/releases/download/v#\\{version\\}/wowgpt-darwin-`, 'g')).length, 2);
});

test('no shipped file names the project under another GitHub owner or name', () => {
  const allowed = new Set([REPO, TAP_REPO]);
  const wrong = [];
  for (const file of shippedFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const ref of projectReferences(line)) {
        const upstreamHistory = ref === UPSTREAM && file === 'CHANGELOG.md';
        if (!allowed.has(ref) && !upstreamHistory) wrong.push(`${file}:${i + 1}: ${ref}`);
      }
    });
  }
  assert.deepEqual(wrong, [], `these lines name another repository than ${REPO}:\n${wrong.join('\n')}`);
});

test('the scan catches an old name, a stale owner and a tap shorthand', () => {
  assert.deepEqual(projectReferences('https://api.github.com/repos/rdimascio/wow-ai/releases'), ['rdimascio/wow-ai']);
  assert.deepEqual(projectReferences('git clone https://github.com/someone/wowgpt.git'), ['someone/wowgpt']);
  assert.deepEqual(projectReferences('brew install rdimascio/wow-ai/wowgpt'), ['rdimascio/wow-ai']);
  assert.deepEqual(projectReferences('https://github.com/shagu/pfQuest'), []);
});
