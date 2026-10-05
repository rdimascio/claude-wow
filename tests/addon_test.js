// Runs the real addon Lua (Codec.lua + ClaudeWoW.lua) in a Lua VM with a stub
// WoW API (wow_stub.lua) and drives it through a session: login, hello, a sent
// message read back off the pixel strip, a reply delivered through a slot, the
// bridge's default folder and agent, a chat that picks another agent, a
// permission denial with Allow, and a restore.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', 'addon', 'ClaudeWoW');
const CELLS_PER_ROW = 200;

function newVM() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (code, arg, chunk) => {
    const buf = to_luastring(code);
    const loaded = chunk ? lauxlib.luaL_loadbuffer(L, buf, buf.length, to_luastring('@' + chunk)) : lauxlib.luaL_loadstring(L, buf);
    if (loaded !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let nargs = 0;
    if (arg !== undefined) {
      lua.lua_pushstring(L, to_luastring(arg));
      nargs = 1;
    }
    if (lua.lua_pcall(L, nargs, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  // Evaluate an expression and bring it back as a string (or nil).
  const evaluate = expr => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const num = expr => Number(evaluate(expr));
  run(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  for (const f of ['Codec.lua', 'Inbox.lua', 'ClaudeWoW.lua']) run(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'ClaudeWoW', 'addon/' + f);
  return { run, evaluate, num };
}

// Read the strip the addon drew, exactly like capture.ps1: 3 bits per cell,
// [C7 1A] [id] [len] [payload] [fletcher]. Returns { id, text } or null.
function decodeStrip(vm, threshold = 0.5) {
  if (vm.evaluate('ClaudeWoWStrip and ClaudeWoWStrip.shown') !== 'true') return null;
  vm.run(`
    local parts = {}
    local th = ${threshold}
    for _, t in ipairs(ClaudeWoWStrip.textures) do
      if t.shown and t.color then
        local c, r = math.floor(t.x / 4), math.floor(-t.y / 4)
        local v = (t.color[1] >= th and 4 or 0) + (t.color[2] >= th and 2 or 0) + (t.color[3] >= th and 1 or 0)
        parts[#parts + 1] = (r * ${CELLS_PER_ROW} + c) .. ":" .. v
      end
    end
    RESULT = table.concat(parts, ",")`);
  const cells = [];
  for (const p of vm.evaluate('RESULT').split(',')) {
    const [i, v] = p.split(':').map(Number);
    cells[i] = v;
  }
  const bytes = [];
  let acc = 0,
    nbits = 0;
  for (let i = 0; i < cells.length; i++) {
    acc = (acc << 3) | (cells[i] || 0);
    nbits += 3;
    while (nbits >= 8) {
      bytes.push((acc >> (nbits - 8)) & 0xff);
      nbits -= 8;
      acc &= (1 << nbits) - 1;
    }
  }
  assert.equal(bytes[0], 0xc7);
  assert.equal(bytes[1], 0x1a);
  const id = bytes[2] * 256 + bytes[3];
  const len = bytes[4] * 256 + bytes[5];
  let s1 = 0,
    s2 = 0;
  for (let k = 2; k < 6 + len; k++) {
    s1 = (s1 + bytes[k]) % 255;
    s2 = (s2 + s1) % 255;
  }
  assert.equal(bytes[6 + len], s1, 'fletcher s1');
  assert.equal(bytes[7 + len], s2, 'fletcher s2');
  return { id, text: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8') };
}

function stripRecords(vm, threshold) {
  const frame = decodeStrip(vm, threshold);
  if (!frame) return [];
  return frame.text.split('\x1E').map(r => {
    const p = r.split('\x1F');
    const withCtx = p[4].split(';').includes('c'); // a "c" flag means field 7 is the game context
    const rec = { session: p[0], chat: p[1], id: Number(p[2]), cwd: p[3], flags: p[4], name: p[5], text: p.slice(withCtx ? 7 : 6).join('\x1F') };
    if (withCtx) rec.ctx = p[6];
    return rec;
  });
}

// Make the next LoadAddOn deliver this slot data (a Lua table literal body).
const flagsOf = r =>
  r.flags
    .split(';')
    .filter(t => !/^(probe|pt|lc|ver|proto)=/.test(t))
    .join(';');

function nextSlot(vm, luaBody) {
  vm.run(`STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = ${luaBody} end`);
}

function login(vm) {
  vm.run('STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  vm.run('STUB.FireEvent("PLAYER_LOGIN")');
}

// Let the bridge answer the login hello: its slot carries a fresh clock, which is
// what makes the addon consider itself connected (Send is gated on that).
function connect(vm) {
  vm.run('STUB.RunTimers()'); // C_Timer.After(3, SayHello)
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // hello poll 5 s later
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true', 'connected after the hello slot');
}

test('addon loads, builds its UI and creates a first chat', () => {
  const vm = newVM();
  login(vm);
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Chat 1');
  assert.equal(vm.evaluate('ClaudeWoWFrame ~= nil'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWMini ~= nil'), 'true');
  assert.equal(vm.num('#STUB.tickers'), 2, 'the transport tick and the whisper-tab pulse');
  assert.equal(vm.evaluate('SlashCmdList.CLAUDEWOW ~= nil'), 'true');
  // Two commands, not two spellings of one: /claude-wow shows the window, /claude
  // bare opens a new chat the way a terminal does. No other alias.
  assert.deepEqual(
    [1, 2].map(i => vm.evaluate('SLASH_CLAUDEWOW' + i)),
    ['/claude-wow', null],
    'the client command and no alias',
  );
  assert.deepEqual(
    [1, 2].map(i => vm.evaluate('SLASH_CLAUDE' + i)),
    ['/claude', null],
    'the terminal command and no alias',
  );
  assert.equal(vm.evaluate('SlashCmdList.CLAUDE ~= nil'), 'true');
  // Bare /claude starts a fresh chat rather than toggling the window.
  vm.evaluate('SlashCmdList.CLAUDE("")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'bare /claude added a chat');
  // With text it still routes to the client handler.
  vm.evaluate('SlashCmdList.CLAUDE("mini")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'a command after /claude is not a new chat');
  assert.equal(vm.evaluate('SlashCmdList.CLAUDEWOWASK'), null, '/claude is a spelling of the one command, not a handler of its own');
  // The names from before the rename are gone, not aliased: nothing registers them.
  vm.run(
    'RESULT = ""; for k, v in pairs(_G) do if type(k) == "string" and k:match("^SLASH_") and type(v) == "string" and (v == "/wow-ai" or v == "/wowai" or v == "/ai" or v == "/ask" or v == "/wow-claude") then RESULT = RESULT .. k .. "=" .. v .. " " end end',
  );
  assert.equal(vm.evaluate('RESULT'), '', 'no old slash command survives');
});

const talentsLine = vm =>
  vm
    .evaluate('ClaudeWoW.GameContext()')
    .split('\n')
    .find(l => l.startsWith('Talents:'));

test('the talents line falls back to the old talent-tab functions when there are no trait trees', () => {
  const vm = newVM();
  login(vm);
  vm.run(
    'C_Traits = nil; function GetNumTalentTabs() return 2 end; function GetTalentTabInfo(i) local t = { { "Combat", 3 }, { "Subtlety", 1 } }; return t[i][1], "icon", t[i][2] end',
  );
  assert.equal(talentsLine(vm), 'Talents: Combat 3 / Subtlety 1');
});

test('on Classic Era the talents line reads names and points from GetSpecializationInfo, not the reordered GetTalentTabInfo shim', () => {
  const vm = newVM();
  login(vm);
  vm.run(`
    C_SpecializationInfo.GetCombatConfigIDForSpecGroup = nil
    function GetNumTalentTabs() return 3 end
    local tabs = { { 161, "Assassination", 0 }, { 182, "Combat", 14 }, { 183, "Subtlety", 5 } }
    C_SpecializationInfo.GetSpecializationInfo = function(i)
      local t = tabs[i]
      return t[1], t[2], "description", 132292, nil, nil, t[3], "background", 0, true
    end
    function GetTalentTabInfo(i)
      local t = tabs[i]
      return t[1], t[2], "description", 132292, t[3], "background", 0, true
    end
  `);
  assert.equal(talentsLine(vm), 'Talents: Assassination 0 / Combat 14 / Subtlety 5');
});

test('a shift-clicked link lands in the focused input and is sent as its name plus tooltip', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const link = '|cff1eff00|Hitem:2140:0:0:0:0:0:0:0:60:0:0|h[Fine Longsword]|h|r';
  vm.run(
    `STUB.tooltips["item:2140:0:0:0:0:0:0:0:60:0:0"] = { "Fine Longsword", { "Main Hand", "Sword" }, { "17 - 33 Damage", "Speed 2.70" }, "Requires Level 14" }`,
  );
  // Without focus the link is left alone (shift-click keeps its normal meaning).
  vm.run(`ClaudeWoWInput:SetText("is this good for me? "); ClaudeWoWInput:ClearFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'is this good for me? ');
  // The client's own path (bags, spellbook, quest log all end here): ChatFrameUtil.InsertLink.
  vm.run(`ClaudeWoWInput:SetFocus(); ChatFrameUtil.InsertLink("${link}")`);
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'is this good for me? ' + link);
  // The old global name is not hooked as well, so nothing is inserted twice.
  vm.run(`ChatEdit_InsertLink("${link}")`);
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'is this good for me? ' + link + link, 'the alias reaches the one hook exactly once');
  vm.run(`ClaudeWoWInput:SetText("is this good for me? ${link}")`);
  vm.run('ClaudeWoW.SendFromInput()');
  const expected = [
    'is this good for me? [Fine Longsword]',
    '',
    '--- Linked from the game ---',
    '[Fine Longsword] item 2140 (Uncommon)',
    '  Fine Longsword',
    '  Main Hand  Sword',
    '  17 - 33 Damage  Speed 2.70',
    '  Requires Level 14',
  ].join('\n');
  const rec = stripRecords(vm).find(r => r.text.startsWith('is this good'));
  assert.equal(rec.text, expected);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), expected, 'the transcript shows what was sent');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Is this good for me');
  // Bare links (no colour) and repeated links: one block each, tooltip or not.
  vm.run('RESULT = (ClaudeWoW.ExpandLinks("x |Hspell:1978|h[Serpent Sting]|h y |Hspell:1978|h[Serpent Sting]|h"))');
  assert.equal(vm.evaluate('RESULT'), 'x [Serpent Sting] y [Serpent Sting]\n\n--- Linked from the game ---\n[Serpent Sting] spell 1978');
  vm.run(
    'RESULT = (ClaudeWoW.ExpandLinks("x |Hspell:1978|h[Serpent Sting]|h y |Henchant:7418|h[Enchant Bracer - Minor Health]|h z |Hitem:2140|h[Fine Longsword]|h"))',
  );
  assert.deepEqual(
    [...require('../bridge/replytokens').linkedSpells([vm.evaluate('RESULT')])].sort((a, b) => a - b),
    [1978, 7418],
    'the bridge reads the spell and recipe IDs the addon writes',
  );
  vm.run('RESULT, COUNT = ClaudeWoW.ExpandLinks("plain text | with a pipe")');
  assert.equal(vm.evaluate('RESULT'), 'plain text | with a pipe');
  assert.equal(vm.evaluate('COUNT'), '0');
});

test('a message sent while disconnected goes out by itself once the bridge answers', () => {
  const vm = newVM();
  login(vm);
  vm.run('ClaudeWoW.Toggle(true)');
  vm.run('ClaudeWoWInput:SetText("fix the bug"); ClaudeWoW.SendFromInput()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'nothing sent yet');
  // The bridge answers the hello poll: the queued message follows without a second click.
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  assert.ok(vm.num('ClaudeWoWDB.chats[1].pendingId') >= 1, 'queued message went out on connect');
  assert.ok(stripRecords(vm).find(r => r.text === 'fix the bug'));
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), '', 'box cleared after the auto-send');
  // Only once: a later reconnect sends nothing.
  vm.run('ClaudeWoW.Connect()');
  nextSlot(vm, '{ now = time(), cwd = "C:\\\\proj", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(stripRecords(vm).filter(r => r.text === 'fix the bug').length, 1);
});

test('the Folder... menu item (right-click a chat) opens a prompt that sets the chat folder like /claude-wow cd', () => {
  const vm = newVM();
  login(vm);
  vm.run('ClaudeWoW.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '');
  // Accept the dialog the way the game would: an edit box holding the new path.
  vm.run(`
    local dialog = { editBox = { GetText = function() return "  ..\\\\realms " end } }
    StaticPopupDialogs.CLAUDEWOW_FOLDER.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), '..\\realms');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('relative to'));
  vm.run('ClaudeWoW.FolderPrompt()');
  assert.equal(vm.evaluate('STUB.popup.data.cwd'), '..\\realms', 'prompt is prefilled with the current folder');
  // A full path gets no "relative to" note; empty goes back to the default.
  vm.run('ClaudeWoW.SetFolder("C:\\\\other")');
  assert.ok(!vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('relative to'));
  vm.run('ClaudeWoW.SetFolder("")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), '');
});

test('a sent message is encoded on the strip with the chat folder and goes to the coding plugin, then a slot reply finishes it', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.CLAUDE("cd realms")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), 'realms');
  vm.run('ClaudeWoW.Send("hello world")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  assert.ok(id >= 1);
  const rec = stripRecords(vm).find(r => r.text === 'hello world');
  assert.ok(rec, 'message record on the strip');
  assert.equal(rec.chat, chatId);
  assert.equal(rec.id, id);
  assert.equal(rec.cwd, 'realms');
  assert.equal(rec.flags, 'plugin=claude-code;t', 'a chat with a folder is a coding session there');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.plugin'), 'claude-code');
  // The chat took its title from the first message.
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Hello world');

  nextSlot(
    vm,
    `{ now = time(), cwd = "C:\\\\proj", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "hi back", cwd = "x", session = "s" } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // first scheduled poll is 5 s after sending
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].role'), 'assistant');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), 'hi back');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('hi back'), 'reply echoed to the game chat');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'strip cleared once nothing is pending');

  // The bridge's default folder arrived with the slot and is what "/claude-wow cd" reports.
  vm.run('SlashCmdList.CLAUDE("cd")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), '');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('C:\\proj'));
});

test('a chat can pick its agent: the strip says so, replies are labelled by their writer, unknown names are refused', () => {
  const vm = newVM();
  login(vm);
  // The hello slot carries the bridge's default agent and the ones it knows.
  vm.run('STUB.RunTimers()');
  const slot = replies => `{ now = time(), cwd = "", agent = "claude", agents = { "claude", "codex", "grok" }, replies = { ${replies || ''} } }`;
  nextSlot(vm, slot());
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  const texts = () => vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(texts().includes('agent: Claude (bridge default)'), 'the cwd line names the bridge default');
  // Without an agent of its own the chat sends no agent flag, and the reply is labelled Claude.
  vm.run('ClaudeWoW.Send("hello")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  let rec = stripRecords(vm).find(r => r.text === 'hello');
  assert.equal(rec.flags, 't');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.agent'), null);
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id}, status = "done", text = "hi", agent = "claude" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].role'), 'assistant');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].agent'), 'claude');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('[Claude · '), 'the game chat echo names the agent');
  // Switch this chat to Codex: the next message carries agent=codex, on both transports.
  vm.run('SlashCmdList.CLAUDE("-c --agent Codex")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), 'codex');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('agent set to Codex'));
  vm.run('ClaudeWoW.Send("now with codex")');
  rec = stripRecords(vm).find(r => r.text === 'now with codex');
  assert.equal(rec.flags, 'agent=codex');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.agent'), 'codex');
  assert.ok(texts().includes('agent: Codex   mode: pixel'));
  const id2 = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(vm, slot(`{ chat = "${chatId}", id = ${id2}, status = "done", text = "codex here", agent = "codex" }`));
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].agent'), 'codex');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('[Codex · '));
  // Resend keeps the agent flag.
  vm.run('ClaudeWoW.Send("again")');
  vm.run('ClaudeWoW.Resend()');
  assert.equal(stripRecords(vm).find(r => r.text === 'again').flags, 'agent=codex');
  vm.run('SlashCmdList.CLAUDE("cancel")');
  // A name the bridge did not list is refused; "default" goes back to the bridge's.
  vm.run('SlashCmdList.CLAUDE("-c --agent gemini")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), 'codex');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('Unknown agent "gemini"'));
  vm.run('SlashCmdList.CLAUDE("-c --agent default")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), '');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes("agent reset to the bridge's default: Claude"));
  // The Agent... menu item opens a prompt prefilled with the chat's agent.
  vm.run('ClaudeWoW.SetAgent("grok"); ClaudeWoW.AgentPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_AGENT');
  assert.equal(vm.evaluate('STUB.popup.data.agent'), 'grok');
  vm.run(`
    local dialog = { editBox = { GetText = function() return " codex " end } }
    StaticPopupDialogs.CLAUDEWOW_AGENT.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), 'codex');
  // A new chat inherits the agent, like the folder.
  vm.run('ClaudeWoW.NewChat("Second")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].agent'), 'codex');
});

test('free text that starts with a command word is a message for a new chat; exact commands and config keys still run', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const sentIn = text => {
    const r = stripRecords(vm).find(x => x.text === text);
    return r && r.chat;
  };
  const active = () => vm.evaluate('ClaudeWoWDB.activeChat');
  const count = () => vm.num('#ClaudeWoWDB.chats');
  const last = () => vm.evaluate('(function() local c = ClaudeWoW_Active() return c.history[#c.history].text end)()');
  vm.run('function ClaudeWoW_Active() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then return c end end end');
  vm.run('SlashCmdList.CLAUDE("delete the unused imports")');
  assert.equal(count(), 2, 'no chat deleted, a new one started');
  assert.equal(sentIn('delete the unused imports'), active());
  vm.run('SlashCmdList.CLAUDE("cancel")');
  assert.equal(vm.evaluate('ClaudeWoW_Active().pendingId'), null, 'cancel ran as a command');
  vm.run('SlashCmdList.CLAUDE("help me with this macro")');
  assert.equal(count(), 3);
  assert.equal(sentIn('help me with this macro'), active());
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run('SlashCmdList.CLAUDE("help")');
  assert.ok(last().includes('/claude -r [id|name|n] [text]'), last());
  vm.run('SlashCmdList.CLAUDE("config context off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.context'), 'false');
  vm.run('SlashCmdList.CLAUDE("config context matters here")');
  assert.equal(count(), 4, 'a config line whose value does not fit is a message');
  assert.equal(sentIn('config context matters here'), active());
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run('SlashCmdList.CLAUDE("voice off")');
  assert.equal(count(), 5, 'settings live under config now: "voice off" is a message');
  assert.equal(sentIn('voice off'), active());
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run('SlashCmdList.CLAUDE("clear the cache")');
  assert.equal(sentIn('clear the cache'), active());
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run('SlashCmdList.CLAUDE("reset the counter")');
  assert.equal(vm.evaluate('ClaudeWoW_Active().resetNext'), null);
  assert.equal(sentIn('reset the counter'), active());
  vm.run('SlashCmdList.CLAUDE("cancel")');
  const before = count();
  const here = active();
  vm.run('SlashCmdList.CLAUDE("-c delete it anyway")');
  assert.equal(count(), before, '-c never starts a chat');
  assert.equal(sentIn('delete it anyway'), here);
});

test('game chat echo: the summary by default, the first lines without one, the whole reply with "echo full"', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), 'summary', 'summary echo is the default');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const prints = () => vm.evaluate('table.concat(STUB.prints, "\\n")');
  const reply = (text, summary) => {
    vm.run('STUB.prints = {}');
    vm.run('ClaudeWoW.Send("do it")');
    const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
    const sum = summary === undefined ? '' : `, summary = "${summary}"`;
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "${text}", agent = "claude"${sum} } } }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  };

  reply('Merged **two** PRs: https://github.com/o/r/pull/7');
  assert.ok(
    prints().includes('|Haddon:claudewow:url:https://github.com/o/r/pull/7|h[PR #7]|h') && !prints().includes('**'),
    'the echo renders bold and short links too: ' + prints(),
  );
  vm.run('ClaudeWoWDB.settings.echo = "short"');
  reply('Ran it.\\n```\\necho `pwd` **x** https://a.com\\n```\\nDone.');
  assert.ok(
    prints().includes('Ran it. Done.') && !prints().includes('pwd') && !prints().includes('url:https://a.com'),
    'the one-line echo leaves the code out instead of restyling it: ' + prints(),
  );
  vm.run('ClaudeWoWDB.settings.echo = "full"');
  reply('Full **echo**: https://github.com/o/r/pull/8');
  assert.ok(prints().includes('|h[PR #8]|h') && !prints().includes('**'), 'and so does the full echo: ' + prints());
  vm.run('ClaudeWoWDB.settings.echo = "summary"');

  // With a summary only the summary is printed; the window keeps the whole reply.
  reply('Long line one\\nLong line two\\nLong line three\\n\\nTL;DR: Renamed foo.\\nTests pass.', 'Renamed foo.\\nTests pass.');
  let out = prints();
  assert.ok(out.includes('[Claude · ') && out.includes('Renamed foo.') && out.includes('Tests pass.'), 'summary lines printed: ' + out);
  assert.ok(!out.includes('Long line one'), 'the body stays out of the game chat');
  assert.ok(out.includes('[open]'), 'the open link is there');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('Long line three'), 'the window has the full reply');

  // Without a summary: the first two lines, then a hint that there is more.
  reply('Line one\\nLine two\\nLine three\\nLine four');
  out = prints();
  assert.ok(out.includes('Line one') && out.includes('Line two'), 'first two lines: ' + out);
  assert.ok(!out.includes('Line three'), 'third line held back');
  assert.ok(out.includes('click [open]'), 'hint to open the window');

  // A short reply without a summary needs no hint.
  reply('Just this');
  out = prints();
  assert.ok(out.includes('Just this') && !out.includes('click [open] to read'), out);

  // "echo full" prints everything, as before.
  vm.run('SlashCmdList.CLAUDE("config echo full")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), 'full');
  reply('Line one\\nLine two\\nLine three\\n\\nTL;DR: Short.', 'Short.');
  out = prints();
  assert.ok(out.includes('Line one') && out.includes('Line three') && out.includes('TL;DR: Short.'), out);
  vm.run('SlashCmdList.CLAUDE("config echo summary")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), 'summary');
  vm.run('SlashCmdList.CLAUDE("config echo bogus")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), 'summary', 'an unknown mode is ignored');

  // An install that still had the old default saved moves to summary once; a mode picked on purpose stays.
  const vm2 = newVM();
  vm2.run('ClaudeWoWDB = { settings = { echo = "full" } }');
  login(vm2);
  assert.equal(vm2.evaluate('ClaudeWoWDB.settings.echo'), 'summary');
  const vm3 = newVM();
  vm3.run('ClaudeWoWDB = { settings = { echo = "short" } }');
  login(vm3);
  assert.equal(vm3.evaluate('ClaudeWoWDB.settings.echo'), 'short');
  const vm4 = newVM();
  vm4.run('ClaudeWoWDB = { settings = { echo = "full", echoV2 = true } }');
  login(vm4);
  assert.equal(vm4.evaluate('ClaudeWoWDB.settings.echo'), 'full');
});

test('chat management commands: -n, -r, rename, delete, clear, copy', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.CLAUDE("-n Realms")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].name'), 'Realms');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), vm.evaluate('ClaudeWoWDB.chats[2].id'));
  vm.run('SlashCmdList.CLAUDE("-r 1")');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), vm.evaluate('ClaudeWoWDB.chats[1].id'));
  vm.run('SlashCmdList.CLAUDE("rename Stuff")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Stuff');
  vm.run('SlashCmdList.CLAUDE("help")');
  const help = vm.evaluate('ClaudeWoWDB.chats[1].history[1].text');
  assert.ok(help.includes('/claude cd'), help);
  assert.ok(!help.includes('/claude-wow'), 'help never mentions the old command');
  vm.run('SlashCmdList.CLAUDE("clear")');
  assert.equal(vm.num('#ClaudeWoWDB.chats[1].history'), 0);
  vm.run('SlashCmdList.CLAUDE("delete")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Realms');
  // The copy box builds with a proper backdrop (the stub fails on SetBackdrop(nil)).
  vm.run('ClaudeWoW.ShowCopy("some reply")');
  assert.equal(vm.evaluate('ClaudeWoWCopy.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWCopyBox.text'), 'some reply');
});

