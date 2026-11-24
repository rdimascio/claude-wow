// install.sh and install.ps1, the one-line installers: they parse, the Node
// version gate accepts 22.2+ and nothing older or malformed, and the shell
// script runs nothing until it has been read in full (curl | sh safety).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { REPO_URL, API_URL } = require('../bridge/repo');

const SH = path.join(__dirname, '..', 'install.sh');
const PS1 = path.join(__dirname, '..', 'install.ps1');
const hasSh = process.platform !== 'win32' && !spawnSync('sh', ['-c', 'true']).error;
const pwsh = ['pwsh', 'powershell'].find(p => !spawnSync(p, ['-NoProfile', '-Command', '$true'], { windowsHide: true }).error);

test('install.sh: everything lives in functions and main runs last, so a cut-off download does nothing', () => {
  const src = fs.readFileSync(SH, 'utf8');
  assert.match(src, /\nmain "\$@"\n$/, 'main "$@" is the last line');
  assert.ok(!/\nsudo\b/.test(src) && !/ sudo /.test(src), 'never sudo');
  assert.ok(src.includes(`curl -fsSL ${REPO_URL}/releases/latest/download/install.sh | sh`), 'documents its own URL, the release asset');
  assert.match(src, /id -u.*-ne 0/, 'refuses root');
});

test('install.sh parses, and its Node gate accepts 22.2+ only', { skip: !hasSh && 'no sh here' }, () => {
  const lint = spawnSync('sh', ['-n', SH], { encoding: 'utf8' });
  assert.equal(lint.status, 0, lint.stderr);
  const ok = v => spawnSync('sh', [SH, '--node-ok', v], { encoding: 'utf8' });
  for (const v of ['v22.2.0', '22.2.0', 'v22.10.1', 'v24.21.0', 'v100.0.0']) assert.equal(ok(v).status, 0, `${v} should pass: ${ok(v).stdout}`);
  for (const v of ['v22.1.9', 'v21.9.0', 'v18.0.0', 'garbage', '', 'v22']) assert.equal(ok(v).status, 1, `${v} should fail`);
  assert.match(ok('v20.0.0').stdout, /need 22\.2/);
});

