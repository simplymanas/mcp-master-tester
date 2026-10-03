#!/usr/bin/env node
// MCP Master Tester — backend
// Bridges the browser UI to any MCP server over stdio, Streamable HTTP or SSE.
// Author: @simplymanas

import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  ElicitRequestSchema,
  LoggingMessageNotificationSchema,
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.PORT ?? 6280);
const HOST = '127.0.0.1'; // local only: this process can spawn commands
const sessions = new Map();

// ---------- session ----------

class Session {
  constructor(config) {
    this.id = randomUUID();
    this.config = config;
    this.subscribers = new Set();
    this.backlog = [];
    this.pendingElicitations = new Map();
    this.stderrTail = [];
  }

  emit(event) {
    const entry = { ts: Date.now(), ...event };
    this.backlog.push(entry);
    if (this.backlog.length > 2000) this.backlog.shift();
    const line = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of this.subscribers) res.write(line);
  }

  buildTransport() {
    const c = this.config;
    if (c.transport === 'stdio') {
      if (!c.command) throw httpError(400, 'stdio transport requires a command');
      const t = new StdioClientTransport({
        command: c.command,
        args: c.args ?? [],
        env: c.env ?? {},
        cwd: c.cwd || undefined,
        stderr: 'pipe',
      });
      t.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        this.stderrTail.push(text);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
        this.emit({ type: 'stderr', text });
      });
      return t;
    }
    if (!c.url) throw httpError(400, `${c.transport} transport requires a URL`);
    const url = new URL(c.url);
    const requestInit = { headers: c.headers ?? {} };
    if (c.transport === 'http') return new StreamableHTTPClientTransport(url, { requestInit });
    if (c.transport === 'sse') return new SSEClientTransport(url, { requestInit });
    throw httpError(400, `Unknown transport: ${c.transport}`);
  }

  // Log every JSON-RPC frame in both directions.
  tap(transport) {
    const send = transport.send.bind(transport);
    transport.send = (msg, opts) => {
      this.emit({ type: 'rpc', dir: 'out', msg });
      return send(msg, opts);
    };
    let handler;
    Object.defineProperty(transport, 'onmessage', {
      configurable: true,
      get: () => handler,
      set: (fn) => {
        handler = fn && ((msg, extra) => {
          this.emit({ type: 'rpc', dir: 'in', msg });
          fn(msg, extra);
        });
      },
    });
  }

  async connect() {
    this.client = new Client(
      { name: 'mcp-master-tester', version: '1.0.0' },
      { capabilities: { elicitation: {} } },
    );
    this.registerHandlers();
    this.transport = this.buildTransport();
    this.tap(this.transport);
    this.client.onclose = () => this.emit({ type: 'closed' });
    this.client.onerror = (err) => this.emit({ type: 'error', message: err.message });
    await this.client.connect(this.transport);
  }

  registerHandlers() {
    const c = this.client;
    c.setNotificationHandler(LoggingMessageNotificationSchema, (n) => this.emit({ type: 'log', params: n.params }));
    c.setNotificationHandler(ToolListChangedNotificationSchema, () => this.emit({ type: 'list_changed', kind: 'tools' }));
    c.setNotificationHandler(ResourceListChangedNotificationSchema, () => this.emit({ type: 'list_changed', kind: 'resources' }));
    c.setNotificationHandler(PromptListChangedNotificationSchema, () => this.emit({ type: 'list_changed', kind: 'prompts' }));

    // Server asks the user for input (API keys, confirmations, ...): forward to the UI and wait.
    c.setRequestHandler(ElicitRequestSchema, (req) => {
      if (this.subscribers.size === 0) throw new Error('No UI attached to answer elicitation');
      const reqId = randomUUID();
      this.emit({ type: 'elicit', reqId, params: req.params });
      return new Promise((resolve) => this.pendingElicitations.set(reqId, resolve));
    });
  }

  info() {
    return {
      id: this.id,
      serverInfo: this.client.getServerVersion(),
      capabilities: this.client.getServerCapabilities(),
      instructions: this.client.getInstructions(),
      protocolVersion: this.transport.protocolVersion ?? null,
      pid: this.transport.pid ?? null,
    };
  }

  async close() {
    await this.client?.close(); // emits 'closed' to subscribers while they are still open
    for (const res of this.subscribers) res.end();
    this.subscribers.clear();
  }
}