test('chat rows: right-click opens a menu that renames or sets the folder of that chat, the trash can asks before deleting', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.CLAUDE("-n Realms")');
  const first = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const second = vm.evaluate('ClaudeWoWDB.chats[2].id');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), second);
  // The menu opens for the row's chat, not the active one, and toggles closed on a second open.
  vm.run(`ClaudeWoW.ShowChatMenu("${first}", ClaudeWoWFrame)`);
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.chatId'), first);
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.title.text'), 'Chat 1');
  vm.run(`ClaudeWoW.ShowChatMenu("${first}", ClaudeWoWFrame)`);
  assert.equal(vm.evaluate('ClaudeWoWChatMenu.shown'), 'false');
  // Rename and Folder prompts target the chat they were opened for.
  vm.run(`ClaudeWoW.RenamePrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_RENAME');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  vm.run(`
    local dialog = { editBox = { GetText = function() return "Old stuff" end } }
    StaticPopupDialogs.CLAUDEWOW_RENAME.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Old stuff');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].name'), 'Realms');
  vm.run(`ClaudeWoW.FolderPrompt("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_FOLDER');
  assert.equal(vm.evaluate('STUB.popup.data.id'), first);
  // The X asks first: nothing happens until OK, then only that chat goes and the active one stays.
  vm.run(`ClaudeWoW.ConfirmDelete("${first}")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_DELETE');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2);
  vm.run('StaticPopupDialogs.CLAUDEWOW_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].id'), second);
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), second);
  // Deleting the last chat clears it instead of removing it.
  vm.run(`ClaudeWoW.ConfirmDelete("${second}")`);
  vm.run('StaticPopupDialogs.CLAUDEWOW_DELETE.OnAccept({}, STUB.popup.data)');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Chat 1');
});

test('minimize collapses to the mini bar and back; the mini bar X hides everything', () => {
  const vm = newVM();
  login(vm);
  vm.run('ClaudeWoW.Toggle(true)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true');
  vm.run('ClaudeWoW.Minimize(true)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWMini.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.minimized'), 'true');
  vm.run('ClaudeWoW.Minimize(false)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWMini.shown'), 'false');
  vm.run('ClaudeWoW.Toggle(false)');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWMini.shown'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shown'), 'false');
});

test('reload mode writes the outbox for the bridge instead of drawing the strip', () => {
  const vm = newVM();
  login(vm);
  vm.run('SlashCmdList.CLAUDE("config mode reload")');
  vm.run('SlashCmdList.CLAUDE("reset")');
  vm.run('ClaudeWoW.Send("via reload", { "WebSearch", "Bash(git:*)" })');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.newSession'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.text'), Buffer.from('via reload').toString('hex'));
  assert.equal(Buffer.from(vm.evaluate('ClaudeWoWDB.outbox.allow'), 'hex').toString('utf8'), 'WebSearch\x1fBash(git:*)');
  assert.equal(decodeStrip(vm), null);
});

// The screenshot transport: the bridge's slot says `transport = "screenshot"`,
// and from then on the strip is only up for the frames around a Screenshot()
// call. Drives the strip's OnUpdate by hand (the stub renders nothing).
function frames(vm, n) {
  for (let i = 0; i < n; i++) vm.run('local f = ClaudeWoWStrip; if f.shown and f.scripts.OnUpdate then f.scripts.OnUpdate(f, 0.016) end');
}

test("screenshot transport: Blizzard's \"Screen captured\" status stays hidden for the addon's own shots, on both Classic Era frames, and shows for the player's", () => {
  const vm = newVM();
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\ctl\\\\valid.wav"] = true; STUB.armed = true');
  login(vm);
  vm.run(`
    WorldFrame = CreateFrame("Frame", "WorldFrame")
    local function status(parent)
      local f = CreateFrame("Frame", "ActionStatus", parent)
      f:Hide()
      f:RegisterEvent("SCREENSHOT_SUCCEEDED")
      f:SetScript("OnEvent", function(self) self:Show() end)
      return f
    end
    OLD_STATUS = status(WorldFrame)
    NEW_STATUS = status(UIParent)
  `);
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 1);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('OLD_STATUS.shown'), 'false', 'the WorldFrame child Era still has is hidden');
  assert.equal(vm.evaluate('NEW_STATUS.shown'), 'false', 'the global ActionStatus is hidden');
  vm.run('STUB.RunTimers()');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('OLD_STATUS.shown'), 'true', 'a screenshot the player takes still says so');
  assert.equal(vm.evaluate('NEW_STATUS.shown'), 'true');
});

test('screenshot transport: the strip is shot once per message, hidden on the event, and the format CVar is restored', () => {
  const vm = newVM();
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\ctl\\\\valid.wav"] = true; STUB.armed = true');
  login(vm);
  vm.run('STUB.RunTimers()'); // SayHello: not knowing better, the hello goes up pixel-style
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  assert.equal(vm.num('STUB.screenshots'), 0);
  // The hello poll reads a slot from a screenshot-mode bridge.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transport'), 'screenshot', 'remembered for the next login');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png', 'lossless format while the mode is on');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), 'jpeg', "the player's own format is kept");
  // The unacknowledged hello is shot now: strip up, two frames, Screenshot().
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 1);
  assert.equal(vm.num('STUB.screenshots'), 0, 'not before the strip had a frame to render');
  frames(vm, 1);
  assert.equal(vm.num('STUB.screenshots'), 1);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'still up until the client confirms');
  assert.equal(flagsOf(stripRecords(vm)[0]), 'h;c');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'hidden as soon as the shot is confirmed');
  assert.equal(vm.evaluate('ClaudeWoWStrip.scripts.OnUpdate'), null, 'no OnUpdate left running');
  // A message: one more shot, carrying the hello (still unacked) and the message.
  vm.run('ClaudeWoW.Send("hello world")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 2);
  const recs = stripRecords(vm);
  assert.ok(recs.find(r => r.text === 'hello world'));
  assert.ok(recs.find(r => flagsOf(r) === 'h;c'));
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  // Ticks without news take no more screenshots; an ack changes nothing on screen either.
  vm.run('STUB.now = STUB.now + 2; STUB.Tick(); STUB.now = STUB.now + 2; STUB.Tick()');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 2);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  vm.run(`STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\ack\\\\${String(id).padStart(3, '0')}.wav"] = false; STUB.now = STUB.now + 2; STUB.Tick()`);
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 2);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  // A player's own screenshot event with nothing in flight is ignored.
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 2);
  // A second chat's message that the bridge never acks: the 40 s retry shoots it
  // again (the hello has expired by then and is not on that strip).
  vm.run('ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("lost one")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 3);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('STUB.now = STUB.now + 41; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'retry puts the strip up again');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4);
  assert.deepEqual(
    stripRecords(vm).map(r => r.text),
    ['lost one'],
  );
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  // The status line says which transport is in use; diag counts the shots.
  vm.run('STUB.texts = {}; ClaudeWoW.UpdateStatus()');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('mode: pixel (screenshot)'));
  vm.run('SlashCmdList.CLAUDE("diag")');
  const diag = vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text');
  assert.ok(diag.includes('transport: screenshot, screenshots: 4 taken, 4 confirmed, 0 failed, 0 without event'), diag);
  // Back to a pixel-mode bridge: the CVar goes back and the strip stays up pixel-style.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "pixel", replies = {} }');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transport'), 'pixel');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg', 'restored');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.shotFormatSaved'), null);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'pixel mode: the strip stays up until acked');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 4, 'no screenshots in pixel mode');
});

test('screenshot transport: a failed shot is retried a few times, a missing event times out, logout restores the CVar', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()'); // SayHello
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()'); // the hello poll learns the transport
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  frames(vm, 2); // the hello's shot
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 1);
  vm.run('ClaudeWoW.Send("try me")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 2);
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'a failure puts it straight up again');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 3);
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4);
  vm.run('STUB.prints = {}');
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false', 'after SHOT_RETRIES failures it waits for the normal retry');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4);
  // Every try failed: the reload outbox tells the bridge to fall back to the pixel capture, and the player hears once.
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.shot'), 'failed');
  assert.equal(vm.evaluate('#STUB.prints'), '1');
  assert.ok(vm.evaluate('STUB.prints[1]').includes('SCREENSHOT_FAILED 3 times'), vm.evaluate('STUB.prints[1]'));
  // The 40 s retry shoots it again, with the flag on the record.
  vm.run('STUB.now = STUB.now + 41; STUB.Tick()');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 5);
  const failed = stripRecords(vm).find(r => r.text === 'try me');
  assert.ok(failed && failed.flags.split(';').includes('shot=failed'), JSON.stringify(stripRecords(vm).map(r => r.flags)));
  vm.run('STUB.FireEvent("SCREENSHOT_FAILED")');
  assert.equal(vm.evaluate('#STUB.prints'), '1', 'not said again');
  // No event at all: the timeout hides the strip and counts it.
  vm.run('STUB.timers = {}; ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("quiet")');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 6);
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  vm.run('STUB.RunTimers()'); // the SHOT_TIMEOUT timer
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  vm.run('SlashCmdList.CLAUDE("diag")');
  const diag = vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text');
  assert.ok(diag.includes('6 taken, 1 confirmed, 4 failed, 1 without event'), diag);
  // Logging out restores the format; the mode itself is remembered.
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'png');
  vm.run('STUB.FireEvent("PLAYER_LOGOUT")');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transport'), 'screenshot');
});

test("screenshot transport without Screenshot(): the strip stays up carrying shot=missing, the reload outbox says so, the player is told once, and diag shows the bridge's fallback note", () => {
  const vm = newVM();
  vm.run('Screenshot = nil'); // a client without the function
  login(vm);
  vm.run('STUB.RunTimers()'); // SayHello
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('STUB.prints = {}; STUB.now = STUB.now + 6; STUB.Tick()'); // the hello poll learns the transport
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transport'), 'screenshot');
  assert.equal(vm.evaluate('STUB.cvars.screenshotFormat'), 'jpeg', 'the format CVar is left alone: no shot can be taken');
  // The hello counted as delivered pixel-style (the bridge was seen while it was up): nothing is on the strip now.
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'false');
  // A message: no shot can be taken, so the strip stays up pixel-style, every
  // record on it tells the bridge why, and the player hears about it once.
  vm.run('ClaudeWoW.Send("hello there")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 0);
  const told = () =>
    vm.evaluate(
      '(function() local n = 0; for _, l in ipairs(STUB.prints or {}) do if l:find("no Screenshot%(%) function") then n = n + 1 end end; return n end)()',
    );
  assert.equal(told(), '1', 'the player is told once');
  const recs = stripRecords(vm);
  assert.ok(
    recs.every(r => r.flags.split(';').includes('shot=missing')),
    JSON.stringify(recs.map(r => r.flags)),
  );
  const msg = recs.find(r => r.text === 'hello there');
  assert.ok(msg && msg.flags.split(';').includes('shot=missing'), JSON.stringify(recs.map(r => r.flags)));
  // The reload fallback's outbox carries the same report, so a /reload reaches the bridge with it.
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.shot'), 'missing');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.text'), Buffer.from('hello there').toString('hex'));
  vm.run('STUB.now = STUB.now + 41; STUB.Tick()');
  assert.equal(told(), '1', 'a retry does not say it again');
  // The bridge fell back: its slot says pixel, with the note; diag shows it and the flag goes away.
  nextSlot(
    vm,
    '{ now = time(), cwd = "", transport = "pixel", transportNote = "pixel transport, fallen back to since 2026-09-28 12:00 UTC because the game client has no Screenshot() function; the pixel capture is deprecated", replies = {} }',
  );
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transport'), 'pixel');
  assert.ok(
    stripRecords(vm).every(r => !r.flags.includes('shot=')),
    'on the pixel transport nothing is reported',
  );
  vm.run('ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("second")'); // the first chat still has its message pending
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.text'), Buffer.from('second').toString('hex'));
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.shot'), null);
  vm.run('SlashCmdList.CLAUDE("diag")');
  const diag = vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text');
  assert.ok(
    diag.includes('transport: pixel (bridge: pixel transport, fallen back to since 2026-09-28 12:00 UTC because the game client has no Screenshot() function'),
    diag,
  );
  // A bridge back on the screenshot transport drops the note.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.transportNote'), null);
});

// A client crash skips PLAYER_LOGOUT and its restore: the player's screenshots
// would silently stay in our format. The original is in the saved settings from
// the first change, and load gives it back when the value is still ours.
// Every shot is a full-screen file that only the bridge deletes. Once the bridge
// has been silent for as long as BridgeState's "down" window (5 min with presence
// beats), the addon stops shooting, says so once, and puts the strip up
// pixel-style instead, so the usual retries and fallback carry the message.
test('screenshot transport: shots stop once the bridge has been dark for a while, the player is told, Connect takes one by hand, and shooting resumes when the bridge is back', () => {
  const vm = newVM();
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\ctl\\\\valid.wav"] = true; STUB.armed = true');
  login(vm);
  vm.run('STUB.RunTimers()');
  vm.run('STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\presence\\\\a\\\\0001.wav"] = false');
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", presence = { ring = "a", at = 1, n = 2000, probe = "" }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.PresenceWorks()'), 'true', 'the login self-test saw the bridge delete a launch-time file');
  frames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 1);
  vm.run('ClaudeWoW.Send("still there?")');
  frames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 2);
  const prints = () => vm.evaluate('table.concat(STUB.prints, "\\n")') || '';
  // The bridge dies: its slot files keep the clock of its last write. After
  // 200 s it is only stale, and the retry still shoots.
  vm.run('local dead = time(); STUB.onLoadAddOn = function(name) ClaudeWoW_SlotData = { now = dead, cwd = "", transport = "screenshot", replies = {} } end');
  vm.run('STUB.now = STUB.now + 200; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the 40 s retry');
  frames(vm, 2);
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.equal(vm.num('STUB.screenshots'), 3);
  assert.ok(!prints().includes('screenshots paused'), 'nothing said while the bridge is merely stale');
  // Past 5 minutes it counts as down: the next retry puts the strip up pixel-style, no file.
  vm.run('STUB.now = STUB.now + 110; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true', 'the message is not dropped: the strip stays up as in pixel mode');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 3, 'no screenshot for a bridge that has been dark 5 minutes');
  assert.ok(prints().includes('bridge not seen for 5m10s: screenshots paused'), 'the player is told in the game chat: ' + prints());
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('screenshots paused'), 'and in the window');
  vm.run('STUB.prints = {}; ClaudeWoW.NewChat("Two"); ClaudeWoW.Send("anyone?")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 4, 'a message typed at a dark bridge buys one hello shot, like a Connect click');
  assert.ok(
    stripRecords(vm).find(r => r.text === 'still there?'),
    'the message that waited rides on that one shot',
  );
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  assert.ok(!prints().includes('screenshots paused'), 'said once, not per message');
  vm.run('SlashCmdList.CLAUDE("diag")');
  assert.ok(
    vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text').includes('screenshots PAUSED (bridge not seen for'),
    'diag says so',
  );
  vm.run('STUB.now = STUB.now + 20; STUB.Tick()');
  vm.run('STUB.now = STUB.now + 2; STUB.Tick()');
  frames(vm, 3);
  assert.equal(vm.num('STUB.screenshots'), 4, 'and no more');
  assert.ok(!prints().includes('resume'), 'a send is not the bridge coming back');
  // The bridge is back: a presence beat. Said once, and sends shoot again.
  vm.run(
    'STUB.sounds["Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\presence\\\\a\\\\0002.wav"] = false; STUB.prints = {}; STUB.now = STUB.now + 2; STUB.Tick()',
  );
  assert.ok(prints().includes('bridge is back: screenshots resume'), prints());
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  vm.run('ClaudeWoW.Send("back?")');
  assert.equal(vm.evaluate('ClaudeWoWStrip.shown'), 'true');
  frames(vm, 2);
  assert.equal(vm.num('STUB.screenshots'), 5, 'a message sent now is shot as usual');
  assert.ok(stripRecords(vm).find(r => r.text === 'back?'));
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  vm.run('STUB.now = STUB.now + 2; STUB.Tick()');
  assert.equal(prints().split('screenshots resume').length, 2, 'said once');
});

// Vision: a "v" flag on the record asks the bridge to attach the screenshot's
// game view to the run. Off by default; on per chat, or once with /claude-wow look.
test('vision: off by default; "vision on" flags every send and resend with v, "look" flags one message, footer and diag show it', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const flagsOf = text => (stripRecords(vm).find(r => r.text === text) || {}).flags;
  const reply = text => {
    const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
    nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "${text}", agent = "claude" } } }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  };
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.vision'), 'false', 'off by default');
  vm.run('ClaudeWoW.Send("plain")');
  assert.equal(flagsOf('plain'), 't', 'no vision flag while off');
  reply('ok');
  // The footer says so, and so does diag.
  vm.run('STUB.texts = {}; ClaudeWoW.UpdateStatus()');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('mode: pixel   vision: off'));
  vm.run('SlashCmdList.CLAUDE("diag")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('\nvision: off'));

  // "look" sends that one message with the flag; the setting stays off.
  vm.run('SlashCmdList.CLAUDE("look what is this item?")');
  assert.equal(flagsOf('what is this item?'), 'v');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.vision'), 'false');
  reply('a sword');
  vm.run('SlashCmdList.CLAUDE("look")');
  assert.equal(flagsOf('What do you see on my screen?'), 'v', 'a bare look asks the obvious question');
  reply('grass');
  // "look at my gear" is the command too (the whole line is the question).
  vm.run('SlashCmdList.CLAUDE("look at my gear")');
  assert.equal(flagsOf('at my gear'), 'v');
  reply('fine');

  // On: every send carries it, next to the other flags, and a resend keeps it.
  vm.run('SlashCmdList.CLAUDE("config vision on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.vision'), 'true');
  let note = vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  assert.ok(note.includes('Vision is ON, but the bridge listens on the pixel transport'), 'told it needs the screenshot transport: ' + note);
  vm.run('STUB.texts = {}; ClaudeWoW.UpdateStatus()');
  assert.ok(vm.evaluate('table.concat(STUB.texts, "|")').includes('mode: pixel   vision: on'));
  vm.run('SlashCmdList.CLAUDE("-c --agent codex")');
  vm.run('ClaudeWoW.Send("with the picture")');
  assert.equal(flagsOf('with the picture'), 'agent=codex;v');
  vm.run('ClaudeWoW.Resend()');
  assert.equal(flagsOf('with the picture'), 'agent=codex;v', 'a resend asks again (it is a fresh screenshot)');
  reply('seen');
  vm.run('SlashCmdList.CLAUDE("-c --agent default")');
  vm.run('SlashCmdList.CLAUDE("diag")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('\nvision: on (needs the screenshot transport'));
  // On a screenshot-mode bridge the status is the happy one.
  nextSlot(vm, '{ now = time(), cwd = "", transport = "screenshot", replies = {} }');
  vm.run('ClaudeWoW.Connect(); STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('SlashCmdList.CLAUDE("config vision")');
  note = vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  assert.ok(note.startsWith('Vision is ON: each message goes out with a picture of your screen'), note);
  vm.run('ClaudeWoW.Send("dark one")');
  assert.equal(flagsOf('dark one'), 'v');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
  reply('yes');
  // Off again: no flag, and the setting survives a reload (it is in the saved data).
  vm.run('SlashCmdList.CLAUDE("config vision off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.vision'), 'false');
  vm.run('ClaudeWoW.Send("no picture")');
  assert.equal(flagsOf('no picture'), '');
  vm.run('STUB.FireEvent("SCREENSHOT_SUCCEEDED")');
});

const WHISPER_DOCK = 'STUB.ChatDock()';

