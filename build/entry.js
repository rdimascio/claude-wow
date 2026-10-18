// The compiled binary's entry point (build.js: bun build --compile). Bun
// embeds a file imported with { type: 'file' } and resolves the import to the
// file's path inside the binary; bridge/assets.js reads them from there and
// writes them out where python and the game can see them. The list is
// assets.FILES, one import per file (tests/assets_test.js keeps the two in
// step). Then the supervisor, which is the claude-wow command. Bun only:
// from a checkout, node runs bridge/supervisor.js directly.
import addonCoreNamespace from '../addon/ClaudeWoW/Core/Namespace.lua' with { type: 'file' };
import addonCoreLog from '../addon/ClaudeWoW/Core/Log.lua' with { type: 'file' };
import addonCoreState from '../addon/ClaudeWoW/Core/State.lua' with { type: 'file' };
import addonTransportStrip from '../addon/ClaudeWoW/Transport/Strip.lua' with { type: 'file' };
import addonTransportScreenshot from '../addon/ClaudeWoW/Transport/Screenshot.lua' with { type: 'file' };
import addonTransportChatLog from '../addon/ClaudeWoW/Transport/ChatLog.lua' with { type: 'file' };
import addonTransportSignals from '../addon/ClaudeWoW/Transport/Signals.lua' with { type: 'file' };
import addonTransportSlots from '../addon/ClaudeWoW/Transport/Slots.lua' with { type: 'file' };
import addonTransportTick from '../addon/ClaudeWoW/Transport/Tick.lua' with { type: 'file' };
import addonChatContext from '../addon/ClaudeWoW/Chat/Context.lua' with { type: 'file' };
import addonChatSend from '../addon/ClaudeWoW/Chat/Send.lua' with { type: 'file' };
import addonChatReplies from '../addon/ClaudeWoW/Chat/Replies.lua' with { type: 'file' };
import addonChatGrants from '../addon/ClaudeWoW/Chat/Grants.lua' with { type: 'file' };
import addonWhisperTabs from '../addon/ClaudeWoW/Whisper/Tabs.lua' with { type: 'file' };
import addonWhisperReply from '../addon/ClaudeWoW/Whisper/Reply.lua' with { type: 'file' };
import addonWhisperIntercept from '../addon/ClaudeWoW/Whisper/Intercept.lua' with { type: 'file' };
import addonChatOptions from '../addon/ClaudeWoW/Chat/Options.lua' with { type: 'file' };
import addonChatSessions from '../addon/ClaudeWoW/Chat/Sessions.lua' with { type: 'file' };
import addonUiMarkdown from '../addon/ClaudeWoW/UI/Markdown.lua' with { type: 'file' };
import addonUiMenu from '../addon/ClaudeWoW/UI/Menu.lua' with { type: 'file' };
import addonUiMinimap from '../addon/ClaudeWoW/UI/Minimap.lua' with { type: 'file' };
import addonUiPopups from '../addon/ClaudeWoW/UI/Popups.lua' with { type: 'file' };
import addonUiCopy from '../addon/ClaudeWoW/UI/Copy.lua' with { type: 'file' };
import addonUiTranscript from '../addon/ClaudeWoW/UI/Transcript.lua' with { type: 'file' };
import addonUiChatList from '../addon/ClaudeWoW/UI/ChatList.lua' with { type: 'file' };
import addonUiFrame from '../addon/ClaudeWoW/UI/Frame.lua' with { type: 'file' };
import addonCommandsDiag from '../addon/ClaudeWoW/Commands/Diag.lua' with { type: 'file' };
import addonCommandsRegistry from '../addon/ClaudeWoW/Commands/Registry.lua' with { type: 'file' };
import addonCommandsClaude from '../addon/ClaudeWoW/Commands/Claude.lua' with { type: 'file' };
import addonCommandsConfig from '../addon/ClaudeWoW/Commands/Config.lua' with { type: 'file' };
import addonLua from '../addon/ClaudeWoW/ClaudeWoW.lua' with { type: 'file' };
import addonToc from '../addon/ClaudeWoW/ClaudeWoW.toc' with { type: 'file' };
import addonCodec from '../addon/ClaudeWoW/Codec.lua' with { type: 'file' };
import addonInbox from '../addon/ClaudeWoW/Inbox.lua' with { type: 'file' };
import addonMap from '../addon/ClaudeWoW/Map.lua' with { type: 'file' };
import addonRoast from '../addon/ClaudeWoW/Roast.lua' with { type: 'file' };
import addonStream from '../addon/ClaudeWoW/Stream.lua' with { type: 'file' };
import addonVoice from '../addon/ClaudeWoW/Voice.lua' with { type: 'file' };
import addonLootRoll from '../addon/ClaudeWoW/LootRoll.lua' with { type: 'file' };
import addonAchievements from '../addon/ClaudeWoW/Achievements.lua' with { type: 'file' };
import addonOrders from '../addon/ClaudeWoW/Orders.lua' with { type: 'file' };
import addonDM from '../addon/ClaudeWoW/DM.lua' with { type: 'file' };
import addonWidgets from '../addon/ClaudeWoW/Widgets.lua' with { type: 'file' };
import addonWindow from '../addon/ClaudeWoW/UI/Window.lua' with { type: 'file' };
import addonTelemetry from '../addon/ClaudeWoW/Telemetry.lua' with { type: 'file' };
import addonObserved from '../addon/ClaudeWoW/Observed.lua' with { type: 'file' };
import addonDev from '../addon/ClaudeWoW/Dev.lua' with { type: 'file' };
import addonHelp from '../addon/ClaudeWoW/Help.lua' with { type: 'file' };
import addonBoot from '../addon/ClaudeWoW/Boot.lua' with { type: 'file' };
import addonBindings from '../addon/ClaudeWoW/Bindings.xml' with { type: 'file' };
import addonPortrait from '../addon/ClaudeWoW/Portrait.tga' with { type: 'file' };
import addonMinimapIcon from '../addon/ClaudeWoW/MinimapIcon.tga' with { type: 'file' };
import capturePs1 from '../bridge/capture.ps1' with { type: 'file' };
import captureMac from '../bridge/capture_mac.py' with { type: 'file' };
import captureX11 from '../bridge/capture_x11.py' with { type: 'file' };
import configExample from '../bridge/config.example.json' with { type: 'file' };
import primer from '../docs/WOW-ADDON-PRIMER.md' with { type: 'file' };
import pluginManifest from '../assets/plugins/claude-wow/.claude-plugin/plugin.json' with { type: 'file' };
import pluginWowCode from '../assets/plugins/claude-wow/agents/wow-code.md' with { type: 'file' };
import pluginWowPlanner from '../assets/plugins/claude-wow/agents/wow-planner.md' with { type: 'file' };

