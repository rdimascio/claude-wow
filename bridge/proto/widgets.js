'use strict';

const crypto = require('crypto');
const { ADDON, luaStr, cleanText } = require('./util');
const { parseSideFile } = require('./map');

const WIDGET_LIMITS = { widgets: 8, sourceBytes: 16000, totalBytes: 64000, title: 60 };
const WIDGET_NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const WIDGET_BLOCK_RE = /```wowui([^\n]*)\n([\s\S]*?)```/g;

const WIDGET_DENIED_NAMES = [
  'CastSpell',
  'CastSpellByName',
  'CastSpellByID',
  'CastShapeshiftForm',
  'CastPetAction',
  'UseAction',
  'UseItemByName',
  'UseInventoryItem',
  'UseContainerItem',
  'UseToy',
  'UseToyByName',
  'RunMacro',
  'RunMacroText',
  'RunBinding',
  'RunScript',
  'TargetUnit',
  'TargetNearestEnemy',
  'TargetNearestFriend',
  'TargetLastTarget',
  'TargetLastEnemy',
  'ClearTarget',
  'AssistUnit',
  'FocusUnit',
  'InteractUnit',
  'FollowUnit',
  'AttackTarget',
  'StartAttack',
  'StopAttack',
  'PetAttack',
  'PetFollow',
  'SpellStopCasting',
  'SpellStopTargeting',
  'SpellTargetUnit',
  'CancelShapeshiftForm',
  'CancelUnitBuff',
  'JumpOrAscendStart',
  'MoveForwardStart',
  'MoveBackwardStart',
  'StrafeLeftStart',
  'StrafeRightStart',
  'TurnLeftStart',
  'TurnRightStart',
  'ToggleAutoRun',
  'ToggleRun',
  'SitStandOrDescendStart',
  'PickupAction',
  'PlaceAction',
  'PickupSpell',
  'PickupItem',
  'PickupMacro',
  'PickupContainerItem',
  'PickupInventoryItem',
  'DeleteCursorItem',
  'EquipItemByName',
  'SendChatMessage',
  'SendAddonMessage',
  'BNSendWhisper',
  'DoEmote',
  'SendMail',
  'ChatEdit_SendText',
  'ChatEdit_ParseText',
  'InviteUnit',
  'UninviteUnit',
  'LeaveParty',
  'AcceptGroup',
  'AcceptTrade',
  'InitiateTrade',
  'BuyMerchantItem',
  'RepairAllItems',
  'PlaceAuctionBid',
  'SetRaidTarget',
  'CreateMacro',
  'EditMacro',
  'DeleteMacro',
  'SetBinding',
  'SetBindingClick',
  'SetBindingSpell',
  'SetBindingItem',
  'SetBindingMacro',
  'SaveBindings',
  'SetCVar',
  'ConsoleExec',
  'ReloadUI',
  'Logout',
  'Quit',
  'ForceQuit',
  'LoadAddOn',
  'EnableAddOn',
  'DisableAddOn',
  'SlashCmdList',
  'hooksecurefunc',
  'securecall',
  'securecallfunction',
  'secureexecuterange',
  'loadstring',
  'load',
  'getfenv',
  'setfenv',
  'getglobal',
  'setglobal',
  'rawget',
  'rawset',
  'debug',
  'CombatLogGetCurrentEventInfo',
];
const WIDGET_TEMPLATES = [
  'BackdropTemplate',
  'TooltipBackdropTemplate',
  'TooltipBorderedFrameTemplate',
  'BasicFrameTemplate',
  'BasicFrameTemplateWithInset',
  'InsetFrameTemplate',
  'UIPanelButtonTemplate',
  'UIPanelCloseButton',
  'UICheckButtonTemplate',
  'InputBoxTemplate',
  'OptionsSliderTemplate',
  'UIPanelScrollFrameTemplate',
  'GameTooltipTemplate',
];
const WIDGET_RESTRICTED_EVENTS = [
  'COMBAT_LOG_EVENT',
  'COMBAT_LOG_EVENT_UNFILTERED',
  'COMBAT_LOG_APPLY_FILTER_SETTINGS',
  'COMBAT_LOG_REFILTER_ENTRIES',
  'MINIMAP_PING',
  'UNIT_PING_PIN_ADDED',
  'UNIT_PING_PIN_REMOVED',
];
const WIDGET_DENIED_RE = new RegExp(`(?<![A-Za-z0-9_])(${WIDGET_DENIED_NAMES.join('|')})(?![A-Za-z0-9_])`, 'g');
const WIDGET_DENIED_PATTERNS = [
  { re: /Secure[A-Za-z]*(?:Template|Handler)|SecureAction/g, why: 'secure templates' },
  { re: new RegExp(`(?<![A-Za-z0-9_])${ADDON}[A-Za-z0-9_]*`, 'g'), why: "the addon's own data" },
  { re: new RegExp(`(?<![A-Za-z0-9_])(?:${WIDGET_RESTRICTED_EVENTS.join('|')})(?![A-Za-z0-9_])`, 'g'), why: 'an event only the Blizzard UI may register' },
];

function widgetRevision(source) {
  return crypto.createHash('sha1').update(String(source)).digest('hex').slice(0, 12);
}