function connectAs(vm, agent) {
  vm.run('STUB.RunTimers()');
  nextSlot(vm, `{ now = time(), cwd = "", agent = "${agent}", agents = { "claude", "codex" }, replies = {} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true', 'connected after the hello slot');
}

function dockVM(saved) {
  const vm = newVM();
  vm.run(WHISPER_DOCK);
  if (saved) vm.run(saved);
  login(vm);
  return vm;
}

const tabLines = (vm, n) => vm.evaluate(`STUB.Lines(ChatFrame${n})`) || '';
const tabLinks = (vm, n) =>
  JSON.parse(
    vm.evaluate(
      `(function() local t = {} for _, l in ipairs(STUB.LinksIn(ChatFrame${n})) do t[#t + 1] = string.format("%q", l) end return "[" .. table.concat(t, ",") .. "]" end)()`,
    ),
  );
const pendingOf = (vm, id) => vm.num(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${id}" then return c.pendingId end end end)()`);
const slotReply = (vm, id, body) => {
  nextSlot(vm, `{ now = time(), cwd = "", agent = "claude", replies = { { chat = "${id}", id = ${pendingOf(vm, id)}, ${body} } } }`);
  for (let i = 0; i < 8; i++) vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
};

test('whisper tabs: on by default; the active chat is a tab at login, Enter there goes to the agent and never to the server, replies flash it', () => {
  const vm = dockVM();
  connectAs(vm, 'claude');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const enter = (box, text) => vm.run(`${box}:SetText("${text}"); ${box}.scripts.OnEnterPressed(${box})`);

  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'true', 'on by default');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisperNews'), null, 'a fresh install gets no "new" notice');
  assert.equal(vm.num('STUB.tempWindows'), 1, 'the tab opens once the bridge names its agent');
  assert.equal(vm.evaluate('ChatFrame11Tab.text'), 'Claude', "a chat with its default name is the agent's tab");
  assert.equal(vm.evaluate('ChatFrame11EditBox.attrs.tellTarget'), 'Claude', 'the box whispers the agent');
  assert.equal(vm.evaluate('ChatFrame11.shown'), 'false', 'opened in the dock without stealing the view');
  assert.ok(tabLines(vm, 11).includes('Type to talk'), 'a welcome line: ' + tabLines(vm, 11));
  assert.ok(tabLinks(vm, 11).includes(`addon:claudewow:open:${chatId}`), 'with a workspace link');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false', 'the workspace window stays closed');
  assert.equal(vm.evaluate('ClaudeWoWMini.shown'), 'true', 'a fresh install shows the compact bar with the status light');

  enter('ChatFrame11EditBox', 'from the tab');
  assert.equal(vm.num('STUB.serverSends'), 0, 'nothing reached the server');
  assert.ok(
    stripRecords(vm).find(r => r.text === 'from the tab'),
    'the message went out on the strip',
  );
  assert.equal(vm.evaluate('ChatFrame11EditBox:GetText()'), '', 'the box is emptied');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false', 'sending from the tab never opens the window');
  let out = tabLines(vm, 11);
  assert.ok(out.includes('To Claude: from the tab @1,0.5,1'), 'echoed as an outgoing whisper: ' + out);
  assert.match(out, /Claude is working\.\.\. 0s {2}\|Haddon:claudewow:cancel:\w+\|h.*@1,1,0/, 'one progress line with a cancel link');

  vm.run('ChatFrame11.shown = false; STUB.prints = {}');
  slotReply(vm, chatId, 'status = "working", text = "Reading files"');
  out = tabLines(vm, 11);
  assert.equal((out.match(/is working\.\.\./g) || []).length, 1, 'the progress line is edited in place, not repeated: ' + out);
  assert.match(out, /Claude is working\.\.\. \d+m? ?\d*s? - Reading files/, out);
  slotReply(vm, chatId, 'status = "working", text = "Editing Map.lua"');
  out = tabLines(vm, 11);
  assert.equal((out.match(/is working\.\.\./g) || []).length, 1, 'still one line');
  assert.ok(out.includes('Editing Map.lua') && !out.includes('Reading files'), 'showing the latest step');
  slotReply(vm, chatId, 'status = "working", text = "List my open PRs\\nRun gh search prs", steps = 2');
  out = tabLines(vm, 11);
  assert.match(out, /Claude is working\.\.\. [^\n]*· 2 steps - Run gh search prs {2}\|H/, 'the step count and only the newest step: ' + out);
  assert.ok(!out.includes('List my open PRs'), 'older steps stay out of the one-line tab: ' + out);

  slotReply(vm, chatId, 'status = "done", text = "hi back\\nsecond line", agent = "claude"');
  out = tabLines(vm, 11);
  assert.ok(out.includes('|Haddon:claudewow:reply:' + chatId + '|h[Claude]|h whispers: hi back @1,0.5,1'), 'first line formatted as a whisper: ' + out);
  assert.ok(out.includes('second line @1,0.5,1'), 'a short reply is shown whole');
  assert.ok(!out.includes('is working'), 'the progress line is gone once the reply lands');
  assert.deepEqual(vm.evaluate('table.concat(STUB.flashed, ",")'), 'ChatFrame11', 'the tab flashed');
  assert.ok(!vm.evaluate('table.concat(STUB.prints, "\\n")').includes('hi back'), 'no duplicate in General');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), 'hi back\nsecond line', 'the window has it too');

  enter('ChatFrame11EditBox', 'tell me everything');
  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of the long answer`).join('\\n');
  slotReply(vm, chatId, `status = "done", text = "${long}", summary = "TL;DR: it is long.\\nRead the rest in the window.", agent = "claude"`);
  out = tabLines(vm, 11);
  assert.ok(out.includes('whispers: TL;DR: it is long.'), 'a long reply shows its TL;DR: ' + out);
  assert.ok(!out.includes('line 30 of the long answer'), 'not the whole text');
  assert.match(out, /TL;DR of a longer reply \(30 lines\):\|r \|Haddon:claudewow:open:\w+\|h\|cff7ec8ff\[full reply\]/);
  vm.run(`STUB.ClickLink("|Haddon:claudewow:open:${chatId}|h[full reply]|h")`);
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true', 'the full reply link opens the workspace');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), chatId);
  vm.run('ClaudeWoW.Minimize(true)');

  enter('ChatFrame11EditBox', 'first');
  const before = stripRecords(vm).length;
  enter('ChatFrame11EditBox', 'too soon');
  assert.equal(stripRecords(vm).length, before, 'no second record while one is pending');
  assert.ok(tabLines(vm, 11).includes('is still working on #'), 'told in the tab');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].draft'), 'too soon');
  slotReply(vm, chatId, 'status = "done", text = "done", agent = "claude"');
  out = tabLines(vm, 11);
  assert.ok(out.includes('Waiting to go: too soon  |Haddon:claudewow:send:' + chatId + '|h'), 'the waiting message is offered with a send link: ' + out);
  vm.run(`STUB.ClickLink("|Haddon:claudewow:send:${chatId}|h[send it]|h")`);
  assert.ok(
    stripRecords(vm).find(r => r.text === 'too soon'),
    'the link sends it',
  );
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].draft'), null);
  slotReply(vm, chatId, 'status = "done", text = "ok", agent = "claude"');

  enter('ChatFrame1EditBox', '/w Claude ping');
  assert.ok(
    stripRecords(vm).find(r => r.text === 'ping'),
    '/w Claude from General reaches the agent',
  );
  assert.equal(vm.num('STUB.serverSends'), 0);
  slotReply(vm, chatId, 'status = "done", text = "pong", agent = "claude"');
  enter('ChatFrame1EditBox', '/w Bob hi');
  assert.equal(vm.num('STUB.serverSends'), 1, 'a real whisper still goes out');
  enter('ChatFrame11EditBox', '/s hello all');
  assert.equal(vm.num('STUB.serverSends'), 2, "another slash command in the tab is the game's");

  vm.run('SlashCmdList.CLAUDE("-n Second")');
  const secondId = vm.evaluate('ClaudeWoWDB.chats[2].id');
  assert.equal(vm.num('STUB.tempWindows'), 2, 'a new chat is a new tab');
  assert.equal(vm.evaluate('ChatFrame12Tab.text'), 'Second');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'false', 'and no window');
  vm.run('ClaudeWoW.Send("second hello")');
  assert.ok(tabLines(vm, 12).includes('To Claude: second hello'));
  slotReply(vm, secondId, 'status = "done", text = "for two", agent = "claude"');
  assert.ok(tabLines(vm, 12).includes('whispers: for two') && !tabLines(vm, 11).includes('for two'));
  vm.run('ClaudeWoW.Send("again")');
  slotReply(vm, secondId, 'status = "error", text = "boom"');
  assert.ok(tabLines(vm, 12).includes('Bridge error: boom  |Haddon:claudewow:open:' + secondId + '|h|cff7ec8ff[open]|r|h @1,1,0'), tabLines(vm, 12));

  vm.run('ClaudeWoWDB.settings.lootRoll = false');
  vm.run('ClaudeWoW.Send("once more")');
  const deniedId = pendingOf(vm, secondId);
  slotReply(
    vm,
    secondId,
    'status = "done", text = "need it", denied = { "Bash(rm:*)" }, macros = { { name = "Burst", body = "#showtooltip\\n/cast Arcane Power" } }',
  );
  out = tabLines(vm, 12);
  assert.ok(out.includes('needs permission for Bash(rm:*): |Haddon:claudewow:roll:' + secondId + ':' + deniedId + ':need|h'), out);
  assert.ok(out.includes('[Allow & retry]') && out.includes('[Allow once]') && out.includes('[Pass]'), 'the roll answers are links');
  assert.ok(
    out.includes('|Haddon:claudewow:macro:' + secondId + ':' + deniedId + ':1|h|cffffd100[Create macro: Burst]'),
    'a macro button becomes a link: ' + out,
  );
  vm.run(`STUB.ClickLink("|Haddon:claudewow:macro:${secondId}:${deniedId}:1|h[Create macro: Burst]|h")`);
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_MACRO', 'the macro link opens the Create-macro prompt');
  assert.match(vm.evaluate('STUB.popup.text'), /Create the macro "Burst"\?[\s\S]*\/cast Arcane Power/);
  assert.equal(vm.evaluate('STUB.popup.data.name'), 'Burst');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${secondId}:${deniedId}:greed|h[Allow once]|h")`);
  const retry = stripRecords(vm).find(r => r.text === 'Those actions are allowed for this run. Continue from where you left off.');
  assert.ok(retry && retry.flags.split(';').includes('once=Bash(rm:*)'), 'Greed from the tab retries once');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:roll:${secondId}:${deniedId}:need|h[Allow & retry]|h")`);
  assert.ok(tabLines(vm, 12).includes('That request was answered already.'), 'a stale answer link says so');
  slotReply(vm, secondId, 'status = "done", text = "done now", agent = "claude"');

  assert.ok(
    vm.evaluate(`select(2, STUB.filters.CHAT_MSG_SYSTEM(nil, "CHAT_MSG_SYSTEM", "No player named 'Claude' is currently playing."))`).includes('WHISPER LEAK'),
  );
  assert.equal(
    vm.evaluate(`select(2, STUB.filters.CHAT_MSG_SYSTEM(nil, "CHAT_MSG_SYSTEM", "No player named 'Bob' is currently playing."))`),
    null,
    'other names are left alone',
  );

  vm.run('SlashCmdList.CLAUDE("rename Renamed")');
  assert.equal(vm.evaluate('ChatFrame12Tab.text'), 'Renamed');
  vm.run('SlashCmdList.CLAUDE("delete")');
  assert.equal(vm.evaluate('ChatFrame12.inUse'), 'false', "the deleted chat's tab is closed");
  vm.run('STUB.prints = {}');
  vm.run('SlashCmdList.CLAUDE("config ui whisper off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'false');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisperChoice'), 'off', 'the choice is remembered as explicit');
  assert.equal(vm.evaluate('ChatFrame11.inUse'), 'false');
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('Whisper tabs are off'), 'said in the game chat, since the tab is gone');
  enter('ChatFrame1EditBox', '/w Claude ping');
  assert.equal(vm.num('STUB.serverSends'), 3, "off: a whisper is the game's again");
});

test('whisper default for existing installs: an explicit "off" stays off, an old default flips on once and says so, "on" stays on', () => {
  const offMsg = '{ role = "system", text = "Whisper tabs are off; replies go to the game chat as before", t = 1700000100 }';
  const onMsg = '{ role = "system", text = "Whisper tabs are ON: this chat is the \\"x\\" tab", t = 1700000000 }';
  const saved = (whisper, history) =>
    `ClaudeWoWDB = { settings = { whisper = ${whisper}, echoV2 = true, pluginsV1 = true, chatsPerCharacterV1 = true }, lastSeq = 3, session = "s1", forget = {}, activeChat = "c1", chats = { { id = "c1", name = "Chat 1", cwd = "", agent = "", plugin = "", unread = 0, history = { ${history} } } } }`;

  let vm = dockVM(saved('false', `${onMsg}, ${offMsg}`));
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'false', 'turned off by hand before: kept off');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisperChoice'), 'off');
  connectAs(vm, 'claude');
  assert.equal(vm.num('STUB.tempWindows'), 0, 'no tab opens');

  vm = dockVM(saved('false', `${offMsg}, ${onMsg.replace('1700000000', '1700000200')}`));
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'true', 'the last choice was on: on');

  vm = dockVM(saved('false', '{ role = "user", text = "hello", t = 1700000000, id = 1 }'));
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'true', 'the old default (never touched) moves to the new default');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisperV2'), 'true');
  connectAs(vm, 'claude');
  assert.match(tabLines(vm, 11), /New: chats live in whisper tabs like this one by default\. \/claude config ui whisper off goes back/, 'said once in the tab');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisperNews'), null, 'only once');

  vm.run('SlashCmdList.CLAUDE("config ui whisper off")');
  vm.run('ClaudeWoW.MigrateWhisper(ClaudeWoWDB.settings, false)');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'false', 'after the migration an explicit off is never flipped again');

  vm = dockVM(saved('true', ''));
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisperNews'), null, 'already on: nothing to announce');
});

test('/claude config ui: whisper, dim, dodge and autohide are settings that persist; bad values are refused', () => {
  const vm = dockVM();
  connectAs(vm, 'claude');
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  assert.equal(vm.num('ClaudeWoWDB.settings.dim'), 0.35, 'dims to 35% by default');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.dodge'), 'true');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.autohide'), 'true');
  vm.run('SlashCmdList.CLAUDE("config ui dim 50%")');
  assert.equal(vm.num('ClaudeWoWDB.settings.dim'), 0.5);
  vm.run('SlashCmdList.CLAUDE("config ui dim off")');
  assert.equal(vm.num('ClaudeWoWDB.settings.dim'), 1);
  assert.match(last(), /Dimming is off/);
  const chats = vm.num('#ClaudeWoWDB.chats');
  vm.run('SlashCmdList.CLAUDE("config ui dim 5")');
  assert.equal(vm.num('ClaudeWoWDB.settings.dim'), 1, 'below 10% the window would vanish: not a setting');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), chats + 1, 'so, like any command word that does not fit, it is a message');
  vm.run('ClaudeWoW.Config("ui dim 5")');
  assert.match(vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text'), /ui does not take "dim 5"/);
  vm.run('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id)');
  vm.run('SlashCmdList.CLAUDE("config ui dim on")');
  assert.equal(vm.num('ClaudeWoWDB.settings.dim'), 0.35);
  vm.run('SlashCmdList.CLAUDE("config ui dodge off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.dodge'), 'false');
  vm.run('SlashCmdList.CLAUDE("config ui autohide off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.autohide'), 'false');
  vm.run('SlashCmdList.CLAUDE("config")');
  assert.match(last(), /\nui = whisper on, dim 35%, dodge off, autohide off {2}- {2}/);
  vm.run('SlashCmdList.CLAUDE("config whisper off")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisperChoice'), 'off', 'the old spelling is the same setting');
  vm.run('SlashCmdList.CLAUDE("config ui whisper on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.whisper'), 'true');
  assert.match(last(), /^Whisper tabs are ON/);
});

test('the bridge status line: a silent bridge is said once in the tab with a connect link, and its return too', () => {
  const vm = dockVM();
  connectAs(vm, 'claude');
  vm.run('STUB.onLoadAddOn = nil; STUB.now = STUB.now + 800; STUB.Tick()');
  let out = tabLines(vm, 11);
  assert.match(out, /Bridge quiet for a while\. \|Haddon:claudewow:connect\|h/, out);
  vm.run('STUB.now = STUB.now + 600; STUB.Tick()');
  out = tabLines(vm, 11);
  assert.match(out, /Bridge: not seen for .* - is the bridge running\? \|Haddon:claudewow:connect\|h/, out);
  assert.ok(!out.includes('Bridge quiet'), 'the status line is replaced, not stacked');
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", agent = "claude", replies = {} }');
  vm.run('STUB.ClickLink("|Haddon:claudewow:connect|h[connect]|h")');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  assert.ok(tabLines(vm, 11).includes('Bridge is back.'));
});

function whisperVM() {
  const vm = newVM();
  vm.run(WHISPER_DOCK);
  vm.run(`SNAP = { g = {}, util = {}, enter = ChatFrame1EditBox:GetScript("OnEnterPressed") }
    for k, v in pairs(_G) do if type(v) == "function" then SNAP.g[k] = v end end
    for k, v in pairs(ChatFrameUtil) do SNAP.util[k] = v end`);
  login(vm);
  connect(vm);
  return vm;
}

const typeIn = (vm, box, text) => vm.run(`${box}:SetText(${JSON.stringify(text)}); STUB.PressEnter(${box})`);
const replyTo = (vm, id, body) => {
  const pending = vm.num(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${id}" then return c.pendingId end end end)()`);
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${id}", id = ${pending}, ${body} } } }`);
  for (let i = 0; i < 8; i++) vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
};

function replacedFunctions(vm) {
  return vm.evaluate(`(function()
    local bad = {}
    local function secure(fn) return STUB.secureHooks[fn] == true end
    for k, v in pairs(SNAP.g) do
      if _G[k] ~= v and not secure(_G[k]) then bad[#bad + 1] = k end
    end
    for k, v in pairs(SNAP.util) do
      if ChatFrameUtil[k] ~= v and not secure(ChatFrameUtil[k]) then bad[#bad + 1] = "ChatFrameUtil." .. k end
    end
    for _, name in ipairs(CHAT_FRAMES) do
      local eb = _G[name].editBox
      for k, v in pairs(ChatFrameEditBoxMixin) do
        if eb[k] ~= v and not secure(eb[k]) then bad[#bad + 1] = name .. "EditBox:" .. k end
      end
      for script, fn in pairs(eb.scripts) do
        if script ~= "OnEnterPressed" or fn ~= SNAP.enter then bad[#bad + 1] = name .. "EditBox script " .. script end
      end
      if next(eb.hooks) then bad[#bad + 1] = name .. "EditBox HookScript" end
      for _, k in ipairs({ "OnEnterPressed", "SendMessage", "SendText", "ParseText", "OnPreSendText" }) do
        if eb[k] ~= ChatFrameEditBoxMixin[k] then bad[#bad + 1] = name .. "EditBox:" .. k .. " (send path)" end
      end
    end
    for _, hook in ipairs(STUB.editBoxHooks) do bad[#bad + 1] = "hooksecurefunc on edit box " .. hook end
    if ChatEdit_SendText ~= SNAP.g.ChatEdit_SendText then bad[#bad + 1] = "ChatEdit_SendText (send path)" end
    if ChatFrameUtil.SendText ~= SNAP.util.SendText then bad[#bad + 1] = "ChatFrameUtil.SendText (send path)" end
    return table.concat(bad, ", ")
  end)()`);
}

test("whisper tabs replace nothing of the game's: no global, ChatFrameUtil entry, edit-box method or script is swapped for addon code", () => {
  const vm = whisperVM();
  vm.run('SlashCmdList.CLAUDE("-c --agent claude")');
  vm.run('SlashCmdList.CLAUDE("config whisper on")');
  assert.equal(vm.num('STUB.tempWindows'), 1);
  vm.run('SlashCmdList.CLAUDE("-n Second")');
  vm.run('ClaudeWoW.Send("open a second tab")');
  assert.equal(vm.num('STUB.tempWindows'), 2);
  assert.equal(replacedFunctions(vm), '');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text').includes('Whisper tabs are ON'));
  vm.run('SlashCmdList.CLAUDE("diag")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text').includes('send hook: pre-send'));
});

test("protected slash commands typed in the game's box or a whisper tab reach the game's handler with no addon function on the stack", () => {
  const vm = whisperVM();
  vm.run('SlashCmdList.CLAUDE("-c --agent claude")');
  vm.run('SlashCmdList.CLAUDE("config whisper on")');
  for (const box of ['ChatFrame1EditBox', 'ChatFrame11EditBox']) {
    vm.run('STUB.protectedCalls = {}');
    typeIn(vm, box, '/cast Fireball');
    typeIn(vm, box, '/gquit');
    typeIn(vm, box, '/sit');
    assert.equal(vm.evaluate('#STUB.protectedCalls'), '3', box);
    assert.equal(vm.evaluate('STUB.protectedCalls[1].name .. ":" .. STUB.protectedCalls[1].arg'), 'CastSpellByName:Fireball', box);
    assert.equal(vm.evaluate('STUB.protectedCalls[2].name'), 'GuildLeave', box);
    for (let i = 1; i <= 3; i++)
      assert.equal(vm.evaluate(`STUB.protectedCalls[${i}].tainted`), 'false', `${box} call ${i} ran tainted: addon code ran earlier in this Enter`);
  }
  const sentBefore = vm.num('#STUB.chatSent');
  typeIn(vm, 'ChatFrame1EditBox', 'hello everyone');
  typeIn(vm, 'ChatFrame1EditBox', '/g guild hello');
  assert.equal(vm.num('#STUB.chatSent'), sentBefore + 2);
  assert.equal(vm.evaluate(`STUB.chatSent[${sentBefore + 1}].chatType .. ":" .. tostring(STUB.chatSent[${sentBefore + 1}].tainted)`), 'SAY:false');
  assert.equal(vm.evaluate(`STUB.chatSent[${sentBefore + 2}].chatType .. ":" .. tostring(STUB.chatSent[${sentBefore + 2}].tainted)`), 'GUILD:false');
  typeIn(vm, 'ChatFrame11EditBox', 'to the agent');
  assert.equal(vm.num('#STUB.chatSent'), sentBefore + 2, "the tab's whisper never reaches the server");
  assert.ok(stripRecords(vm).find(r => r.text === 'to the agent'));
  assert.equal(replacedFunctions(vm), '');
});

test("slash commands: /skill typed in a coding chat's whisper tab goes to that chat and never to the server", () => {
  const vm = whisperVM();
  vm.run('SlashCmdList.CLAUDE("-c --agent claude")');
  vm.run('SlashCmdList.CLAUDE("config whisper on")');
  vm.run('ClaudeWoWDB.chats[1].cwd = "/Users/me/every"; ClaudeWoWDB.chats[1].plugin = "claude-code"');
  vm.run('ClaudeWoW.ApplySkills({ "babysit-pr" })');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  const sentBefore = vm.num('#STUB.chatSent');
  typeIn(vm, 'ChatFrame11EditBox', '/babysit-pr 18632');
  const recs = stripRecords(vm).filter(r => r.text === '/babysit-pr 18632');
  assert.equal(recs.length, 1, 'the command reached the chat once');
  const rec = recs[0];
  assert.equal(rec.chat, vm.evaluate('ClaudeWoWDB.chats[1].id'));
  assert.equal(vm.num('#STUB.chatSent'), sentBefore, 'nothing reached the server');
  assert.equal(vm.num('STUB.serverSends'), 0);
});

test("the fallback chat list pages 16 at a time and opens on the active chat's page", () => {
  const vm = whisperVM();
  vm.run('for i = 2, 20 do ClaudeWoW.NewChat("c" .. i) end');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 20);
  const shown = () =>
    vm.evaluate('(function() local t = {} for _, b in ipairs(ClaudeWoW.UI.chatButtons) do if b.shown then t[#t + 1] = b.chatId end end return #t end)()');
  const selected = () =>
    vm.evaluate('(function() for _, b in ipairs(ClaudeWoW.UI.chatButtons) do if b.shown and b.selected.shown then return b.chatId end end end)()');
  assert.equal(vm.evaluate('ClaudeWoW.UI.pageLabel:GetText()'), '2 / 2', 'the new 20th chat is active, so page 2 shows');
  assert.equal(Number(shown()), 4);
  assert.equal(selected(), vm.evaluate('ClaudeWoWDB.activeChat'), 'and its row is highlighted');
  vm.run('ClaudeWoW.UI.pagePrev.scripts.OnClick(ClaudeWoW.UI.pagePrev)');
  assert.equal(vm.evaluate('ClaudeWoW.UI.pageLabel:GetText()'), '1 / 2');
  assert.equal(Number(shown()), 16);
  vm.run('ClaudeWoW.UI.pagePrev.scripts.OnClick(ClaudeWoW.UI.pagePrev)');
  assert.equal(vm.evaluate('ClaudeWoW.UI.pageLabel:GetText()'), '1 / 2', 'it does not go below the first page');
  vm.run('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[18].id)');
  assert.equal(vm.evaluate('ClaudeWoW.UI.pageLabel:GetText()'), '2 / 2', 'switching chats follows the active chat');
});

