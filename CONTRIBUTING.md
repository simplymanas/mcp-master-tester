# Contributing to MCP Master Tester

Thanks for helping! Every contribution counts, from typo fixes to new features. If you're unsure about anything, [open an issue](https://github.com/simplymanas/mcp-master-tester/issues) and ask.

## Find something to work on

- Issues labelled [`good first issue`](https://github.com/simplymanas/mcp-master-tester/labels/good%20first%20issue) are a good place to start.
- The [roadmap in the README](README.md#roadmap-help-wanted) lists larger features.
- Before starting on something big, comment on its issue (or open one) so we don't duplicate work.

## Set up

Requires Node.js 20+.

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/<your-username>/mcp-master-tester.git
cd mcp-master-tester
npm install
npm start          # http://127.0.0.1:6280
npm test           # integration tests against the reference "everything" server
```

There's no build step. Edit a file and reload the browser (restart `npm start` after backend changes).

| File | What lives there |
|---|---|
| `cli.js` | Command line: starts the UI, or runs `lint` or `smoke` |
| `server.js` | Backend: sessions, transports, REST API, event stream |
| `public/app.js` | UI logic: connection form, schema forms, results, log |
| `public/theme.js` | Light/dark theme toggle |
| `public/forms.js` | Argument forms built from a JSON Schema, as pure functions with no DOM access |
| `public/lint.js` | Lint rules as pure functions, with no DOM access |
| `public/smoke.js` | Smoke test logic as pure functions: what runs, what is sent, how answers are judged |
| `public/config-import.js` | Turns a Claude Desktop, Cursor or VS Code config into profiles, as pure functions |
| `public/diff.js` | The tool lockfile and how each change between two snapshots is graded, as pure functions |
| `public/evals.js` | Tool-selection evals: the cases file, the tool list sent to the model, and grading, as pure functions. The API call is in `cli.js`, which loads the Anthropic SDK only inside `eval` |
| `public/style.css` | Theme and layout |
| `test/api.test.js` | Integration tests (Node's built-in test runner) |
| `test/lint.test.js` | Unit tests for the lint rules |
| `test/smoke.test.js` | Unit tests for the smoke test logic |
| `test/forms.test.js` | Unit tests that hostile schema text never becomes markup |
| `test/package.test.js` | Weight budget: dependency list, package size and published files |
| `test/cli.test.js` | Tests for `lint` and `smoke` from the command line |
| `test/config-import.test.js` | Unit tests for config import, including that secret values are never kept |
| `test/diff.test.js` | Unit tests for the lockfile and the breaking-change rules |
| `test/evals.test.js` | Unit tests for eval cases and grading |
| `test/eval-cli.test.js` | Tests for `eval` from the command line, against a fake Anthropic API (`test/fixtures/fake-anthropic.js`), so no key is needed |
| `test/action.test.js` | Tests for the GitHub Action's inputs, summary and outputs |
| `action.yml`, `action/run.mjs` | The GitHub Action (not in the npm package) |
| `test/fixtures/` | Small MCP servers the tests run against (not test files themselves) |

### REST API

The page talks to the backend through these endpoints.

All calls are `POST` with a JSON body. The reply is `{ ok, ms, result }`, or on failure `{ ok: false, error, code, data, authRequired }`. A `tools/call` whose `structuredContent` doesn't fit the tool's `outputSchema` still replies `ok: true`, with `outputSchemaError` next to `result`.

| Endpoint | MCP method |
|---|---|
| `/api/sessions` | connect (`initialize`) |
| `DELETE /api/sessions/:id` | close |
| `GET /api/sessions/:id/events` | event stream (SSE) |
| `/api/sessions/:id/ping` | `ping` |
| `/api/sessions/:id/tools/list` · `tools/call` | `tools/*` |
| `/api/sessions/:id/resources/list` · `resources/templates` · `resources/read` | `resources/*` |
| `/api/sessions/:id/prompts/list` · `prompts/get` | `prompts/*` |
| `/api/sessions/:id/logging/level` | `logging/setLevel` |
| `/api/sessions/:id/elicit/:reqId` | answer to `elicitation/create` |
| `GET /api/info` | none: returns `{ name, version }` of this app, unwrapped |

## Make a change

1. Create a branch: `git checkout -b feat/short-description` (or `fix/…`, `docs/…`).
2. Make your change. Test it in the browser against a real server. The default profile launches `server-everything`, which exercises every feature.
3. Add or update tests in `test/` for backend changes. For a new lint rule, add a case it must flag and a near-miss it must not flag to `test/lint.test.js`. Run `npm test`.
4. Update the README if behavior or setup changed.
5. Commit with a short, imperative message: `Add smoke-test mode`, `Fix SSE header handling`.
6. Push and open a pull request. Fill in the template.

CI runs `npm test` on Node 20, 22, 24 and 26 for every pull request. Dependabot opens one grouped pull request a week for dependency updates.

## Guidelines

- **Keep it simple.** No build step, no frontend framework, and as few dependencies as possible. Plain JavaScript in the browser, Express on the backend.
- **Keep it light.** `test/package.test.js` fails if a runtime dependency is added or the published package passes its size budget. If your change really needs more, raise the limit in the same pull request and explain why.
- **One clear way to do things.** Don't add hidden fallbacks or duplicate code paths.
- **Fail fast with clear errors.** Show the user what went wrong rather than hiding it.
- **One function, one job.** Keep functions focused and named for what they do.
- **Small, focused pull requests.** One change per pull request is easier to review and merge.
- **Never log or store secrets.** API keys and tokens stay in memory only.
- **Treat everything a server sends as untrusted.** Pass it through `esc()` before it goes into HTML, and never add inline `<script>` or `on…=` handlers: the Content-Security-Policy blocks them.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Please be kind and respectful.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
