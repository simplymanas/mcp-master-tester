// Unit tests for the lint rules in public/lint.js. Each rule gets a case that must be flagged and a
// near-miss that must not be.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lintTools, resultChars, unhelpfulError, wrapsTextOnly, fixedValues, betterType, nameStyle, isListish, confusablePairs, writeVerb, readOnlyDoubt, descriptionIndent, outputSchemaProblems, lintMarkdown, toolListSize, sizeLines,
  BIG_RESULT_CHARS,
} from '../public/lint.js';

// A tool that passes every rule; tests override one thing at a time.
const clean = (over = {}) => ({
  name: 'read_note',
  description: 'Read one note by id. Do not use for searching; use search_notes instead.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Note id, e.g. "n_42"' } }, required: ['id'] },
  ...over,
});
const findings = (tools, runtime) => lintTools(tools, runtime);
const has = (list, target, re) => list.some((f) => f.target === target && re.test(f.msg));
const sevOf = (list, target, re) => list.find((f) => f.target === target && re.test(f.msg))?.sev;

test('a well-formed tool has no findings', () => {
  assert.deepEqual(findings([clean()]), []);
});

test('spec errors: duplicate names, non-object schemas, undefined required fields', () => {
  const f = findings([
    clean(),
    clean(),
    clean({ name: 'bad_schema', inputSchema: { type: 'string' } }),
    clean({ name: 'bad_required', inputSchema: { type: 'object', properties: {}, required: ['x'] } }),
  ]);
  assert.equal(sevOf(f, 'read_note', /duplicate/), 'error');
  assert.equal(sevOf(f, 'bad_schema', /inputSchema\.type/), 'error');
  assert.equal(sevOf(f, 'bad_required', /required "x"/), 'error');
});

test('missing "required" list is flagged; an explicit empty list is fine', () => {
  const props = { q: { type: 'string', description: 'Query, e.g. "cats"' } };
  assert.ok(has(findings([clean({ inputSchema: { type: 'object', properties: props } })]), 'read_note', /no "required" list/));
  assert.ok(!has(findings([clean({ inputSchema: { type: 'object', properties: props, required: [] } })]), 'read_note', /no "required" list/));
  assert.ok(!has(findings([clean({ inputSchema: { type: 'object', properties: {} } })]), 'read_note', /no "required" list/));
  // every parameter has a default, so all are clearly optional
  const defaults = { n: { type: 'integer', default: 3, description: 'How many' } };
  assert.ok(!has(findings([clean({ inputSchema: { type: 'object', properties: defaults } })]), 'read_note', /no "required" list/));
  const one = findings([clean({ inputSchema: { type: 'object', properties: { ...defaults, ...props } } })]);
  assert.ok(has(one, 'read_note', /say whether "q" is mandatory/));
});

test('huge descriptions and a huge tool catalog are flagged', () => {
  const long = clean({ description: `Do not use for X. ${'word '.repeat(500)}` });
  assert.equal(sevOf(findings([long]), 'read_note', /description is ~\d+ tokens/), 'warn');
  const many = Array.from({ length: 30 }, (_, i) => clean({ name: `tool_${i}`, description: `Do not use for X. Tool ${i} ${'detail '.repeat(220)}` }));
  assert.ok(findings(many).some((f) => /all 30 tool definitions add up/.test(f.msg)));
  assert.ok(!findings([clean()]).some((f) => /tool definitions add up/.test(f.msg)));
});

test('indentation a dedent would remove: first line, shared margin and blank lines, not nested indents', () => {
  assert.equal(descriptionIndent('one line'), 0);
  assert.equal(descriptionIndent('\n    Read a file.\n    \n    Returns text.'), 4 + 4 + 4);
  assert.equal(descriptionIndent('  Read a file.\n  Options:\n    - lines\n    - offset'), 2 + 2 + 2 + 2);
  assert.equal(descriptionIndent('Read a file.\nOptions:\n  - lines'), 0);
});

