#!/usr/bin/env node
// MCP Master Tester — command line entry point.
//   mcp-master-tester                 start the web UI (server.js)
//   mcp-master-tester lint [...]      lint a server's tool definitions and exit non-zero on findings (for CI)
// Author: @simplymanas

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { lintTools } from './public/lint.js';

const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const SEVERITIES = ['error', 'warn', 'info'];

const HELP = `MCP Master Tester ${VERSION}

Usage:
  mcp-master-tester                          Start the web UI (http://127.0.0.1:6280, or set PORT)
  mcp-master-tester lint [options] -- <command> [args...]
                                             Lint a stdio server's tools
  mcp-master-tester lint [options] --url <url>
                                             Lint a Streamable HTTP server's tools (add --sse for SSE)

Lint options:
  --fail-on <level>     Exit 1 when there are findings at this level or worse:
                        error (default), warn, info, or never
  --format <format>     text (default), json, or github (GitHub Actions annotations)
  --show-info           Also list info findings in text output (they are counted either way)
  --env KEY=VALUE       Environment variable for a stdio server (repeatable)
  --cwd <dir>           Working directory for a stdio server
  --url <url>           Server URL for Streamable HTTP or SSE
  --sse                 Use the legacy SSE transport with --url
  --header "Name: value"  HTTP header (repeatable), e.g. --header "Authorization: Bearer $TOKEN"
  --timeout <ms>        Give up connecting and listing tools after this long (default 30000)

Exit codes: 0 passed, 1 findings at or above --fail-on, 2 usage or connection error.

Examples:
  npx mcp-master-tester lint -- npx -y @modelcontextprotocol/server-everything
  npx mcp-master-tester lint --fail-on warn -- node dist/index.js
  npx mcp-master-tester lint --url https://example.com/mcp --header "Authorization: Bearer $TOKEN"
`;

class UsageError extends Error {}

