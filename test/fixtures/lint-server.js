// Fixture MCP server for the CLI lint tests: serves tool definitions with known problems.
// Pass "clean" as the first argument to serve one tool that passes every error and warning rule.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const clean = {
  name: 'read_note',
  description: 'Reads one note by id. Don\'t use it to search; use search_notes instead.',
  inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Note id, e.g. "n_42"' } }, required: ['id'] },
  annotations: { readOnlyHint: true },
};
const broken = [
  clean,
  { ...clean }, // duplicate name: error
  { name: 'send_mail', inputSchema: { type: 'object', properties: { to: { type: 'string' } }, required: ['to', 'subject'] } }, // undefined required field: error; no description: warn
];

const server = new Server({ name: 'lint-fixture', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: process.argv[2] === 'clean' ? [clean] : broken }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
await server.connect(new StdioServerTransport());
