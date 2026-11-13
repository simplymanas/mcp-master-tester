// Tests for `mcp-master-tester lint` and `smoke`: run the CLI as a child process against fixture and reference servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'cli.js');
const fixture = path.join(root, 'test/fixtures/lint-server.js');
const smokeFixture = path.join(root, 'test/fixtures/smoke-server.js');
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
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mcpt-cli-'));
after(() => { httpServer?.kill(); rmSync(tmp, { recursive: true, force: true }); });
const argsFile = (name, content) => { const file = path.join(tmp, name); writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content)); return file; };

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
  assert.match((await run('smoke', '--help')).stdout, /--print-args/);
  assert.match((await run('--help')).stdout, /mcp-master-tester smoke/);
  const r = await run('frobnicate');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command "frobnicate"/);
});

// ---------------------------------------------------------------- smoke

test('smoke: runs the read-only tools, skips the rest, and warns when made-up arguments are rejected', async () => {
  const r = await run('smoke', '--', 'node', smokeFixture);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mcp-master-tester smoke · smoke-fixture v0\.0\.1 · 4 tools · stdio/);
  assert.match(r.stdout, /pass\s+ping_db\s+\d+ ms/);
  assert.match(r.stdout, /pass\s+get_weather\s+\d+ ms/);
  assert.match(r.stdout, /warn\s+find_user\s+\d+ ms\s+returned an error for the made-up "id": No user with id "test"/);
  assert.match(r.stdout, /skip\s+delete_user\s+not marked read-only/);
  assert.match(r.stdout, /passed: 0 failed, 1 warning, 2 passed, 1 skipped\. Failing on: fail\./);
  assert.match(r.stdout, /1 of 4 tools was not tested because it isn't marked read-only \(annotations\.readOnlyHint\): delete_user\. Add --all to run it, or --fail-on skip/);
  assert.match(r.stdout, /--print-args/);
  assert.equal((await run('smoke', '--fail-on', 'warn', '--', 'node', smokeFixture)).code, 1);
});

test('smoke: --args supplies real arguments, and --print-args writes a file to start from', async () => {
  const printed = await run('smoke', '--print-args', '--', 'node', smokeFixture);
  assert.equal(printed.code, 0, printed.stderr);
  assert.deepEqual(JSON.parse(printed.stdout), { ping_db: {}, get_weather: { city: 'Pune' }, find_user: { id: 'test' } });
  assert.match(printed.stderr, /Made-up values to replace with real ones: find_user \(id\)/);

  const file = argsFile('real.json', { ...JSON.parse(printed.stdout), find_user: { id: 'u_1' } });
  const r = await run('smoke', '--fail-on', 'warn', '--args', file, '--', 'node', smokeFixture);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass\s+find_user/);
  assert.match(r.stdout, /0 failed, 0 warnings, 3 passed, 1 skipped/);

  // The same error is a failure once the arguments are the user's own.
  const wrong = await run('smoke', '--args', argsFile('wrong.json', { find_user: { id: 'u_404' } }), '--', 'node', smokeFixture);
  assert.equal(wrong.code, 1);
  assert.match(wrong.stdout, /fail\s+find_user\s+\d+ ms\s+returned an error: No user with id "u_404"/);
});

test('smoke: --all, --tool and --skip choose what runs', async () => {
  const all = await run('smoke', '--all', '--', 'node', smokeFixture);
  assert.match(all.stdout, /pass\s+delete_user/);
  assert.match(all.stdout, /3 passed, 0 skipped/);

  const one = await run('smoke', '--tool', 'delete_user', '--', 'node', smokeFixture);
  assert.equal(one.code, 0);
  assert.match(one.stdout, /pass\s+delete_user/);
  assert.match(one.stdout, /skip\s+ping_db\s+not selected/);
  assert.match(one.stdout, /0 failed, 0 warnings, 1 passed, 3 skipped/);

  const skipped = await run('smoke', '--fail-on', 'warn', '--skip', 'find_user', '--', 'node', smokeFixture);
  assert.equal(skipped.code, 0);
  assert.match(skipped.stdout, /skip\s+find_user\s+skipped on request/);
});