test('install.sh: unknown options and a missing Node (from source) fail loudly with a hint', { skip: !hasSh && 'no sh here' }, () => {
  const bad = spawnSync('sh', [SH, '--frobnicate'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /install failed: unknown option --frobnicate/);
  assert.match(bad.stderr, /-> Options:.*--from-source/);
  // From source, Node is required and its absence is the message.
  const noNode = spawnSync('/bin/sh', [SH, '--no-service', '--from-source'], { encoding: 'utf8', env: { PATH: '/nonexistent', HOME: process.env.HOME } });
  assert.equal(noNode.status, 1);
  assert.match(noNode.stderr, /Node\.js is not installed/);
  assert.match(noNode.stderr, /nodejs\.org/);
  // Without --from-source, nothing to fetch a binary with is a failure, never the source route.
  const noTools = spawnSync('/bin/sh', [SH, '--no-service'], { encoding: 'utf8', env: { PATH: '/nonexistent', HOME: process.env.HOME } });
  assert.equal(noTools.status, 1);
  assert.match(noTools.stderr, /install failed: /);
  assert.doesNotMatch(noTools.stdout + noTools.stderr, /installing from source|Node\.js is not installed/);
});

test('install.sh: the binary route names the release asset build.js produces for this machine, and verifies it', { skip: !hasSh && 'no sh here' }, () => {
  const asset = spawnSync('sh', [SH, '--binary-asset'], { encoding: 'utf8' }).stdout.trim();
  const B = require('../build');
  if (['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-x64'].includes(B.hostTarget())) assert.equal(asset, B.outName(B.hostTarget()));
  else assert.equal(asset, '', 'no binary for this platform: the source route');
  const src = fs.readFileSync(SH, 'utf8');
  assert.match(src, /releases\/latest\/download/, 'fetches from the GitHub release');
  assert.match(src, /SHA256SUMS/, 'checks the checksum');
  assert.match(src, /mv -f "\$tmp\/\$asset" "\$BIN_DIR\/wowgpt"/, 'replaces the binary by rename, so a running bridge keeps its file');
  assert.match(src, /service help/, 'runs the download once before keeping it');
  assert.match(src, /^  if \[ -n "\$SOURCE" \]; then\n    get_source$/m, 'the source route only for --from-source');
  assert.equal(src.match(/^\s+get_source$/gm).length, 1, 'no other way into the source route');
});

const INSTALLER_TOOLS_WITHOUT_NODE = [
  'uname',
  'mktemp',
  'rm',
  'sed',
  'head',
  'chmod',
  'mkdir',
  'mv',
  'cut',
  'grep',
  'sha256sum',
  'shasum',
  'cat',
  'cp',
  'ls',
  'tr',
  'ln',
];
const NON_ROOT_ID = '#!/bin/sh\necho 1000\n';

function fakeReleaseHost(newestTag, { machine, logArgs, sums = 'good', hashTools = true, latestTag = null, node = false } = {}) {
  const asset = machine ? 'wowgpt-unsupported' : spawnSync('sh', [SH, '--binary-asset'], { encoding: 'utf8' }).stdout.trim();
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wowgpt-install-'));
  const fakeBin = path.join(root, 'fake-bin');
  const files = path.join(root, 'files');
  const home = path.join(root, 'home');
  const binDir = path.join(root, 'bin');
  for (const d of [fakeBin, files, home, binDir]) fs.mkdirSync(d, { recursive: true });
  const argLog = path.join(root, 'args.log');
  const binary = `#!/bin/sh\necho "fake wowgpt $*"\n${logArgs ? `echo "$*" >> '${argLog}'\n` : ''}`;
  fs.writeFileSync(path.join(files, asset), binary);
  const sum = require('crypto').createHash('sha256').update(binary).digest('hex');
  const sumOf = { good: sum, bad: '0'.repeat(64) }[sums];
  if (sumOf) fs.writeFileSync(path.join(files, 'SHA256SUMS'), `${sumOf}  ${asset}\n`);
  if (newestTag)
    fs.writeFileSync(path.join(root, 'releases.json'), `[\n  {\n    "url": "x",\n    "tag_name": "${newestTag}",\n    "prerelease": true\n  }\n]\n`);
  if (latestTag) fs.writeFileSync(path.join(root, 'latest.json'), `{\n  "url": "x",\n  "tag_name": "${latestTag}",\n  "prerelease": false\n}\n`);
  const log = path.join(root, 'curl.log');
  fs.writeFileSync(
    path.join(fakeBin, 'curl'),
    [
      '#!/bin/sh',
      'url= out=',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in -o) out=$2; shift ;; -H) shift ;; http*) url=$1 ;; esac',
      '  shift',
      'done',
      `echo "$url" >> '${log}'`,
      'case "$url" in',
      `  '${API_URL}/releases?per_page=1') cat '${path.join(root, 'releases.json')}' 2>/dev/null || exit 22 ;;`,
      `  '${API_URL}/releases/latest') cat '${path.join(root, 'latest.json')}' 2>/dev/null || exit 22 ;;`,
      `  ${REPO_URL}/releases/download/${newestTag || 'none'}/*) cp '${files}'/"\${url##*/}" "$out" || exit 22 ;;`,
      '  *) exit 22 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  for (const tool of INSTALLER_TOOLS_WITHOUT_NODE) {
    if (tool === 'uname' && machine) continue;
    if (!hashTools && (tool === 'sha256sum' || tool === 'shasum')) continue;
    const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found.startsWith('/')) fs.symlinkSync(found, path.join(fakeBin, tool));
  }
  fs.writeFileSync(path.join(fakeBin, 'id'), NON_ROOT_ID, { mode: 0o755 });
  if (machine)
    fs.writeFileSync(path.join(fakeBin, 'uname'), `#!/bin/sh\ncase "$1" in -m) echo ${machine.arch} ;; *) echo ${machine.os} ;; esac\n`, { mode: 0o755 });
  const gitLog = path.join(root, 'git.log');
  if (node) {
    fs.writeFileSync(path.join(fakeBin, 'node'), `#!/bin/sh\n[ "$1" = -v ] && { echo v22.2.0; exit 0; }\necho "$*" >> '${argLog}'\n`, { mode: 0o755 });
    fs.writeFileSync(
      path.join(fakeBin, 'git'),
      `#!/bin/sh\necho "$*" >> '${gitLog}'\n[ "$1" = clone ] || exit 0\nfor last; do :; done\nmkdir -p "$last/bridge" && : > "$last/setup.js"\n`,
      { mode: 0o755 },
    );
  }
  const env = {
    PATH: `${fakeBin}:${binDir}`,
    HOME: home,
    SHELL: '/bin/sh',
    WOWGPT_BIN: binDir,
    WOWGPT_REPO: REPO_URL,
  };
  return { asset, root, binDir, home, log, env, argLog, gitLog };
}

