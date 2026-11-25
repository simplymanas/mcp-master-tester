// A stand-in for the Anthropic Messages API, so eval can be tested without a key or a bill.
// Point the SDK at it with ANTHROPIC_BASE_URL=http://127.0.0.1:<port>.
//
//   node test/fixtures/fake-anthropic.js [port]     prints "listening on <port>" when ready
//
// How it "chooses": the first tool whose name appears in the prompt is called; a JSON object in the
// prompt becomes the arguments. A prompt with no tool name gets a text answer. Special cases:
//   key "bad-key"          401 authentication_error
//   model "no-such-model"  404 not_found_error
//   prompt with "REFUSE"   stop_reason "refusal"
// Every request body is kept; GET /requests returns them, for tests that check the request shape.
import http from 'node:http';

const port = Number(process.argv[2] ?? 0);
const requests = [];

const error = (res, status, type, message) => {
  res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_fake' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/requests') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(requests));
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return error(res, 404, 'not_found_error', 'not found');
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const msg = JSON.parse(body);
    // Newer SDKs send the key as "Authorization: Bearer", older ones as "x-api-key".
    const key = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '') ?? null;
    requests.push({ key: key ? 'set' : null, body: msg });
    if (key === 'bad-key') return error(res, 401, 'authentication_error', 'invalid x-api-key');
    if (msg.model === 'no-such-model') return error(res, 404, 'not_found_error', `model: ${msg.model}`);

    const prompt = String(msg.messages?.[0]?.content ?? '');
    const usage = { input_tokens: 1000, output_tokens: 20 };
    const reply = (content, stop) => {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_fake' });
      res.end(JSON.stringify({ id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: msg.model, content, stop_reason: stop, stop_sequence: null, usage }));
    };
    if (prompt.includes('REFUSE')) return reply([], 'refusal');
    const names = (msg.tools ?? []).map((t) => t.name).sort((a, b) => b.length - a.length);
    const tool = names.find((n) => prompt.includes(n));
    if (!tool) return reply([{ type: 'text', text: 'I can answer that without a tool.' }], 'end_turn');
    const found = /\{.*\}/.exec(prompt);
    const input = found ? JSON.parse(found[0]) : {};
    reply([{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: `toolu_${requests.length}`, name: tool, input }], 'tool_use');
  });
});

server.listen(port, '127.0.0.1', () => console.log(`listening on ${server.address().port}`));
