# Changelog

All notable changes to MCP Master Tester. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **Multi-line strings in JSON results are readable.** A string with newlines, such as a text table returned in `structuredContent`, used to wrap into one long line of `\n` escapes. The display now breaks after each `\n` and lines the text up under the opening quote, with the escapes kept and dimmed. Copy JSON still copies the exact JSON.

### Added

- **A hint when `structuredContent` only wraps the text output.** When it's a single string field that repeats the text content (for example `{"result": "..."}`, which Python FastMCP produces when a tool returns a `str`), the result shows an *only wraps the text output* badge, because clients get no fields to work with.

### Docs

- Re-recorded the README demo GIF on 1.1.1. It now shows the connection panel and the new Lint count, and is about 650 KB instead of 4.2 MB. The "What's new" line now covers 1.1.1.

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

[1.1.1]: https://github.com/simplymanas/mcp-master-tester/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/simplymanas/mcp-master-tester/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/simplymanas/mcp-master-tester/releases/tag/v1.0.0
