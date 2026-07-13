# Security Policy

## Supported Versions

Only the latest version published in the marketplace is supported.

## Reporting a Vulnerability

If you believe you've found a security vulnerability in this plugin, the
underlying WeJob MCP server, or the way this plugin interacts with Claude,
please report it responsibly:

- Email: **security@wejob.ch** (preferred) or `support@wejob.ch`
- Please include: a description, reproduction steps, impact assessment, and
  any relevant logs (with secrets removed).
- Do **not** open a public GitHub issue for security reports.

We aim to acknowledge reports within 3 working days and provide a substantive
response (mitigation, timeline, or request for more information) within
10 working days. Depending on complexity, coordinated disclosure may take
longer.

## Scope

**In scope**
- This plugin's manifest, skill, and marketplace configuration
- The interaction between the plugin and the WeJob MCP server
- The WeJob MCP server itself (`https://mcp.wejob.ch/mcp`)
- The WeJob public documentation and privacy pages

**Out of scope**
- Vulnerabilities in Claude, Claude Code, Cowork, or Anthropic infrastructure
  (report those to Anthropic directly)
- Issues that require compromising a user's local device or account
- Social engineering
- Denial of service via traffic volume

## Data Handling

The WeJob MCP server exposes public discovery data only (public job offers,
formations, and company profiles). It does not process private candidate,
recruiter, or account data. See [wejob.ch/privacy](https://wejob.ch/privacy)
for the underlying service's full privacy policy.
