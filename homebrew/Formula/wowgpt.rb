# Homebrew formula for the WoWGPT bridge and its `wowgpt` command.
# Lives in the tap rdimascio/homebrew-claude-wow as Formula/wowgpt.rb:
#
#   brew tap rdimascio/claude-wow
#   brew install wowgpt         # the release binary: nothing else, no Node.js
#   brew install --HEAD wowgpt  # the checkout instead, run with Homebrew's node
#   wowgpt setup                # the game-side install (addon, config, slot pool)
#   wowgpt service install      # optional: run it in the background, start at login
#
# The stable install is one self-contained binary per architecture from the
# project's GitHub release (build.js: the bridge, setup and the service
# commands with Bun's runtime inside); Node is not involved. --HEAD is the
# checkout run with node, as before. Homebrew installs the bridge and the
# command; it cannot touch the game folder, so the addon goes in with
# `wowgpt setup`. The keg holds only code: the config, the agents'
# sessions, transcripts and logs live in ~/.wowgpt (WOWGPT_HOME), and
# the binary writes the capture scripts and the addon it carries there too
# (assets/), so `brew upgrade` keeps them all. See ../README.md.
class Wowgpt < Formula
  desc "WoWGPT: chat with local coding agents from inside World of Warcraft (the bridge and CLI)"
  homepage "https://github.com/rdimascio/claude-wow"
  license "MIT"
  # The first tagged release. Cutting one: tag it, attach the four binaries
  # and SHA256SUMS from `node build.js` (CI builds them too), then put the two
  # darwin sums from SHA256SUMS here. Until then only --HEAD installs.
  version "0.5.0"
  on_macos do
    on_arm do
      url "https://github.com/rdimascio/claude-wow/releases/download/v#{version}/wowgpt-darwin-arm64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000" # wowgpt-darwin-arm64 in SHA256SUMS
    end
    on_intel do
      url "https://github.com/rdimascio/claude-wow/releases/download/v#{version}/wowgpt-darwin-x64"
      sha256 "0000000000000000000000000000000000000000000000000000000000000000" # wowgpt-darwin-x64 in SHA256SUMS
    end
  end
  head do
    url "https://github.com/rdimascio/claude-wow.git", branch: "main"
    depends_on "node"
  end
  # python3 is only needed for the pixel-capture transport (capture_mac.py);
  # the screenshot transport needs nothing beyond the bridge. Left to the user.

  def install
    if build.head?
      # Code only. The bridge keeps config.json, state.json, transcripts.json,
      # bridge.log and its scratch folders in ~/.wowgpt (bridge/home.js), never
      # in the keg, so an upgrade replaces nothing the user cares about.
      libexec.install Dir["*"]
      chmod 0755, libexec/"bridge/supervisor.js"
      (bin/"wowgpt").write_env_script libexec/"bridge/supervisor.js",
        PATH: "#{formula_opt_bin("node")}:$PATH"
    else
      # A bare file download: Homebrew stages it under its own name.
      binary = Dir["wowgpt-darwin-*"].first
      odie "the download holds no wowgpt binary" unless binary
      bin.install binary => "wowgpt"
    end
  end

  def caveats
    <<~EOS
      Homebrew installed the bridge and the wowgpt command only. The addon has
      to go into the game folder, which Homebrew cannot do:

        wowgpt setup              # finds the client, installs the addon, writes the config
        wowgpt service install    # optional: run in the background, start at login

      Your config, the agents' sessions and the logs live in ~/.wowgpt
      (or $WOWGPT_HOME), outside this keg, so `brew upgrade` keeps them.
      After an upgrade, `wowgpt service restart` picks up the new code.
    EOS
  end

  test do
    assert_match "install", shell_output("#{bin}/wowgpt service help")
    assert_match "wowgpt [--project", shell_output("#{bin}/wowgpt --help")
    assert_match "wowgpt ", shell_output("#{bin}/wowgpt --version")
  end
end
