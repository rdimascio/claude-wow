# Homebrew tap layout

This folder is the content of the tap repository `rdimascio/homebrew-wowgpt`
(Homebrew finds `brew tap rdimascio/wowgpt` at `github.com/rdimascio/homebrew-wowgpt`).
You do not copy it by hand. On a tag push, the `homebrew-tap` job of
`.github/workflows/release.yml` writes the release version and the two darwin
sums from the signed `SHA256SUMS` into `Formula/wowgpt.rb` and pushes it to the
tap (the `TAP_TOKEN` secret). The sums in this repository stay zero.

```
homebrew-wowgpt/
  Formula/
    wowgpt.rb
```

Then:

```sh
brew tap rdimascio/wowgpt
brew install wowgpt          # the release binary (macOS arm64 and x64), no Node.js
wowgpt setup                 # game side: addon, config.json, slot pool, background service
```

`brew install --HEAD wowgpt` installs the checkout instead, run with Homebrew's node.

The stable formula fetches one self-contained binary (`build.js`: the bridge, setup
and the service commands with Bun's runtime inside) from the tagged release and
puts it in `bin` as `wowgpt`; nothing else is installed. `--HEAD` clones the
repo and runs it with Homebrew's `node`, as the formula always did. The formula's
two `sha256` lines are filled in from the release's `SHA256SUMS` by the release workflow.

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
none of that; `wowgpt setup` afterwards reinstalls the background service, which restarts
the bridge on the new code, and installs the addon that ships with it.

## Checking the formula locally

```sh
brew install --HEAD --formula ./homebrew/Formula/wowgpt.rb   # the repo copy has zero sums, so only --HEAD installs from it
brew test wowgpt
wowgpt service help
brew uninstall wowgpt
```