const chatName = (vm, id) => vm.evaluate(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${id}" then return c.name end end end)()`);

test('/r to an agent is swallowed before the send with whisper tabs off too, and a /r name that reaches the server is a LEAK', () => {
  const vm = whisperVM();
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run('SlashCmdList.CLAUDE("-c --agent claude")');
  vm.run('SlashCmdList.CLAUDE("config ui whisper off")');
  vm.run('ClaudeWoW.Send("question")');
  replyTo(vm, chatId, 'status = "done", text = "answer", agent = "claude"');
  typeIn(vm, 'ChatFrame1EditBox', '/r tabs are off');
  assert.equal(stripRecords(vm).find(r => r.text === 'tabs are off').chat, chatId);
  assert.equal(vm.num('STUB.serverSends'), 0, 'the pre-send callback emptied the box');
  assert.equal(vm.evaluate('ChatFrame1EditBox:GetText()'), '');

  const name = `Claude [${chatName(vm, chatId)}]`;
  const leak = vm.evaluate(
    `(function() local hide, msg = STUB.filters.CHAT_MSG_SYSTEM(nil, "CHAT_MSG_SYSTEM", "No player named '${name}' is currently playing.") return tostring(hide) .. "|" .. tostring(msg) end)()`,
  );
  assert.match(leak, /^false\|.*WHISPER LEAK: No player named 'Claude \[/, leak);
  const other = vm.evaluate(
    `(function() local hide, msg = STUB.filters.CHAT_MSG_SYSTEM(nil, "CHAT_MSG_SYSTEM", "No player named 'Bob' is currently playing.") return tostring(hide) .. "|" .. tostring(msg) end)()`,
  );
  assert.equal(other, 'false|nil', "a real name is the game's message");
});

test('taint: /r to an agent taints only the last-tell list; /cast and /gquit typed afterwards run untainted, and /r to a real player still sends through the game', () => {
  const clean = whisperVM();
  clean.run('STUB.FireEvent("CHAT_MSG_WHISPER", "hey", "Bob")');
  typeIn(clean, 'ChatFrame1EditBox', '/r hi Bob');
  assert.equal(
    clean.evaluate('STUB.chatSent[1].target .. ":" .. tostring(STUB.chatSent[1].tainted)'),
    'Bob:false',
    'control: with no agent reply the list is secure',
  );

  const vm = whisperVM();
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run('SlashCmdList.CLAUDE("-c --agent claude")');
  vm.run('ClaudeWoW.Send("question")');
  replyTo(vm, chatId, 'status = "done", text = "answer", agent = "claude"');
  assert.equal(vm.evaluate('STUB.lastTellTaint[1]'), 'true', "the addon's write taints the entry it wrote");
  assert.equal(vm.evaluate('STUB.lastTellTaint[2]'), 'true', 'and every slot it shifted');

  typeIn(vm, 'ChatFrame1EditBox', '/r thanks');
  assert.equal(vm.evaluate('tostring(ChatFrame1EditBox.attrTaint.tellTarget)'), 'true', 'the /r line read the list, so the box it set up is tainted');

  const tab = vm.evaluate(
    `(function() for _, name in ipairs(CHAT_FRAMES) do if _G[name].claudewowChatId == "${chatId}" then return name .. "EditBox" end end end)()`,
  );
  assert.ok(tab);
  vm.run('STUB.FireEvent("CHAT_MSG_WHISPER", "hey", "Bob")');
  assert.equal(vm.evaluate('STUB.lastTell[1] .. "|" .. STUB.lastTell[2]'), `Bob|Claude [${chatName(vm, chatId)}]`);
  typeIn(vm, 'ChatFrame1EditBox', '/r hi Bob');
  assert.equal(vm.num('STUB.serverSends'), 1);
  assert.equal(
    vm.evaluate('STUB.chatSent[1].chatType .. ":" .. STUB.chatSent[1].target .. ":" .. STUB.chatSent[1].text'),
    'WHISPER:Bob:hi Bob',
    'the game sent it, the addon did not touch it',
  );
  assert.equal(vm.evaluate('tostring(STUB.chatSent[1].tainted)'), 'true', 'it ran tainted after reading the list, which SendChatMessage allows');

  for (const box of ['ChatFrame1EditBox', tab]) {
    vm.run('STUB.protectedCalls = {}');
    typeIn(vm, box, '/cast Fireball');
    typeIn(vm, box, '/gquit');
    assert.equal(vm.num('#STUB.protectedCalls'), 2, box);
    assert.equal(vm.evaluate('STUB.protectedCalls[1].name .. ":" .. tostring(STUB.protectedCalls[1].tainted)'), 'CastSpellByName:false', box);
    assert.equal(vm.evaluate('STUB.protectedCalls[2].name .. ":" .. tostring(STUB.protectedCalls[2].tainted)'), 'GuildLeave:false', box);
  }
  assert.equal(replacedFunctions(vm), '');
});

test("plugins: a fresh install follows the bridge's default and sends no flag; chats from before plugins stay bound to claude-code; a new chat starts with no project; a restore brings the binding", () => {
  // Fresh saved data: chat 1 is bound to nothing, so a message carries no plugin flag
  // and the bridge routes it to its default (ask).
  const vm = newVM();
  login(vm);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), '');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.pluginsV1'), 'true');
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", plugin = "ask", plugins = { "ask", "claude-code" }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  vm.run('ClaudeWoW.Send("what drops the sword")');
  const rec = stripRecords(vm).find(r => r.text === 'what drops the sword');
  assert.equal(rec.flags, 't');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.plugin'), null);
  vm.run('ClaudeWoW.NewChat("Second")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].plugin'), '');
  // A restored chat comes back with the plugin the bridge's transcript names.
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  const token = vm.evaluate('ClaudeWoWDB.session');
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "ok", plugin = "ask" } }, restore = { token = "${token}", chats = { { id = "old1", name = "Old work", cwd = "", plugin = "claude-code", messages = { { role = "user", id = 1, t = 1, text = "q" } } } } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 3);
  assert.equal(vm.evaluate('(function() for _, ch in ipairs(ClaudeWoWDB.chats) do if ch.id == "old1" then return ch.plugin end end end)()'), 'claude-code');

  // Saved data from before plugins existed: every chat was a coding chat, and
  // says so on the wire from now on; the migration runs once.
  const old = newVM();
  old.run(
    'ClaudeWoWDB = { chats = { { id = "c1", name = "Old", cwd = "realms", history = {}, unread = 0, created = 1 } }, activeChat = "c1", settings = { chatsPerCharacterV1 = true } }',
  );
  login(old);
  assert.equal(old.evaluate('ClaudeWoWDB.chats[1].plugin'), 'claude-code');
  connect(old);
  old.run('ClaudeWoW.Send("fix the build")');
  const coding = stripRecords(old).find(r => r.text === 'fix the build');
  assert.equal(coding.flags, 'plugin=claude-code');
  assert.equal(coding.cwd, 'realms');
  assert.equal(old.evaluate('ClaudeWoWDB.outbox.plugin'), 'claude-code');
  old.run('ClaudeWoW.Resend()');
  assert.equal(stripRecords(old).find(r => r.text === 'fix the build').flags, 'plugin=claude-code', 'a resend keeps the binding');
  old.run('ClaudeWoW.NewChat("More code")');
  assert.equal(old.evaluate('ClaudeWoWDB.chats[2].plugin'), '', 'a new chat starts with no project, not the binding of the chat it was made from');
  assert.equal(old.evaluate('ClaudeWoWDB.chats[2].cwd'), '');
  // A chat unbound later stays unbound after a reload: the migration does not run again.
  old.run('ClaudeWoWDB.chats[2].plugin = ""; STUB.FireEvent("ADDON_LOADED", "ClaudeWoW")');
  assert.equal(old.evaluate('ClaudeWoWDB.chats[2].plugin'), '');
});

test('plugins: /claude config plugin binds the chat like --agent, the Plugin... menu item opens a prefilled prompt, the footer and diag show the binding', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "", plugin = "ask", plugins = { "ask", "claude-code" }, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  const texts = () => vm.evaluate('table.concat(STUB.texts, "|")');
  assert.ok(vm.evaluate('ClaudeWoWChatMenu ~= nil') === 'true' && texts().includes('Plugin...'), 'the chat menu has a Plugin... item');
  // Bound to nothing: the footer names the bridge's default, and so does the command.
  assert.ok(texts().includes('vision: off   plugin: ask (bridge default)'), texts());
  vm.run('SlashCmdList.CLAUDE("config plugin")');
  assert.ok(last().startsWith("plugin is the bridge's default: ask"), last());
  // Bind to the coding plugin: the flag goes out with the next message, on both transports.
  vm.run('SlashCmdList.CLAUDE("config plugin Claude-Code")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), 'claude-code');
  assert.ok(last().includes('plugin set to claude-code'), last());
  vm.run('ClaudeWoW.Send("fix the build")');
  assert.equal(stripRecords(vm).find(r => r.text === 'fix the build').flags, 'plugin=claude-code;t');
  assert.equal(vm.evaluate('ClaudeWoWDB.outbox.plugin'), 'claude-code');
  vm.run('STUB.texts = {}; ClaudeWoW.UpdateStatus()');
  assert.ok(texts().includes('vision: off   plugin: claude-code'), texts());
  vm.run('SlashCmdList.CLAUDE("diag")');
  assert.ok(last().includes('\nplugin: claude-code (bridge has: ask, claude-code)'), last());
  // An unknown plugin is refused; "default" unbinds; a message that merely starts with the word is sent.
  vm.run('SlashCmdList.CLAUDE("config plugin factory")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), 'claude-code');
  assert.ok(last().includes('Unknown plugin "factory"'), last());
  vm.run('SlashCmdList.CLAUDE("config plugin default")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), '');
  assert.ok(last().includes("plugin reset to the bridge's default: ask"), last());
  vm.run('SlashCmdList.CLAUDE("diag")');
  assert.ok(last().includes('\nplugin: bridge default, ask (bridge has: ask, claude-code)'), last());
  vm.run('SlashCmdList.CLAUDE("config plugin for my warrior please")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), '');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'free text after config plugin is a message for a new chat');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].history[#ClaudeWoWDB.chats[2].history].text'), 'config plugin for my warrior please');
  vm.run('SlashCmdList.CLAUDE("cancel"); ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id)');
  // The Plugin... menu item opens a prompt prefilled with the chat's binding; OK applies it.
  vm.run('ClaudeWoW.SetPlugin("ask"); ClaudeWoW.PluginPrompt()');
  assert.equal(vm.evaluate('STUB.popup.which'), 'CLAUDEWOW_PLUGIN');
  assert.equal(vm.evaluate('STUB.popup.data.plugin'), 'ask');
  vm.run(`local dialog = { editBox = { GetText = function() return "claude-code" end } }
    StaticPopupDialogs.CLAUDEWOW_PLUGIN.OnAccept(dialog, STUB.popup.data)`);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].plugin'), 'claude-code');
  // Help lists the command.
  vm.run('SlashCmdList.CLAUDE("config")');
  assert.ok(last().includes('\nplugin = claude-code  -  <name>|default: advanced'), last());
  vm.run('SlashCmdList.CLAUDE("help")');
  assert.ok(!/\bplugin\b/.test(last()), 'help does not need the word plugin');
});

function parsed(vm, msg) {
  vm.run(`local o = ClaudeWoW.ParseCli(${JSON.stringify(msg)})
    local keys = {}
    for k, v in pairs(o) do
      if k == "addDir" then
        keys[#keys + 1] = "addDir=" .. table.concat(v, "|")
      else
        keys[#keys + 1] = k .. "=" .. tostring(v)
      end
    end
    table.sort(keys)
    RESULT = table.concat(keys, ";")`);
  return Object.fromEntries(
    vm
      .evaluate('RESULT')
      .split(';')
      .map(kv => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i), kv.slice(i + 1)];
      }),
  );
}

test('the /claude parser: short and long flags, --flag=value, quotes, flags before text, and text that only looks like a flag', () => {
  const vm = newVM();
  login(vm);
  let o = parsed(vm, 'fix the build');
  assert.equal(o.flags, '0');
  assert.equal(o.text, 'fix the build');
  o = parsed(vm, '-c keep going');
  assert.equal(o.continue, 'true');
  assert.equal(o.text, 'keep going');
  o = parsed(vm, '--continue');
  assert.equal(o.continue, 'true');
  assert.equal(o.text, '');
  o = parsed(vm, '--model opus --effort=high fix the build');
  assert.equal(o.model, 'opus');
  assert.equal(o.effort, 'high');
  assert.equal(o.text, 'fix the build');
  o = parsed(vm, '--model="claude-opus-5[1m]" --permission-mode plan  "quoted  text"');
  assert.equal(o.model, 'claude-opus-5[1m]');
  assert.equal(o.permissionMode, 'plan');
  assert.equal(o.text, 'quoted  text');
  o = parsed(vm, '--add-dir "My Addons" --add-dir=~/notes -c look here');
  assert.equal(o.addDir, 'My Addons|~/notes');
  assert.equal(o.continue, 'true');
  assert.equal(o.text, 'look here');
  o = parsed(vm, '-r abc123 go on');
  assert.equal(o.resume, 'abc123');
  assert.equal(o.text, 'go on');
  o = parsed(vm, '-r');
  assert.equal(o.resume, 'true');
  o = parsed(vm, '--resume "Old work" --agent codex');
  assert.equal(o.resume, 'Old work');
  assert.equal(o.agent, 'codex');
  o = parsed(vm, '--model');
  assert.equal(o.model, 'true', 'a flag with no value asks for the current one');
  o = parsed(vm, '-n Raid prep -c');
  assert.equal(o.name, 'Raid');
  assert.equal(o.text, 'prep -c', 'a flag after the text is text');
  o = parsed(vm, '--verbose output is too long, why?');
  assert.equal(o.flags, '0');
  assert.equal(o.text, '--verbose output is too long, why?');
  o = parsed(vm, '-5 degrees outside, what should I wear');
  assert.equal(o.flags, '0');
  assert.equal(o.text, '-5 degrees outside, what should I wear');
  o = parsed(vm, '--model sonnet -- -c is not a flag here');
  assert.equal(o.model, 'sonnet');
  assert.equal(o.text, '-c is not a flag here');
  o = parsed(vm, '"-c" in quotes is text');
  assert.equal(o.flags, '0');
  assert.equal(o.text, '"-c" in quotes is text');
});

test('/claude flags set per-chat settings: with text on a new chat, with -c on the current one; they travel on the strip and in the outbox', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const firstId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run('SlashCmdList.CLAUDE("--model opus --effort HIGH --permission-mode PLAN --add-dir realms fix the build")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'flags with text start a new chat, like claude --model opus "..."');
  const chat = 'ClaudeWoWDB.chats[2]';
  assert.equal(vm.evaluate(`${chat}.model`), 'opus');
  assert.equal(vm.evaluate(`${chat}.effort`), 'high');
  assert.equal(vm.evaluate(`${chat}.permissionMode`), 'plan');
  assert.equal(vm.evaluate(`${chat}.addDirs[1]`), 'realms');
  let rec = stripRecords(vm).find(r => r.text === 'fix the build');
  assert.equal(rec.chat, vm.evaluate(`${chat}.id`));
  const flags = rec.flags.split(';');
  assert.ok(flags.includes('model=opus') && flags.includes('effort=high') && flags.includes('pm=plan'), rec.flags);
  assert.ok(flags.includes('dirs=' + Buffer.from('realms').toString('hex')), rec.flags);
  const opts = Buffer.from(vm.evaluate('ClaudeWoWDB.outbox.opts'), 'hex').toString('utf8');
  assert.ok(opts.includes('model=opus') && opts.includes('pm=plan'), opts);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].model'), null, 'the first chat is untouched');
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run('SlashCmdList.CLAUDE("-c --model sonnet --effort -")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, '-c changes the current chat');
  assert.equal(vm.evaluate(`${chat}.model`), 'sonnet');
  assert.equal(vm.evaluate(`${chat}.effort`), null, 'a value of - clears it');
  const last = () => vm.evaluate(`${chat}.history[#${chat}.history].text`);
  assert.ok(last().includes('model: sonnet') && last().includes("effort: the agent's default"), last());
  vm.run('SlashCmdList.CLAUDE("--permission-mode")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'a bare flag only shows the setting');
  assert.equal(last(), 'permission mode: plan');
  vm.run('SlashCmdList.CLAUDE("--effort extreme do it")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'a bad value starts nothing');
  assert.ok(last().includes('Unknown effort "extreme"'), last());
  vm.run('SlashCmdList.CLAUDE("--permission-mode yolo")');
  assert.ok(last().includes('Unknown permission mode "yolo"'), last());
  vm.run('ClaudeWoW.Send("again")');
  vm.run('ClaudeWoW.Resend()');
  assert.ok(
    stripRecords(vm)
      .find(r => r.text === 'again')
      .flags.split(';')
      .includes('model=sonnet'),
    'a resend keeps the settings',
  );
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run(`ClaudeWoW.SwitchChat("${firstId}")`);
  vm.run('SlashCmdList.CLAUDE("-n Raid --agent codex plan the raid")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 3);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[3].name'), 'Raid');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[3].agent'), 'codex');
  assert.ok(
    stripRecords(vm)
      .find(r => r.text === 'plan the raid')
      .flags.split(';')
      .includes('agent=codex'),
  );
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run('SlashCmdList.CLAUDE("-c -n Raid night")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[3].name'), 'Raid', '-n takes one word; quote a longer name');
  vm.run('SlashCmdList.CLAUDE("-c -n \\"Raid night\\"")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[3].name'), 'Raid night');
  vm.run('SlashCmdList.CLAUDE("-h")');
  assert.ok(vm.evaluate('ClaudeWoWDB.chats[3].history[#ClaudeWoWDB.chats[3].history].text').startsWith('/claude <text>'));
});

