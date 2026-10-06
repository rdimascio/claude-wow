#!/usr/bin/env node
'use strict';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TOOL_ENV = 'CONTRACT_MCP_TOOL';
const ECHO_ENV = 'CONTRACT_MCP_ECHO';
const SERVER_NAME = 'contract';

const toolName = name =>
  String(name || '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 64);

function toolNames(argv, env) {
  const names = [...argv];
  if (env[TOOL_ENV]) names.push(env[TOOL_ENV]);
  return [...new Set(names.map(toolName).filter(Boolean))];
}

function createServer({ tools, env, stdout }) {
  const send = msg => stdout.write(JSON.stringify(msg) + '\n');
  function onRequest(method, params) {
    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list')
      return {
        tools: tools.map(name => ({ name, description: `Contract probe tool ${name}. Takes no input.`, inputSchema: { type: 'object', properties: {} } })),
      };
    if (method === 'tools/call') {
      const name = params && params.name;
      if (!tools.includes(name)) return { content: [{ type: 'text', text: `no tool ${name}` }], isError: true };
      return { content: [{ type: 'text', text: `${name} echo=${env[ECHO_ENV] || ''}` }] };
    }
    const err = new Error(`Method not found: ${method}`);
    err.code = -32601;
    throw err;
  }
  function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || msg.id === undefined || msg.id === null) return;
    try {
      send({ jsonrpc: '2.0', id: msg.id, result: onRequest(msg.method, msg.params) });
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code || -32603, message: e.message } });
    }
  }
  let buffer = '';
  function feed(chunk) {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {}
    }
  }
  return { handle, feed };
}

function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env || process.env;
  const stdin = deps.stdin || process.stdin;
  const stdout = deps.stdout || process.stdout;
  const server = createServer({ tools: toolNames(argv, env), env, stdout });
  stdin.setEncoding('utf8');
  stdin.on('data', server.feed);
  stdin.on('end', () => {
    if (!deps.stdin) process.exit(0);
  });
  return server;
}

module.exports = { main, TOOL_ENV, ECHO_ENV };

if (require.main === module) main();
