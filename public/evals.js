// MCP Master Tester — tool-selection evals
// Author: @simplymanas
//
// Does a model pick the right tool? Each case is a request a user might make and the tool it should
// lead to. The eval sends the request to a model together with the server's real tool list, then
// grades the tool the model chose and, when the case says so, the arguments. Nothing is called on
// the server. Pure functions, shared by the CLI and the unit tests; the API call lives in cli.js.

export const DEFAULT_CASES = 'mcp-evals.json';
export const DEFAULT_MODEL = 'claude-opus-5-5';

// What the model is told. Kept short and neutral, so the result reflects the tool list, not the prompt.
export const EVAL_SYSTEM = 'You are an assistant connected to one MCP server, whose tools are listed. Do what the user asks. '
  + 'When one of the tools fits the request, call it. When none fits, answer without calling a tool.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const json = (v) => JSON.stringify(v);

/**
 * Reads a cases file: either an array of cases or { "model": "...", "cases": [...] }. Each case:
 *   prompt  what the user asks (required)
 *   expect  the tool that should be called, a list of acceptable tools, or null for "no tool"
 *   args    optional: argument values the call must have; others are ignored
 *   name    optional: a label for the output
 * Throws an Error that says what is wrong and where.
 */
export function parseCases(text) {
  let data;
  try { data = JSON.parse(text); } catch (err) { throw new Error(`not valid JSON: ${err.message}`); }
  const list = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.cases) ? data.cases : null;
  if (!list) throw new Error('expected an array of cases, or an object with a "cases" array');
  if (!list.length) throw new Error('it has no cases');
  if (isObject(data) && data.model !== undefined && (typeof data.model !== 'string' || !data.model)) throw new Error('"model" must be a model name');

  const cases = list.map((c, i) => {
    const at = `case ${i + 1}`;
    if (!isObject(c)) throw new Error(`${at} must be an object`);
    if (typeof c.prompt !== 'string' || !c.prompt.trim()) throw new Error(`${at} needs a "prompt": the request a user would make`);
    if (!('expect' in c)) throw new Error(`${at} needs "expect": a tool name, a list of names, or null when no tool should be called`);
    const expect = c.expect === null ? null : [].concat(c.expect);
    if (expect && (!expect.length || expect.some((t) => typeof t !== 'string' || !t))) throw new Error(`${at}: "expect" must be a tool name, a list of names, or null`);
    if (c.args !== undefined && !isObject(c.args)) throw new Error(`${at}: "args" must be an object of argument values`);
    if (c.args !== undefined && expect === null) throw new Error(`${at}: "args" needs a tool in "expect"`);
    if (c.name !== undefined && typeof c.name !== 'string') throw new Error(`${at}: "name" must be text`);
    return { name: c.name ?? null, prompt: c.prompt, expect, args: c.args ?? null };
  });
  return { model: isObject(data) ? data.model ?? null : null, cases };
}

/** Tool names a case expects that the server doesn't have, so a typo can't pass as "never chosen". */
export function unknownTools(cases, tools) {
  const known = new Set(tools.map((t) => t.name));
  return [...new Set(cases.flatMap((c) => c.expect ?? []).filter((n) => !known.has(n)))];
}

// The Messages API accepts tool names of letters, digits, "_" and "-", up to 64 characters. MCP names
// can hold more (dots, slashes), so those are renamed for the request and mapped back for the report.
const API_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** MCP tools as Messages API tool definitions, and a map from the names sent back to the MCP names. */
export function toApiTools(tools) {
  const used = new Set();
  const fromApi = new Map();
  const apiTools = tools.map((t) => {
    let name = API_NAME.test(t.name) ? t.name : (t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'tool');
    for (let n = 2; used.has(name); n++) name = `${name.slice(0, 60)}_${n}`;
    used.add(name);
    fromApi.set(name, t.name);
    const schema = isObject(t.inputSchema) ? t.inputSchema : {};
    return {
      name,
      ...(t.description ? { description: t.description } : {}),
      input_schema: { ...schema, type: 'object' },
    };
  });
  return { tools: apiTools, fromApi };
}

// Expected argument values: strings match ignoring case and surrounding spaces, objects match on the
// keys the case gives, arrays item by item, everything else exactly.
function sameValue(expected, actual) {
  if (typeof expected === 'string') return typeof actual === 'string' && expected.trim().toLowerCase() === actual.trim().toLowerCase();
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => sameValue(e, actual[i]));
  if (isObject(expected)) return isObject(actual) && Object.entries(expected).every(([k, v]) => sameValue(v, actual[k]));
  return expected === actual;
}

const short = (s, max = 80) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const listOf = (names) => names.map((n) => `"${n}"`).join(' or ');

/**
 * Grades one case from the model's response (a Messages API message).
 * @returns {{status: 'pass'|'fail'|'error', chose: string|null, args: object|null, msg: string}}
 */
export function judgeCase(c, response, fromApi = new Map()) {
  if (response?.stop_reason === 'refusal') return { status: 'error', chose: null, args: null, msg: 'the model declined the request' };
  const content = Array.isArray(response?.content) ? response.content : [];
  const use = content.find((b) => b.type === 'tool_use');
  const chose = use ? fromApi.get(use.name) ?? use.name : null;
  const args = use && isObject(use.input) ? use.input : null;
  if (response?.stop_reason === 'max_tokens' && !use) return { status: 'error', chose: null, args: null, msg: 'the response hit max_tokens before choosing' };

  if (c.expect === null) {
    return chose
      ? { status: 'fail', chose, args, msg: `called "${chose}", but no tool should be called` }
      : { status: 'pass', chose, args, msg: 'answered without a tool' };
  }
  if (!chose) {
    const said = content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    return { status: 'fail', chose, args, msg: `called no tool, expected ${listOf(c.expect)}${said.trim() ? `. It said: "${short(said)}"` : ''}` };
  }
  if (!c.expect.includes(chose)) return { status: 'fail', chose, args, msg: `called "${chose}", expected ${listOf(c.expect)}` };

  const wrong = Object.entries(c.args ?? {}).filter(([k, v]) => !sameValue(v, args?.[k]));
  if (wrong.length) {
    const what = wrong.map(([k, v]) => (args?.[k] === undefined ? `"${k}" was not set (expected ${json(v)})` : `"${k}" was ${short(json(args[k]), 60)} (expected ${json(v)})`));
    return { status: 'fail', chose, args, msg: `called "${chose}", but ${what.join('; ')}` };
  }
  return { status: 'pass', chose, args, msg: c.args ? `called "${chose}" with the expected arguments` : `called "${chose}"` };
}

export function countEval(results) {
  const counts = { pass: 0, fail: 0, error: 0 };
  for (const r of results) counts[r.status]++;
  return counts;
}

/** Whole-number percentage of cases that passed. */
export const passRate = (counts) => {
  const total = counts.pass + counts.fail + counts.error;
  return total ? Math.floor((counts.pass / total) * 100) : 0;
};

/** Which tools the model picked instead of the expected one, most frequent first: "get_forecast → get_weather". */
export function mixUps(cases, results) {
  const tally = new Map();
  results.forEach((r, i) => {
    if (r.status !== 'fail' || !r.chose || cases[i].expect === null || cases[i].expect.includes(r.chose)) return;
    const key = `${cases[i].expect.join('/')} → ${r.chose}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  });
  return [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([pair, n]) => ({ pair, n }));
}

/** A short label for a case: its name, else the tool it expects. */
export const caseLabel = (c) => c.name ?? (c.expect === null ? '(no tool)' : c.expect.join(' / '));
export { short as shortText };
