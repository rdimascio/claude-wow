'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOM = require('../../bridge/room');
const { makeRoot, gameRunner } = require('./helpers');

const ROOT = makeRoot('room');
const withGame = gameRunner(ROOT);
const SQLITE = '/usr/bin/sqlite3';
const TOKEN = 'feedfacecafebeef0123456789abcdef';

function frame(text) {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([head, body]);
}

function fakeRoom() {
  const sockets = [];
  const seen = [];
  const server = http.createServer((req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket) => {
    seen.push(req.url);
    if (!req.url.endsWith(`token=${TOKEN}`)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('error', () => {});
    sockets.push(socket);
  });
  return {
    seen,
    sockets,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    send: event => sockets.forEach(s => s.write(frame(JSON.stringify(event)))),
    close: () => {
      sockets.forEach(s => s.destroy());
      server.close();
    },
  };
}

test('an agent-room message in a followed channel reaches the game as its own chat, read through the news ring', { skip: !fs.existsSync(SQLITE) }, async () => {
  const room = fakeRoom();
  const port = await room.listen();
  try {
    await withGame(
      {
        beforeLaunch: sb => {
          const db = path.join(sb.home, 'room.sqlite');
          execFileSync(SQLITE, [db, `create table meta (key text primary key, value text not null); insert into meta values ('web_token', '${TOKEN}');`]);
          const cfg = JSON.parse(fs.readFileSync(sb.config, 'utf8'));
          cfg.roomDownAfterMs = 1000;
          cfg.plugins.room = { enabled: true, workspace: 'wow-ai', url: `ws://127.0.0.1:${port}/ws`, db };
          fs.writeFileSync(sb.config, JSON.stringify(cfg, null, 2));
        },
      },
      async h => {
        await h.client.connect();
        await h.client.waitFor(() => room.sockets.length > 0, { timeoutMs: 20000, label: 'the bridge to connect to the room' });
        const snapshot = {
          type: 'snapshot',
          snapshot: {
            agents: [{ id: 'assistant', displayName: 'Ari' }],
            channels: [{ id: 'ch-ship', workspaceId: 'wow-ai', slug: 'ship', name: 'Ship', archived: false }],
            threads: [{ id: 't1', channelId: 'ch-ship', title: 'Deploy' }],
          },
        };
        room.send(snapshot);
        await h.bridge.waitForLine(/room: connected to agent-room, following 1 channel\(s\) of wow-ai/, { timeoutMs: 15000 });
        const fired = () => h.client.luaValue('ClaudeWoW.Presence.News().fired');
        const before = Number(fired());
        room.send({
          type: 'message',
          threadId: 't1',
          message: { id: 'm1', threadId: 't1', authorId: 'assistant', semantic: { kind: 'chat', text: 'Merged #172 to main.' }, text: '' },
        });
        const chatId = ROOM.chatIdFor('ch-ship');
        const chat = await h.client.waitFor(() => (h.client.db().chats || []).find(c => c.id === chatId), {
          timeoutMs: 30000,
          label: 'the room chat in game',
        });
        assert.equal(chat.name, '#ship');
        assert.equal(chat.plugin, 'room');
        assert.ok(
          chat.history.some(m => m.role === 'assistant' && m.text === 'Deploy: Merged #172 to main.'),
          JSON.stringify(chat.history),
        );
        assert.ok(Number(fired()) > before, 'the news ring told the game to read');
        room.send({
          type: 'message',
          threadId: 't1',
          message: { id: 'm1', threadId: 't1', authorId: 'assistant', semantic: { kind: 'chat', text: 'Merged #172 to main.' }, text: '' },
        });
        room.send({
          type: 'message',
          threadId: 't1',
          message: { id: 'm2', threadId: 't1', authorId: 'human:U1', semantic: { kind: 'chat', text: 'thanks' }, text: '' },
        });
        const transcript = () => JSON.parse(fs.readFileSync(path.join(h.sb.home, 'transcripts.json'), 'utf8')).chats[chatId];
        await h.client.waitFor(() => transcript().messages.some(m => m.roomId === 'm2'), { timeoutMs: 10000, label: 'the second message on the bridge' });
        assert.deepEqual(
          transcript().messages.map(m => [m.roomId, m.seq, m.text]),
          [
            ['m1', 1, 'Deploy: Merged #172 to main.'],
            ['m2', 2, 'Deploy: thanks'],
          ],
          'agent-room re-sends a turn after it ends; the same message id is kept once',
        );
        h.client.runLua(`ClaudeWoW.DeleteChat(${JSON.stringify(chatId)})`);
        await h.bridge.waitForLine(new RegExp(`forgot chat ${chatId}`), { timeoutMs: 15000 });
        assert.equal(h.transcripts().chats[chatId], undefined);
        room.send({
          type: 'message',
          threadId: 't1',
          message: { id: 'm3', threadId: 't1', authorId: 'assistant', semantic: { kind: 'chat', text: 'after the delete' }, text: '' },
        });
        await h.client.waitFor(() => transcript() && transcript().messages.some(m => m.roomId === 'm3'), {
          timeoutMs: 10000,
          label: 'the message after the delete',
        });
        assert.equal(
          transcript().messages.find(m => m.roomId === 'm3').seq,
          3,
          'the sequence goes on after a delete, so another client that still shows the chat does not drop it',
        );
        room.sockets.splice(0).forEach(s => s.destroy());
        await h.client.waitFor(() => transcript().messages.some(m => m.role === 'system' && /agent-room is unreachable/.test(m.text)), {
          timeoutMs: 10000,
          label: 'the unreachable line in the room chat',
        });
        await h.bridge.restart();
        room.sockets.splice(0).forEach(sock => sock.destroy());
        await h.client.waitFor(() => room.sockets.length > 0, { timeoutMs: 20000, label: 'the restarted bridge to reconnect' });
        room.send(snapshot);
        await h.client.waitFor(() => transcript().messages.some(m => m.role === 'system' && /agent-room is back/.test(m.text)), {
          timeoutMs: 10000,
          label: 'the back line in the room chat',
        });
        assert.ok(!h.bridge.output.includes(TOKEN), 'the token is never logged');
      },
    );
  } finally {
    room.close();
  }
});
