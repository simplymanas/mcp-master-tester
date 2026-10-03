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
| `server.js` | Backend: sessions, transports, REST API, event stream |
| `public/app.js` | UI logic: connection form, schema forms, results, lint, log |
| `public/style.css` | Theme and layout |
| `test/api.test.js` | Integration tests (Node's built-in test runner) |

## Make a change

1. Create a branch: `git checkout -b feat/short-description` (or `fix/…`, `docs/…`).
2. Make your change. Test it in the browser against a real server. The default profile launches `server-everything`, which exercises every feature.
3. Add or update tests in `test/` for backend changes. Run `npm test`.
4. Update the README if behavior or setup changed.
5. Commit with a short, imperative message: `Add smoke-test mode`, `Fix SSE header handling`.
6. Push and open a pull request. Fill in the template.

CI runs `npm test` on Node 20, 22 and 24 for every pull request.

## Guidelines

- **Keep it simple.** No build step, no frontend framework, and as few dependencies as possible. Plain JavaScript in the browser, Express on the backend.
- **One clear way to do things.** Don't add hidden fallbacks or duplicate code paths.
- **Fail fast with clear errors.** Show the user what went wrong rather than hiding it.
- **One function, one job.** Keep functions focused and named for what they do.
- **Small, focused pull requests.** One change per pull request is easier to review and merge.
- **Never log or store secrets.** API keys and tokens stay in memory only.

## Code of conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). Please be kind and respectful.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
