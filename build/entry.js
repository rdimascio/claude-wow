// The compiled binary's entry point (build.js: bun build --compile). Bun
// embeds a file imported with { type: 'file' } and resolves the import to the
// file's path inside the binary; bridge/assets.js reads them from there and
// writes them out where python and the game can see them. The list is
// assets.FILES, one import per file (tests/assets_test.js keeps the two in
// step). Then the supervisor, which is the wowgpt command. Bun only:
// from a checkout, node runs bridge/supervisor.js directly.
import addonCoreNamespace from '../addon/WoWGPT/Core/Namespace.lua' with { type: 'file' };
import addonCoreLog from '../addon/WoWGPT/Core/Log.lua' with { type: 'file' };
import addonCoreState from '../addon/WoWGPT/Core/State.lua' with { type: 'file' };
import addonTransportStrip from '../addon/WoWGPT/Transport/Strip.lua' with { type: 'file' };
import addonTransportScreenshot from '../addon/WoWGPT/Transport/Screenshot.lua' with { type: 'file' };
import addonTransportChatLog from '../addon/WoWGPT/Transport/ChatLog.lua' with { type: 'file' };
import addonTransportSignals from '../addon/WoWGPT/Transport/Signals.lua' with { type: 'file' };
import addonTransportSlots from '../addon/WoWGPT/Transport/Slots.lua' with { type: 'file' };
import addonTransportTick from '../addon/WoWGPT/Transport/Tick.lua' with { type: 'file' };
import addonChatContext from '../addon/WoWGPT/Chat/Context.lua' with { type: 'file' };
import addonChatSend from '../addon/WoWGPT/Chat/Send.lua' with { type: 'file' };
import addonChatReplies from '../addon/WoWGPT/Chat/Replies.lua' with { type: 'file' };
import addonChatGrants from '../addon/WoWGPT/Chat/Grants.lua' with { type: 'file' };
import addonWhisperTabs from '../addon/WoWGPT/Whisper/Tabs.lua' with { type: 'file' };
import addonWhisperReply from '../addon/WoWGPT/Whisper/Reply.lua' with { type: 'file' };
import addonWhisperIntercept from '../addon/WoWGPT/Whisper/Intercept.lua' with { type: 'file' };
import addonChatOptions from '../addon/WoWGPT/Chat/Options.lua' with { type: 'file' };
import addonChatSessions from '../addon/WoWGPT/Chat/Sessions.lua' with { type: 'file' };
import addonUiMarkdown from '../addon/WoWGPT/UI/Markdown.lua' with { type: 'file' };
import addonUiMenu from '../addon/WoWGPT/UI/Menu.lua' with { type: 'file' };
import addonUiMinimap from '../addon/WoWGPT/UI/Minimap.lua' with { type: 'file' };
import addonUiPopups from '../addon/WoWGPT/UI/Popups.lua' with { type: 'file' };
import addonUiCopy from '../addon/WoWGPT/UI/Copy.lua' with { type: 'file' };
import addonUiTranscript from '../addon/WoWGPT/UI/Transcript.lua' with { type: 'file' };
import addonUiChatList from '../addon/WoWGPT/UI/ChatList.lua' with { type: 'file' };
import addonUiFrame from '../addon/WoWGPT/UI/Frame.lua' with { type: 'file' };
import addonCommandsDiag from '../addon/WoWGPT/Commands/Diag.lua' with { type: 'file' };
import addonCommandsRegistry from '../addon/WoWGPT/Commands/Registry.lua' with { type: 'file' };
import addonCommandsClaude from '../addon/WoWGPT/Commands/Claude.lua' with { type: 'file' };
import addonCommandsConfig from '../addon/WoWGPT/Commands/Config.lua' with { type: 'file' };
import addonLua from '../addon/WoWGPT/WoWGPT.lua' with { type: 'file' };
import addonToc from '../addon/WoWGPT/WoWGPT.toc' with { type: 'file' };
import addonCodec from '../addon/WoWGPT/Codec.lua' with { type: 'file' };
import addonInbox from '../addon/WoWGPT/Inbox.lua' with { type: 'file' };
import addonMap from '../addon/WoWGPT/Map.lua' with { type: 'file' };
import addonRoast from '../addon/WoWGPT/Roast.lua' with { type: 'file' };
import addonStream from '../addon/WoWGPT/Stream.lua' with { type: 'file' };
import addonVoice from '../addon/WoWGPT/Voice.lua' with { type: 'file' };
import addonLootRoll from '../addon/WoWGPT/LootRoll.lua' with { type: 'file' };
import addonAchievements from '../addon/WoWGPT/Achievements.lua' with { type: 'file' };
import addonOrders from '../addon/WoWGPT/Orders.lua' with { type: 'file' };
import addonDM from '../addon/WoWGPT/DM.lua' with { type: 'file' };
import addonWidgets from '../addon/WoWGPT/Widgets.lua' with { type: 'file' };
import addonWindow from '../addon/WoWGPT/UI/Window.lua' with { type: 'file' };
import addonTelemetry from '../addon/WoWGPT/Telemetry.lua' with { type: 'file' };
import addonObserved from '../addon/WoWGPT/Observed.lua' with { type: 'file' };
import addonDev from '../addon/WoWGPT/Dev.lua' with { type: 'file' };
import addonHelp from '../addon/WoWGPT/Help.lua' with { type: 'file' };
import addonBoot from '../addon/WoWGPT/Boot.lua' with { type: 'file' };
import addonBindings from '../addon/WoWGPT/Bindings.xml' with { type: 'file' };
import addonPortrait from '../addon/WoWGPT/Portrait.tga' with { type: 'file' };
import addonMinimapIcon from '../addon/WoWGPT/MinimapIcon.tga' with { type: 'file' };
import capturePs1 from '../bridge/capture.ps1' with { type: 'file' };
import captureMac from '../bridge/capture_mac.py' with { type: 'file' };
import captureX11 from '../bridge/capture_x11.py' with { type: 'file' };
import configExample from '../bridge/config.example.json' with { type: 'file' };
import primer from '../docs/WOW-ADDON-PRIMER.md' with { type: 'file' };
import pluginManifest from '../assets/plugins/wowgpt/.claude-plugin/plugin.json' with { type: 'file' };
import pluginWowCode from '../assets/plugins/wowgpt/agents/wow-code.md' with { type: 'file' };
import pluginWowPlanner from '../assets/plugins/wowgpt/agents/wow-planner.md' with { type: 'file' };

