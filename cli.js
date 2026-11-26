#!/usr/bin/env node
// MCP Master Tester — command line entry point.
//   mcp-master-tester                 start the web UI (server.js)
//   mcp-master-tester lint [...]      check a server's tool definitions
//   mcp-master-tester smoke [...]     call each read-only tool once and check the answers
//   mcp-master-tester snapshot [...]  save the tool list to a lockfile
//   mcp-master-tester diff [...]      compare the tool list with the lockfile, flag breaking changes
//   mcp-master-tester eval [...]      check that a model picks the right tool for each test request
// lint, smoke, diff and eval exit non-zero on findings, for CI.
// Author: @simplymanas

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { lintTools, toolListSize, sizeLines } from './public/lint.js';
import { planSmoke, runSmoke, countSmoke, smokeFailed, untestedTools, NOT_READ_ONLY } from './public/smoke.js';
import { snapshotTools, lockfileText, parseLockfile, diffTools, DEFAULT_LOCKFILE, DIFF_LEVELS } from './public/diff.js';
import { parseCases, unknownTools, toApiTools, judgeCase, countEval, passRate, mixUps, caseLabel, shortText, DEFAULT_CASES, DEFAULT_MODEL, EVAL_SYSTEM } from './public/evals.js';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const SEVERITIES = ['error', 'warn', 'info'];

const HELP = `MCP Master Tester ${VERSION}

Usage:
  mcp-master-tester                               Start the web UI (http://127.0.0.1:6280, or set PORT)
  mcp-master-tester lint     [options] <server>   Check the server's tool definitions
  mcp-master-tester smoke    [options] <server>   Call each read-only tool once and check the answers
  mcp-master-tester snapshot [options] <server>   Save the tool list to a lockfile, to commit
  mcp-master-tester diff     [options] <server>   Compare the tool list with the lockfile
  mcp-master-tester eval     [options] <server>   Check that a model picks the right tool for each request

<server> is one of:
  -- <command> [args...]   A stdio server, for example: -- node dist/index.js
  --url <url>              A Streamable HTTP server (add --sse for the legacy SSE transport)

Options for every command:
  --format <format>     text (default), json, or github (GitHub Actions annotations)
  --env KEY=VALUE       Environment variable for a stdio server (repeatable)
  --cwd <dir>           Working directory for a stdio server
  --header "Name: value"  HTTP header (repeatable), e.g. --header "Authorization: Bearer $TOKEN"
  --timeout <ms>        Give up on connecting, listing tools, or one tool call after this long
                        (default 30000)

lint options:
  --fail-on <level>     Exit 1 when there are findings at this level or worse:
                        error (default), warn, info, or never
  --show-info           Also list info findings in text output (they are counted either way)
  --max-tokens <n>      Token budget for the whole tool list: going over it is an error, so CI
                        fails when the list grows past it. Replaces the warning at ~10,000.
  --max-tool-tokens <n> Token budget for any one tool definition
  --tokenizer <name>    How to count tokens for the size and the budgets: estimate (default,
                        characters of compact JSON / 4) or o200k (OpenAI's tokenizer, exact;
                        needs the gpt-tokenizer package, see the README)

smoke options:
  --all                 Also run tools that aren't clearly read-only. They may change data.
  --tool <name>         Run only this tool (repeatable), whether or not it is read-only.
                        The safest way to choose: it doesn't rely on the server's own labels.
  --skip <name>         Don't run this tool (repeatable)
  --args <file>         JSON file with the arguments to send: { "tool_name": { "param": "value" } }
                        Tools not in the file get arguments built from their schema.
  --print-args          Print the arguments that would be sent, as JSON you can save, edit and
                        pass back with --args. Runs nothing.
  --fail-on <level>     Exit 1 on: fail (default), warn, skip, or never. Each level includes
                        the ones before it; skip also fails when a tool went untested and
                        you didn't leave it out yourself with --skip or --tool.

snapshot options:
  --out <file>          Where to write the lockfile (default ${DEFAULT_LOCKFILE})

diff options:
  --lock <file>         The lockfile to compare with (default ${DEFAULT_LOCKFILE})
  --fail-on <level>     Exit 1 on: breaking (default), warn, info, or never. breaking: a change
                        that can fail existing callers or clients. warn: a changed description,
                        annotation or default, or a change it can't classify. info: additions.

eval options (calls the Anthropic API with your key; nothing is called on the server):
  --cases <file>        Test requests and the tool each should lead to (default ${DEFAULT_CASES}):
                        [{ "prompt": "Weather in Paris?", "expect": "get_weather", "args": { "city": "Paris" } }]
                        "expect" can be a list of acceptable tools, or null when no tool fits.
  --model <id>          Model to test with (default: "model" in the cases file, else ${DEFAULT_MODEL})
  --effort <level>      Effort for the model: low, medium, high, xhigh or max (default: the model's own)
  --pass-rate <percent> Pass when at least this share of cases pass (default 100). Models vary a
                        little from run to run, so a large suite may want 90.
  --fail-on <level>     fail (default): exit 1 below --pass-rate. never: report only.
  Needs ANTHROPIC_API_KEY and the Anthropic SDK, which is installed only for eval:
    npx -p mcp-master-tester -p @anthropic-ai/sdk mcp-master-tester eval -- node dist/index.js

Exit codes: 0 passed, 1 findings or failures at or above --fail-on, 2 usage or connection error.

Examples:
  npx mcp-master-tester lint -- npx -y @modelcontextprotocol/server-everything
  npx mcp-master-tester lint --fail-on warn -- node dist/index.js
  npx mcp-master-tester lint --url https://example.com/mcp --header "Authorization: Bearer $TOKEN"
  npx mcp-master-tester smoke -- node dist/index.js
  npx mcp-master-tester smoke --print-args -- node dist/index.js > smoke.json
  npx mcp-master-tester smoke --args smoke.json -- node dist/index.js
  npx mcp-master-tester snapshot -- node dist/index.js
  npx mcp-master-tester diff -- node dist/index.js
  npx -p mcp-master-tester -p @anthropic-ai/sdk mcp-master-tester eval -- node dist/index.js
`;

