// Tests for `mcp-master-tester lint`: run the CLI as a child process against fixture and reference servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'cli.js');
const fixture = path.join(root, 'test/fixtures/lint-server.js');
const everything = createRequire(import.meta.url).resolve('@modelcontextprotocol/server-everything/dist/index.js');
const HTTP_PORT = 6393;
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const run = (...args) => new Promise((resolve) => {
  execFile(process.execPath, [cli, ...args], { cwd: root, timeout: 60000 }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
});

let httpServer;
before(async () => {
  httpServer = spawn(process.execPath, [everything, 'streamableHttp'], { env: { ...process.env, PORT: String(HTTP_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('reference HTTP server did not start')), 20000);
    const check = (d) => { if (/listening on port/i.test(d)) { clearTimeout(timer); resolve(); } };
    httpServer.stdout.on('data', check);
    httpServer.stderr.on('data', check);
  });
});
after(() => httpServer?.kill());

test('lint: a clean server passes, even when failing on warnings', async () => {
  const r = await run('lint', '--fail-on', 'warn', '--', 'node', fixture, 'clean');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /lint-fixture v0\.0\.1 · 1 tool · stdio/);
  assert.match(r.stdout, /passed: 0 errors, 0 warnings, 0 info/);
});

test('lint: spec errors fail the run and are listed; info is counted but hidden by default', async () => {
  const r = await run('lint', '--', 'node', fixture);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /error\s+read_note\s+duplicate tool name/);
  assert.match(r.stdout, /error\s+send_mail\s+required "subject" is not defined/);
  assert.match(r.stdout, /warn\s+send_mail\s+missing description/);
  assert.doesNotMatch(r.stdout, /info\s+send_mail/);
  assert.match(r.stdout, /failed: 2 errors, 2 warnings, 3 info \(add --show-info/);
  const all = await run('lint', '--show-info', '--', 'node', fixture);
  assert.match(all.stdout, /info\s+send_mail\s+no annotations/);
});

test('lint: --fail-on sets the threshold', async () => {
  assert.equal((await run('lint', '--fail-on', 'never', '--', 'node', fixture)).code, 0);
  assert.equal((await run('lint', '--fail-on', 'info', '--', 'node', fixture, 'clean')).code, 0);
  assert.equal((await run('lint', '--fail-on', 'info', '--', 'node', everything)).code, 1); // has info findings only
  assert.equal((await run('lint', '--', 'node', everything)).code, 0);
});

test('lint: --format json is machine-readable', async () => {
  const r = await run('lint', '--format', 'json', '--', 'node', fixture);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.server, { name: 'lint-fixture', version: '0.0.1' });
  assert.deepEqual(j.counts, { error: 2, warn: 2, info: 3 });
  assert.equal(j.passed, false);
  assert.equal(j.tools, 3);
  assert.deepEqual(j.findings[0], { sev: 'error', target: 'read_note', msg: 'duplicate tool name' });
});

test('lint: --format github prints workflow annotations', async () => {
  const r = await run('lint', '--format', 'github', '--', 'node', fixture);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], '::error title=MCP lint%3A read_note::duplicate tool name');
  assert.ok(lines.some((l) => l.startsWith('::warning title=MCP lint%3A send_mail::missing description')));
  assert.ok(lines.some((l) => l.startsWith('::notice ')));
  assert.equal(lines.at(-1), 'MCP lint: 2 errors, 2 warnings, 3 info. Failing on: error.');
});

test('lint: Streamable HTTP via --url', async () => {
  const r = await run('lint', '--url', `http://127.0.0.1:${HTTP_PORT}/mcp`, '--header', 'X-Test: 1');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mcp-servers\/everything .* · Streamable HTTP/);
});

test('lint: a server that fails to start exits 2 and shows its stderr', async () => {
  const r = await run('lint', '--timeout', '10000', '--', 'node', '-e', "console.error('boom: missing API_KEY'); process.exit(1)");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /could not list the server's tools/);
  assert.match(r.stderr, /boom: missing API_KEY/);
});

test('lint: usage errors exit 2 with a hint', async () => {
  for (const args of [[], ['--fail-on', 'bad', '--', 'x'], ['--format', 'xml', '--', 'x'], ['stray', '--', 'x'], ['--sse', '--', 'x'],
    ['--url', 'http://x', '--', 'x'], ['--env', 'NOEQUALS', '--', 'x'], ['--timeout', '0', '--', 'x']]) {
    const r = await run('lint', ...args);
    assert.equal(r.code, 2, `should reject ${JSON.stringify(args)}`);
    assert.match(r.stderr, /lint --help/);
  }
});

test('--version, --help and unknown commands', async () => {
  assert.equal((await run('--version')).stdout.trim(), version);
  assert.match((await run('lint', '--help')).stdout, /--fail-on <level>/);
  const r = await run('frobnicate');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command "frobnicate"/);
});
