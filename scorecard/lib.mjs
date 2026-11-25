// Monthly scorecard: pure functions shared by select.mjs, scan.mjs and build.mjs, and unit-tested in
// test/scorecard.test.js. No network and no file access here.
import { createHash } from 'node:crypto';
import { canonical } from '../public/diff.js';
import { lintTools } from '../public/lint.js';

export const TOP_N = 100;
export const WORK_DIR = '/work';  // a server's working directory inside the scan container
const OFFICIAL = 'io.modelcontextprotocol.registry/official';

// ---------- the registry ----------

// The latest, active version of each server. The registry API returns these with ?version=latest,
// but filtering again keeps a test fixture or an API change from slipping through.
export function activeServers(entries) {
  return entries.filter((e) => {
    const m = e?._meta?.[OFFICIAL];
    return e?.server?.name && m?.status === 'active' && m?.isLatest !== false;
  });
}

// PyPI compares project names in this form (PEP 503), and so does its download data.
export const pypiName = (name) => String(name).toLowerCase().replace(/[-_.]+/g, '-');

const packageKey = (type, identifier) => `${type}:${type === 'pypi' ? pypiName(identifier) : identifier}`;

// Every npm or PyPI package a registry server runs over stdio, once each. When several registry
// entries point at the same package, the first keeps it: the list is sorted by name, so the choice is stable.
export function packageCandidates(servers) {
  const out = new Map();
  for (const { server: s, _meta } of [...servers].sort((a, b) => a.server.name.localeCompare(b.server.name))) {
    for (const p of s.packages ?? []) {
      if (!['npm', 'pypi'].includes(p.registryType) || p.transport?.type !== 'stdio' || typeof p.identifier !== 'string') continue;
      const key = packageKey(p.registryType, p.identifier);
      if (out.has(key)) continue;
      out.set(key, {
        key, type: p.registryType, identifier: p.identifier, version: p.version ?? null,
        registryName: s.name, title: s.title ?? null, publishedAt: _meta?.[OFFICIAL]?.publishedAt ?? null, pkg: p,
      });
    }
  }
  return out;
}

// Arguments from a registry package entry. A value the publisher gave is used as is; an argument with
// no value or default is left out, unless it is required, which makes the server one we can't start
// without configuring it. Values with {placeholders} also need configuring.
function registryArgs(list = []) {
  const argv = [];
  for (const a of list) {
    const value = a.value ?? a.default;
    const what = a.valueHint ?? a.name ?? a.description ?? 'an argument';
    if (value === undefined || value === null || value === '') {
      if (a.isRequired) return { problem: `needs ${String(what).slice(0, 60)}` };
      continue;
    }
    if (/\{[^}]*\}/.test(String(value))) return { problem: `needs ${String(what).slice(0, 60)}` };
    if (a.type === 'named') argv.push(String(a.name), String(value));
    else argv.push(String(value));
  }
  return { argv };
}

// The command that starts a registry package, or the reason it can't be started unattended.
// Environment variables get only the defaults the publisher set; no key or token is ever made up,
// so a server that needs one either starts without it (most still list their tools) or fails to.
export function commandFor(c) {
  const runner = c.type === 'npm' ? 'npx' : 'uvx';
  const spec = c.version ? `${c.identifier}@${c.version}` : c.identifier;
  const runtime = c.pkg.runtimeHint === runner ? registryArgs(c.pkg.runtimeArguments) : { argv: [] };
  const pkgArgs = registryArgs(c.pkg.packageArguments);
  const problem = runtime.problem ?? pkgArgs.problem;
  if (problem) return { problem };
  const rt = runtime.argv.filter((a) => a !== '-y');
  const namesPackage = rt.some((a) => a === c.identifier || a.startsWith(`${c.identifier}@`) || a.startsWith(`${c.identifier}=`));
  const command = [runner, ...(runner === 'npx' ? ['-y'] : []), ...rt, ...(namesPackage ? [] : [spec]), ...pkgArgs.argv];
  const env = {};
  const needs = [];
  for (const v of c.pkg.environmentVariables ?? []) {
    if (!v?.name) continue;
    if (v.default !== undefined && v.default !== null && v.default !== '' && !v.isSecret) env[v.name] = String(v.default);
    else if (v.isRequired) needs.push(String(v.name));
  }
  return { command, env, needs };
}

// The TOP_N most downloaded packages, most first; ties keep registry-name order.
export function pickTop(candidates, downloads, n = TOP_N) {
  return [...candidates.values()]
    .map((c) => ({ ...c, downloads: downloads.get(c.key) ?? 0 }))
    .filter((c) => c.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads || a.registryName.localeCompare(b.registryName))
    .slice(0, n);
}

