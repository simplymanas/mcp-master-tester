// MCP Master Tester — lint rules for tool definitions and tool results
// Author: @simplymanas
//
// Pure functions with no DOM access, so the browser (app.js) and the unit tests (test/lint.test.js)
// share one implementation.

export const BIG_RESULT_CHARS = 40000;      // ≈10k tokens: one result this big crowds a client's context
export const BIG_DESCRIPTION_CHARS = 2000;  // ≈500 tokens for a single tool description
export const BIG_CATALOG_CHARS = 40000;     // ≈10k tokens for all tool definitions, sent on every model request
export const approxTokens = (chars) => Math.round(chars / 4).toLocaleString('en-US');

/**
 * Lint a server's tool list.
 * @param {object[]} tools  tools from tools/list
 * @param {object} [runtime]  what calls in this session revealed:
 *   bigResults: { [toolName]: chars }    largest oversized result per tool
 *   badErrors:  { [toolName]: string }   text of an isError result with no useful message
 * @returns {{sev: 'error'|'warn'|'info', target: string, msg: string}[]}
 */
export function lintTools(tools, runtime = {}) {
  const out = [];
  const add = (sev, target, msg) => out.push({ sev, target, msg });
  const seen = new Set();

  for (const t of tools) {
    if (seen.has(t.name)) add('error', t.name, 'duplicate tool name');
    seen.add(t.name);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(t.name)) add('warn', t.name, 'name should match [A-Za-z0-9_.-]{1,128}');
    if (!t.description) add('warn', t.name, 'missing description — models cannot tell when to use it');
    else if (t.description.length < 20) add('info', t.name, 'very short description');
    else if (t.description.length > BIG_DESCRIPTION_CHARS)
      add('warn', t.name, `description is ~${approxTokens(t.description.length)} tokens — it is sent with every request; move detail into parameter descriptions or docs`);

    const s = t.inputSchema;
    if (!s || s.type !== 'object') { add('error', t.name, 'inputSchema.type must be "object"'); continue; }
    const props = s.properties ?? {};
    const names = Object.keys(props);
    for (const r of s.required ?? []) if (!(r in props)) add('error', t.name, `required "${r}" is not defined in properties`);
    // Without "required", a parameter with no default leaves the model guessing whether to send it.
    const unclear = Array.isArray(s.required) ? [] : names.filter((n) => props[n].default === undefined);
    if (unclear.length)
      add('info', t.name, unclear.length === 1
        ? `no "required" list — say whether "${unclear[0]}" is mandatory (use [] if nothing is)`
        : `no "required" list — say which of ${unclear.map((n) => `"${n}"`).join(', ')} are mandatory (use [] if none are)`);

    for (const [n, p] of Object.entries(props)) {
      if (!p.type && !p.enum && !p.anyOf && !p.oneOf && !p.$ref) add('warn', t.name, `property "${n}" has no type`);
      if (!p.description) add('info', t.name, `property "${n}" has no description`);
      const values = fixedValues(p);
      if (values) add('warn', t.name, `string param "${n}" lists fixed values (${values.map((v) => `"${v}"`).join(', ')}) — make it an enum so clients can validate it`);
      const typed = betterType(n, p);
      if (typed) add(typed.sev, t.name, `string param "${n}" looks like ${typed.what} — ${typed.fix}`);
      const missing = !values && !typed && missingExample(p);
      if (missing === 'enum') add('info', t.name, `enum "${n}" has no description or default — say what the values mean and which to pick when unsure`);
      else if (missing) add('info', t.name, `string param "${n}" has no example — add "examples", a default, or an "e.g." in its description`);
    }

    if (!t.annotations) add('info', t.name, 'no annotations (readOnly/destructive hints)');
    if (t.outputSchema && t.outputSchema.type !== 'object') add('error', t.name, 'outputSchema.type must be "object"');
    if (isListish(t.name) && !names.some((n) => LIMIT_RE.test(n)))
      add('info', t.name, 'list/search-style tool with no limit or pagination parameter — output may be unbounded and flood the client\'s context');
  }

  // Naming conventions: flag tools that break the server's own majority style, else non-snake_case.
  const styles = tools.map((t) => ({ name: t.name, style: nameStyle(t.name) }));
  const counts = {};
  for (const { style } of styles) if (style !== 'single' && style !== 'other') counts[style] = (counts[style] ?? 0) + 1;
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const majority = ranked.length > 1 && ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
  for (const { name, style } of styles) {
    if (style === 'single' || style === 'snake' || style === 'other') continue;
    if (majority && style !== majority) add('warn', name, `name is ${STYLE_LABEL[style]} but most tools on this server are ${STYLE_LABEL[majority]} — pick one convention`);
    else add('info', name, `name is ${STYLE_LABEL[style]}, not snake_case — snake_case is the most common MCP tool naming convention`);
  }

  // The whole catalog is sent to the model on every request.
  const catalog = tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
  if (catalog > BIG_CATALOG_CHARS && tools.length) {
    const largest = tools.reduce((a, b) => (JSON.stringify(b).length > JSON.stringify(a).length ? b : a));
    add('warn', largest.name, `all ${tools.length} tool definitions add up to ~${approxTokens(catalog)} tokens, sent with every request; this is the largest (~${approxTokens(JSON.stringify(largest).length)})`);
  }

  // Tools a model could mix up.
  const similar = new Map();
  for (const { a, b, why } of confusablePairs(tools)) {
    add('warn', b, why === 'name'
      ? `name is very close to "${a}" — models may confuse them; make the names and descriptions say how they differ`
      : `description is nearly identical to "${a}"'s — models can't tell them apart; say what each is for`);
    similar.set(a, b).set(b, a);
  }

  // Descriptions that never say when NOT to use the tool. More important when a look-alike exists.
  for (const t of tools) {
    if (!t.description || t.description.length < 20 || NEGATIVE_GUIDANCE_RE.test(t.description)) continue;
    const twin = similar.get(t.name);
    add(twin ? 'warn' : 'info', t.name, twin
      ? `description doesn't say when not to use it (vs "${twin}") — e.g. "Use ${twin} instead when …"`
      : 'description doesn\'t say when not to use it — add a "Don\'t use for …" or "Use X instead when …" line');
  }

  // Runtime findings from calls made in this session.
  for (const [name, chars] of Object.entries(runtime.bigResults ?? {}))
    add('warn', name, `a call returned ~${approxTokens(chars)} tokens of output — cap it, paginate, or summarize (threshold ~${approxTokens(BIG_RESULT_CHARS)})`);
  for (const [name, text] of Object.entries(runtime.badErrors ?? {}))
    add('warn', name, `returned isError with no useful message (${text ? `"${text}"` : 'empty'}) — say what went wrong and how to fix the call, so the model can recover`);

  const order = { error: 0, warn: 1, info: 2 };
  const toolOrder = new Map(tools.map((t, i) => [t.name, i]));
  return out.sort((a, b) => order[a.sev] - order[b.sev] || (toolOrder.get(a.target) ?? 0) - (toolOrder.get(b.target) ?? 0));
}

