// Unit tests for the smoke test: which arguments are sent, which tools run, and how each answer is judged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleValue, sampleArgs, planSmoke, judge, runSmoke, countSmoke, smokeFailed, NOT_READ_ONLY } from '../public/smoke.js';
import { BIG_RESULT_CHARS } from '../public/lint.js';

const readOnly = { readOnlyHint: true };
const tool = (name, extra = {}) => ({ name, inputSchema: { type: 'object', properties: {}, required: [] }, ...extra });
const ok = (result = { content: [{ type: 'text', text: 'fine' }] }, ms = 5) => ({ ok: true, result, ms });
const err = (error, code = null, ms = 5) => ({ ok: false, error, code, ms });

test('sampleValue: values the schema supplies are not "made up"', () => {
  assert.deepEqual(sampleValue({ type: 'string', default: 'c' }), { value: 'c', made: false });
  assert.deepEqual(sampleValue({ type: 'string', examples: ['n_42', 'n_43'] }), { value: 'n_42', made: false });
  assert.deepEqual(sampleValue({ const: 'v1' }), { value: 'v1', made: false });
  assert.deepEqual(sampleValue({ type: 'string', enum: ['asc', 'desc'] }), { value: 'asc', made: false });
  assert.deepEqual(sampleValue({ type: 'boolean' }), { value: false, made: false });
  assert.deepEqual(sampleValue({ type: 'null' }), { value: null, made: false });
  assert.deepEqual(sampleValue({ anyOf: [{ type: 'null' }, { enum: ['x'] }] }), { value: 'x', made: false });
  assert.deepEqual(sampleValue({ default: 0 }), { value: 0, made: false }, 'a falsy default still counts');
});