test('a description indented to match its source code is flagged; real nesting and small amounts are not', () => {
  // The way a template literal or docstring inside a class ends up: 24 spaces on every line.
  const pad = ' '.repeat(24);
  const lines = Array.from({ length: 12 }, (_, i) => `${pad}Step ${i}: do the thing.`);
  const indented = clean({ description: `\n${pad}Read a file. Do not use for searching.\n${lines.join('\n')}` });
  const f = findings([indented]);
  assert.equal(sevOf(f, 'read_note', /tokens of indentation \(\d+% of it\)/), 'warn');
  assert.ok(has(f, 'read_note', /dedent/));

  // The same text at the left margin, with a nested list: nothing to remove.
  const nested = clean({ description: `Read a file. Do not use for searching.\n${lines.map((l, i) => (i % 2 ? `  - ${l.trim()}` : l.trim())).join('\n')}` });
  assert.ok(!has(findings([nested]), 'read_note', /indentation/));
  // A little indentation (under ~50 tokens) is not worth a warning.
  assert.ok(!has(findings([clean({ description: `Read a file. Do not use for searching.\n${lines.slice(0, 3).join('\n')}` })]), 'read_note', /indentation/));
  // Over 200 characters, but a small share of a long description.
  const long = clean({ description: `Read a file. Do not use for searching. ${'word '.repeat(300)}\n${lines.slice(0, 10).join('\n')}` });
  assert.ok(!has(findings([long]), 'read_note', /indentation/));
});

