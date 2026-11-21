// Tests for the GitHub Action's entry point (action/run.mjs): how inputs become cli.js arguments, the
// job summary, and whole runs against the fixture servers with the files GitHub provides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRuns, summarize, InputError } from '../action/run.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'action/run.mjs');

test('action.yml passes every input to the script, and only through env', () => {
  const yml = readFileSync(path.join(root, 'action.yml'), 'utf8');
  const inputs = [...yml.split('\noutputs:')[0].matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]);
  assert.ok(inputs.length >= 10);
  for (const name of inputs) {
    const envName = `MMT_${name.toUpperCase().replace(/-/g, '_')}`;
    assert.ok(yml.includes(`${envName}: \${{ inputs.${name} }}`), `${name} is passed as ${envName}`);
  }
  // No input is expanded inside a run: line, where it would become shell code.
  for (const line of yml.split('\n').filter((l) => /^\s+run:/.test(l))) assert.ok(!line.includes('${{'), line);
});

test('planRuns: a stdio server gets lint then smoke, with the command after --', () => {
  const runs = planRuns({ MMT_COMMAND: 'node dist/index.js --port  0', MMT_CHECKS: 'lint, smoke' });
  assert.deepEqual(runs.map((r) => r.check), ['lint', 'smoke']);
  assert.deepEqual(runs[0].argv, ['lint', '--format', 'github', '--timeout', '30000', '--fail-on', 'error', '--', 'node', 'dist/index.js', '--port', '0']);
  assert.deepEqual(runs[1].argv, ['smoke', '--format', 'github', '--timeout', '30000', '--fail-on', 'fail', '--', 'node', 'dist/index.js', '--port', '0']);
  assert.deepEqual(planRuns({ MMT_COMMAND: 'node s.js' }).map((r) => r.check), ['lint', 'smoke'], 'both by default');
  assert.deepEqual(planRuns({ MMT_COMMAND: 'node s.js', MMT_CHECKS: 'smoke' }).map((r) => r.check), ['smoke']);
});

test('planRuns: env, cwd and the smoke options', () => {
  const [lint, smoke] = planRuns({
    MMT_COMMAND: 'python server.py', MMT_ENV: 'API_KEY=abc\n\n  MODE=test  ', MMT_CWD: 'server',
    MMT_LINT_FAIL_ON: 'warn', MMT_SMOKE_FAIL_ON: 'skip', MMT_TOOLS: 'get_a, get_b\nget_c', MMT_SKIP: 'slow_one',
    MMT_ALL: 'true', MMT_ARGS: 'smoke.json', MMT_TIMEOUT: '5000',
  });
  assert.deepEqual(lint.argv, ['lint', '--format', 'github', '--timeout', '5000', '--cwd', 'server', '--env', 'API_KEY=abc', '--env', 'MODE=test', '--fail-on', 'warn', '--', 'python', 'server.py']);
  assert.deepEqual(smoke.argv.slice(smoke.argv.indexOf('--fail-on')), [
    '--fail-on', 'skip', '--tool', 'get_a', '--tool', 'get_b', '--tool', 'get_c', '--skip', 'slow_one', '--all', '--args', 'smoke.json', '--', 'python', 'server.py',
  ]);
});

test('planRuns: a remote server gets --url, --sse and one --header per line, commas and all', () => {
  const [lint] = planRuns({ MMT_URL: 'https://example.com/sse', MMT_SSE: 'true', MMT_HEADERS: 'Authorization: Bearer x\nAccept: a, b', MMT_CHECKS: 'lint' });
  assert.deepEqual(lint.argv, ['lint', '--format', 'github', '--timeout', '30000', '--fail-on', 'error', '--url', 'https://example.com/sse', '--sse', '--header', 'Authorization: Bearer x', '--header', 'Accept: a, b']);
});

test('planRuns: wrong inputs are explained in the action\'s own terms', () => {
  const fails = (env, re) => assert.throws(() => planRuns(env), (err) => err instanceof InputError && re.test(err.message));
  fails({}, /set command .* or url/);
  fails({ MMT_COMMAND: 'node s.js', MMT_URL: 'https://x' }, /either command or url/);
  fails({ MMT_COMMAND: 'node s.js', MMT_CHECKS: 'lint, test' }, /only list lint and smoke \(got "test"\)/);
  fails({ MMT_COMMAND: 'node s.js', MMT_LINT_FAIL_ON: 'warning' }, /lint-fail-on must be error, warn, info, never/);
  fails({ MMT_COMMAND: 'node s.js', MMT_SMOKE_FAIL_ON: 'error' }, /smoke-fail-on must be fail, warn, skip, never/);
  fails({ MMT_COMMAND: 'node s.js', MMT_ALL: 'yes' }, /all must be true or false/);
});

