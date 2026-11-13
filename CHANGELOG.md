# Changelog

All notable changes to MCP Master Tester. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-11-12

### Added

- **Smoke test.** Calls every read-only tool once and tells you which ones don't answer properly. ([#17](https://github.com/simplymanas/mcp-master-tester/pull/17))
  - **In the UI:** a new **Smoke** tab with a Run button, a result for each tool (passed, warning, failed or skipped), the time it took and the arguments that were sent. Click a result to open the tool with those arguments and the full result. The tab shows failures + warnings, then the passes (`0 · 9 ok`).
  - **From the command line, for CI:** `npx mcp-master-tester smoke -- <server command>` (or `--url`). It exits 1 when a tool fails, prints text, JSON or GitHub Actions annotations, and shares its connection options with `lint`.
  - **What fails a tool:** no answer before the timeout, the server closing the connection, a protocol error, a result that breaks the tool's `outputSchema`, or an error result for arguments that came from the schema or from you.
  - **Arguments** are a value for each required parameter: the schema's default, example, const or first enum value, or else a made-up placeholder. An error for a made-up value is a warning, not a failure, because the tool did answer. In the UI, a tool you already ran by hand is called with the arguments you used. On the command line, `--print-args` writes the arguments to a file you can edit and pass back with `--args`.
  - **Safe by default:** only tools marked `readOnlyHint: true` run. `--all` (or the checkbox, which asks first) runs the rest. `--tool` and `--skip` pick tools by name, and a misspelt name is an error, so a renamed tool can't quietly drop out of the test.
  - A run that calls no tool at all fails, because it has proved nothing. If a tool crashes the server, the tools after it are reported as not run.
  - While a smoke test runs in the UI, a server's request for user input (elicitation) is declined automatically, so the run doesn't wait for someone to answer.

### Changed

- `mcp-master-tester lint` with no server now says "No server given" instead of "Nothing to lint". Its options and output are otherwise unchanged.

### Internal

- **A weight budget in the tests.** `test/package.test.js` fails if a runtime dependency is added, the published package passes 60 kB (it is 43 kB), install scripts appear, files other than the app get published, or the page loads anything from another host.
- **Dependencies updated** in the lockfile (MCP SDK 1.32.2, Express 5.3.0 and their trees), which clears the 5 advisories `npm audit` reported for the repo. Installs from npm already resolved the fixed versions.
- **Dependabot** opens one grouped pull request a week for npm packages and one for GitHub Actions.
- **CI also runs on Node 26**, the current LTS line, next to 20, 22 and 24.

### Docs

- The README has a **Lightweight** section with the measured install size next to the official inspector's.

## [1.2.1] - 2026-11-12

### Security

- **A server could run script in the tester's page through a tool schema.** The `minimum` and `maximum` of a number parameter went into the argument form unescaped, so a server could put HTML there and have it run when you opened the tool. The page can ask the backend to start commands, so a hostile server you connected to, including a remote one, could have run commands on your machine. Affects every version up to 1.2.0; please update. Now only real numbers become `min`/`max`, and every other value a server sends was checked and is escaped.
- **Content-Security-Policy.** The page is served with a policy that stops inline script and event handlers from running, and stops the page from loading or sending anything outside the app. This is a second line of defence if an escaping mistake is ever made again.
- **Requests from other websites are rejected.** The backend now refuses any request whose `Origin` isn't the app itself. Before, only the browser's own cross-origin rules stood between another website and the backend.

### Fixed

- **Starting on a busy port now fails with a clear error.** A second instance used to print the "running at" address and exit quietly with code 0, leaving you looking at the instance that was already running, possibly an older version. It now says the port is in use, suggests `PORT=…`, and exits 1.
- A schema with a non-array `default` on a multi-select field, or a non-array `required`, no longer breaks the form.

### Docs

- The README said URL-mode elicitation was supported. It isn't: the tester doesn't advertise it, so servers can't use it. The README now says so, and it's on the roadmap. The dormant code for it now only links `http` and `https` addresses.