function deniedWidgetCalls(source) {
  const found = new Set();
  for (const m of String(source).matchAll(WIDGET_DENIED_RE)) found.add(m[1]);
  for (const { re, why } of WIDGET_DENIED_PATTERNS) {
    for (const m of String(source).matchAll(re)) found.add(`${m[0]} (${why})`);
  }
  return [...found];
}

function validateWidgetCommand(c, why = []) {
  if (!c || typeof c !== 'object') {
    why.push('not an object');
    return null;
  }
  if (c.op === 'clearall') return { op: 'clearall' };
  const name = String(c.name ?? '');
  if (!WIDGET_NAME_RE.test(name)) {
    why.push(`bad widget name "${name.slice(0, 40)}"`);
    return null;
  }
  if (c.op === 'remove') return { op: 'remove', name };
  if (c.op !== 'set') {
    why.push(`unknown op "${String(c.op).slice(0, 20)}"`);
    return null;
  }
  const source = String(c.source ?? '')
    .replace(/\r/g, '')
    .trim();
  if (!source) {
    why.push(`widget ${name}: empty source`);
    return null;
  }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > WIDGET_LIMITS.sourceBytes) {
    why.push(`widget ${name}: ${bytes} bytes, over ${WIDGET_LIMITS.sourceBytes}; refused`);
    return null;
  }
  const denied = deniedWidgetCalls(source);
  if (denied.length) {
    why.push(`widget ${name} refused, widgets are display-only: ${denied.slice(0, 8).join(', ')}`);
    return null;
  }
  return { op: 'set', name, title: cleanText(c.title || name, WIDGET_LIMITS.title), source, rev: widgetRevision(source) };
}

function newWidgetSet(epoch) {
  return { epoch: epoch || Math.random().toString(36).slice(2, 10), version: 0, items: {} };
}

function applyWidgetCommands(set, cmds, now = Date.now()) {
  const notes = [];
  let changed = false;
  for (const raw of cmds || []) {
    const why = [];
    const c = validateWidgetCommand(raw, why);
    notes.push(...why);
    if (!c) continue;
    if (c.op === 'clearall') {
      if (Object.keys(set.items).length) {
        set.items = {};
        changed = true;
      }
      notes.push('removed all widgets');
    } else if (c.op === 'remove') {
      if (set.items[c.name]) {
        delete set.items[c.name];
        changed = true;
        notes.push(`removed widget ${c.name}`);
      }
    } else if (set.items[c.name] && set.items[c.name].rev === c.rev && set.items[c.name].title === c.title) {
      notes.push(`widget ${c.name}: unchanged`);
    } else {
      set.items[c.name] = { title: c.title, source: c.source, rev: c.rev, t: now };
      changed = true;
      notes.push(`widget ${c.name}: sent to the game (${Buffer.byteLength(c.source, 'utf8')} bytes)`);
    }
  }
  const totalBytes = () => Object.values(set.items).reduce((s, w) => s + Buffer.byteLength(w.source, 'utf8'), 0);
  const oldestFirst = () => Object.keys(set.items).sort((a, b) => set.items[a].t - set.items[b].t);
  while (Object.keys(set.items).length > WIDGET_LIMITS.widgets || totalBytes() > WIDGET_LIMITS.totalBytes) {
    const oldest = oldestFirst()[0];
    delete set.items[oldest];
    notes.push(`dropped old widget ${oldest} (widget budget full)`);
    changed = true;
  }
  if (changed) set.version = (set.version || 0) + 1;
  return { changed, notes };
}

function parseWidgetHeader(rest) {
  let header = String(rest || '');
  let title = '';
  header = header.replace(/\btitle\s*=\s*"([^"]*)"/i, (_, v) => {
    title = v;
    return ' ';
  });
  const words = header.trim().split(/\s+/).filter(Boolean);
  return { name: words[0] || '', remove: words.slice(1).some(w => w.toLowerCase() === 'remove'), title };
}

function extractWidgetBlocks(text) {
  const cmds = [];
  const stripped = String(text ?? '')
    .replace(WIDGET_BLOCK_RE, (_, header, body) => {
      const h = parseWidgetHeader(header);
      if (h.remove) cmds.push({ op: 'remove', name: h.name });
      else cmds.push({ op: 'set', name: h.name, title: h.title || h.name, source: body });
      return h.remove ? '' : `[UI widget "${h.name || '?'}"]`;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: stripped, cmds };
}

function parseWidgetFile(src) {
  return parseSideFile('widget', src);
}

function luaWidgets(set) {
  const lines = ['\twidgets = {', `\t\tepoch = ${luaStr(set.epoch)},`, `\t\tversion = ${Number(set.version) || 0},`, '\t\titems = {'];
  for (const [name, w] of Object.entries(set.items || {})) {
    lines.push(`\t\t\t{ name = ${luaStr(name)}, title = ${luaStr(w.title)}, rev = ${luaStr(w.rev)}, source = ${luaStr(w.source)} },`);
  }
  lines.push('\t\t},', '\t},');
  return lines.join('\n');
}

module.exports = {
  WIDGET_LIMITS,
  WIDGET_DENIED_NAMES,
  WIDGET_RESTRICTED_EVENTS,
  WIDGET_TEMPLATES,
  deniedWidgetCalls,
  validateWidgetCommand,
  newWidgetSet,
  applyWidgetCommands,
  extractWidgetBlocks,
  parseWidgetFile,
  luaWidgets,
  widgetRevision,
};