test('lintMarkdown: a table for an issue or PR, safe from what the server sends', () => {
  const md = lintMarkdown([
    { sev: 'error', target: 'send_mail', msg: 'required "subject" is not defined in properties' },
    { sev: 'warn', target: 'bad`name', msg: 'a | b\nsecond line' },
  ], { serverInfo: { name: 'demo', version: '1.0.0' }, tools: 1 });
  assert.equal(md, [
    '### Lint report: demo v1.0.0', '',
    '1 tool · 1 error, 1 warning, 0 info', '',
    '| Level | Tool | Finding |', '|---|---|---|',
    '| error | `send_mail` | required "subject" is not defined in properties |',
    "| warn | `bad'name` | a \\| b second line |",
    '', 'Checked with [MCP Master Tester](https://github.com/simplymanas/mcp-master-tester).',
  ].join('\n'));
  assert.match(lintMarkdown([], {}), /^### Lint report: MCP server\n\n0 errors, 0 warnings, 0 info\n\nNo findings\./);
});

test('outputSchemaProblems: one line per problem, named by the field it is about', () => {
  assert.deepEqual(
    outputSchemaProblems("Structured content does not match the tool's output schema: data/celsius must be number, data must have required property 'city'"),
    ['celsius: must be number', "must have required property 'city'"],
  );
  assert.deepEqual(outputSchemaProblems("MCP error -32602: Structured content does not match the tool's output schema: data/items/0/name must be string"), ['items/0/name: must be string']);
  assert.deepEqual(outputSchemaProblems('Tool get_report has an output schema but did not return structured content'), ['The tool declares an outputSchema but returned no structuredContent.']);
  // Text in an unexpected shape is shown as it is.
  assert.deepEqual(outputSchemaProblems('something else, entirely'), ['something else, entirely']);
});

test('confusable names: plurals, casing, word order and filler words', () => {
  assert.deepEqual(confusablePairs([clean({ name: 'get_user' }), clean({ name: 'getUsers' })]).map((p) => p.why), ['name']);
  assert.deepEqual(confusablePairs([clean({ name: 'user_get', description: 'a' }), clean({ name: 'get_users', description: 'b' })]).map((p) => p.why), ['name']);
  assert.deepEqual(confusablePairs([
    clean({ name: 'get_item', description: 'Read an inventory item record from the warehouse.' }),
    clean({ name: 'set_item', description: 'Change the stock quantity stored for an inventory item.' }),
  ]), []);
});

test('near-identical descriptions are flagged even when names share nothing', () => {
  const d = 'Fetch the current weather forecast for a city including temperature and wind.';
  const pairs = confusablePairs([clean({ name: 'forecast', description: d }), clean({ name: 'weather_now', description: `${d} Fast.` })]);
  assert.deepEqual(pairs.map((p) => p.why), ['description']);
  const f = findings([clean({ name: 'forecast', description: d }), clean({ name: 'weather_now', description: `${d} Fast.` })]);
  assert.equal(sevOf(f, 'weather_now', /description is nearly identical to "forecast"/), 'warn');
});

test('a prefix every tool has, or a description template most share, does not make tools look alike', () => {
  // Shaped like servers generated from an API spec: every name starts with "API-", every description
  // carries the same "Acme | … Error Responses" wrapper. Seen in a survey of public MCP servers.
  const tool = (name, what, code = 'Bad request') => clean({ name, description: `Acme | ${what} Error Responses: 400: ${code}` });
  const tools = [
    tool('API-retrieve-a-block', 'Retrieve a block'),
    tool('API-update-a-block', 'Update a block'),
    tool('API-delete-a-block', 'Delete a block'),
    tool('API-retrieve-a-page', 'Retrieve a page'),
    tool('API-post-search', 'Search by title'),
    tool('API-get-user', 'Retrieve a user', '400'),
    tool('API-get-users', 'List all users', '400'),
  ];
  // Only the real near-duplicate is left.
  assert.deepEqual(confusablePairs(tools).map((p) => `${p.a} ~ ${p.b}`), ['API-get-user ~ API-get-users']);
  // Templated descriptions that differ in what they manage are not "nearly identical".
  const azureLike = (name, what) => clean({ name, description: `${what} operations - Commands for managing ${what} resources. This tool is a hierarchical command router.` });
  assert.deepEqual(confusablePairs([azureLike('acr', 'Container Registry'), azureLike('containerapps', 'Container Apps'), azureLike('keyvault', 'Key Vault')]), []);
});

test('"when not to use" guidance: info alone, warn when a look-alike exists', () => {
  const plain = 'Read one note by its id and return the full text.';
  assert.equal(sevOf(findings([clean({ description: plain })]), 'read_note', /when not to use/), 'info');
  const f = findings([clean({ name: 'get_user', description: plain }), clean({ name: 'getUsers' })]);
  assert.equal(sevOf(f, 'get_user', /when not to use it \(vs "getUsers"\)/), 'warn');
});

test('string params that list fixed values should be enums', () => {
  assert.deepEqual(fixedValues({ type: 'string', description: 'Sort order: asc|desc' }), ['asc', 'desc']);
  assert.deepEqual(fixedValues({ type: 'string', description: 'One of "open", "closed" or "all".' }), ['open', 'closed', 'all']);
  assert.equal(fixedValues({ type: 'string', description: 'Search text, e.g. "cats" or "dogs"' }), null);
  assert.equal(fixedValues({ type: 'string', enum: ['asc', 'desc'], description: 'asc|desc' }), null);
  const f = findings([clean({ inputSchema: { type: 'object', properties: { order: { type: 'string', description: 'Sort order: asc|desc' } }, required: [] } })]);
  assert.equal(sevOf(f, 'read_note', /lists fixed values \("asc", "desc"\)/), 'warn');
});

test('free-form strings that should be typed', () => {
  assert.equal(betterType('include_archived', { type: 'string' })?.what, 'a boolean');
  assert.equal(betterType('mode', { type: 'string', description: 'Pass "true" or "false".' })?.what, 'a boolean');
  assert.equal(betterType('limit', { type: 'string' })?.what, 'a number');
  assert.equal(betterType('created_at', { type: 'string' })?.what, 'a date or time');
  assert.equal(betterType('callback_url', { type: 'string' })?.what, 'a URL');
  assert.equal(betterType('email', { type: 'string' })?.what, 'an email address');
  // near-misses that are strings for real
  assert.equal(betterType('phone_number', { type: 'string' }), null);
  assert.equal(betterType('last', { type: 'string' }), null);
  assert.equal(betterType('query', { type: 'string', description: 'Returns true if any note matches.' }), null);
  assert.equal(betterType('created_at', { type: 'string', format: 'date-time' }), null);
  assert.equal(betterType('limit', { type: 'integer' }), null);
});

test('enums and strings with no example', () => {
  const tool = (props) => clean({ inputSchema: { type: 'object', properties: props, required: [] } });
  assert.ok(has(findings([tool({ q: { type: 'string', description: 'Text to search for' } })]), 'read_note', /string param "q" has no example/));
  assert.ok(has(findings([tool({ level: { type: 'string', enum: ['a', 'b'] } })]), 'read_note', /enum "level" has no description/));
  for (const ok of [
    { type: 'string', description: 'Text, e.g. "cats"' },
    { type: 'string', examples: ['cats'] },
    { type: 'string', default: 'cats' },
    { type: 'string', format: 'date-time', description: 'When' },
    { type: 'string', enum: ['a', 'b'], description: 'Which mode to use' },
  ]) assert.ok(!findings([tool({ q: ok })]).some((f) => /example|enum "q"/.test(f.msg)), JSON.stringify(ok));
});

test('list/search tools need a limit or pagination parameter', () => {
  assert.ok(isListish('search_logs') && isListish('listUsers') && isListish('get_all_users'));
  assert.ok(!isListish('simulate-research-query') && !isListish('toggle-simulated-logging'));
  const props = (extra) => ({ type: 'object', properties: { q: { type: 'string', description: 'e.g. "x"' }, ...extra }, required: [] });
  assert.ok(has(findings([clean({ name: 'search_notes', inputSchema: props() })]), 'search_notes', /no limit or pagination/));
  assert.ok(!has(findings([clean({ name: 'search_notes', inputSchema: props({ limit: { type: 'integer', description: 'Max' } }) })]), 'search_notes', /no limit/));
});

test('annotations: a read-only tool named like a write, or also marked destructive, is a warning', () => {
  const readOnly = { readOnlyHint: true };
  const f = findings([
    clean({ name: 'cancel_booking', annotations: readOnly }),
    clean({ name: 'booking_delete', annotations: readOnly }),
    clean({ name: 'close_position', annotations: readOnly }),
    clean({ name: 'get_close_price', annotations: readOnly }),
    clean({ name: 'get_audit', annotations: { readOnlyHint: true, destructiveHint: true } }),
    // near-misses: the same names without the read-only claim, and read-only names that only mention a write
    clean({ name: 'cancel_order', annotations: { readOnlyHint: false } }),
    clean({ name: 'delete_note', annotations: undefined }),
    clean({ name: 'get_update_status', annotations: readOnly }),
    clean({ name: 'validate_delete', annotations: readOnly }),
    clean({ name: 'order_status', annotations: readOnly }),
  ]);
  assert.equal(sevOf(f, 'cancel_booking', /marked read-only, but "cancel" in its name suggests it changes something/), 'warn');
  assert.equal(sevOf(f, 'booking_delete', /marked read-only, but "delete" in its name/), 'warn');
  assert.equal(sevOf(f, 'close_position', /marked read-only, but "close" in its name/), 'warn');
  assert.equal(sevOf(f, 'get_audit', /marked read-only and destructive at the same time/), 'warn');
  for (const name of ['cancel_order', 'delete_note', 'get_update_status', 'validate_delete', 'order_status', 'get_close_price']) {
    assert.ok(!has(f, name, /marked read-only/), `${name} must not be flagged`);
  }
});

test('writeVerb: finds the verb at the start or end of a name, in any naming style', () => {
  const verbs = {
    cancel_booking: 'cancel', 'delete-user': 'delete', deleteUser: 'delete', 'user.remove': 'remove', booking_cancel: 'cancel',
    send: 'send', set_status: 'set', post_comment: 'post', update_status: 'update',
    close_position: 'close', close_all_positions: 'close', closePosition: 'close', place_order: 'place', 'place-order': 'place',
    liquidate_position: 'liquidate', amend_order: 'amend', order_amend: 'amend', halt_desk: 'halt', retire_bot: 'retire',
  };
  for (const [name, verb] of Object.entries(verbs)) assert.equal(writeVerb(name), verb, name);
  // Lookups that mention a write, nouns that look like verbs, and names with no verb at all.
  for (const name of ['get_booking', 'get_update_status', 'list_deleted_users', 'validate_delete', 'dry_run_delete', 'order_status',
    'get_order', 'data_set', 'blog_post', 'echo', 'get-sum', 'trigger-long-running-operation', 'search_and_replace', '',
    // "close" and "place" are nouns anywhere but the start: a closing price, a market place.
    'get_close_price', 'market_close', 'previous_close', 'market_place', 'get_place', 'list_open_orders', 'open_orders']) {
    assert.equal(writeVerb(name), null, name);
  }
});

test('readOnlyDoubt: only questions a tool that claims to be read-only', () => {
  assert.match(readOnlyDoubt({ name: 'cancel_booking', annotations: { readOnlyHint: true } }), /"cancel"/);
  assert.equal(readOnlyDoubt({ name: 'cancel_booking', annotations: { readOnlyHint: false } }), null);
  assert.equal(readOnlyDoubt({ name: 'cancel_booking' }), null);
  assert.equal(readOnlyDoubt({ name: 'get_booking', annotations: { readOnlyHint: true } }), null);
  assert.equal(readOnlyDoubt({ name: 'get_booking', annotations: { readOnlyHint: true, destructiveHint: false } }), null);
  assert.equal(readOnlyDoubt(undefined), null);
});

test('naming: snake_case is quiet, other styles are info, breaking the server majority is a warning', () => {
  assert.equal(nameStyle('read_note'), 'snake');
  assert.equal(nameStyle('read-note'), 'kebab');
  assert.equal(nameStyle('readNote'), 'camel');
  assert.equal(nameStyle('ReadNote'), 'pascal');
  assert.equal(nameStyle('echo'), 'single');
  assert.equal(nameStyle('read_Note-x'), 'mixed');
  const allKebab = findings([clean({ name: 'read-note' }), clean({ name: 'write-note' })]);
  assert.equal(sevOf(allKebab, 'read-note', /kebab-case, not snake_case/), 'info');
  const mixed = findings([clean({ name: 'read_note' }), clean({ name: 'write_note' }), clean({ name: 'deleteNote' })]);
  assert.equal(sevOf(mixed, 'deleteNote', /camelCase but most tools on this server are snake_case/), 'warn');
  assert.ok(!mixed.some((f) => f.target === 'read_note' && /snake_case/.test(f.msg)));
});

test('runtime: oversized results', () => {
  assert.equal(resultChars({ content: [{ type: 'text', text: 'abc' }] }), 3);
  // structuredContent duplicates the text, so it is not double counted
  assert.equal(resultChars({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } }), 7);
  const f = findings([clean()], { bigResults: { read_note: BIG_RESULT_CHARS * 2 } });
  assert.equal(sevOf(f, 'read_note', /returned ~20,000 tokens/), 'warn');
});