test('summarize: warnings and errors become a table; info findings are only counted', () => {
  const stdout = [
    '::error title=MCP lint%3A send_mail::required "subject" is not defined in properties',
    '::warning title=MCP lint%3A get_user::a | b%0Asecond line, 100%25',
    '::notice title=MCP lint%3A get_user::no annotations',
    '::notice title=MCP lint%3A send_mail::very short description',
    'MCP lint: 1 error, 1 warning, 2 info. Failing on: error.',
  ].join('\n');
  const { result, markdown } = summarize('lint', stdout, '', 1);
  assert.equal(result, 'failed');
  assert.match(markdown, /^### MCP lint: failed\n\n1 error, 1 warning, 2 info\. Failing on: error\./);
  assert.match(markdown, /\| error \| `send_mail` \| required "subject" is not defined in properties \|/);
  assert.match(markdown, /\| warning \| `get_user` \| a \\\| b second line, 100% \|/);
  assert.match(markdown, /2 info findings are listed as notices on the run\./);
  assert.ok(!/no annotations/.test(markdown));
});

test('summarize: a run that could not start shows why', () => {
  const { result, markdown } = summarize('smoke', '', 'mcp-master-tester smoke: could not connect: spawn nope ENOENT\n', 2);
  assert.equal(result, 'error');
  assert.match(markdown, /### MCP smoke: could not run/);
  assert.match(markdown, /spawn nope ENOENT/);
  assert.equal(summarize('smoke', 'MCP smoke: 0 failed, 0 warnings, 2 passed, 0 skipped. Failing on: fail.', '', 0).result, 'passed');
});

test('summarize: run-level rows have no tool, and hints name the action inputs, not CLI flags', () => {
  const { markdown } = summarize('smoke', '::warning title=MCP smoke%3A untested tools::1 of 3 tools was not tested: send_mail. Add --all to run it, or --fail-on skip to fail when a tool goes untested.', '', 0);
  assert.match(markdown, /\| warning \|  \| 1 of 3 tools was not tested: send_mail\. Add `all: true` to run it, or `smoke-fail-on: skip` to fail/);
});

// Runs the entry point the way the composite step does, with GitHub's summary and output files.
function runAction(env) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mmt-action-'));
  const files = { GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'), GITHUB_OUTPUT: path.join(dir, 'output') };
  for (const f of Object.values(files)) writeFileSync(f, '');
  return new Promise((resolve) => {
    execFile(process.execPath, [entry], { cwd: root, timeout: 60000, env: { PATH: process.env.PATH, ...files, ...env } }, (err, stdout) => {
      const read = (k) => readFileSync(files[k], 'utf8');
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, summary: read('GITHUB_STEP_SUMMARY'), output: read('GITHUB_OUTPUT') });
      rmSync(dir, { recursive: true, force: true });
    });
  });
}

test('the action passes on a healthy server: annotations in the log, a summary, and outputs', async () => {
  const r = await runAction({ MMT_COMMAND: 'node test/fixtures/smoke-server.js', MMT_CHECKS: 'lint, smoke' });
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /::group::MCP lint/);
  assert.match(r.stdout, /::warning title=MCP smoke%3A find_user::/);
  assert.match(r.summary, /### MCP lint: passed/);
  assert.match(r.summary, /### MCP smoke: passed\n\n0 failed, 1 warning, 2 passed, 1 skipped/);
  assert.equal(r.output, 'lint=passed\nsmoke=passed\n');
});

test('the action fails when lint fails, and still runs the smoke test', async () => {
  const r = await runAction({ MMT_COMMAND: 'node test/fixtures/lint-server.js' });
  assert.equal(r.code, 1);
  assert.match(r.summary, /### MCP lint: failed[\s\S]*\| error \| `read_note` \| duplicate tool name \|/);
  assert.match(r.summary, /### MCP smoke:/);
  assert.match(r.output, /^lint=failed\nsmoke=\w+\n$/);
});

test('the action stops with exit 2 on bad inputs or a server that will not start', async () => {
  const bad = await runAction({ MMT_COMMAND: 'node s.js', MMT_CHECKS: 'test' });
  assert.equal(bad.code, 2);
  assert.match(bad.stdout, /^::error title=MCP Master Tester::checks can only list lint and smoke/m);
  const missing = await runAction({ MMT_COMMAND: 'node test/fixtures/does-not-exist.js', MMT_CHECKS: 'lint' });
  assert.equal(missing.code, 2);
  assert.match(missing.summary, /### MCP lint: could not run/);
  assert.equal(missing.output, 'lint=error\nsmoke=skipped\n');
});
