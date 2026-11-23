// MCP Master Tester — tool-list lockfile and breaking-change diff
// Author: @simplymanas
//
// snapshotTools() turns a server's tool list into a lockfile: sorted, with nothing that changes on its
// own (no dates, no server version), so it only shows up in a pull request when the tools change.
// diffTools() compares two snapshots and grades each change:
//   breaking  existing callers or clients can fail: a tool or parameter removed, a new required
//             parameter, a narrower type, an enum value removed, an output field that may be missing
//   warn      worth a look: a changed description (models read it on every request, and a changed
//             description is how a tool can be repurposed), changed annotations or defaults, or a schema
//             change this check can't classify
//   info      additive: a new tool, a new optional parameter, a wider type
// Pure functions, shared by the CLI and the unit tests.

export const LOCKFILE_VERSION = 1;
export const DEFAULT_LOCKFILE = 'mcp-tools.lock.json';
export const DIFF_LEVELS = ['breaking', 'warn', 'info'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const json = (v) => JSON.stringify(v);

// Object keys sorted at every level, so the same tools always give the same text.
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}

const TOOL_FIELDS = ['title', 'description', 'inputSchema', 'outputSchema', 'annotations'];

export function snapshotTools(tools, server = {}) {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries = sorted.map((t) => [t.name, canonical(Object.fromEntries(TOOL_FIELDS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]])))]);
  return { lockfileVersion: LOCKFILE_VERSION, server: server.name ?? null, tools: Object.fromEntries(entries) };
}

export const lockfileText = (lock) => `${JSON.stringify(lock, null, 2)}\n`;

export function parseLockfile(text) {
  let lock;
  try { lock = JSON.parse(text); } catch (err) { throw new Error(`not valid JSON: ${err.message}`); }
  if (!isObject(lock) || !isObject(lock.tools)) throw new Error('not a tool lockfile: it has no "tools" object');
  if (lock.lockfileVersion !== LOCKFILE_VERSION) throw new Error(`lockfileVersion ${json(lock.lockfileVersion)} is not supported (expected ${LOCKFILE_VERSION})`);
  return lock;
}

// ---------------------------------------------------------------- schemas