// ---------- helpers ----------

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}

function isAuthError(err) {
  return err?.code === 401 || /\b401\b|unauthori[sz]ed/i.test(err?.message ?? '');
}

function getSession(req) {
  const s = sessions.get(req.params.id);
  if (!s) throw httpError(404, 'Session not found — reconnect');
  return s;
}

// Wrap async handlers; time every MCP call.
const route = (fn) => async (req, res) => {
  const started = performance.now();
  try {
    const result = await fn(req, res);
    if (!res.headersSent) res.json({ ok: true, ms: Math.round(performance.now() - started), result });
  } catch (err) {
    const status = err.status ?? (isAuthError(err) ? 401 : 500);
    res.status(status).json({
      ok: false,
      ms: Math.round(performance.now() - started),
      error: err.message,
      code: err.code ?? null,
      data: err.data ?? null,
      authRequired: isAuthError(err),
      ...err.extra,
    });
  }
};

// Supplying onprogress makes the SDK attach a progressToken, so servers can stream progress.
const callOpts = (req) => {
  const s = getSession(req);
  return {
    timeout: Number(req.body?.timeout ?? 60000),
    resetTimeoutOnProgress: true,
    onprogress: (p) => s.emit({ type: 'progress', params: p }),
  };
};

// ---------- app ----------

const app = express();

// Block DNS-rebinding: a hostile site resolving to 127.0.0.1 must not reach an API that spawns commands.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return res.status(403).json({ ok: false, error: `Host not allowed: ${req.headers.host}` });
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));

app.post('/api/sessions', route(async (req) => {
  const session = new Session(req.body);
  try {
    await session.connect();
  } catch (err) {
    await session.client?.close().catch(() => {});
    throw Object.assign(err, { extra: { stderr: session.stderrTail.join('').slice(-4000) } });
  }
  sessions.set(session.id, session);
  return session.info();
}));

app.delete('/api/sessions/:id', route(async (req) => {
  const s = getSession(req);
  sessions.delete(s.id);
  await s.close();
  return { closed: true };
}));

app.get('/api/sessions/:id/events', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  for (const e of s.backlog) res.write(`data: ${JSON.stringify(e)}\n\n`);
  s.subscribers.add(res);
  req.on('close', () => s.subscribers.delete(res));
});

app.post('/api/sessions/:id/elicit/:reqId', route(async (req) => {
  const s = getSession(req);
  const resolve = s.pendingElicitations.get(req.params.reqId);
  if (!resolve) throw httpError(404, 'Elicitation request not pending');
  s.pendingElicitations.delete(req.params.reqId);
  resolve(req.body); // { action: 'accept'|'decline'|'cancel', content? }
  return { answered: true };
}));

app.post('/api/sessions/:id/ping', route((req) => getSession(req).client.ping()));
app.post('/api/sessions/:id/tools/list', route((req) => getSession(req).client.listTools(req.body?.cursor ? { cursor: req.body.cursor } : undefined)));
app.post('/api/sessions/:id/tools/call', route((req) =>
  getSession(req).client.callTool({ name: req.body.name, arguments: req.body.arguments ?? {} }, undefined, callOpts(req))));
app.post('/api/sessions/:id/resources/list', route((req) => getSession(req).client.listResources(req.body?.cursor ? { cursor: req.body.cursor } : undefined)));
app.post('/api/sessions/:id/resources/templates', route((req) => getSession(req).client.listResourceTemplates()));
app.post('/api/sessions/:id/resources/read', route((req) => getSession(req).client.readResource({ uri: req.body.uri }, callOpts(req))));
app.post('/api/sessions/:id/prompts/list', route((req) => getSession(req).client.listPrompts(req.body?.cursor ? { cursor: req.body.cursor } : undefined)));
app.post('/api/sessions/:id/prompts/get', route((req) =>
  getSession(req).client.getPrompt({ name: req.body.name, arguments: req.body.arguments ?? {} }, callOpts(req))));
app.post('/api/sessions/:id/logging/level', route((req) => getSession(req).client.setLoggingLevel(req.body.level)));

app.listen(PORT, HOST, () => console.log(`MCP Master Tester → http://${HOST}:${PORT}`));

process.on('SIGINT', async () => {
  await Promise.all([...sessions.values()].map((s) => s.close().catch(() => {})));
  process.exit(0);
});
