// MCP Master Tester — schema forms
// Builds the argument form for a JSON Schema as an HTML string. Pure functions with no DOM access, so the
// unit tests can check them. Schemas come from the server and are untrusted: every value that reaches the
// HTML goes through esc(), or is checked to be a number.
// Author: @simplymanas

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const SECRET_RE = /key|token|secret|pass(word)?|auth|credential|bearer|cookie/i;

const primaryType = (s) => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type);

// A schema can put anything in `minimum` and `maximum`; only a real number becomes an attribute.
const numAttr = (name, v) => (typeof v === 'number' && Number.isFinite(v) ? `${name}="${v}"` : '');

// Enum options from `enum` (+ legacy `enumNames`) or a oneOf/anyOf of `const` values.
function enumOptions(s) {
  if (Array.isArray(s.enum)) return s.enum.map((value, i) => ({ value, label: s.enumNames?.[i] ?? value }));
  const alts = s.oneOf ?? s.anyOf;
  if (alts?.length && alts.every((a) => 'const' in a)) return alts.map((a) => ({ value: a.const, label: a.title ?? a.const }));
  return null;
}

function fieldKind(s) {
  if (enumOptions(s)) return 'enum';
  const t = primaryType(s);
  if (t === 'array' && s.items && enumOptions(s.items)) return 'multi';
  if (t === 'boolean') return 'bool';
  if (t === 'integer') return 'int';
  if (t === 'number') return 'num';
  if (t === 'string' && !s.anyOf && !s.oneOf) return 'str';
  return 'json';
}

export function fieldHtml(name, s, required, value) {
  const kind = fieldKind(s);
  const v = value !== undefined ? value : s.default;
  const typeLabel = Array.isArray(s.type) ? s.type.join('|') : (s.type ?? (s.anyOf || s.oneOf ? 'union' : 'any'));
  let input;
  if (kind === 'enum') {
    const opts = enumOptions(s).map((o) => `<option value="${esc(JSON.stringify(o.value))}" ${JSON.stringify(o.value) === JSON.stringify(v) ? 'selected' : ''}>${esc(o.label)}</option>`);
    input = `<select><option value="">${required ? '— choose —' : '(unset)'}</option>${opts.join('')}</select>`;
  } else if (kind === 'multi') {
    const opts = enumOptions(s.items);
    const chosen = new Set((Array.isArray(v) ? v : []).map((x) => JSON.stringify(x)));
    input = `<select multiple size="${Math.min(opts.length, 6)}">${opts.map((o) => `<option value="${esc(JSON.stringify(o.value))}" ${chosen.has(JSON.stringify(o.value)) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (kind === 'bool') {
    input = `<select><option value="">(unset)</option><option value="true" ${v === true ? 'selected' : ''}>true</option><option value="false" ${v === false ? 'selected' : ''}>false</option></select>`;
  } else if (kind === 'int' || kind === 'num') {
    input = `<input type="number" step="${kind === 'int' ? 1 : 'any'}" value="${esc(v ?? '')}" ${numAttr('min', s.minimum)} ${numAttr('max', s.maximum)} />`;
  } else if (kind === 'str') {
    const secret = SECRET_RE.test(name) || s.format === 'password' || s.writeOnly;
    const long = (s.maxLength ?? 0) > 200 || /content|body|text|code|script|markdown|query/i.test(name);
    if (secret) input = `<div class="secret-wrap"><input type="password" value="${esc(v ?? '')}" autocomplete="off" spellcheck="false" /><button type="button" class="btn tiny" data-act="reveal">show</button></div>`;
    else if (long) input = `<textarea spellcheck="false">${esc(v ?? '')}</textarea>`;
    else input = `<input value="${esc(v ?? '')}" spellcheck="false" placeholder="${esc(s.format ? `format: ${s.format}` : s.pattern ?? '')}" />`;
  } else {
    input = `<textarea spellcheck="false" placeholder="JSON">${v === undefined ? '' : esc(JSON.stringify(v, null, 2))}</textarea>`;
  }
  return `<div class="field" data-name="${esc(name)}" data-kind="${kind}">
    <div class="fl">${esc(name)} <span class="ft">${esc(typeLabel)}</span>${required ? '<span class="req">*</span>' : ''}</div>
    ${s.description ? `<div class="fd">${esc(s.description)}</div>` : ''}
    ${input}
  </div>`;
}

export function formFields(schema, values = {}) {
  const props = schema?.properties ?? {};
  const req = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const names = Object.keys(props);
  if (!names.length) return '<p class="hint">No arguments.</p>';
  return names.map((n) => fieldHtml(n, props[n], req.has(n), values?.[n])).join('');
}
