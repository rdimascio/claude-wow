#!/usr/bin/env node
'use strict';
// The ed25519 key that signs each release's SHA256SUMS. Self-update trusts a
// release only when SHA256SUMS.sig verifies under RELEASE_PUBLIC_KEY in
// bridge/selfupdate.js.
//
//   node dev/release-key.js generate [--out <file>]
//       makes a new key pair, writes the private key (PEM, mode 0600) to
//       <file> (default ~/wowgpt-release-signing-key.pem; never inside this
//       checkout, never over an existing file) and prints the public key to
//       paste into RELEASE_PUBLIC_KEY and the command that stores the private
//       key as the RELEASE_SIGNING_KEY secret.
//   node dev/release-key.js sign <SHA256SUMS>
//       writes <SHA256SUMS>.sig with the private key in RELEASE_SIGNING_KEY.
//   node dev/release-key.js verify <SHA256SUMS>
//       checks <SHA256SUMS>.sig against RELEASE_PUBLIC_KEY; fails while the
//       key is the placeholder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const UPD = require('../bridge/selfupdate');
const { REPO } = require('../bridge/repo');

const ROOT = path.join(__dirname, '..');
const SECRET = 'RELEASE_SIGNING_KEY';
const DEFAULT_KEY_FILE = 'wowgpt-release-signing-key.pem';
const USAGE = 'usage: node dev/release-key.js generate [--out <file>] | sign <SHA256SUMS> | verify <SHA256SUMS>';

function insideCheckout(file, root = ROOT) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function generate(argv, { out, home = os.homedir(), root = ROOT }) {
  let keyFile = path.join(home, DEFAULT_KEY_FILE);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) keyFile = path.resolve(argv[++i]);
    else throw new Error(USAGE);
  }
  if (insideCheckout(keyFile, root))
    throw new Error(`${keyFile} is inside the checkout ${root}; the private key never goes into the repository. Pick a file outside it with --out.`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  fs.writeFileSync(keyFile, pem, { mode: 0o600, flag: 'wx' });
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  out(`private key: ${keyFile} (keep it out of the repository; back it up somewhere safe)`);
  out(`public key : ${spki}`);
  out('');
  out('Next:');
  out(`  1. In bridge/selfupdate.js set:  const RELEASE_PUBLIC_KEY = '${spki}';`);
  out(`  2. Store the private key as the release secret:  gh secret set ${SECRET} --repo ${REPO} < "${keyFile}"`);
  return 0;
}

function sign(file, { out, env = process.env }) {
  const pem = env[SECRET];
  if (!pem) throw new Error(`${SECRET} is not set, so ${file} cannot be signed`);
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${SECRET} is a ${key.asymmetricKeyType} key, not ed25519`);
  const signature = crypto.sign(null, fs.readFileSync(file), key).toString('base64');
  fs.writeFileSync(`${file}.sig`, signature + '\n');
  out(`signed ${file} -> ${file}.sig`);
  return 0;
}

function verify(file, { out, publicKey = UPD.RELEASE_PUBLIC_KEY }) {
  const problem = UPD.sumsSignatureProblem(fs.readFileSync(file), fs.readFileSync(`${file}.sig`, 'utf8'), publicKey);
  if (problem) throw new Error(`${file}: ${problem}`);
  out(`${file}.sig verifies ${file} under RELEASE_PUBLIC_KEY`);
  return 0;
}

function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out || console.log;
  const err = deps.err || console.error;
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'generate') return generate(rest, { ...deps, out });
    if ((cmd === 'sign' || cmd === 'verify') && rest.length === 1) return (cmd === 'sign' ? sign : verify)(rest[0], { ...deps, out });
    err(USAGE);
    return 2;
  } catch (e) {
    err(`release-key: ${e.message}`);
    return 1;
  }
}

module.exports = { main, insideCheckout, SECRET, DEFAULT_KEY_FILE };

if (require.main === module) process.exitCode = main();