test('sampleValue: placeholders are marked as made up and respect the schema\'s limits', () => {
  assert.deepEqual(sampleValue({ type: 'string' }), { value: 'test', made: true });
  assert.equal(sampleValue({ type: 'string', minLength: 8 }).value.length, 8);
  assert.equal(sampleValue({ type: 'string', maxLength: 2 }).value, 'te');
  assert.equal(sampleValue({ type: 'string', format: 'uri' }).value, 'https://example.com');
  assert.equal(sampleValue({ type: 'string', format: 'email' }).value, 'user@example.com');
  assert.match(sampleValue({ type: 'string', format: 'date-time' }).value, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(sampleValue({ type: 'integer' }), { value: 1, made: true });
  assert.equal(sampleValue({ type: 'integer', minimum: 10 }).value, 10);
  assert.equal(sampleValue({ type: 'number', maximum: -3 }).value, -3);
  assert.equal(sampleValue({ type: 'integer', exclusiveMinimum: 1 }).value, 2);
  assert.equal(sampleValue({ type: 'integer', exclusiveMaximum: 1 }).value, 0);
  assert.equal(sampleValue({ type: 'integer', minimum: 0.5, maximum: 9 }).value, 1);
  assert.deepEqual(sampleValue({ type: ['string', 'null'] }), { value: 'test', made: true });
  assert.deepEqual(sampleValue({ type: 'array', items: { type: 'string' } }), { value: [], made: true });
  assert.deepEqual(sampleValue({ type: 'array', minItems: 2, items: { type: 'integer' } }).value, [1, 1]);
  assert.deepEqual(sampleValue({ $ref: '#/$defs/Thing' }), { value: 'test', made: true });
  assert.deepEqual(sampleValue(undefined), { value: 'test', made: true });
});

test('sampleValue: objects are filled from their own required list', () => {
  const schema = { type: 'object', properties: { unit: { enum: ['c', 'f'] }, note: { type: 'string' }, where: { type: 'string' } }, required: ['unit', 'where'] };
  assert.deepEqual(sampleValue(schema), { value: { unit: 'c', where: 'test' }, made: true });
  assert.deepEqual(sampleValue({ properties: { unit: { enum: ['c'] } }, required: ['unit'] }), { value: { unit: 'c' }, made: false });
});

test('sampleArgs: required parameters only, and it names the made-up ones', () => {
  const schema = {
    type: 'object',
    properties: { city: { type: 'string', enum: ['Pune', 'Oslo'] }, id: { type: 'string' }, limit: { type: 'integer', default: 10 }, verbose: { type: 'boolean' } },
    required: ['city', 'id'],
  };
  assert.deepEqual(sampleArgs(schema), { args: { city: 'Pune', id: 'test' }, made: ['id'] });
  assert.deepEqual(sampleArgs({ type: 'object', properties: { a: { type: 'string' } } }), { args: {}, made: [] }, 'no required list: send nothing');
  assert.deepEqual(sampleArgs({ type: 'object', required: ['ghost'] }), { args: { ghost: 'test' }, made: ['ghost'] }, 'required but undefined');
  assert.deepEqual(sampleArgs(undefined), { args: {}, made: [] });
  assert.deepEqual(sampleArgs({ type: 'object', required: 'id' }), { args: {}, made: [] });
});

test('planSmoke: by default only tools marked read-only run', () => {
  const tools = [tool('read', { annotations: readOnly }), tool('write', { annotations: { readOnlyHint: false } }), tool('unmarked')];
  const plan = planSmoke(tools);
  assert.deepEqual(plan.map((p) => [p.tool, p.run]), [['read', true], ['write', false], ['unmarked', false]]);
  assert.equal(plan[1].reason, NOT_READ_ONLY);
  assert.equal(plan[2].reason, NOT_READ_ONLY);
  assert.deepEqual(planSmoke(tools, { all: true }).map((p) => p.run), [true, true, true]);
});

test('planSmoke: --tool picks exactly those tools, --skip wins over everything', () => {
  const tools = [tool('a', { annotations: readOnly }), tool('b', { annotations: readOnly }), tool('w')];
  const picked = planSmoke(tools, { only: ['w', 'a'] });
  assert.deepEqual(picked.map((p) => [p.tool, p.run, p.reason]), [['a', true, undefined], ['b', false, 'not selected'], ['w', true, undefined]]);
  const skipped = planSmoke(tools, { all: true, only: ['a'], skip: ['a'] });
  assert.deepEqual(skipped.map((p) => p.run), [false, false, false]);
  assert.equal(skipped[0].reason, 'skipped on request');
});

test('planSmoke: where the arguments come from', () => {
  const needsId = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
  const needsEnum = { type: 'object', properties: { city: { enum: ['Pune'] } }, required: ['city'] };
  const tools = [tool('by_id', { annotations: readOnly, inputSchema: needsId }), tool('by_city', { annotations: readOnly, inputSchema: needsEnum }), tool('plain', { annotations: readOnly })];
  const plan = planSmoke(tools, { given: { plain: { deep: true } } });
  assert.deepEqual(plan[0], { tool: 'by_id', run: true, args: { id: 'test' }, source: 'made-up', made: ['id'] });
  assert.deepEqual(plan[1], { tool: 'by_city', run: true, args: { city: 'Pune' }, source: 'schema', made: [] });
  assert.deepEqual(plan[2], { tool: 'plain', run: true, args: { deep: true }, source: 'given', made: [] });
  // Arguments given for a tool that isn't selected don't make it run.
  assert.equal(planSmoke([tool('w')], { given: { w: {} } })[0].run, false);
});

test('judge: a normal answer passes', () => {
  assert.deepEqual(judge({ source: 'schema', made: [] }, ok()), { status: 'pass', msg: '' });
  assert.deepEqual(judge({ source: 'made-up', made: ['id'] }, ok({ content: [] })), { status: 'pass', msg: '' });
});

test('judge: an error result is a warning for made-up arguments, a failure otherwise', () => {
  const errorResult = ok({ isError: true, content: [{ type: 'text', text: 'No user with id "test".' }] });
  assert.deepEqual(judge({ source: 'made-up', made: ['id'] }, errorResult), { status: 'warn', msg: 'returned an error for the made-up "id": No user with id "test".' });
  assert.deepEqual(judge({ source: 'schema', made: [] }, errorResult), { status: 'fail', msg: 'returned an error: No user with id "test".' });
  assert.deepEqual(judge({ source: 'given', made: [] }, errorResult), { status: 'fail', msg: 'returned an error: No user with id "test".' });
  assert.equal(judge({ source: 'schema', made: [] }, ok({ isError: true })).msg, 'returned an error: no message');
});

test('judge: "invalid params" is a warning only when the arguments were made up', () => {
  const rejected = err('MCP error -32602: id must be a UUID', -32602);
  assert.deepEqual(judge({ source: 'made-up', made: ['id'] }, rejected), { status: 'warn', msg: 'rejected the call for the made-up "id": id must be a UUID' });
  assert.equal(judge({ source: 'given', made: [] }, rejected).status, 'fail');
  assert.equal(judge({ source: 'schema', made: [] }, rejected).status, 'fail');
});

test('judge: timeouts, crashes, exceptions and outputSchema violations always fail', () => {
  const madeUp = { source: 'made-up', made: ['id'] };
  assert.deepEqual(judge(madeUp, err('MCP error -32001: Request timed out', -32001, 30001.4)), { status: 'fail', msg: 'no answer: timed out after 30001 ms' });
  assert.deepEqual(judge(madeUp, err('MCP error -32000: Connection closed', -32000)), { status: 'fail', msg: 'the server closed the connection during the call' });
  assert.deepEqual(judge(madeUp, err('Not connected')), { status: 'fail', msg: 'the server closed the connection during the call' });
  assert.deepEqual(judge(madeUp, err('MCP error -32603: MCP error -32603: TypeError: x is undefined', -32603)), { status: 'fail', msg: 'protocol error -32603: TypeError: x is undefined' });
  assert.deepEqual(judge(madeUp, err('boom')), { status: 'fail', msg: 'protocol error: boom' });
  // The SDK reports both outputSchema problems as -32602 / -32600; neither is the caller's fault.
  assert.match(judge(madeUp, err('MCP error -32602: Structured content does not match the tool\'s output schema: data/celsius must be number', -32602)).msg, /^result breaks its outputSchema: .*celsius must be number$/);
  assert.equal(judge(madeUp, err('MCP error -32600: Tool get_report has an output schema but did not return structured content', -32600)).status, 'fail');
});

test('judge: an oversized answer is a warning, and a tool needing tasks is skipped', () => {
  const big = judge({ source: 'schema', made: [] }, ok({ content: [{ type: 'text', text: 'x'.repeat(BIG_RESULT_CHARS + 1) }] }));
  assert.equal(big.status, 'warn');
  assert.match(big.msg, /^answered with ~10,000 tokens of output/);
  assert.equal(judge({ source: 'schema', made: [] }, err('MCP error -32600: Tool "research" requires task-based execution. Use …', -32600)).status, 'skip');
});

test('judge: long messages are cut to one readable line', () => {
  const { msg } = judge({ source: 'schema', made: [] }, ok({ isError: true, content: [{ type: 'text', text: `line one\n\n${'y'.repeat(500)}` }] }));
  assert.ok(msg.length < 190, `${msg.length} chars`);
  assert.doesNotMatch(msg, /\n/);
  assert.match(msg, /…$/);
});

test('runSmoke: calls the planned tools in order with their arguments and reports each result', async () => {
  const plan = planSmoke([
    tool('a', { annotations: readOnly }),
    tool('w'),
    tool('b', { annotations: readOnly, inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }),
  ]);
  const calls = [];
  const seen = [];
  const results = await runSmoke(plan, async (name, args) => { calls.push([name, args]); return name === 'b' ? ok({ isError: true, content: [{ type: 'text', text: 'nope' }] }, 7.6) : ok(); }, (r, i) => seen.push([i, r.tool, r.status]));
  assert.deepEqual(calls, [['a', {}], ['b', { id: 'test' }]]);
  assert.deepEqual(seen, [[0, 'a', 'pass'], [1, 'w', 'skip'], [2, 'b', 'warn']]);
  assert.deepEqual(results[0], { tool: 'a', status: 'pass', msg: '', ms: 5, args: {}, source: 'schema' });
  assert.deepEqual(results[1], { tool: 'w', status: 'skip', msg: NOT_READ_ONLY });
  assert.equal(results[2].ms, 8);
  assert.deepEqual(countSmoke(results), { pass: 1, warn: 1, fail: 0, skip: 1 });
});

test('runSmoke: once the connection closes, the remaining tools are not called', async () => {
  const plan = planSmoke([tool('a', { annotations: readOnly }), tool('crash', { annotations: readOnly }), tool('c', { annotations: readOnly }), tool('w')]);
  const calls = [];
  const results = await runSmoke(plan, async (name) => { calls.push(name); return name === 'crash' ? err('MCP error -32000: Connection closed', -32000) : ok(); });
  assert.deepEqual(calls, ['a', 'crash']);
  assert.deepEqual(results.map((r) => r.status), ['pass', 'fail', 'skip', 'skip']);
  assert.equal(results[2].msg, 'not run: the server connection closed during "crash"');
  assert.equal(results[3].msg, NOT_READ_ONLY);
});

test('smokeFailed: the --fail-on levels, and a run that called nothing fails', () => {
  const r = (...statuses) => statuses.map((status, i) => ({ tool: `t${i}`, status, msg: '' }));
  assert.equal(smokeFailed(r('pass', 'skip')), false);
  assert.equal(smokeFailed(r('pass', 'warn')), false);
  assert.equal(smokeFailed(r('pass', 'warn'), 'warn'), true);
  assert.equal(smokeFailed(r('pass', 'fail')), true);
  assert.equal(smokeFailed(r('pass', 'fail'), 'never'), false);
  assert.equal(smokeFailed(r('skip', 'skip')), true, 'nothing ran, so nothing was proved');
  assert.equal(smokeFailed([]), true);
  assert.equal(smokeFailed([], 'never'), false);
});