test('runtime: isError results with no actionable message', () => {
  const err = (text) => ({ isError: true, content: text === undefined ? [] : [{ type: 'text', text }] });
  for (const bad of [undefined, '', 'Error', 'Internal error', 'MCP error -32603: failed', '[object Object]', 'undefined'])
    assert.notEqual(unhelpfulError(err(bad)), null, `should flag ${JSON.stringify(bad)}`);
  for (const good of ['Note "n_42" not found. Call search_notes to find valid ids.', 'limit must be between 1 and 100, got 500'])
    assert.equal(unhelpfulError(err(good)), null, `should accept ${good}`);
  assert.equal(unhelpfulError({ content: [{ type: 'text', text: 'Error' }] }), null); // not an isError result
  const f = findings([clean()], { badErrors: { read_note: 'Error' } });
  assert.equal(sevOf(f, 'read_note', /isError with no useful message \("Error"\)/), 'warn');
});

test('runtime: structuredContent that only wraps the text output', () => {
  const text = 'id     : req-1\nstatus : DONE';
  const res = (sc, t = text) => ({ content: [{ type: 'text', text: t }], structuredContent: sc });
  assert.equal(wrapsTextOnly(res({ result: text })), true);
  assert.equal(wrapsTextOnly(res({ result: `${text}\n` })), true); // whitespace differences don't matter
  assert.equal(wrapsTextOnly(res({ id: 'req-1', status: 'DONE' })), false); // real fields
  assert.equal(wrapsTextOnly(res({ result: 'something else' })), false); // a string, but not the text
  assert.equal(wrapsTextOnly(res({ result: text, extra: 1 })), false);
  assert.equal(wrapsTextOnly(res({ count: 3 }, '3')), false); // not a string
  assert.equal(wrapsTextOnly({ content: [{ type: 'text', text }] }), false); // no structuredContent
});

