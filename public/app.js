// MCP Master Tester — UI
// Author: @simplymanas

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SECRET_RE = /key|token|secret|pass(word)?|auth|credential|bearer|cookie/i;

const state = {
  transport: 'stdio',
  env: [],
  headers: [],
  bearerRequired: false,
  session: null,
  events: null,
  tools: [], resources: [], templates: [], prompts: [], lint: [],
  tab: 'tools',
  selected: null,         // key of selected item in current tab
  rawMode: false,
  draft: null,            // argument values shown in the current form
  results: {},            // itemKey -> last response
  history: {},            // itemKey -> [{args, ok, ms, ts}]
  pending: new Map(),     // rpc correlation for latency
  logFilters: { rpc: true, stderr: true, log: true },
};

// ---------------------------------------------------------------- API

async function api(path, body, method = 'POST') {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw Object.assign(new Error(json.error), json);
  return json;
}

const sessionApi = (path, body) => api(`/sessions/${state.session.id}${path}`, body ?? {});

async function listAll(path, key) {
  const items = [];
  let cursor;
  do {
    const { result } = await sessionApi(path, cursor ? { cursor } : {});
    items.push(...result[key]);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

// ---------------------------------------------------------------- connection form

function kvRowHtml(kind, row, i) {
  return `<div class="kv-row" data-kind="${kind}" data-i="${i}">
    <input data-f="key" value="${esc(row.key)}" placeholder="${kind === 'env' ? 'NAME' : 'Header'}" spellcheck="false" />
    <input data-f="value" type="${row.secret ? 'password' : 'text'}" value="${esc(row.value)}" placeholder="value" spellcheck="false" autocomplete="off" />
    <button data-act="secret" class="${row.secret ? 'on' : ''}" title="Treat as secret (masked, never saved)">🔒</button>
    <button data-act="del" title="Remove">✕</button>
  </div>`;
}

function renderKv() {
  $('#envRows').innerHTML = state.env.map((r, i) => kvRowHtml('env', r, i)).join('');
  $('#headerRows').innerHTML = state.headers.map((r, i) => kvRowHtml('headers', r, i)).join('');
}

function setTransport(t) {
  state.transport = t;
  document.querySelectorAll('#transportSeg button').forEach((b) => b.classList.toggle('active', b.dataset.t === t));
  $('#stdioFields').hidden = t !== 'stdio';
  $('#httpFields').hidden = t === 'stdio';
}

function splitArgs(str) {
  return [...str.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

const kvToObject = (rows) => Object.fromEntries(rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

function buildConfig() {
  if (state.transport === 'stdio') {
    return { transport: 'stdio', command: $('#command').value.trim(), args: splitArgs($('#args').value), cwd: $('#cwd').value.trim(), env: kvToObject(state.env) };
  }
  const headers = kvToObject(state.headers);
  const bearer = $('#bearer').value.trim();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return { transport: state.transport, url: $('#url').value.trim(), headers };
}

// Ask the user for every secret that is declared but empty.
async function ensureSecrets() {
  const missing = [];
  const rows = state.transport === 'stdio' ? state.env : state.headers;
  rows.forEach((r) => { if (r.secret && r.key.trim() && !r.value) missing.push({ label: r.key, row: r }); });
  if (state.transport !== 'stdio' && state.bearerRequired && !$('#bearer').value) missing.push({ label: 'Bearer token', bearer: true });
  if (!missing.length) return true;

  return openModal(`
    <h3>Secrets required</h3>
    <p class="hint">This profile needs values that are never stored. They stay in memory for this tab only.</p>
    ${missing.map((m, i) => `<label>${esc(m.label)}<input name="s${i}" type="password" required autocomplete="off" /></label>`).join('')}
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Connect</button></div>`,
  (action, form) => {
    if (action !== 'ok') return false;
    missing.forEach((m, i) => {
      const v = form.elements[`s${i}`].value;
      if (m.bearer) $('#bearer').value = v; else m.row.value = v;
    });
    renderKv();
    return true;
  });
}

async function connect() {
  if (state.session) await disconnect();
  if (!(await ensureSecrets())) return;
  const config = buildConfig();
  setStatus('connecting');
  $('#connectError').hidden = true;
  try {
    const { result } = await api('/sessions', config);
    state.session = result;
    onConnected();
  } catch (err) {
    setStatus('disconnected');
    if (err.authRequired && config.transport !== 'stdio') return askForToken(err.error);
    showConnectError(err);
  }
}

function askForToken(message) {
  openModal(`
    <h3>Authentication required</h3>
    <p class="hint">${esc(message)}</p>
    <label>Bearer token<input name="token" type="password" required autocomplete="off" /></label>
    <p class="hint">Sent as <code>Authorization: Bearer …</code>. For other schemes, add a header in the connection panel.</p>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Retry</button></div>`,
  (action, form) => {
    if (action !== 'ok') return false;
    $('#bearer').value = form.elements.token.value;
    setTimeout(connect);
    return true;
  });
}

function showConnectError(err) {
  const box = $('#connectError');
  const stderr = err.stderr ? `\n\n— stderr —\n${err.stderr}` : '';
  const looksLikeKey = /api[_\s-]?key|token|unauthori|credential|missing.*env|environment variable/i.test(`${err.error} ${err.stderr ?? ''}`);
  box.innerHTML = `${esc(err.error)}${esc(stderr)}${looksLikeKey && state.transport === 'stdio'
    ? '\n\n<button class="btn tiny" id="addKeyBtn">This server looks like it needs a key — add one</button>' : ''}`;
  box.hidden = false;
  $('#addKeyBtn')?.addEventListener('click', () => {
    openModal(`
      <h3>Add a key</h3>
      <p class="hint">Passed to the server process as an environment variable.</p>
      <label>Variable name<input name="k" required placeholder="e.g. GITHUB_PERSONAL_ACCESS_TOKEN" spellcheck="false" /></label>
      <label>Value<input name="v" type="password" required autocomplete="off" /></label>
      <div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Add &amp; reconnect</button></div>`,
    (action, form) => {
      if (action !== 'ok') return false;
      state.env.push({ key: form.elements.k.value.trim(), value: form.elements.v.value, secret: true });
      renderKv();
      setTimeout(connect);
      return true;
    });
  });
}

async function disconnect() {
  const s = state.session;
  state.session = null;
  state.events?.close();
  state.events = null;
  if (s) await api(`/sessions/${s.id}`, undefined, 'DELETE').catch(() => {});
  Object.assign(state, { tools: [], resources: [], templates: [], prompts: [], lint: [], selected: null, results: {}, history: {} });
  setStatus('disconnected');
  render();
}

function setStatus(s) {
  const el = $('#status');
  el.className = `status ${s}`;
  el.textContent = s;
  const on = s === 'connected';
  $('#pingBtn').disabled = !on;
  $('#disconnectBtn').disabled = !on;
  $('#logLevel').disabled = !(on && state.session?.capabilities?.logging);
  const si = state.session?.serverInfo;
  $('#serverMeta').textContent = on && si ? `${si.name} v${si.version}${state.session.protocolVersion ? ` · protocol ${state.session.protocolVersion}` : ''}` : '';
}

async function onConnected() {
  setStatus('connected');
  state.events = new EventSource(`/api/sessions/${state.session.id}/events`);
  state.events.onmessage = (e) => onEvent(JSON.parse(e.data));
  await refreshLists();
}

async function refreshLists(only) {
  const caps = state.session.capabilities ?? {};
  const jobs = [];
  if (caps.tools && (!only || only === 'tools')) jobs.push(listAll('/tools/list', 'tools').then((v) => { state.tools = v; }));
  if (caps.resources && (!only || only === 'resources')) {
    jobs.push(listAll('/resources/list', 'resources').then((v) => { state.resources = v; }));
    jobs.push(sessionApi('/resources/templates').then(({ result }) => { state.templates = result.resourceTemplates; }));
  }
  if (caps.prompts && (!only || only === 'prompts')) jobs.push(listAll('/prompts/list', 'prompts').then((v) => { state.prompts = v; }));
  const failures = (await Promise.allSettled(jobs)).filter((r) => r.status === 'rejected');
  failures.forEach((f) => addLogRow({ ts: Date.now(), type: 'error', message: `list failed: ${f.reason.message}` }));
  state.lint = lintServer();
  render();
}

// ---------------------------------------------------------------- events & log

function onEvent(e) {
  if (e.type === 'elicit') return handleElicitation(e);
  if (e.type === 'progress') {
    const btn = document.querySelector('[data-act="run"]:disabled,[data-act="read"]:disabled');
    const { progress, total, message } = e.params;
    if (btn) btn.textContent = `Running… ${progress}${total ? `/${total}` : ''}${message ? ` ${message}` : ''}`;
    return;
  }
  if (e.type === 'list_changed') { addLogRow({ ...e, type: 'log', params: { level: 'notice', data: `${e.kind}/list_changed` } }); return refreshLists(e.kind); }
  if (e.type === 'closed') { addLogRow({ ...e, type: 'error', message: 'connection closed by server' }); if (state.session) { state.session = null; setStatus('disconnected'); } return; }
  addLogRow(e);
}

function addLogRow(e) {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.dataset.type = e.type === 'error' ? 'log' : e.type;
  let dir = '', summary = '', ms = '', payload = null;

  if (e.type === 'rpc') {
    const m = e.msg;
    dir = e.dir === 'out' ? '→' : '←';
    payload = m;
    const corr = (side) => `${side}:${m.id}`;
    if (m.method && m.id !== undefined) { // request
      state.pending.set(corr(e.dir === 'out' ? 'c' : 's'), e.ts);
      summary = `${m.method} #${m.id}${m.params?.name ? ` (${m.params.name})` : ''}`;
    } else if (m.method) {
      summary = `${m.method} (notification)`;
    } else {
      const key = corr(e.dir === 'in' ? 'c' : 's');
      if (state.pending.has(key)) { ms = `${e.ts - state.pending.get(key)} ms`; state.pending.delete(key); }
      summary = m.error ? `error #${m.id}: ${m.error.message}` : `result #${m.id}`;
      if (m.error || m.result?.isError) row.classList.add('err');
    }
  } else if (e.type === 'stderr') {
    dir = '⚠'; summary = e.text.trimEnd(); row.classList.add('stderr'); payload = e.text;
  } else if (e.type === 'log') {
    dir = '✎'; payload = e.params;
    summary = `[${e.params?.level ?? 'log'}]${e.params?.logger ? ` ${e.params.logger}:` : ''} ${typeof e.params?.data === 'string' ? e.params.data : JSON.stringify(e.params?.data)}`;
  } else {
    dir = '✕'; summary = e.message; row.classList.add('err');
  }

  row.innerHTML = `<span class="lt">${new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span><span class="ld ${e.dir ?? ''}">${dir}</span><span class="lm">${esc(summary)}</span><span class="lms">${ms}</span>`;
  row.hidden = !state.logFilters[row.dataset.type];
  row.addEventListener('click', (ev) => {
    if (ev.target.closest('pre')) return;
    const open = row.querySelector('pre');
    if (open) return open.remove();
    row.insertAdjacentHTML('beforeend', `<pre>${typeof payload === 'string' ? esc(payload) : highlight(payload)}</pre>`);
  });

  const body = $('#logBody');
  const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 20;
  body.appendChild(row);
  while (body.childElementCount > 1500) body.firstElementChild.remove();
  if (stick) body.scrollTop = body.scrollHeight;
}

// ---------------------------------------------------------------- elicitation

function handleElicitation(e) {
  const p = e.params;
  const answer = (body) => api(`/sessions/${state.session.id}/elicit/${e.reqId}`, body);

  if (p.mode === 'url') {
    return openModal(`
      <h3>Server requests you visit a URL</h3>
      <p>${esc(p.message)}</p>
      <p><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a></p>
      <div class="actions"><button class="btn" value="decline">Decline</button><button class="btn primary" value="accept">Done</button></div>`,
    (action) => { answer({ action: action === 'accept' ? 'accept' : 'decline' }); return true; });
  }

  const schema = p.requestedSchema ?? { type: 'object', properties: {} };
  openModal(`
    <h3>Server is asking for input</h3>
    <p>${esc(p.message)}</p>
    <div id="elicitFields">${formFields(schema)}</div>
    <div class="actions">
      <button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn" value="decline" formnovalidate>Decline</button>
      <button class="btn primary" value="accept">Submit</button>
    </div>`,
  (action, form) => {
    if (action !== 'accept') { answer({ action }); return true; }
    const { args, ok } = collectArgs(form.querySelector('#elicitFields'), schema);
    if (!ok) return false;
    answer({ action: 'accept', content: args });
    return true;
  });
}

// ---------------------------------------------------------------- modal

function openModal(html, onAction) {
  const dlg = $('#modal');
  const form = $('#modalForm');
  form.innerHTML = html;
  return new Promise((resolve) => {
    form.onsubmit = (ev) => {
      ev.preventDefault();
      const action = ev.submitter?.value ?? 'cancel';
      const result = onAction(action, form);
      if (result === false && action !== 'cancel' && action !== 'decline') return; // validation failed: keep open
      dlg.close();
      resolve(result !== false);
    };
    dlg.oncancel = () => { onAction('cancel', form); resolve(false); };
    dlg.showModal();
    form.querySelector('input,select,textarea')?.focus();
  });
}

// ---------------------------------------------------------------- schema forms

const primaryType = (s) => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type);

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

function fieldHtml(name, s, required, value) {
  const kind = fieldKind(s);
  const v = value !== undefined ? value : s.default;
  const typeLabel = Array.isArray(s.type) ? s.type.join('|') : (s.type ?? (s.anyOf || s.oneOf ? 'union' : 'any'));
  let input;
  if (kind === 'enum') {
    const opts = enumOptions(s).map((o) => `<option value="${esc(JSON.stringify(o.value))}" ${JSON.stringify(o.value) === JSON.stringify(v) ? 'selected' : ''}>${esc(o.label)}</option>`);
    input = `<select><option value="">${required ? '— choose —' : '(unset)'}</option>${opts.join('')}</select>`;
  } else if (kind === 'multi') {
    const opts = enumOptions(s.items);
    const chosen = new Set((v ?? []).map((x) => JSON.stringify(x)));
    input = `<select multiple size="${Math.min(opts.length, 6)}">${opts.map((o) => `<option value="${esc(JSON.stringify(o.value))}" ${chosen.has(JSON.stringify(o.value)) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (kind === 'bool') {
    input = `<select><option value="">(unset)</option><option value="true" ${v === true ? 'selected' : ''}>true</option><option value="false" ${v === false ? 'selected' : ''}>false</option></select>`;
  } else if (kind === 'int' || kind === 'num') {
    input = `<input type="number" step="${kind === 'int' ? 1 : 'any'}" value="${esc(v ?? '')}" ${s.minimum !== undefined ? `min="${s.minimum}"` : ''} ${s.maximum !== undefined ? `max="${s.maximum}"` : ''} />`;
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

function formFields(schema, values = {}) {
  const props = schema?.properties ?? {};
  const req = new Set(schema?.required ?? []);
  const names = Object.keys(props);
  if (!names.length) return '<p class="hint">No arguments.</p>';
  return names.map((n) => fieldHtml(n, props[n], req.has(n), values[n])).join('');
}

// Fail fast: every invalid field is flagged and nothing is sent.
function collectArgs(container, schema) {
  const req = new Set(schema?.required ?? []);
  const args = {};
  let ok = true;
  container.querySelectorAll('.field').forEach((f) => {
    f.classList.remove('invalid');
    f.querySelector('.ferr')?.remove();
    const name = f.dataset.name;
    const el = f.querySelector('input,select,textarea');
    const fail = (msg) => { ok = false; f.classList.add('invalid'); f.insertAdjacentHTML('beforeend', `<div class="ferr">${esc(msg)}</div>`); };
    if (f.dataset.kind === 'multi') {
      const picked = [...el.selectedOptions].map((o) => JSON.parse(o.value));
      if (picked.length) args[name] = picked; else if (req.has(name)) fail('choose at least one');
      return;
    }
    const raw = el.value;
    if (raw.trim() === '') { if (req.has(name)) fail('required'); return; }
    switch (f.dataset.kind) {
      case 'enum': args[name] = JSON.parse(raw); break;
      case 'bool': args[name] = raw === 'true'; break;
      case 'int': if (!Number.isInteger(Number(raw))) fail('must be an integer'); else args[name] = Number(raw); break;
      case 'num': if (Number.isNaN(Number(raw))) fail('must be a number'); else args[name] = Number(raw); break;
      case 'str': args[name] = raw; break;
      default: try { args[name] = JSON.parse(raw); } catch (e) { fail(`invalid JSON: ${e.message}`); }
    }
  });
  return { args, ok };
}

// ---------------------------------------------------------------- rendering

function highlight(value) {
  const json = esc(JSON.stringify(value, null, 2));
  return json.replace(/(&quot;(?:\\.|[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, (m, str, colon, bool) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (bool) return `<span class="j-bool">${m}</span>`;
    if (m === 'null') return `<span class="j-null">${m}</span>`;
    return `<span class="j-num">${m}</span>`;
  });
}

function prettyText(text) {
  try { return highlight(JSON.parse(text)); } catch { return esc(text); }
}

function itemsForTab() {
  const q = $('#search').value.toLowerCase();
  const match = (...parts) => parts.join(' ').toLowerCase().includes(q);
  switch (state.tab) {
    case 'tools': return state.tools.filter((t) => match(t.name, t.title, t.description)).map((t) => ({ key: t.name, name: t.title ? `${t.name}` : t.name, desc: t.description, data: t }));
    case 'resources': return [
      ...state.resources.filter((r) => match(r.name, r.uri, r.description)).map((r) => ({ key: `r:${r.uri}`, name: r.name ?? r.uri, desc: r.uri, data: r })),
      ...state.templates.filter((r) => match(r.name, r.uriTemplate, r.description)).map((r) => ({ key: `t:${r.uriTemplate}`, name: r.name ?? r.uriTemplate, desc: r.uriTemplate, data: r, template: true })),
    ];
    case 'prompts': return state.prompts.filter((p) => match(p.name, p.description)).map((p) => ({ key: p.name, name: p.name, desc: p.description, data: p }));
    case 'lint': return state.lint.filter((l) => match(l.target, l.msg)).map((l, i) => ({ key: `l:${i}`, name: l.target, desc: l.msg, data: l, sev: l.sev }));
    default: return [];
  }
}

function render() {
  $('#cTools').textContent = state.tools.length;
  $('#cResources').textContent = state.resources.length + state.templates.length;
  $('#cPrompts').textContent = state.prompts.length;
  $('#cLint').textContent = state.lint.filter((l) => l.sev !== 'info').length;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  $('.list-pane').hidden = state.tab === 'info';

  const items = itemsForTab();
  const sevDot = { error: 'err', warn: 'warn', info: '' };
  $('#itemList').innerHTML = items.map((it) => {
    const last = state.results[`${state.tab}:${it.key}`];
    const dot = it.sev ? sevDot[it.sev] : last ? (last.ok && !last.result?.isError ? 'ok' : 'err') : '';
    return `<li data-key="${esc(it.key)}" class="${it.key === state.selected ? 'active' : ''}">
      <div class="iname">${dot ? `<span class="dot ${dot}"></span>` : ''}${esc(it.name)}${it.template ? ' <span class="badge info">template</span>' : ''}</div>
      ${it.desc ? `<div class="idesc">${esc(it.desc)}</div>` : ''}
    </li>`;
  }).join('') || `<li class="hint" style="cursor:default">${state.session ? 'Nothing here.' : 'Not connected.'}</li>`;

  renderDetail(items.find((i) => i.key === state.selected));
}

function renderDetail(item) {
  const d = $('#detail');
  if (state.tab === 'info') return void (d.innerHTML = infoHtml());
  if (state.tab === 'lint' && !item) return void (d.innerHTML = lintSummaryHtml());
  if (!state.session) return void (d.innerHTML = '<div class="empty">Connect to an MCP server to begin.</div>');
  if (!item) return void (d.innerHTML = '<div class="empty">Select an item from the list.</div>');
  if (state.tab === 'tools') d.innerHTML = toolHtml(item.data);
  if (state.tab === 'resources') d.innerHTML = resourceHtml(item);
  if (state.tab === 'prompts') d.innerHTML = promptHtml(item.data);
  if (state.tab === 'lint') { state.tab = 'tools'; state.selected = item.data.target; state.draft = null; render(); }
}

function annotationBadges(t) {
  const a = t.annotations ?? {};
  const out = [];
  if (a.readOnlyHint) out.push('<span class="badge ok">read-only</span>');
  if (a.destructiveHint) out.push('<span class="badge err">destructive</span>');
  if (a.idempotentHint) out.push('<span class="badge info">idempotent</span>');
  if (a.openWorldHint) out.push('<span class="badge warn">open-world</span>');
  if (t.outputSchema) out.push('<span class="badge info">outputSchema</span>');
  return out.join('');
}

function runSection(label, schema, key, values) {
  const body = state.rawMode
    ? `<textarea id="rawArgs" spellcheck="false" style="min-height:160px">${esc(JSON.stringify(values ?? {}, null, 2))}</textarea>`
    : `<div id="argForm">${formFields(schema, values)}</div>`;
  return `<div class="section">
    <div class="section-head"><h3>Arguments</h3><div class="spacer"></div>
      <button class="btn tiny" data-act="raw">${state.rawMode ? 'Form' : 'Edit as JSON'}</button>
      <button class="btn tiny" data-act="schema">Schema</button></div>
    <div class="section-body">
      ${body}
      <div class="run-row">
        <button class="btn primary" data-act="run">${label}</button>
        <input id="timeout" type="number" value="60000" min="1000" step="1000" title="Timeout (ms)" />
        <span class="hint">ms timeout · Ctrl/⌘+Enter</span>
      </div>
      <pre class="json" id="schemaView" hidden>${highlight(schema ?? {})}</pre>
    </div>
  </div>
  <div id="resultArea">${resultHtml(key)}</div>
  ${historyHtml(key)}`;
}

function toolHtml(t) {
  const key = `tools:${t.name}`;
  return `<h1 class="d-title">${esc(t.name)}</h1>
    ${t.title ? `<div>${esc(t.title)}</div>` : ''}
    <div class="badges">${annotationBadges(t)}</div>
    <div class="d-desc">${esc(t.description ?? '')}</div>
    ${runSection('Run tool', t.inputSchema, key, state.draft ?? state.history[key]?.[0]?.args)}`;
}

function resourceHtml(item) {
  const r = item.data;
  const key = `resources:${item.key}`;
  const vars = item.template ? [...r.uriTemplate.matchAll(/\{[+#./;?&]?([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((v) => v.replace(/\*$/, ''))) : [];
  const schema = { type: 'object', properties: Object.fromEntries(vars.map((v) => [v, { type: 'string' }])), required: vars };
  return `<h1 class="d-title">${esc(r.name ?? r.uri ?? r.uriTemplate)}</h1>
    <div class="badges"><span class="badge">${esc(r.uri ?? r.uriTemplate)}</span>${r.mimeType ? `<span class="badge info">${esc(r.mimeType)}</span>` : ''}</div>
    <div class="d-desc">${esc(r.description ?? '')}</div>
    <div class="section"><div class="section-body">
      ${item.template ? `<div id="argForm">${formFields(schema)}</div>` : ''}
      <div class="run-row"><button class="btn primary" data-act="read">Read resource</button>
        <input id="timeout" type="number" value="60000" min="1000" step="1000" title="Timeout (ms)" /><span class="hint">ms timeout</span></div>
    </div></div>
    <div id="resultArea">${resultHtml(key)}</div>`;
}

function promptHtml(p) {
  const key = `prompts:${p.name}`;
  const schema = {
    type: 'object',
    properties: Object.fromEntries((p.arguments ?? []).map((a) => [a.name, { type: 'string', description: a.description }])),
    required: (p.arguments ?? []).filter((a) => a.required).map((a) => a.name),
  };
  return `<h1 class="d-title">${esc(p.name)}</h1>
    <div class="d-desc">${esc(p.description ?? '')}</div>
    ${runSection('Get prompt', schema, key, state.draft ?? state.history[key]?.[0]?.args)}`;
}

function contentHtml(c) {
  const head = `<div class="ctype">${esc(c.type)}${c.mimeType ? ` · ${esc(c.mimeType)}` : ''}</div>`;
  switch (c.type) {
    case 'text': return `<div class="content-item">${head}<pre class="json">${prettyText(c.text)}</pre></div>`;
    case 'image': return `<div class="content-item">${head}<img src="data:${esc(c.mimeType)};base64,${esc(c.data)}" alt="image result" /></div>`;
    case 'audio': return `<div class="content-item">${head}<audio controls src="data:${esc(c.mimeType)};base64,${esc(c.data)}"></audio></div>`;
    case 'resource_link': return `<div class="content-item">${head}<pre class="json">${highlight(c)}</pre></div>`;
    case 'resource': return `<div class="content-item">${head}${resourceContentsHtml(c.resource)}</div>`;
    default: return `<div class="content-item">${head}<pre class="json">${highlight(c)}</pre></div>`;
  }
}

function resourceContentsHtml(rc) {
  if (rc.text !== undefined) return `<div class="ctype">${esc(rc.uri)}</div><pre class="json">${prettyText(rc.text)}</pre>`;
  if (rc.mimeType?.startsWith('image/')) return `<div class="ctype">${esc(rc.uri)}</div><img src="data:${esc(rc.mimeType)};base64,${esc(rc.blob)}" alt="" />`;
  const bytes = Math.round((rc.blob?.length ?? 0) * 0.75);
  return `<div class="ctype">${esc(rc.uri)} · blob ${bytes} bytes</div><a class="btn tiny" download="resource" href="data:${esc(rc.mimeType ?? 'application/octet-stream')};base64,${esc(rc.blob)}">Download</a>`;
}

function resultHtml(key) {
  const r = state.results[key];
  if (!r) return '';
  const tool = key.startsWith('tools:') ? state.tools.find((t) => `tools:${t.name}` === key) : null;
  let status, body;
  if (!r.ok) {
    status = `<span class="badge err">${r.authRequired ? 'auth required' : 'protocol error'}${r.code !== null && r.code !== undefined ? ` ${esc(r.code)}` : ''}</span>`;
    body = `<pre class="json">${esc(r.error)}${r.data ? `\n\n${highlight(r.data)}` : ''}</pre>`;
  } else {
    const res = r.result;
    const warnings = [];
    if (tool?.outputSchema && res.structuredContent === undefined && !res.isError) warnings.push('<span class="badge warn">outputSchema declared but no structuredContent</span>');
    status = `<span class="badge ${res.isError ? 'err' : 'ok'}">${res.isError ? 'tool error (isError)' : 'success'}</span>${warnings.join('')}`;
    const parts = [];
    (res.content ?? []).forEach((c) => parts.push(contentHtml(c)));
    (res.contents ?? []).forEach((c) => parts.push(`<div class="content-item">${resourceContentsHtml(c)}</div>`));
    (res.messages ?? []).forEach((m) => parts.push(`<div class="content-item"><div class="ctype">role: ${esc(m.role)}</div>${contentHtml(m.content)}</div>`));
    if (res.structuredContent !== undefined) parts.push(`<div class="content-item"><div class="ctype">structuredContent</div><pre class="json">${highlight(res.structuredContent)}</pre></div>`);
    body = parts.join('') || '<p class="hint">Empty result.</p>';
  }
  return `<div class="section">
    <div class="section-head"><h3>Result</h3><div class="result-meta">${status}<span class="badge">${r.ms} ms</span></div><div class="spacer"></div>
      <button class="btn tiny" data-act="copy">Copy JSON</button></div>
    <div class="section-body">${body}
      <details><summary class="hint">Raw response</summary><pre class="json">${highlight(r.ok ? r.result : r)}</pre></details>
    </div></div>`;
}

function historyHtml(key) {
  const h = state.history[key];
  if (!h?.length) return '';
  return `<div class="section"><div class="section-head"><h3>History</h3></div><div class="section-body"><ul class="history">
    ${h.map((e, i) => `<li><span class="dot ${e.ok ? 'ok' : 'err'}"></span><span>${new Date(e.ts).toLocaleTimeString([], { hour12: false })}</span><span>${e.ms} ms</span><code>${esc(JSON.stringify(e.args))}</code><button class="btn tiny" data-act="rerun" data-i="${i}">load</button></li>`).join('')}
  </ul></div></div>`;
}

function infoHtml() {
  const s = state.session;
  if (!s) return '<div class="empty">Not connected.</div>';
  const cfg = buildConfig();
  const mask = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, SECRET_RE.test(k) ? '••••••' : v]));
  const shown = { ...cfg, env: cfg.env && mask(cfg.env), headers: cfg.headers && mask(cfg.headers) };
  return `<h1 class="d-title">${esc(s.serverInfo?.name)} <span class="hint">v${esc(s.serverInfo?.version)}</span></h1>
    <div class="badges">
      ${s.protocolVersion ? `<span class="badge info">protocol ${esc(s.protocolVersion)}</span>` : ''}
      ${s.pid ? `<span class="badge">pid ${s.pid}</span>` : ''}
      ${Object.keys(s.capabilities ?? {}).map((c) => `<span class="badge ok">${esc(c)}</span>`).join('')}
    </div>
    ${s.instructions ? `<div class="section"><div class="section-head"><h3>Instructions</h3></div><div class="section-body d-desc">${esc(s.instructions)}</div></div>` : ''}
    <div class="section"><div class="section-head"><h3>Capabilities</h3></div><div class="section-body"><pre class="json">${highlight(s.capabilities)}</pre></div></div>
    <div class="section"><div class="section-head"><h3>serverInfo</h3></div><div class="section-body"><pre class="json">${highlight(s.serverInfo)}</pre></div></div>
    <div class="section"><div class="section-head"><h3>Connection (secrets masked)</h3></div><div class="section-body"><pre class="json">${highlight(shown)}</pre></div></div>`;
}

// ---------------------------------------------------------------- lint

function lintServer() {
  const out = [];
  const add = (sev, target, msg) => out.push({ sev, target, msg });
  const seen = new Set();
  for (const t of state.tools) {
    if (seen.has(t.name)) add('error', t.name, 'duplicate tool name');
    seen.add(t.name);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(t.name)) add('warn', t.name, 'name should match [A-Za-z0-9_.-]{1,128}');
    if (!t.description) add('warn', t.name, 'missing description — models cannot tell when to use it');
    else if (t.description.length < 20) add('info', t.name, 'very short description');
    const s = t.inputSchema;
    if (!s || s.type !== 'object') { add('error', t.name, 'inputSchema.type must be "object"'); continue; }
    const props = s.properties ?? {};
    for (const r of s.required ?? []) if (!(r in props)) add('error', t.name, `required "${r}" is not defined in properties`);
    for (const [n, p] of Object.entries(props)) {
      if (!p.type && !p.enum && !p.anyOf && !p.oneOf && !p.$ref) add('warn', t.name, `property "${n}" has no type`);
      if (!p.description) add('info', t.name, `property "${n}" has no description`);
    }
    if (!t.annotations) add('info', t.name, 'no annotations (readOnly/destructive hints)');
    if (t.outputSchema && t.outputSchema.type !== 'object') add('error', t.name, 'outputSchema.type must be "object"');
  }
  const order = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
}

function lintSummaryHtml() {
  if (!state.session) return '<div class="empty">Not connected.</div>';
  const n = (sev) => state.lint.filter((l) => l.sev === sev).length;
  const cls = { error: 'err', warn: 'warn', info: 'info' };
  return `<h1 class="d-title">Lint report</h1>
    <div class="badges"><span class="badge err">${n('error')} errors</span><span class="badge warn">${n('warn')} warnings</span><span class="badge info">${n('info')} info</span></div>
    <p class="hint">Static checks of tool definitions against the MCP spec and model-usability practice. Click a finding in the list to open the tool.</p>
    ${state.lint.length ? `<table class="grid"><tr><th>Severity</th><th>Tool</th><th>Finding</th></tr>
      ${state.lint.map((l) => `<tr><td><span class="badge ${cls[l.sev]}">${l.sev}</span></td><td><code>${esc(l.target)}</code></td><td>${esc(l.msg)}</td></tr>`).join('')}</table>`
    : '<p>✓ No findings.</p>'}`;
}

// ---------------------------------------------------------------- actions

function currentItem() { return itemsForTab().find((i) => i.key === state.selected); }

function currentArgs(schema) {
  if (state.rawMode) {
    const raw = $('#rawArgs').value.trim() || '{}';
    try { return { ok: true, args: JSON.parse(raw) }; } catch (e) { alertResult(`Invalid JSON: ${e.message}`); return { ok: false }; }
  }
  const form = $('#argForm');
  return form ? collectArgs(form, schema) : { ok: true, args: {} };
}

function alertResult(msg) { $('#resultArea').innerHTML = `<div class="error-box">${esc(msg)}</div>`; }

async function execute() {
  const item = currentItem();
  if (!item || !state.session) return;
  const timeout = Number($('#timeout')?.value || 60000);
  const key = `${state.tab}:${item.key}`;
  let path, body, schema, args = {};

  if (state.tab === 'tools') {
    schema = item.data.inputSchema;
    const a = currentArgs(schema); if (!a.ok) return; args = a.args;
    if (item.data.annotations?.destructiveHint && !confirm(`"${item.data.name}" is marked destructive. Run it?`)) return;
    path = '/tools/call'; body = { name: item.data.name, arguments: args, timeout };
  } else if (state.tab === 'prompts') {
    schema = { required: (item.data.arguments ?? []).filter((x) => x.required).map((x) => x.name) };
    const a = currentArgs(schema); if (!a.ok) return; args = a.args;
    path = '/prompts/get'; body = { name: item.data.name, arguments: args, timeout };
  } else if (state.tab === 'resources') {
    let uri = item.data.uri;
    if (item.template) {
      const form = $('#argForm');
      const vars = [...form.querySelectorAll('.field')].map((f) => f.dataset.name);
      const a = collectArgs(form, { required: vars }); if (!a.ok) return; args = a.args;
      uri = item.data.uriTemplate.replace(/\{([+#./;?&]?)([^}]+)\}/g, (_, op, names) =>
        names.split(',').map((n) => (op === '+' ? args[n.replace(/\*$/, '')] : encodeURIComponent(args[n.replace(/\*$/, '')]))).join(','));
    }
    path = '/resources/read'; body = { uri, timeout };
  }

  const btn = document.querySelector('[data-act="run"],[data-act="read"]');
  btn.disabled = true; btn.textContent = 'Running…';
  let res;
  try { res = await sessionApi(path, body); } catch (err) { res = err; res.ms = err.ms ?? 0; }
  state.results[key] = res;
  state.draft = args;
  (state.history[key] ??= []).unshift({ args, ok: res.ok && !res.result?.isError, ms: res.ms, ts: Date.now() });
  state.history[key].length = Math.min(state.history[key].length, 20);
  render();
}

// ---------------------------------------------------------------- profiles

const PROFILE_KEY = 'mcpt.profiles';
function loadProfiles() { try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) ?? []; } catch { return []; } }
function storeProfiles(p) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } renderProfiles(); }

function renderProfiles() {
  const p = loadProfiles();
  $('#profiles').innerHTML = p.map((x, i) => `<li data-i="${i}"><span class="pname">${esc(x.name)}</span><span class="ptag">${esc(x.transport)}</span><button class="btn tiny ghost danger" data-act="delprofile">✕</button></li>`).join('')
    || '<li class="hint" style="cursor:default;border:0">No saved profiles.</li>';
}

function saveProfile() {
  openModal(`<h3>Save profile</h3><label>Name<input name="n" required value="${esc($('#args').value.split(' ').pop() || $('#url').value || 'server')}" /></label>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div>`,
  (action, form) => {
    if (action !== 'ok') return false;
    const strip = (rows) => rows.map((r) => ({ key: r.key, secret: r.secret, value: r.secret ? '' : r.value }));
    const profiles = loadProfiles().filter((x) => x.name !== form.elements.n.value);
    profiles.push({
      name: form.elements.n.value, transport: state.transport,
      command: $('#command').value, args: $('#args').value, cwd: $('#cwd').value, url: $('#url').value,
      env: strip(state.env), headers: strip(state.headers), bearerRequired: !!$('#bearer').value,
    });
    storeProfiles(profiles);
    return true;
  });
}

function applyProfile(p) {
  setTransport(p.transport);
  $('#command').value = p.command ?? ''; $('#args').value = p.args ?? ''; $('#cwd').value = p.cwd ?? ''; $('#url').value = p.url ?? '';
  $('#bearer').value = '';
  state.env = p.env.map((r) => ({ ...r })); state.headers = p.headers.map((r) => ({ ...r }));
  state.bearerRequired = p.bearerRequired;
  renderKv();
}

// ---------------------------------------------------------------- wiring

$('#transportSeg').addEventListener('click', (e) => { const t = e.target.dataset.t; if (t) setTransport(t); });
$('#connectBtn').addEventListener('click', connect);
$('#disconnectBtn').addEventListener('click', disconnect);
$('#pingBtn').addEventListener('click', async () => {
  const b = $('#pingBtn');
  try { const r = await sessionApi('/ping'); b.textContent = `Ping ${r.ms} ms`; } catch (e) { b.textContent = 'Ping failed'; addLogRow({ ts: Date.now(), type: 'error', message: e.message }); }
  setTimeout(() => { b.textContent = 'Ping'; }, 2000);
});
$('#saveProfileBtn').addEventListener('click', saveProfile);
$('#bearer').addEventListener('input', () => { state.bearerRequired = false; });

document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
  state[b.dataset.add].push({ key: '', value: '', secret: false });
  renderKv();
}));

for (const id of ['#envRows', '#headerRows']) {
  const el = $(id);
  el.addEventListener('input', (e) => {
    const row = e.target.closest('.kv-row'); if (!row) return;
    const r = state[row.dataset.kind][row.dataset.i];
    r[e.target.dataset.f] = e.target.value;
    if (e.target.dataset.f === 'key' && SECRET_RE.test(r.key) && !r.secret) {
      r.secret = true;
      row.querySelector('[data-f="value"]').type = 'password';
      row.querySelector('[data-act="secret"]').classList.add('on');
    }
  });
  el.addEventListener('click', (e) => {
    const act = e.target.dataset.act; if (!act) return;
    const row = e.target.closest('.kv-row');
    const list = state[row.dataset.kind];
    if (act === 'del') list.splice(row.dataset.i, 1);
    if (act === 'secret') list[row.dataset.i].secret = !list[row.dataset.i].secret;
    renderKv();
  });
}

$('#profiles').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]'); if (!li) return;
  const profiles = loadProfiles();
  if (e.target.dataset.act === 'delprofile') { profiles.splice(li.dataset.i, 1); return storeProfiles(profiles); }
  applyProfile(profiles[li.dataset.i]);
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.tab = b.dataset.tab; state.selected = null; state.draft = null; render();
});
$('#search').addEventListener('input', render);
$('#itemList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-key]'); if (!li) return;
  state.selected = li.dataset.key; state.draft = null; render();
});

$('#detail').addEventListener('click', async (e) => {
  const act = e.target.dataset.act; if (!act) return;
  const item = currentItem();
  const key = item && `${state.tab}:${item.key}`;
  if (act === 'run' || act === 'read') execute();
  if (act === 'schema') $('#schemaView').hidden = !$('#schemaView').hidden;
  if (act === 'reveal') { const i = e.target.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; e.target.textContent = i.type === 'password' ? 'show' : 'hide'; }
  if (act === 'copy') navigator.clipboard.writeText(JSON.stringify(state.results[key], null, 2));
  if (act === 'raw') {
    if (state.rawMode) {
      try { state.draft = JSON.parse($('#rawArgs').value || '{}'); } catch (err) { return alertResult(`Invalid JSON: ${err.message}`); }
    } else {
      state.draft = collectArgs($('#argForm'), {}).args; // keep whatever is filled in
    }
    state.rawMode = !state.rawMode;
    renderDetail(item);
  }
  if (act === 'rerun') { state.draft = state.history[key][e.target.dataset.i].args; renderDetail(item); }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('#modal').open) { e.preventDefault(); execute(); }
});

$('#logToggle').addEventListener('click', () => {
  const p = $('#logPanel'); p.classList.toggle('collapsed');
  $('#logToggle').textContent = `${p.classList.contains('collapsed') ? '▸' : '▾'} Protocol log`;
});
$('#logClear').addEventListener('click', () => { $('#logBody').innerHTML = ''; });
document.querySelectorAll('.log-head [data-f]').forEach((c) => c.addEventListener('change', () => {
  state.logFilters[c.dataset.f] = c.checked;
  document.querySelectorAll('.log-row').forEach((r) => { r.hidden = !state.logFilters[r.dataset.type]; });
}));
$('#logLevel').addEventListener('change', async (e) => {
  if (!e.target.value) return;
  try { await sessionApi('/logging/level', { level: e.target.value }); } catch (err) { addLogRow({ ts: Date.now(), type: 'error', message: err.message }); }
});

// Defaults: the reference "everything" server exercises tools, resources, prompts, logging and elicitation.
$('#command').value = 'npx';
$('#args').value = '-y @modelcontextprotocol/server-everything';
renderKv();
renderProfiles();
render();
