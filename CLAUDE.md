# claude-wow

## When the player is talking to you from inside the game

Your system prompt says so when it does: "The user is talking to you from inside World of Warcraft" (an in-game chat) or "This run was started from an in-game World of Warcraft chat" (a factory run). Then the player is using the addon and bridge this repository builds, right now, to talk to you. Act on that:

- The player's only step after a change is `/reload` in game, or a full game restart when the change adds or removes a file in an addon folder (the client indexes addon files only at launch). Never ask them to run a terminal command, git, npm, `setup.js` or `dev deploy`.
- Shipping is: a PR merged to `main`, then the live bridge deploys it on its own when it is idle (`autoDeploy` in `~/.claude-wow/config.json`, `bridge/autodeploy.js`). The deploy runs setup, which installs the addon, and the game then shows "New addon files are installed ... Type /reload to load them." Say in your reply when the merged change needs `/reload` or a restart, and when it needs nothing (a bridge-only change).
- The deploy restarts the bridge. Chats and their sessions survive it; a run that is going when it starts is waited for.
- Never copy addon files into the game folder yourself, and never edit `~/.claude-wow` to ship a change.
- Replies are read in a small game window without Markdown: plain sentences, short.
