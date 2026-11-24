// dev/release-key.js: the key pair it makes, the signature the release
// workflow writes with it, and self-update's check of that signature.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const KEY = require('../dev/release-key');
const UPD = require('../bridge/selfupdate');

const ROOT = path.join(__dirname, '..');

function run(argv, deps = {}) {
  const lines = [];
  const code = KEY.main(argv, { out: l => lines.push(l), err: l => lines.push(l), ...deps });
  return { code, text: lines.join('\n') };
}

test('generate writes the private key outside the checkout, 0600, never over a file, and prints the public key and the secret command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wowgpt-key-'));
  try {
    const r = run(['generate'], { home });
    assert.equal(r.code, 0, r.text);
    const keyFile = path.join(home, KEY.DEFAULT_KEY_FILE);
    assert.match(fs.readFileSync(keyFile, 'utf8'), /^-----BEGIN PRIVATE KEY-----/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    const pub = /^public key : (\S+)$/m.exec(r.text)[1];
    assert.equal(UPD.releasePublicKey(pub).asymmetricKeyType, 'ed25519');
    assert.ok(r.text.includes(`const RELEASE_PUBLIC_KEY = '${pub}';`));
    assert.match(r.text, new RegExp(`gh secret set ${KEY.SECRET} --repo \\S+ < "`));
    assert.doesNotMatch(r.text, /BEGIN PRIVATE KEY/, 'the private key is never printed');
    const again = run(['generate'], { home });
    assert.equal(again.code, 1, 'an existing key file is never overwritten');
    assert.match(again.text, /EEXIST/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('generate refuses a key file inside the checkout and writes nothing there', () => {
  for (const out of [path.join(ROOT, 'release.pem'), path.join(ROOT, 'dev', 'k.pem'), ROOT]) {
    const r = run(['generate', '--out', out]);
    assert.equal(r.code, 1, out);
    assert.match(r.text, /inside the checkout/);
    if (out !== ROOT) assert.ok(!fs.existsSync(out), `${out} was not written`);
  }
  assert.equal(KEY.insideCheckout(path.join(path.dirname(ROOT), 'elsewhere.pem')), false);
});

test('sign writes a .sig that self-update accepts under the generated key, and verify refuses a wrong key, edited sums or the placeholder', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wowgpt-sign-'));
  try {
    const gen = run(['generate'], { home });
    const pub = /^public key : (\S+)$/m.exec(gen.text)[1];
    const env = { [KEY.SECRET]: fs.readFileSync(path.join(home, KEY.DEFAULT_KEY_FILE), 'utf8') };
    const sums = path.join(home, 'SHA256SUMS');
    fs.writeFileSync(sums, `${'a'.repeat(64)}  wowgpt-linux-x64\n`);
    assert.equal(run(['sign', sums], { env }).code, 0);
    assert.equal(UPD.sumsSignatureProblem(fs.readFileSync(sums), fs.readFileSync(`${sums}.sig`, 'utf8'), pub), '');
    assert.equal(run(['verify', sums], { publicKey: pub }).code, 0);
    const placeholder = run(['verify', sums], { publicKey: UPD.RELEASE_PUBLIC_KEY_UNSET });
    assert.equal(placeholder.code, 1);
    assert.match(placeholder.text, /no release public key/);
    const other = run(['generate', '--out', path.join(home, 'other.pem')], { home });
    assert.equal(run(['verify', sums], { publicKey: /^public key : (\S+)$/m.exec(other.text)[1] }).code, 1, 'another key');
    fs.appendFileSync(sums, `${'b'.repeat(64)}  evil\n`);
    assert.equal(run(['verify', sums], { publicKey: pub }).code, 1, 'edited sums');
    const unsigned = run(['sign', sums], { env: {} });
    assert.equal(unsigned.code, 1);
    assert.match(unsigned.text, /RELEASE_SIGNING_KEY is not set/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('release.yml signs SHA256SUMS on a tag with the secret, checks it against the key the binary carries, and ships the .sig', () => {
  const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  const job = name => {
    const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm').exec(text);
    assert.ok(m, `job ${name}`);
    return m[1];
  };
  const sign = job('sign');
  assert.match(sign, /^ {4}needs: bridge$/m);
  assert.match(sign, /^ {4}if: github\.event_name == 'push' && github\.ref_type == 'tag'$/m);
  assert.match(sign, /^ {6}contents: read$/m);
  assert.match(sign, /RELEASE_SIGNING_KEY: \$\{\{ secrets\.RELEASE_SIGNING_KEY \}\}/);
  assert.match(sign, /node dev\/release-key\.js sign dist\/SHA256SUMS\n\s+node dev\/release-key\.js verify dist\/SHA256SUMS/);
  assert.equal(text.match(/secrets\.RELEASE_SIGNING_KEY/g).length, 1, 'only the sign job sees the private key');
  const release = job('github-release');
  assert.match(release, /^ {4}needs: \[version, addon, bridge, sign\]$/m);
  assert.match(release, /node dev\/release-key\.js verify dist\/SHA256SUMS/);
  assert.match(release, /test "\$\(ls dist \| wc -l\)" -eq 6/, 'four binaries, SHA256SUMS and SHA256SUMS.sig');
  assert.match(release, /gh release create .* addon-zip\/\*\.zip dist\/\* install\.sh install\.ps1$/m, 'the one-line installers are release assets');
});