function parseLintArgs(argv) {
  const dash = argv.indexOf('--');
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const command = dash === -1 ? [] : argv.slice(dash + 1);
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: own,
      allowPositionals: true,
      options: {
        'fail-on': { type: 'string', default: 'error' },
        format: { type: 'string', default: 'text' },
        'show-info': { type: 'boolean', default: false },
        env: { type: 'string', multiple: true, default: [] },
        cwd: { type: 'string' },
        url: { type: 'string' },
        sse: { type: 'boolean', default: false },
        header: { type: 'string', multiple: true, default: [] },
        timeout: { type: 'string', default: '30000' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { help: true };
  if (positionals.length) throw new UsageError(`Unexpected argument "${positionals[0]}". Put the server command after "--".`);
  if (!['error', 'warn', 'info', 'never'].includes(values['fail-on'])) throw new UsageError(`--fail-on must be error, warn, info or never (got "${values['fail-on']}")`);
  if (!['text', 'json', 'github'].includes(values.format)) throw new UsageError(`--format must be text, json or github (got "${values.format}")`);
  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new UsageError(`--timeout must be a positive number of milliseconds (got "${values.timeout}")`);
  if (values.url && command.length) throw new UsageError('Give either --url or a command after "--", not both.');
  if (!values.url && !command.length) throw new UsageError('Nothing to lint: give a server command after "--", or --url.');
  if (values.sse && !values.url) throw new UsageError('--sse needs --url.');

  const kv = (list, sep, flag) => Object.fromEntries(list.map((item) => {
    const i = item.indexOf(sep);
    if (i <= 0) throw new UsageError(`${flag} expects ${flag === '--env' ? 'KEY=VALUE' : '"Name: value"'} (got "${item}")`);
    return [item.slice(0, i).trim(), item.slice(i + 1).trim()];
  }));
  const config = values.url
    ? { transport: values.sse ? 'sse' : 'http', url: values.url, headers: kv(values.header, ':', '--header') }
    : { transport: 'stdio', command: command[0], args: command.slice(1), env: kv(values.env, '=', '--env'), cwd: values.cwd };
  return { config, failOn: values['fail-on'], format: values.format, showInfo: values['show-info'], timeout };
}

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

async function fetchTools(config, timeout) {
  const stderrTail = [];
  const client = new Client({ name: 'mcp-master-tester', version: VERSION }, { capabilities: {} });
  const transport = buildTransport(config, stderrTail);
  try {
    await withTimeout(client.connect(transport), timeout, 'Connecting');
    const tools = [];
    let cursor;
    do {
      const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), timeout, 'tools/list');
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return { tools, server: client.getServerVersion() ?? {}, hasTools: !!client.getServerCapabilities()?.tools };
  } catch (err) {
    const stderr = stderrTail.join('').trim();
    throw Object.assign(err, { stderr });
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------- output ----------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const LABEL = { error: paint('31;1', 'error'), warn: paint('33', 'warn '), info: paint('2', 'info ') };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function summary(counts) {
  return `${plural(counts.error, 'error')}, ${plural(counts.warn, 'warning')}, ${counts.info} info`;
}

function printText({ findings, counts, server, tools, failOn, failed, showInfo, transport }) {
  console.log(`${paint('1', 'mcp-master-tester lint')} · ${server.name ?? 'server'}${server.version ? ` v${server.version}` : ''} · ${plural(tools, 'tool')} · ${transport}\n`);
  const shown = findings.filter((f) => showInfo || f.sev !== 'info');
  const width = Math.min(40, Math.max(0, ...shown.map((f) => f.target.length)));
  for (const f of shown) console.log(`  ${LABEL[f.sev]}  ${f.target.padEnd(width)}  ${f.msg}`);
  if (shown.length) console.log('');
  const hidden = counts.info && !showInfo ? ` (add --show-info to list the info findings)` : '';
  const verdict = failed ? paint('31;1', '✖ failed') : paint('32;1', '✔ passed');
  console.log(`${verdict}: ${summary(counts)}${hidden}. Failing on: ${failOn}.`);
}

// GitHub Actions workflow commands: findings show up as annotations on the run.
function printGithub({ findings, counts, failOn }) {
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const cmd = { error: 'error', warn: 'warning', info: 'notice' };
  for (const f of findings) console.log(`::${cmd[f.sev]} title=${escProp(`MCP lint: ${f.target}`)}::${esc(f.msg)}`);
  console.log(`MCP lint: ${summary(counts)}. Failing on: ${failOn}.`);
}

async function runLint(argv) {
  let opts;
  try {
    opts = parseLintArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`mcp-master-tester lint: ${err.message}\nRun "mcp-master-tester lint --help" for usage.`);
    return 2;
  }
  if (opts.help) { console.log(HELP); return 0; }

  let result;
  try {
    result = await fetchTools(opts.config, opts.timeout);
  } catch (err) {
    const cause = err.cause?.code ?? err.cause?.message; // e.g. "fetch failed" → ECONNREFUSED
    console.error(`mcp-master-tester lint: could not list the server's tools: ${err.message}${cause ? ` (${cause})` : ''}`);
    if (err.stderr) console.error(`\nServer stderr (last lines):\n${err.stderr.split('\n').slice(-20).join('\n')}`);
    return 2;
  }

  const findings = lintTools(result.tools);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.sev]++;
  const worst = opts.failOn === 'never' ? -1 : SEVERITIES.indexOf(opts.failOn);
  const failed = findings.some((f) => SEVERITIES.indexOf(f.sev) <= worst);
  const transport = opts.config.transport === 'stdio' ? 'stdio' : opts.config.transport === 'sse' ? 'SSE' : 'Streamable HTTP';
  const report = { findings, counts, server: result.server, tools: result.tools.length, failOn: opts.failOn, failed, showInfo: opts.showInfo, transport };

  if (opts.format === 'json') {
    console.log(JSON.stringify({
      server: { name: result.server.name ?? null, version: result.server.version ?? null },
      transport: opts.config.transport, tools: result.tools.length, counts, failOn: opts.failOn, passed: !failed, findings,
    }, null, 2));
  } else if (opts.format === 'github') {
    printGithub(report);
  } else {
    printText(report);
  }
  if (!result.hasTools && opts.format === 'text') console.log('Note: the server does not declare the "tools" capability.');
  return failed ? 1 : 0;
}

// ---------- dispatch ----------

const [sub, ...rest] = process.argv.slice(2);
if (sub === 'lint') {
  // Exit explicitly (a remote transport can keep the event loop alive), but only after stdout has
  // flushed: on macOS, pipes are asynchronous, and piped output (CI logs, | jq) could be cut short.
  const code = await runLint(rest);
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
