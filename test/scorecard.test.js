// Tests for the monthly scorecard (scorecard/): choosing servers from the registry, starting them,
// checking what the scan returns, and the page. The end-to-end test runs scan.mjs and build.mjs against
// the fixture servers, with no container and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeServers, packageCandidates, commandFor, pickTop, planServers, registryStats, pypiName, packageId,
  checkScanResult, serverMetrics, changeSince, median,
} from '../scorecard/lib.mjs';
import { reasonFor, buildScorecard } from '../scorecard/build.mjs';
import { renderPage, REASONS } from '../scorecard/page.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OFFICIAL = 'io.modelcontextprotocol.registry/official';
const entry = (name, server = {}, meta = {}) => ({
  server: { name, version: '1.0.0', ...server },
  _meta: { [OFFICIAL]: { status: 'active', isLatest: true, publishedAt: '2026-11-20T00:00:00Z', ...meta } },
});
const npmPkg = (identifier, extra = {}) => ({ registryType: 'npm', identifier, version: '1.2.3', transport: { type: 'stdio' }, ...extra });

test('activeServers keeps the latest active version of each server', () => {
  const list = [entry('a/one'), entry('a/two', {}, { status: 'deprecated' }), entry('a/three', {}, { isLatest: false }), { server: {} }];
  assert.deepEqual(activeServers(list).map((e) => e.server.name), ['a/one']);
});

test('packageCandidates: npm and PyPI stdio packages, each once, PyPI names normalised', () => {
  const c = packageCandidates([
    entry('b/second', { packages: [npmPkg('shared-mcp')] }),
    entry('a/first', { packages: [npmPkg('shared-mcp'), { registryType: 'pypi', identifier: 'My_Server.MCP', version: '2.0', transport: { type: 'stdio' } }] }),
    entry('c/docker', { packages: [{ registryType: 'oci', identifier: 'ghcr.io/x/y', transport: { type: 'stdio' } }] }),
    entry('d/http', { packages: [npmPkg('http-only', { transport: { type: 'streamable-http' } })] }),
  ]);
  assert.deepEqual([...c.keys()], ['npm:shared-mcp', 'pypi:my-server-mcp']);
  assert.equal(c.get('npm:shared-mcp').registryName, 'a/first', 'the first by registry name keeps a shared package');
  assert.equal(pypiName('AWSLabs.aws_documentation'), 'awslabs-aws-documentation');
});

test('commandFor: the pinned package, the publisher\'s arguments and defaults, and no made-up secrets', () => {
  const base = { type: 'npm', identifier: '@acme/mcp', version: '1.2.3' };
  assert.deepEqual(commandFor({ ...base, pkg: npmPkg('@acme/mcp') }), { command: ['npx', '-y', '@acme/mcp@1.2.3'], env: {}, needs: [] });

  const full = commandFor({ ...base, pkg: npmPkg('@acme/mcp', {
    packageArguments: [{ type: 'positional', value: 'serve' }, { type: 'named', name: '--mode', default: 'stdio' }, { type: 'named', name: '--verbose' }],
    environmentVariables: [
      { name: 'ACME_REGION', default: 'eu', isRequired: true },
      { name: 'ACME_KEY', isRequired: true, isSecret: true },
      { name: 'ACME_TOKEN', default: 'abc', isSecret: true },
    ],
  }) });
  assert.deepEqual(full.command, ['npx', '-y', '@acme/mcp@1.2.3', 'serve', '--mode', 'stdio']);
  assert.deepEqual(full.env, { ACME_REGION: 'eu' }, 'a secret is never set, even from a default');
  assert.deepEqual(full.needs, ['ACME_KEY']);

  assert.match(commandFor({ ...base, pkg: npmPkg('@acme/mcp', { packageArguments: [{ type: 'positional', isRequired: true, valueHint: 'directory' }] }) }).problem, /needs directory/);
  assert.match(commandFor({ ...base, pkg: npmPkg('@acme/mcp', { packageArguments: [{ type: 'named', name: '--root', value: '{root_dir}' }] }) }).problem, /needs --root/);

  const py = commandFor({ type: 'pypi', identifier: 'acme-mcp', version: '0.4', pkg: { runtimeHint: 'uvx', runtimeArguments: [{ type: 'named', name: '--from', value: 'acme-mcp==0.4' }, { type: 'positional', value: 'acme' }] } });
  assert.deepEqual(py.command, ['uvx', '--from', 'acme-mcp==0.4', 'acme'], 'runtime arguments that name the package replace the default spec');
  assert.deepEqual(commandFor({ type: 'pypi', identifier: 'acme-mcp', version: null, pkg: {} }).command, ['uvx', 'acme-mcp']);
});

