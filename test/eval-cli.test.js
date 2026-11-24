// Tests for `mcp-master-tester eval`: the CLI against the fixture server, with a fake Anthropic API
// (test/fixtures/fake-anthropic.js) in place of the real one, so no key or network is needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'cli.js');
const server = ['--', 'node', path.join(root, 'test/fixtures/smoke-server.js')];
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mcpt-eval-'));

let fake;
let baseUrl;
before(async () => {
  fake = spawn(process.execPath, [path.join(root, 'test/fixtures/fake-anthropic.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake Anthropic API did not start')), 10000);
    fake.stdout.on('data', (d) => { const m = /listening on (\d+)/.exec(d); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  baseUrl = `http://127.0.0.1:${port}`;
});
after(() => { fake?.kill(); rmSync(tmp, { recursive: true, force: true }); });

const casesFile = (name, content) => { const file = path.join(tmp, name); writeFileSync(file, JSON.stringify(content)); return file; };
const run = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [cli, 'eval', ...args], {
    cwd: root, timeout: 60000,
    env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_AUTH_TOKEN: '', NO_COLOR: '1', ...env },
  }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
});
const requests = async () => (await fetch(`${baseUrl}/requests`)).json();

const good = [
  { prompt: 'Use get_weather {"city": "pune"}', expect: 'get_weather', args: { city: 'Pune' } },
  { name: 'small talk', prompt: 'Hello there', expect: null },
  { prompt: 'Is the database up? ping_db', expect: ['ping_db', 'get_weather'] },
];

test('eval: a suite where every case picks the right tool passes', async () => {
  const before = (await requests()).length;
  const r = await run(['--cases', casesFile('good.json', good), ...server]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Model: claude-opus-5-5 · 3 cases/);
  assert.match(r.stdout, /✔ passed: 3 of 3 passed \(100%\), 0 failed, 0 errors; needs 100%/);
  assert.match(r.stdout, /Tokens: 3,000 in, 60 out/);

  // What was sent: the server's tools as API tools, "auto" with one call at most, and no tool run anywhere.
  const sent = (await requests()).slice(before).map((q) => q.body);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].model, 'claude-opus-5-5');
  assert.deepEqual(sent[0].tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.deepEqual(sent[0].tools.map((t) => t.name), ['ping_db', 'get_weather', 'find_user', 'delete_user']);
  assert.equal(sent[0].tools[1].input_schema.type, 'object');
  assert.equal(sent[0].output_config, undefined, 'no effort unless asked');
  assert.ok(sent.every((b) => b.messages.length === 1 && b.messages[0].role === 'user'), 'one request per case, no tool results sent back');
});

test('eval: wrong choices fail the run, name the mix-up, and --pass-rate or --fail-on never let it through', async () => {
  const file = casesFile('mixed.json', [...good, { prompt: 'Who is find_user?', expect: 'get_weather' }]);
  const r = await run(['--cases', file, ...server]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /fail +get_weather +Who is find_user\?/);
  assert.match(r.stdout, /→ called "find_user", expected "get_weather"/);
  assert.match(r.stdout, /✖ failed: 3 of 4 passed \(75%\), 1 failed, 0 errors; needs 100%/);
  assert.match(r.stdout, /Mixed up: get_weather → find_user/);
  assert.equal((await run(['--cases', file, '--pass-rate', '75', ...server])).code, 0);
  assert.equal((await run(['--cases', file, '--fail-on', 'never', ...server])).code, 0);
});

test('eval: json and github formats', async () => {
  const file = casesFile('json.json', { model: 'claude-sonnet-5-5', cases: [good[0], { prompt: 'REFUSE get_weather', expect: 'get_weather' }] });
  const j = await run(['--cases', file, '--format', 'json', '--effort', 'low', ...server]);
  assert.equal(j.code, 1);
  const out = JSON.parse(j.stdout);
  assert.equal(out.model, 'claude-sonnet-5-5', 'the model from the cases file');
  assert.equal(out.effort, 'low');
  assert.deepEqual(out.counts, { pass: 1, fail: 0, error: 1 });
  assert.equal(out.passRate, 50);
  assert.deepEqual(out.results[0].args, { city: 'pune' });
  assert.equal(out.results[1].msg, 'the model declined the request');
  assert.deepEqual((await requests()).at(-1).body.output_config, { effort: 'low' });

  const g = await run(['--cases', file, '--format', 'github', '--model', 'claude-haiku-5-5', ...server]);
  assert.match(g.stdout, /^::error title=MCP eval%3A get_weather::"REFUSE get_weather": the model declined the request$/m);
  assert.match(g.stdout, /^MCP eval: 1 of 2 passed \(50%\), 0 failed, 1 error; needs 100%\. Model: claude-haiku-5-5\./m, '--model wins over the file');
});

test('eval: setup problems stop with exit 2 and one clear message', async () => {
  const file = casesFile('setup.json', good);
  const badKey = await run(['--cases', file, ...server], { ANTHROPIC_API_KEY: 'bad-key' });
  assert.equal(badKey.code, 2);
  assert.match(badKey.stderr, /the Anthropic API refused the key \(401\)\. Set ANTHROPIC_API_KEY/);

  const badModel = await run(['--cases', file, '--model', 'no-such-model', ...server]);
  assert.equal(badModel.code, 2);
  assert.match(badModel.stderr, /model "no-such-model" was not found/);

  const typo = await run(['--cases', casesFile('typo.json', [{ prompt: 'p', expect: 'get_wether' }]), ...server]);
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /no tool named "get_wether"\. It has: ping_db, get_weather/);

  const missing = await run(['--cases', path.join(tmp, 'nope.json'), ...server]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /No cases file at .*nope\.json/);

  const badFile = await run(['--cases', casesFile('bad.json', [{ prompt: 'p' }]), ...server]);
  assert.match(badFile.stderr, /case 1 needs "expect"/);
  assert.match((await run(['--cases', file, '--pass-rate', '101', ...server])).stderr, /--pass-rate must be a percentage/);
  assert.match((await run(['--cases', file, '--effort', 'turbo', ...server])).stderr, /--effort must be low, medium/);
});
