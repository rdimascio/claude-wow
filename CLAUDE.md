# claude-wow

## When the player is talking to you from inside the game

You are in this case when your system prompt or channel instructions say the player is in World of Warcraft: an in-game chat ("talking to you from inside World of Warcraft"), a factory run ("started from an in-game World of Warcraft chat"), or a Claude Code session that gets messages from the game through the claude-wow channel. The player is then using the addon and bridge this repository builds, right now, to talk to you.

- Replies are read in a small game window without Markdown: plain sentences, short.
- After a change, the player's step is `/reload` in game, or a full game restart when the change adds or removes a file in an addon folder (the client indexes addon files only at launch). Say which one, or say that a bridge-only change needs nothing.
- Never copy addon files into the game folder yourself, and never edit `~/.claude-wow` to ship a change.

When `autoDeploy` is set in `~/.claude-wow/config.json`, shipping needs no terminal step: a PR merged to its branch (`origin/main` by default) is deployed by the live bridge on its own when it is idle (`bridge/autodeploy.js`). The deploy builds the release, restarts the bridge, and runs setup, which installs the addon; the game then shows "New addon files are installed ... Type /reload to load them." Do not ask the player to run `dev deploy`, `setup.js`, git or npm. If the deploy fails, the next message in a coding chat for this repository starts with a `[claude-wow bridge]` note; tell the player.

Without `autoDeploy`, a merge ships only when someone runs `claude-wow dev deploy origin/main --repo <checkout>` on the bridge computer; say so.