require('../bridge/assets').embed({
  'addon/ClaudeWoW/Core/Namespace.lua': addonCoreNamespace,
  'addon/ClaudeWoW/Core/Log.lua': addonCoreLog,
  'addon/ClaudeWoW/Core/State.lua': addonCoreState,
  'addon/ClaudeWoW/Transport/Strip.lua': addonTransportStrip,
  'addon/ClaudeWoW/Transport/Screenshot.lua': addonTransportScreenshot,
  'addon/ClaudeWoW/Transport/ChatLog.lua': addonTransportChatLog,
  'addon/ClaudeWoW/Transport/Signals.lua': addonTransportSignals,
  'addon/ClaudeWoW/Transport/Slots.lua': addonTransportSlots,
  'addon/ClaudeWoW/Transport/Tick.lua': addonTransportTick,
  'addon/ClaudeWoW/Chat/Context.lua': addonChatContext,
  'addon/ClaudeWoW/Chat/Send.lua': addonChatSend,
  'addon/ClaudeWoW/Chat/Replies.lua': addonChatReplies,
  'addon/ClaudeWoW/Chat/Grants.lua': addonChatGrants,
  'addon/ClaudeWoW/Whisper/Tabs.lua': addonWhisperTabs,
  'addon/ClaudeWoW/Whisper/Reply.lua': addonWhisperReply,
  'addon/ClaudeWoW/Whisper/Intercept.lua': addonWhisperIntercept,
  'addon/ClaudeWoW/Chat/Options.lua': addonChatOptions,
  'addon/ClaudeWoW/Chat/Sessions.lua': addonChatSessions,
  'addon/ClaudeWoW/UI/Markdown.lua': addonUiMarkdown,
  'addon/ClaudeWoW/UI/Menu.lua': addonUiMenu,
  'addon/ClaudeWoW/UI/Minimap.lua': addonUiMinimap,
  'addon/ClaudeWoW/UI/Popups.lua': addonUiPopups,
  'addon/ClaudeWoW/UI/Copy.lua': addonUiCopy,
  'addon/ClaudeWoW/UI/Transcript.lua': addonUiTranscript,
  'addon/ClaudeWoW/UI/ChatList.lua': addonUiChatList,
  'addon/ClaudeWoW/UI/Frame.lua': addonUiFrame,
  'addon/ClaudeWoW/Commands/Diag.lua': addonCommandsDiag,
  'addon/ClaudeWoW/Commands/Registry.lua': addonCommandsRegistry,
  'addon/ClaudeWoW/Commands/Claude.lua': addonCommandsClaude,
  'addon/ClaudeWoW/Commands/Config.lua': addonCommandsConfig,
  'addon/ClaudeWoW/ClaudeWoW.lua': addonLua,
  'addon/ClaudeWoW/ClaudeWoW.toc': addonToc,
  'addon/ClaudeWoW/Codec.lua': addonCodec,
  'addon/ClaudeWoW/Inbox.lua': addonInbox,
  'addon/ClaudeWoW/Map.lua': addonMap,
  'addon/ClaudeWoW/Roast.lua': addonRoast,
  'addon/ClaudeWoW/Stream.lua': addonStream,
  'addon/ClaudeWoW/Voice.lua': addonVoice,
  'addon/ClaudeWoW/LootRoll.lua': addonLootRoll,
  'addon/ClaudeWoW/Achievements.lua': addonAchievements,
  'addon/ClaudeWoW/Orders.lua': addonOrders,
  'addon/ClaudeWoW/DM.lua': addonDM,
  'addon/ClaudeWoW/Widgets.lua': addonWidgets,
  'addon/ClaudeWoW/UI/Window.lua': addonWindow,
  'addon/ClaudeWoW/Telemetry.lua': addonTelemetry,
  'addon/ClaudeWoW/Observed.lua': addonObserved,
  'addon/ClaudeWoW/Dev.lua': addonDev,
  'addon/ClaudeWoW/Help.lua': addonHelp,
  'addon/ClaudeWoW/Boot.lua': addonBoot,
  'addon/ClaudeWoW/Bindings.xml': addonBindings,
  'addon/ClaudeWoW/Portrait.tga': addonPortrait,
  'addon/ClaudeWoW/MinimapIcon.tga': addonMinimapIcon,
  'bridge/capture.ps1': capturePs1,
  'bridge/capture_mac.py': captureMac,
  'bridge/capture_x11.py': captureX11,
  'bridge/config.example.json': configExample,
  'docs/WOW-ADDON-PRIMER.md': primer,
  'assets/plugins/claude-wow/.claude-plugin/plugin.json': pluginManifest,
  'assets/plugins/claude-wow/agents/wow-code.md': pluginWowCode,
  'assets/plugins/claude-wow/agents/wow-planner.md': pluginWowPlanner,
});
require('../bridge/supervisor');
