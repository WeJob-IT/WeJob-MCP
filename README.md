# WeJob Plugin for Claude

Official Claude plugin for **WeJob**, the Swiss IT job board. This plugin gives
Claude (Cowork, Claude Code) read-only access to the public WeJob MCP server —
you can search public job offers, professional formations, and company profiles
directly from Claude.

- Full documentation: **https://wejob.ch/mcp-wejob**
- MCP endpoint: `https://mcp.wejob.ch/mcp` (HTTPS, no authentication)
- Scope: **public, read-only** discovery data
- License: [MIT](LICENSE)
- Validated direct MCP clients: GitHub Copilot in VS Code, Gemini CLI, and Grok/xAI

This repository is a **public mirror** dedicated to the Anthropic plugin
distribution. The underlying MCP server (which returns the data) is a separate
service that runs on WeJob's infrastructure — this repo contains only the
plugin's manifest, skill, and assets.

## Install

### Claude Code (CLI)

```sh
claude plugin marketplace add https://github.com/WeJob-IT/WeJob-MCP
claude plugin install wejob@wejob
```

Verify:

```sh
claude mcp list
# → plugin:wejob:wejob   https://mcp.wejob.ch/mcp (HTTP)   ✓ Connected
```

### Claude Cowork

Customize → Plugins → Add marketplace → paste this repo's URL → install `wejob`.

### claude.ai / Claude Desktop — no plugin needed

For end users of claude.ai or Claude Desktop, the same server is available as
a **custom connector** — no repository or install required:

Settings → Connectors → Add custom connector → `https://mcp.wejob.ch/mcp`
(no authentication).

## Direct MCP clients

The plugin bundle is for Claude surfaces, but the public MCP endpoint can also
be used directly by other MCP-compatible clients:

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

## Verify install

Installation is confirmed by two things: **(1)** the deterministic checks
below show the connection is live, and **(2)** you actually see Claude call
the WeJob tools when you ask a WeJob question. Both matter — the first alone
means the plumbing works but the tools may not be used; the second alone can
be luck.

### 1. Deterministic checks — is it connected?

These don't depend on Claude's judgment. Run whichever matches your surface.

**Server health (any surface)**

```sh
curl https://mcp.wejob.ch/health
# expected: {"ok":true,"name":"wejob-mcp","version":"0.1.0"}
```

**Claude Code (CLI)**

```sh
claude mcp list       # expected: plugin:wejob:wejob ... ✓ Connected
claude plugin list    # expected: wejob@wejob installed
```

**Claude Cowork**

Same CLI commands, or in the UI: Customize → Plugins → **WeJob** shown as
installed with a connected status.

**Claude Desktop and claude.ai**

Settings → Connectors → **WeJob** shows a connected/green indicator.

### 2. Behavioral check — is it actually used?

The deterministic checks say the connection is up. To verify the tools are
actually invoked, use one of the directive prompts below in a **new**
conversation, and **watch for tool-call indicators** — not just the answer
text. A well-written text answer without any tool call means Claude answered
from its own knowledge, not from WeJob.

> On Desktop or claude.ai, first click **+** → Connectors → tick **WeJob** so
> the connector is enabled for the conversation. Without this step, Claude
> won't call the tools even if the connector is installed.

**Prompt A — list the tools**

> What WeJob tools do you have available? List them.

Expected: Claude names `wejob_search_jobs`, `wejob_get_job`,
`wejob_search_formations`, `wejob_get_formation`, `wejob_search_companies`,
`wejob_get_company`, `search`, `fetch`. If Claude says it has no WeJob tools,
the connector isn't active in this conversation.

**Prompt B — force a tool call**

> Use the WeJob tools to list a few current job offers.

Expected: a tool-call indicator (icon or block above/inside Claude's response,
showing `wejob_search_jobs` was invoked) followed by results with URLs like
`https://wejob.ch/jobs/…`. A plain text answer without any tool-call
indicator means the tool wasn't used — see troubleshooting below.

### Troubleshooting

- **No tool-call indicator, only text** — the connector is likely installed
  but not enabled for this conversation. On Desktop / claude.ai, open **+** →
  Connectors → tick **WeJob**. On Code CLI, exit the session and reopen — new
  plugins are only picked up by new sessions.
- **`✗ Failed` or missing from `claude mcp list`** — either the server is
  unreachable (run the health check first) or the plugin manifest wasn't
  loaded correctly (re-run `claude plugin install wejob@wejob`).
- **Connector shown as connected, but no tools appear when enabled** — the
  MCP handshake likely failed. Health check first; if it returns `ok`,
  contact support.

## What the plugin ships

- **`wejob` skill** — teaches Claude when to call the WeJob MCP tools instead
  of inspecting local code or falling back to generic web search.
- **MCP connector configuration** — points Claude at
  `https://mcp.wejob.ch/mcp` over HTTPS.

Together they form a coherent bundle: install once, and Claude automatically
uses the right tools whenever the user asks about WeJob jobs, formations, or
companies.

### Tools exposed by the MCP server

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

## Data scope and privacy

The plugin exposes **public discovery data only**:

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