// A short, stable id for a package: npm-playwright-mcp, pypi-mcp-server-time.
export const packageId = (type, identifier) => `${type}-${(type === 'pypi' ? pypiName(identifier) : identifier).replace(/^@/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

// The run list: the top packages, then the baseline servers from the first survey that aren't among them.
// A baseline server that is also in the top keeps its baseline id, name and command, so its history continues.
export function planServers(top, baseline) {
  const byKey = new Map(baseline.filter((b) => b.package).map((b) => [packageKey(b.package.type, b.package.identifier), b]));
  const used = new Set();
  const list = top.map((c, i) => {
    const base = byKey.get(c.key);
    const row = {
      id: base?.id ?? packageId(c.type, c.identifier), name: base?.name ?? c.title ?? c.identifier, by: base?.by ?? c.registryName.split('/')[0],
      rank: i + 1, downloads: c.downloads, registryName: c.registryName,
      package: { type: c.type, identifier: c.identifier, version: c.version },
      source: base ? 'both' : 'top',
    };
    if (base) { used.add(base.id); return { ...row, command: base.command, url: base.url, env: base.env ?? {}, needs: [] }; }
    const cmd = commandFor(c);
    return cmd.problem ? { ...row, problem: cmd.problem } : { ...row, command: cmd.command, env: cmd.env, needs: cmd.needs };
  });
  for (const b of baseline) {
    if (used.has(b.id)) continue;
    list.push({ id: b.id, name: b.name, by: b.by, rank: null, downloads: null, registryName: null, package: b.package ?? null,
      source: 'baseline', command: b.command, url: b.url, env: b.env ?? {}, needs: [] });
  }
  return list;
}

// Facts about the whole registry, from its listing alone: nothing is run.
export function registryStats(entries, now = new Date()) {
  const active = activeServers(entries);
  const since = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const publishers = new Map();
  let remoteOnly = 0, packageOnly = 0, both = 0, recent = 0;
  const types = {};
  for (const { server: s, _meta } of active) {
    const r = (s.remotes ?? []).length > 0, p = (s.packages ?? []).length > 0;
    if (r && p) both++; else if (r) remoteOnly++; else if (p) packageOnly++;
    if ((_meta?.[OFFICIAL]?.publishedAt ?? '') >= since) recent++;
    for (const k of new Set((s.packages ?? []).map((x) => x.registryType))) types[k] = (types[k] ?? 0) + 1;
    const ns = s.name.split('/')[0];
    publishers.set(ns, (publishers.get(ns) ?? 0) + 1);
  }
  const counts = [...publishers.values()].sort((a, b) => b - a);
  const top10 = counts.slice(0, 10).reduce((a, b) => a + b, 0);
  return {
    servers: active.length, deprecated: entries.filter((e) => e?._meta?.[OFFICIAL]?.status === 'deprecated').length,
    publishedLast30Days: recent, remoteOnly, packageOnly, both, packageTypes: types,
    publishers: publishers.size, top10PublishersServers: top10,
  };
}

// ---------- results from the scan ----------

const LIMITS = { tools: 2000, nameChars: 256, textChars: 200 };
const str = (v, max = LIMITS.textChars) => (typeof v === 'string' ? v.slice(0, max) : null);

// A scan result comes from a job that ran other people's code, so it is checked before anything uses it:
// the shape, the sizes, and every string that can reach the page. Returns null when it can't be trusted.
export function checkScanResult(raw, id) {
  if (!raw || typeof raw !== 'object' || raw.id !== id) return null;
  if (!raw.ok) return { ok: false, error: str(raw.error) ?? 'failed', ms: Number.isFinite(raw.ms) ? raw.ms : null };
  if (!Array.isArray(raw.tools) || raw.tools.length > LIMITS.tools) return null;
  if (!raw.tools.every((t) => t && typeof t === 'object' && !Array.isArray(t) && typeof t.name === 'string' && t.name.length <= LIMITS.nameChars)) return null;
  const server = raw.server && typeof raw.server === 'object' ? { name: str(raw.server.name), version: str(raw.server.version) } : { name: null, version: null };
  return { ok: true, tools: raw.tools, server, ms: Number.isFinite(raw.ms) ? raw.ms : null };
}

const size = (x) => JSON.stringify(x ?? null).length;
const tokens = (chars) => Math.round(chars / 4);

// The numbers the scorecard shows for one server: the same measures as the first survey.
export function serverMetrics(tools) {
  const findings = (() => { try { return lintTools(tools); } catch { return []; } })();
  const params = tools.flatMap((t) => Object.values(t.inputSchema?.properties ?? {}));
  const big = tools.reduce((a, t) => (!a || size(t) > size(a) ? t : a), null);
  const ann = (t) => (t.annotations && typeof t.annotations === 'object' ? t.annotations : {});
  return {
    tools: tools.length,
    tokens: tokens(tools.reduce((n, t) => n + size(t), 0)),
    largest: big ? { name: big.name, tokens: tokens(size(big)) } : null,
    labelled: tools.filter((t) => t.annotations && Object.keys(t.annotations).length).length,
    readOnly: tools.filter((t) => ann(t).readOnlyHint === true).length,
    destructive: tools.filter((t) => ann(t).destructiveHint === true).length,
    noDescription: tools.filter((t) => !t.description).length,
    params: params.length,
    paramsNoDescription: params.filter((p) => !(p && typeof p === 'object' && p.description)).length,
    outputSchemas: tools.filter((t) => t.outputSchema).length,
    lint: { error: findings.filter((f) => f.sev === 'error').length, warn: findings.filter((f) => f.sev === 'warn').length },
    toolNames: tools.map((t) => t.name).sort(),
    // Order doesn't count: a server that lists the same tools in another order hasn't changed.
    hash: createHash('sha256').update(JSON.stringify(canonical([...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))))).digest('hex').slice(0, 16),
  };
}

// What changed for one server since the previous scorecard.
export function changeSince(prev, cur) {
  if (!prev?.metrics || !cur?.metrics) return null;
  const before = new Set(prev.metrics.toolNames ?? []), after = new Set(cur.metrics.toolNames ?? []);
  return {
    tokens: cur.metrics.tokens - prev.metrics.tokens,
    tools: cur.metrics.tools - prev.metrics.tools,
    added: [...after].filter((n) => !before.has(n)),
    removed: [...before].filter((n) => !after.has(n)),
    changed: prev.metrics.hash !== undefined && prev.metrics.hash !== cur.metrics.hash,
  };
}

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
