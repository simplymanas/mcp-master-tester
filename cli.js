#!/usr/bin/env node
// MCP Master Tester — command line entry point.
//   mcp-master-tester                 start the web UI (server.js)
//   mcp-master-tester lint [...]      check a server's tool definitions
//   mcp-master-tester smoke [...]     call each read-only tool once and check the answers
// lint and smoke exit non-zero on findings, for CI.
// Author: @simplymanas

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { lintTools } from './public/lint.js';
import { planSmoke, runSmoke, countSmoke, smokeFailed, NOT_READ_ONLY } from './public/smoke.js';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const SEVERITIES = ['error', 'warn', 'info'];

const HELP = `MCP Master Tester ${VERSION}

Usage:
  mcp-master-tester                            Start the web UI (http://127.0.0.1:6280, or set PORT)
  mcp-master-tester lint  [options] <server>   Check the server's tool definitions
  mcp-master-tester smoke [options] <server>   Call each read-only tool once and check the answers

<server> is one of:
  -- <command> [args...]   A stdio server, for example: -- node dist/index.js
  --url <url>              A Streamable HTTP server (add --sse for the legacy SSE transport)

Options for lint and smoke:
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

smoke options:
  --all                 Also run tools that aren't marked read-only. They may change data.
  --tool <name>         Run only this tool (repeatable), whether or not it is read-only
  --skip <name>         Don't run this tool (repeatable)
  --args <file>         JSON file with the arguments to send: { "tool_name": { "param": "value" } }
                        Tools not in the file get arguments built from their schema.
  --print-args          Print the arguments that would be sent, as JSON you can save, edit and
                        pass back with --args. Runs nothing.
  --fail-on <level>     Exit 1 on: fail (default), warn, or never

Exit codes: 0 passed, 1 findings or failures at or above --fail-on, 2 usage or connection error.

Examples:
  npx mcp-master-tester lint -- npx -y @modelcontextprotocol/server-everything
  npx mcp-master-tester lint --fail-on warn -- node dist/index.js
  npx mcp-master-tester lint --url https://example.com/mcp --header "Authorization: Bearer $TOKEN"
  npx mcp-master-tester smoke -- node dist/index.js
  npx mcp-master-tester smoke --print-args -- node dist/index.js > smoke.json
  npx mcp-master-tester smoke --args smoke.json -- node dist/index.js
`;

class UsageError extends Error {}

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

const runLint = (argv) => runCommand('lint', argv, {
  failLevels: ['error', 'warn', 'info', 'never'],
  options: { 'show-info': { type: 'boolean', default: false } },
}, async ({ values, config, failOn, format, timeout }) => {
  const { tools, server, hasTools } = await withServer(config, timeout, (s) => s);
  const findings = lintTools(tools);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.sev]++;
  const worst = failOn === 'never' ? -1 : SEVERITIES.indexOf(failOn);
  const failed = findings.some((f) => SEVERITIES.indexOf(f.sev) <= worst);

  if (format === 'json') {
    console.log(JSON.stringify({ server: serverJson(server), transport: config.transport, tools: tools.length, counts, failOn, passed: !failed, findings }, null, 2));
  } else if (format === 'github') {
    const kind = { error: 'error', warn: 'warning', info: 'notice' };
    for (const f of findings) console.log(ghAnnotation(kind[f.sev], `MCP lint: ${f.target}`, f.msg));
    console.log(`MCP lint: ${lintSummary(counts)}. Failing on: ${failOn}.`);
  } else {
    console.log(header('lint', server, tools.length, config));
    const showInfo = values['show-info'];
    const shown = findings.filter((f) => showInfo || f.sev !== 'info');
    const width = Math.min(40, Math.max(0, ...shown.map((f) => f.target.length)));
    for (const f of shown) console.log(`  ${LINT_LABEL[f.sev]}  ${f.target.padEnd(width)}  ${f.msg}`);
    if (shown.length) console.log('');
    const hidden = counts.info && !showInfo ? ' (add --show-info to list the info findings)' : '';
    console.log(`${failed ? paint('31;1', '✖ failed') : paint('32;1', '✔ passed')}: ${lintSummary(counts)}${hidden}. Failing on: ${failOn}.`);
    if (!hasTools) console.log('Note: the server does not declare the "tools" capability.');
  }
  return failed ? 1 : 0;
});

// ---------- smoke ----------

const SMOKE_LABEL = { pass: paint('32', 'pass'), warn: paint('33', 'warn'), fail: paint('31;1', 'fail'), skip: paint('2', 'skip') };
const smokeSummary = (c) => `${c.fail} failed, ${plural(c.warn, 'warning')}, ${c.pass} passed, ${c.skip} skipped`;

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
  failLevels: ['fail', 'warn', 'never'],
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
    const notReadOnly = results.filter((r) => r.status === 'skip' && r.msg === NOT_READ_ONLY).length;
    const nothingRan = ran === 0 ? `No tools were run${notReadOnly ? ': no tool is marked read-only (annotations.readOnlyHint). Add --all, or name tools with --tool' : ''}.` : '';

    if (format === 'json') {
      console.log(JSON.stringify({
        server: serverJson(server), transport: config.transport, tools: tools.length, counts, failOn, passed: !failed,
        results: results.map((r) => ({ tool: r.tool, status: r.status, ms: r.ms ?? null, msg: r.msg, args: r.args ?? null, argSource: r.source ?? null })),
      }, null, 2));
    } else if (format === 'github') {
      for (const r of results) {
        if (r.status === 'fail') console.log(ghAnnotation('error', `MCP smoke: ${r.tool}`, r.msg));
        if (r.status === 'warn') console.log(ghAnnotation('warning', `MCP smoke: ${r.tool}`, r.msg));
      }
      if (nothingRan && failed) console.log(ghAnnotation('error', 'MCP smoke', nothingRan));
      console.log(`MCP smoke: ${smokeSummary(counts)}. Failing on: ${failOn}.`);
    } else {
      console.log(`\n${failed ? paint('31;1', '✖ failed') : paint('32;1', '✔ passed')}: ${smokeSummary(counts)}. Failing on: ${failOn}.`);
      if (nothingRan) console.log(nothingRan);
      else if (notReadOnly) console.log(`${plural(notReadOnly, 'tool')} not marked read-only ${notReadOnly === 1 ? 'was' : 'were'} skipped. Add --all to run ${notReadOnly === 1 ? 'it' : 'them'} too.`);
      if (results.some((r) => r.status === 'warn' && r.source === 'made-up')) {
        console.log('A tool that rejects made-up arguments can\'t be checked fully. Save the arguments with --print-args, put in real values, and pass the file with --args.');
      }
    }
    return failed ? 1 : 0;
  });
});

// ---------- dispatch ----------

const COMMANDS = { lint: runLint, smoke: runSmokeCommand };
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
