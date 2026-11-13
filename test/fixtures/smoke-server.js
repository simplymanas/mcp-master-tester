// Fixture MCP server for the smoke tests: tools that answer well, and tools that fail in known ways.
//   (no argument)  four healthy tools: two answer as they are, one needs a real id, one changes data
//   broken         adds a tool whose result breaks its outputSchema, one that throws, and one that never answers
//   crash          adds a tool that kills the server, followed by a healthy one that can then no longer run
//   unmarked       one healthy tool with no annotations
//   mislabelled    a healthy tool, plus two that claim to be read-only but whose name or annotations say otherwise
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const mode = process.argv[2];
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const readOnly = { readOnlyHint: true };
const noArgs = { type: 'object', properties: {}, required: [] };
const weatherOut = { type: 'object', properties: { city: { type: 'string' }, celsius: { type: 'number' } }, required: ['city', 'celsius'] };

const healthy = [
  { name: 'ping_db', description: 'Checks the database answers.', inputSchema: noArgs, annotations: readOnly, run: () => text('ok') },
  {
    name: 'get_weather',
    description: 'Current weather for a city.',
    inputSchema: { type: 'object', properties: { city: { type: 'string', enum: ['Pune', 'Oslo'] }, units: { type: 'string', default: 'c' } }, required: ['city'] },
    outputSchema: weatherOut,
    annotations: readOnly,
    run: ({ city }) => ({ ...text(`${city}: 21`), structuredContent: { city, celsius: 21 } }),
  },
  {
    name: 'find_user',
    description: 'Looks up one user by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'User id, e.g. "u_1"' } }, required: ['id'] },
    annotations: readOnly,
    run: ({ id }) => (id === 'u_1' ? text('Asha') : { ...text(`No user with id "${id}". Ids look like "u_1".`), isError: true }),
  },
  {
    name: 'delete_user',
    description: 'Deletes one user by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: ({ id }) => text(`deleted ${id}`),
  },
];

const broken = [
  { name: 'get_report', description: 'Returns a report.', inputSchema: noArgs, outputSchema: weatherOut, annotations: readOnly, run: () => ({ ...text('report'), structuredContent: { city: 'Pune', celsius: 'warm' } }) },
  { name: 'get_stats', description: 'Returns statistics.', inputSchema: noArgs, annotations: readOnly, run: () => { throw new McpError(ErrorCode.InternalError, 'TypeError: stats is undefined'); } },
  { name: 'slow_query', description: 'Never answers.', inputSchema: noArgs, annotations: readOnly, run: () => new Promise(() => {}) },
];

const crashing = [
  { name: 'crash_now', description: 'Kills the server.', inputSchema: noArgs, annotations: readOnly, run: () => process.exit(1) },
  { name: 'after_crash', description: 'Healthy, but listed after the crash.', inputSchema: noArgs, annotations: readOnly, run: () => text('ok') },
];

const mislabelled = [
  { name: 'cancel_booking', description: 'Cancels a booking.', inputSchema: noArgs, annotations: readOnly, run: () => text('booking cancelled') },
  { name: 'get_audit', description: 'Reads the audit log.', inputSchema: noArgs, annotations: { readOnlyHint: true, destructiveHint: true }, run: () => text('audit') },
];

const tools = mode === 'unmarked' ? [{ name: 'do_thing', description: 'Does a thing.', inputSchema: noArgs, run: () => text('done') }]
  : mode === 'broken' ? [...healthy, ...broken]
  : mode === 'crash' ? [healthy[0], ...crashing]
  : mode === 'mislabelled' ? [healthy[0], ...mislabelled]
  : healthy;

const server = new Server({ name: 'smoke-fixture', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ run, ...definition }) => definition) }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`);
  return tool.run(req.params.arguments ?? {});
});
await server.connect(new StdioServerTransport());