class UsageError extends Error {}
// Stops a command with exit code 2 and this message, for problems that aren't about the arguments.
class FatalError extends Error {}

// ---------- arguments ----------

const COMMON_OPTIONS = {
  format: { type: 'string', default: 'text' },
  env: { type: 'string', multiple: true, default: [] },
  cwd: { type: 'string' },
  url: { type: 'string' },
  sse: { type: 'boolean', default: false },
  header: { type: 'string', multiple: true, default: [] },
  timeout: { type: 'string', default: '30000' },
  help: { type: 'boolean', short: 'h', default: false },
};

// Parses what lint and smoke share: where the server is, the output format and the --fail-on level.
function parseCommandArgs(argv, { options, failLevels }) {
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const command = dash === -1 ? [] : argv.slice(dash + 1);
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: own,
      allowPositionals: true,
      options: { ...COMMON_OPTIONS, 'fail-on': { type: 'string', default: failLevels[0] }, ...options },
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { help: true };
  if (positionals.length) throw new UsageError(`Unexpected argument "${positionals[0]}". Put the server command after "--".`);
  if (!failLevels.includes(values['fail-on'])) throw new UsageError(`--fail-on must be ${failLevels.slice(0, -1).join(', ')} or ${failLevels.at(-1)} (got "${values['fail-on']}")`);
  if (!['text', 'json', 'github'].includes(values.format)) throw new UsageError(`--format must be text, json or github (got "${values.format}")`);
  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError(`--timeout must be a positive number of milliseconds (got "${values.timeout}")`);
  if (values.url && command.length) throw new UsageError('Give either --url or a command after "--", not both.');
  if (!values.url && !command.length) throw new UsageError('No server given: put its command after "--", or use --url.');
  if (values.sse && !values.url) throw new UsageError('--sse needs --url.');

  const kv = (list, sep, flag) => Object.fromEntries(list.map((item) => {
    const i = item.indexOf(sep);
    if (i <= 0) throw new UsageError(`${flag} expects ${flag === '--env' ? 'KEY=VALUE' : '"Name: value"'} (got "${item}")`);
    return [item.slice(0, i).trim(), item.slice(i + 1).trim()];
  }));
  const config = values.url
    ? { transport: values.sse ? 'sse' : 'http', url: values.url, headers: kv(values.header, ':', '--header') }
    : { transport: 'stdio', command: command[0], args: command.slice(1), env: kv(values.env, '=', '--env'), cwd: values.cwd };
  return { values, config, failOn: values['fail-on'], format: values.format, timeout };
}

const transportLabel = (config) => (config.transport === 'stdio' ? 'stdio' : config.transport === 'sse' ? 'SSE' : 'Streamable HTTP');

// ---------- connection ----------