test('/claude -r: bare lists running and recent sessions; a number, a name or an id picks one; a running session attaches live, another resumes headless, an ambiguous prefix lists the matches', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const now = 'time()';
  nextSlot(
    vm,
    `{ now = ${now}, cwd = "/home/me", plugins = { "ask", "claude-code", "live" }, live = { sessions = { "wow-ai (/Users/me/wow-ai)" }, start = "x" }, sessions = {
    { id = "6624f327-7126-423e-a653-d7cf7a4e492b", name = "wow-ai", cwd = "/Users/me/wow-ai", agent = "claude", at = ${now} - 30, live = true },
    { id = "f02436b8-8a5f-4c05-823e-bef25f88ff7b", name = "Claude version check", cwd = "/Users/me/proj", agent = "claude", at = ${now} - 7200 },
    { id = "abcd1111-0000-4000-8000-000000000001", name = "First abcd", cwd = "/a", agent = "claude", at = ${now} - 90000 },
    { id = "abcd2222-0000-4000-8000-000000000002", name = "Second abcd", cwd = "/b", agent = "codex", at = ${now} - 100000 },
  }, replies = {} }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  const firstId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const field = f => vm.evaluate(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then return c.${f} end end end)()`);
  const lastText = () => field('history[#c.history].text');
  vm.run('STUB.prints = {}');
  vm.run('SlashCmdList.CLAUDE("-r")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1, 'the list starts nothing');
  const list = vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  assert.match(list, /\n1\. wow-ai · wow-ai · now · live\n/);
  assert.match(list, /\n3\. Claude version check · proj · 2h ago · resume\n/);
  assert.match(list, /\n2\. Chat 1 · now · resume \(this chat\)\n/, 'chats and sessions by age');
  const prints = vm.evaluate('table.concat(STUB.prints, "\\n")');
  assert.ok(prints.includes('|Haddon:claudewow:resume:2|h'), 'each line in the game chat is a link that picks it');

  vm.run('SlashCmdList.CLAUDE("-r 1 where is the flight master?")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'attaching a running session opens a chat for it');
  assert.equal(field('liveTarget'), '6624f327-7126-423e-a653-d7cf7a4e492b');
  assert.equal(field('name'), 'wow-ai');
  let rec = stripRecords(vm).find(r => r.text === 'where is the flight master?');
  const liveFlags = rec.flags.split(';');
  assert.ok(liveFlags.includes('plugin=live'), rec.flags);
  assert.ok(liveFlags.includes('live=' + Buffer.from('6624f327-7126-423e-a653-d7cf7a4e492b').toString('hex')), rec.flags);
  assert.ok(!liveFlags.some(f => f.startsWith('resume=')), 'live, not headless');
  const liveChat = field('id');
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run(`ClaudeWoW.SwitchChat("${firstId}")`);
  vm.run('SlashCmdList.CLAUDE("-r wow-ai")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'the same session again goes back to its chat');
  assert.equal(field('id'), liveChat);

  vm.run('SlashCmdList.CLAUDE("-r f024 --model opus carry on")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 3, 'a session that is not running resumes headless in a chat of its own');
  assert.equal(field('cwd'), '/Users/me/proj');
  assert.equal(field('model'), 'opus');
  rec = stripRecords(vm).find(r => r.text === 'carry on');
  assert.equal(rec.cwd, '/Users/me/proj');
  const headless = rec.flags.split(';');
  assert.ok(headless.includes('resume=f02436b8-8a5f-4c05-823e-bef25f88ff7b'), rec.flags);
  assert.ok(headless.includes('plugin=claude-code') && headless.includes('agent=claude') && headless.includes('model=opus'), rec.flags);
  const headlessChat = field('id');
  replyTo(vm, headlessChat, 'status = "done", text = "resumed", agent = "claude", session = "f02436b8-8a5f-4c05-823e-bef25f88ff7b", cwd = "/Users/me/proj"');
  assert.equal(field('resumeId'), null, 'the resume goes out once');
  vm.run('ClaudeWoW.Send("next turn")');
  assert.ok(
    !stripRecords(vm)
      .find(r => r.text === 'next turn')
      .flags.includes('resume='),
    'later turns continue the adopted session',
  );
  vm.run('SlashCmdList.CLAUDE("cancel")');

  vm.run('SlashCmdList.CLAUDE("-r abcd")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 3, 'an ambiguous prefix attaches nothing');
  assert.match(lastText(), /^"abcd" matches 2 sessions/);
  assert.match(lastText(), /\n2\. Second abcd · b · 1d ago · resume/);
  vm.run('SlashCmdList.CLAUDE("-r 2")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 4, 'a number picks from the list just shown');
  assert.equal(field('resumeId'), 'abcd2222-0000-4000-8000-000000000002');
  assert.equal(field('agent'), 'codex', 'the session keeps the agent that made it');

  vm.run('SlashCmdList.CLAUDE("-r nothing-like-this")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 4);
  assert.match(lastText(), /No chat or session matches "nothing-like-this"/);

  vm.run('SlashCmdList.CLAUDE("-r 0123456789abcdef hello")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 5, 'an id the list does not have is handed to the bridge to look up');
  assert.equal(field('adoptCwd'), 'true');
  const lookedUp = field('id');
  assert.ok(
    stripRecords(vm)
      .find(r => r.text === 'hello')
      .flags.split(';')
      .includes('resume=0123456789abcdef'),
  );
  replyTo(vm, lookedUp, 'status = "done", text = "found it", agent = "claude", session = "0123456789abcdef-full", cwd = "/srv/found"');
  assert.equal(field('cwd'), '/srv/found', 'the folder the bridge found sticks to the chat');

  vm.run('SlashCmdList.CLAUDE("-r")');
  vm.run('SetItemRef("claudewow:resume:1")');
  assert.equal(field('id'), liveChat, 'clicking a line picks it');
  vm.run('SlashCmdList.CLAUDE("-r claude")');
  assert.equal(field('id'), headlessChat, 'a name prefix picks the one session it fits');
  vm.run('SlashCmdList.CLAUDE("-r \\"chat 1\\"")');
  assert.equal(field('id'), firstId, 'a chat name in quotes picks that chat');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 5);
});

const PICK_LIVE = '6624f327-7126-423e-a653-d7cf7a4e492b';
const PICK_DEAF = 'f02436b8-8a5f-4c05-823e-bef25f88ff7b';
const PICK_RESTART = `cd /Users/ryan/wow-ai && claude --resume ${PICK_DEAF} --dangerously-load-development-channels server:claude-wow`;

function pickerVM() {
  const vm = whisperVM();
  const headless = Array.from(
    { length: 12 },
    (_, i) =>
      `{ id = "0000000${i.toString(16)}-0000-4000-8000-000000000000", name = "Old task ${i + 1}", cwd = "/srv/p${i}", agent = "claude", at = time() - ${(i + 2) * 86400} },`,
  ).join('\n');
  vm.run(
    `ClaudeWoW.ApplyLive({ sessions = { "wow-ai (/Users/ryan/wow-ai)" }, start = "cd /repo && claude --dangerously-load-development-channels server:claude-wow" })`,
  );
  vm.run(`ClaudeWoW.ApplySessions({
    { id = "${PICK_DEAF}", name = "wow-ai", title = "Refactor the bridge", cwd = "/Users/ryan/wow-ai", branch = "main", agent = "claude", at = time() - 2280, running = true, restart = "${PICK_RESTART}" },
    { id = "${PICK_LIVE}", name = "wow-ai", title = "Fix the live picker", cwd = "/Users/ryan/wow-ai", branch = "fix/live-session-picker", agent = "claude", at = time() - 60, live = true, running = true },
    { id = "${PICK_DEAF}", name = "wow-ai", title = "Refactor the bridge", cwd = "/Users/ryan/wow-ai", branch = "main", agent = "claude", at = time() - 2280, running = true, restart = "${PICK_RESTART}" },
    ${headless}
  }, time())`);
  return vm;
}

const activeField = (vm, f) =>
  vm.evaluate(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then return c.${f} end end end)()`);
const tabOf = (vm, chatId) =>
  vm.evaluate(`(function() for _, name in ipairs(CHAT_FRAMES) do if _G[name].claudewowChatId == "${chatId}" then return name end end end)()`);
const chatTabText = (vm, chatId) =>
  vm.evaluate(
    `(function() local t = {} for _, m in ipairs(${tabOf(vm, chatId)}.messages or {}) do t[#t + 1] = m.text end return table.concat(t, "\\n") end)()`,
  );

test('/claude -r picker: short clickable rows with title, folder and branch, age and state; live first, duplicates collapsed, 8 rows and [more], this chat marked', () => {
  const vm = pickerVM();
  const firstId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run('SlashCmdList.CLAUDE("-r")');
  const text = vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  const lines = text.split('\n');
  assert.equal(lines[0], 'Sessions: click one to attach this chat, or /claude -r <n>.');
  assert.equal(lines[1], '1. Fix the live picker · wow-ai (fix/live-session-picker) · 1m ago · live');
  assert.equal(lines[2], '2. Refactor the bridge · wow-ai (main) · 38m ago · running, not listening');
  assert.equal(lines[3], '3. Chat 1 · now · resume (this chat)');
  assert.equal(lines[4], '4. Old task 1 · p0 · 2d ago · resume');
  assert.equal(lines.filter(l => /^\d+\. /.test(l)).length, 8, 'eight rows at most');
  assert.equal(lines[9], '[more] 7 older sessions: /claude -r more');
  assert.equal(text.split('Refactor the bridge').length, 2, 'the duplicate is one row');
  assert.doesNotMatch(text, /f02436b8|6624f327/, 'no ids to copy');

  const tab = chatTabText(vm, firstId);
  for (let i = 1; i <= 8; i++) assert.ok(tab.includes(`|Haddon:claudewow:resume:${i}|h`), `row ${i} is a link`);
  assert.ok(tab.includes('|Haddon:claudewow:sessions:all|h'), '[more] is a link');
  assert.ok(tab.includes('|cff55ff55live|r'), 'live badge in green');
  assert.ok(tab.includes('running, not listening'), tab);
  assert.ok(!tab.includes('resume:9|h'));

  const n = vm.num('#ClaudeWoWDB.chats[1].history');
  assert.equal(vm.num('#ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].picker'), 9, 'the workspace gets 8 rows and [more]');
  assert.equal(
    vm.evaluate(`ClaudeWoW.UI.bubbles[${n}].body.text`),
    'Sessions: click one to attach this chat, or /claude -r <n>.',
    'the bubble shows the header; the rows are buttons',
  );
  assert.match(vm.evaluate(`ClaudeWoW.UI.bubbles[${n}].rowBtns[1].label.text`), /^\|cff7ec8ff\[1\]\|r Fix the live picker .*\|cff55ff55live\|r$/);
  assert.equal(vm.evaluate(`ClaudeWoW.UI.bubbles[${n}].rowBtns[1].shown`), 'true');

  vm.run(`local b = ClaudeWoW.UI.bubbles[${n}].rowBtns[9]; b.scripts.OnClick(b)`);
  const all = vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  assert.equal(all.split('\n').filter(l => /^\d+\. /.test(l)).length, 15, '[more] lists them all');
  assert.doesNotMatch(all, /\[more\]/);
  vm.run('SlashCmdList.CLAUDE("-r more")');
  assert.equal(
    vm
      .evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text')
      .split('\n')
      .filter(l => /^\d+\. /.test(l)).length,
    15,
  );

  vm.run('SlashCmdList.CLAUDE("-r")');
  const m = vm.num('#ClaudeWoWDB.chats[1].history');
  vm.run(`local b = ClaudeWoW.UI.bubbles[${m}].rowBtns[1]; b.scripts.OnClick(b)`);
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'a click on a row attaches a chat');
  assert.equal(activeField(vm, 'liveTarget'), PICK_LIVE);
  vm.run('SlashCmdList.CLAUDE("-r")');
  const again = vm.evaluate(
    '(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then return c.history[#c.history].text end end end)()',
  );
  assert.match(again, /\n1\. Fix the live picker · wow-ai \(fix\/live-session-picker\) · 1m ago · live \(this chat\)\n/);
  const liveChat = activeField(vm, 'id');
  vm.run(`STUB.ClickLink("${'|Haddon:claudewow:resume:3|h'}")`);
  assert.equal(activeField(vm, 'id'), firstId, 'a chat link in the tab switches to that chat');
  vm.run('SlashCmdList.CLAUDE("-r 1")');
  assert.equal(activeField(vm, 'id'), liveChat, '/claude -r <n> still works');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2);
});

test('/claude -r on a session running without the channel: no live attach, the exact restart command, and a one-click headless resume', () => {
  const vm = pickerVM();
  const firstId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run('SlashCmdList.CLAUDE("-r")');
  vm.run('SlashCmdList.CLAUDE("-r 2 hello there")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1, 'nothing is attached to a session that cannot hear the game');
  assert.equal(
    stripRecords(vm).find(r => r.text === 'hello there'),
    undefined,
    'nothing is sent',
  );
  const notice = vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  assert.equal(
    notice,
    [
      'Refactor the bridge is running in a terminal, but it was not started with the claude-wow channel, so it cannot hear the game.',
      'Restart it in its terminal with:',
      PICK_RESTART,
      'Or resume it headless here: click [resume headless] below.',
      'Your message was not sent.',
    ].join('\n'),
  );
  const tab = chatTabText(vm, firstId);
  assert.ok(tab.includes(PICK_RESTART), 'the tab shows the command');
  assert.ok(tab.includes(`|Haddon:claudewow:headless:${PICK_DEAF}|h`), tab);
  assert.equal(vm.num('#ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].picker'), 1, 'the workspace gets a resume headless button');

  vm.run('SlashCmdList.CLAUDE("-r refactor")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 1, 'by name as well');
  vm.run(`STUB.ClickLink("|Haddon:claudewow:headless:${PICK_DEAF}|h")`);
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'the click resumes it headless in a chat of its own');
  assert.equal(activeField(vm, 'resumeId'), PICK_DEAF);
  assert.equal(activeField(vm, 'liveTarget'), null);
  assert.equal(activeField(vm, 'cwd'), '/Users/ryan/wow-ai');
});

test('a live reply that arrives after the watchdog failed the message still lands in the chat, once', () => {
  const vm = pickerVM();
  vm.run('SlashCmdList.CLAUDE("-r 1 hey!")');
  const chatId = activeField(vm, 'id');
  const id = vm.num(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${chatId}" then return c.pendingId end end end)()`);
  assert.ok(id >= 1);
  const failed = `{ chat = "${chatId}", id = ${id}, status = "error", text = "The session \\"wow-ai\\" did not pick it up — it may be busy or not listening. A late reply still lands here.", agent = "claude", plugin = "live", lateOk = true }`;
  nextSlot(vm, `{ now = time(), cwd = "", replies = { ${failed} } }`);
  for (let i = 0; i < 8 && activeField(vm, 'pendingId') !== null; i++) vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
  assert.equal(activeField(vm, 'pendingId'), null);
  assert.match(activeField(vm, 'history[#c.history].text'), /^Bridge error: The session "wow-ai" did not pick it up/);
  const late = `{ now = time(), cwd = "", replies = { ${failed}, { chat = "${chatId}", id = ${id}, status = "done", late = true, text = "Sorry, I was busy. Hi!", agent = "claude", plugin = "live" } } }`;
  nextSlot(vm, late);
  for (let i = 0; i < 30; i++) vm.run('STUB.now = STUB.now + 5; STUB.Tick()');
  const texts = JSON.parse(
    vm
      .evaluate(
        `(function() local t = {} for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${chatId}" then for _, m in ipairs(c.history) do t[#t + 1] = string.format("%q", m.role .. ":" .. m.text) end end end return "[" .. table.concat(t, ",") .. "]" end)()`,
      )
      .replace(/\\\n/g, '\\n'),
  );
  assert.equal(texts.filter(t => t === 'assistant:Sorry, I was busy. Hi!').length, 1, texts.join('\n'));
  assert.ok(chatTabText(vm, chatId).includes('Sorry, I was busy. Hi!'), 'it shows in the whisper tab');
});

test('/claude -r with no running session names the command that starts one, and Pass on a live chat sends the denial to that session', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(
    vm,
    '{ now = time(), cwd = "", plugin = "ask", plugins = { "ask", "claude-code", "live" }, live = { sessions = {}, start = "cd /repo && claude --dangerously-load-development-channels server:claude-wow" }, sessions = {}, replies = {} }',
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  vm.run('SlashCmdList.CLAUDE("-r")');
  assert.ok(last().endsWith('Start one with: cd /repo && claude --dangerously-load-development-channels server:claude-wow'), last());
  vm.run('ClaudeWoW.ApplySessions({ { id = "", name = "wow-ai", cwd = "/Users/me/wow-ai", agent = "claude", at = time(), live = true } }, time())');
  vm.run('SlashCmdList.CLAUDE("-r wow-ai")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].liveTarget'), 'wow-ai', 'without a session id the name is the target');
  vm.run('ClaudeWoW.Send("touch a file")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[2].id');
  const id = vm.num('ClaudeWoWDB.chats[2].pendingId');
  assert.ok(id >= 1);
  nextSlot(
    vm,
    `{ now = time(), cwd = "", plugins = { "ask", "claude-code", "live" }, replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "Claude Code (wow-ai) wants to use Bash.\\nRoll Need or Greed to allow it once, Pass to deny it.", agent = "claude", plugin = "live", denied = { "Bash(touch:*)" } } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].pendingId'), null, 'the roll prompt finished the message');
  vm.run('ClaudeWoWDB.chats[2].plugin = "live"');
  vm.run(`ClaudeWoW.PassOnDenial("${chatId}", { "Bash(touch:*)" })`);
  const denial = stripRecords(vm).find(r => r.text === 'Denied.');
  assert.ok(denial, 'Pass sends the denial on a live chat');
  assert.equal(denial.flags, 'agent=claude;plugin=live;live=' + Buffer.from('wow-ai').toString('hex'));
});

test('/claude config lists every setting with its value, gets one, sets one, and refuses keys it does not know', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  vm.run('SlashCmdList.CLAUDE("config")');
  const list = last();
  for (const key of [
    'voice',
    'roast',
    'whisper',
    'echo',
    'vision',
    'roll',
    'achievements',
    'context',
    'signal',
    'mode',
    'longchat',
    'auto',
    'plugin',
    'ui',
    'map',
    'macro',
    'bind',
    'diag',
  ]) {
    assert.match(list, new RegExp(`\\n${key}( = [^\\n]*)?  -  `), `${key} is listed`);
  }
  assert.match(list, /\nvision = off  -  /);
  assert.match(list, /\necho = summary  -  /);
  vm.run('SlashCmdList.CLAUDE("config vision on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.vision'), 'true');
  vm.run('SlashCmdList.CLAUDE("config vision")');
  assert.ok(last().startsWith('Vision is ON'), last());
  vm.run('SlashCmdList.CLAUDE("config echo 900")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.echo'), '900');
  vm.run('SlashCmdList.CLAUDE("config mode reload")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.mode'), 'reload');
  vm.run('SlashCmdList.CLAUDE("config mode pixel")');
  vm.run('SlashCmdList.CLAUDE("config ctx 50k")');
  assert.equal(vm.num('ClaudeWoWDB.settings.contextWarn'), 50000, 'an old spelling of a key still works');
  vm.run('SlashCmdList.CLAUDE("config diag")');
  assert.ok(last().startsWith('Diagnostics:'));
  vm.run('SlashCmdList.CLAUDE("config macro")');
  assert.ok(last().startsWith('macro: undo'), last());
  vm.run('SlashCmdList.CLAUDE("config")');
  assert.match(last(), /\nvision = on  -  /);
  const chats = vm.num('#ClaudeWoWDB.chats');
  vm.run('SlashCmdList.CLAUDE("config")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), chats, 'config never starts a chat');
});

test('/claude-wow is a hidden alias for one release: the old verbs still work, text continues the current chat, and nothing tells the player about it', () => {
  const vm = whisperVM();
  const firstId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const last = () =>
    vm.evaluate('(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == ClaudeWoWDB.activeChat then return c.history[#c.history].text end end end)()');
  vm.run('SlashCmdList.CLAUDEWOW("vision on")');
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.vision'), 'true');
  vm.run('SlashCmdList.CLAUDEWOW("vision off")');
  vm.run('SlashCmdList.CLAUDEWOW("agent codex")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].agent'), 'codex');
  vm.run('SlashCmdList.CLAUDEWOW("context 80k")');
  assert.equal(vm.num('ClaudeWoWDB.settings.contextWarn'), 80000);
  vm.run('SlashCmdList.CLAUDEWOW("new Realms")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[2].name'), 'Realms');
  vm.run('SlashCmdList.CLAUDEWOW("chat 1")');
  assert.equal(vm.evaluate('ClaudeWoWDB.activeChat'), firstId);
  vm.run('SlashCmdList.CLAUDEWOW("live")');
  assert.ok(last().startsWith('Sessions:'), last());
  typeIn(vm, 'ChatFrame1EditBox', '/claude-wow continue here');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 2, 'old text continues the current chat');
  assert.equal(stripRecords(vm).find(r => r.text === 'continue here').chat, firstId);
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run('SlashCmdList.CLAUDE("config whisper on")');
  const tab = vm.evaluate(
    `(function() for _, name in ipairs(CHAT_FRAMES) do if _G[name].claudewowChatId == "${firstId}" then return name .. "EditBox" end end end)()`,
  );
  vm.run(`ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[2].id)`);
  typeIn(vm, tab, '/claude-wow from the tab');
  assert.equal(stripRecords(vm).find(r => r.text === 'from the tab').chat, firstId, "old text in a tab goes to that tab's chat");
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run('ClaudeWoW.Toggle(false); SlashCmdList.CLAUDEWOW("")');
  assert.equal(vm.evaluate('ClaudeWoWFrame.shown'), 'true', 'bare /claude-wow still toggles the window');
  vm.run('SlashCmdList.CLAUDE("help")');
  assert.ok(!last().includes('/claude-wow'), 'help does not mention it');
  vm.run('SlashCmdList.CLAUDE("config")');
  assert.ok(!last().includes('/claude-wow'), 'config does not mention it');
  vm.run('ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[1].id); SlashCmdList.CLAUDE("clear"); ClaudeWoW.Render()');
  assert.equal(vm.num('STUB.serverSends'), 0);
});

// Context growth: the bridge reports, on every final reply, what the chat's next
// message will carry (ctx), the turns in the session and the model's window.
function footerText(vm) {
  vm.run(
    'RESULT = ""; for _, ch in ipairs(ClaudeWoWFrame.children) do if ch.kind == "FontString" and type(ch.text) == "string" and ch.text:sub(1, 4) == "cwd:" then RESULT = ch.text end end',
  );
  return vm.evaluate('RESULT');
}
function replyWith(vm, fields) {
  vm.run('ClaudeWoW.Send("msg")');
  const chatId = vm.evaluate('ClaudeWoWDB.activeChat');
  const id =
    vm.num('ClaudeWoWDB.chats[1].pendingId') ||
    vm.num('(function() for _, ch in ipairs(ClaudeWoWDB.chats) do if ch.pendingId then return ch.pendingId end end end)()');
  assert.ok(id >= 1, 'a message is pending');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "ok", ${fields} } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(
    vm.evaluate('(function() for _, ch in ipairs(ClaudeWoWDB.chats) do if ch.pendingId then return "pending" end end end)()'),
    null,
    'the reply landed',
  );
}

test('context growth: the footer, /claude-wow context and diag show ctx and turns from the reply record', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  assert.ok(footerText(vm).includes('plugin:'), footerText(vm));
  assert.ok(!footerText(vm).includes('·'), 'nothing known before the first reply');
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  // The numbers measured on a live machine: 106,863 tokens after 8 turns.
  // The footer reads like Claude Code's own status line: elapsed since the session
  // started, the tokens the next message carries, the session at API list prices.
  vm.run('SlashCmdList.CLAUDE("config context 100k")');
  replyWith(vm, 'ctx = 106863, turns = 8, window = 200000, since = time() - 718, cost = 2.41');
  assert.equal(vm.num('ClaudeWoWDB.chats[1].ctx'), 106863);
  assert.equal(vm.num('ClaudeWoWDB.chats[1].turns'), 8);
  assert.ok(footerText(vm).endsWith('   11m 58s · ↓ 106.9k tokens · ≈$2.41 API'), footerText(vm));
  // It ticks while the window is open and nothing is pending.
  vm.run('STUB.now = STUB.now + 62; STUB.Tick()');
  assert.ok(footerText(vm).includes('13m 00s · ↓'), footerText(vm));
  vm.run('SlashCmdList.CLAUDE("diag")');
  assert.ok(last().includes('context: warning at 100.0k tokens'), last());
  assert.ok(last().includes('Msg: 13m 00s · ↓ 106.9k tokens of 200.0k · ≈$2.41 API, 8 turns (warned)'), last());
  // Bare /claude-wow context: this chat's size and turns, the session, the threshold, then the game context as before.
  vm.run('SlashCmdList.CLAUDE("config context")');
  assert.ok(last().startsWith('Context: 106.9k tokens of 200.0k after 8 turns'), last());
  assert.ok(last().includes('Session: 13m 00s since it started; ≈$2.41 at API list prices so far (a comparison, not a bill'), last());
  assert.ok(last().includes('Warning at 100.0k tokens'), last());
  assert.ok(last().includes('Game context is ON'), last());
  // A working record carries nothing and changes nothing.
  vm.run('ClaudeWoW.Send("more")');
  let id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = { { chat = "${vm.evaluate('ClaudeWoWDB.activeChat')}", id = ${id}, status = "working", text = "thinking" } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.num('ClaudeWoWDB.chats[1].ctx'), 106863);
  vm.run('SlashCmdList.CLAUDE("cancel")');
  // A fresh session with an agent that reports nothing (turns = 1, no ctx): the clock only, and no stale cost.
  replyWith(vm, 'turns = 1, since = time() - 5');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].ctx'), null);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cost'), null);
  assert.ok(footerText(vm).endsWith('   5s'), footerText(vm));
  assert.ok(!footerText(vm).includes('tokens'), footerText(vm));
  vm.run('SlashCmdList.CLAUDE("config context")');
  assert.ok(last().includes('Context: 1 turn in this session; AI does not report its context size.'), last());
  // A restore bundle (read with the next reply) brings the numbers back with the chat.
  vm.run('ClaudeWoWCharDB.restored = nil');
  const token = vm.evaluate('ClaudeWoWDB.session');
  vm.run('ClaudeWoW.Send("one more")');
  id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = { { chat = "${vm.evaluate('ClaudeWoWDB.activeChat')}", id = ${id}, status = "done", text = "ok", turns = 2 } }, restore = { token = "${token}", chats = { { id = "r1", name = "Old", cwd = "", plugin = "ask", ctx = 312458, turns = 213, since = time() - 3725, cost = 7.5, messages = { { role = "user", id = 1, t = 1, agent = "", text = "hey" } } } } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWCharDB.restored'), 'true', 'the bundle was read');
  vm.run('SlashCmdList.CLAUDE("-r Old")');
  assert.equal(vm.num('(function() for _, ch in ipairs(ClaudeWoWDB.chats) do if ch.id == "r1" then return ch.ctx end end end)()'), 312458);
  assert.ok(footerText(vm).endsWith('   1h 02m · ↓ 312.5k tokens · ≈$7.50 API'), footerText(vm));
});

test('context growth: past the threshold the chat is warned once per crossing, with a New chat button that does what bare /claude does', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  const warnings = () =>
    vm.num('(function() local n = 0; for _, m in ipairs(ClaudeWoWDB.chats[1].history) do if m.newChat then n = n + 1 end end; return n end)()');
  assert.equal(vm.num('ClaudeWoWDB.settings.contextWarn'), 300000, 'the default threshold');
  vm.run('SlashCmdList.CLAUDE("config context 50k")');
  assert.equal(vm.num('ClaudeWoWDB.settings.contextWarn'), 50000, 'persisted in the saved settings');
  assert.ok(last().startsWith('Context warning at 50.0k tokens'), last());
  replyWith(vm, 'ctx = 40000, turns = 3, window = 200000');
  assert.equal(warnings(), 0, 'under the mark');
  replyWith(vm, 'ctx = 60000, turns = 4, window = 200000, cost = 1.2');
  assert.equal(warnings(), 1, 'the crossing warns');
  const warning = last();
  for (const must of [
    '60.0k tokens of 200.0k after 4 turns, past the 50.0k mark',
    're-reads all of it',
    'replies cost more and start slower',
    'New chat starts AI fresh',
    'this transcript stays here',
    '/claude config context <n> moves the mark, 0 turns it off',
  ]) {
    assert.ok(warning.includes(must), `warning says "${must}": ${warning}`);
  }
  assert.equal(warning.split('\n').length, 3, 'two sentences and the config hint: ' + warning);
  assert.ok(vm.evaluate('table.concat(STUB.prints, "\\n")').includes('past the 50.0k mark'), 'the warning reached the game chat, where the reply went');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].ctxWarned'), 'true');
  replyWith(vm, 'ctx = 75000, turns = 5, window = 200000');
  replyWith(vm, 'ctx = 88000, turns = 6, window = 200000');
  assert.equal(warnings(), 1, 'no nagging while it stays over the mark');
  // A fresh session (a /claude-wow reset, a folder change) brings it back under: re-armed.
  replyWith(vm, 'ctx = 20000, turns = 1, window = 200000');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].ctxWarned'), null);
  assert.equal(warnings(), 1);
  replyWith(vm, 'ctx = 90000, turns = 2, window = 200000');
  assert.equal(warnings(), 2, 'the second crossing warns again');
  // The button on the warning: a shown "New chat" button whose click is bare /claude.
  vm.run('ClaudeWoW.Render()');
  vm.run(
    'FOUND = nil; for _, f in ipairs(STUB.frames) do if f.kind == "Button" and f.text == "New chat" and f.shown and f.parent and f.parent.shown then FOUND = f end end',
  );
  assert.equal(vm.evaluate('FOUND ~= nil'), 'true', 'a New chat button is shown on the warning');
  const before = vm.num('#ClaudeWoWDB.chats');
  vm.run('FOUND.scripts.OnClick(FOUND)');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), before + 1, 'one click, one new chat');
  assert.notEqual(vm.evaluate('ClaudeWoWDB.activeChat'), vm.evaluate('ClaudeWoWDB.chats[1].id'), 'and it is the active one');
  assert.ok(!footerText(vm).includes('tokens') && !footerText(vm).includes('·'), 'the new chat starts from nothing: ' + footerText(vm));
  assert.equal(vm.num('#ClaudeWoWDB.chats[1].history'), vm.num('#ClaudeWoWDB.chats[1].history'), 'the old transcript is untouched');
  // 0 turns the warning off; a plain number works too.
  vm.run('SlashCmdList.CLAUDE("-r 1")');
  vm.run('SlashCmdList.CLAUDE("config context 0")');
  assert.equal(vm.num('ClaudeWoWDB.settings.contextWarn'), 0);
  assert.ok(last().startsWith('Context warning off'), last());
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].ctxWarned'), null, 'turning it off re-arms');
  replyWith(vm, 'ctx = 312458, turns = 213, window = 200000');
  assert.equal(warnings(), 2, 'off means off');
  vm.run('SlashCmdList.CLAUDE("config context 100000")');
  assert.equal(vm.num('ClaudeWoWDB.settings.contextWarn'), 100000);
  vm.run('SlashCmdList.CLAUDE("diag")');
  assert.ok(last().includes('context: warning at 100.0k tokens'), last());
});

test('context growth: a warning after one turn says "1 turn", not "1 turns"', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.CLAUDE("config context 50k")');
  replyWith(vm, 'ctx = 60000, turns = 1, window = 200000');
  const warning = vm.evaluate('(function() for _, m in ipairs(ClaudeWoWDB.chats[1].history) do if m.newChat then return m.text end end end)()');
  assert.ok(warning.includes('after 1 turn, past the 50.0k mark'), warning);
  assert.ok(!warning.includes('1 turns'), warning);
});

const gamePath = rel => 'Interface\\\\AddOns\\\\ClaudeWoW_Runtime\\\\' + rel.split('/').join('\\\\');
const lastSystem = vm =>
  vm.evaluate('(function() local h = ClaudeWoWDB.chats[1].history; for i = #h, 1, -1 do if h[i].role == "system" then return h[i].text end end end)()');

function launchArmed(vm, extra = '') {
  vm.run(`STUB.sounds["${gamePath('ctl/valid.wav')}"] = true; STUB.armed = true; ${extra} STUB.Launch()`);
  login(vm);
  vm.run('STUB.RunTimers()');
  const hello = stripRecords(vm).find(r => r.flags.split(';').includes('h'));
  const probe = /probe=(\w+)/.exec(hello.flags);
  assert.ok(probe, 'the hello asks the bridge for a late-created probe file: ' + hello.flags);
  return probe[1];
}

const legacyPath = rel => 'Interface\\\\AddOns\\\\ClaudeWoW\\\\' + rel.split('/').join('\\\\');

test('signals: with only the old ClaudeWoW signal folders indexed (a bridge from before ClaudeWoW_Runtime, or no restart since setup) the addon falls back to them', () => {
  const vm = newVM();
  vm.run('STUB.signalRoot = "ClaudeWoW"');
  launchArmed(vm, `STUB.sounds["${gamePath('ctl/valid.wav')}"] = nil; STUB.sounds["${legacyPath('ctl/valid.wav')}"] = true;`);
  assert.equal(vm.evaluate('ClaudeWoW.Presence.root'), 'Interface\\AddOns\\ClaudeWoW\\');
  assert.equal(vm.evaluate('ClaudeWoW.Presence.Channel()'), 'true');
  vm.run(`STUB.sounds["${legacyPath('presence/a/0001.wav')}"] = false`);
  nextSlot(vm, '{ now = time(), cwd = "", replies = {}, signals = "armed", presence = { ring = "a", at = 1, n = 2000 } }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.Presence.State().test'), 'passed', 'a beat in the old folder is seen');
  assert.equal(vm.num('ClaudeWoW.Presence.State().beats'), 1);
});

test('signals: when a deleted launch-time file still reads present the self-test fails, presence falls back to the idle-poll windows, and pt=failed rides on the next strip', () => {
  const vm = newVM();
  const token = launchArmed(vm, 'STUB.deletionVisible = false;');
  vm.run(`STUB.sounds["${gamePath('presence/a/0001.wav')}"] = false`);
  nextSlot(vm, `{ now = time(), cwd = "", replies = {}, signals = "armed", presence = { ring = "a", at = 1, n = 2000, probe = "${token}" } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.Presence.State().test'), 'failed');
  assert.equal(vm.evaluate('ClaudeWoW.PresenceWorks()'), 'false');
  vm.run('STUB.now = STUB.now + 400; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.BridgeState()'), 'ok', 'the 12-minute window of the no-presence mode, not the 90 s one');
  vm.run('SlashCmdList.CLAUDE("diag")');
  const diag = lastSystem(vm);
  assert.match(diag, /presence: slot polls only \(self-test failed: presence\/a\/0001\.wav still reads present after the bridge deleted it\)/);
  vm.run('ClaudeWoW.Send("after a failed test")');
  const rec = stripRecords(vm).find(r => r.text === 'after a failed test');
  assert.ok(rec.flags.split(';').includes('pt=failed'), rec.flags);
});

test('a new chat asks the bridge for a title with its first message and takes the one that comes back', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run('ClaudeWoW.Send("why does my pet keep running off")');
  assert.equal(stripRecords(vm).find(r => r.text === 'why does my pet keep running off').flags, 't');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Why does my pet keep', 'the first words stand in until the title arrives');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "working", text = "thinking...", agent = "claude", title = "Hunter Pet Pathing" } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].name'), 'Hunter Pet Pathing', 'the title names the chat as soon as it lands');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].titleFor'), null);
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "ok", agent = "claude" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);

  vm.run('ClaudeWoW.Send("and in dungeons?")');
  assert.equal(stripRecords(vm).find(r => r.text === 'and in dungeons?').flags, '', 'only the first message asks for a title');

  vm.run('ClaudeWoW.NewChat(); ClaudeWoW.Send("slow title")');
  const late = vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].id');
  const firstId = vm.num('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].pendingId');
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${late}", id = ${firstId}, status = "done", text = "ok", agent = "claude" } } }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('ClaudeWoW.Send("next")');
  const nextId = vm.num('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].pendingId');
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = { { chat = "${late}", id = ${nextId}, status = "working", text = "...", agent = "claude", title = "Other Title", titleFor = ${nextId} } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].name'), 'Slow title', 'a title for another message does not rename the chat');
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = { { chat = "${late}", id = ${nextId}, status = "working", text = "...", agent = "claude", title = "Slow Title", titleFor = ${firstId} } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].name'), 'Slow Title', 'a title that missed its reply rides on the next one');

  vm.run('ClaudeWoW.NewChat(); ClaudeWoW.Send("best leveling zone")');
  const second = vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].id');
  const id2 = vm.num('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].pendingId');
  assert.equal(vm.num('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].titleFor'), id2, 'the second chat asked for a title too');
  vm.run(`ClaudeWoW.RenamePrompt("${second}")`);
  vm.run(`
    local dialog = { editBox = { GetText = function() return "Mine" end } }
    StaticPopupDialogs.CLAUDEWOW_RENAME.OnAccept(dialog, STUB.popup.data)`);
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = { { chat = "${second}", id = ${id2}, status = "done", text = "ok", agent = "claude", title = "Leveling Zones" } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].name'), 'Mine', 'a name the player chose is kept');
});