test('smoke: untested tools are called out, and --fail-on skip turns them into a failure', async () => {
  // By default the run passes, but says which tools the pass doesn't cover.
  const lenient = await run('smoke', '--skip', 'find_user', '--', 'node', smokeFixture);
  assert.equal(lenient.code, 0);
  assert.match(lenient.stdout, /passed: 0 failed, 0 warnings, 2 passed, 2 skipped/);
  assert.match(lenient.stdout, /1 of 4 tools was not tested .*: delete_user\./);

  const strict = await run('smoke', '--fail-on', 'skip', '--skip', 'find_user', '--', 'node', smokeFixture);
  assert.equal(strict.code, 1);
  assert.match(strict.stdout, /failed: 0 failed, 0 warnings, 2 passed, 2 skipped\. Failing on: skip\./);
  assert.match(strict.stdout, /delete_user\. Add --all to run it, or --skip to leave it out on purpose\./);

  // A tool left out on purpose doesn't count: every tool is now either tested or excluded by name.
  const excluded = await run('smoke', '--fail-on', 'skip', '--skip', 'find_user', '--skip', 'delete_user', '--', 'node', smokeFixture);
  assert.equal(excluded.code, 0, excluded.stdout);
  assert.doesNotMatch(excluded.stdout, /not tested/);

  // Running it also satisfies the check, and "skip" still includes warnings.
  assert.equal((await run('smoke', '--fail-on', 'skip', '--all', '--skip', 'find_user', '--', 'node', smokeFixture)).code, 0);
  assert.equal((await run('smoke', '--fail-on', 'skip', '--all', '--', 'node', smokeFixture)).code, 1, 'find_user warns');

  const github = await run('smoke', '--format', 'github', '--fail-on', 'skip', '--skip', 'find_user', '--', 'node', smokeFixture);
  assert.match(github.stdout, /^::error title=MCP smoke%3A untested tools::1 of 4 tools was not tested/m);
});

test('smoke: tools left out with --tool are a choice, so they are not reported as untested', async () => {
  const r = await run('smoke', '--fail-on', 'skip', '--tool', 'echo', '--', 'node', everything);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /0 failed, 0 warnings, 1 passed, 12 skipped/);
  assert.doesNotMatch(r.stdout, /not tested/);
});

test('smoke: a broken result, an exception and a timeout each fail the run', async () => {
  const r = await run('smoke', '--timeout', '1500', '--', 'node', smokeFixture, 'broken');
  assert.equal(r.code, 1);
  assert.match(r.stdout, /fail\s+get_report\s+\d+ ms\s+result breaks its outputSchema: .*celsius must be number/);
  assert.match(r.stdout, /fail\s+get_stats\s+\d+ ms\s+protocol error -32603: TypeError: stats is undefined/);
  // A timer may fire a millisecond early, so the measured time can read 1499.
  assert.match(r.stdout, /fail\s+slow_query\s+\d+ ms\s+no answer: timed out after 1[45]\d\d ms/);
  assert.match(r.stdout, /failed: 3 failed, 1 warning, 2 passed, 1 skipped/);
  assert.equal((await run('smoke', '--timeout', '1500', '--fail-on', 'never', '--', 'node', smokeFixture, 'broken')).code, 0);
});

test('smoke: a tool that crashes the server fails, and the tools after it are reported as not run', async () => {
  const r = await run('smoke', '--', 'node', smokeFixture, 'crash');
  assert.equal(r.code, 1);
  assert.match(r.stdout, /pass\s+ping_db/);
  assert.match(r.stdout, /fail\s+crash_now\s+\d+ ms\s+the server closed the connection during the call/);
  assert.match(r.stdout, /skip\s+after_crash\s+not run: the server connection closed during "crash_now"/);
});

