'use strict';
const http = require('http');

const GUILD = '900000000000000001';

function startFakeDiscord({ channelId }) {
  const calls = [];
  const threads = new Map();
  let seq = 1000;
  const nextId = () => String(910000000000000000n + BigInt(++seq));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {}
      const url = req.url.replace(/^\/api\/v10/, '');
      calls.push({ method: req.method, url, body, auth: req.headers.authorization || '' });
      const send = (obj, status = 200) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      let m;
      if (req.method === 'GET' && url === `/channels/${channelId}`) return send({ id: channelId, guild_id: GUILD, type: 0 });
      if (req.method === 'GET' && (m = /^\/channels\/(\d+)$/.exec(url)) && threads.has(m[1]))
        return send({ id: m[1], parent_id: channelId, guild_id: GUILD, type: 11 });
      if (req.method === 'POST' && (m = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(url))) {
        const id = nextId();
        threads.set(id, { name: body && body.name });
        return send({ id, parent_id: m[1], guild_id: GUILD, type: 11, name: body && body.name });
      }
      if (req.method === 'POST' && (m = /^\/channels\/(\d+)\/messages$/.exec(url)))
        return send({
          id: nextId(),
          channel_id: m[1],
          content: body && body.content,
          timestamp: new Date().toISOString(),
          author: { id: '0', username: 'bot', bot: true },
        });
      if (req.method === 'PATCH' && (m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(url)))
        return send({ id: m[2], channel_id: m[1], content: body && body.content });
      if (req.method === 'DELETE') {
        res.statusCode = 204;
        return res.end();
      }
      send({}, 200);
    });
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        guild: GUILD,
        calls,
        threads,
        posts: () => calls.filter(c => c.method === 'POST' && /^\/channels\/\d+\/messages$/.test(c.url)),
        close: () => new Promise(r => server.close(() => r())),
      }),
    ),
  );
}

module.exports = { startFakeDiscord, GUILD };
