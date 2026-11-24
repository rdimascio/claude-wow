#!/usr/bin/env node
'use strict';
// `node dev/brew-formula.js <formula.rb> <SHA256SUMS> <version>`: writes the
// release version and the two darwin binary sums into the Homebrew formula.
// The release workflow runs it before it pushes the formula to the tap.

const fs = require('fs');

const DARWIN_BINARIES = Object.freeze(['wowgpt-darwin-arm64', 'wowgpt-darwin-x64']);
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ZERO_SUM = '0'.repeat(64);

function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1]);
  }
  return sums;
}

function fillFormula(formula, sumsText, version) {
  if (!VERSION_RE.test(version)) throw new Error(`"${version}" is not a release version`);
  const sums = parseSums(sumsText);
  let out = String(formula);
  const versionLine = /^ {2}version "[^"]*"$/m;
  if (!versionLine.test(out)) throw new Error('the formula has no version line');
  out = out.replace(versionLine, `  version "${version}"`);
  for (const name of DARWIN_BINARIES) {
    const sum = sums.get(name);
    if (!sum || !SHA256_RE.test(sum) || sum === ZERO_SUM) throw new Error(`SHA256SUMS has no sum for ${name}`);
    const sumLine = new RegExp(`^( +sha256 )"[0-9a-f]{64}"( # ${name} in SHA256SUMS)$`, 'm');
    if (!sumLine.test(out)) throw new Error(`the formula has no sha256 line marked ${name}`);
    out = out.replace(sumLine, `$1"${sum}"$2`);
  }
  if (out.includes(ZERO_SUM)) throw new Error('the formula still holds a zero sha256');
  return out;
}

function main(argv = process.argv.slice(2)) {
  const [formulaFile, sumsFile, version] = argv;
  if (!formulaFile || !sumsFile || !version) {
    console.error('usage: node dev/brew-formula.js <formula.rb> <SHA256SUMS> <version>');
    return 2;
  }
  try {
    const filled = fillFormula(fs.readFileSync(formulaFile, 'utf8'), fs.readFileSync(sumsFile, 'utf8'), version);
    fs.writeFileSync(formulaFile, filled);
  } catch (e) {
    console.error(`brew-formula: ${e.message}`);
    return 1;
  }
  console.log(`brew-formula: ${formulaFile} is version ${version} with the darwin sums from ${sumsFile}`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { DARWIN_BINARIES, parseSums, fillFormula, main };