test('smoke: a run that calls nothing fails and says why', async () => {
  const r = await run('smoke', '--', 'node', smokeFixture, 'unmarked');
  assert.equal(r.code, 1);
  assert.match(r.stdout, /failed: no tools were run\. Failing on: fail\.\nNo tool is marked read-only \(annotations\.readOnlyHint\)\. Add --all, or name tools with --tool\./);
  assert.doesNotMatch(r.stdout, /0 failed/, 'the verdict must not read "failed: 0 failed"');
  assert.equal((await run('smoke', '--all', '--', 'node', smokeFixture, 'unmarked')).code, 0);
  const never = await run('smoke', '--fail-on', 'never', '--', 'node', smokeFixture, 'unmarked');
  assert.equal(never.code, 0);
  assert.match(never.stdout, /passed: 0 failed, 0 warnings, 0 passed, 1 skipped\. Failing on: never\.\nNo tools were run\. No tool is marked read-only/);
});

test('smoke: --format json is machine-readable', async () => {
  const r = await run('smoke', '--format', 'json', '--timeout', '1500', '--', 'node', smokeFixture, 'broken');
  assert.equal(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.server, { name: 'smoke-fixture', version: '0.0.1' });
  assert.deepEqual(j.counts, { pass: 2, warn: 1, fail: 3, skip: 1 });
  assert.equal(j.passed, false);
  assert.equal(j.failOn, 'fail');
  assert.equal(j.tools, 7);
  const byTool = Object.fromEntries(j.results.map((x) => [x.tool, x]));
  assert.deepEqual({ ...byTool.get_weather, ms: 0 }, { tool: 'get_weather', status: 'pass', ms: 0, msg: '', args: { city: 'Pune' }, argSource: 'schema' });
  assert.equal(byTool.find_user.argSource, 'made-up');
  assert.deepEqual(byTool.delete_user, { tool: 'delete_user', status: 'skip', ms: null, msg: 'not marked read-only', args: null, argSource: null });
  assert.deepEqual(j.untested, ['delete_user']);
});

test('smoke: --format github prints an annotation for each failure and warning', async () => {
  const r = await run('smoke', '--format', 'github', '--timeout', '1500', '--', 'node', smokeFixture, 'broken');
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.includes('::error title=MCP smoke%3A get_stats::protocol error -32603: TypeError: stats is undefined'), r.stdout);
  assert.ok(lines.some((l) => l.startsWith('::warning title=MCP smoke%3A find_user::returned an error for the made-up "id"')));
  assert.ok(lines.some((l) => l.startsWith('::warning title=MCP smoke%3A untested tools::1 of 7 tools was not tested because it isn\'t marked read-only (annotations.readOnlyHint): delete_user.')), r.stdout);
  assert.equal(lines.filter((l) => l.startsWith('::')).length, 5, 'one per failure and warning, plus one for the untested tool; passes get none');
  assert.equal(lines.at(-1), 'MCP smoke: 3 failed, 1 warning, 2 passed, 1 skipped. Failing on: fail.');

  const nothing = await run('smoke', '--format', 'github', '--', 'node', smokeFixture, 'unmarked');
  assert.match(nothing.stdout, /^::error title=MCP smoke::No tools were run/);
});

test('smoke: the reference server passes over stdio and Streamable HTTP', async () => {
  // trigger-long-running-operation takes 10 seconds by design; leave it out to keep the suite quick.
  const stdio = await run('smoke', '--skip', 'trigger-long-running-operation', '--', 'node', everything);
  assert.equal(stdio.code, 0, stdio.stdout + stdio.stderr);
  assert.match(stdio.stdout, /pass\s+get-structured-content/);
  assert.match(stdio.stdout, /passed: 0 failed, 0 warnings, 8 passed, 5 skipped/);

  const http = await run('smoke', '--tool', 'echo', '--tool', 'get-sum', '--url', `http://127.0.0.1:${HTTP_PORT}/mcp`);
  assert.equal(http.code, 0, http.stdout + http.stderr);
  assert.match(http.stdout, /· Streamable HTTP/);
  assert.match(http.stdout, /0 failed, 0 warnings, 2 passed/);
});

