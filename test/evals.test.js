// Unit tests for public/evals.js: the cases file, the tool list sent to the model, and grading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCases, unknownTools, toApiTools, judgeCase, countEval, passRate, mixUps, caseLabel } from '../public/evals.js';

const toolUse = (name, input = {}) => ({ stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', id: 't1', name, input }] });
const text = (s) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: s }] });
const one = (c) => parseCases(JSON.stringify([c])).cases[0];

test('parseCases: an array or { model, cases }, with expect as a name, a list or null', () => {
  const plain = parseCases('[{"prompt":"Weather in Paris?","expect":"get_weather"}]');
  assert.equal(plain.model, null);
  assert.deepEqual(plain.cases, [{ name: null, prompt: 'Weather in Paris?', expect: ['get_weather'], args: null }]);
  const full = parseCases(JSON.stringify({ model: 'claude-sonnet-5-5', cases: [
    { name: 'either', prompt: 'p', expect: ['a', 'b'], args: { id: 1 } },
    { prompt: 'hello', expect: null },
  ] }));
  assert.equal(full.model, 'claude-sonnet-5-5');
  assert.deepEqual(full.cases.map((c) => c.expect), [['a', 'b'], null]);
});

test('parseCases explains what is wrong, and where', () => {
  assert.throws(() => parseCases('{'), /not valid JSON/);
  assert.throws(() => parseCases('{"tests": []}'), /array of cases/);
  assert.throws(() => parseCases('[]'), /no cases/);
  assert.throws(() => parseCases('[{"expect":"a"}]'), /case 1 needs a "prompt"/);
  assert.throws(() => parseCases('[{"prompt":"p","expect":"a"},{"prompt":"q"}]'), /case 2 needs "expect"/);
  assert.throws(() => parseCases('[{"prompt":"p","expect":[]}]'), /"expect" must be/);
  assert.throws(() => parseCases('[{"prompt":"p","expect":null,"args":{"a":1}}]'), /"args" needs a tool/);
  assert.throws(() => parseCases('[{"prompt":"p","expect":"a","args":[1]}]'), /"args" must be an object/);
  assert.throws(() => parseCases('{"model":"","cases":[{"prompt":"p","expect":"a"}]}'), /"model" must be/);
});

test('unknownTools catches expected names the server lacks', () => {
  const { cases } = parseCases('[{"prompt":"p","expect":["get_user","getUser"]},{"prompt":"q","expect":null}]');
  assert.deepEqual(unknownTools(cases, [{ name: 'get_user' }]), ['getUser']);
});

test('toApiTools: name, description and an object input_schema; odd names renamed and mapped back', () => {
  const { tools, fromApi } = toApiTools([
    { name: 'get_weather', description: 'Weather.', inputSchema: { type: 'object', properties: { city: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'files.read', inputSchema: undefined },
    { name: 'files/read' },
  ]);
  assert.deepEqual(tools[0], { name: 'get_weather', description: 'Weather.', input_schema: { type: 'object', properties: { city: { type: 'string' } } } });
  assert.deepEqual(tools.map((t) => t.name), ['get_weather', 'files_read', 'files_read_2']);
  assert.deepEqual(tools[1].input_schema, { type: 'object' });
  assert.equal(fromApi.get('files_read_2'), 'files/read');
  assert.equal(judgeCase(one({ prompt: 'p', expect: 'files/read' }), toolUse('files_read_2'), fromApi).status, 'pass');
});

test('judgeCase: the right tool passes, another tool or none fails, and says what happened', () => {
  const c = one({ prompt: 'Weather in Paris?', expect: 'get_weather' });
  assert.deepEqual(judgeCase(c, toolUse('get_weather')), { status: 'pass', chose: 'get_weather', args: {}, msg: 'called "get_weather"' });
  assert.equal(judgeCase(c, toolUse('get_forecast')).msg, 'called "get_forecast", expected "get_weather"');
  assert.equal(judgeCase(c, text('Which city?')).msg, 'called no tool, expected "get_weather". It said: "Which city?"');
  assert.equal(judgeCase(one({ prompt: 'p', expect: ['a', 'b'] }), toolUse('b')).status, 'pass');
});

test('judgeCase: a null case passes only when no tool is called', () => {
  const c = one({ prompt: 'Hello', expect: null });
  assert.equal(judgeCase(c, text('Hi!')).status, 'pass');
  assert.equal(judgeCase(c, toolUse('get_weather')).msg, 'called "get_weather", but no tool should be called');
});

test('judgeCase: arguments match on the keys given, strings ignoring case', () => {
  const c = one({ prompt: 'p', expect: 'get_weather', args: { city: 'Paris', days: 3, filter: { units: 'C' } } });
  assert.equal(judgeCase(c, toolUse('get_weather', { city: ' paris ', days: 3, filter: { units: 'c', extra: 1 }, other: true })).status, 'pass');
  assert.equal(judgeCase(c, toolUse('get_weather', { city: 'Oslo', filter: { units: 'C' } })).msg,
    'called "get_weather", but "city" was "Oslo" (expected "Paris"); "days" was not set (expected 3)');
  assert.equal(judgeCase(one({ prompt: 'p', expect: 'a', args: { ids: [1, 2] } }), toolUse('a', { ids: [1, 2, 3] })).status, 'fail');
});

test('judgeCase: a refusal or a cut-off answer is an error, not a wrong choice', () => {
  const c = one({ prompt: 'p', expect: 'a' });
  assert.equal(judgeCase(c, { stop_reason: 'refusal', content: [] }).status, 'error');
  assert.equal(judgeCase(c, { stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '' }] }).status, 'error');
});

test('counts, pass rate and mix-ups', () => {
  const { cases } = parseCases(JSON.stringify([
    { prompt: '1', expect: 'get_forecast' }, { prompt: '2', expect: 'get_forecast' }, { prompt: '3', expect: 'a' }, { prompt: '4', expect: null },
  ]));
  const results = [judgeCase(cases[0], toolUse('get_weather')), judgeCase(cases[1], toolUse('get_weather')), judgeCase(cases[2], toolUse('a')), { status: 'error', chose: null }];
  const counts = countEval(results);
  assert.deepEqual(counts, { pass: 1, fail: 2, error: 1 });
  assert.equal(passRate(counts), 25);
  assert.equal(passRate({ pass: 2, fail: 1, error: 0 }), 66, 'rounded down, so 66% never passes a 67% bar');
  assert.deepEqual(mixUps(cases, results), [{ pair: 'get_forecast → get_weather', n: 2 }]);
  assert.deepEqual(cases.map(caseLabel), ['get_forecast', 'get_forecast', 'a', '(no tool)']);
});
