// Monthly scorecard: render docs/scorecard.html from one month's data and the month before.
// Every string from a server or the registry is escaped, and the page loads nothing but site.css,
// under the same Content-Security-Policy as the rest of the site.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const n = (x) => (x === null || x === undefined ? '' : Number(x).toLocaleString('en-US'));
const signed = (x) => (x > 0 ? `+${n(x)}` : x < 0 ? `−${n(-x)}` : '0');
const day = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const plural = (k, word, many = `${word}s`) => `${n(k)} ${k === 1 ? word : many}`;
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

export const REASONS = {
  setup: 'needs a setting the registry entry has no value for',
  key: 'needs a key or sign-in',
  timeout: 'no answer within 3 minutes',
  exited: "didn't start with the command in its registry entry",
  refused: 'refused the connection',
  error: 'failed to list its tools',
  missing: 'no result from the scan',
};

function pkgLine(r) {
  if (r.url) { try { const u = new URL(r.url); return `remote: ${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { return 'remote'; } }
  if (!r.package) return '';
  const v = r.server?.version ?? r.package.version;
  return `${r.package.identifier}${v ? ` ${v}` : ''}${r.package.type === 'pypi' ? ' (PyPI)' : ''}`;
}

function changeCell(c) {
  if (!c) return '<td class="num muted">new</td>';
  if (!c.changed && c.tokens === 0) return '<td class="num muted">same</td>';
  return `<td class="num">${signed(c.tokens)}</td>`;
}

const head = (d) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
  <title>MCP server scorecard · MCP Master Tester</title>
  <meta name="description" content="Every month: the tool lists of the most downloaded servers in the official MCP Registry, measured. How much each sends to the model, and how well its tools are labelled. Updated ${esc(day(d.date))}.">
  <link rel="canonical" href="https://simplymanas.github.io/mcp-master-tester/scorecard.html">
  <meta property="og:type" content="article">
  <meta property="og:title" content="MCP server scorecard, ${esc(day(d.date))}">
  <meta property="og:description" content="The tool lists of the most downloaded MCP servers, measured every month.">
  <meta property="og:url" content="https://simplymanas.github.io/mcp-master-tester/scorecard.html">
  <meta property="og:image" content="https://simplymanas.github.io/mcp-master-tester/screenshot-lint.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27%3E%3Cpath d=%27M8 1l7 7-7 7-7-7z%27 fill=%27%234f9cf9%27/%3E%3C/svg%3E">
  <link rel="stylesheet" href="site.css">
</head>
<body>
<header class="site-header">
  <div class="wrap">
    <a class="brand" href="./"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1l7 7-7 7-7-7z"/></svg>MCP Master Tester</a>
    <nav class="site-nav" aria-label="Site">
      <a href="./" class="hide-sm">Home</a>
      <a href="guide.html">Docs</a>
      <a href="survey.html" class="hide-sm">Survey</a>
      <a href="scorecard.html" aria-current="page">Scorecard</a>
      <a href="https://github.com/simplymanas/mcp-master-tester" target="_blank" rel="noopener" class="hide-sm">GitHub</a>
    </nav>
  </div>
</header>
`;

const foot = `
<footer class="site-footer">
  <div class="wrap">
    <span>MCP Master Tester · MIT licence · by <a href="https://github.com/simplymanas" target="_blank" rel="noopener">@simplymanas</a></span>
    <nav aria-label="Footer">
      <a href="./">Home</a>
      <a href="guide.html">Docs</a>
      <a href="https://github.com/simplymanas/mcp-master-tester" target="_blank" rel="noopener">GitHub</a>
      <a href="https://www.npmjs.com/package/mcp-master-tester" target="_blank" rel="noopener">npm</a>
    </nav>
  </div>
</footer>
</body>
</html>
`;

function changes(d) {
  if (!d.previous) return '  <p>This is the first scorecard. From next month, this section lists what changed.</p>\n';
  const measured = d.servers.filter((r) => r.metrics && r.change);
  const moved = measured.filter((r) => Math.abs(r.change.tokens) >= 200).sort((a, b) => Math.abs(b.change.tokens) - Math.abs(a.change.tokens)).slice(0, 8);
  const changed = measured.filter((r) => r.change.changed);
  const added = measured.reduce((k, r) => k + r.change.added.length, 0);
  const removed = measured.reduce((k, r) => k + r.change.removed.length, 0);
  // The first survey had no ranking, so "new in the top N" means something only after a scorecard.
  const entered = d.previousKind === 'survey' ? [] : d.servers.filter((r) => r.rank && !r.previousRank);
  const what = d.previousKind === 'survey' ? 'the first survey' : 'the scorecard';
  const out = [changed.length
    ? `  <p>Compared with ${what} of ${esc(day(d.previous))}: ${plural(changed.length, 'server')} changed ${changed.length === 1 ? 'its' : 'their'} tool list, adding ${plural(added, 'tool')} and removing ${n(removed)}.</p>`
    : `  <p>Compared with ${what} of ${esc(day(d.previous))}: no server changed its tool list.</p>`];
  if (moved.length) {
    out.push('  <ul>');
    for (const r of moved) {
      const c = r.change;
      const detail = [c.added.length ? `${plural(c.added.length, 'tool')} added` : '', c.removed.length ? `${n(c.removed.length)} removed` : ''].filter(Boolean).join(', ');
      out.push(`    <li><strong>${esc(r.name)}:</strong> ${signed(c.tokens)} tokens, now ~${n(r.metrics.tokens)}${detail ? ` (${detail})` : ''}.</li>`);
    }
    out.push('  </ul>');
  }
  if (entered.length) out.push(`  <p>New in the top ${n(d.topN)} this month: ${entered.map((r) => esc(r.name)).join(', ')}.</p>`);
  return `${out.join('\n')}\n`;
}

export function renderPage(d) {
  const rows = d.servers;
  const measured = rows.filter((r) => r.metrics);
  const notMeasured = rows.filter((r) => !r.metrics);
  const tools = measured.reduce((k, r) => k + r.metrics.tools, 0);
  const labelled = measured.reduce((k, r) => k + r.metrics.labelled, 0);
  const params = measured.reduce((k, r) => k + r.metrics.params, 0);
  const paramsNo = measured.reduce((k, r) => k + r.metrics.paramsNoDescription, 0);
  const over = measured.filter((r) => r.metrics.tokens > 10000);
  const reg = d.registry;
  const sorted = [...measured].sort((a, b) => b.metrics.tokens - a.metrics.tokens || a.name.localeCompare(b.name));
  const topCount = rows.filter((r) => r.rank).length;
  const specErrors = measured.filter((r) => r.metrics.lint.error);

  const table = sorted.map((r) => {
    const m = r.metrics;
    return `<tr><td>${esc(r.name)}<span class="pkg">${esc(pkgLine(r))}</span></td>`
      + `<td class="num">${r.rank ? `${n(r.rank)}<span class="pkg">${n(r.downloads)}</span>` : '<span class="muted">survey</span>'}</td>`
      + `<td class="num">${n(m.tools)}</td><td class="num">${n(m.tokens)}${m.tokensWithoutOutputSchemas !== undefined && m.tokensWithoutOutputSchemas < m.tokens ? `<span class="pkg">${n(m.tokensWithoutOutputSchemas)} without output schemas</span>` : ''}</td>${changeCell(r.change)}`
      + `<td class="num">${n(m.labelled)} of ${n(m.tools)}</td><td class="num">${n(m.paramsNoDescription)} of ${n(m.params)}</td>`
      + `<td class="num">${m.lint.error ? `<strong>${n(m.lint.error)}</strong>` : '0'} / ${n(m.lint.warn)}</td></tr>`;
  }).join('\n');

  const failed = notMeasured.map((r) => `    <li><strong>${esc(r.name)}</strong> <span class="muted">${esc(pkgLine(r))}</span>: ${esc(r.needs?.length && r.reason !== 'setup' ? `needs ${r.needs.join(', ')}` : REASONS[r.reason] ?? REASONS.error)}${r.rank ? ` (rank ${n(r.rank)})` : ''}</li>`).join('\n');

  return `${head(d)}
<main class="wrap article">
  <p class="kicker">Scorecard · ${esc(day(d.date))}</p>
  <h1>MCP server scorecard</h1>
  <p class="lede">Every month I list the tools of the ${n(d.topN)} most downloaded servers in the official MCP Registry, and of the servers from the <a href="survey.html">first survey</a>, and measure what each sends to the model on every request. Only the tool list is read: no tool is called.</p>

  <ul class="stats">
    <li><strong>${n(measured.length)}</strong><span>servers measured, ${plural(tools, 'tool')}</span></li>
    <li><strong>${n(over.length)}</strong><span>over 10,000 tokens</span></li>
    <li><strong>~${n(d.summary.medianTokens)}</strong><span>tokens for the median server</span></li>
    <li><strong>${pct(labelled, tools)}%</strong><span>of tools have safety labels</span></li>
  </ul>

  <h2>${d.previousKind === 'survey' ? 'Since the first survey' : 'Since the last scorecard'}</h2>
${changes(d)}
  <h2>What the numbers say</h2>
  <ul>
    <li><strong>Size:</strong> ${plural(over.length, 'server')} send${over.length === 1 ? 's' : ''} over 10,000 tokens with every request${over.length ? `: ${over.sort((a, b) => b.metrics.tokens - a.metrics.tokens).slice(0, 6).map((r) => `${esc(r.name)} (~${n(r.metrics.tokens)})`).join(', ')}${over.length > 6 ? ' and others' : ''}` : ''}. Lint warns above that.</li>
    <li><strong>Safety labels:</strong> ${n(labelled)} of ${plural(tools, 'tool')} have annotations such as <code>readOnlyHint</code>. ${plural(measured.filter((r) => r.metrics.tools && !r.metrics.labelled).length, 'server')} label none of ${measured.filter((r) => r.metrics.tools && !r.metrics.labelled).length === 1 ? 'its' : 'their'} tools.</li>
    <li><strong>Parameters:</strong> ${n(paramsNo)} of ${plural(params, 'parameter')} have no description of their own.</li>
    <li><strong>Spec errors:</strong> ${specErrors.length ? `${plural(specErrors.length, 'server')} ${specErrors.length === 1 ? 'has' : 'have'} at least one lint error, such as an input schema that isn't an object or a duplicate tool name: ${specErrors.map((r) => esc(r.name)).join(', ')}.` : 'no server has a lint error, such as an input schema that isn\'t an object or a duplicate tool name.'}</li>
  </ul>

  <h2>The registry as a whole</h2>
  <p>The official registry lists ${n(reg.servers)} servers (latest versions, not counting ${n(reg.deprecated)} deprecated), ${n(reg.publishedLast30Days)} of them published or updated in the last 30 days. ${n(reg.remoteOnly)} are remote only, ${n(reg.packageOnly)} are packages only and ${n(reg.both)} are both. They come from ${n(reg.publishers)} publishers, and the 10 largest account for ${n(reg.top10PublishersServers)} servers (${pct(reg.top10PublishersServers, reg.servers)}%), which is why the scorecard ranks by downloads instead of measuring the whole list.</p>

  <h2 id="data">All ${n(measured.length)} servers measured</h2>
  <p>Largest first. Rank is by downloads in the last 30 days, shown under it; "survey" marks a server from the first survey that isn't in the top ${n(d.topN)}. Change is in tokens since the last scorecard.</p>
  <div class="table-wrap">
<table class="data wide">
<thead><tr><th>Server and package</th><th class="num">Rank</th><th class="num">Tools</th><th class="num">Est. tokens</th><th class="num">Change</th><th class="num">Labelled</th><th class="num">Params with no description</th><th class="num">Lint errors / warnings</th></tr></thead>
<tbody>
${table}
</tbody></table>
  </div>
${notMeasured.length ? `
  <h2 id="not-measured">Not measured this month</h2>
  <p>${plural(notMeasured.length, 'server')} couldn't be listed without an account, a key or a setting. Most servers that need a key still list their tools without one; these didn't.</p>
  <ul>
${failed}
  </ul>
` : ''}
  <h2 id="method">Method</h2>
  <ul>
    <li><strong>When:</strong> ${esc(day(d.date))}, by a scheduled GitHub Actions workflow in this project's repository. The results arrive as a pull request, which I review before it's published.</li>
    <li><strong>Which servers:</strong> the ${n(topCount)} registry servers whose npm or PyPI package had the most downloads in the last 30 days, run over stdio, plus the servers from the first survey. Download counts come from npm's public API (for scoped packages, from npm's search results, which cover the ${n(d.method.npmSearchDepth)} most relevant "mcp" packages) and from the public PyPI download dataset. Downloads count every install of a package, so a large tool that also includes an MCP server, such as a cloud provider's command line, ranks by all its users. Remote-only servers have no download counts, so only the survey's remote servers are included.${(d.method.notes ?? []).map((x) => ` ${esc(x)}`).join('')}</li>
    <li><strong>How:</strong> each package is the version the registry lists, run with <code>npx</code> or <code>uvx</code> and only the arguments and environment defaults its registry entry gives, read the way the registry's schema defines them. A server whose entry doesn't give a working command is listed as not started; its publisher can fix the entry. No key or token is supplied. Each runs inside a container with no access to the repository's credentials, and its output is checked before use.</li>
    <li><strong>Only tool lists were read.</strong> Each server got <code>initialize</code> and <code>tools/list</code>, nothing else. The lists were checked with MCP Master Tester ${esc(d.lintVersion)}'s lint.</li>
    <li><strong>Tokens are estimated</strong> as the characters of each tool definition, as compact JSON, divided by four, the same estimate lint and the first survey use. It includes output schemas, which not every client passes to the model; where a server declares them, the table also gives the count without them. Real tokenizers differ by model, so compare servers with each other rather than reading the figures as exact.</li>
    <li><strong>Settings change the numbers.</strong> Several servers can expose fewer tools through their options. These figures are for the defaults.</li>
    <li><strong>The data:</strong> every month's numbers are in <a href="https://github.com/simplymanas/mcp-master-tester/tree/main/docs/scorecard" target="_blank" rel="noopener">docs/scorecard</a> as JSON.</li>
  </ul>
  <div class="note">
    <p>I make MCP Master Tester, the tool used for these checks. If a number here is wrong, or your server needs a setting to start, please <a href="https://github.com/simplymanas/mcp-master-tester/issues" target="_blank" rel="noopener">open an issue</a>.</p>
  </div>
</main>
${foot}`;
}