test('pickTop and planServers: most downloaded first, the survey servers kept and merged', () => {
  const candidates = packageCandidates([
    entry('x/low', { title: 'Low', packages: [npmPkg('low-mcp')] }),
    entry('x/high', { title: 'High', packages: [npmPkg('high-mcp')] }),
    entry('x/none', { packages: [npmPkg('none-mcp')] }),
    entry('ms/playwright', { packages: [npmPkg('@playwright/mcp')] }),
  ]);
  const downloads = new Map([['npm:low-mcp', 10], ['npm:high-mcp', 500], ['npm:@playwright/mcp', 9000]]);
  const top = pickTop(candidates, downloads, 2);
  assert.deepEqual(top.map((c) => c.identifier), ['@playwright/mcp', 'high-mcp']);

  const baseline = [
    { id: 'playwright', name: 'Playwright MCP', by: 'Microsoft', package: { type: 'npm', identifier: '@playwright/mcp' }, command: ['npx', '-y', '@playwright/mcp', '--headless'] },
    { id: 'deepwiki', name: 'DeepWiki', by: 'Cognition', url: 'https://mcp.deepwiki.com/mcp' },
  ];
  const plan = planServers(top, baseline);
  assert.deepEqual(plan.map((s) => [s.id, s.source, s.rank]), [['playwright', 'both', 1], ['npm-high-mcp', 'top', 2], ['deepwiki', 'baseline', null]]);
  assert.deepEqual(plan[0].command, ['npx', '-y', '@playwright/mcp', '--headless'], 'a survey server keeps its own command');
  assert.deepEqual(plan[1].command, ['npx', '-y', 'high-mcp@1.2.3']);
  assert.equal(plan[1].name, 'High');
  assert.equal(packageId('pypi', 'Awslabs.AWS_docs'), 'pypi-awslabs-aws-docs');
});

test('registryStats describes the registry from its listing alone', () => {
  const s = registryStats([
    entry('io.github.bulk/a', { remotes: [{ url: 'https://a' }] }),
    entry('io.github.bulk/b', { remotes: [{ url: 'https://b' }], packages: [npmPkg('b')] }),
    entry('com.acme/c', { packages: [npmPkg('c'), { registryType: 'pypi', identifier: 'c' }] }, { publishedAt: '2026-01-01T00:00:00Z' }),
    entry('old/d', {}, { status: 'deprecated' }),
  ], new Date('2026-12-01T00:00:00Z'));
  assert.deepEqual(s, { servers: 3, deprecated: 1, publishedLast30Days: 2, remoteOnly: 1, packageOnly: 1, both: 1,
    packageTypes: { npm: 2, pypi: 1 }, publishers: 2, top10PublishersServers: 3 });
});

test('checkScanResult trusts nothing the scan wrote', () => {
  const tools = [{ name: 'ping', inputSchema: { type: 'object' } }];
  assert.equal(checkScanResult({ id: 'other', ok: true, tools }, 'mine'), null, 'a result for another server');
  assert.equal(checkScanResult({ id: 'mine', ok: true, tools: 'lots' }, 'mine'), null);
  assert.equal(checkScanResult({ id: 'mine', ok: true, tools: [{ name: 'x'.repeat(300) }] }, 'mine'), null);
  assert.equal(checkScanResult({ id: 'mine', ok: true, tools: Array(2001).fill({ name: 'a' }) }, 'mine'), null);
  const ok = checkScanResult({ id: 'mine', ok: true, tools, server: { name: 'n'.repeat(500), version: 7 } }, 'mine');
  assert.equal(ok.server.name.length, 200);
  assert.equal(ok.server.version, null);
  assert.deepEqual(checkScanResult({ id: 'mine', ok: false, error: 'e'.repeat(999) }, 'mine').error.length, 200);
});

