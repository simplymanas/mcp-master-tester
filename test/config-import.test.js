// Unit tests for public/config-import.js: client configs in, profiles out, and no secret values kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profilesFromConfig, joinArgs } from '../public/config-import.js';

test('Claude Desktop / Cursor: stdio servers with args and env', () => {
  const { profiles, skipped, secrets } = profilesFromConfig(JSON.stringify({
    mcpServers: {
      filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/My Documents'] },
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_real', LOG_LEVEL: 'debug' } },
    },
  }));
  assert.deepEqual(skipped, []);
  assert.deepEqual(profiles[0], {
    name: 'filesystem', transport: 'stdio', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem "/Users/me/My Documents"', cwd: '', url: '',
    env: [], headers: [], bearerRequired: false,
  });
  assert.deepEqual(profiles[1].env, [
    { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', secret: true, value: '' },
    { key: 'LOG_LEVEL', secret: false, value: 'debug' },
  ]);
  assert.deepEqual(secrets, [{ name: 'github', keys: ['GITHUB_PERSONAL_ACCESS_TOKEN'] }]);
  assert.ok(!JSON.stringify(profiles).includes('ghp_real'), 'a secret value never reaches a profile');
});

test('VS Code: "servers", remote servers, headers and ${input:…} placeholders', () => {
  const vscode = { inputs: [{ id: 'tok', type: 'promptString', password: true }], servers: {
    remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${input:tok}', 'X-Team': 'blue' } },
    legacy: { type: 'sse', url: 'https://example.com/events' },
    local: { type: 'stdio', command: 'python', args: ['-m', 'my_server'], env: { REGION: '${input:region}' } },
  } };
  const { profiles, secrets } = profilesFromConfig(JSON.stringify(vscode));
  assert.deepEqual(profiles.map((p) => [p.name, p.transport]), [['remote', 'http'], ['legacy', 'sse'], ['local', 'stdio']]);
  assert.deepEqual(profiles[0].headers, [{ key: 'Authorization', secret: true, value: '' }, { key: 'X-Team', secret: false, value: 'blue' }]);
  assert.deepEqual(profiles[2].env, [{ key: 'REGION', secret: true, value: '' }], 'a placeholder value is asked for, not saved');
  assert.deepEqual(secrets.map((s) => s.name), ['remote', 'local']);
  // settings.json nests it one level deeper.
  assert.equal(profilesFromConfig(JSON.stringify({ mcp: vscode })).profiles.length, 3);
});

test('other shapes: a bare map, serverUrl, an /sse URL without a type', () => {
  const { profiles } = profilesFromConfig(JSON.stringify({ a: { command: 'node', args: ['s.js'] }, b: { serverUrl: 'https://x.dev/sse' } }));
  assert.deepEqual(profiles.map((p) => [p.name, p.transport, p.url || p.args]), [['a', 'stdio', 's.js'], ['b', 'sse', 'https://x.dev/sse']]);
});

test('entries it can\'t use are skipped with a reason; bad input is explained', () => {
  const { profiles, skipped } = profilesFromConfig(JSON.stringify({ mcpServers: { ok: { command: 'node' }, empty: {}, odd: 'npx thing' } }));
  assert.deepEqual(profiles.map((p) => p.name), ['ok']);
  assert.deepEqual(skipped, [{ name: 'empty', reason: 'no "command" or "url"' }, { name: 'odd', reason: 'not an object' }]);
  assert.throws(() => profilesFromConfig('{ mcpServers: }'), /isn't valid JSON/);
  assert.throws(() => profilesFromConfig('[1, 2]'), /Paste a JSON object/);
  assert.throws(() => profilesFromConfig('{ "mcpServers": {} }'), /No servers found/);
  assert.throws(() => profilesFromConfig('{ "theme": "dark" }'), /No servers found/);
});

test('joinArgs quotes what the Arguments field would otherwise split', () => {
  assert.equal(joinArgs(['-y', 'pkg', 'a b', 'say "hi"', '']), `-y pkg "a b" 'say "hi"' ""`);
});