function skillsVM(skills = '"babysit-pr", "fresh-eyes", "review-prs"') {
  const vm = newVM();
  login(vm);
  vm.run('SLASH_OTHERADDON1 = "/review-prs"; SlashCmdList.OTHERADDON = function() STUB.otherAddon = true end');
  vm.run('ClaudeWoWDB.chats[1].cwd = "/Users/me/every"; ClaudeWoWDB.chats[1].plugin = "claude-code"');
  vm.run('STUB.RunTimers()');
  nextSlot(vm, `{ now = time(), cwd = "/Users/me/every", skills = { ${skills} }, replies = {} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  return vm;
}

test('slash commands: a chat with no plugin of its own follows the bridge default, so it takes them when the default is claude-code and refuses them when it is ask', () => {
  for (const [dflt, sent] of [
    ['claude-code', true],
    ['ask', false],
  ]) {
    const vm = newVM();
    login(vm);
    vm.run('ClaudeWoWDB.chats[1].cwd = ""; ClaudeWoWDB.chats[1].plugin = ""');
    vm.run('STUB.RunTimers()');
    nextSlot(vm, `{ now = time(), cwd = "/Users/me/every", plugin = "${dflt}", plugins = { "ask", "claude-code" }, skills = { "babysit-pr" }, replies = {} }`);
    vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
    vm.run('SlashCmdList.CLAUDEWOW_SKILL_BABYSIT_PR("7")');
    assert.equal(!!stripRecords(vm).find(r => r.text === '/babysit-pr 7'), sent, dflt);
  }
});

test('slash commands: each factory skill from the bridge becomes a game slash command that sends /skill args to the coding chat; a command another addon owns is left alone', () => {
  const vm = skillsVM();
  assert.equal(vm.evaluate('SLASH_CLAUDEWOW_SKILL_BABYSIT_PR1'), '/babysit-pr');
  assert.equal(vm.evaluate('SLASH_CLAUDEWOW_SKILL_RUNS1'), '/runs');
  assert.equal(vm.evaluate('SLASH_CLAUDEWOW_SKILL_STOP1'), '/stop');
  assert.equal(vm.evaluate('SlashCmdList.CLAUDEWOW_SKILL_REVIEW_PRS'), null, '/review-prs belongs to another addon');
  vm.run('SlashCmdList.CLAUDEWOW_SKILL_BABYSIT_PR("  18632 ")');
  const rec = stripRecords(vm).find(r => r.text === '/babysit-pr 18632');
  assert.ok(rec, 'the command goes out as the message text');
  assert.equal(rec.cwd, '/Users/me/every');
  assert.match(rec.flags, /plugin=claude-code/);
});

test('slash commands: a general chat refuses them, and a skill the bridge stopped listing is refused at use', () => {
  const vm = skillsVM();
  vm.run('ClaudeWoWDB.chats[1].cwd = ""; ClaudeWoWDB.chats[1].plugin = ""');
  vm.run('SlashCmdList.CLAUDEWOW_SKILL_BABYSIT_PR("12")');
  assert.ok(!stripRecords(vm).some(r => r.text === '/babysit-pr 12'), 'nothing is sent from a general chat');
  assert.match(vm.evaluate('table.concat(STUB.prints, "\\n")'), /\/babysit-pr runs in a coding chat/);
  vm.run('ClaudeWoWDB.chats[1].cwd = "/Users/me/every"; ClaudeWoWDB.chats[1].plugin = "claude-code"');
  vm.run('ClaudeWoW.ApplySkills({ "fresh-eyes" })');
  vm.run('SlashCmdList.CLAUDEWOW_SKILL_BABYSIT_PR("12")');
  assert.ok(!stripRecords(vm).some(r => r.text === '/babysit-pr 12'));
  assert.match(vm.evaluate('table.concat(STUB.prints, "\\n")'), /\/babysit-pr is not a factory skill on this bridge right now/);
  vm.run('ClaudeWoW.ApplySkills(nil)');
  vm.run('SlashCmdList.CLAUDEWOW_SKILL_RUNS("")');
  assert.match(vm.evaluate('table.concat(STUB.prints, "\\n")'), /\/runs is not a factory skill/, 'with the factory off even /runs is refused');
});

test('slash commands: Tab in the input completes a command name, lists the choices when several match, and does nothing in a general chat or mid-message', () => {
  const vm = skillsVM();
  vm.run('ClaudeWoW.Toggle()');
  const tab = text => vm.run(`ClaudeWoWInput:SetText(${JSON.stringify(text)}); ClaudeWoWInput:GetScript("OnTabPressed")(ClaudeWoWInput)`);
  const input = () => vm.evaluate('ClaudeWoWInput:GetText()');
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  tab('/bab');
  assert.equal(input(), '/babysit-pr ');
  assert.equal(vm.num('ClaudeWoWInput.cursor'), 12);
  tab('/r');
  assert.equal(input(), '/r', 'two commands start with r');
  assert.equal(last(), 'Commands: /runs, /review-prs');
  tab('/zz');
  assert.match(last(), /^No command starts with \/zz\. Commands: \/runs, \/stop, \/babysit-pr, \/fresh-eyes, \/review-prs$/);
  tab('fix /bab');
  assert.equal(input(), 'fix /bab');
  vm.run('ClaudeWoWDB.chats[1].cwd = ""; ClaudeWoWDB.chats[1].plugin = ""');
  tab('/bab');
  assert.equal(input(), '/bab', 'a general chat has no commands');
});

function connectIn(vm, cwd) {
  vm.run('STUB.RunTimers()');
  nextSlot(vm, `{ now = time(), cwd = "${cwd}", replies = {} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
}

test('projects: a chat has none by default; --project, #name and none attach and detach one, and the wire carries the folder', () => {
  const vm = newVM();
  login(vm);
  connectIn(vm, '/Users/me/every');
  vm.run('ClaudeWoW.Send("best rogue race")');
  let rec = stripRecords(vm).find(r => r.text === 'best rogue race');
  assert.ok(!/plugin=claude-code/.test(rec.flags || ''), 'a general chat is not a coding session');
  assert.ok(!rec.cwd, 'and sends no folder');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].cwd'), '');

  vm.run('SlashCmdList.CLAUDE("--project every fix the build")');
  rec = stripRecords(vm).find(r => r.text === 'fix the build');
  assert.equal(rec.cwd, '/Users/me/every', 'a known project by its name');
  assert.match(rec.flags, /plugin=claude-code/);
  assert.equal(vm.evaluate('ClaudeWoWDB.settings.projects[1]'), '/Users/me/every', 'remembered for the dropdown');

  vm.run('SlashCmdList.CLAUDE("--project nope hi")');
  assert.match(
    vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text'),
    /Unknown project "nope"\. Known: every/,
  );

  vm.run('ClaudeWoW.NewChat()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].cwd'), '', 'a new chat from a project chat has no project');
  vm.run('ClaudeWoW.Send("check the #every build")');
  rec = stripRecords(vm).find(r => r.text === 'check the every build');
  assert.ok(rec, 'the tag is sent as the plain name');
  assert.equal(rec.cwd, '/Users/me/every', '#name attaches the project before the message goes out');

  vm.run('ClaudeWoW.NewChat()');
  vm.run('ClaudeWoW.Send("price #42 and #fun")');
  rec = stripRecords(vm).find(r => r.text === 'price #42 and #fun');
  assert.ok(rec && !rec.cwd, 'a tag that names no project is left alone');

  vm.run('SlashCmdList.CLAUDE("-c --project none")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].cwd'), '');
});

test('projects: the bridge list adds recent projects with repo labels, and one folder spelled with ~ or a trailing slash is listed once', () => {
  const vm = newVM();
  login(vm);
  vm.run('ClaudeWoWDB.settings.projects = { "~/code/every", "/Users/me/code/every/" }');
  vm.run('STUB.RunTimers()');
  nextSlot(
    vm,
    '{ now = time(), cwd = "/Users/me/code/every", home = "/Users/me", projects = { { path = "/Users/me/code/every", label = "every" }, { path = "/Users/me/wow-ai", label = "claude-wow" }, { path = "/Users/me/every-3", label = "every (every-3)" } }, replies = {} }',
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');

  vm.run('SlashCmdList.CLAUDE("--project nope hi")');
  const said = vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text');
  assert.match(said, /Known: every, claude-wow, every \(every-3\)\./, 'one every for both spellings, then the bridge list by label: ' + said);

  vm.run('SlashCmdList.CLAUDE("--project claude-wow fix the build")');
  const rec = stripRecords(vm).find(r => r.text === 'fix the build');
  assert.equal(rec.cwd, '/Users/me/wow-ai', 'the repo label finds the folder');
  const tab = vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history - 1].text');
  assert.match(tab, /project: claude-wow/);
});

test('projects: without a bridge list the picker keeps folder names, and ~ stays as typed until the bridge names its home', () => {
  const vm = newVM();
  login(vm);
  vm.run('ClaudeWoWDB.settings.projects = { "~/code/every", "/Users/me/wow-ai" }');
  connectIn(vm, '/Users/me/code/every');
  vm.run('SlashCmdList.CLAUDE("--project nope hi")');
  const said = vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text');
  assert.match(said, /Known: every, wow-ai, every\./, said);
});

test('the whisper tab and the game chat echo render coding replies the same way: fences skipped, code untouched, links short, cuts on word boundaries', () => {
  const vm = whisperVM();
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run(`ClaudeWoW.Send("merge them")`);
  const pending = vm.num(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${chatId}" then return c.pendingId end end end)()`);
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${pending}, status = "done", text = "I merged **PR** https://github.com/o/r/pull/18610.\\n\`\`\`\\necho \`pwd\`\\n\\nls\\n\`\`\`", agent = "claude" } } }`,
  );
  vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
  const tab = chatTabText(vm, chatId);
  assert.ok(tab.includes('|Haddon:claudewow:url:https://github.com/o/r/pull/18610|h[PR #18610]|h|r.'), 'a short link in the tab: ' + tab);
  assert.ok(!tab.includes('**') && tab.includes('echo `pwd`'), 'bold is drawn, code stays as written');
  assert.ok(!tab.includes('```'), 'no fence line is written');
  assert.ok(tab.includes('echo `pwd`\nls'), 'a blank line inside a fence writes no empty whisper line: ' + JSON.stringify(tab.slice(-200)));
  vm.run(`ClaudeWoW.Send("long one")`);
  const second = vm.num(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${chatId}" then return c.pendingId end end end)()`);
  const long = 'x'.repeat(262) + ' https://github.com/o/r/pull/18632 completed and then ' + 'x'.repeat(40) + '\\nmore'.repeat(9);
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${second}, status = "done", text = "${long}", agent = "claude" } } }`);
  vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
  const preview = chatTabText(vm, chatId);
  assert.ok(preview.includes('[PR #18632]|h|r...'), 'a whole URL before the cut stays a link: ' + preview.slice(-500));
  assert.ok(!/pull\/18\d{0,2}\|h/.test(preview), 'never into a link with a shorter, wrong PR number');
  vm.run(`ClaudeWoW.Send("one url")`);
  const third = vm.num(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${chatId}" then return c.pendingId end end end)()`);
  const lone = 'https://example.com/' + 'a'.repeat(300) + '\\nmore'.repeat(9);
  nextSlot(vm, `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${third}, status = "done", text = "${lone}", agent = "claude" } } }`);
  vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
  assert.ok(
    chatTabText(vm, chatId).includes('|Haddon:claudewow:url:https://example.com/' + 'a'.repeat(300) + '|h'),
    'a line that is one long URL stays one whole link, not an empty cut',
  );
});