test('serverMetrics: the first survey\'s measures, plus what changed since last time', () => {
  const tools = [
    { name: 'read_doc', description: 'Read one document by its id.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Document id' }, raw: { type: 'boolean' } } }, annotations: { readOnlyHint: true } },
    { name: 'delete_doc', description: 'Delete a document for good.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { destructiveHint: true }, outputSchema: { type: 'object' } },
    { name: 'bad', inputSchema: { type: 'string' } },
  ];
  const m = serverMetrics(tools);
  assert.equal(m.tools, 3);
  assert.equal(m.tokens, Math.round(tools.reduce((k, t) => k + JSON.stringify(t).length, 0) / 4));
  assert.equal(m.largest.name, 'read_doc');
  assert.deepEqual([m.labelled, m.readOnly, m.destructive, m.noDescription, m.params, m.paramsNoDescription, m.outputSchemas], [2, 1, 1, 1, 3, 2, 1]);
  assert.equal(m.lint.error, 1, 'the input schema that is not an object');
  assert.deepEqual(m.toolNames, ['bad', 'delete_doc', 'read_doc']);
  assert.equal(serverMetrics([...tools].reverse()).hash, m.hash, 'the same tools in another order are not a change');
  assert.notEqual(serverMetrics([{ ...tools[0], description: 'Read a document.' }, ...tools.slice(1)]).hash, m.hash);

  const after = serverMetrics([tools[0], { name: 'search_docs', description: 'Search documents by text.', inputSchema: { type: 'object' } }]);
  const c = changeSince({ metrics: m }, { metrics: after });
  assert.deepEqual([c.added, c.removed, c.changed], [['search_docs'], ['bad', 'delete_doc'], true]);
  assert.equal(c.tokens, after.tokens - m.tokens);
  assert.equal(changeSince(null, { metrics: after }), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 10]), 3);
});

test('reasonFor turns error text into a fixed reason, so none of it reaches the page', () => {
  assert.equal(reasonFor('no answer within 180 s'), 'timeout');
  assert.equal(reasonFor('FIRECRAWL_API_KEY environment variable is required'), 'key');
  assert.equal(reasonFor('MCP error -32000: Connection closed'), 'exited');
  assert.equal(reasonFor('fetch failed'), 'refused');
  assert.equal(reasonFor('something odd'), 'error');
});

const planFor = (servers) => ({ date: '2026-12-01', topN: 100, registry: registryStats([entry('a/b')]), method: { npmSearchDepth: 5000, notes: [] }, servers });