test('findings are sorted by severity, then by tool order', () => {
  const f = findings([
    clean({ name: 'b_tool', description: 'short' }),
    clean({ name: 'a_tool', inputSchema: { type: 'string' } }),
  ]);
  assert.deepEqual(f.map((x) => x.sev), [...f.map((x) => x.sev)].sort((x, y) => ['error', 'warn', 'info'].indexOf(x) - ['error', 'warn', 'info'].indexOf(y)));
  assert.equal(f[0].target, 'a_tool');
});

test('toolListSize: where the size comes from, the largest tools first, and parameters without a description', () => {
  const big = clean({ name: 'search_notes', description: 'Search notes by text. '.repeat(20), outputSchema: { type: 'object', properties: { hits: { type: 'array' } } },
    inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer', description: 'Most results, e.g. 10' } } } });
  const tools = [clean(), big];
  const size = toolListSize(tools);
  const tok = (v) => Math.round(JSON.stringify(v).length / 4);
  assert.equal(size.tokens, Math.round((JSON.stringify(tools[0]).length + JSON.stringify(big).length) / 4));
  assert.equal(size.outputSchemas, tok(big.outputSchema));
  assert.equal(size.descriptions, Math.round((JSON.stringify(tools[0].description).length + JSON.stringify(big.description).length) / 4));
  assert.ok(Math.abs(size.descriptions + size.inputSchemas + size.outputSchemas + size.other - size.tokens) <= 2, 'the parts add up');
  assert.deepEqual(size.tools.map((t) => t.name), ['search_notes', 'read_note']);
  assert.deepEqual([size.params, size.paramsNoDescription], [3, 1]);
  const lines = sizeLines(size);
  assert.match(lines.size, /^Tool list: ~[\d,]+ tokens \(descriptions ~[\d,]+, input schemas ~[\d,]+, output schemas ~[\d,]+, other ~[\d,]+\)$/);
  assert.match(lines.largest, /^Largest: search_notes ~[\d,]+, read_note ~[\d,]+$/);
  assert.equal(lines.params, 'Parameters: 1 of 3 have no description');
  const one = sizeLines(toolListSize([clean()]));
  assert.equal(one.largest, undefined, 'no "largest" line for a single tool');
  assert.doesNotMatch(one.size, /output schemas/, 'output schemas are mentioned only when there are some');
  assert.deepEqual(toolListSize([]), { tokens: 0, descriptions: 0, inputSchemas: 0, outputSchemas: 0, other: 0, tools: [], params: 0, paramsNoDescription: 0 });
});

test('token budgets: over the whole-list or per-tool budget is an error, and a list budget replaces the ~10k warning', () => {
  const huge = Array.from({ length: 40 }, (_, i) => clean({ name: `tool_${i}`, description: `Tool ${i}. ${'Long text. '.repeat(100)}` }));
  const size = toolListSize(huge);
  assert.ok(size.tokens > 10000);
  assert.equal(lintTools(huge).find((f) => /add up to/.test(f.msg))?.sev, 'warn', 'the fixed warning without a budget');
  const over = lintTools(huge, {}, { maxTokens: 8000 });
  const err = over.find((f) => /over the budget of 8,000/.test(f.msg));
  assert.equal(err.sev, 'error');
  assert.match(err.msg, new RegExp(`all 40 tool definitions add up to ~${size.tokens.toLocaleString('en-US')} tokens, over the budget of 8,000; largest: `));
  assert.equal(over.filter((f) => /add up to/.test(f.msg)).length, 1, 'the budget replaces the warning, not adds to it');
  assert.ok(!lintTools(huge, {}, { maxTokens: 50000 }).some((f) => /add up to/.test(f.msg)), 'under a budget the user set: no warning either');

  const perTool = lintTools([clean(), clean({ name: 'long_one', description: 'x'.repeat(2000) })], {}, { maxToolTokens: 300 });
  assert.equal(sevOf(perTool, 'long_one', /over the per-tool budget of 300/), 'error');
  assert.ok(!has(perTool, 'read_note', /per-tool budget/));
});

test('a tokenizer counts the size and the budgets instead of characters / 4', async () => {
  const { countTokens } = await import('gpt-tokenizer/encoding/o200k_base');
  const o200k = { name: 'o200k', count: countTokens };
  const big = clean({ name: 'search_notes', description: 'Search notes by text. '.repeat(20), outputSchema: { type: 'object', properties: { hits: { type: 'array' } } } });
  const tools = [clean(), big];
  const size = toolListSize(tools, o200k);
  assert.equal(size.tokenizer, 'o200k');
  assert.equal(size.tokens, countTokens(tools.map((t) => JSON.stringify(t)).join('')), 'the total is counted the way the scorecard counts it');
  assert.equal(size.tools.find((t) => t.name === 'search_notes').tokens, countTokens(JSON.stringify(big)));
  assert.equal(size.outputSchemas, countTokens(JSON.stringify(big.outputSchema)));
  assert.notEqual(size.tokens, toolListSize(tools).tokens, 'a real count, not the estimate');
  const lines = sizeLines(size);
  assert.match(lines.size, /^Tool list: [\d,]+ o200k tokens \(descriptions [\d,]+, input schemas [\d,]+, output schemas [\d,]+, other [\d,]+\)$/);
  assert.match(lines.largest, /^Largest: search_notes [\d,]+, read_note [\d,]+$/);
  assert.ok(!('tokenizer' in toolListSize(tools)), 'no tokenizer field for an estimate');

  const over = lintTools(tools, {}, { maxTokens: 50, maxToolTokens: 60, tokenizer: o200k });
  assert.match(over.find((f) => /over the budget of 50/.test(f.msg)).msg, new RegExp(`add up to ${size.tokens} o200k tokens, over the budget of 50; largest: search_notes \\d+`));
  assert.equal(sevOf(over, 'search_notes', /^definition is \d+ o200k tokens, over the per-tool budget of 60$/), 'error');
});

test('lintMarkdown adds the size lines when given', () => {
  const md = lintMarkdown([], { tools: 1, size: toolListSize([clean()]) });
  assert.match(md, /\n- Tool list: ~\d+ tokens \(descriptions/);
  assert.match(md, /\n- Parameters: 0 of 1 have no description/);
});