// ---------------------------------------------------------------- results

// Characters a tool result puts into a model's context. structuredContent usually repeats the text
// content (the spec asks servers to send both), so count whichever is larger rather than the sum.
export function resultChars(res) {
  if (!res) return 0;
  let text = 0;
  for (const c of res.content ?? []) {
    if (c.type === 'text') text += c.text?.length ?? 0;
    else if (c.type === 'resource') text += c.resource?.text?.length ?? 0;
  }
  const structured = res.structuredContent === undefined ? 0 : JSON.stringify(res.structuredContent).length;
  return Math.max(text, structured);
}

const GENERIC_ERROR_RE = /^(error|errored|failed|failure|fail|internal( server)? error|unknown error|an error occurred|something went wrong|exception|undefined|null|none|\[object object\]|bad request|invalid( input| request| arguments?)?|not ok|false|-?1)[.!]?$/i;

// For an isError result whose text doesn't help a model fix the call, returns that text ('' when
// there is none); otherwise null.
export function unhelpfulError(res) {
  if (!res?.isError) return null;
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(' ').replace(/\s+/g, ' ').trim();
  const bare = text.replace(/^(mcp )?error( -?\d+)?:\s*/i, '');
  if (bare.length < 12 || GENERIC_ERROR_RE.test(bare)) return text.slice(0, 60);
  return null;
}