const hasAsset = hasSh && spawnSync('sh', [SH, '--binary-asset'], { encoding: 'utf8' }).stdout.trim() !== '';

test(
  'install.sh: with no stable release, latest falls back to the newest release (a pre-release) and verifies it',
  { skip: !hasAsset && 'no prebuilt binary for this platform' },
  () => {
    const h = fakeReleaseHost('v0.5.0-beta.1');
    try {
      const r = spawnSync('/bin/sh', [SH, '--no-service'], { encoding: 'utf8', env: h.env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /trying the newest release, v0\.5\.0-beta\.1/);
      assert.match(r.stdout, /checksum OK/);
      assert.equal(fs.readFileSync(path.join(h.binDir, 'wowgpt'), 'utf8'), '#!/bin/sh\necho "fake wowgpt $*"\n');
      const urls = fs.readFileSync(h.log, 'utf8').trim().split('\n');
      assert.equal(urls[0], `${REPO_URL}/releases/latest/download/${h.asset}`);
      assert.equal(urls[1], `${API_URL}/releases?per_page=1`);
      assert.ok(urls.includes(`${REPO_URL}/releases/download/v0.5.0-beta.1/SHA256SUMS`));
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  },
);

test(
  'install.sh: with no release at all, latest fails with a clear error and never takes the source route',
  { skip: !hasAsset && 'no prebuilt binary for this platform' },
  () => {
    const none = fakeReleaseHost(null);
    try {
      const r = spawnSync('/bin/sh', [SH, '--no-service'], { encoding: 'utf8', env: none.env });
      assert.equal(r.status, 1);
      assert.match(r.stdout, /no binary at .*releases\/latest\/download/);
      assert.match(r.stderr, /install failed: no wowgpt binary could be downloaded from .*\/releases .*nothing was installed/);
      assert.match(r.stderr, /-> .*--from-source/);
      assert.doesNotMatch(r.stdout + r.stderr, /installing from source|Node\.js is not installed|cloning/);
      assert.ok(!fs.existsSync(path.join(none.binDir, 'wowgpt')), 'nothing installed');
    } finally {
      fs.rmSync(none.root, { recursive: true, force: true });
    }
  },
);

test(
  'install.sh: a release without SHA256SUMS, a machine without sha256sum or shasum, or a wrong sum fails and installs nothing',
  { skip: !hasAsset && 'no prebuilt binary for this platform' },
  () => {
    for (const [label, opts, re] of [
      ['no SHA256SUMS', { sums: 'none' }, /install failed: the release has no SHA256SUMS .*cannot be verified; nothing was installed/],
      ['no hash tool', { hashTools: false }, /install failed: neither sha256sum nor shasum is here, so the download cannot be verified; nothing was installed/],
      ['wrong sum', { sums: 'bad' }, /install failed: the downloaded .* does not match the release's SHA256SUMS; nothing was installed/],
    ]) {
      const h = fakeReleaseHost('v0.5.0-beta.1', opts);
      try {
        const r = spawnSync('/bin/sh', [SH, '--no-service'], { encoding: 'utf8', env: h.env });
        assert.equal(r.status, 1, `${label}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, re, label);
        assert.doesNotMatch(r.stdout, /warning:|checksum OK/, label);
        assert.ok(!fs.existsSync(path.join(h.binDir, 'wowgpt')), `${label}: nothing installed`);
      } finally {
        fs.rmSync(h.root, { recursive: true, force: true });
      }
    }
  },
);

test('install.sh --from-source clones the latest release tag, or the pinned release, never main', { skip: !hasSh && 'no sh here' }, () => {
  for (const [label, args, env, want] of [
    ['latest', [], {}, 'v1.0.0'],
    ['pinned', ['--release', 'v0.4.0'], {}, 'v0.4.0'],
    ['ref', [], { WOWGPT_REF: 'my-branch' }, 'my-branch'],
  ]) {
    const h = fakeReleaseHost('v1.1.0-beta.1', { latestTag: 'v1.0.0', node: true });
    try {
      const r = spawnSync('/bin/sh', [SH, '--no-service', '--from-source', ...args], { encoding: 'utf8', env: { ...h.env, ...env } });
      assert.equal(r.status, 0, `${label}: ${r.stdout}${r.stderr}`);
      const clone = fs.readFileSync(h.gitLog, 'utf8').trim();
      assert.ok(clone.startsWith(`clone --quiet --depth 1 --branch ${want} ${REPO_URL} `), `${label}: ${clone}`);
      assert.doesNotMatch(clone, /--branch main/, label);
      const lookups = fs.existsSync(h.log) ? fs.readFileSync(h.log, 'utf8') : '';
      assert.equal(lookups.includes(`${API_URL}/releases/latest`), label === 'latest', `${label}: the latest tag is looked up only when needed`);
      assert.ok(!lookups.includes('/download/'), `${label}: no binary download`);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }
});

test('install.sh --from-source with no release tag to find fails instead of taking main', { skip: !hasSh && 'no sh here' }, () => {
  const h = fakeReleaseHost(null, { node: true });
  try {
    const r = spawnSync('/bin/sh', [SH, '--no-service', '--from-source'], { encoding: 'utf8', env: h.env });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /install failed: could not find the latest release's tag/);
    assert.ok(!fs.existsSync(h.gitLog), 'nothing cloned');
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test(
  'install.sh: a pinned --release that cannot be downloaded fails and never falls back to another release or the source',
  { skip: !hasAsset && 'no prebuilt binary for this platform' },
  () => {
    for (const pin of [['--release', 'v0.4.0'], []]) {
      const pinned = fakeReleaseHost('v0.5.0-beta.1');
      try {
        const env = pin.length ? pinned.env : { ...pinned.env, WOWGPT_RELEASE: 'v0.4.0' };
        const r = spawnSync('/bin/sh', [SH, '--no-service', ...pin], { encoding: 'utf8', env });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /install failed: release v0\.4\.0 has no wowgpt binary for this machine/);
        assert.match(r.stderr, /a pinned release never falls back/);
        assert.doesNotMatch(r.stdout, /installing from source/);
        assert.doesNotMatch(r.stderr, /Node\.js is not installed/);
        assert.ok(!fs.existsSync(path.join(pinned.binDir, 'wowgpt')), 'nothing installed');
        const urls = fs.readFileSync(pinned.log, 'utf8');
        assert.ok(!/api\.github\.com/.test(urls), 'no lookup of another release');
        assert.match(urls, /releases\/download\/v0\.4\.0\//);
      } finally {
        fs.rmSync(pinned.root, { recursive: true, force: true });
      }
    }
  },
);

test('install.sh: a pinned --release that exists installs that release', { skip: !hasAsset && 'no prebuilt binary for this platform' }, () => {
  const h = fakeReleaseHost('v0.5.0-beta.1');
  try {
    const r = spawnSync('/bin/sh', [SH, '--no-service', '--release', 'v0.5.0-beta.1'], { encoding: 'utf8', env: h.env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /checksum OK/);
    const urls = fs.readFileSync(h.log, 'utf8').trim().split('\n');
    assert.equal(urls[0], `${REPO_URL}/releases/download/v0.5.0-beta.1/${h.asset}`);
    assert.ok(!urls.some(u => u.includes('api.github.com')));
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

test('install.sh: a platform with no binary says so and points at --from-source, pinned or latest', { skip: !hasSh && 'no sh here' }, () => {
  const h = fakeReleaseHost('v0.5.0-beta.1', { machine: { os: 'Linux', arch: 'riscv64' } });
  try {
    for (const args of [['--release', 'v0.5.0-beta.1'], []]) {
      const r = spawnSync('/bin/sh', [SH, '--no-service', ...args], { encoding: 'utf8', env: h.env });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /install failed: no wowgpt binary is built for Linux riscv64; nothing was installed/);
      assert.match(r.stderr, /-> Run this again with --from-source/);
      assert.doesNotMatch(r.stderr, /network/);
      assert.doesNotMatch(r.stdout, /installing from source/);
      assert.ok(!fs.existsSync(h.log), 'nothing downloaded');
    }
  } finally {
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});

function ps1Functions(names) {
  return `
    $ErrorActionPreference = 'Stop'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${PS1.replace(/'/g, "''")}', [ref]$null, [ref]$null)
    foreach ($name in @(${names.map(n => `'${n}'`).join(', ')})) {
      $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
      if (-not $fn) { Write-Output "FAIL no $name"; exit 1 }
      . ([scriptblock]::Create($fn.Extent.Text))
    }
    function Expect($want, $got) { if ($want -ne $got) { Write-Output "FAIL want $want got $got"; exit 1 } }`;
}

test(
  'install.ps1: only -FromSource takes the source route; a failed or impossible download fails, latest or pinned',
  { skip: !pwsh && 'no PowerShell here' },
  () => {
    const script = `${ps1Functions(['Select-BridgeRoute'])}
    $global:downloads = 0
    Expect 'source' (Select-BridgeRoute $true 'v0.4.0' 'AMD64' { $global:downloads++; $true })
    Expect 'no-binary-for-platform' (Select-BridgeRoute $false 'v0.4.0' 'ARM64' { $global:downloads++; $true })
    Expect 'no-binary-for-platform' (Select-BridgeRoute $false 'latest' 'ARM64' { $global:downloads++; $true })
    Expect 0 $global:downloads
    Expect 'binary' (Select-BridgeRoute $false 'v0.4.0' 'AMD64' { $true })
    Expect 'binary' (Select-BridgeRoute $false 'latest' 'AMD64' { $true })
    Expect 'pinned-download-failed' (Select-BridgeRoute $false 'v0.4.0' 'AMD64' { $false })
    Expect 'download-failed' (Select-BridgeRoute $false 'latest' 'AMD64' { $false })
    Write-Output OK`;
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK/);
  },
);

test(
  'install.ps1: a missing SHA256SUMS, a missing hash or a wrong sum is a problem, and the source ref is the release tag',
  { skip: !pwsh && 'no PowerShell here' },
  () => {
    const sum = 'a'.repeat(64);
    const script = `${ps1Functions(['Get-SumProblem', 'Select-SourceRef'])}
    $asset = 'wowgpt-windows-x64.exe'
    Expect '' (Get-SumProblem "${sum}  $asset\`n" $asset '${sum.toUpperCase()}')
    if (-not ((Get-SumProblem '' $asset '${sum}') -match 'no SHA256SUMS')) { Write-Output 'FAIL no sums'; exit 1 }
    if (-not ((Get-SumProblem "${sum}  $asset" $asset '') -match 'could not be hashed')) { Write-Output 'FAIL no hash'; exit 1 }
    if (-not ((Get-SumProblem "${'b'.repeat(64)}  $asset" $asset '${sum}') -match 'does not match')) { Write-Output 'FAIL wrong sum'; exit 1 }
    if (-not ((Get-SumProblem "${sum}  other.exe" $asset '${sum}') -match 'does not match')) { Write-Output 'FAIL no line'; exit 1 }
    $global:lookups = 0
    Expect 'my-branch' (Select-SourceRef 'my-branch' 'latest' { $global:lookups++; 'v1.0.0' })
    Expect 'v0.4.0' (Select-SourceRef '' 'v0.4.0' { $global:lookups++; 'v1.0.0' })
    Expect 0 $global:lookups
    Expect 'v1.0.0' (Select-SourceRef '' 'latest' { 'v1.0.0' })
    Expect $null (Select-SourceRef '' 'latest' { $null })
    Write-Output OK`;
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /OK/);
  },
);

test('install.ps1 takes the route and the checks the functions pick, and never defaults the source to main', () => {
  const src = fs.readFileSync(PS1, 'utf8');
  assert.match(
    src,
    /^switch \(Select-BridgeRoute \(\[bool\]\$FromSource\) \$Release \$env:PROCESSOR_ARCHITECTURE \{ Get-Binary \}\) \{$/m,
    'the installer takes the route the function picks',
  );
  assert.match(src, /^ {2}'source' \{ Get-Source \}$/m);
  assert.match(src, /'no-binary-for-platform' \{ Fail "no wowgpt binary is built for .*-FromSource/);
  assert.match(src, /'pinned-download-failed' \{ Fail "release \$Release has no wowgpt binary/);
  assert.match(src, /'download-failed' \{ Fail "no wowgpt binary could be downloaded/);
  assert.equal(src.match(/Get-Source \}/g).length, 1, 'one way into the source route');
  assert.match(
    src,
    /\$problem = Get-SumProblem \$sums \$asset \$have\n {2}if \(\$problem\) \{ Remove-Item -Force \$tmp; Fail \$problem/,
    'a sum problem fails before the binary runs',
  );
  assert.doesNotMatch(src, /warning: the release has no SHA256SUMS|was not verified/);
  assert.match(src, /\$script:Ref = Select-SourceRef \$Ref \$Release/);
  assert.match(src, /\$env:CLAUDE_WOW_REF\) -ne \$null\)\[0\] \} else \{ '' \}\),/, 'no main default');
  assert.doesNotMatch(src, /'main'/);
});

test('install.ps1 names the Startup launcher by every name bridge/service.js knows', () => {
  const SVC = require('../bridge/service');
  const names = [
    path.win32.basename(SVC.dirs('win32', { APPDATA: 'C:\\A', LOCALAPPDATA: 'C:\\L' }, 'C:\\U').definition),
    ...SVC.OLD_SERVICES.map(o => o.launcher),
  ];
  const list = /^\$ServiceLaunchers = @\((.*)\)$/m.exec(fs.readFileSync(PS1, 'utf8'))[1];
  assert.deepEqual(
    list.split(',').map(s => s.trim().replace(/^'|'$/g, '')),
    names,
  );
});

test(
  'install.ps1: an existing launcher is reinstalled without asking, a fresh install asks with Enter as yes, and the flags win',
  { skip: !pwsh && 'no PowerShell here' },
  () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wowgpt-ps1-'));
    const old = path.join(dir, 'Claude WoW bridge.vbs');
    fs.writeFileSync(old, 'x');
    const missing = path.join(dir, 'WoWGPT bridge.vbs');
    const script = `
    $ErrorActionPreference = 'Stop'
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${PS1.replace(/'/g, "''")}', [ref]$null, [ref]$null)
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Select-ServiceFlag' }, $true) | Select-Object -First 1
    if (-not $fn) { Write-Output 'FAIL no Select-ServiceFlag'; exit 1 }
    . ([scriptblock]::Create($fn.Extent.Text))
    $global:asked = 0
    function Expect($want, $got) { if ($want -ne $got) { Write-Output "FAIL want $want got $got"; exit 1 } }
    $never = { $global:asked += 100; 'n' }
    $defs = @('${missing.replace(/'/g, "''")}', '${old.replace(/'/g, "''")}')
    $none = @('${missing.replace(/'/g, "''")}')
    Expect '--service' (Select-ServiceFlag $false $false '' $defs $true $never)
    Expect '--service' (Select-ServiceFlag $false $false '' $defs $false $never)
    Expect '--no-service' (Select-ServiceFlag $false $true '' $defs $true $never)
    Expect '--no-service' (Select-ServiceFlag $false $false 'no' $defs $true $never)
    Expect '--service' (Select-ServiceFlag $true $false '' $none $true $never)
    Expect '--no-service' (Select-ServiceFlag $false $false '' $none $false $never)
    Expect 0 $global:asked
    Expect '--service' (Select-ServiceFlag $false $false '' $none $true { $global:asked++; '' })
    Expect '--service' (Select-ServiceFlag $false $false '' $none $true { $global:asked++; 'Y' })
    Expect '--no-service' (Select-ServiceFlag $false $false '' $none $true { $global:asked++; 'n' })
    Expect 3 $global:asked
    Write-Output OK`;
    try {
      const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /OK/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const src = fs.readFileSync(PS1, 'utf8');
    assert.match(src, /^\$setupArgs = @\(\$serviceFlag\)$/m, 'setup gets the choice');
    assert.doesNotMatch(src, /& \$Cmd service install/, 'setup installs the service, not the installer');
  },
);

test('install.ps1 parses, and its Node gate matches the shell one', { skip: !pwsh && 'no PowerShell here' }, () => {
  const script = `
    $errs = $null
    [System.Management.Automation.Language.Parser]::ParseFile('${PS1.replace(/'/g, "''")}', [ref]$null, [ref]$errs) | Out-Null
    if ($errs.Count) { $errs | ForEach-Object { Write-Output $_.Message }; exit 1 }
    $MinNode = [version]'22.2'
    function Test-NodeVersion([string]$v) { try { return ([version]($v -replace '^v', '')) -ge $MinNode } catch { return $false } }
    foreach ($v in 'v22.2.0','v24.21.0','v100.0.0') { if (-not (Test-NodeVersion $v)) { Write-Output "FAIL $v"; exit 1 } }
    foreach ($v in 'v22.1.9','v18.0.0','garbage','') { if (Test-NodeVersion $v) { Write-Output "FAIL $v"; exit 1 } }
    Write-Output OK`;
  const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK/);
  const src = fs.readFileSync(PS1, 'utf8');
  assert.ok(src.includes(`irm ${REPO_URL}/releases/latest/download/install.ps1 | iex`), 'documents its own URL, the release asset');
  assert.ok(!/RunAs|Start-Process .*-Verb/i.test(src), 'never elevates');
});

test('the installers put the code under the home folder, name the wowgpt command, and carry no wow-ai or claude-wow command over', () => {
  const sh = fs.readFileSync(SH, 'utf8');
  assert.match(sh, /^DIR=\$\{WOWGPT_DIR:-\$\{CLAUDE_WOW_DIR:-\$HOME_DIR\/app\}\}$/m, 'code under ~/.wowgpt/app, state in ~/.wowgpt');
  assert.match(sh, /^HOME_DIR=\$\{WOWGPT_HOME:-\$\{CLAUDE_WOW_HOME:-\$HOME\/\.wowgpt\}\}$/m);
  assert.match(sh, /"\$BIN_DIR\/wowgpt"/);
  assert.ok(!/BIN_DIR\/wow-ai" <<EOF/.test(sh), 'no wow-ai shim is written');
  assert.doesNotMatch(
    sh,
    /migrate_old_install|link_old_command|\.wow-ai|BIN_DIR\/claude-wow/,
    'no old-command migration: setup carries the home and service over',
  );
  assert.ok(!/WOW_AI_/.test(sh), 'no WOW_AI_* variable left');
  const ps = fs.readFileSync(PS1, 'utf8');
  assert.match(ps, /'wowgpt\.cmd'/);
  assert.match(ps, /'wowgpt\.exe'/, 'the binary route');
  assert.match(ps, /wowgpt-windows-x64\.exe/, 'the release asset build.js produces');
  assert.match(ps, /SHA256SUMS/);
  assert.match(ps, /Get-Source/, 'falls back to the source');
  assert.match(ps, /\$newest = if \(\$Release -eq 'latest'\) \{ Get-NewestReleaseTag \}/, 'only latest falls back to the newest release');
  assert.match(ps, /\/releases\?per_page=1"/, 'the newest release, pre-releases included');
  assert.doesNotMatch(ps + sh, /newest pre-release/, 'the fallback takes the newest release of any kind');
  assert.match(ps, /Programs\\wowgpt'/);
  assert.doesNotMatch(ps, /\$OldDir|\$OldClaudeWowDir|Programs\\wow-ai|Programs\\claude-wow/, 'no old-command migration');
  assert.ok(!/WOW_AI_/.test(ps), 'no WOW_AI_* variable left');
});

// The rename to WoWGPT: an installer run with only the old CLAUDE_WOW_*
// variables still finds its folders.
test(
  'install.sh after the rename: CLAUDE_WOW_BIN still counts, and an old claude-wow command is left alone',
  { skip: !hasAsset && 'no prebuilt binary for this platform' },
  () => {
    const h = fakeReleaseHost('v0.5.0-beta.1');
    try {
      const env = { ...h.env, CLAUDE_WOW_BIN: h.binDir };
      delete env.WOWGPT_BIN;
      fs.writeFileSync(path.join(h.binDir, 'claude-wow'), '#!/bin/sh\necho "claude-wow 0.5.0"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(h.binDir, 'unrelated'), 'other\n');
      const r = spawnSync('/bin/sh', [SH, '--no-service'], { encoding: 'utf8', env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(fs.existsSync(path.join(h.binDir, 'wowgpt')), 'the binary went into the folder the old variable names');
      assert.equal(fs.readFileSync(path.join(h.binDir, 'claude-wow'), 'utf8'), '#!/bin/sh\necho "claude-wow 0.5.0"\n', 'no link to wowgpt');
      assert.equal(fs.readFileSync(path.join(h.binDir, 'unrelated'), 'utf8'), 'other\n');
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  },
);

test('install.sh names the background service by every name bridge/service.js knows', () => {
  const SVC = require('../bridge/service');
  const sh = fs.readFileSync(SH, 'utf8');
  assert.equal(/^LAUNCHD_LABELS="(.*)"$/m.exec(sh)[1], [SVC.LABEL, ...SVC.OLD_LABEL].join(' '));
  assert.equal(/^SYSTEMD_UNITS="(.*)"$/m.exec(sh)[1], [SVC.UNIT, ...SVC.OLD_UNIT].join(' '));
});

test(
  'install.sh: an existing service under any name is reinstalled without asking, a fresh install with nobody to ask gets none, and the flags win',
  { skip: !hasAsset && 'no prebuilt binary for this platform' },
  () => {
    const cases = [
      { definition: 'Library/LaunchAgents/io.claudewow.bridge.plist', args: [], want: '--service', reinstall: true },
      { definition: '.config/systemd/user/wow-ai-bridge.service', args: [], want: '--service', reinstall: true },
      { definition: 'Library/LaunchAgents/io.wowgpt.bridge.plist', args: ['--no-service'], want: '--no-service' },
      { definition: '', args: [], want: '--no-service' },
      { definition: '', args: ['--service'], want: '--service' },
    ];
    for (const c of cases) {
      const h = fakeReleaseHost('v0.5.0-beta.1', { logArgs: true });
      try {
        if (c.definition) {
          fs.mkdirSync(path.dirname(path.join(h.home, c.definition)), { recursive: true });
          fs.writeFileSync(path.join(h.home, c.definition), 'x');
        }
        const r = spawnSync('/bin/sh', [SH, ...c.args], { encoding: 'utf8', env: h.env });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        const setup = fs
          .readFileSync(h.argLog, 'utf8')
          .split('\n')
          .find(l => l.startsWith('setup '));
        assert.equal(setup.split(' ')[1], c.want, `${c.definition || 'no service'} ${c.args.join(' ')}: ${setup}`);
        assert.equal(/setup reinstalls it so it runs this version/.test(r.stdout), !!c.reinstall);
        assert.doesNotMatch(r.stdout, /works from any folder/);
      } finally {
        fs.rmSync(h.root, { recursive: true, force: true });
      }
    }
  },
);

test(
  'install.sh: with its folder not on the PATH and nobody to ask, the last lines give the full path of the command',
  { skip: !hasAsset && 'no prebuilt binary for this platform' },
  () => {
    const h = fakeReleaseHost('v0.5.0-beta.1');
    try {
      const env = {
        ...h.env,
        PATH: h.env.PATH.split(':')
          .filter(d => d !== h.binDir)
          .join(':'),
      };
      const r = spawnSync('/bin/sh', [SH, '--no-service'], { encoding: 'utf8', env });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(
        r.stdout,
        new RegExp(`^The wowgpt command is ${h.binDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/wowgpt \\(its folder is not on your PATH\\)\\.$`, 'm'),
      );
      const onPath = spawnSync('/bin/sh', [SH, '--no-service'], { encoding: 'utf8', env: h.env });
      assert.doesNotMatch(onPath.stdout, /The wowgpt command is \//);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  },
);

test('every documented one-liner fetches the installer from the latest release, never from main', () => {
  const docs = ['README.md', 'docs/INSTALL.md', 'docs/INSTALL-LINUX.md', 'docs/INSTALL-WINDOWS.md', 'install.sh', 'install.ps1'];
  let seen = 0;
  for (const doc of docs) {
    for (const line of fs.readFileSync(path.join(__dirname, '..', doc), 'utf8').split('\n')) {
      if (!/wowgpt|claude-wow|rdimascio/.test(line) || !/install\.(sh \| sh|ps1 \| iex)/.test(line)) continue;
      seen++;
      assert.ok(line.includes(`${REPO_URL}/releases/latest/download/install.`), `${doc}: ${line}`);
    }
  }
  assert.ok(seen >= 8, `found ${seen} one-liners`);
});
