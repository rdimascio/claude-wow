# Phase 7: the transcript and the chat list redraw only what changed

Plan: [`addon-architecture.md` §4 phase 7](../addon-architecture.md). Measured with `node dev/render-bench.js` (the test VM, `tests/lua/vm.js`, with the native templates the quest-log list needs), median of 5 runs on Node 24, Apple Silicon. The stub's `GetStringHeight` returns a constant, so the counts are the instrument and the wall time is only a sanity check: in the game each `SetText` and `GetStringHeight` on a wrapped font string is a layout.

Script: login, open the window, the hello slot (connected), 5 chats, 10 messages and 10 slot replies in one chat (20 history entries), 60 ticks of 2 s with the window open, 10 chat switches.

| Measure | Before (`a433d10`) | After |
|---|---|---|
| `Render` calls | 63 | |
| bubble `SetText` calls (under `ClaudeWoWContent`) | 1,596 | |
| chat-list `SetText` calls (under `ClaudeWoWChatListContent`) | 1,153 | |
| `GetStringHeight` calls | 1,430 | |
| chat-list row fills (`Q.FillRow`) | 342 | |
| wall time (median of 5) | 541 ms | |

The 60 idle ticks call `Render` zero times before and after: `CheckConnection` renders only when the connection key changes, and the footer clock only runs `UpdateStatus`. The cost is in the renders that other code asks for (a send, a reply, a chat switch), each of which lays out every bubble of the active chat and fills every row of the list.