test('smoke: a misspelt tool name or a bad --args file exits 2 instead of testing less', async () => {
  const cases = [
    [['--tool', 'pingdb'], /--tool: the server has no tool named "pingdb"\. It has: ping_db, get_weather/],
    [['--skip', 'nope'], /--skip: the server has no tool named "nope"/],
    [['--args', argsFile('typo.json', { find_usr: { id: 'u_1' } })], /--args: the server has no tool named "find_usr"/],
    [['--args', argsFile('array.json', [1])], /must hold a JSON object like/],
    [['--args', argsFile('scalar.json', { find_user: 'u_1' })], /the arguments for "find_user" .* must be a JSON object/],
    [['--args', argsFile('broken.json', '{ not json')], /--args: could not read/],
    [['--args', path.join(tmp, 'missing.json')], /--args: could not read/],
    [['--fail-on', 'error'], /--fail-on must be fail, warn, skip or never \(got "error"\)/],
  ];
  for (const [args, message] of cases) {
    const r = await run('smoke', ...args, '--', 'node', smokeFixture);
    assert.equal(r.code, 2, `should reject ${JSON.stringify(args)}: ${r.stdout}`);
    assert.match(r.stderr, message);
    assert.match(r.stderr, /smoke --help/);
  }
  const noServer = await run('smoke');
  assert.equal(noServer.code, 2);
  assert.match(noServer.stderr, /No server given/);
});

test('smoke: a server that fails to start exits 2 and shows its stderr', async () => {
  const r = await run('smoke', '--timeout', '10000', '--', 'node', '-e', "console.error('boom: missing API_KEY'); process.exit(1)");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /boom: missing API_KEY/);
});

// ---------------------------------------------------------------- read-only claims

test('smoke: a tool marked read-only but named like a write is not called unless asked for', async () => {
  const r = await run('smoke', '--', 'node', smokeFixture, 'mislabelled');
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pass\s+ping_db/);
  assert.match(r.stdout, /skip\s+cancel_booking\s+marked read-only, but "cancel" in its name suggests it changes something/);
  assert.match(r.stdout, /skip\s+get_audit\s+marked read-only and destructive at the same time/);
  assert.match(r.stdout, /0 failed, 0 warnings, 1 passed, 2 skipped/);
  assert.match(r.stdout, /2 of 3 tools were not tested because they aren't clearly read-only \(not marked read-only, or marked but named like a write\): cancel_booking, get_audit\. Add --all to run them/);

  // By name, or with --all, it runs.
  const named = await run('smoke', '--tool', 'cancel_booking', '--', 'node', smokeFixture, 'mislabelled');
  assert.match(named.stdout, /pass\s+cancel_booking/);
  assert.match((await run('smoke', '--all', '--', 'node', smokeFixture, 'mislabelled')).stdout, /0 failed, 0 warnings, 3 passed, 0 skipped/);

  // They count as untested, so --fail-on skip fails until they are run or left out by name.
  assert.equal((await run('smoke', '--fail-on', 'skip', '--', 'node', smokeFixture, 'mislabelled')).code, 1);
  assert.equal((await run('smoke', '--fail-on', 'skip', '--skip', 'cancel_booking', '--skip', 'get_audit', '--', 'node', smokeFixture, 'mislabelled')).code, 0);

  const json = JSON.parse((await run('smoke', '--format', 'json', '--', 'node', smokeFixture, 'mislabelled')).stdout);
  assert.deepEqual(json.untested, ['cancel_booking', 'get_audit']);
  assert.deepEqual(JSON.parse((await run('smoke', '--print-args', '--', 'node', smokeFixture, 'mislabelled')).stdout), { ping_db: {} });
});

test('lint: warns about read-only tools whose name or annotations contradict the label', async () => {
  const r = await run('lint', '--', 'node', smokeFixture, 'mislabelled');
  assert.equal(r.code, 0, 'a warning, not an error');
  assert.match(r.stdout, /warn\s+cancel_booking\s+marked read-only, but "cancel" in its name suggests it changes something/);
  assert.match(r.stdout, /warn\s+get_audit\s+marked read-only and destructive at the same time/);
  assert.doesNotMatch(r.stdout, /warn\s+ping_db\s+marked read-only/);
  assert.equal((await run('lint', '--fail-on', 'warn', '--', 'node', smokeFixture, 'mislabelled')).code, 1);
  // The reference server's read-only tools are named like lookups.
  assert.doesNotMatch((await run('lint', '--', 'node', everything)).stdout, /marked read-only/);
});
