# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report them privately through [GitHub security advisories](https://github.com/simplymanas/mcp-master-tester/security/advisories/new), or email **simplymanas@gmail.com**. Include steps to reproduce and the version you tested. You'll get a reply within a few days.

## Security model

MCP Master Tester is a **local developer tool**:

- The backend binds to `127.0.0.1` only, because it can start any command entered in the stdio form. Exposing it on a network would let others run commands on your machine.
- Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` are rejected, so a malicious website cannot reach the backend through DNS rebinding.
- API keys and tokens are kept in memory only and are never written to disk. Saved profiles store the names of secrets, never the values.
- Tools run only when you click **Run**. Tools marked destructive ask for confirmation first.

Issues that break these guarantees, for example a way to reach the backend from another machine or a secret ending up in storage or logs, are security issues.