test('the page escapes what servers and the registry say, and shows no error text', () => {
  const hostile = '<script>alert(1)</script>';
  const plan = planFor([
    { id: 'evil', name: hostile, by: hostile, rank: 1, downloads: 5, source: 'top', package: { type: 'npm', identifier: `x${hostile}`, version: '1' }, command: ['x'], env: {}, needs: [] },
    { id: 'down', name: 'Down', by: 'd', rank: 2, downloads: 4, source: 'top', package: { type: 'npm', identifier: 'down', version: '1' }, command: ['x'], env: {}, needs: ['DOWN_API_KEY', 'bad name!'] },
  ]);
  const scan = mkdtempSync(path.join(os.tmpdir(), 'mcpt-sc-'));
  writeFileSync(path.join(scan, 'evil.json'), JSON.stringify({ id: 'evil', ok: true, server: { name: hostile, version: hostile }, tools: [{ name: hostile, description: hostile, inputSchema: { type: 'object' } }] }));
  writeFileSync(path.join(scan, 'down.json'), JSON.stringify({ id: 'down', ok: false, error: `401 ${hostile} visit evil.example` }));
  const html = renderPage(buildScorecard(plan, scan, null, '9.9.9'));
  rmSync(scan, { recursive: true, force: true });
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /evil\.example/, 'error text never appears');
  assert.match(html, /<strong>Down<\/strong>.*needs DOWN_API_KEY/);
  assert.doesNotMatch(html, /bad name!/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  const loaded = [...html.matchAll(/<(?:script|link|img|iframe)\b(?![^>]*rel="canonical")[^>]*?\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(loaded.includes('site.css'));
  assert.deepEqual(loaded.filter((u) => /^(?:[a-z]+:)?\/\//i.test(u)), [], 'the page loads nothing from other hosts');
  assert.ok(Object.values(REASONS).every((r) => !/[<>]/.test(r)));
});

test('baseline.json: the first survey\'s servers, each with a command or a URL', () => {
  const baseline = JSON.parse(readFileSync(path.join(root, 'scorecard/baseline.json'), 'utf8'));
  assert.equal(new Set(baseline.map((b) => b.id)).size, baseline.length, 'ids are unique');
  for (const b of baseline) {
    assert.ok(b.name && b.by, b.id);
    assert.ok(b.url ? /^https:\/\//.test(b.url) : ['npx', 'uvx'].includes(b.command?.[0]), b.id);
    if (b.command) assert.ok(b.package?.identifier && b.command.includes(b.package.identifier), `${b.id} names its package`);
  }
});

test('the workflow keeps the job that runs servers away from write access and caches', () => {
  const yml = readFileSync(path.join(root, '.github/workflows/scorecard.yml'), 'utf8');
  assert.match(yml, /^permissions: \{\}$/m, 'nothing by default');
  const job = (name) => yml.split(/\n {2}(?=[a-z]+:\n)/).find((j) => j.startsWith(`${name}:`));
  const scan = job('scan');
  assert.match(scan, /permissions:\n\s+contents: read\n/);
  assert.doesNotMatch(scan, /write|cache:|secrets\./);
  assert.match(scan, /persist-credentials: false/);
  assert.match(scan, /docker run/, 'servers run inside the container');
  assert.doesNotMatch(job('publish'), /scan\.mjs|docker/, 'the job that can write never runs a server');
  assert.match(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'), /^\s+workflow_dispatch:/m, 'CI can be started on the scorecard pull request');
  const reminder = readFileSync(path.join(root, '.github/workflows/scorecard-reminder.yml'), 'utf8');
  assert.match(reminder, /cron: '0 9 28 \* \*'/, 'the reminder comes before the 1st');
  assert.deepEqual([...reminder.matchAll(/^\s+(\w[\w-]*): (?:write|read)$/gm)].map((m) => m[1]), ['issues'], 'it can only open issues');
});

const node = (args, opts = {}) => new Promise((resolve) => {
  execFile(process.execPath, args, { cwd: root, timeout: 120000, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
});

test('end to end: scan the fixture servers, then build the data and the page', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'mcpt-sc-e2e-'));
  try {
    const fixture = (f, ...a) => ['node', path.join(root, 'test/fixtures', f), ...a];
    const plan = planFor([
      { id: 'smoke', name: 'Smoke fixture', by: 'tests', rank: 1, downloads: 100, source: 'top', package: { type: 'npm', identifier: 'smoke', version: '1' }, command: fixture('smoke-server.js'), env: {}, needs: [] },
      { id: 'lint', name: 'Lint fixture', by: 'tests', rank: 2, downloads: 50, source: 'top', package: { type: 'npm', identifier: 'lint', version: '1' }, command: fixture('lint-server.js'), env: {}, needs: [] },
      { id: 'hangs', name: 'Hangs', by: 'tests', rank: 3, downloads: 10, source: 'top', package: null, command: ['node', '-e', 'setInterval(() => {}, 1000)'], env: {}, needs: [] },
      { id: 'missing', name: 'Missing', by: 'tests', rank: 4, downloads: 5, source: 'top', package: null, command: ['no-such-command-mcpt'], env: {}, needs: [] },
      { id: 'setup', name: 'Needs setup', by: 'tests', rank: 5, downloads: 1, source: 'top', package: null, problem: 'needs directory' },
    ]);
    const planFile = path.join(tmp, 'plan.json');
    writeFileSync(planFile, JSON.stringify(plan));
    const scanDir = path.join(tmp, 'scan');
    const scan = await node(['scorecard/scan.mjs', planFile, scanDir, '--timeout', '8000'], { env: { ...process.env, SCORECARD_WORK: path.join(tmp, 'work') } });
    assert.equal(scan.code, 0, scan.stdout + scan.stderr);
    assert.match(scan.stdout, /listed smoke +4 tools/);
    assert.match(scan.stdout, /failed hangs +no answer within 8 s/);
    assert.ok(!existsSync(path.join(scanDir, 'setup.json')), 'a server that needs setup is not started');

    // Last month's scorecard: the smoke fixture had one tool fewer.
    const docs = path.join(tmp, 'docs');
    mkdirSync(path.join(docs, 'scorecard'), { recursive: true });
    const smokeTools = JSON.parse(readFileSync(path.join(scanDir, 'smoke.json'), 'utf8')).tools;
    writeFileSync(path.join(docs, 'scorecard', '2026-11-01.json'), JSON.stringify({ date: '2026-11-01', servers: [{ id: 'smoke', rank: 1, metrics: serverMetrics(smokeTools.slice(0, 3)) }] }));

    const build = await node(['scorecard/build.mjs', planFile, scanDir, docs]);
    assert.equal(build.code, 0, build.stdout + build.stderr);
    assert.match(build.stdout, /scorecard 2026-12-01: 2 of 5 servers measured/);
    const data = JSON.parse(readFileSync(path.join(docs, 'scorecard', '2026-12-01.json'), 'utf8'));
    assert.equal(data.previous, '2026-11-01');
    const by = Object.fromEntries(data.servers.map((r) => [r.id, r]));
    assert.deepEqual(by.smoke.change.added, ['delete_user']);
    assert.ok(by.lint.metrics.lint.error > 0);
    assert.deepEqual([by.hangs.reason, by.missing.reason, by.setup.reason], ['timeout', 'exited', 'setup']);
    const html = readFileSync(path.join(docs, 'scorecard.html'), 'utf8');
    assert.match(html, /Compared with the scorecard of 1 November 2026: 1 server changed its tool list, adding 1 tool/);
    assert.match(html, /<strong>Hangs<\/strong>.*no answer within 3 minutes/);
    assert.match(html, /<strong>Needs setup<\/strong>.*needs a setting/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
