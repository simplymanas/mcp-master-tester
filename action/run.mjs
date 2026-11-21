// MCP Master Tester — GitHub Action entry point (action.yml at the repo root runs this).
// Author: @simplymanas
//
// Turns the action's inputs into `cli.js lint` and `cli.js smoke` runs with --format github, passes
// their output through (so the annotations appear on the run), and writes a job summary and the
// step outputs. Not part of the npm package. The pure functions are exported for test/action.test.js.

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const LINT_FAIL = ['error', 'warn', 'info', 'never'];
const SMOKE_FAIL = ['fail', 'warn', 'skip', 'never'];
const MAX_ROWS = 50;

export class InputError extends Error {}

// The argument lists for cli.js, one per check, from the MMT_* variables action.yml sets.
export function planRuns(env) {
  const get = (name) => (env[`MMT_${name}`] ?? '').trim();
  const lines = (name) => get(name).split('\n').map((s) => s.trim()).filter(Boolean);
  const items = (name) => get(name).split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const bool = (name) => {
    const v = get(name).toLowerCase();
    if (v === '' || v === 'false') return false;
    if (v === 'true') return true;
    throw new InputError(`${name.toLowerCase()} must be true or false (got "${get(name)}")`);
  };
  const oneOf = (name, allowed, fallback) => {
    const v = get(name) || fallback;
    if (!allowed.includes(v)) throw new InputError(`${name.toLowerCase().replace(/_/g, '-')} must be ${allowed.join(', ')} (got "${v}")`);
    return v;
  };

  const checks = items('CHECKS').map((c) => c.toLowerCase());
  for (const c of checks) if (c !== 'lint' && c !== 'smoke') throw new InputError(`checks can only list lint and smoke (got "${c}")`);
  const wanted = checks.length ? checks : ['lint', 'smoke'];

  const command = get('COMMAND');
  const url = get('URL');
  if (command && url) throw new InputError('Give either command or url, not both.');
  if (!command && !url) throw new InputError('No server given: set command (a stdio server, e.g. "node dist/index.js") or url.');

  const common = ['--format', 'github', '--timeout', get('TIMEOUT') || '30000'];
  let server;
  if (url) {
    server = ['--url', url];
    if (bool('SSE')) server.push('--sse');
    for (const h of lines('HEADERS')) server.push('--header', h);
  } else {
    if (get('CWD')) common.push('--cwd', get('CWD'));
    for (const e of lines('ENV')) common.push('--env', e);
    server = ['--', ...command.split(/\s+/)];
  }
  // The server goes last: "--" ends cli.js's own options, and everything after it is the command.
  const tail = (opts) => [...opts, ...server];

  const runs = [];
  if (wanted.includes('lint')) runs.push({ check: 'lint', argv: ['lint', ...common, '--fail-on', oneOf('LINT_FAIL_ON', LINT_FAIL, 'error'), ...tail([])] });
  if (wanted.includes('smoke')) {
    const opts = ['--fail-on', oneOf('SMOKE_FAIL_ON', SMOKE_FAIL, 'fail')];
    for (const t of items('TOOLS')) opts.push('--tool', t);
    for (const s of items('SKIP')) opts.push('--skip', s);
    if (bool('ALL')) opts.push('--all');
    if (get('ARGS')) opts.push('--args', get('ARGS'));
    runs.push({ check: 'smoke', argv: ['smoke', ...common, ...tail(opts)] });
  }
  return runs;
}

const unescape = (s) => s.replace(/%0D/g, '\r').replace(/%0A/g, '\n').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%25/g, '%');
const cell = (s) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
// The CLI's hints name its flags; in the summary, name the action inputs that set them.
const INPUT_FOR_FLAG = [[/--fail-on skip\b/g, '`smoke-fail-on: skip`'], [/--all\b/g, '`all: true`'], [/--tool\b/g, '`tools`'], [/--skip\b/g, '`skip`'], [/--args\b/g, '`args`']];
const asInputs = (msg) => INPUT_FOR_FLAG.reduce((s, [re, input]) => s.replace(re, input), msg);
// Annotation titles that name a part of the run rather than a tool.
const NOT_A_TOOL = new Set(['untested tools']);

// Markdown for the job summary from one run's output and exit code.
export function summarize(check, stdout, stderr, code) {
  const result = code === 0 ? 'passed' : code === 1 ? 'failed' : 'error';
  const label = { passed: 'passed', failed: 'failed', error: 'could not run' }[result];
  const rows = [];
  let notices = 0;
  let total = '';
  for (const line of stdout.split('\n')) {
    const m = /^::(error|warning|notice) title=([^:]*)::(.*)$/.exec(line);
    if (!m) { if (line.startsWith(`MCP ${check}:`)) total = line.slice(`MCP ${check}:`.length).trim(); continue; }
    if (m[1] === 'notice') { notices++; continue; }
    const title = unescape(m[2]);
    const target = title.includes(': ') ? title.slice(title.indexOf(': ') + 2) : '';
    const tool = target && !NOT_A_TOOL.has(target) ? `\`${cell(target)}\`` : '';
    rows.push(`| ${m[1]} | ${tool} | ${asInputs(cell(unescape(m[3])))} |`);
  }
  const out = [`### MCP ${check}: ${label}`, ''];
  if (total) out.push(total, '');
  if (result === 'error') {
    const reason = stderr.trim().split('\n').filter(Boolean).slice(-5).join('\n');
    out.push('The check stopped before it could finish:', '', '```text', reason || `exit code ${code}`, '```', '');
  }
  if (rows.length) {
    out.push('| Level | Tool | Message |', '|---|---|---|', ...rows.slice(0, MAX_ROWS));
    if (rows.length > MAX_ROWS) out.push('', `…and ${rows.length - MAX_ROWS} more, listed as annotations on the run.`);
    out.push('');
  }
  if (notices) out.push(`${notices} info ${notices === 1 ? 'finding is' : 'findings are'} listed as notices on the run.`, '');
  return { result, markdown: out.join('\n') };
}

function run(argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    child.on('error', (err) => resolve({ code: 2, stdout, stderr: `${stderr}${err.message}\n` }));
    child.on('close', (code) => resolve({ code: code ?? 2, stdout, stderr }));
  });
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.log(`::error title=MCP Master Tester::Node.js 20 or newer is needed (this runner has ${process.version}). Add actions/setup-node before this step.`);
    return 2;
  }
  let runs;
  try {
    runs = planRuns(process.env);
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    console.log(`::error title=MCP Master Tester::${err.message}`);
    return 2;
  }
  const results = { lint: 'skipped', smoke: 'skipped' };
  let worst = 0;
  for (const { check, argv } of runs) {
    console.log(`::group::MCP ${check}`);
    const { code, stdout, stderr } = await run(argv);
    console.log('::endgroup::');
    const { result, markdown } = summarize(check, stdout, stderr, code);
    results[check] = result;
    worst = Math.max(worst, code);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `lint=${results.lint}\nsmoke=${results.smoke}\n`);
  return worst;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