function buildTransport(config, stderrTail) {
  if (config.transport === 'stdio') {
    const t = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd, stderr: 'pipe' });
    t.stderr?.on('data', (chunk) => { stderrTail.push(chunk.toString()); if (stderrTail.length > 50) stderrTail.shift(); });
    return t;
  }
  let url;
  try { url = new URL(config.url); } catch { throw new UsageError(`Not a valid URL: ${config.url}`); }
  const requestInit = { headers: config.headers };
  return config.transport === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Connects, lists every tool, hands the open connection to `use`, and always closes it afterwards.
async function withServer(config, timeout, use) {
  const stderrTail = [];
  const client = new Client({ name: 'mcp-master-tester', version: VERSION }, { capabilities: {} });
  try {
    const transport = buildTransport(config, stderrTail);
    await withTimeout(client.connect(transport), timeout, 'Connecting');
    const tools = [];
    let cursor;
    do {
      const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), timeout, 'tools/list');
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return await use({ client, tools, server: client.getServerVersion() ?? {}, hasTools: !!client.getServerCapabilities()?.tools });
  } catch (err) {
    throw Object.assign(err, { stderr: stderrTail.join('').trim() });
  } finally {
    await client.close().catch(() => {});
  }
}

// Runs a command's work and turns the two expected failures into exit code 2 with a clear message.
async function runCommand(name, argv, spec, work) {
  let opts;
  try {
    opts = parseCommandArgs(argv, spec);
    if (opts.help) { console.log(HELP); return 0; }
    return await work(opts);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`mcp-master-tester ${name}: ${err.message}\nRun "mcp-master-tester ${name} --help" for usage.`);
      return 2;
    }
    if (err instanceof FatalError) { console.error(`mcp-master-tester ${name}: ${err.message}`); return 2; }
    const cause = err.cause?.code ?? err.cause?.message; // e.g. "fetch failed" → ECONNREFUSED
    console.error(`mcp-master-tester ${name}: could not list the server's tools: ${err.message}${cause ? ` (${cause})` : ''}`);
    if (err.stderr) console.error(`\nServer stderr (last lines):\n${err.stderr.split('\n').slice(-20).join('\n')}`);
    return 2;
  }
}

// ---------- output ----------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const header = (what, server, tools, config) =>
  `${paint('1', `mcp-master-tester ${what}`)} · ${server.name ?? 'server'}${server.version ? ` v${server.version}` : ''} · ${plural(tools, 'tool')} · ${transportLabel(config)}\n`;
const serverJson = (server) => ({ name: server.name ?? null, version: server.version ?? null });

// GitHub Actions workflow commands: findings show up as annotations on the run.
const ghEscape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const ghAnnotation = (kind, title, msg) => `::${kind} title=${ghEscape(title).replace(/:/g, '%3A').replace(/,/g, '%2C')}::${ghEscape(msg)}`;

// ---------- lint ----------

const LINT_LABEL = { error: paint('31;1', 'error'), warn: paint('33', 'warn '), info: paint('2', 'info ') };
const lintSummary = (counts) => `${plural(counts.error, 'error')}, ${plural(counts.warn, 'warning')}, ${counts.info} info`;

const TOKENIZERS = ['estimate', 'o200k'];
const TOKENIZER_INSTALL = '--tokenizer o200k needs the gpt-tokenizer package, which is not installed with MCP Master Tester. Run it with\n'
  + '  npx -p mcp-master-tester -p gpt-tokenizer mcp-master-tester lint --tokenizer o200k ...\n'
  + 'or add it to your project: npm install --save-dev gpt-tokenizer';

// gpt-tokenizer is an optional peer dependency, like the Anthropic SDK for eval: only --tokenizer o200k
// needs it. Its o200k counts match OpenAI's tiktoken; the scorecard counts with the same encoding.
async function loadO200k() {
  try {
    const { countTokens } = await import('gpt-tokenizer/encoding/o200k_base');
    return { name: 'o200k', count: countTokens };
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' && /gpt-tokenizer/.test(err.message)) throw new FatalError(TOKENIZER_INSTALL);
    throw err;
  }
}

