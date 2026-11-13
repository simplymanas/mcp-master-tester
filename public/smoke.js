// MCP Master Tester — smoke test
// Calls each tool once and judges the answer: did it respond, without a protocol error or a timeout, with
// a result that fits its outputSchema?
// Author: @simplymanas
//
// Pure functions with no DOM or SDK access. The caller passes in `call(name, args)`, so the browser
// (app.js), the command line (cli.js) and the unit tests (test/smoke.test.js) share one implementation.

import { resultChars, BIG_RESULT_CHARS, approxTokens } from './lint.js';

export const NOT_READ_ONLY = 'not marked read-only';
const SKIPPED_ON_REQUEST = 'skipped on request';
const NOT_SELECTED = 'not selected';

const STRING_FORMATS = {
  uri: 'https://example.com', url: 'https://example.com', 'uri-reference': 'https://example.com',
  email: 'user@example.com', hostname: 'example.com', ipv4: '127.0.0.1', ipv6: '::1',
  date: '2026-01-01', 'date-time': '2026-01-01T00:00:00Z', time: '00:00:00Z', duration: 'PT1M',
  uuid: '00000000-0000-4000-8000-000000000000',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * A value for one JSON Schema.
 * `made` is false when the schema itself supplies the value (default, example, const, enum, boolean),
 * and true when it had to be made up (a placeholder string or number), which a server may well reject.
 */
export function sampleValue(s) {
  if (!s || typeof s !== 'object') return { value: 'test', made: true };
  if (s.default !== undefined) return { value: s.default, made: false };
  if (Array.isArray(s.examples) && s.examples.length) return { value: s.examples[0], made: false };
  if (s.const !== undefined) return { value: s.const, made: false };
  if (Array.isArray(s.enum) && s.enum.length) return { value: s.enum[0], made: false };
  const alternatives = s.oneOf ?? s.anyOf;
  if (Array.isArray(alternatives) && alternatives.length) return sampleValue(alternatives.find((a) => a?.type !== 'null') ?? alternatives[0]);

  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') ?? 'null' : s.type ?? (s.properties ? 'object' : undefined);
  switch (type) {
    case 'boolean': return { value: false, made: false };
    case 'null': return { value: null, made: false };
    case 'integer':
    case 'number': {
      const whole = type === 'integer';
      const [min, max, above, below] = [num(s.minimum), num(s.maximum), num(s.exclusiveMinimum), num(s.exclusiveMaximum)];
      let n = 1;
      if (min !== undefined && n < min) n = whole ? Math.ceil(min) : min;
      if (above !== undefined && n <= above) n = whole ? Math.floor(above) + 1 : above + 1;
      if (max !== undefined && n > max) n = whole ? Math.floor(max) : max;
      if (below !== undefined && n >= below) n = whole ? Math.ceil(below) - 1 : below - 1;
      return { value: n, made: true };
    }
    case 'string': {
      if (STRING_FORMATS[s.format]) return { value: STRING_FORMATS[s.format], made: true };
      let text = 'test';
      if (num(s.minLength) > text.length) text = text.padEnd(Math.min(s.minLength, 1000), 't');
      if (num(s.maxLength) < text.length) text = text.slice(0, Math.max(0, s.maxLength));
      return { value: text, made: true };
    }
    case 'array': {
      const count = Number.isInteger(s.minItems) && s.minItems > 0 ? Math.min(s.minItems, 5) : 0;
      return { value: Array.from({ length: count }, () => sampleValue(s.items).value), made: true };
    }
    case 'object': {
      const { args, made } = sampleArgs(s);
      return { value: args, made: made.length > 0 };
    }
    default: return { value: 'test', made: true };
  }
}

/**
 * Arguments for a tool: a value for every required parameter, and nothing for optional ones (the server
 * applies its own defaults). `made` lists the parameters whose value had to be made up.
 */
export function sampleArgs(inputSchema) {
  const props = inputSchema?.properties ?? {};
  const args = {};
  const made = [];
  for (const name of Array.isArray(inputSchema?.required) ? inputSchema.required : []) {
    const sample = sampleValue(props[name]);
    args[name] = sample.value;
    if (sample.made) made.push(name);
  }
  return { args, made };
}

/**
 * Decide what to do with each tool.
 * @param {object[]} tools  tools from tools/list
 * @param {object} [opts]
 *   all:   also run tools that aren't marked read-only (annotations.readOnlyHint)
 *   only:  tool names: run exactly these, read-only or not
 *   skip:  tool names to leave out
 *   given: { [toolName]: args } arguments supplied by the user, used as they are
 * @returns {{tool: string, run: boolean, reason?: string, args?: object, source?: 'given'|'schema'|'made-up', made?: string[]}[]}
 */
export function planSmoke(tools, { all = false, only = [], skip = [], given = {} } = {}) {
  const picked = new Set(only);
  const dropped = new Set(skip);
  return tools.map((t) => {
    if (dropped.has(t.name)) return { tool: t.name, run: false, reason: SKIPPED_ON_REQUEST };
    if (picked.size && !picked.has(t.name)) return { tool: t.name, run: false, reason: NOT_SELECTED };
    if (t.annotations?.readOnlyHint !== true && !all && !picked.has(t.name)) return { tool: t.name, run: false, reason: NOT_READ_ONLY };
    if (Object.hasOwn(given, t.name)) return { tool: t.name, run: true, args: given[t.name], source: 'given', made: [] };
    const { args, made } = sampleArgs(t.inputSchema);
    return { tool: t.name, run: true, args, source: made.length ? 'made-up' : 'schema', made };
  });
}

const connectionClosed = (o) => o.code === -32000 || /connection closed|not connected|session not found/i.test(String(o.error ?? ''));
const oneLine = (text, max = 160) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/**
 * Judge one call.
 * @param {object} item     an entry from planSmoke() with run: true
 * @param {object} outcome  { ok: true, result, ms } or { ok: false, error, code, ms }
 * @returns {{status: 'pass'|'warn'|'fail'|'skip', msg: string}}
 */
export function judge(item, outcome) {
  const madeUp = item.source === 'made-up';
  const forArgs = madeUp ? ` for the made-up ${item.made.map((n) => `"${n}"`).join(', ') || 'arguments'}` : '';

  if (!outcome.ok) {
    const text = oneLine(String(outcome.error ?? 'unknown error').replace(/^(?:MCP error -?\d+:\s*)+/, ''));
    if (/requires task-based execution/i.test(text)) return { status: 'skip', msg: 'needs task-based execution, which the tester does not support yet' };
    if (outcome.code === -32001 || /timed out/i.test(text)) return { status: 'fail', msg: `no answer: timed out after ${Math.round(outcome.ms ?? 0)} ms` };
    if (connectionClosed(outcome)) return { status: 'fail', msg: 'the server closed the connection during the call' };
    if (/output schema|structured content/i.test(text)) return { status: 'fail', msg: `result breaks its outputSchema: ${text}` };
    // A server may rightly refuse a made-up value. Refusing its own defaults, or the user's arguments, is a failure.
    if (outcome.code === -32602 && madeUp) return { status: 'warn', msg: `rejected the call${forArgs}: ${text}` };
    return { status: 'fail', msg: `protocol error${outcome.code !== null && outcome.code !== undefined ? ` ${outcome.code}` : ''}: ${text}` };
  }

  const result = outcome.result ?? {};
  if (result.isError) {
    const text = oneLine((result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join(' ')) || 'no message';
    return madeUp
      ? { status: 'warn', msg: `returned an error${forArgs}: ${text}` }
      : { status: 'fail', msg: `returned an error: ${text}` };
  }
  const chars = resultChars(result);
  if (chars > BIG_RESULT_CHARS) return { status: 'warn', msg: `answered with ~${approxTokens(chars)} tokens of output: cap it, paginate or summarize` };
  return { status: 'pass', msg: '' };
}

/**
 * Run a plan, one tool at a time and in order.
 * @param {object[]} plan  from planSmoke()
 * @param {(name: string, args: object) => Promise<object>} call  resolves to an outcome (see judge); never rejects
 * @param {(result: object, index: number) => void} [onResult]  called as each tool finishes
 * @returns {Promise<{tool: string, status: string, msg: string, ms?: number, args?: object, source?: string}[]>}
 */
export async function runSmoke(plan, call, onResult = () => {}) {
  const results = [];
  let closedDuring = null;
  for (const item of plan) {
    let result;
    if (!item.run) {
      result = { tool: item.tool, status: 'skip', msg: item.reason };
    } else if (closedDuring !== null) {
      result = { tool: item.tool, status: 'skip', msg: `not run: the server connection closed during "${closedDuring}"` };
    } else {
      const outcome = await call(item.tool, item.args);
      result = { tool: item.tool, ...judge(item, outcome), ms: Math.round(outcome.ms ?? 0), args: item.args, source: item.source };
      if (!outcome.ok && connectionClosed(outcome)) closedDuring = item.tool;
    }
    results.push(result);
    onResult(result, results.length - 1);
  }
  return results;
}

export function countSmoke(results) {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) counts[r.status]++;
  return counts;
}

/**
 * The tools that went untested without the user leaving them out: not marked read-only, listed after a
 * tool that took the server down, and so on. A pass says nothing about these.
 */
export function untestedTools(results) {
  return results.filter((r) => r.status === 'skip' && r.msg !== SKIPPED_ON_REQUEST && r.msg !== NOT_SELECTED);
}

/**
 * Whether a finished run counts as failed. A run that called nothing has proved nothing, so it fails too.
 * Each level includes the ones before it:
 *   fail: a tool failed
 *   warn: or a tool gave a warning
 *   skip: or a tool went untested without being left out on purpose (see untestedTools)
 * @param {'fail'|'warn'|'skip'|'never'} failOn
 */
export function smokeFailed(results, failOn = 'fail') {
  if (failOn === 'never') return false;
  const counts = countSmoke(results);
  if (counts.pass + counts.warn + counts.fail === 0) return true;
  if (counts.fail > 0) return true;
  if (failOn !== 'fail' && counts.warn > 0) return true;
  return failOn === 'skip' && untestedTools(results).length > 0;
}
