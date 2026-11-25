// Monthly scorecard: list one server's tools and print the result as one JSON line. scan.mjs runs this
// in its own process group, so a server that hangs is killed along with everything it started.
// Only initialize and tools/list are sent: no tool is ever called.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const s = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const cwd = process.argv[3];
const started = Date.now();
const print = (r) => process.stdout.write(`${JSON.stringify({ id: s.id, ms: Date.now() - started, ...r })}\n`);

const transport = s.url
  ? new StreamableHTTPClientTransport(new URL(s.url))
  : new StdioClientTransport({
    command: s.command[0], args: s.command.slice(1), cwd, stderr: 'ignore',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...s.env,
      npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', NO_UPDATE_NOTIFIER: '1', CI: '1' },
  });
const client = new Client({ name: 'mcp-master-tester-scorecard', version: '1' });
try {
  await client.connect(transport);
  const tools = [];
  let cursor;
  let pages = 0;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor && ++pages < 50);
  const info = client.getServerVersion() ?? {};
  print({ ok: true, server: { name: info.name, version: info.version }, tools });
} catch (e) {
  print({ ok: false, error: String(e?.message ?? e).split('\n')[0].slice(0, 200) });
} finally {
  await client.close().catch(() => {});
  process.exit(0);
}