const runLint = (argv) => runCommand('lint', argv, {
  failLevels: ['error', 'warn', 'info', 'never'],
  options: {
    'show-info': { type: 'boolean', default: false },
    'max-tokens': { type: 'string' },
    'max-tool-tokens': { type: 'string' },
    tokenizer: { type: 'string', default: 'estimate' },
  },
}, async ({ values, config, failOn, format, timeout }) => {
  if (!TOKENIZERS.includes(values.tokenizer)) throw new UsageError(`--tokenizer must be one of ${TOKENIZERS.join(', ')} (got "${values.tokenizer}")`);
  const budget = {};
  for (const [flag, key] of [['max-tokens', 'maxTokens'], ['max-tool-tokens', 'maxToolTokens']]) {
    if (values[flag] === undefined) continue;
    const n = Number(values[flag]);
    if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${flag} must be a whole number of tokens above 0 (got "${values[flag]}")`);
    budget[key] = n;
  }
  const tokenizer = values.tokenizer === 'o200k' ? await loadO200k() : undefined;
  const { tools, server, hasTools } = await withServer(config, timeout, (s) => s);
  const findings = lintTools(tools, {}, { ...budget, tokenizer });
  const size = toolListSize(tools, tokenizer);
  const lines = sizeLines(size);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.sev]++;
  const worst = failOn === 'never' ? -1 : SEVERITIES.indexOf(failOn);
  const failed = findings.some((f) => SEVERITIES.indexOf(f.sev) <= worst);

  if (format === 'json') {
    console.log(JSON.stringify({ server: serverJson(server), transport: config.transport, tools: tools.length, counts, failOn, passed: !failed,
      size, ...(Object.keys(budget).length ? { budget } : {}), findings }, null, 2));
  } else if (format === 'github') {
    const kind = { error: 'error', warn: 'warning', info: 'notice' };
    for (const f of findings) console.log(ghAnnotation(kind[f.sev], `MCP lint: ${f.target}`, f.msg));
    console.log(`MCP lint: ${lines.size}.${lines.params ? ` ${lines.params}.` : ''}`);
    console.log(`MCP lint: ${lintSummary(counts)}. Failing on: ${failOn}.`);
  } else {
    console.log(header('lint', server, tools.length, config));
    const showInfo = values['show-info'];
    const shown = findings.filter((f) => showInfo || f.sev !== 'info');
    const width = Math.min(40, Math.max(0, ...shown.map((f) => f.target.length)));
    for (const f of shown) console.log(`  ${LINT_LABEL[f.sev]}  ${f.target.padEnd(width)}  ${f.msg}`);
    if (shown.length) console.log('');
    if (tools.length) {
      const budgetNote = budget.maxTokens ? `, budget ${budget.maxTokens.toLocaleString('en-US')}` : '';
      console.log(`${lines.size.replace(/ tokens \(/, ` tokens${budgetNote} (`)}`);
      for (const key of ['largest', 'params']) if (lines[key]) console.log(lines[key]);
      console.log('');
    }
    const hidden = counts.info && !showInfo ? ' (add --show-info to list the info findings)' : '';
    console.log(`${failed ? paint('31;1', '✖ failed') : paint('32;1', '✔ passed')}: ${lintSummary(counts)}${hidden}. Failing on: ${failOn}.`);
    if (!hasTools) console.log('Note: the server does not declare the "tools" capability.');
  }
  return failed ? 1 : 0;
});

// ---------- smoke ----------

const SMOKE_LABEL = { pass: paint('32', 'pass'), warn: paint('33', 'warn'), fail: paint('31;1', 'fail'), skip: paint('2', 'skip') };
const smokeSummary = (c) => `${c.fail} failed, ${plural(c.warn, 'warning')}, ${c.pass} passed, ${c.skip} skipped`;

// Up to eight names, then a count, so a server with many tools doesn't flood the log.
const someNames = (names, max = 8) => (names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', '));

// --args file: { "tool_name": { ...arguments } }
function readArgsFile(file) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { throw new UsageError(`--args: could not read ${file}: ${err.message}`); }
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(parsed)) throw new UsageError(`--args: ${file} must hold a JSON object like { "tool_name": { "param": "value" } }`);
  for (const [tool, args] of Object.entries(parsed)) if (!isObject(args)) throw new UsageError(`--args: the arguments for "${tool}" in ${file} must be a JSON object`);
  return parsed;
}

const runSmokeCommand = (argv) => runCommand('smoke', argv, {
  failLevels: ['fail', 'warn', 'skip', 'never'],
  options: {
    all: { type: 'boolean', default: false },
    tool: { type: 'string', multiple: true, default: [] },
    skip: { type: 'string', multiple: true, default: [] },
    args: { type: 'string' },
    'print-args': { type: 'boolean', default: false },
  },
}, ({ values, config, failOn, format, timeout }) => {
  const given = values.args ? readArgsFile(values.args) : {};

  return withServer(config, timeout, async ({ client, tools, server }) => {
    // A misspelt name would silently leave a tool untested, so it is an error.
    const known = new Set(tools.map((t) => t.name));
    for (const [flag, names] of [['--tool', values.tool], ['--skip', values.skip], ['--args', Object.keys(given)]]) {
      const unknown = names.filter((n) => !known.has(n));
      if (unknown.length) throw new UsageError(`${flag}: the server has no tool named ${unknown.map((n) => `"${n}"`).join(', ')}. It has: ${[...known].join(', ') || 'no tools'}.`);
    }
    const plan = planSmoke(tools, { all: values.all, only: values.tool, skip: values.skip, given });

    if (values['print-args']) {
      const toRun = plan.filter((p) => p.run);
      console.log(JSON.stringify(Object.fromEntries(toRun.map((p) => [p.tool, p.args])), null, 2));
      const madeUp = toRun.filter((p) => p.made.length).map((p) => `${p.tool} (${p.made.join(', ')})`);
      if (madeUp.length) console.error(`Made-up values to replace with real ones: ${madeUp.join('; ')}`);
      return 0;
    }

    const call = async (name, args) => {
      const started = performance.now();
      try {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout });
        return { ok: true, result, ms: performance.now() - started };
      } catch (err) {
        return { ok: false, error: err.message, code: err.code ?? null, ms: performance.now() - started };
      }
    };

    // Text output prints each line as its tool finishes, so a long run shows progress.
    const width = Math.min(40, Math.max(0, ...plan.map((p) => p.tool.length)));
    const line = (r) => `  ${SMOKE_LABEL[r.status]}  ${r.tool.padEnd(width)}  ${(r.ms === undefined ? '' : `${r.ms} ms`).padStart(9)}  ${r.msg}`.trimEnd();
    if (format === 'text') console.log(header('smoke', server, tools.length, config));
    const results = await runSmoke(plan, call, (r) => { if (format === 'text') console.log(line(r)); });

    const counts = countSmoke(results);
    const failed = smokeFailed(results, failOn);
    const ran = counts.pass + counts.warn + counts.fail;
    const untested = untestedTools(results);
    // Held back because they may change data: not marked read-only, or marked but contradicted by their name.
    const guarded = untested.filter((r) => r.guarded);
    const names = guarded.map((r) => r.tool);
    const one = guarded.length === 1;
    const unmarkedOnly = guarded.every((r) => r.msg === NOT_READ_ONLY);
    const because = unmarkedOnly
      ? `${one ? 'it isn\'t' : 'they aren\'t'} marked read-only (annotations.readOnlyHint)`
      : `${one ? 'it isn\'t' : 'they aren\'t'} clearly read-only (not marked read-only, or marked but named like a write)`;

    // A pass covers only the tools that ran. Say which ones didn't, where it can't be missed.
    const coverage = ran > 0 && guarded.length
      ? `${guarded.length} of ${plural(tools.length, 'tool')} ${one ? 'was' : 'were'} not tested because ${because}: ${someNames(names)}. `
        + `Add --all to run ${one ? 'it' : 'them'}, or ${failOn === 'skip' ? `--skip to leave ${one ? 'it' : 'them'} out on purpose` : '--fail-on skip to fail when a tool goes untested'}.`
      : '';
    const whyNothing = ran > 0 ? ''
      : tools.length === 0 ? 'The server lists no tools.'
      : !guarded.length ? 'Every tool was skipped.'
      : unmarkedOnly ? 'No tool is marked read-only (annotations.readOnlyHint). Add --all, or name tools with --tool.'
      : 'No tool is clearly read-only: each is unmarked, or marked read-only but named like a write. Add --all, or name tools with --tool.';

    if (format === 'json') {
      console.log(JSON.stringify({
        server: serverJson(server), transport: config.transport, tools: tools.length, counts, failOn, passed: !failed,
        untested: untested.map((r) => r.tool),
        results: results.map((r) => ({ tool: r.tool, status: r.status, ms: r.ms ?? null, msg: r.msg, args: r.args ?? null, argSource: r.source ?? null })),
      }, null, 2));
    } else if (format === 'github') {
      for (const r of results) {
        if (r.status === 'fail') console.log(ghAnnotation('error', `MCP smoke: ${r.tool}`, r.msg));
        if (r.status === 'warn') console.log(ghAnnotation('warning', `MCP smoke: ${r.tool}`, r.msg));
      }
      if (ran === 0) {
        if (failed) console.log(ghAnnotation('error', 'MCP smoke', `No tools were run. ${whyNothing}`));
      } else {
        if (coverage) console.log(ghAnnotation(failOn === 'skip' ? 'error' : 'warning', 'MCP smoke: untested tools', coverage));
        // With --fail-on skip, every other untested tool fails the run too, so each gets its reason.
        if (failOn === 'skip') for (const r of untested) if (!r.guarded) console.log(ghAnnotation('error', `MCP smoke: ${r.tool}`, `not tested: ${r.msg}`));
      }
      console.log(`MCP smoke: ${smokeSummary(counts)}. Failing on: ${failOn}.`);
    } else {
      const verdict = failed ? paint('31;1', '✖ failed') : paint('32;1', '✔ passed');
      if (ran === 0 && failed) console.log(`\n${verdict}: no tools were run. Failing on: ${failOn}.\n${whyNothing}`);
      else console.log(`\n${verdict}: ${smokeSummary(counts)}. Failing on: ${failOn}.${ran === 0 ? `\nNo tools were run. ${whyNothing}` : ''}`);
      if (coverage) console.log(paint('33', coverage));
      if (results.some((r) => r.status === 'warn' && r.source === 'made-up')) {
        console.log('A tool that rejects made-up arguments can\'t be checked fully. Save the arguments with --print-args, put in real values, and pass the file with --args.');
      }
    }
    return failed ? 1 : 0;
  });
});

// ---------- snapshot and diff ----------

const runSnapshot = (argv) => runCommand('snapshot', argv, {
  failLevels: ['never'],
  options: { out: { type: 'string', default: DEFAULT_LOCKFILE } },
}, async ({ values, config, timeout }) => {
  const { tools, server } = await withServer(config, timeout, (s) => s);
  const text = lockfileText(snapshotTools(tools, server));
  const file = values.out;
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (before === text) {
    console.log(`${file} is up to date: ${plural(tools.length, 'tool')} from ${server.name ?? 'the server'}.`);
  } else {
    writeFileSync(file, text);
    console.log(`${before === null ? 'Wrote' : 'Updated'} ${file}: ${plural(tools.length, 'tool')} from ${server.name ?? 'the server'}. Commit it, and run "mcp-master-tester diff" in CI.`);
  }
  return 0;
});

const DIFF_LABEL = { breaking: paint('31;1', 'breaking'), warn: paint('33', 'warn    '), info: paint('2', 'info    ') };
const diffSummary = (c) => `${c.breaking} breaking, ${plural(c.warn, 'warning')}, ${c.info} info`;

const runDiff = (argv) => runCommand('diff', argv, {
  failLevels: [...DIFF_LEVELS, 'never'],
  options: { lock: { type: 'string', default: DEFAULT_LOCKFILE } },
}, async ({ values, config, failOn, format, timeout }) => {
  const file = values.lock;
  if (!existsSync(file)) throw new UsageError(`No lockfile at ${file}. Create one with "mcp-master-tester snapshot" and the same server options, and commit it.`);
  let lock;
  try { lock = parseLockfile(readFileSync(file, 'utf8')); } catch (err) { throw new UsageError(`${file} is ${err.message}`); }
  const { tools, server } = await withServer(config, timeout, (s) => s);
  const changes = diffTools(lock, snapshotTools(tools, server));
  const counts = { breaking: 0, warn: 0, info: 0 };
  for (const c of changes) counts[c.sev]++;
  const worst = failOn === 'never' ? -1 : DIFF_LEVELS.indexOf(failOn);
  const failed = changes.some((c) => DIFF_LEVELS.indexOf(c.sev) <= worst);
  const before = Object.keys(lock.tools).length;

  if (format === 'json') {
    console.log(JSON.stringify({ server: serverJson(server), transport: config.transport, lockfile: file, tools: { before, after: tools.length }, counts, failOn, passed: !failed, changes }, null, 2));
  } else if (format === 'github') {
    const kind = { breaking: 'error', warn: 'warning', info: 'notice' };
    for (const c of changes) console.log(ghAnnotation(kind[c.sev], `MCP diff: ${c.target}`, c.msg));
    console.log(`MCP diff: ${changes.length ? diffSummary(counts) : 'no changes'}. Failing on: ${failOn}.`);
  } else {
    console.log(header('diff', server, tools.length, config));
    console.log(`Compared with ${file} (${plural(before, 'tool')}).\n`);
    const width = Math.min(40, Math.max(0, ...changes.map((c) => c.target.length)));
    for (const c of changes) console.log(`  ${DIFF_LABEL[c.sev]}  ${c.target.padEnd(width)}  ${c.msg}`);
    if (changes.length) console.log('');
    if (!changes.length) console.log(`${paint('32;1', '✔ passed')}: no changes since ${file}.`);
    else console.log(`${failed ? paint('31;1', '✖ failed') : paint('32;1', '✔ passed')}: ${diffSummary(counts)}. Failing on: ${failOn}.`);
    if (changes.length) console.log(`If these changes are intended, update the lockfile with "mcp-master-tester snapshot" and commit it.`);
  }
  return failed ? 1 : 0;
});

// ---------- eval ----------

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EVAL_LABEL = { pass: paint('32', 'pass '), fail: paint('31;1', 'fail '), error: paint('31', 'error') };
const evalSummary = (c, rate) => `${c.pass} of ${c.pass + c.fail + c.error} passed (${rate}%), ${c.fail} failed, ${plural(c.error, 'error')}`;
const SDK_INSTALL = 'eval needs the Anthropic SDK, which is not installed with MCP Master Tester. Run it with\n'
  + '  npx -p mcp-master-tester -p @anthropic-ai/sdk mcp-master-tester eval ...\n'
  + 'or add it to your project: npm install --save-dev @anthropic-ai/sdk';

// The SDK is an optional peer dependency: only eval needs it, so everything else stays at two dependencies.
async function loadAnthropic() {
  try {
    return (await import('@anthropic-ai/sdk')).default;
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' && /@anthropic-ai\/sdk/.test(err.message)) throw new FatalError(SDK_INSTALL);
    throw err;
  }
}

// Runs `work` over `items` with at most `limit` at a time; results keep the items' order.
async function pool(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await work(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const runEval = (argv) => runCommand('eval', argv, {
  failLevels: ['fail', 'never'],
  options: {
    cases: { type: 'string', default: DEFAULT_CASES },
    model: { type: 'string' },
    effort: { type: 'string' },
    'pass-rate': { type: 'string', default: '100' },
  },
}, async ({ values, config, failOn, format, timeout }) => {
  const file = values.cases;
  if (!existsSync(file)) throw new UsageError(`No cases file at ${file}. Create one: [{ "prompt": "Weather in Paris?", "expect": "get_weather" }], and pass it with --cases.`);
  let suite;
  try { suite = parseCases(readFileSync(file, 'utf8')); } catch (err) { throw new UsageError(`${file}: ${err.message}`); }
  const required = Number(values['pass-rate']);
  if (!Number.isFinite(required) || required < 0 || required > 100) throw new UsageError(`--pass-rate must be a percentage from 0 to 100 (got "${values['pass-rate']}")`);
  if (values.effort !== undefined && !EFFORTS.includes(values.effort)) throw new UsageError(`--effort must be ${EFFORTS.join(', ')} (got "${values.effort}")`);
  const model = values.model ?? suite.model ?? DEFAULT_MODEL;
  const Anthropic = await loadAnthropic();
  const anthropic = new Anthropic();
  const { cases } = suite;

  return withServer(config, timeout, async ({ tools, server }) => {
    const unknown = unknownTools(cases, tools);
    if (unknown.length) throw new UsageError(`${file}: the server has no tool named ${unknown.map((n) => `"${n}"`).join(', ')}. It has: ${tools.map((t) => t.name).join(', ') || 'no tools'}.`);
    if (!tools.length) throw new UsageError('The server lists no tools, so there is nothing to choose from.');
    const api = toApiTools(tools);
    const tokens = { input: 0, output: 0 };
    let fatal = null;

    // One request per case. Only the request is sent: no tool runs, on the server or anywhere else.
    const ask = async (c) => {
      if (fatal) return { status: 'error', chose: null, args: null, msg: 'not run' };
      try {
        const response = await anthropic.messages.create({
          model,
          max_tokens: 16000,
          system: EVAL_SYSTEM,
          tools: api.tools,
          // "auto": the model may also answer without a tool, which is what null cases test.
          tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          messages: [{ role: 'user', content: c.prompt }],
          ...(values.effort ? { output_config: { effort: values.effort } } : {}),
        });
        tokens.input += response.usage?.input_tokens ?? 0;
        tokens.output += response.usage?.output_tokens ?? 0;
        return judgeCase(c, response, api.fromApi);
      } catch (err) {
        // A bad key or model fails every case the same way, so stop and say it once.
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
          fatal = `the Anthropic API refused the key (${err.status}). Set ANTHROPIC_API_KEY to a valid key.`;
        } else if (err instanceof Anthropic.NotFoundError) {
          fatal = `model "${model}" was not found (404). Check --model or "model" in ${file}.`;
        } else if (err instanceof Anthropic.BadRequestError) {
          return { status: 'error', chose: null, args: null, msg: `the API rejected the request: ${err.message}` };
        } else if (err instanceof Anthropic.APIConnectionError) {
          return { status: 'error', chose: null, args: null, msg: `could not reach the Anthropic API: ${err.message}` };
        } else if (err instanceof Anthropic.APIError) {
          return { status: 'error', chose: null, args: null, msg: `Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}` };
        } else {
          // Not an API answer: usually no credentials at all, which fails every case the same way.
          const hint = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? '' : ' Set ANTHROPIC_API_KEY to an Anthropic API key.';
          fatal = `could not call the Anthropic API: ${err.message.replace(/\.?$/, ".")}${hint}`;
        }
        return { status: 'error', chose: null, args: null, msg: fatal };
      }
    };

    if (format === 'text') {
      console.log(header('eval', server, tools.length, config));
      console.log(`Model: ${model}${values.effort ? ` (effort ${values.effort})` : ''} · ${plural(cases.length, 'case')} from ${file}\n`);
    }
    const results = await pool(cases, 4, ask);
    if (fatal) throw new FatalError(fatal);

    const counts = countEval(results);
    const rate = passRate(counts);
    const failed = failOn !== 'never' && rate < required;
    const mixed = mixUps(cases, results);

    if (format === 'json') {
      console.log(JSON.stringify({
        server: serverJson(server), transport: config.transport, model, effort: values.effort ?? null, casesFile: file,
        tools: tools.length, counts, passRate: rate, required, failOn, passed: !failed, tokens, mixUps: mixed,
        results: results.map((r, i) => ({ name: cases[i].name, prompt: cases[i].prompt, expect: cases[i].expect, status: r.status, chose: r.chose, args: r.args, msg: r.msg })),
      }, null, 2));
    } else if (format === 'github') {
      results.forEach((r, i) => {
        if (r.status !== 'pass') console.log(ghAnnotation('error', `MCP eval: ${caseLabel(cases[i])}`, `"${shortText(cases[i].prompt)}": ${r.msg}`));
      });
      for (const m of mixed) console.log(ghAnnotation('warning', 'MCP eval: mixed up', `${m.pair} (${plural(m.n, 'case')})`));
      console.log(`MCP eval: ${evalSummary(counts, rate)}; needs ${required}%. Model: ${model}. Failing on: ${failOn}.`);
    } else {
      const width = Math.min(30, Math.max(0, ...cases.map((c) => caseLabel(c).length)));
      results.forEach((r, i) => {
        const c = cases[i];
        console.log(`  ${EVAL_LABEL[r.status]}  ${caseLabel(c).padEnd(width)}  ${shortText(c.prompt, 60)}`);
        if (r.status !== 'pass') console.log(`         ${' '.repeat(width)}  ${paint('2', '→')} ${r.msg}`);
      });
      console.log(`\n${failed ? paint('31;1', '✖ failed') : paint('32;1', '✔ passed')}: ${evalSummary(counts, rate)}; needs ${required}%. Failing on: ${failOn}.`);
      if (mixed.length) console.log(`Mixed up: ${mixed.map((m) => `${m.pair}${m.n > 1 ? ` (${m.n})` : ''}`).join(', ')}. Clearer descriptions usually fix this.`);
      console.log(paint('2', `Tokens: ${tokens.input.toLocaleString('en-US')} in, ${tokens.output.toLocaleString('en-US')} out.`));
    }
    return failed ? 1 : 0;
  });
});

// ---------- dispatch ----------

const COMMANDS = { lint: runLint, smoke: runSmokeCommand, snapshot: runSnapshot, diff: runDiff, eval: runEval };
const [sub, ...rest] = process.argv.slice(2);
if (Object.hasOwn(COMMANDS, sub)) {
  // Exit explicitly (a remote transport can keep the event loop alive), but only after stdout has
  // flushed: on macOS, pipes are asynchronous, and piped output (CI logs, | jq) could be cut short.
  const code = await COMMANDS[sub](rest);
  const flushed = (stream) => new Promise((resolve) => stream.write('', resolve));
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
} else if (sub === '--version' || sub === '-v') {
  console.log(VERSION);
} else if (sub === '--help' || sub === '-h' || sub === 'help') {
  console.log(HELP);
} else if (sub === undefined) {
  await import('./server.js');
} else {
  console.error(`Unknown command "${sub}".\n\n${HELP}`);
  process.exitCode = 2;
}
