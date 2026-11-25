// Monthly scorecard, step 1 of 3: choose the servers. Reads the official MCP Registry and public
// download counts; runs nothing. Writes the plan that scan.mjs runs and build.mjs reports.
//
//   node scorecard/select.mjs <out.json> [--top N]
//
// Download counts, last 30 days:
//   npm, unscoped packages  api.npmjs.org batch lookups (exact)
//   npm, scoped packages    the npm search API, which reports monthly downloads; npm doesn't allow batch
//                           lookups of scoped packages and throttles one-by-one lookups after a few dozen
//   PyPI                    the public PyPI download dataset on ClickHouse (one query)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { activeServers, packageCandidates, pickTop, planServers, registryStats, pypiName, TOP_N } from './lib.mjs';

const UA = { 'user-agent': 'mcp-master-tester-scorecard (+https://github.com/simplymanas/mcp-master-tester)' };
const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const NPM_SEARCH_DEPTH = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with retries: waits longer after each 429 or server error, up to about four minutes in all.
async function getJson(url, init = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { ...init, headers: { ...UA, ...init.headers } }).catch((e) => ({ ok: false, status: 0, error: e }));
    if (r.ok) return r.json();
    if (r.status === 404) return null;
    if (attempt >= 6 || (r.status && r.status < 500 && r.status !== 429)) throw new Error(`${url.split('?')[0]}: HTTP ${r.status || r.error?.message}`);
    await sleep(2000 * 2 ** attempt);
  }
}

async function readRegistry() {
  const all = [];
  let cursor;
  do {
    const u = new URL(REGISTRY);
    u.searchParams.set('limit', '100');
    u.searchParams.set('version', 'latest');
    if (cursor) u.searchParams.set('cursor', cursor);
    const page = await getJson(u.href);
    all.push(...(page?.servers ?? []));
    cursor = page?.metadata?.nextCursor;
  } while (cursor);
  return all;
}

async function npmDownloads(candidates) {
  const out = new Map();
  const npm = [...candidates.values()].filter((c) => c.type === 'npm');
  const unscoped = npm.filter((c) => !c.identifier.startsWith('@'));
  for (let i = 0; i < unscoped.length; i += 128) {
    const batch = unscoped.slice(i, i + 128);
    const j = await getJson(`https://api.npmjs.org/downloads/point/last-month/${batch.map((c) => encodeURIComponent(c.identifier)).join(',')}`);
    for (const c of batch) {
      const d = batch.length === 1 ? j?.downloads : j?.[c.identifier]?.downloads;
      if (Number.isFinite(d)) out.set(c.key, d);
    }
    await sleep(1000);
  }
  const scoped = new Map(npm.filter((c) => c.identifier.startsWith('@')).map((c) => [c.identifier, c.key]));
  for (let from = 0; from < NPM_SEARCH_DEPTH; from += 250) {
    const j = await getJson(`https://registry.npmjs.org/-/v1/search?text=mcp&size=250&from=${from}&popularity=1.0&quality=0&maintenance=0`);
    for (const o of j?.objects ?? []) {
      const key = scoped.get(o.package?.name);
      if (key && Number.isFinite(o.downloads?.monthly)) out.set(key, o.downloads.monthly);
    }
    if ((j?.objects ?? []).length < 250) break;
    await sleep(3000);
  }
  return out;
}

async function pypiDownloads(candidates) {
  const out = new Map();
  const pypi = [...candidates.values()].filter((c) => c.type === 'pypi');
  const byName = new Map(pypi.map((c) => [pypiName(c.identifier), c.key]));
  for (let i = 0; i < pypi.length; i += 2000) {
    const names = [...byName.keys()].slice(i, i + 2000).filter((n) => /^[a-z0-9-]+$/.test(n)).map((n) => `'${n}'`).join(',');
    if (!names) continue;
    const sql = `SELECT project, sum(count) AS d FROM pypi.pypi_downloads_per_day WHERE date >= today() - 30 AND project IN (${names}) GROUP BY project FORMAT JSON`;
    const j = await getJson('https://sql-clickhouse.clickhouse.com/?user=demo', { method: 'POST', body: sql });
    for (const row of j?.data ?? []) if (byName.has(row.project)) out.set(byName.get(row.project), Number(row.d));
  }
  return out;
}

const outFile = process.argv[2];
if (!outFile) { console.error('usage: node scorecard/select.mjs <out.json> [--top N]'); process.exit(2); }
const topAt = process.argv.indexOf('--top');
const topN = topAt > 0 ? Number(process.argv[topAt + 1]) : TOP_N;
const here = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(readFileSync(path.join(here, 'baseline.json'), 'utf8'));

const now = new Date();
const entries = await readRegistry();
console.log(`registry: ${entries.length} latest versions`);
const candidates = packageCandidates(activeServers(entries));
console.log(`packages run over stdio: ${candidates.size}`);
const notes = [];
const downloads = new Map();
for (const [label, fn] of [['npm', npmDownloads], ['PyPI', pypiDownloads]]) {
  try {
    const d = await fn(candidates);
    for (const [k, v] of d) downloads.set(k, v);
    console.log(`${label} download counts: ${d.size}`);
  } catch (e) {
    notes.push(`${label} download counts were unavailable (${e.message}), so no ${label} package could enter the top ${topN} this month.`);
    console.log(notes.at(-1));
  }
}
const top = pickTop(candidates, downloads, topN);
const servers = planServers(top, baseline);
writeFileSync(outFile, `${JSON.stringify({
  date: now.toISOString().slice(0, 10), topN, registry: registryStats(entries, now),
  method: { npmSearchDepth: NPM_SEARCH_DEPTH, notes }, servers,
}, null, 1)}\n`);
console.log(`planned ${servers.length} servers (${servers.filter((s) => s.problem).length} can't be started unattended) -> ${outFile}`);