These changes are from [#14](https://github.com/simplymanas/mcp-master-tester/pull/14).

## [1.2.0] - 2026-11-07

### Added

- **Lint from the command line, for CI.** `npx mcp-master-tester lint -- <server command>` (or `--url` for Streamable HTTP and SSE) runs the same lint rules as the Lint tab and exits 1 when there are findings at the `--fail-on` level (`error` by default, or `warn`, `info`, `never`). Output can be text, JSON, or GitHub Actions annotations (`--format github`). A server that fails to start exits 2 and has its stderr printed. Running `mcp-master-tester` with no arguments still starts the web UI. ([#12](https://github.com/simplymanas/mcp-master-tester/pull/12))
- **Light/dark theme button** at the top right. The theme still follows your system setting until you pick one; your choice is remembered across reloads and wins over later system changes.
- **About panel** (the ⓘ button next to it): the version, who built it, and links to the source, npm package, release notes, issues and tutorial. It reads the version from the new `GET /api/info` endpoint. ([#11](https://github.com/simplymanas/mcp-master-tester/pull/11))
- **A hint when `structuredContent` only wraps the text output.** When it's a single string field that repeats the text content (for example `{"result": "..."}`, which Python FastMCP produces when a tool returns a `str`), the result shows an *only wraps the text output* badge, because clients get no fields to work with. ([#10](https://github.com/simplymanas/mcp-master-tester/pull/10))

### Fixed

- **Multi-line strings in JSON results are readable.** A string with newlines, such as a text table returned in `structuredContent`, used to wrap into one long line of `\n` escapes. The display now breaks after each `\n` and lines the text up under the opening quote, with the escapes kept and dimmed. Copy JSON still copies the exact JSON. ([#10](https://github.com/simplymanas/mcp-master-tester/pull/10))

### Docs

- Re-recorded the README demo GIF on 1.1.1. It now shows the connection panel and the new Lint count, and is about 650 KB instead of 4.2 MB. The "What's new" line now covers 1.1.1. ([#9](https://github.com/simplymanas/mcp-master-tester/pull/9))

## [1.1.1] - 2026-11-06

### Fixed

- **Phone layout.** On narrow screens the page scrolled sideways and the tool list was squeezed under the detail pane, so tools couldn't be tapped. The layout now stacks and scrolls normally.
- **The Lint tab count no longer reads 0 when there are findings.** It shows errors + warnings, coloured by the worst, then info findings muted (`0 · 30`), with the breakdown in a tooltip.
- **The log-level dropdown explains itself.** When a server doesn't declare the `logging` capability, the dropdown says "no logging support" and its tooltip explains why, instead of being silently disabled.

These fixes are from [#6](https://github.com/simplymanas/mcp-master-tester/pull/6).

### Docs

- The README covers the connection panel, how to read the Lint count, when the log level can be set, phone support, and that closing the tab stops the server. It also adds screenshots and an updated roadmap ([#7](https://github.com/simplymanas/mcp-master-tester/pull/7)).

## [1.1.0] - 2026-11-05

### Added

- **Connection state in the sidebar.** The connection card shows Not connected, Connecting… or Connected. When connected, it shows the server name, version, transport, command or URL, and pid, with **Reconnect** and **Disconnect** buttons. ([#3](https://github.com/simplymanas/mcp-master-tester/pull/3))
- **Lint rules for tools that models struggle with** ([#3](https://github.com/simplymanas/mcp-master-tester/pull/3), [#4](https://github.com/simplymanas/mcp-master-tester/pull/4), from [#2](https://github.com/simplymanas/mcp-master-tester/issues/2)):
  - tools a model could confuse: overlapping names (`get_user` vs `getUsers`) or near-identical descriptions
  - descriptions that never say when *not* to use the tool, or that are so long they eat context; the whole tool list being too big
  - string params that list fixed values and should be an enum
  - strings that should be typed: booleans, numbers, dates, URLs, emails
  - enums and strings with no example
  - no `required` list when a parameter has no default
  - non-snake_case names, and names that break the server's own convention
  - list/search tools with no limit or pagination parameter
- **Checks on real tool calls.** A badge and a lint warning when a result is over ~10k tokens, or when an `isError` result has no message a model could recover from.
- Unit tests for every lint rule (`test/lint.test.js`). The rules now live in `public/lint.js`.

### Fixed

- **Reconnecting could fail, and server processes leaked.** Clicking Connect while a connection was still starting launched a second server and orphaned the first, which kept running after Disconnect. Closing or reloading the tab also left the server running. Servers that hold a port, lock file or browser profile then failed on the next connect.
- When a server exits on its own, the backend session is now cleaned up.
- Tool results and list refreshes from a replaced session no longer show up in the new one.
- The client now reports its real version in `clientInfo` (it was hard-coded to 1.0.0).

### Docs

- Linked the step-by-step tutorial on Medium from the README ([#1](https://github.com/simplymanas/mcp-master-tester/pull/1)).

## [1.0.0] - 2026-11-04

First release: a local web UI to connect to, inspect and test any MCP server over stdio, Streamable HTTP or SSE, with schema-driven tool forms, auth and key prompts, elicitation, lint, and a live JSON-RPC log.

[1.3.0]: https://github.com/simplymanas/mcp-master-tester/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/simplymanas/mcp-master-tester/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/simplymanas/mcp-master-tester/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/simplymanas/mcp-master-tester/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/simplymanas/mcp-master-tester/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/simplymanas/mcp-master-tester/releases/tag/v1.0.0