const HANDLED = new Set(['type', 'enum', 'properties', 'required', 'items', 'description', 'default', 'title', 'examples',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
const LOWER = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems']; // raising one rejects values that passed
const UPPER = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems']; // lowering one does

const typeSet = (s) => (isObject(s) && s.type !== undefined ? [].concat(s.type) : null); // null: any type
const accepts = (set, t) => set === null || set.includes(t) || (t === 'integer' && set.includes('number'));
const covers = (wide, narrow) => wide === null || (narrow !== null && narrow.every((t) => accepts(wide, t)));
const typeText = (set) => (set === null ? 'any type' : set.join(' or '));

// Compares two JSON Schemas. In "input" a change breaks callers when the new schema rejects something the
// old one accepted; in "output" it breaks clients when the server may now send something the old schema
// ruled out, or leave out something it promised.
function compareSchema(a, b, path, dir, add) {
  if (!isObject(a) || !isObject(b)) { if (json(a) !== json(b)) add('warn', `${where(path, dir)}: schema changed`); return; }
  const input = dir === 'input';

  const ta = typeSet(a); const tb = typeSet(b);
  if (json(ta) !== json(tb)) {
    const fine = input ? covers(tb, ta) : covers(ta, tb);
    add(fine ? 'info' : 'breaking', `${where(path, dir)}: type changed from ${typeText(ta)} to ${typeText(tb)}`);
  }

  if (json(a.enum) !== json(b.enum)) {
    const ea = Array.isArray(a.enum) ? a.enum.map(json) : null;
    const eb = Array.isArray(b.enum) ? b.enum.map(json) : null;
    if (ea && !eb) add(input ? 'info' : 'warn', `${where(path, dir)}: no longer limited to a list of values`);
    else if (!ea && eb) add(input ? 'breaking' : 'info', `${where(path, dir)}: now limited to ${eb.join(', ')}`);
    else {
      const removed = ea.filter((v) => !eb.includes(v));
      const added = eb.filter((v) => !ea.includes(v));
      if (removed.length) add(input ? 'breaking' : 'info', `${where(path, dir)}: no longer ${input ? 'accepts' : 'returns'} ${removed.join(', ')}`);
      if (added.length) add(input ? 'info' : 'warn', `${where(path, dir)}: new value${added.length === 1 ? '' : 's'} ${added.join(', ')}${input ? '' : ', which clients may not expect'}`);
    }
  }

  for (const k of [...LOWER, ...UPPER]) {
    if (a[k] === b[k]) continue;
    if ((a[k] !== undefined && typeof a[k] !== 'number') || (b[k] !== undefined && typeof b[k] !== 'number')) continue; // left to the catch-all below
    const tighter = b[k] !== undefined && (a[k] === undefined || (LOWER.includes(k) ? b[k] > a[k] : b[k] < a[k]));
    add(input && tighter ? 'breaking' : 'info', `${where(path, dir)}: ${k} ${a[k] ?? 'none'} → ${b[k] ?? 'none'}`);
  }

  if (path && (a.description ?? '') !== (b.description ?? '')) add('warn', `${where(path, dir)}: description changed`);
  if (input && json(a.default) !== json(b.default)) add('warn', `${where(path, dir)}: default changed from ${json(a.default) ?? 'none'} to ${json(b.default) ?? 'none'}, so calls that leave it out behave differently`);

  if (isObject(a.properties) || isObject(b.properties)) {
    const pa = isObject(a.properties) ? a.properties : {};
    const pb = isObject(b.properties) ? b.properties : {};
    const ra = new Set(Array.isArray(a.required) ? a.required : []);
    const rb = new Set(Array.isArray(b.required) ? b.required : []);
    for (const name of Object.keys(pa)) {
      const p = join(path, name);
      if (!(name in pb)) {
        if (input) add('breaking', `${where(p, dir)}: removed, so calls that send it may be rejected`);
        else add(ra.has(name) ? 'breaking' : 'warn', `${where(p, dir)}: removed`);
        continue;
      }
      if (ra.has(name) !== rb.has(name)) {
        const nowRequired = rb.has(name);
        if (input) add(nowRequired ? 'breaking' : 'info', `${where(p, dir)}: ${nowRequired ? 'now required' : 'now optional'}`);
        else add(nowRequired ? 'info' : 'breaking', `${where(p, dir)}: ${nowRequired ? 'now always present' : 'no longer always present'}`);
      }
      compareSchema(pa[name], pb[name], p, dir, add);
    }
    for (const name of Object.keys(pb)) {
      if (name in pa) continue;
      const p = join(path, name);
      if (input) add(rb.has(name) ? 'breaking' : 'info', `${where(p, dir)}: new ${rb.has(name) ? 'required parameter, so existing calls without it fail' : 'optional parameter'}`);
      else add('info', `${where(p, dir)}: new field`);
    }
  }

  if (a.items !== undefined || b.items !== undefined) {
    if (a.items === undefined || b.items === undefined) add('warn', `${where(`${path}[]`, dir)}: item schema ${a.items === undefined ? 'added' : 'removed'}`);
    else compareSchema(a.items, b.items, `${path}[]`, dir, add);
  }

  const rest = (s) => json(canonical(Object.fromEntries(Object.entries(s).filter(([k, v]) => !HANDLED.has(k) || ([...LOWER, ...UPPER].includes(k) && typeof v !== 'number')))));
  if (rest(a) !== rest(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !HANDLED.has(k) && json(a[k]) !== json(b[k]));
    add('warn', `${where(path, dir)}: ${keys.join(', ') || 'schema'} changed in a way this check can't classify; review it`);
  }
}

const join = (path, name) => (path ? `${path}.${name}` : name);
const where = (path, dir) => (path ? `${dir === 'input' ? 'parameter' : 'output field'} "${path}"` : dir === 'input' ? 'input' : 'output');

// ---------------------------------------------------------------- tools

/**
 * What changed between two snapshots, worst first.
 * @returns {{sev: 'breaking'|'warn'|'info', target: string, msg: string}[]}
 */
export function diffTools(before, after) {
  const out = [];
  const a = before.tools ?? {};
  const b = after.tools ?? {};
  for (const name of Object.keys(a)) {
    const add = (sev, msg) => out.push({ sev, target: name, msg });
    if (!(name in b)) { add('breaking', 'tool removed'); continue; }
    const ta = a[name]; const tb = b[name];
    if ((ta.description ?? '') !== (tb.description ?? '')) {
      add('warn', `description changed (${(ta.description ?? '').length} → ${(tb.description ?? '').length} characters): models read it on every request, so check the new text`);
    }
    if ((ta.title ?? '') !== (tb.title ?? '')) add('info', `title changed from ${json(ta.title ?? null)} to ${json(tb.title ?? null)}`);
    const ha = isObject(ta.annotations) ? ta.annotations : {};
    const hb = isObject(tb.annotations) ? tb.annotations : {};
    for (const k of [...new Set([...Object.keys(ha), ...Object.keys(hb)])].sort()) {
      if (json(ha[k]) === json(hb[k])) continue;
      const note = k === 'readOnlyHint' && hb[k] === true ? ': clients may now call it without asking the user'
        : k === 'destructiveHint' && hb[k] === true ? ': clients may now ask before calling it' : '';
      add('warn', `annotation ${k} changed from ${json(ha[k]) ?? 'unset'} to ${json(hb[k]) ?? 'unset'}${note}`);
    }
    compareSchema(ta.inputSchema ?? {}, tb.inputSchema ?? {}, '', 'input', add);
    if (ta.outputSchema && !tb.outputSchema) add('breaking', 'outputSchema removed: clients that read structuredContent lose it');
    else if (!ta.outputSchema && tb.outputSchema) add('info', 'outputSchema added');
    else if (ta.outputSchema) compareSchema(ta.outputSchema, tb.outputSchema, '', 'output', add);
  }
  for (const name of Object.keys(b)) if (!(name in a)) out.push({ sev: 'info', target: name, msg: 'new tool' });

  const order = { breaking: 0, warn: 1, info: 2 };
  return out.sort((x, y) => order[x.sev] - order[y.sev] || (x.target < y.target ? -1 : x.target > y.target ? 1 : 0));
}
