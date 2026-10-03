// Integration tests: drive the tester's REST API against the reference "everything" MCP server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const everything = createRequire(import.meta.url).resolve('@modelcontextprotocol/server-everything/dist/index.js');
const PORT = 6391;
const HTTP_SERVER_PORT = 6392;
const BASE = `http://127.0.0.1:${PORT}/api`;
const children = [];

function start(args, env, readyPattern) {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env } });
  children.push(child);
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (d) => {
      output += d;
      if (readyPattern.test(output)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`process exited (${code}) before ready:\n${output}`)));
  });
}

async function api(route, body, method = 'POST') {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const stdioConfig = { transport: 'stdio', command: process.execPath, args: [everything] };

before(async () => {
  await start(['server.js'], { PORT: String(PORT) }, /MCP Master Tester/);
  await start([everything, 'streamableHttp'], { PORT: String(HTTP_SERVER_PORT) }, /listening on port/i);
});

after(() => children.forEach((c) => c.kill()));

test('stdio: connects and reports server info and capabilities', async () => {
  const { status, json } = await api('/sessions', stdioConfig);
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(json.result.serverInfo.name);
  assert.ok(json.result.capabilities.tools);
  assert.ok(json.result.pid > 0);
  await api(`/sessions/${json.result.id}`, undefined, 'DELETE');
});

test('stdio: lists tools, calls a tool, and reports tool errors as isError', async () => {
  const { json: s } = await api('/sessions', stdioConfig);
  const id = s.result.id;

  const tools = await api(`/sessions/${id}/tools/list`, {});
  assert.ok(tools.json.result.tools.some((t) => t.name === 'echo'));

  const echo = await api(`/sessions/${id}/tools/call`, { name: 'echo', arguments: { message: 'hello' } });
  assert.equal(echo.json.ok, true);
  assert.match(echo.json.result.content[0].text, /hello/);
  assert.equal(typeof echo.json.ms, 'number');

  const missing = await api(`/sessions/${id}/tools/call`, { name: 'no-such-tool' });
  assert.equal(missing.json.result.isError, true);

  await api(`/sessions/${id}`, undefined, 'DELETE');
});

test('stdio: ping, resources and prompts', async () => {
  const { json: s } = await api('/sessions', stdioConfig);
  const id = s.result.id;

  assert.equal((await api(`/sessions/${id}/ping`)).json.ok, true);

  const resources = await api(`/sessions/${id}/resources/list`, {});
  const first = resources.json.result.resources[0];
  const read = await api(`/sessions/${id}/resources/read`, { uri: first.uri });
  assert.ok(read.json.result.contents.length > 0);

  const prompts = await api(`/sessions/${id}/prompts/list`, {});
  assert.ok(prompts.json.result.prompts.length > 0);

  await api(`/sessions/${id}`, undefined, 'DELETE');
});

test('event stream delivers JSON-RPC frames', async () => {
  const { json: s } = await api('/sessions', stdioConfig);
  const id = s.result.id;
  const controller = new AbortController();
  const res = await fetch(`${BASE}/sessions/${id}/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const first = JSON.parse(new TextDecoder().decode(value).split('\n')[0].replace(/^data: /, ''));
  assert.equal(first.type, 'rpc');
  assert.equal(first.msg.method, 'initialize');
  controller.abort();
  await api(`/sessions/${id}`, undefined, 'DELETE');
});

test('streamable HTTP: connects and calls a tool', async () => {
  const { json: s } = await api('/sessions', { transport: 'http', url: `http://127.0.0.1:${HTTP_SERVER_PORT}/mcp` });
  assert.equal(s.ok, true);
  const echo = await api(`/sessions/${s.result.id}/tools/call`, { name: 'echo', arguments: { message: 'over http' } });
  assert.match(echo.json.result.content[0].text, /over http/);
  await api(`/sessions/${s.result.id}`, undefined, 'DELETE');
});

test('stdio failure returns the server stderr', async () => {
  const { status, json } = await api('/sessions', {
    transport: 'stdio',
    command: process.execPath,
    args: ['-e', "console.error('API_KEY is required'); process.exit(1)"],
  });
  assert.equal(status, 500);
  assert.equal(json.ok, false);
  assert.match(json.stderr, /API_KEY is required/);
});

test('rejects requests with a foreign Host header (DNS rebinding)', async () => {
  const { request } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '/api/sessions', method: 'POST', headers: { Host: `evil.example:${PORT}`, 'Content-Type': 'application/json' } },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify(stdioConfig));
  });
  assert.equal(status, 403);
});

test('rejects invalid requests', async () => {
  const noCommand = await api('/sessions', { transport: 'stdio' });
  assert.equal(noCommand.status, 400);

  const unknownSession = await api('/sessions/does-not-exist/tools/list', {});
  assert.equal(unknownSession.status, 404);
});
