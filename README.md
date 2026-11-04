# WeJob MCP

[![MCP Badge](https://lobehub.com/badge/mcp/wejob-it-wejob-mcp)](https://lobehub.com/mcp/wejob-it-wejob-mcp)

Official MCP server for **WeJob**, the Swiss IT job board. It gives any
MCP-compatible AI assistant read-only access to public WeJob data: search job
offers, professional formations, and company profiles, then open any of them
for full details.

- Full documentation: **https://wejob.ch/mcp-wejob**
- MCP endpoint: `https://mcp.wejob.ch/mcp` (Streamable HTTP, no authentication)
- Official MCP Registry name: `ch.wejob/wejob`
- Scope: **public, read-only** discovery data
- License: [MIT](LICENSE)
- Works with: ChatGPT, Claude, GitHub Copilot in VS Code, Gemini CLI, Grok/xAI,
  and any client that supports remote MCP servers

This repository is a **public mirror**. It contains the source code of the MCP
server that answers at `https://mcp.wejob.ch/mcp`, in [`server/`](server/), and
a ready-made plugin bundle for Claude. The server runs on WeJob's
infrastructure and reads the public WeJob API; the code published here is the
same version as the one deployed.

## Quick connect (recommended)

No install needed: point your MCP client at the remote server.

```json
{
  "mcpServers": {
    "wejob": {
      "type": "streamable-http",
      "url": "https://mcp.wejob.ch/mcp"
    }
  }
}
```

Client-specific instructions are below. To run the server yourself instead,
see [Source code](#source-code).

## Tools

All read-only:

| Tool | Purpose |
|------|---------|
| `search` | Unified search across jobs, formations, companies |
| `fetch` | Fetch one item by composite id (`job:`/`formation:`/`company:`) |
| `wejob_search_jobs` | Search public active job offers |
| `wejob_get_job` | One public job offer |
| `wejob_search_formations` | Search public formations |
| `wejob_get_formation` | One public formation |
| `wejob_search_companies` | Search public company profiles |
| `wejob_get_company` | One public company profile |

Search tools accept the same filters and sort orders as the search pages of
wejob.ch, return the total number of matches, and paginate with `page` and
`limit` (1 to 50). The server also provides MCP prompts and reference
resources.

## Connect your client

### ChatGPT

WeJob is available in the ChatGPT plugin directory: search for **WeJob** and
add it.

### GitHub Copilot in VS Code

Add the server through `MCP: Open User Configuration` or `.vscode/mcp.json`:

```json
{
  "servers": {
    "wejob": {
      "type": "http",
      "url": "https://mcp.wejob.ch/mcp"
    }
  }
}
```

Then run `MCP: List Servers`, start `wejob` if needed, and use Copilot Chat in
Agent mode.

### Gemini CLI

Add the server to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "wejob": {
      "httpUrl": "https://mcp.wejob.ch/mcp",
      "timeout": 60000,
      "trust": false
    }
  }
}
```

Restart Gemini CLI, then run `/mcp`.

### Grok / xAI

In Grok web, add a custom MCP connector named `WeJob` with:

```text
https://mcp.wejob.ch/mcp
```

xAI Remote MCP Tools can use the same URL as `server_url` with a `server_label`
such as `wejob`.

### Claude

**claude.ai / Claude Desktop** — no plugin needed: Settings → Connectors → Add
custom connector → `https://mcp.wejob.ch/mcp` (no authentication).

**Claude Code (CLI)** — install the plugin bundle from this repository:

```sh
claude plugin marketplace add https://github.com/WeJob-IT/WeJob-MCP
claude plugin install wejob@wejob
```

Verify:

```sh
claude mcp list
# → plugin:wejob:wejob   https://mcp.wejob.ch/mcp (HTTP)   ✓ Connected
```

**Claude Cowork** — Customize → Plugins → Add marketplace → paste this repo's
URL → install `wejob`.

The plugin bundle adds a `wejob` skill that teaches Claude when to call the
WeJob tools instead of inspecting local code or falling back to generic web
search, plus the connector configuration pointing at `https://mcp.wejob.ch/mcp`.

## Verify the connection

A working setup shows two things: **(1)** the server is reachable and your
client lists it as connected, and **(2)** the assistant actually calls the
WeJob tools when you ask a WeJob question. The first alone means the plumbing
works but the tools may not be used; the second alone can be luck.

### 1. Is it connected?

**Server health (any client)**

```sh
curl https://mcp.wejob.ch/health
# expected: {"ok":true,"name":"wejob-mcp","version":"0.1.0"}
```

Then check your client's MCP or connector list:

- **VS Code**: `MCP: List Servers` shows `wejob` as running.
- **Gemini CLI**: `/mcp` lists `wejob` with its tools.
- **Claude Code**: `claude mcp list` shows `plugin:wejob:wejob ... ✓ Connected`.
- **ChatGPT, Claude Desktop, claude.ai, Grok**: the WeJob connector shows a
  connected status in the connectors settings.

### 2. Is it actually used?

In a **new** conversation, with the WeJob connector enabled, try one of these
prompts and **watch for tool-call indicators**, not just the answer text. A
well-written answer without any tool call means the assistant answered from its
own knowledge, not from WeJob.

**Prompt A — list the tools**

> What WeJob tools do you have available? List them.

Expected: the assistant names `wejob_search_jobs`, `wejob_get_job`,
`wejob_search_formations`, `wejob_get_formation`, `wejob_search_companies`,
`wejob_get_company`, `search`, `fetch`. If it says it has no WeJob tools, the
connector isn't active in this conversation.

**Prompt B — force a tool call**

> Use the WeJob tools to list a few current job offers.

Expected: a tool-call indicator showing `wejob_search_jobs` was invoked,
followed by results with URLs like `https://wejob.ch/jobs/…`.

### Troubleshooting

- **No tool-call indicator, only text** — the connector is likely installed
  but not enabled for this conversation. In chat apps (ChatGPT, claude.ai,
  Claude Desktop, Grok), enable WeJob in the conversation's tools or connectors
  menu. In CLIs (Claude Code, Gemini CLI), start a new session: new servers are
  only picked up by new sessions.
- **Server missing or failed in the client's list** — run the health check
  first. If it returns `ok`, re-check the URL in your configuration.
- **Connected, but no tools appear** — the MCP handshake likely failed. Health
  check first; if it returns `ok`, contact support.

## Source code

The MCP server lives in [`server/`](server/): a single dependency-free Node.js
file ([`server/src/server.js`](server/src/server.js)) that speaks MCP over
STDIO or Streamable HTTP, and its test suite.

```sh
cd server
npm test                     # node --test, no install needed (Node 20+)
npm start                    # STDIO
WEJOB_API_BASE_URL=https://wejob.ch/api WEJOB_WEB_BASE_URL=https://wejob.ch npm run start:http
```

See [`server/README.md`](server/README.md) for parameters, logging and
configuration ([`server/.env.example`](server/.env.example)).

## Data scope and privacy

The server exposes **public discovery data only**:

- Public job offers, formations, and company profiles
- Public URLs back to WeJob pages

It never exposes candidate profiles, CVs, applications, messages, or private
recruiter data, and performs no writes.

See the [WeJob privacy policy](https://wejob.ch/privacy) for the underlying
service's data handling.

## Support

- Public documentation: https://wejob.ch/mcp-wejob
- Contact: `support@wejob.ch`
- Company: WeJob Sàrl, Route de Pré-Bois 14, 1216 Cointrin, Switzerland