// True when structuredContent is one string field that just repeats the text output, e.g. {"result": "<text>"}.
// That gives clients no fields to work with; Python FastMCP produces it when a tool returns a str.
export function wrapsTextOnly(res) {
  const sc = res?.structuredContent;
  if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return false;
  const vals = Object.values(sc);
  if (vals.length !== 1 || typeof vals[0] !== 'string') return false;
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  const text = norm((res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'));
  return text !== '' && norm(vals[0]) === text;
}

// ---------------------------------------------------------------- helpers

const NEGATIVE_GUIDANCE_RE = /\b(do not|don'?t|never|avoid|not (for|to be used|intended|suitable|meant)|instead|rather than|unless|only (use|when|for|if)|prefer\b)/i;
const LIMIT_RE = /^(limit|max|max_?(results|items|count|tokens|length|lines|rows)|page|page_?size|per_?page|cursor|offset|top_?k|count|first|last|size|n)$/i;
const LIST_VERBS = new Set(['list', 'search', 'query', 'find', 'browse', 'scan', 'dump', 'export', 'grep', 'tail']);
const LIST_NOUNS = new Set(['logs', 'history', 'all']);
const STYLE_LABEL = { snake: 'snake_case', kebab: 'kebab-case', camel: 'camelCase', pascal: 'PascalCase', dotted: 'dot.separated', mixed: 'a mix of styles' };

// Split snake_case, kebab-case, dotted and camelCase names into lowercase words.
export const nameWords = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function nameStyle(name) {
  if (/^[a-z][a-z0-9]*$/.test(name)) return 'single';
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return 'snake';
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) return 'kebab';
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(name)) return 'camel';
  if (/^([A-Z][a-z0-9]*){2,}$/.test(name)) return 'pascal';
  if (/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(name)) return 'dotted';
  if (/^[A-Za-z0-9_.-]+$/.test(name) && /[_.-]/.test(name) && /[A-Z_.-]/.test(name)) return 'mixed';
  return 'other';
}

// Tools that return a collection: the leading verb lists/searches (search_logs, listUsers), or the
// name asks for everything (get_all_users, read_logs). "simulate-research-query" is not one.
export function isListish(name) {
  const w = nameWords(name);
  return LIST_VERBS.has(w[0]) || w.some((x) => LIST_NOUNS.has(x));
}

const isStringSchema = (s) => s.type === 'string' || (Array.isArray(s.type) && s.type.includes('string'));

// "enum" or "string" when a string-ish parameter gives the model nothing concrete to imitate, else null.
export function missingExample(p) {
  const s = p.type === 'array' && p.items ? p.items : p;
  const hasEnum = Array.isArray(s.enum);
  if (!hasEnum && !isStringSchema(s)) return null;
  if (s.const !== undefined || (!hasEnum && (s.format || s.pattern))) return null; // shape already pinned down
  if (p.examples?.length || s.examples?.length || p.default !== undefined || s.default !== undefined) return null;
  const desc = `${p.description ?? ''} ${s === p ? '' : s.description ?? ''}`;
  if (/\b(e\.g\.|eg:|example|for instance|such as|like ["'`])|["'`][^"'`]+["'`]/i.test(desc)) return null;
  if (hasEnum) return s.enum.length > 1 && !desc.trim() ? 'enum' : null; // an enum with a description explaining it is fine
  return 'string';
}

// The values of a free-form string whose description spells out a closed set ("one of 'asc' or
// 'desc'", "Sort order: asc|desc"), or null.
export function fixedValues(p) {
  if (!isStringSchema(p) || p.enum || p.const !== undefined || p.format || p.pattern) return null;
  const d = p.description ?? '';
  const piped = d.match(/(?:^|[\s(:])([a-z0-9_-]{1,24}(?:\s*\|\s*[a-z0-9_-]{1,24}){1,9})(?=$|[\s).,;])/i);
  if (piped) return piped[1].split('|').map((v) => v.trim());
  const listed = d.match(/\b(?:one of|either|must be|should be|can be|valid values?(?: are)?|allowed values?(?: are)?|possible values?(?: are)?|options?(?: are)?|accepts?)\s*:?\s*((?:["'`][^"'`\s]{1,24}["'`](?:\s*(?:,|or|and|\/)\s*)*){2,10})/i);
  if (listed) return [...listed[1].matchAll(/["'`]([^"'`\s]{1,24})["'`]/g)].map((m) => m[1]);
  return null;
}

// For a string parameter whose name implies a stronger type, what to use instead; otherwise null.
export function betterType(name, p) {
  if (!isStringSchema(p) || p.enum || p.const !== undefined || p.format || p.pattern) return null;
  if (Array.isArray(p.type) && p.type.length > 1) return null; // already a union on purpose
  const w = nameWords(name);
  const last = w[w.length - 1];
  if (['is', 'has', 'should', 'can', 'enable', 'disable', 'include', 'allow', 'use'].includes(w[0]) && w.length > 1
      || ['enabled', 'disabled', 'flag', 'recursive', 'verbose', 'force'].includes(last)
      || /["'`]?\btrue\b["'`]?\s*(or|\/|\|)\s*["'`]?\bfalse\b|\bfalse\b["'`]?\s*(or|\/|\|)\s*["'`]?\btrue\b/i.test(p.description ?? ''))
    return { sev: 'warn', what: 'a boolean', fix: 'use "type": "boolean" so models don\'t send "yes", "1" or "True"' };
  // Last word only, and only words that are numeric in practice ("phone_number" and "last" stay strings).
  if (['count', 'limit', 'offset', 'max', 'min', 'port', 'timeout', 'retries', 'age', 'year', 'days', 'hours', 'minutes', 'seconds', 'ms', 'quantity', 'qty', 'amount', 'k'].includes(last))
    return { sev: 'warn', what: 'a number', fix: 'use "type": "integer" or "number" (with minimum/maximum) instead of a string' };
  if (['at', 'date', 'since', 'until', 'before', 'after', 'timestamp', 'time', 'datetime', 'deadline'].includes(last))
    return { sev: 'info', what: 'a date or time', fix: 'add "format": "date-time" (or "date") so models send ISO 8601' };
  if (['url', 'uri', 'link', 'href', 'endpoint', 'webhook'].includes(last))
    return { sev: 'info', what: 'a URL', fix: 'add "format": "uri"' };
  if (last === 'email')
    return { sev: 'info', what: 'an email address', fix: 'add "format": "email"' };
  return null;
}

// Pairs of tools a model could mix up:
//   name: same words once plurals, word order, casing and filler words are ignored (get_user / getUsers),
//         or names sharing a word whose descriptions are similar
//   description: descriptions nearly identical, whatever the names
export function confusablePairs(tools) {
  const stem = (w) => w.replace(/ies$/, 'y').replace(/(?<=[^s])s$/, '');
  const words = (text, stop) => new Set(nameWords(text ?? '').filter((w) => !stop.has(w)).map(stem));
  const FILLER = new Set(['get', 'the', 'a', 'an', 'all', 'by', 'of', 'for', 'tool', 'do', 'run']);
  const STOP = new Set([...FILLER, 'and', 'or', 'to', 'in', 'on', 'with', 'from', 'is', 'it', 'this', 'that', 'be', 'as', 'at', 'use', 'return', 'given']);
  const jaccard = (a, b) => { const shared = [...a].filter((w) => b.has(w)).length; const union = new Set([...a, ...b]).size; return union ? shared / union : 0; };
  const info = tools.map((t) => ({ name: t.name, nw: words(t.name, FILLER), dw: words(t.description, STOP) }));
  const pairs = [];
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      const [a, b] = [info[i], info[j]];
      const nameSim = jaccard(a.nw, b.nw);
      const descSim = a.dw.size >= 4 && b.dw.size >= 4 ? jaccard(a.dw, b.dw) : 0;
      if ((a.nw.size > 0 && nameSim === 1) || (nameSim > 0 && descSim >= 0.6)) pairs.push({ a: a.name, b: b.name, why: 'name' });
      else if (descSim >= 0.8) pairs.push({ a: a.name, b: b.name, why: 'description' });
    }
  }
  return pairs;
}
