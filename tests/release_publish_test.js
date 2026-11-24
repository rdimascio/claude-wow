// The release workflow's publishing jobs after the GitHub release: the
// Homebrew tap (dev/brew-formula.js fills the formula) and npm.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BF = require('../dev/brew-formula');

const ROOT = path.join(__dirname, '..');
const FORMULA = path.join(ROOT, 'homebrew', 'Formula', 'wowgpt.rb');
const ARM = 'a'.repeat(64);
const X64 = 'b'.repeat(64);
const SUMS = `${ARM}  wowgpt-darwin-arm64\n${X64}  wowgpt-darwin-x64\n${'c'.repeat(64)}  wowgpt-linux-x64\n${'d'.repeat(64)}  wowgpt-windows-x64.exe\n`;

function releaseJob(name) {
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm').exec(text);
  assert.ok(m, `job ${name}`);
  return m[1];
}

test('fillFormula writes the version and each darwin sum on its own marked line', () => {
  const filled = BF.fillFormula(fs.readFileSync(FORMULA, 'utf8'), SUMS, '1.2.3');
  assert.match(filled, /^ {2}version "1\.2\.3"$/m);
  assert.match(filled, new RegExp(`sha256 "${ARM}" # wowgpt-darwin-arm64 in SHA256SUMS`));
  assert.match(filled, new RegExp(`sha256 "${X64}" # wowgpt-darwin-x64 in SHA256SUMS`));
  assert.ok(!filled.includes('0'.repeat(64)));
});

test('fillFormula refuses a missing sum, a bad version or a formula without the marked lines', () => {
  const formula = fs.readFileSync(FORMULA, 'utf8');
  assert.throws(() => BF.fillFormula(formula, `${ARM}  wowgpt-darwin-arm64\n`, '1.2.3'), /no sum for wowgpt-darwin-x64/);
  assert.throws(
    () => BF.fillFormula(formula, `${'0'.repeat(64)}  wowgpt-darwin-arm64\n${X64}  wowgpt-darwin-x64\n`, '1.2.3'),
    /no sum for wowgpt-darwin-arm64/,
  );
  assert.throws(() => BF.fillFormula(formula, SUMS, 'v1.2.3'), /not a release version/);
  assert.throws(() => BF.fillFormula(formula.replace(/ # wowgpt-darwin-x64 in SHA256SUMS/, ''), SUMS, '1.2.3'), /no sha256 line marked wowgpt-darwin-x64/);
});

test('the brew-formula command rewrites the file and fails without writing on a bad input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wowgpt-brew-'));
  try {
    const rb = path.join(dir, 'wowgpt.rb');
    const sums = path.join(dir, 'SHA256SUMS');
    fs.copyFileSync(FORMULA, rb);
    fs.writeFileSync(sums, `${ARM}  wowgpt-darwin-arm64\n`);
    const before = fs.readFileSync(rb, 'utf8');
    assert.equal(BF.main([rb, sums, '1.2.3']), 1);
    assert.equal(fs.readFileSync(rb, 'utf8'), before);
    fs.writeFileSync(sums, SUMS);
    assert.equal(BF.main([rb, sums, '1.2.3']), 0);
    assert.match(fs.readFileSync(rb, 'utf8'), new RegExp(X64));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release.yml fills the formula and pushes it to the tap only with TAP_TOKEN', () => {
  const tap = releaseJob('homebrew-tap');
  assert.match(tap, /^ {4}needs: \[version, github-release\]$/m);
  assert.match(tap, /^ {4}if: github\.event_name == 'push' && github\.ref_type == 'tag'$/m);
  assert.match(tap, /node dev\/release-key\.js verify dist\/SHA256SUMS/, 'the sums it copies are the signed ones');
  assert.match(tap, /node dev\/brew-formula\.js homebrew\/Formula\/wowgpt\.rb dist\/SHA256SUMS "\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(tap, /TAP_TOKEN: \$\{\{ secrets\.TAP_TOKEN \}\}/);
  assert.match(tap, /if \[ -z "\$TAP_TOKEN" \]; then\n\s+echo "::warning::TAP_TOKEN is not set[^\n]*\n\s+exit 0/);
  assert.match(tap, /rdimascio\/homebrew-wowgpt\.git/);
  assert.match(tap, /git -C tap push origin HEAD/);
});
