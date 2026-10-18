# Plan: the ClaudeWoW addon as a modular, linted, measured codebase

Status: revision 2 (2026-10-17). Phases 0 to 5 merged the same day (PRs #185 to #191); §6 has the numbers. Phase 6 is done (`refactor/addon-state`); phases 7 to 9 and the bridge items in §8.2 are open. Reviewed `origin/main` at `f7f3a12`. Every number below was measured on that checkout with the commands named next to it; **(unverified)** marks a claim nobody has checked in the game client yet. Code references name functions, not line numbers.

## 1. What the review found

### 1.1 The addon in numbers

| Measure | Value | How measured |
|---|---|---|
| Addon Lua, all files | 18,362 lines in 17 files | `wc -l addon/ClaudeWoW/*.lua` |
| `ClaudeWoW.lua` alone | 10,790 lines, 410 KB, 59% of the addon | same |
| Functions in `ClaudeWoW.lua` | 656 (`Q.` 196, `Cli.` 148, `ClaudeWoW.` 133, `Whisper.` 38, `Presence.` 12, 123 file-local) | `grep -c '^function Q\.'` and friends |
| Main-chunk locals in `ClaudeWoW.lua` | **189 of the 200 Lua 5.1 allows**; `tests/order_check.js` already budgets 190 | `luaparse` count, same as `order_check.js` |
| Longest functions | `RunCommand` 365 lines, `BuildUI` 296, `ClaudeWoW.Render` 159, `Tick` 151, `Q.BuildQuestFrames` 136, `RefreshStrip` 128, `ClaudeWoW.Send` 125 | awk over `^function` boundaries |
| Fields on the `run` state table | 111 distinct, none declared | `grep -o 'run\.[A-Za-z_]*' \| sort -u` |
| `db.settings` keys | 24 in the core, plus per-module keys | same shape |
| Commits that touch `ClaudeWoW.lua` | 250 of 895 (28%) | `git log --oneline -- addon/ClaudeWoW/ClaudeWoW.lua` |
| Unmerged local branches | 11; open PRs: 0 | `git branch --no-merged origin/main`, `gh pr list` |
| Addon test VM boot | about 190 ms per `fengari` VM; `tests/addon_test.js` alone 113 tests in 21.7 s | `time node --test tests/addon_test.js` on Node 24 |
| Test files that build their own Lua VM | 30, each with a copied `newVM` | `grep -c luaL_newstate tests/*.js` |
| Lua lint or formatter | none (`luacheck`, `stylua`, `selene` not installed, no config in the repo) | `which`, `git ls-files` |
| Leaked globals | one: `_` in `Q.OpenQuest` (`_, _, index = Q.QuestTitle(id)` with no `local`) | `luajit -bl` and grep for `GSET` |

### 1.2 What is already right, and stays

- Every optional game API goes through `Try` or `pcall`, so one client (Forever 16001, Classic Era 11509) never breaks the other. 70 `pcall` sites in the core alone.
- No global leaks beyond the module tables (`ClaudeWoW`, `ClaudeWoWRoll`, ...). The bytecode scan above found exactly one stray write.
- The widget sandbox (`Widgets.lua`) is an allowlist with a proxy membrane, not a denylist. Frame kinds, templates, game functions and timers are each enumerated.
- The UI uses Blizzard templates and atlases, each guarded by `C_XMLUtil.GetTemplateInfo` or `C_Texture.GetAtlasExists` with a plain fallback.
- The wire protocol is versioned (`ClaudeWoW.Version.PROTO`, `Verdict`), and every transport has a fallback below it (chat log, screenshot, pixel strip, reload).
- The tests drive the real Lua in a VM with a 819-line stub of the client, through whole sessions. CI pins every action by SHA, runs on three OSes and two runtimes, and the release is packaged by the BigWigs packager with a byte-for-byte check.

The refactor keeps all of this. Nothing below changes behaviour; every phase is a pure restructuring with the same tests green before and after.

### 1.3 Findings, ranked by value to fix

**F1. One file at the compiler's limit.** `ClaudeWoW.lua` has 189 of the 200 main-chunk locals Lua 5.1 permits. The repo guards this with a budget in `tests/order_check.js` and a hint to "fold constants into a table", which is why constants have been piling into `Q.` and `Cli.` instead of being named locals. The next feature that needs two top-level locals fails to load. The file is also the most-changed file in the repo (28% of commits), so every parallel session edits it and every rebase conflicts in it.

**F2. Modules talk through 17 globals.** `ClaudeWoWRoll`, `ClaudeWoWTelemetry`, `ClaudeWoWOrders`, `ClaudeWoWMap` and 13 others are global tables, and the core reads them at about 130 sites, each behind `if ClaudeWoWX then`. The addon loader's private namespace (`local ADDON_NAME, ns = ...`, one table handed to every file in the toc) is documented in the repo's own `docs/WOW-ADDON-PRIMER.md` and used by nearly every maintained addon, but not here. The test VMs push only the addon name as the vararg, so they would hand each file a `nil` namespace today.

**F3. Helpers copied per file.** `Try` exists 6 times (core, `Map`, `Window`, `Observed`, `Telemetry`, `Voice`), `Print` 7 times, `Settings` 5 times, `Trim` and `Display` twice. The chat prefix `|cff66ccff[Azeroth Companion]|r ` is a literal in at least four files. Each copy drifts: three `Try` variants return different numbers of values.

**F4. State is a bag.** `run` carries 111 undeclared fields and is reset by reassignment in `PLAYER_LOGIN`, so a field set before login is silently lost. Saved settings are migrated by ad-hoc boolean flags (`autoRefreshV2`, `whisperV3`, `echoV2`, `chatsPerCharacterV1`, `pluginsV1`, `miniBarV2`, `contextWarnV2`, `loginNoticeV1`) spread across `InitDB`, `MigrateWhisper` and `MigrateMiniBar`, and modules write `ClaudeWoWDB.settings` directly (`Telemetry.lua` 8 sites, `Stream.lua`, `Roast.lua`, `Achievements.lua`).

**F5. Rendering is whole-transcript, every time.** `ClaudeWoW.Render` lays out every message of the active chat (up to `MAX_HISTORY` = 200) on every call: it sets text and reads `GetStringHeight` per bubble, which forces a layout. There are 82 call sites of `Render`, `RenderChatList` or `UpdateStatus`, and the 2-second `Tick` reaches `Render` through `CheckConnection` whenever the connection key changes. There is no dirty flag, no cached height, and no append-only path for the common case (one new message). In-game cost is **(unverified)**; `/claude diag` already prints addon memory and CPU, which is the before/after instrument.

**F6. No Lua lint, no formatter.** JavaScript has `oxlint` and `oxfmt` in CI; Lua has nothing. The bytecode scan found the `_` leak in minutes; `luacheck` finds that class of bug on every push, plus unused variables, shadowing and unreachable code. Hot globals (`type` 377 reads, `table` 289, `ipairs` 204 in the core) are never localized, which Blizzard's own UI code and every performance-minded addon does in hot paths.

**F7. Six tables describe the same commands.** `COMMAND_ARGS`, `Cli.CLAUDE_VERBS`, `Cli.CONFIG_KEYS`, `Cli.CONFIG_HELP`, `Cli.MODULE_SUBCOMMANDS` and `ClaudeWoW.HELP` each list verbs by hand, and `RunCommand` dispatches them with a 365-line `if`/`elseif` chain. A verb present in one table and absent from another silently becomes a chat message (the `/claude n` incident in the project notes is this failure).

**F8. Copy-pasted dialog and tooltip boilerplate.** 15 `StaticPopupDialogs` entries repeat the same `OnShow`/`OnAccept`/`EditBoxOnEnterPressed`/`EditBoxOnEscapePressed` block; 19 `GameTooltip:SetOwner` blocks in the core repeat the same four lines.

**F9. The test harness is copied 30 times.** Each addon test file has its own `newVM` that creates a `fengari` state, loads `tests/wow_stub.lua`, then a hand-written file list. Adding an addon file means editing up to 24 tests and `order_check.js`. The VM boot parses 410 KB of Lua per test: about 350 VM boots per `npm test`, roughly a minute of parsing **(estimate from the 190 ms per boot measured above)**.

**F10. Four timers and four `OnUpdate` drivers.** `Tick` (2 s), `Whisper.Pulse` (1 s), `Telemetry.Pump` (5 s) and the `LootRoll` hold ticker (0.25 s) run independently, plus `OnUpdate` scripts in `Window`, `LootRoll`, `Map` (two) and the strip. They do not share a clock or a frame budget.

**F11. The layout is written into the docs as an invariant.** `docs/ARCHITECTURE.md` says "`ClaudeWoW.lua` is a single file; sections in order: ..."; `CONTRIBUTING.md` describes it as "everything"; `order_check.js` lists files by hand instead of reading the toc. The split must update all three in the same PR.

**F12. Help content lives in the wrong file.** `ClaudeWoW.HELP` (the command reference) is an 80-line table in the core; `Help.lua` only renders it. With a command registry (F7) the help text comes from the registry and this table goes away.

### 1.4 The bridge (Node)

See §8; filled in from the bridge review.

## 2. The standards adopted, and where they come from

| Practice | Source | Applied here as |
|---|---|---|
| One private namespace table per addon, handed to every file by the loader (`local ADDON_NAME, ns = ...`) | Blizzard's addon loader; WoWAce/Ace3 convention; the repo's own primer | `ns` replaces the `ClaudeWoWX` globals for inter-module calls; the public `ClaudeWoW` global stays for widgets and the dev console |
| Small files, one concern each, listed in load order in the toc with subfolders | Blizzard FrameXML layout; WeakAuras, ElvUI, Details!, DBM | §3 layout |
| Static analysis in CI with a generated globals list | WeakAuras, ElvUI, DBM, Questie, Bagnon all run `luacheck` on every push | `.luacheckrc` whose `read_globals` come from the bytecode scan, so it is exact for this codebase, and a `luacheck` step in the `lint` job |
| Frame and font-string pools, mixins, a registry for events and messages | Blizzard `Pools.lua`, `Mixin.lua`, `EventRegistry`, `CallbackRegistryMixin` | bubble and row pools through `CreateFramePool` where the client has it **(verify on Era 11509)**, one event dispatcher in `Core/Events.lua` |
| Defaults table and versioned migrations for saved variables | AceDB-3.0's defaults, Blizzard's `SavedVariables` version fields | `Core/State.lua`: one `DEFAULTS` table, one ordered `MIGRATIONS` list with integer versions, modules read settings through `ns.Settings` |
| Redraw only what changed | Blizzard's `ScrollBoxListMixin` data providers; every tracker addon | dirty flags per chat, cached heights per message, append path |
| A formatter with a one-time repo-wide commit in `.git-blame-ignore-revs` | the repo already did this for JS with `oxfmt`; `StyLua` is the standard Lua formatter | owner decision, §7 |

Not adopted: embedding Ace3 (AceAddon, AceEvent, AceDB). The patterns are worth more than the libraries here: the test VM would have to load and stub several thousand more lines, the addon has no profile switching or options-table needs that AceConfig solves, and the transport code is unlike anything Ace3 abstracts. `LibStub` and `CallbackHandler-1.0` (about 300 lines together) can come in later if intra-addon messaging outgrows `Core/Events.lua`.

## 3. Target layout

```
addon/ClaudeWoW/
  ClaudeWoW.toc                 load order below, subfolders with backslashes
  Codec.lua                     unchanged: pure Lua, no WoW calls
  Inbox.lua                     unchanged: the bridge overwrites it
  Core/
    Namespace.lua               ns, product constants, Try, Trim, Display, Wire, Link, Flat, Fmt*, Contains, Money (one copy each)
    Log.lua                     ns.Print, ns.Say, ns.TellPlayer with the one prefix
    State.lua                   db: InitDB, DEFAULTS, MIGRATIONS; run: declared fields; chats: NewId, FindChat, ActiveChat, AddChat, AddHistory
    Events.lua                  ns.On(event, fn), ns.Off, ns.Fire(message, ...), one frame, one dispatcher
  Transport/
    Strip.lua                   EnsureStrip, ShowStrip, HideStrip, StripCodec, RecordFor, RefreshStrip
    Screenshot.lua              ScreenshotMode, CVars, ShotStatus, TakeScreenshot, ScreenshotDone, ApplyTransport
    ChatLog.lua                 ClaudeWoW.ChatLog
    Signals.lua                 Presence, CheckSignal, activity files, SelfTestSignals, BridgeState, Connect
    Slots.lua                   TryLoadSlot, ApplyInbox, ProcessInbox, Version, ImportRestore
    Tick.lua                    Tick, PollLate, GiveUp
  Chat/
    Send.lua                    Send, SendForget, SendCancel, SayHello, Resend, OpenUrl, SendDmNext
    Replies.lua                 ApplyReplies, Finish, FinishQuiet, LateReply, NoteUsage, ContextWarning
    Grants.lua                  AllowAlways, AllowOnce, PassOnDenial, ConfirmAllow, GrantGate, denial text
    Context.lua                 GameContext, SkillLines, talents, Polestar, ExpandLinks, TooltipLines
    Options.lua                 projects, agents, plugins, effort, MCP, add-dirs (the Cli.* option helpers)
    Sessions.lua                SessionEntries, resume picker, AttachTo, ResumeAll, handoff
  Whisper/
    Tabs.lua                    FrameFor, Adopt, Retitle, Flash, Close
    Reply.lua                   Reply, Body, Progress, Sent, BridgeLine, Pulse
    Intercept.lua               HookPreSend, Intercept, leak filter, ReplyName, OfferReply
  UI/
    Frame.lua                   BuildUI, Toggle, Suspend, header buttons
    Transcript.lua              bubbles, notes, empty state, Render
    ChatList.lua                quest-log list, legacy list, headers, rows, RenderChatList
    Menu.lua                    ShowMenu, native and fallback menus
    Minimap.lua                 minimap button, signal, drag
    Markdown.lua                MarkFences, StripSummary, MarkdownLine, RichText, links
    Popups.lua                  one factory for the edit-box dialogs; the 15 StaticPopupDialogs entries
    Copy.lua                    ShowCopy
    Window.lua                  unchanged: dodging, dimming, layout
  Commands/
    Registry.lua                one table: verb -> { args = <checker>, help = <row>, run = <fn>, config = <bool> }
    Claude.lua                  ParseCli, RunCli, /claude entry
    Config.lua                  /claude config and the ui subcommands
    Diag.lua                    diag, probe, slots, errors
  Features/
    Map.lua, Roast.lua, Stream.lua, Voice.lua, LootRoll.lua, Achievements.lua,
    Orders.lua, DM.lua, Widgets.lua, Telemetry.lua, Observed.lua, Help.lua, Dev.lua   (moved, then de-duplicated)
  Boot.lua                      the ADDON_LOADED / PLAYER_LOGIN sequence; checks ns.files against the toc list
```

Rules of the layout:

- `ClaudeWoW` (the global) keeps every name that something outside the addon reads: widgets through the sandbox, `/dump` in the dev console, `tests/*` and `dev/wow/client.js`. Everything else moves to `ns` and is file-local where it can be.
- No file above 1,200 lines and no function above 80 lines, enforced by `order_check.js` (renamed `tests/addon_check.js`), which reads the toc instead of a hand list.
- A file registers itself in `ns.files` at its end. `Boot.lua` compares that set with the toc list it embeds and, if a file is missing, prints one line ("restart the game to load the new addon files") and stops instead of erroring on a nil `ns` function. This is the guard for the client's launch-time file index (see `docs/ARCHITECTURE.md`, "files on disk"): a `/reload` after an update that adds files does not load them.

## 4. Order of work

Each phase is one PR unless noted, lands with the full suite green, and changes no behaviour. The suite is the safety net: 350 addon tests through the real Lua, plus the e2e tests through the real bridge.

| Phase | What | Size | Risk | Gate |
|---|---|---|---|---|
| 0 | This plan. `.luacheckrc` generated from the bytecode scan; `luacheck` in the CI `lint` job; fix the `_` leak. `tests/lua/vm.js`: one VM builder that reads the toc and passes `(ADDON_NAME, ns)`; the 30 copies use it. `order_check.js` reads the toc. | M | none: tooling and tests only | CI green, `luacheck` at 0 warnings on the current code (the config starts with the warnings it has to allow, listed in the file, and each later phase removes some) |
| 1 | `Core/`: `ns`, one copy of each helper, `Log.lua`. Modules call `ns.Try`, `ns.Print`. Restart guard in `Boot.lua`. The bridge's install step reports a toc file-list change so the in-game notice says "restart", not "/reload" (`addonDisk.restart`). | M | low: additive, old globals kept | the `if ClaudeWoWX then` count drops to the optional-module checks only |
| 2 | `Transport/`: strip, screenshot, chat log, signals, slots, tick. | L | medium: the most state-heavy code; `addon_test.js` covers it end to end | `addon_test.js`, `chatlog_test.js`, `telemetry_addon_test.js`, e2e delivery tests |
| 3 | `Chat/`: send, replies, grants, context, options, sessions. | L | medium | `addon_test.js`, `lootroll_test.js`, `polish5_*`, e2e permissions |
| 4 | `Whisper/` and `UI/`: transcript, chat list, menu, minimap, markdown, popups through one factory. | L | low: UI code is leaf code | `window_addon_test.js`, `minimap_addon_test.js`, `naming_addon_test.js`, `options_addon_test.js` |
| 5 | `Commands/Registry.lua`: one table per verb; `RunCommand` becomes a lookup; `COMMAND_ARGS`, `CLAUDE_VERBS`, `CONFIG_KEYS`, `CONFIG_HELP`, `MODULE_SUBCOMMANDS` and `ClaudeWoW.HELP` are derived from it. A test asserts every verb has args, help and a runner. | M | low | `addon_test.js` command cases, `options_addon_test.js`, the help page test |
| 6 | `Core/State.lua`: `DEFAULTS`, ordered `MIGRATIONS` guarded by the legacy flags (no `db.schema` integer: a new field would change every install's saved data, which the fixture forbids), `run` fields declared in `RUN_FIELDS`, modules read settings through `ns.Settings`. Done: `tests/fixtures/state_migrations.json` holds `InitDB`'s result for 50 historical shapes, generated once from `origin/main`. | M | medium: migrations must reproduce today's flag logic exactly; a test loads each historical saved-variables shape | `polish5_v1_test.js` (whisper migrations), `state_migrations_test.js`, `run_fields_test.js` |
| 7 | Render: dirty flags per chat, cached heights per message, append-only path, `Tick` never calls `Render` unless something changed. Measure with `/claude diag` before and after. | M | medium | numbers in `docs/plans/measurements/` |
| 8 | Test speed: shared VM builder already in place; compile the addon once per test file with `string.dump` (`fengari` ships `ldump.js`) and load bytecode per test. Measure. | S | low | `npm test` wall time before and after |
| 9 | Optional, owner decision: `StyLua` repo-wide with a `.git-blame-ignore-revs` entry; `ScrollBoxListMixin` for the transcript where the client has it **(verify on Era 11509)**. | M | low | — |

Phases 2 to 4 can go in any order and in parallel sessions, since each moves a disjoint section. Phase 5 depends on 1. Phases 6 and 7 depend on 2 to 4.

## 5. Rules for every refactor PR

1. No behaviour change. A PR that fixes a bug found on the way says so in its description and adds the test; it does not hide the fix in a move.
2. Move, then rename. The first commit moves code verbatim into the new file (so `git log --follow` and `git blame -M` keep history); the second commit renames and de-duplicates.
3. Every public name the old file exported stays reachable at the same path (`ClaudeWoW.X`, `Q.X`, `Cli.X`) until Phase 5, so tests and the dev console keep working between phases.
4. `luacheck` at 0 warnings for the files the PR touches; the allowlist in `.luacheckrc` only shrinks.
5. The docs sweep from the project notes: `grep -n '<file>.lua' docs/ARCHITECTURE.md README.md CONTRIBUTING.md` and update every hit in the same PR; `CHANGELOG.md` gets an `[Unreleased]` line when the player must restart the game.
6. A PR that adds a file ships the restart guard (Phase 1) first, or it breaks every player who `/reload`s after the update.

## 6. Measurements

After Phase 5 (`origin/main` at `22e5b3b`, 2026-10-17), against the numbers in §1.1:

| Measure | Before (`f7f3a12`) | After Phase 5 |
|---|---|---|
| `ClaudeWoW.lua` | 10,790 lines, 189 main-chunk locals | 612 lines, 29 locals |
| Addon Lua files | 17 | 48 (`Core/` 3, `Transport/` 6, `Chat/` 6, `Whisper/` 3, `UI/` 9, `Commands/` 4, `Boot.lua`, the features) |
| Largest file | `ClaudeWoW.lua` | `Widgets.lua` 1,354 (unchanged), then `Chat/Options.lua` 1,271 |
| Highest main-chunk locals | 189 | 83 (`Orders.lua`) |
| Private copies of `Try` / `Print` / `Settings` | 6 / 7 / 5 | 0 / 0 / 6 after Phase 5; 0 / 0 / 0 after Phase 6 (`ns.Settings`, `ns.Setting`; `Roast.lua` and `Stream.lua` keep a `RoastDB` / `StreamDB` helper for their own tables, read through `ns.db`) |
| `if ClaudeWoWX then` guards in the core file | 22 | 1 (the rest moved with their code) |
| Lua lint and formatter | none | `luacheck` 0 warnings on 48 files, StyLua checked, both in CI; 7 findings fixed in Phase 0 |
| Unit tests | 1,440 (1,431 pass, 9 skipped) | 1,448 (1,439 pass, 9 skipped) |
| Command behaviour pinned | by hand in 6 tables | `tests/fixtures/commands.json`, 52 verbs x 28 inputs from main, byte-equal |

Still to take, before and after Phases 7 and 8: `/claude diag` addon memory and CPU after a fixed script (login, open the window, 20 messages in one chat, 5 chats), and `npm test` wall time with `tests/addon_test.js` alone (21.7 s on Node 24 before Phase 0).

## 7. Decisions for the owner

1. **Formatter.** Run `StyLua` once over `addon/` (tabs, 160 columns, matching `.editorconfig` and the JS width), with the commit in `.git-blame-ignore-revs`? It touches every Lua line once; with 0 open PRs the cost is lowest now. Recommendation: yes, as the last commit of Phase 0.
2. **Local tooling.** Install `luacheck` and `stylua` on this machine (`brew install luacheck stylua`) so sessions run them before pushing, instead of waiting for CI? Recommendation: yes.
3. **Subfolders in the addon.** `Core\Namespace.lua` paths in the toc are standard and the BigWigs packager ships them, but every doc and the `setup.js` installer must copy the tree, not a flat list. Recommendation: subfolders.
4. **Go-ahead.** Phases 1 to 5 under the standing merge-and-deploy approval, one PR each, docs swept, no questions between them unless a phase finds a real bug. Recommendation: yes, in order 0, 1, 2, 3, 4, 5.

## 8. The bridge

Reviewed in parallel, same checkout, same rules. The bridge is careful at its edges (`gamefs.js` opens with `O_EXCL|O_NOFOLLOW`, refuses hard links and checks folder identity; the lock file checks pid start time; child process groups are killed with a grace period) and loose in the middle.

### 8.1 Findings

- **B1. `bridge.js` runs at `require` time.** 4,061 lines; reading config, taking the lock, installing signal handlers and starting the loops all happen at module load, so no unit test can load it in-process. All 10 unit files and 49 e2e files that need it spawn it as a child. 20 module-level `let` bindings and about 15 top-level `Map`/`Set` tables hold the state; `state` is handed to other modules as a closure and mutated by `protocol.js`, `clients.js`, `maphold.js` and `sessions.js`; `saveState()` has 46 call sites, each with an fsync.
- **B2. Long functions.** `runAgent` is about 630 lines and mixes a pure plan (what to run, with which flags), file writes, the spawn, and the stream parser wiring. `submit` is about 110 lines; `finish` re-enters itself through `Promise.race`.
- **B3. 15 copies of "write a temp file and rename".** Three temp-name schemes, fsync in one of them, a fixed `file + '.tmp'` name in `atomicWrite` (two concurrent writers collide). `pidAlive` exists four times with two different meanings of `EPERM`. `readJson` four times, `isDirectory` twice, the map and widget side-file pipelines are the same 80 lines twice.
- **B4. Silent failures.** 24 empty `catch {}` in `bridge.js`, 11 in `service.js`, 7 in `releases.js`. `takeMapCommands` and `takeWidgetCommands` swallow every read error, so an `EACCES` reads as "no commands". The unhandled-rejection handler exits the process with code 70; the `.then` in `nameChat` calls `publish()` with no catch, so a throw there would take the bridge down over a chat title.
- **B5. Timers.** The 5-minute screenshot sweeper keeps running after `fallbackToPixel` closes the watcher (it is `unref`'d, so it does not block exit); `roomNewsTimer` is not cleared in `shutdown`.
- **B6. Config written from two processes.** `allowRules` edits `cfg.agents` in memory, re-reads `config.json` and rewrites it; `setup.js` writes the same file. No lock.
- **B7. `protocol.js`** is 2,071 lines and about 130 exports across eight concerns (dedup, usage, strip flags, prompts, permissions, Lua emit, map, macros, widgets). Honest about purity, hard to navigate.
- **B8. Tooling gaps.** `oxlint` runs only the `correctness` category (`suspicious`, `perf` and `import/no-cycle` are off, `caughtErrors: none` hides unused catch bindings); no `.nvmrc` while CI pins Node 22 and this machine runs 24; `package.json` has no `"type"`; `setup.js` re-implements the `engines` check that `.npmrc` `engine-strict=true` provides. `selfupdate.js` requires the build script `build.js` at runtime for its target list.
- **Measured.** `npm test` on Node 24: 68 s wall, 1,440 tests, 1,431 pass, 9 skipped, 0 fail.
- **Path traversal into the game folder: low.** Slot paths are fixed names under the client's addon folder, side-file names sanitize the chat id, job ids are numbers. One item to confirm: whether `gameFolders()` gates `opts.cwd` the way it gates `addDirs` **(unverified)**.

### 8.2 Bridge work, in value order

| # | What | Size | Risk |
|---|---|---|---|
| 1 | `bridge/fsutil.js`: `atomicWrite` (random temp name, fsync, mode), `readJson`, `pidAlive` (one meaning of `EPERM`), `isDirectory`; the 15 copies use it | M | low |
| 2 | Clear the sweeper in `fallbackToPixel`; clear `roomNewsTimer` in `shutdown` | S | none |
| 3 | Catch in `nameChat`'s `.then`; log non-`ENOENT` errors in `takeMapCommands` and `takeWidgetCommands` | S | none |
| 4 | One `sideFile(kind)` pipeline for map and widget commands | S | low |
| 5 | Lint: `suspicious` and `import/no-cycle` on (warn, then deny), `no-empty` on; `.nvmrc` = 22; `"type": "commonjs"`; `.npmrc` `engine-strict=true` | S | low |
| 6 | `publisher.js`: `sharedSlotFields`, `slotFile`, `publishClient`, `publishNow`, `publish`, `keepReply`, `restoreReplies` behind `{ state, live, clients }`, unit-tested without a child process | M | medium |
| 7 | `runAgent` split into a pure `planRun(job, opts)` and `spawnRun(plan)`; the plan gets unit tests | M | medium |
| 8 | `protocol.js` split by concern with the old file kept as a re-export barrel, so the 20 importers do not change | M | low |
| 9 | A state store with `update()` and a debounced `save()` in place of 46 direct saves | M | medium |
| 10 | `main()` at the bottom of `bridge.js` and `createBridge(deps)` for the rest, so the file loads in a unit test | L | medium |

Bridge items 1 to 5 are small and go first. The addon phases and the bridge items are independent and can run in separate sessions.