test('a whisper reply waits briefly for an item the client has not loaded, then shows the real link; it gives up after three tries with a plain id', () => {
  const vm = whisperVM();
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run(
    'STUB.cached = false; C_Item.GetItemInfo = function(id) if id == 2589 and STUB.cached then return "Linen Cloth", "|cffffffff|Hitem:2589::::::::|h[Linen Cloth]|h|r" end end; C_Item.RequestLoadItemDataByID = function() end',
  );
  const deliver = text => {
    vm.run(`ClaudeWoW.Send("${text}")`);
    const pending = vm.num(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${chatId}" then return c.pendingId end end end)()`);
    nextSlot(
      vm,
      `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${pending}, status = "done", text = "farm {item:2589}", agent = "claude" } } }`,
    );
    vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
  };
  deliver('what cloth');
  assert.ok(!chatTabText(vm, chatId).includes('farm'), 'nothing is written while the item loads');
  vm.run('STUB.cached = true; STUB.RunTimers()');
  assert.ok(chatTabText(vm, chatId).includes('farm |cffffffff|Hitem:2589::::::::|h[Linen Cloth]|h|r'), chatTabText(vm, chatId));

  vm.run('STUB.cached = false');
  deliver('again');
  for (let i = 0; i < 4; i++) vm.run('STUB.RunTimers()');
  assert.ok(chatTabText(vm, chatId).includes('farm |cff9d9d9ditem 2589|r'), 'after three tries the reply goes out with the plain id');
});

const lastOf = (vm, n, role) =>
  vm.evaluate(`(function() local h = ClaudeWoWDB.chats[${n}].history; for i = #h, 1, -1 do if h[i].role == "${role}" then return h[i].text end end end)()`);
const minutes = (vm, count, step = 60) => {
  for (let i = 0; i < count; i++) vm.run(`STUB.now = STUB.now + ${step}; STUB.Tick()`);
};

test("/claude cancel typed in the shared chat box while a chat's whisper tab is selected cancels that chat, not the window's; a chat that is not waiting says so and names the ones that are", () => {
  const vm = whisperVM();
  const lead = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run('ClaudeWoW.Send("lead the work")');
  const leadId = pendingOf(vm, lead);
  const leadName = chatName(vm, lead);
  const quiet = vm.evaluate('ClaudeWoW.AddChat("Quiet", { cwd = "", plugin = "stream", quiet = true }).id');
  vm.run(`ClaudeWoW.Send("track", nil, { chat = "${quiet}" })`);
  assert.ok(pendingOf(vm, quiet) > 0);
  vm.run('ClaudeWoW.NewChat("Two")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), 3);
  assert.notEqual(vm.evaluate('ClaudeWoWDB.activeChat'), lead);
  const leadTab = tabOf(vm, lead);
  assert.ok(leadTab, 'the waiting chat has a tab');
  const target = vm.evaluate(`${leadTab}.chatTarget`);
  assert.ok(target);

  vm.run('SlashCmdList.CLAUDE("cancel")');
  assert.equal(pendingOf(vm, lead), leadId, "the window's chat is not the waiting one");
  assert.equal(
    lastOf(vm, 3, 'system'),
    `Nothing to cancel: Two is not waiting for a reply. Waiting: 1. ${leadName} (#${leadId}). Pick one with /claude chat <number>, then /claude cancel.`,
  );

  const shared = (chatType, tell, selected = leadTab) =>
    vm.run(
      `ChatFrame1EditBox:SetAttribute("chatType", "${chatType}"); ChatFrame1EditBox:SetAttribute("tellTarget", ${JSON.stringify(tell)}); SELECTED_DOCK_FRAME = ${selected}`,
    );
  shared('SAY', target);
  typeIn(vm, 'ChatFrame1EditBox', '/claude cancel');
  assert.equal(pendingOf(vm, lead), leadId, 'a box not in whisper mode is the game chat, not the tab');
  shared('WHISPER', 'Bob');
  typeIn(vm, 'ChatFrame1EditBox', '/claude cancel');
  assert.equal(pendingOf(vm, lead), leadId, 'a whisper to a real player is not the tab');
  const twoTab = tabOf(vm, vm.evaluate('ClaudeWoWDB.activeChat'));
  assert.ok(twoTab && twoTab !== leadTab, 'the other chat has its own tab');
  shared('WHISPER', target, twoTab);
  typeIn(vm, 'ChatFrame1EditBox', '/claude cancel');
  assert.equal(pendingOf(vm, lead), leadId, "with another chat's tab selected, the waiting chat is not cancelled though the box whispers the same agent");
  assert.match(lastOf(vm, 3, 'system'), /^Nothing to cancel: Two is not waiting/);
  shared('WHISPER', target, `{ claudewowChatId = "${lead}" }`);
  typeIn(vm, 'ChatFrame1EditBox', '/claude cancel');
  assert.equal(pendingOf(vm, lead), leadId, 'a frame that only claims the chat is not its tab');
  vm.run('ClaudeWoWDB.settings.whisper = false');
  shared('WHISPER', target);
  typeIn(vm, 'ChatFrame1EditBox', '/claude cancel');
  assert.equal(pendingOf(vm, lead), leadId, 'with whisper tabs off there is no tab to follow');
  vm.run('ClaudeWoWDB.settings.whisper = true');
  shared('WHISPER', target);
  typeIn(vm, 'ChatFrame1EditBox', '/claude cancel');
  assert.equal(
    vm.evaluate(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${lead}" then return c.pendingId end end end)()`),
    null,
    "the selected tab's chat is cancelled",
  );
  assert.match(lastOf(vm, 1, 'system'), new RegExp(`^Gave up waiting on #${leadId}`));
  shared('WHISPER', target);
  typeIn(vm, 'ChatFrame1EditBox', '/claude cancel');
  assert.equal(lastOf(vm, 1, 'system'), `Nothing to cancel: ${leadName} is not waiting for a reply. No chat is waiting.`);

  vm.run(`ClaudeWoW.Send("again", nil, { chat = "${lead}" })`);
  const again = pendingOf(vm, lead);
  assert.ok(again > leadId);
  vm.run(`ClaudeWoW.SwitchChat(ClaudeWoWDB.chats[3].id)`);
  const replyName = `${target} [${chatName(vm, lead)}]`;
  shared('WHISPER', replyName);
  typeIn(vm, 'ChatFrame1EditBox', '/claude cancel');
  assert.equal(
    vm.evaluate(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${lead}" then return c.pendingId end end end)()`),
    null,
    'a box that /r set to "agent [chat]" still cancels the selected tab\'s chat',
  );
  assert.equal(vm.num('STUB.serverSends'), 0);
});

const SAVE_DB = `local function ser(v)
  local t = type(v)
  if t == "string" then return string.format("%q", v) end
  if t == "number" or t == "boolean" then return tostring(v) end
  if t ~= "table" then return "nil" end
  local parts = {}
  for k, x in pairs(v) do
    if type(x) ~= "function" and type(x) ~= "userdata" then parts[#parts + 1] = "[" .. ser(k) .. "]=" .. ser(x) end
  end
  return "{" .. table.concat(parts, ",") .. "}"
end
SAVED_DB = ser(ClaudeWoWDB)
SAVED_FILES = ser({ sounds = STUB.sounds, armed = STUB.armed, index = STUB.index, deletionVisible = STUB.deletionVisible })`;

const enterWorld = (vm, initial) => vm.run(`STUB.FireEvent("PLAYER_ENTERING_WORLD", ${initial}, ${!initial})`);

function reloaded(vm, before = '') {
  vm.run(SAVE_DB);
  const saved = vm.evaluate('SAVED_DB');
  const files = vm.evaluate('SAVED_FILES');
  const now = vm.evaluate('STUB.now');
  const epoch = vm.evaluate('STUB.epoch');
  const next = newVM();
  next.run(
    `STUB.now = ${now}; STUB.epoch = ${epoch}; ClaudeWoWDB = ${saved}; local f = ${files}; STUB.sounds = f.sounds or {}; STUB.armed = f.armed; STUB.index = f.index; STUB.deletionVisible = f.deletionVisible; ${before}`,
  );
  login(next);
  enterWorld(next, false);
  return next;
}

function givenUp(seed = '') {
  const vm = newVM();
  if (seed) vm.run(seed);
  login(vm);
  if (vm.evaluate('ClaudeWoWDB.settings.mode') === 'pixel') connect(vm);
  vm.run('ClaudeWoW.Send("are you there")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  minutes(vm, 36);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'given up');
  return { vm, chatId, id };
}

const doneSlot = (chatId, id, text) =>
  `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "${text}", agent = "claude" } } }`;

test("a give-up survives /reload: the reply to that message still lands after it, from the hello's slot read or from Inbox.lua in reload mode", () => {
  const pixel = givenUp();
  assert.equal(pixel.vm.num('ClaudeWoWDB.chats[1].gaveUp'), pixel.id, 'the promise is on the chat, in the saved data');
  const after = reloaded(pixel.vm);
  after.run('STUB.RunTimers()');
  nextSlot(after, doneSlot(pixel.chatId, pixel.id, 'after the reload'));
  after.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(lastOf(after, 1, 'assistant'), 'after the reload');
  assert.equal(after.evaluate('ClaudeWoWDB.chats[1].gaveUp'), null, 'kept until it is kept');

  const reload = givenUp('ClaudeWoWDB = { settings = { mode = "reload" } }');
  const inbox = reloaded(reload.vm, `ClaudeWoW_Inbox = ${doneSlot(reload.chatId, reload.id, 'from the inbox')}`);
  assert.equal(lastOf(inbox, 1, 'assistant'), 'from the inbox', 'reload mode reads it from Inbox.lua at the next load');
});

test('a sig file for a given-up message is read after a /reload too, once, even when it fired before the reload', () => {
  let vm = newVM();
  launchArmed(vm);
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('ClaudeWoW.Send("are you there")');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  minutes(vm, 36);
  assert.equal(vm.num('ClaudeWoWDB.chats[1].gaveUp'), id);
  vm.run(`STUB.sounds["${gamePath(`sig/${String(((id - 1) % 200) + 1).padStart(3, '0')}.wav`)}"] = false`);
  vm = reloaded(vm);
  vm.run(`STUB.onLoadAddOn = function(name) LOADS = (LOADS or 0) + 1; ClaudeWoW_SlotData = { now = time(), cwd = "", replies = {} } end`);
  minutes(vm, 1, 5);
  const afterFirst = vm.num('LOADS');
  assert.ok(afterFirst >= 1, 'the fired sig is read once after the reload');
  for (let i = 0; i < 10; i++) minutes(vm, 1, 30);
  assert.equal(vm.num('LOADS'), afterFirst, 'a sig that stays fired is read once, not on every tick');
  vm.run(`STUB.onLoadAddOn = function(name) LOADS = (LOADS or 0) + 1; ClaudeWoW_SlotData = ${doneSlot(chatId, id, 'after the reload, by sig')} end`);
  vm.run(`STUB.sounds["${gamePath(`sig/${String(((id - 1) % 200) + 1).padStart(3, '0')}.wav`)}"] = true`);
  minutes(vm, 1, 5);
  vm.run(`STUB.sounds["${gamePath(`sig/${String(((id - 1) % 200) + 1).padStart(3, '0')}.wav`)}"] = false`);
  minutes(vm, 1, 5);
  assert.equal(lastOf(vm, 1, 'assistant'), 'after the reload, by sig', 'a sig fired again after the reload brings the reply');
});

test('heartbeats read before a /reload are not read again as new life after it', () => {
  let vm = newVM();
  launchArmed(vm);
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('ClaudeWoW.Send("a job that died")');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  const slot = String(((id - 1) % 200) + 1).padStart(3, '0');
  for (let k = 1; k <= 5; k++) {
    vm.run(`STUB.sounds["${gamePath(`act/${slot}/${String(k).padStart(2, '0')}.wav`)}"] = false`);
    minutes(vm, 1);
  }
  minutes(vm, 25);
  vm = reloaded(vm);
  vm.run('SlashCmdList.CLAUDE("diag")');
  assert.match(lastSystem(vm), new RegExp(`: pending #${id}, heartbeat 5 beats`), 'the counter picks up where it was');
  minutes(vm, 6);
  assert.equal(vm.num('ClaudeWoWDB.chats[1].pendingId'), id, '35 minutes after the last beat, not yet');
  minutes(vm, 6);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'the old beats gave it no extra time');
});

function silentFor(slotFields, mins) {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('ClaudeWoW.Send("how long")');
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  const fields = typeof slotFields === 'function' ? slotFields(vm, id) : slotFields;
  nextSlot(vm, `{ now = time(), cwd = "", replies = {}${fields ? ', ' + fields : ''} }`);
  minutes(vm, mins);
  return { vm, id, pending: vm.evaluate('ClaudeWoWDB.chats[1].pendingId') };
}

test('a message the bridge still lists as queued or running keeps its chat waiting; entries that do not match or carry a bad stamp do not', () => {
  const alive = (vm, id, extra = '') => `alive = { { session = "${vm.evaluate('ClaudeWoWDB.session')}", id = ${id}, since = 0${extra} } }`;
  assert.equal(silentFor((vm, id) => alive(vm, id), 60).pending !== null, true, 'queued: every fresh slot read is a sign of life');
  assert.equal(silentFor((vm, id) => `alive = { { session = "other", id = ${id}, since = 0 } }`, 36).pending, null, 'another addon session');
  assert.equal(silentFor((vm, id) => alive(vm, id + 1), 36).pending, null, 'another message');
  assert.equal(
    silentFor((vm, id) => `alive = { { session = "${vm.evaluate('ClaudeWoWDB.session')}", id = "${id}", since = 0 } }`, 36).pending,
    null,
    'an id that is not a number',
  );
  assert.equal(silentFor((vm, id) => alive(vm, id).replace('since = 0', 'since = time() + 86400'), 36).pending, null, 'a run start after the write time');
  assert.equal(silentFor((vm, id) => alive(vm, id).replace(', since = 0', ''), 36).pending, null, 'no start field');
  assert.equal(silentFor((vm, id) => alive(vm, id).replace('since = 0', 'since = tostring(time())'), 36).pending, null, 'a start that is a string');
  assert.equal(silentFor(() => 'alive = "everything"', 36).pending, null, 'a list that is not a table');
  assert.equal(silentFor(() => 'alive = { 5, "x" }', 36).pending, null, 'entries that are not tables');
  const old = newVM();
  login(old);
  connect(old);
  old.run('ClaudeWoW.Send("how long")');
  const oldId = old.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(old, `{ now = time() - 600, cwd = "", replies = {}, ${alive(old, oldId)} }`);
  minutes(old, 36);
  assert.equal(old.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'a slot written over 5 minutes ago is no sign of life');
  const noNow = newVM();
  login(noNow);
  connect(noNow);
  noNow.run('ClaudeWoW.Send("how long")');
  const id = noNow.num('ClaudeWoWDB.chats[1].pendingId');
  nextSlot(noNow, `{ cwd = "", replies = {}, ${alive(noNow, id)} }`);
  minutes(noNow, 36);
  assert.equal(noNow.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'a slot without a write time');

  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('ClaudeWoW.Send("queued, then run")');
  const queued = vm.num('ClaudeWoWDB.chats[1].pendingId');
  minutes(vm, 20);
  nextSlot(vm, `{ now = time(), cwd = "", replies = {}, ${alive(vm, queued).replace('since = 0', 'since = time() - 600')} }`);
  minutes(vm, 1);
  nextSlot(vm, '{ now = time(), cwd = "", replies = {} }');
  minutes(vm, 23);
  assert.equal(vm.num('ClaudeWoWDB.chats[1].pendingId'), queued, 'running: the run start counts, 44 minutes after the send');
  minutes(vm, 3);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'and the limit runs from the start, not from the slot write');
});

test('in reload mode the auto refresh does not renew the login grace: a chat left pending by an earlier session is freed about two minutes after the first login', () => {
  let vm = newVM();
  vm.run(`ClaudeWoWDB = { session = "feedc0de", lastSeq = 361, settings = { mode = "reload", chatsPerCharacterV1 = true }, chats = {
    { id = "lead", name = "Every AI Lead", cwd = "", agent = "", plugin = "", unread = 0, pendingId = 361, history = { { role = "user", text = "lead the work", id = 361, t = time() - 86400 } } },
  }, activeChat = "lead" }`);
  login(vm);
  enterWorld(vm, true);
  for (let i = 0; i < 5; i++) {
    minutes(vm, 1, 20);
    vm = reloaded(vm);
  }
  assert.equal(vm.num('ClaudeWoWDB.chats[1].pendingId'), 361, 'inside the grace');
  for (let i = 0; i < 4; i++) {
    minutes(vm, 1, 20);
    vm = reloaded(vm);
  }
  minutes(vm, 1, 5);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'freed though a reload came every 20 seconds');

  let slow = newVM();
  slow.run(`ClaudeWoWDB = { session = "feedc0de", lastSeq = 361, chats = {
    { id = "lead", name = "Every AI Lead", cwd = "", agent = "", plugin = "", unread = 0, pendingId = 361, history = { { role = "user", text = "lead the work", id = 361, t = time() - 86400 } } },
  }, activeChat = "lead", settings = { chatsPerCharacterV1 = true } }`);
  login(slow);
  enterWorld(slow, true);
  slow.run('STUB.now = STUB.now + 300');
  slow = reloaded(slow);
  minutes(slow, 1, 5);
  assert.equal(slow.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'a reload that took five minutes is still a reload: no new grace');
});

test('a give-up and a late reply give back the draft typed while waiting, like a reply does', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('ClaudeWoW.Toggle(true)');
  vm.run('ClaudeWoW.Send("first")');
  vm.run('ClaudeWoW.Send("typed while waiting")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].draft'), 'typed while waiting');
  vm.run('ClaudeWoWInput:SetText("")');
  minutes(vm, 36);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null);
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'typed while waiting', 'back in the box on the give-up');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].draft'), null);

  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run('ClaudeWoWInput:SetText(""); ClaudeWoW.Toggle(false)');
  vm.run('ClaudeWoW.Send("second")');
  const second = vm.num('ClaudeWoWDB.chats[1].pendingId');
  vm.run('ClaudeWoW.Send("typed again")');
  minutes(vm, 36);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].draft'), 'typed again', 'nowhere to show it yet: kept');
  vm.run('ClaudeWoW.Toggle(true)');
  nextSlot(vm, doneSlot(chatId, second, 'late answer'));
  minutes(vm, 2, 700);
  assert.equal(lastOf(vm, 1, 'assistant'), 'late answer');
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'typed again', 'back in the box on the late reply');

  vm.run('ClaudeWoWInput:SetText(""); ClaudeWoWDB.chats[1].draft = nil');
  vm.run('ClaudeWoW.Send("third")');
  const third = vm.num('ClaudeWoWDB.chats[1].pendingId');
  vm.run('ClaudeWoW.Send("typed before the cancel")');
  vm.run('SlashCmdList.CLAUDE("cancel")');
  vm.run('ClaudeWoWInput:SetText("")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].draft'), 'typed before the cancel');
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = { { chat = "${chatId}", id = ${third}, status = "done", text = "after the cancel", agent = "claude", late = true } } }`,
  );
  minutes(vm, 2, 700);
  assert.equal(lastOf(vm, 1, 'assistant'), 'after the cancel');
  assert.equal(vm.evaluate('ClaudeWoWInput:GetText()'), 'typed before the cancel', 'back in the box on a reply the bridge marks late');
});

function connectWithPlugins(vm, plugins) {
  vm.run('STUB.RunTimers()');
  nextSlot(vm, `{ now = time(), cwd = "", plugins = { ${plugins.map(p => JSON.stringify(p)).join(', ')} }, replies = {} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
}

const lastLine = vm => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');

function loadDev(vm, handlerSetup = '') {
  vm.run(
    handlerSetup ||
      'DEV_PREV = 0; local h = function() DEV_PREV = DEV_PREV + 1 end; function geterrorhandler() return DEV_HANDLER or h end; function seterrorhandler(f) DEV_HANDLER = f end',
  );
  vm.run(fs.readFileSync(path.join(ADDON, 'Dev.lua'), 'utf8'), 'ClaudeWoW', 'addon/Dev.lua');
}

test('dev commands: refused until the bridge advertises the dev plugin, then sent verbatim as @dev records', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.CLAUDE("dev status")');
  assert.match(lastLine(vm), /has not said it has dev tools/);
  assert.equal(stripRecords(vm).filter(r => r.text.startsWith('@dev')).length, 0);

  const vm2 = newVM();
  login(vm2);
  connectWithPlugins(vm2, ['ask', 'claude-code', 'dev']);
  vm2.run('SlashCmdList.CLAUDE("dev status")');
  const rec = stripRecords(vm2).find(r => r.text === '@dev status');
  assert.ok(rec, 'the record carries @dev status');
  assert.ok(!rec.flags.split(';').includes('t'), 'a dev command never asks for a chat title');
});

test('dev commands: bare dev asks for help, wrong carries its note, bug needs text', () => {
  const sent = cmd => {
    const vm = newVM();
    login(vm);
    connectWithPlugins(vm, ['dev']);
    vm.run(`SlashCmdList.CLAUDE(${JSON.stringify(cmd)})`);
    return {
      vm,
      texts: stripRecords(vm)
        .map(r => r.text)
        .filter(t => t.startsWith('@dev')),
    };
  };
  assert.deepEqual(sent('dev').texts, ['@dev help']);
  assert.deepEqual(sent('wrong the drop rate is from retail').texts, ['@dev wrong the drop rate is from retail']);
  assert.deepEqual(sent('wrong').texts, ['@dev wrong']);
  const bare = sent('bug');
  assert.deepEqual(bare.texts, []);
  assert.match(lastLine(bare.vm), /Say what went wrong/);
});

test('Dev.lua keeps only Claude WoW errors, counts repeats, keeps 20, and still calls the previous handler', () => {
  const vm = newVM();
  login(vm);
  loadDev(vm);
  assert.equal(vm.evaluate('ClaudeWoWDev.installed'), 'true');
  vm.run(
    'DEV_HANDLER("Interface/AddOns/ClaudeWoW/Map.lua:3: boom"); DEV_HANDLER("Interface/AddOns/ClaudeWoW/Map.lua:3: boom"); DEV_HANDLER("Interface/AddOns/OtherAddon/x.lua:1: theirs")',
  );
  assert.equal(vm.num('DEV_PREV'), 3, 'every error still reaches the handler that was there before');
  assert.equal(vm.num('#ClaudeWoWDev.errors'), 1);
  assert.equal(vm.num('ClaudeWoWDev.errors[1].count'), 2);
  vm.run('for i = 1, 25 do DEV_HANDLER("Interface\\\\AddOns\\\\ClaudeWoW\\\\DM.lua:" .. i .. ": e") end');
  assert.equal(vm.num('#ClaudeWoWDev.errors'), 20);
  assert.match(vm.evaluate('ClaudeWoWDev.errors[20].message'), /DM.lua:25/);
  vm.run('SlashCmdList.CLAUDE("errors")');
  assert.match(lastLine(vm), /^20 Lua errors from Claude WoW this UI session \(27 in all\)/);
});

test('Dev.lua without seterrorhandler installs nothing and says so', () => {
  const vm = newVM();
  login(vm);
  loadDev(vm, 'seterrorhandler = nil');
  assert.equal(vm.evaluate('ClaudeWoWDev.installed'), null);
  vm.run('SlashCmdList.CLAUDE("errors")');
  assert.match(lastLine(vm), /this client has no seterrorhandler/);
});

test('Dev.lua says so when another addon keeps the error handler, and reads BugGrabber then', () => {
  const vm = newVM();
  login(vm);
  loadDev(vm, 'local h = function() end; function geterrorhandler() return h end; function seterrorhandler() end');
  assert.equal(vm.evaluate('ClaudeWoWDev.installed'), null);
  assert.equal(vm.evaluate('ClaudeWoWDev.blocked'), 'true');
  vm.run('SlashCmdList.CLAUDE("errors")');
  assert.match(lastLine(vm), /another addon keeps the error handler/);
  vm.run(
    'BugGrabber = { GetDB = function() return { { message = "Interface/AddOns/ClaudeWoW/Orders.lua:7: bad", counter = 3 }, { message = "Interface/AddOns/Other/x.lua:1: no" } } end }',
  );
  vm.run('SlashCmdList.CLAUDE("errors")');
  assert.match(lastLine(vm), /^1 Lua error from Claude WoW this UI session, from BugGrabber, newest last:\nx3 ClaudeWoW\/Orders.lua:7: bad/);
});

test('a dev command waits while the chat has a reply pending, keeps the resume id, the reset and the title', () => {
  const vm = newVM();
  login(vm);
  connectWithPlugins(vm, ['dev']);
  vm.run('local c = ClaudeWoWDB.chats[1]; c.resumeId = "1111aaaa-0000-4000-8000-000000000001"; c.resetNext = true');
  vm.run('SlashCmdList.CLAUDE("dev status")');
  const rec = stripRecords(vm).find(r => r.text === '@dev status');
  assert.ok(rec);
  const flags = rec.flags.split(';');
  assert.ok(!flags.some(f => f.startsWith('resume=') || f.startsWith('live=')), rec.flags);
  assert.ok(!flags.includes('n'), 'the reset waits for the next agent message');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].resetNext'), 'true');
  vm.run('SlashCmdList.CLAUDE("dev diff")');
  assert.match(lastLine(vm), /still waiting on a reply/);
  const id = vm.num('ClaudeWoWDB.chats[1].pendingId');
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  nextSlot(
    vm,
    `{ now = time(), cwd = "", plugins = { "dev" }, replies = { { chat = "${chatId}", id = ${id}, status = "done", text = "branch main", plugin = "dev", cwd = "/elsewhere", session = "" } } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick(); STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'the dev reply landed');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].resumeId'), '1111aaaa-0000-4000-8000-000000000001');
  vm.run('ClaudeWoW.Send("continue the fix")');
  const next = stripRecords(vm).find(r => r.text === 'continue the fix');
  assert.ok(next.flags.split(';').includes('resume=1111aaaa-0000-4000-8000-000000000001'), next.flags);
  assert.ok(next.flags.split(';').includes('n'));
  assert.ok(next.flags.split(';').includes('t'), 'the first real message still asks for a title');
});

test('dev errors and bug attach the caught errors under the marker the bridge splits on, within the payload limit', () => {
  const vm = newVM();
  login(vm);
  loadDev(vm);
  connectWithPlugins(vm, ['dev']);
  vm.run('for i = 1, 20 do DEV_HANDLER("Interface/AddOns/ClaudeWoW/Window.lua:" .. i .. ": " .. string.rep("x", 200)) end');
  vm.run('SlashCmdList.CLAUDE("dev errors")');
  const rec = stripRecords(vm).find(r => r.text.startsWith('@dev errors'));
  assert.ok(rec);
  const [head, attached] = rec.text.split('\n--- addon errors ---\n');
  assert.equal(head, '@dev errors');
  assert.ok(attached.length <= 1400, `attachment ${attached.length} chars`);
  assert.match(attached, /Window.lua:20:/, 'the newest error is kept');

  const vm2 = newVM();
  login(vm2);
  loadDev(vm2);
  connectWithPlugins(vm2, ['dev']);
  vm2.run('DEV_HANDLER("Interface/AddOns/ClaudeWoW/Map.lua:3: boom")');
  vm2.run('SlashCmdList.CLAUDE("bug the map pins vanish")');
  const bug = stripRecords(vm2).find(r => r.text.startsWith('@dev bug'));
  assert.match(bug.text, /^@dev bug the map pins vanish\n--- addon errors ---\naddon .*\nClaudeWoW\/Map.lua:3: boom$/);
});

test('/claude -r all opens one chat per handed-off session with its recap, skips running and adopted ones, and says how to hand off', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(
    vm,
    `{ now = time(), cwd = "", replies = {}, sessions = {
    { id = "aaaa1111-0000-4000-8000-000000000001", name = "Fix map pins", title = "Fix map pins", cwd = "/repo", agent = "claude", at = 1, handoff = true, branch = "fix/pins", recap = "Last ask: fix pins\\nLast answer: PR 12 is open." },
    { id = "aaaa1111-0000-4000-8000-000000000002", name = "Cost cap", title = "Cost cap", cwd = "/repo-wt", agent = "claude", at = 2, handoff = true },
    { id = "aaaa1111-0000-4000-8000-000000000003", name = "Still open", title = "Still open", cwd = "/repo", agent = "claude", at = 3, handoff = true, running = true },
    { id = "aaaa1111-0000-4000-8000-000000000004", name = "Not handed", cwd = "/repo", agent = "claude", at = 4 },
  } }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  const before = vm.num('#ClaudeWoWDB.chats');
  vm.run('SlashCmdList.CLAUDE("-r all")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), before + 2);
  const byResume = id => `(function() for _, ch in ipairs(ClaudeWoWDB.chats) do if ch.resumeId == "${id}" then return ch end end end)()`;
  const pins = byResume('aaaa1111-0000-4000-8000-000000000001');
  const cost = byResume('aaaa1111-0000-4000-8000-000000000002');
  assert.equal(vm.evaluate(`${pins}.cwd`), '/repo');
  assert.equal(vm.evaluate(`${pins}.name`), 'Fix map pins');
  assert.equal(vm.evaluate(`${cost}.cwd`), '/repo-wt');
  const historyOf = c => vm.evaluate(`(function() local t = {} for _, m in ipairs(${c}.history) do t[#t + 1] = m.text end return table.concat(t, "|") end)()`);
  assert.match(historyOf(pins), /Last ask: fix pins\nLast answer: PR 12 is open\./);
  const all = historyOf(pins) + historyOf(cost);
  assert.match(all, /Opened 2 chats for the handed-off sessions: (Fix map pins, Cost cap|Cost cap, Fix map pins)\./);
  assert.match(all, /Still running in a terminal, so not opened .*: Still open\./);
  vm.run('SlashCmdList.CLAUDE("-r all")');
  assert.equal(vm.num('#ClaudeWoWDB.chats'), before + 2, 'a second -r all opens nothing new');
  assert.match(
    vm.evaluate(
      '(function() local c for _, ch in ipairs(ClaudeWoWDB.chats) do if ch.id == ClaudeWoWDB.activeChat then c = ch end end return c.history[#c.history].text end)()',
    ),
    /2 already had a chat/,
  );
});

test('/claude -r all with no handed-off session says how to hand off', () => {
  const vm = newVM();
  login(vm);
  connect(vm);
  vm.run('SlashCmdList.CLAUDE("-r all")');
  assert.match(
    vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'),
    /No sessions were handed off\. In a terminal, run: claude-wow handoff/,
  );
});

test('/claude discord refuses when the bridge has no Discord, and in a general chat; on a coding chat it sends the link flag once', () => {
  const off = newVM();
  login(off);
  connectIn(off, '/Users/me/every');
  off.run('ClaudeWoWDB.chats[1].cwd = "/Users/me/every"; ClaudeWoWDB.chats[1].plugin = "claude-code"');
  off.run('SlashCmdList.CLAUDE("discord")');
  assert.match(off.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text'), /^Discord is not on in this bridge/);
  assert.ok(!stripRecords(off).some(r => /discord=link/.test(r.flags || '')));

  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "/Users/me/every", discord = true, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  const last = () => vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].text');
  vm.run('ClaudeWoWDB.chats[1].cwd = ""; ClaudeWoWDB.chats[1].plugin = "ask"');
  vm.run('SlashCmdList.CLAUDE("discord")');
  assert.match(last(), /^Only a coding chat can live in Discord/);

  vm.run('ClaudeWoWDB.chats[1].cwd = "/Users/me/every"; ClaudeWoWDB.chats[1].plugin = "claude-code"');
  vm.run('SlashCmdList.CLAUDE("discord")');
  const sent = stripRecords(vm).filter(r => /discord=link/.test(r.flags || ''));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, '/claude discord');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].discordLinkPending'), null, 'the flag is one-shot');
});

