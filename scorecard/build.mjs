// Monthly scorecard, step 3 of 3: check the scan results, measure each tool list, compare with the
// previous scorecard, and write docs/scorecard/<date>.json and docs/scorecard.html. Runs nothing from
// the servers: their output is data, checked by checkScanResult before use.
//
//   node scorecard/build.mjs <plan.json> <scan dir> <docs dir>
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { checkScanResult, serverMetrics, changeSince, median, shownTokens } from './lib.mjs';
import { renderPage } from './page.mjs';

const MAX_RESULT_BYTES = 20 * 1024 * 1024;
const VERSION_RE = /^[\w.+-]{1,40}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// Error text comes from other people's code, so the page never shows it; it shows one of these reasons.
export function reasonFor(error = '') {
  if (/no answer within/.test(error)) return 'timeout';
  if (/api[ _-]?key|token|auth|credential|unauthori[sz]ed|\b40[13]\b|login|sign[ -]?in/i.test(error)) return 'key';
  if (/exited|closed|ENOENT|spawn|not found|connection closed/i.test(error)) return 'exited';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|\b40[45]\b|\b5\d\d\b|HTTP/i.test(error)) return 'refused';
  return 'error';
}

function readResult(dir, id) {
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file) || statSync(file).size > MAX_RESULT_BYTES) return null;
  try { return checkScanResult(JSON.parse(readFileSync(file, 'utf8')), id); } catch { return null; }
}

export function previousScorecard(dataDir, date) {
  if (!existsSync(dataDir)) return null;
  const earlier = readdirSync(dataDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < date).sort();
  return earlier.length ? JSON.parse(readFileSync(path.join(dataDir, earlier.at(-1)), 'utf8')) : null;
}

export function buildScorecard(plan, scanDir, prev, lintVersion) {
  const before = new Map((prev?.servers ?? []).map((r) => [r.id, r]));
  const servers = plan.servers.map((s) => {
    const row = {
      id: s.id, name: String(s.name).slice(0, 80), by: String(s.by ?? '').slice(0, 80), rank: s.rank, downloads: s.downloads,
      source: s.source, registryName: s.registryName, package: s.package, url: s.url ?? null,
      needs: (s.needs ?? []).filter((v) => ENV_RE.test(v)),
      previousRank: before.get(s.id)?.rank ?? null,
    };
    if (s.problem) return { ...row, reason: 'setup' };
    const r = readResult(scanDir, s.id);
    if (!r) return { ...row, reason: 'missing' };
    if (!r.ok) return { ...row, reason: reasonFor(r.error) };
    const server = { name: r.server.name, version: VERSION_RE.test(r.server.version ?? '') ? r.server.version : null };
    const withMetrics = { ...row, needs: [], server, metrics: serverMetrics(r.tools, { count: countTokens }) };
    return { ...withMetrics, change: changeSince(before.get(s.id), withMetrics) };
  });
  const measured = servers.filter((r) => r.metrics);
  return {
    date: plan.date, topN: plan.topN, previous: prev?.date ?? null, previousKind: prev?.kind ?? (prev ? 'scorecard' : null), lintVersion, registry: plan.registry, method: plan.method,
    summary: { planned: servers.length, measured: measured.length, medianTokens: median(measured.map((r) => shownTokens(r.metrics))) },
    servers,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [planFile, scanDir, docsDir] = process.argv.slice(2);
  if (!planFile || !scanDir || !docsDir) { console.error('usage: node scorecard/build.mjs <plan.json> <scan dir> <docs dir>'); process.exit(2); }
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lintVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const dataDir = path.join(docsDir, 'scorecard');
  const data = buildScorecard(plan, scanDir, previousScorecard(dataDir, plan.date), lintVersion);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, `${data.date}.json`), `${JSON.stringify(data, null, 1)}\n`);
  writeFileSync(path.join(docsDir, 'scorecard.html'), renderPage(data));
  console.log(`scorecard ${data.date}: ${data.summary.measured} of ${data.summary.planned} servers measured, median ~${data.summary.medianTokens} tokens`);
}
