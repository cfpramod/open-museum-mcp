# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via [GitHub Security Advisories](https://github.com/cfpramod/open-museum-mcp/security/advisories/new). Do not open a public issue.

You can expect an acknowledgement within 7 days. Confirmed issues will be patched on the latest minor release line; older lines are not maintained.

## What counts as a vulnerability here

The strongest guarantees this project tries to make are about **rights correctness** and **input safety**. Reports in these areas are highest priority:

- **License gate bypass.** A path by which a non-open-access record reaches a tool response (a normalized `Artwork` returned to the caller, or any cached row). The gate in `src/licenseGate.ts` is strict-default-deny; any divergence from that posture is a P0.
- **SQL injection or path traversal.** All cache reads/writes go through parameterized statements in `src/db.ts`; the cache directory is created with mode `0o700`. If you find a way to inject SQL, escape the cache directory, or write outside the configured cache path, that is in scope.
- **Stdio transport corruption.** The MCP server uses stdio JSON-RPC; any unsolicited write to stdout (logs, banners, dotenv messages, etc.) breaks the transport. Out-of-band stdout writes are treated as security-adjacent because they can be triggered by malformed inputs and produce silent failures in clients.
- **Adapter input handling.** Crashes, prototype pollution, or exfiltration paths reachable via crafted museum API responses or crafted tool arguments.

## Out of scope

- Issues that require running the server with a modified codebase or untrusted dependencies installed by the operator.
- Findings that depend on a museum API itself returning malicious content beyond what the adapters parse — those are upstream concerns, though we'll still want to know.
- Rate-limit and availability of upstream museum APIs.

## Disclosure

Once a fix ships, the advisory will be published with credit to the reporter unless you ask otherwise. CVE assignment is via GitHub.
