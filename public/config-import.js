// MCP Master Tester — import servers from a client's config file
// Turns the JSON that Claude Desktop, Cursor, VS Code and others use to list MCP servers into saved
// profiles. Pure functions with no DOM access, so the unit tests can check them.
// Author: @simplymanas
//
// Secret values never reach a profile: an env var or header whose name looks secret, or whose value is
// a placeholder such as ${input:token}, keeps its name and loses its value, and the app asks for it on
// connect, as it does for profiles saved by hand.

import { SECRET_RE } from './forms.js';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PLACEHOLDER_RE = /\$\{[^}]+\}/;

// Where each client keeps its list: { mcpServers } (Claude Desktop, Cursor, Windsurf, Cline),
// { servers } (VS Code .vscode/mcp.json), { mcp: { servers } } (VS Code settings.json), or a bare map.
function serverMap(config) {
  if (isObject(config.mcpServers)) return config.mcpServers;
  if (isObject(config.servers)) return config.servers;
  if (isObject(config.mcp) && isObject(config.mcp.servers)) return config.mcp.servers;
  const values = Object.values(config);
  if (values.length && values.every((v) => isObject(v) && (typeof v.command === 'string' || typeof v.url === 'string' || typeof v.serverUrl === 'string'))) return config;
  return null;
}

// One argument per array item, quoted when it has a space, the way the Arguments field splits them.
export function joinArgs(args) {
  return args.map((a) => {
    const s = String(a);
    if (s && !/[\s"']/.test(s)) return s;
    return s.includes('"') ? `'${s}'` : `"${s}"`;
  }).join(' ');
}

function rows(obj, secrets) {
  if (!isObject(obj)) return [];
  return Object.entries(obj).map(([key, raw]) => {
    const value = String(raw ?? '');
    const secret = SECRET_RE.test(key) || PLACEHOLDER_RE.test(value);
    if (secret) secrets.push(key);
    return { key, secret, value: secret ? '' : value };
  });
}

/**
 * Profiles from a client's MCP config.
 * @param {string} text  the pasted JSON
 * @returns {{ profiles: object[], skipped: {name: string, reason: string}[], secrets: {name: string, keys: string[]}[] }}
 * @throws {Error} with a message for the user when the text isn't a config this understands
 */
export function profilesFromConfig(text) {
  let config;
  try { config = JSON.parse(text); } catch (err) { throw new Error(`That isn't valid JSON: ${err.message}`); }
  if (!isObject(config)) throw new Error('Paste a JSON object, such as the contents of claude_desktop_config.json or .vscode/mcp.json.');
  const map = serverMap(config);
  if (!map || !Object.keys(map).length) throw new Error('No servers found. The config should have an "mcpServers" (or VS Code\'s "servers") object with one entry per server.');

  const profiles = [];
  const skipped = [];
  const secrets = [];
  for (const [name, s] of Object.entries(map)) {
    if (!isObject(s)) { skipped.push({ name, reason: 'not an object' }); continue; }
    const hidden = [];
    const url = typeof s.url === 'string' ? s.url : typeof s.serverUrl === 'string' ? s.serverUrl : '';
    let profile;
    if (typeof s.command === 'string' && s.command.trim()) {
      const args = Array.isArray(s.args) ? s.args : [];
      profile = {
        name, transport: 'stdio', command: s.command.trim(), args: joinArgs(args), cwd: typeof s.cwd === 'string' ? s.cwd : '', url: '',
        env: rows(s.env, hidden), headers: [], bearerRequired: false,
      };
    } else if (url) {
      const sse = s.type === 'sse' || s.transport === 'sse' || (!s.type && /\/sse\/?$/.test(url));
      profile = {
        name, transport: sse ? 'sse' : 'http', command: '', args: '', cwd: '', url,
        env: [], headers: rows(s.headers, hidden), bearerRequired: false,
      };
    } else {
      skipped.push({ name, reason: 'no "command" or "url"' });
      continue;
    }
    profiles.push(profile);
    if (hidden.length) secrets.push({ name, keys: hidden });
  }
  return { profiles, skipped, secrets };
}