test('Discord mirror: messages from a linked thread join the game chat once, in order, with a gap notice, and a permission ask keeps its rules', () => {
  const vm = newVM();
  login(vm);
  const chatId = vm.evaluate('ClaudeWoWDB.chats[1].id');
  vm.run('STUB.RunTimers()');
  nextSlot(
    vm,
    `{ now = time(), cwd = "/Users/me/every", discord = true, mirror = {
    { chat = "${chatId}", seq = 1, role = "user", text = "from my phone", agent = "", denied = {} },
    { chat = "${chatId}", seq = 2, role = "assistant", text = "done it", agent = "claude", denied = {} },
    { chat = "nochat", seq = 1, role = "user", text = "ignored", agent = "", denied = {} },
  }, replies = {} }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  const texts = () =>
    JSON.parse(
      vm
        .evaluate(
          '(function() local t = {} for _, m in ipairs(ClaudeWoWDB.chats[1].history) do table.insert(t, string.format("%q", m.role .. "|" .. m.text)) end return "[" .. table.concat(t, ",") .. "]" end)()',
        )
        .replace(/\\\n/g, '\\n'),
    );
  assert.deepEqual(texts().slice(-2), ['user|(Discord) from my phone', 'assistant|done it']);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].mirrorSeq'), '2');

  vm.run(`ClaudeWoW.ApplyMirror({ { chat = "${chatId}", seq = 2, role = "assistant", text = "done it", agent = "claude", denied = {} } })`);
  assert.equal(texts().filter(t => t === 'assistant|done it').length, 1, 'a message already shown is not added again');

  vm.run(
    `ClaudeWoW.ApplyMirror({ { chat = "${chatId}", seq = 6, role = "assistant", text = "needs Bash", agent = "claude", denied = { "Bash(npm test:*)" } } })`,
  );
  assert.deepEqual(texts().slice(-2), ['system|3 earlier message(s) are in Discord.', 'assistant|needs Bash']);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].history[#ClaudeWoWDB.chats[1].history].denied[1]'), 'Bash(npm test:*)');
});

test('attaching a session from another chat that this client does not have keeps that chat id', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(
    vm,
    `{ now = time(), cwd = "/Users/me/every", plugins = { "ask", "claude-code" }, sessions = {
    { id = "abcd1111-0000-4000-8000-000000000001", name = "From Discord", cwd = "/Users/me/every", agent = "claude", at = time() - 60, chat = "d0123456789" },
  }, replies = {} }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('SlashCmdList.CLAUDE("-r abcd1111 carry on")');
  const rec = stripRecords(vm).find(r => r.text === 'carry on');
  assert.ok(rec, 'sent');
  assert.equal(rec.chat, 'd0123456789', 'the game chat has the same id as the Discord chat');
});

test('general chats belong to the character: logout stashes them per character, an alt sees only project chats, and the first load drops the old account-wide chats', () => {
  const chatRow = (id, cwd) => `{ id = "${id}", name = "${id}", cwd = "${cwd}", agent = "", plugin = "", unread = 0, history = {}, created = 1 }`;
  const main = newVM();
  main.run(
    `ClaudeWoWDB = { session = "s1", lastSeq = 3, settings = { pluginsV1 = true }, activeChat = "old", chats = { ${chatRow('old', '')}, ${chatRow('oldrepo', 'realms')} } }`,
  );
  login(main);
  assert.equal(main.evaluate('ClaudeWoWDB.settings.chatsPerCharacterV1'), 'true');
  assert.equal(main.evaluate('#ClaudeWoWDB.chats'), '1', 'every old chat is dropped; only a fresh chat is left');
  assert.notEqual(main.evaluate('ClaudeWoWDB.chats[1].id'), 'old');
  assert.equal(main.evaluate('next(ClaudeWoWDB.forget)'), null, 'no forget records: the bridge drops its copies itself');

  const legacy = newVM();
  legacy.run('ClaudeWoWDB = { session = "s0", settings = {}, history = { { role = "user", text = "ancient", t = 1 } }, pendingId = 4 }');
  login(legacy);
  assert.equal(legacy.evaluate('#ClaudeWoWDB.chats[1].history'), '0', 'the single-chat layout is not migrated back in');
  assert.equal(legacy.evaluate('ClaudeWoWDB.history'), null);

  main.run(
    `table.insert(ClaudeWoWDB.chats, ${chatRow('repo', 'realms')}); table.insert(ClaudeWoWDB.chats, ${chatRow('mine', '')}); ClaudeWoWDB.activeChat = "mine"`,
  );
  main.run('STUB.FireEvent("PLAYER_LOGOUT")');
  const ids = vm => vm.evaluate('(function() local t = {} for _, c in ipairs(ClaudeWoWDB.chats) do t[#t + 1] = c.id end return table.concat(t, ",") end)()');
  assert.equal(ids(main), 'repo', 'only the project chat stays account-wide');
  assert.equal(main.evaluate('#ClaudeWoWCharDB.chats'), '2', 'the fresh chat and "mine" go with the character');
  assert.equal(main.evaluate('ClaudeWoWCharDB.activeChat'), 'mine');

  main.run(SAVE_DB + '\nSAVED_CHAR = ser(ClaudeWoWCharDB)');
  const account = main.evaluate('SAVED_DB');
  const own = main.evaluate('SAVED_CHAR');

  const alt = newVM();
  alt.run(`ClaudeWoWDB = ${account}`);
  login(alt);
  const altIds = ids(alt).split(',');
  assert.ok(altIds.includes('repo'), 'the alt sees the project chat');
  assert.ok(!altIds.includes('mine'), "the alt never sees the main's general chat");

  const back = newVM();
  back.run(`ClaudeWoWDB = ${account}; ClaudeWoWCharDB = ${own}`);
  login(back);
  assert.ok(ids(back).split(',').includes('mine'), 'the main gets its general chat back');
  assert.equal(back.evaluate('ClaudeWoWDB.activeChat'), 'mine', 'and it is active again');
});

test('the hello names the character, and a restore bundle is read once per character and only by its own character', () => {
  const orders = fs.readFileSync(path.join(ADDON, 'Orders.lua'), 'utf8');
  const hexOf = s => Buffer.from(s, 'utf8').toString('hex');
  const bundle = (char, id) =>
    `ClaudeWoW_Inbox = { now = time(), cwd = "", replies = {}, restore = { token = "tok", char = "${char}", chats = { { id = "${id}", name = "${id}", cwd = "", plugin = "ask", messages = { { role = "user", id = 1, t = 1, agent = "", text = "hey" } } } } } }`;
  const boot = (seed, who) => {
    const vm = newVM();
    vm.run(orders, 'ClaudeWoW', 'addon/Orders.lua');
    if (who) vm.run(`UnitName = function(unit) if unit == "player" then return "${who}" end end`);
    vm.run(`ClaudeWoWDB = { session = "tok", lastSeq = 1, settings = { chatsPerCharacterV1 = true } }; ${seed}`);
    login(vm);
    return vm;
  };
  const has = (vm, id) => vm.evaluate(`(function() for _, c in ipairs(ClaudeWoWDB.chats) do if c.id == "${id}" then return "yes" end end end)()`) === 'yes';

  const main = boot(bundle('Helen-TestRealm', 'helens'));
  assert.ok(!has(main, 'helens'), 'the main never imports a bundle made for Helen');
  assert.equal(main.evaluate('ClaudeWoWCharDB.restored'), null, 'and can still take its own');
  main.run('STUB.RunTimers()');
  const hello = stripRecords(main).find(r => r.flags.split(';').includes('h'));
  assert.ok(hello && hello.flags.split(';').includes('char=' + hexOf('Testchar-TestRealm')), hello && hello.flags);

  const own = boot(bundle('Testchar-TestRealm', 'mains'));
  assert.ok(has(own, 'mains'), 'the main imports its own bundle');
  assert.equal(own.evaluate('ClaudeWoWCharDB.restored'), 'true');

  const alt = boot(bundle('Helen-TestRealm', 'helens'), 'Helen');
  assert.ok(has(alt, 'helens'), 'Helen still gets her restore after the main took his on the same account session');
});

test('mcp: the bridge list arrives in a slot, /claude mcp overrides servers per chat, and the wire carries mcp= only after a change', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const last = () => vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text');
  const mcpToken = text =>
    flagsOf(stripRecords(vm).find(r => r.text === text))
      .split(';')
      .find(t => t.startsWith('mcp=')) || null;
  const list =
    '{ { id = "notion", label = "notion", src = "config", on = false, health = "connected" }, { id = "claude_ai_Slack", label = "Slack", src = "claude.ai", on = true, health = "needs-auth" }, { id = "mobbin", label = "mobbin", src = "claude", on = true, health = "nope" }, { id = "bad id", label = "x", src = "claude", on = true }, { id = "x", label = "x", src = "elsewhere", on = true }, "junk" }';
  const answer = (withList = true) => {
    const id = vm.num('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].pendingId');
    const chat = vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].id');
    nextSlot(
      vm,
      `{ now = time(), cwd = "/p", ${withList ? `mcp = ${list},` : ''} replies = { { chat = "${chat}", id = ${id}, status = "done", text = "ok", agent = "claude" } } }`,
    );
    vm.run('STUB.now = STUB.now + 10; STUB.Tick()');
  };
  vm.run('SlashCmdList.CLAUDE("mcp")');
  assert.equal(last(), 'MCP: not connected to the bridge yet.');
  nextSlot(vm, `{ now = time(), cwd = "/p", mcp = ${list}, replies = {} }`);
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');

  vm.run('SlashCmdList.CLAUDE("first")');
  assert.equal(mcpToken('first'), null, 'no change: the defaults apply and nothing extra goes out');
  answer();
  vm.run('SlashCmdList.CLAUDE("mcp")');
  assert.equal(
    last(),
    'MCP servers for this chat (the defaults):\nFrom config.json:\n  off  notion  |cff33cc33ok|r\nYour Claude servers:\n  on   mobbin  |cff999999not seen yet|r\nclaude.ai connectors:\n  on   Slack  |cffff9933needs login|r\n/claude mcp on|off <name> changes one; /claude mcp none turns all off; /claude mcp default goes back to the defaults.',
  );

  vm.run('SlashCmdList.CLAUDE("mcp off slack")');
  assert.equal(last(), 'MCP: Slack is off for this chat.', 'a label finds the server, in any case');
  vm.run('SlashCmdList.CLAUDE("mcp on notion")');
  vm.run('SlashCmdList.CLAUDE("-c second")');
  assert.equal(mcpToken('second'), 'mcp=-claude_ai_Slack,+notion');
  answer();
  vm.run('SlashCmdList.CLAUDE("mcp on slack")');
  vm.run('SlashCmdList.CLAUDE("mcp off notion")');
  assert.equal(
    vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].mcpSet.claude_ai_Slack == nil and ClaudeWoWDB.chats[#ClaudeWoWDB.chats].mcpSet.notion == false'),
    'true',
    'turning one back on drops its override; an off is kept',
  );

  vm.run('SlashCmdList.CLAUDE("mcp none")');
  assert.equal(last(), 'MCP: every server is off for this chat.');
  vm.run('SlashCmdList.CLAUDE("mcp on mobbin")');
  vm.run('SlashCmdList.CLAUDE("-c third")');
  assert.equal(mcpToken('third'), 'mcp=-*,+mobbin');
  answer();

  vm.run('SlashCmdList.CLAUDE("mcp off linear")');
  assert.match(last(), /^MCP: no MCP server named "linear" \(servers: notion, Slack, mobbin\)\.$/);
  vm.run('SlashCmdList.CLAUDE("mcp default")');
  vm.run('SlashCmdList.CLAUDE("-c fourth")');
  assert.equal(mcpToken('fourth'), null, 'default drops the choice');
  answer();

  vm.run('SlashCmdList.CLAUDE("mcp off mobbin")');
  vm.run('SlashCmdList.CLAUDE("-c fifth")');
  assert.equal(mcpToken('fifth'), 'mcp=-mobbin');
  answer(false);
  vm.run('SlashCmdList.CLAUDE("-c sixth")');
  assert.equal(mcpToken('sixth'), null, 'a slot without the list (an older bridge took over) withdraws the token');
});

test('mcp: an older bridge that sends no list gets no mcp= token, and the command says to update it', () => {
  const vm = newVM();
  login(vm);
  connectIn(vm, '/p');
  vm.run('SlashCmdList.CLAUDE("mcp off notion")');
  const said = vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text');
  assert.match(said, /this bridge sends no MCP server list\. Update the bridge/);
  vm.run('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].mcpAllOff = true');
  vm.run('SlashCmdList.CLAUDE("-c hi")');
  const rec = stripRecords(vm).find(r => r.text === 'hi');
  assert.ok(
    !flagsOf(rec)
      .split(';')
      .some(t => t.startsWith('mcp=')),
    flagsOf(rec),
  );
});

test('mcp: Inbox.lua carries the list after a /reload only while fresh, and a chat changes at most 16 servers', () => {
  const vm = newVM();
  login(vm);
  const names = Array.from({ length: 17 }, (_, i) => `s${i}`);
  const list = `{ ${names.map(n => `{ id = "${n}", label = "${n}", src = "claude", on = true, health = "unknown" }`).join(', ')} }`;
  const stale = reloaded(vm, `ClaudeWoW_Inbox = { now = time() - 301, cwd = "", mcp = ${list}, replies = {} }`);
  stale.run('ClaudeWoW.NewChat(); SlashCmdList.CLAUDE("mcp")');
  assert.doesNotMatch(
    stale.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text'),
    /s0/,
    'an Inbox.lua older than 5 minutes is not trusted',
  );
  const next = reloaded(vm, `ClaudeWoW_Inbox = { now = time(), cwd = "", mcp = ${list}, replies = {} }`);
  next.run('ClaudeWoW.NewChat()');
  for (const n of names.slice(0, 16)) next.run(`SlashCmdList.CLAUDE("mcp off ${n}")`);
  next.run('SlashCmdList.CLAUDE("mcp off s16")');
  const said = next.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text');
  assert.equal(said, 'MCP: this chat already changes 16 servers. Use /claude mcp none, then turn on the ones you want, or /claude mcp default.');
  assert.equal(next.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].mcpSet.s16 == nil'), 'true');
  next.run('SlashCmdList.CLAUDE("mcp none")');
  for (const n of names.slice(1)) next.run(`SlashCmdList.CLAUDE("mcp on ${n}")`);
  assert.equal(next.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].mcpSet.s16'), 'true', 'after none, 16 servers can be turned back on');
});

test('mcp: the send limit counts the mcp= token, so a long message with many changes is refused instead of never reaching the strip', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  const names = Array.from({ length: 16 }, (_, i) => `s${i}-${'x'.repeat(58)}`);
  nextSlot(
    vm,
    `{ now = time(), cwd = "/p", mcp = { ${names.map(n => `{ id = "${n}", label = "${n}", src = "claude", on = true, health = "unknown" }`).join(', ')} }, replies = {} }`,
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('ClaudeWoW.NewChat()');
  for (const n of names) vm.run(`SlashCmdList.CLAUDE("mcp off ${n}")`);
  const room = Number(/^C\.MAX_PAYLOAD = (\d+)$/m.exec(fs.readFileSync(path.join(__dirname, '..', 'addon', 'ClaudeWoW', 'Codec.lua'), 'utf8'))[1]) - 300 - 1;
  vm.run(`ClaudeWoW.Send("${'a'.repeat(room - 200)}")`);
  const said = vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text');
  assert.match(said, /^That message is too long for one send/);
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].pendingId == nil'), 'true');
});

test('mcp: two servers with one label are told apart by id', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(
    vm,
    '{ now = time(), cwd = "/p", mcp = { { id = "notion", label = "notion", src = "config", on = true, health = "unknown" }, { id = "plugin_Notion_notion", label = "Notion", src = "plugin", on = true, health = "unknown" }, { id = "a", label = "Twin", src = "claude", on = true, health = "unknown" }, { id = "b", label = "twin", src = "claude", on = true, health = "unknown" } }, replies = {} }',
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  vm.run('ClaudeWoW.NewChat()');
  const last = () => vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history[#ClaudeWoWDB.chats[#ClaudeWoWDB.chats].history].text');
  vm.run('SlashCmdList.CLAUDE("mcp off notion")');
  assert.equal(last(), 'MCP: notion is off for this chat.', 'an exact id wins over a label');
  vm.run('SlashCmdList.CLAUDE("mcp off twin")');
  assert.equal(last(), 'MCP: more than one server is called twin; name one of a, b.');
  vm.run('SlashCmdList.CLAUDE("mcp off plugin_notion_notion")');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[#ClaudeWoWDB.chats].mcpSet.plugin_Notion_notion'), 'false');
});

test('mcp: an off choice is kept even when the server is off by default, ids match exactly first, old saved choices carry over, and the cap counts every stored change', () => {
  const vm = newVM();
  login(vm);
  vm.run('ClaudeWoW.NewChat(); ClaudeWoWDB.chats[#ClaudeWoWDB.chats].mcp = { "mobbin" }');
  vm.run('STUB.RunTimers()');
  nextSlot(
    vm,
    '{ now = time(), cwd = "/p", mcp = { { id = "notion", label = "notion", src = "config", on = false, health = "unknown" }, { id = "Foo", label = "Foo", src = "claude", on = true, health = "unknown" }, { id = "foo", label = "foo", src = "claude", on = true, health = "unknown" }, { id = "mobbin", label = "mobbin", src = "claude", on = true, health = "unknown" } }, replies = {} }',
  );
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  const chat = 'ClaudeWoWDB.chats[#ClaudeWoWDB.chats]';
  assert.equal(
    vm.evaluate(`${chat}.mcp == nil and ${chat}.mcpAllOff == true and ${chat}.mcpSet.mobbin == true`),
    'true',
    'an exact on-list from the last build becomes all off plus those on',
  );
  vm.run(`${chat}.mcpAllOff = nil; ${chat}.mcpSet = nil`);
  vm.run('SlashCmdList.CLAUDE("mcp off notion")');
  assert.equal(vm.evaluate(`${chat}.mcpSet.notion`), 'false', 'off is kept so a same-name server of your own is denied too');
  vm.run('SlashCmdList.CLAUDE("mcp off foo")');
  assert.equal(vm.evaluate(`${chat}.mcpSet.foo == false and ${chat}.mcpSet.Foo == nil`), 'true');
  vm.run(`for i = 1, 14 do ${chat}.mcpSet["gone" .. i] = false end`);
  vm.run('SlashCmdList.CLAUDE("mcp off mobbin")');
  assert.match(vm.evaluate(`${chat}.history[#${chat}.history].text`), /already changes 16 servers/, 'choices for servers not listed right now still count');
});

test('the panel shows Stop instead of Send while the open chat waits; Stop cancels the run and brings Send back', () => {
  const vm = newVM();
  login(vm);
  vm.run('STUB.RunTimers()');
  nextSlot(vm, '{ now = time(), cwd = "/Users/me/every", cancel = true, replies = {} }');
  vm.run('STUB.now = STUB.now + 6; STUB.Tick()');
  assert.equal(vm.evaluate('ClaudeWoW.IsConnected()'), 'true');
  vm.run('ClaudeWoW.Toggle()');
  const shown = name => vm.evaluate(`ClaudeWoW.UI.${name}.shown`);
  assert.equal(shown('send'), 'true');
  assert.equal(shown('stop'), 'false');

  vm.run('ClaudeWoW.Send("long job")');
  const pending = vm.num('ClaudeWoWDB.chats[1].pendingId');
  assert.ok(pending > 0);
  assert.equal(shown('stop'), 'true', 'Stop while the chat waits');
  assert.equal(shown('send'), 'false');

  vm.run('ClaudeWoW.UI.stop:GetScript("OnClick")(ClaudeWoW.UI.stop)');
  assert.equal(vm.evaluate('ClaudeWoWDB.chats[1].pendingId'), null, 'the chat is free again');
  assert.ok(stripRecords(vm).some(r => r.flags === `cancel=${pending}`), 'the bridge is told to stop that run');
  assert.equal(shown('stop'), 'false');
  assert.equal(shown('send'), 'true');

  vm.run('ClaudeWoW.NewChat("other")');
  assert.equal(shown('stop'), 'false', 'another chat that is not waiting shows Send');
});
