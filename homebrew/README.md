# Homebrew tap layout

This folder is the content of the tap repository `rdimascio/homebrew-claude-wow`
(Homebrew finds `brew tap rdimascio/claude-wow` at `github.com/rdimascio/homebrew-claude-wow`).
To publish it, copy `Formula/` into that repo as-is; nothing else is required.

```
homebrew-claude-wow/
  Formula/
    wowgpt.rb
```

Then:

```sh
brew tap rdimascio/claude-wow
brew install --HEAD wowgpt   # the checkout, run with Homebrew's node
wowgpt setup                 # game side: addon, config.json, slot pool
wowgpt service install       # optional: background service
```

Until the first stable release fills in the formula's checksums, only `--HEAD`
works. After that release, `brew install wowgpt` installs the release binary
(macOS arm64 and x64), with no Node.js.

The stable formula fetches one self-contained binary (`build.js`: the bridge, setup
and the service commands with Bun's runtime inside) from the tagged release and
puts it in `bin` as `wowgpt`; nothing else is installed. `--HEAD` clones the
repo and runs it with Homebrew's `node`, as the formula always did. Until the first
tagged release exists, only `--HEAD` installs; the formula's two `sha256` lines are
filled in from the release's `SHA256SUMS` when it is cut.

## The split, honestly

Homebrew can install the bridge and put `wowgpt` on the PATH. It cannot install
a WoW addon into the game folder, find your WoW account, or write a config that
depends on both: that is `wowgpt setup`, the same step every install route ends
with. So `brew install` alone gives you a `wowgpt` that says "run setup first".

## Upgrades keep your config and sessions

The keg holds only code. The bridge keeps `config.json`, `state.json` (the agents'
session ids), `transcripts.json`, `bridge.log` and its scratch folders in a home
folder outside the code: `WOWGPT_HOME` when set, else `~/.wowgpt`
(`bridge/home.js`). `brew upgrade` or `brew reinstall` replaces the keg and touches
none of that; `wowgpt service restart` afterwards picks up the new code, and
`wowgpt setup` is only needed again when the addon itself changed.

## Checking the formula locally

```sh
brew install --HEAD --formula ./homebrew/Formula/wowgpt.rb   # (or without --HEAD once a release exists)
brew test wowgpt
wowgpt service help
brew uninstall wowgpt
```
