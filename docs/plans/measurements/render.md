# Phase 7: the transcript and the chat list redraw only what changed

Plan: [`addon-architecture.md` §4 phase 7](../addon-architecture.md). Measured with `node dev/render-bench.js` (the test VM, `tests/lua/vm.js`, with the native templates the quest-log list needs), median of 5 runs on Node 24, Apple Silicon. The stub's `GetStringHeight` returns a constant, so the counts are the instrument and the wall time is only a sanity check: in the game each `SetText` and `GetStringHeight` on a wrapped font string is a layout.

Script: login, open the window, the hello slot (connected), 5 chats, 10 messages and 10 slot replies in one chat (20 history entries), 60 ticks of 2 s with the window open, 10 chat switches.

| Measure | Before (`a433d10`) | After |
|---|---|---|
| `Render` calls | 63 | 63 |
| bubble `SetText` calls (under `ClaudeWoWContent`) | 1,596 | 216 |
| chat-list `SetText` calls (under `ClaudeWoWChatListContent`) | 1,153 | 132 |
| `GetStringHeight` calls | 1,430 | 171 |
| chat-list rows laid out (`Q.FillRow` past its cache, one `Q.PoiState` each) | 342 | 40 |
| wall time (median of 5) | 541 ms | 499 ms |

The 60 idle ticks call `Render` zero times before and after: `CheckConnection` renders only when the connection key changes, and the footer clock only runs `UpdateStatus`. The cost is in the renders that other code asks for (a send, a reply, a chat switch), each of which laid out every bubble of the active chat and filled every row of the list. After phase 7 a bubble whose inputs did not change (text, role, agent label, timestamp, dim flag, denied flag, macro labels, picker rows, new-chat flag, at the same width and parchment state) keeps its text and height and is only re-anchored; a row or header whose inputs did not change (title, time, colour, glyph, index, active flag, width, preview lines) keeps its text and height too. The remaining 216 bubble texts are the new messages, the pending "Working" bubble (redrawn every time, its clock changes) and the first render after each chat switch, which starts the cache over.

Identity: `tests/render_test.js` runs a 32-step script in two VMs, one incremental and one that clears the caches before every `Render` and `RenderChatList` (today's full redraw), and after every step compares the whole frame tree under `ClaudeWoWContent` and the chat list (texts, sizes, anchors, colours, atlases, fonts, shown flags), on parchment with the quest-log list and on the legacy list.