require('../bridge/assets').embed({
  'addon/WoWGPT/Core/Namespace.lua': addonCoreNamespace,
  'addon/WoWGPT/Core/Log.lua': addonCoreLog,
  'addon/WoWGPT/Core/State.lua': addonCoreState,
  'addon/WoWGPT/Transport/Strip.lua': addonTransportStrip,
  'addon/WoWGPT/Transport/Screenshot.lua': addonTransportScreenshot,
  'addon/WoWGPT/Transport/ChatLog.lua': addonTransportChatLog,
  'addon/WoWGPT/Transport/Signals.lua': addonTransportSignals,
  'addon/WoWGPT/Transport/Slots.lua': addonTransportSlots,
  'addon/WoWGPT/Transport/Tick.lua': addonTransportTick,
  'addon/WoWGPT/Chat/Context.lua': addonChatContext,
  'addon/WoWGPT/Chat/Send.lua': addonChatSend,
  'addon/WoWGPT/Chat/Replies.lua': addonChatReplies,
  'addon/WoWGPT/Chat/Grants.lua': addonChatGrants,
  'addon/WoWGPT/Whisper/Tabs.lua': addonWhisperTabs,
  'addon/WoWGPT/Whisper/Reply.lua': addonWhisperReply,
  'addon/WoWGPT/Whisper/Intercept.lua': addonWhisperIntercept,
  'addon/WoWGPT/Chat/Options.lua': addonChatOptions,
  'addon/WoWGPT/Chat/Sessions.lua': addonChatSessions,
  'addon/WoWGPT/UI/Markdown.lua': addonUiMarkdown,
  'addon/WoWGPT/UI/Menu.lua': addonUiMenu,
  'addon/WoWGPT/UI/Minimap.lua': addonUiMinimap,
  'addon/WoWGPT/UI/Popups.lua': addonUiPopups,
  'addon/WoWGPT/UI/Copy.lua': addonUiCopy,
  'addon/WoWGPT/UI/Transcript.lua': addonUiTranscript,
  'addon/WoWGPT/UI/ChatList.lua': addonUiChatList,
  'addon/WoWGPT/UI/Frame.lua': addonUiFrame,
  'addon/WoWGPT/Commands/Diag.lua': addonCommandsDiag,
  'addon/WoWGPT/Commands/Registry.lua': addonCommandsRegistry,
  'addon/WoWGPT/Commands/Claude.lua': addonCommandsClaude,
  'addon/WoWGPT/Commands/Config.lua': addonCommandsConfig,
  'addon/WoWGPT/WoWGPT.lua': addonLua,
  'addon/WoWGPT/WoWGPT.toc': addonToc,
  'addon/WoWGPT/Codec.lua': addonCodec,
  'addon/WoWGPT/Inbox.lua': addonInbox,
  'addon/WoWGPT/Map.lua': addonMap,
  'addon/WoWGPT/Roast.lua': addonRoast,
  'addon/WoWGPT/Stream.lua': addonStream,
  'addon/WoWGPT/Voice.lua': addonVoice,
  'addon/WoWGPT/LootRoll.lua': addonLootRoll,
  'addon/WoWGPT/Achievements.lua': addonAchievements,
  'addon/WoWGPT/Orders.lua': addonOrders,
  'addon/WoWGPT/DM.lua': addonDM,
  'addon/WoWGPT/Widgets.lua': addonWidgets,
  'addon/WoWGPT/UI/Window.lua': addonWindow,
  'addon/WoWGPT/Telemetry.lua': addonTelemetry,
  'addon/WoWGPT/Observed.lua': addonObserved,
  'addon/WoWGPT/Dev.lua': addonDev,
  'addon/WoWGPT/Help.lua': addonHelp,
  'addon/WoWGPT/Boot.lua': addonBoot,
  'addon/WoWGPT/Bindings.xml': addonBindings,
  'addon/WoWGPT/Portrait.tga': addonPortrait,
  'addon/WoWGPT/MinimapIcon.tga': addonMinimapIcon,
  'bridge/capture.ps1': capturePs1,
  'bridge/capture_mac.py': captureMac,
  'bridge/capture_x11.py': captureX11,
  'bridge/config.example.json': configExample,
  'docs/WOW-ADDON-PRIMER.md': primer,
  'assets/plugins/wowgpt/.claude-plugin/plugin.json': pluginManifest,
  'assets/plugins/wowgpt/agents/wow-code.md': pluginWowCode,
  'assets/plugins/wowgpt/agents/wow-planner.md': pluginWowPlanner,
});
require('../bridge/supervisor');
