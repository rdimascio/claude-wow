# Live UI widgets

Ask the agent for a small UI element (*"give me a DPS meter"*, *"a timer bar for my buffs"*) and it appears in the game a moment later, with no `/reload`. The agent writes addon Lua. The bridge checks it, keeps it versioned and ships it in the slot files. The addon runs it in a sandbox that offers only display APIs.

## How a widget gets from the agent to the game

1. The system prompt of a game chat tells the agent the contract (`WIDGET_HINT` in `bridge/protocol.js`), on every plugin whose `surfaces` include `ui` (`ask` and `claude-code` both do). The agent ends its reply with a block:

   ````
   ```wowui dps title="DPS meter"
   local ui = ...
   local f = CreateFrame("Frame", nil, ui.frame, "BackdropTemplate")
   ...
   ```
   ````

   Or its tools append one JSON object per line to the file in `CLAUDE_WOW_UI_FILE` (set for every run of a plugin with the `ui` surface, in `~/.claude-wow/uijobs/`):

   ```json
   {"op":"set","name":"dps","title":"DPS meter","source":"local ui = ...\n..."}
   {"op":"remove","name":"dps"}
   {"op":"clearall"}
   ```

   A ```` ```wowui <name> remove ```` block with an empty body also removes a widget. The bridge takes the blocks out of the reply and leaves `[UI widget "dps"]` in their place.
2. When the run ends, the bridge validates each widget (`protocol.js`): a name of letters, digits, `_ . -` (at most 32), at most 16,000 bytes of source, at most 8 widgets and 64,000 bytes in total (the oldest go first). It refuses a widget whose source names a protected or outward action (see [Two checks](#two-checks)). A widget with the same name replaces the old one. The reply gets a `[bridge] ui: ...` line that says what changed or why a widget was refused.
3. The widgets live in `state.json` (`widgets`, with an epoch and a version). The next slot files carry the whole set for three minutes after a change, and again after every hello, the same way as the map layers. The addon replaces its copy when the version is newer, so a widget never runs twice, and a client that lost its saved data gets its widgets back.

## The widget contract

The source is the body of a function. `local ui = ...` gives:

| Field | What it is |
|---|---|
| `ui.name`, `ui.title` | the widget's name and title |
| `ui.frame` | the widget's full-screen container frame. `UIParent` in a widget is this frame, and frames created with no parent go in it |
| `ui.db` | a table saved between sessions (for a position, a setting) |
| `ui.print(text)` | print a line to the game chat |

## Two checks

- **Bridge deny-list.** `validateWidgetCommand` refuses a source that names a protected or outward action anywhere in its text: casting, using actions and items, macros (`CastSpellByName`, `UseAction`, `RunMacro`, `RunMacroText`, ...), targeting and movement (`TargetUnit`, `AssistUnit`, `MoveForwardStart`, ...), chat and addon messages (`SendChatMessage`, `SendAddonMessage`, `BNSendWhisper`), groups, trade, mail, bindings, CVars, `ReloadUI`, `LoadAddOn`, `SlashCmdList`, `hooksecurefunc`, `securecall`, `loadstring`/`setfenv`/`getfenv`/`rawget`/`debug`, any `Secure...Template`, any `ClaudeWoW*` global, and the events only the Blizzard UI may register. The list is `WIDGET_DENIED_NAMES` in `bridge/protocol.js`. It is a fast first refusal with a clear message, not the boundary: a name built at run time (`"Cast" .. "Spell"`) passes it.
- **Addon allowlist and membrane.** `Widgets.lua` is the boundary. Each widget runs with its own environment. A global resolves only when it is on the allowlist below; every other global is `nil`. The names on the deny-list resolve to a function that raises "is not allowed in a widget" (a test keeps `DENIED_NAMES` in `Widgets.lua` equal to `WIDGET_DENIED_NAMES`). Every frame, region and game object the widget touches is a proxy (the membrane), so a widget never holds a Blizzard frame or a real frame of its own.

## What a widget can use

| Kind | What resolves |
|---|---|
| Frames | `CreateFrame(kind, name, parent, template)`. `kind` is one of `FRAME_KINDS`: `Frame`, `Button`, `CheckButton`, `Slider`, `StatusBar`, `ScrollFrame`, `EditBox`, `Cooldown`, `ColorSelect`, `MessageFrame`, `ScrollingMessageFrame`, `SimpleHTML`, `Model`, `PlayerModel`, `DressUpModel`, `GameTooltip`. The name is ignored, so a frame never gets a global name. The parent is `nil`, `ui.frame` or a frame the widget made. |
| Templates | `TEMPLATES`, the same list as `WIDGET_TEMPLATES`: `BackdropTemplate`, `TooltipBackdropTemplate`, `TooltipBorderedFrameTemplate`, `BasicFrameTemplate`, `BasicFrameTemplateWithInset`, `InsetFrameTemplate`, `UIPanelButtonTemplate`, `UIPanelCloseButton`, `UICheckButtonTemplate`, `InputBoxTemplate`, `OptionsSliderTemplate`, `UIPanelScrollFrameTemplate`, `GameTooltipTemplate`. Several, comma-separated, are fine. |
| Regions | `CreateFontString`, `CreateTexture`, `CreateMaskTexture`, `CreateLine`, `CreateAnimationGroup` and `CreateAnimation` on the widget's frames. The name argument is dropped. |
| Frame methods | Every method of a frame the widget made, through the proxy. Arguments may be plain values, the widget's own frames and regions, and font objects; any other table reaches the method as the proxy, not a real frame. Return values are filtered (below). |
| Scripts and events | `SetScript`, `HookScript`, `GetScript`, `RegisterEvent`, `RegisterUnitEvent`, `OnUpdate`. Each handler runs in a `pcall`. `UNIT_COMBAT` gives damage and heals on a unit. |
| Timers | `C_Timer.After`, `C_Timer.NewTicker`, `C_Timer.NewTimer`. A ticker or timer handle has `Cancel` and `IsCancelled` only. Stopping the widget cancels its tickers. |
| `Unit*` readers | Any global function named `Unit<Word>...` whose first word is not a writer verb (`UNIT_WRITER_VERBS`: `Set`, `Switch`, `Clear`, `Popup`, `Frame`, `Select`, `Toggle`, `Use`, `Cast`, `Target`). So `UnitHealth`, `UnitAura` and `UnitClass` resolve and `UnitSetRole` does not. |
| Game getters | The fixed list `GAME_FUNCTIONS`: time and frame rate, money and number formatting, zone and instance text, spell, item, inventory and container info, combat ratings, group and raid roster, combo points, forms, totems, action bar state, quest log and skill lines, factions, talents, `GetClassColor`, `GetUnitName`, `GetRaidTargetIndex`, state checks such as `InCombatLockdown`, `IsMounted`, `IsSpellInRange` and modifier keys, and `PlaySound`/`PlaySoundFile`. A `Get*` function that is not on this list is `nil`. |
| `C_` namespaces | A read-only proxy for every `C_*` table. Its functions whose name starts with `Get`, `Is`, `Has`, `Can`, `Does`, `Find`, `Are` or `Should` resolve; any other function raises "is not allowed in a widget"; nested tables are `nil`; writes raise an error. |
| Fonts | Font objects by name: `GameTooltipText`, `GameTooltipTextSmall`, `GameTooltipHeaderText`, `Tooltip_Med`, `Tooltip_Small`, `TextStatusBarText`, `ChatFontNormal`, `ChatFontSmall`, and the families `GameFont*`, `NumberFont*`, `SystemFont_*` and `QuestFont*`. A widget can pass one to `SetFontObject` and read it with `GetFont`, `GetTextColor`, `GetShadowColor`, `GetShadowOffset`, `GetJustifyH`, `GetJustifyV`, `GetSpacing` and `GetObjectType`. It cannot change one. |
| `GameTooltip` | A proxy with the display methods only: `SetOwner`, `ClearLines`, `AddLine`, `AddDoubleLine`, `AddTexture`, `SetText`, `Show`, `Hide`, `IsShown`, `NumLines`, `SetUnit`, `SetUnitAura`, `SetUnitBuff`, `SetUnitDebuff`, `SetSpellByID`, `SetItemByID`, `SetHyperlink`, `SetInventoryItem`, `SetBagItem`, `SetMinimumWidth`, `SetPoint`, `ClearAllPoints`. `GameTooltip:SetOwner(self, "ANCHOR_TOP")` from a widget button works. |
| Data tables | Deep copies of `RAID_CLASS_COLORS`, `CLASS_ICON_TCOORDS`, `ITEM_QUALITY_COLORS`, `FACTION_BAR_COLORS`, `PowerBarColor`, `Enum` and `SOUNDKIT`. A widget changes only its own copy. |
| Lua | Copies of `math`, `string`, `table`, `bit` and `coroutine`, the base functions in `LUA_FUNCTIONS` (`pairs`, `pcall`, `select`, `tostring`, `setmetatable`, `date`, `time`, `strsplit`, `format`, `wipe`, `CopyTable`, `Mixin`, `CreateColor`, ...), and `getmetatable` for tables only. |
| Constants | Any global string, number or boolean (for example `STANDARD_TEXT_FONT`). |

`_G` in a widget is the widget's own environment, so `_G["Cast" .. "SpellByName"]` follows the same rules as a plain name.

### Values that come back from the game

- A frame or region the widget made comes back as the same proxy.
- A frame that sits under one of the widget's frames (a template's child, for example) comes back as a proxy of that widget.
- Any other game object (a Blizzard frame, the chat edit box, `UIParent`'s other children) comes back as `nil`. So `ui.frame:GetParent()` is `nil`, and `UIParent:GetChildren()` lists only the widget's frames.
- A plain table from a getter or an event (an aura from `C_UnitAuras.GetAuraDataByIndex`, the result of `C_NamePlate.GetNamePlates`) is copied deeply. Functions and foreign frames inside it are dropped.
- Writing a field on a widget frame: a string, number or boolean goes to the real frame (`button.tooltipText = "hi"`), unless the field is a method name. A function or table stays on the proxy, so it never replaces a method of the real frame.

## What is refused

| Refused | How |
|---|---|
| Every global not on the allowlist | it is `nil`: Blizzard frames (`DEFAULT_CHAT_FRAME`, `Minimap`, `PlayerFrame`, ...), `SlashCmdList`, `securecall`, `RunScript`, getters outside `GAME_FUNCTIONS`, and so on |
| A name on the deny-list | the bridge refuses the source; at run time the name raises "is not allowed in a widget" |
| `ClaudeWoW*` globals | `nil` (the bridge also refuses a source that names one) |
| Other frame types (`MovieFrame`, ...) and templates (any `Secure*`, `ChatFrameEditBoxTemplate`, ...) | `CreateFrame` raises an error |
| A parent that is not `ui.frame` or the widget's own frame | `CreateFrame` and `SetParent` raise an error |
| `SetScrollChild` with a frame the widget did not make, or with `ui.frame` | raises an error |
| The keyboard | `EnableKeyboard(true)`, `SetFocus`, `SetAutoFocus(true)` and `SetPropagateKeyboardInput(false)` raise an error. Widget edit boxes start with auto focus off, and Escape always clears their focus |
| The mouse on `ui.frame` | `EnableMouse(true)`, `EnableMouseWheel(true)`, `SetMouseClickEnabled(true)` and `SetMouseMotionEnabled(true)` on the full-screen container raise an error. Call them on a child frame |
| `RegisterAllEvents` | raises an error: register each event by name |
| Combat log and ping events | `COMBAT_LOG_EVENT`, `COMBAT_LOG_EVENT_UNFILTERED`, `COMBAT_LOG_APPLY_FILTER_SETTINGS`, `COMBAT_LOG_REFILTER_ENTRIES`, `MINIMAP_PING`, `UNIT_PING_PIN_ADDED`, `UNIT_PING_PIN_REMOVED` (`WIDGET_RESTRICTED_EVENTS`, `RESTRICTED_EVENTS`). This client lets only the Blizzard UI register them; an addon that tries gets the "blocked from an action only available to the Blizzard UI" popup. `CombatLogGetCurrentEventInfo` is on the deny-list. Use `UNIT_COMBAT` |
| `C_` functions that are not getters, nested `C_` tables, writes to a `C_` table or to `C_Timer` | raise an error or are `nil` |

## Changes from the first sandbox

The first sandbox gave a widget every global except a deny-list. The allowlist changes what a widget written for it can do:

- **No Blizzard frames.** `ChatFrame1`, `Minimap`, `PlayerFrame` and the other named frames are `nil`, and no getter hands one back. A widget cannot read or restyle Blizzard UI.
- **No global names.** `CreateFrame("Frame", "MyMeter")` makes a frame with no name, and `MyMeter` stays `nil`. Keep the frame in a local.
- **`UIParent` is `ui.frame`.** `SetPoint("CENTER", UIParent)` anchors to the widget's container, which covers the screen, so the layout is the same.
- **No `GameTooltip` anchoring or capture.** `GameTooltip` is a proxy with display methods only, so `f:SetPoint("BOTTOMRIGHT", GameTooltip)` never passes the real tooltip to the frame, and `SetScrollChild(GameTooltip)` or `SetParent` on it raise an error. `GameTooltip:GetParent`, `SetScript` and the other frame methods are `nil`. The tooltip still shows lines for a widget button through `SetOwner`. What the real client does with the proxy as an anchor was not measured; expect an error or no anchor.
- **Only listed getters.** A `Get*` or `Is*` global outside `GAME_FUNCTIONS` is `nil`, and a `C_` function that is not a getter raises an error. `/claude dev globals` and `npm run audit:widgets` (below) list what the real client has that the allowlist misses.
- **No keyboard, no mouse on the container.** A widget that turned on the keyboard or the mouse on `ui.frame` now fails at that call.
- **Copied tables.** `RAID_CLASS_COLORS` and the other data tables are copies; a change stays in the widget.

## Audit the allowlist against the real client

The allowlist was written from the API docs and the test stub. To check it against the client you play:

1. In game: `/claude dev globals`. The addon walks `_G` once and saves into `ClaudeWoWWidgetDB.globals` the sorted names of global functions named `Unit*`, `Get*`, `Is*`, `Has*` and `Can*`, every function on the allowlist, every function key of every `C_*` namespace (as `C_Name.Function`), and every font object whose name contains `Font` or is on the font list. Each name goes in `admitted` (a widget can use it) or in `refused` (functions) or `refusedFonts` (font objects), decided by the same functions the sandbox uses. It keeps at most 6,000 names, admitted first, and saves the client version, build, interface, time and the full counts. It prints how many it saved. It reads only; it calls nothing it finds. This command runs in the addon and does not need the bridge.
2. `/reload` (or log out), so the game writes the account SavedVariables file.
3. In the claude-wow checkout: `npm run audit:widgets`. It reads `ClaudeWoW.lua` in the SavedVariables folder of every client in `config.json` (or the files you name: `npm run audit:widgets -- <path>`), and lists:
   - admitted names whose first word is a writer or action verb (`Set`, `Send`, `Cast`, `Use`, `Play`, `Select`, ...): check each one;
   - refused names whose first word is a getter verb (`Get`, `Is`, `Has`, `Can`, ...), and refused `Unit*` readers: candidates to add to `GAME_FUNCTIONS`;
   - refused font objects.

   Each list shows 60 names; `--all` shows every name, `--json` prints the report as JSON. The verb is the first word of the function name, after the `C_` namespace or the `Unit` prefix. It exits 2 when no file holds a dump.
4. `/claude dev globals clear` drops the saved names.

## Errors

The first run is in a `pcall`, and so are the widget's script handlers (`SetScript`, `HookScript`) and timer callbacks. On an error, the addon stops the widget (hides its frames, unregisters their events and the handlers it put on `ui.frame`, cancels its tickers) and writes the error to the game chat and to the chat window. An error value that cannot be turned into text still stops the widget. `/claude config ui run <name>` tries again.

## In game

| Command | Does |
|---|---|
| `/claude config ui` or `/claude config ui list` | list the widgets: running, waiting for your OK, removed, or failed with the error (bare, it also shows the tab and window settings) |
| `/claude config ui remove <name>` | stop a widget and keep it off after login. It comes back only when the agent sends a new version |
| `/claude config ui run <name>` | start a widget again (after an error or a remove), or say yes to one that waits |
| `/claude dev globals [clear]` | save (or drop) the names the widget allowlist admits and refuses on this client, for `npm run audit:widgets` |

A widget runs only after the player says yes to that revision. `W.Start` refuses any revision that is not in `ClaudeWoWWidgetDB.approved[name]`, on both paths: a sync from the bridge (`W.Sync`) and the saved set at login (`W.Apply`). Each waiting widget opens one `CLAUDEWOW_WIDGET` popup at a time ("Show the agent's '<title>' widget?", the title through `Display`). **Show** stores `approved[name] = rev` and starts it; **Not Now** stores `removed[name] = rev`, as `remove` does. Both re-check that the revision is still current and was not removed. Escape is no answer: the widget waits and is asked again at the next login. When the popup system refuses (`StaticPopup_Show` returns nil, or cancels it), the widget stays queued and nothing is recorded. The **Widgets** page in the game's AddOns settings lists the widgets with **Remove** and **Show** buttons.

Widgets live in `ClaudeWoWWidgetDB` and approved ones start again at login, in the same sandbox. To delete a widget on the bridge too, ask the agent ("remove the DPS meter").
