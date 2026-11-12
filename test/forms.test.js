// Unit tests for the schema forms: schemas come from the server, so nothing in one may become markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, fieldHtml, formFields } from '../public/forms.js';

// Each payload tries both ways in: close the attribute it lands in and add a handler to the same
// element, then close the element and add a new one.
const hostile = (tag) => `"' onmouseover="window.__xss_${tag}=1" x="'><img src=x onerror="window.__xss_${tag}=1">`;

// The tags and attributes the form builders write themselves. Anything else came from the schema.
const OWN_TAGS = new Set(['div', 'span', 'input', 'select', 'option', 'textarea', 'button', 'p']);
const OWN_ATTRS = new Set(['class', 'data-name', 'data-kind', 'data-act', 'type', 'step', 'value', 'min', 'max',
  'multiple', 'size', 'selected', 'placeholder', 'spellcheck', 'autocomplete']);

function assertNoInjectedMarkup(html, what) {
  for (const [tag, name, attrs] of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    assert.ok(OWN_TAGS.has(name.toLowerCase()), `${what}: schema text became a <${name}> element\n${html}`);
    const leftover = attrs.replace(/\s+([a-zA-Z-]+)(?:="[^"]*")?/g, (m, attr) => {
      assert.ok(OWN_ATTRS.has(attr.toLowerCase()), `${what}: schema text became the attribute "${attr}" in ${tag}`);
      return '';
    });
    assert.match(leftover, /^\s*\/?$/, `${what}: schema text broke out of an attribute in ${tag}`);
  }
}

test('the checker itself catches injected elements and attributes', () => {
  assert.throws(() => assertNoInjectedMarkup('<div class="fd"><img src=x onerror="x"></div>', 'element'));
  assert.throws(() => assertNoInjectedMarkup('<input type="number" min="" onmouseover="x" x="" />', 'attribute'));
  assert.throws(() => assertNoInjectedMarkup(`<input value=""' />`, 'stray quote'));
  assertNoInjectedMarkup('<input type="number" step="1" value="&quot; onmouseover=&quot;x" min="0" />', 'escaped');
});

test('esc() escapes every character that can start markup or end an attribute', () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
});

test('a number field ignores a minimum or maximum that is not a number', () => {
  const html = fieldHtml('n', { type: 'integer', minimum: hostile('min'), maximum: hostile('max') }, false);
  assertNoInjectedMarkup(html, 'minimum/maximum');
  assert.doesNotMatch(html, /\bmin=|\bmax=/);
});

test('a number field keeps a numeric minimum and maximum', () => {
  const html = fieldHtml('n', { type: 'number', minimum: 0, maximum: 2.5 }, false);
  assert.match(html, /min="0"/);
  assert.match(html, /max="2\.5"/);
  assert.doesNotMatch(fieldHtml('n', { type: 'number', minimum: Infinity }, false), /\bmin=/);
});

test('hostile text in any schema slot is shown as text, never as markup', () => {
  const schema = {
    type: 'object',
    required: ['n', hostile('req')],
    properties: {
      n: { type: 'integer', minimum: hostile('min'), maximum: hostile('max'), default: hostile('ndef'), description: hostile('ndesc') },
      f: { type: 'number', minimum: {}, maximum: [hostile('arr')] },
      e: { enum: [hostile('enum'), 'b'], enumNames: [hostile('ename')], default: hostile('enum') },
      c: { oneOf: [{ const: hostile('const'), title: hostile('ctitle') }] },
      m: { type: 'array', items: { enum: [hostile('multi')] }, default: [hostile('multi')] },
      md: { type: 'array', items: { enum: ['a'] }, default: hostile('notarray') },
      s: { type: 'string', format: hostile('fmt'), pattern: hostile('pat'), default: hostile('sdef') },
      p: { type: 'string', pattern: hostile('pat') },
      body: { type: 'string', default: `</textarea>${hostile('long')}` },
      api_key: { type: 'string', default: hostile('secret') },
      j: { type: 'object', default: { k: `</textarea>${hostile('json')}` } },
      t: { type: ['string', hostile('type')] },
      u: { type: hostile('utype') },
      b: { type: 'boolean', default: hostile('bool'), description: hostile('bdesc') },
      [`k${hostile('key')}`]: { type: 'string' },
    },
  };
  const html = formFields(schema);
  assertNoInjectedMarkup(html, 'schema');
  // The hostile text is still there for the user to read, escaped.
  assert.match(html, /&lt;img src=x onerror=&quot;window\.__xss_ndesc=1&quot;&gt;/);
  // The same holds when hostile text arrives as the values to prefill.
  const values = Object.fromEntries(Object.keys(schema.properties).map((k) => [k, hostile('val')]));
  assertNoInjectedMarkup(formFields(schema, values), 'prefilled values');
});

test('formFields handles an empty or malformed schema', () => {
  assert.match(formFields(undefined), /No arguments/);
  assert.match(formFields({ type: 'object' }), /No arguments/);
  assert.match(formFields({ properties: { a: { type: 'string' } }, required: 'a' }), /data-name="a"/);
});
