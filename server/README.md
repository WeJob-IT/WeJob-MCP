# WeJob MCP

Read-only MCP server for WeJob. It exposes public jobs, formations, and company
profiles through existing WeJob API endpoints.

The current integration is designed as the shared MCP base for:

- local Codex testing over STDIO;
- production HTTP access over HTTPS;
- Codex plugin submission;
- ChatGPT Apps and Anthropic integrations;
- MCP-compatible clients such as Gemini CLI, Grok/xAI, and GitHub Copilot in
  VS Code.

## Status

- Local STDIO MCP: validated in Codex.
- Production HTTP MCP: validated at `https://mcp.wejob.ch/mcp`.
- Gemini CLI: validated with the production HTTP endpoint.
- Grok/xAI: validated with a custom MCP connector.
- GitHub Copilot in VS Code: validated with the production HTTP endpoint.
- MCP test suite: `69/69` passing.
- Backend filter regression tests: passing for company, language, location, and
  Java vs JavaScript search behavior.
- Internal MCP logging: structured JSON logs with request id, method/tool,
  argument names, result count, upstream API calls, latency, and redacted
  errors with their type and cause. See [Troubleshooting with logs](#troubleshooting-with-logs).
- Scope: public read-only discovery only.

## Tools

All tools are read-only.

- `search`: search jobs, formations, and companies together.
- `fetch`: fetch one item by composite id (`job:`, `formation:`, `company:`).
- `wejob_search_jobs`: search public active job offers.
- `wejob_get_job`: fetch one public active job offer.
- `wejob_search_formations`: search public active formations.
- `wejob_get_formation`: fetch one public active formation.
- `wejob_search_companies`: search public company profiles.
- `wejob_get_company`: fetch one public company profile.

## Prompts

Ready-made requests a client can offer to its users (`prompts/list`,
`prompts/get`). Each one tells the assistant which tools to call and to answer
from their results only.

- `find_jobs` (`role`, optional `location`): public job offers for a role,
  with the total count and links.
- `company_overview` (`company`): a company's public profile and open offers.
- `job_summary` (`job`: a `job:` id or a title): one offer summarized, with
  "not specified" for missing fields.

## Resources

Reference data a client can attach as context (`resources/list`,
`resources/read`, JSON):

- `wejob://search-filters`: filters, accepted values and sort orders of each
  search tool, built from the same definitions as the tool schemas.
- `wejob://swiss-cantons`: the 26 cantons with their code and their names in
  French, German, Italian and English, as accepted by `location`.

## Search Parameters

Search tools accept a `limit` argument from 1 to 50. The MCP server maps it to
the WeJob API `per_page` parameter.

Job and formation search results include `id`, `title`, `url`, `company`, and
`location` when known. Company search results include `id`, `title`, `url`, and
`location` (their cantons or cities).

`wejob_search_jobs` supports:

- `query`: free-text search over public job content and canonical skills;
- `location`: strict location/canton filter, for example `Vaud`;
- `company`: company name filter, preserving multi-word company names;
- `skills`: comma-separated hard skill filter;
- `languages`: comma-separated language filter, for example `Anglais`,
  `English`, or `en`;
- `limit`: maximum result count, capped at 50.

Search behavior notes:

- searches return exact matches only. The website adds "near" results when few
  match (`near_fallback=1`: "5 exacts, 114 proches" for Java, other cantons for
  Jura); the MCP deliberately does not, because the API does not flag which
  results are near and an assistant would present them as matches. Apart from
  that, filters and sorts mirror the site, so the same search gives the same
  exact results;
- company filters keep multi-word names strict, so `IT Advanced Consulting`
  does not match unrelated companies containing only `IT`;
- language filters prefer structured language requirements and use free-text or
  skills mentions only as secondary signals;
- `Java` and `JavaScript` are treated as distinct terms.

Job searches also accept `technologies`, `employment_type` (full_time, part_time,
CDI, CDD, contract, internship, apprenticeship, freelance), `work_mode` (on_site,
hybrid, remote), `experience_level` (junior, intermediate, senior, expert),
`categories`, `salary_min` and `salary_max`.

`wejob_search_formations` supports `query`, `location`, `company`, `skills`,
`technologies`, `formation_mode` (presentiel, distanciel, hybride),
`certification_type` (certificat, diplome, attestation, bootcamp, aucun),
`categories`, `tarif_min`/`tarif_max` and `duration_min`/`duration_max` (days).
`wejob_search_companies` supports `query`, `location`, `industries`, `sizes`
(1-10 … 5000+) and `technologies`. All accept `limit`, `page` and a `sort`
limited to the orders that make sense for the type.

Each tool advertises only its own filters, with these values in its schema.
Common French or English aliases are turned into the stored value before the
API call (temps plein → full_time, confirmé → intermediate, online → distanciel,
diplôme → diplome); any other value is sent as typed. Several values are
comma-separated. Keys a tool no longer advertises are still accepted.

## Configuration

Environment variables:

- `WEJOB_API_BASE_URL`: WeJob API base URL. Defaults to
  `http://127.0.0.1:8000/api`.
- `WEJOB_WEB_BASE_URL`: user-openable web base URL for result links. Defaults
  to `http://127.0.0.1:3000`.
- `WEJOB_API_TOKEN`: optional bearer token for protected WeJob API calls.
- `WEJOB_MCP_HOST`: HTTP host. Defaults to `127.0.0.1`.
- `WEJOB_MCP_PORT`: HTTP port. Defaults to `8787`.
- `WEJOB_MCP_LOG_LEVEL`: `info`, `warn`, `error`, or `silent`. Defaults to
  `info`.

The server reads `process.env`. It does not load `.env` files by itself. In
production, inject variables through the process manager, container runtime, or
hosting platform.

## Local Codex STDIO

Use STDIO for local Codex wiring. Add this to `~/.codex/config.toml` and adapt
paths if needed:

```toml
[mcp_servers.wejob]
command = "node"
args = ["C:/Users/MilletArthur/Documents/projet/WeJob/wejob-mcp/src/server.js", "--stdio"]
cwd = "C:/Users/MilletArthur/Documents/projet/WeJob/wejob-mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true

[mcp_servers.wejob.env]
WEJOB_API_BASE_URL = "http://127.0.0.1:8000/api"
WEJOB_WEB_BASE_URL = "http://127.0.0.1:3000"
```

Restart Codex after changing the config.

## Local HTTP

Use HTTP locally when testing the JSON-RPC endpoint directly:

```bash
npm run start:http
```

Local endpoints:

```text
http://127.0.0.1:8787/health
http://127.0.0.1:8787/mcp
```

## Production HTTP

Production endpoint:

```text
https://mcp.wejob.ch/mcp
```

Health endpoint:

```text
https://mcp.wejob.ch/health
```

Codex HTTP configuration:

```toml
[mcp_servers.wejob_prod]
url = "https://mcp.wejob.ch/mcp"
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```

## Claude (claude.ai, Claude Code, Cowork)

claude.ai and Claude Desktop: Settings > Connectors > Add custom connector >
`https://mcp.wejob.ch/mcp` (no authentication). Claude Cowork: Customize >
Connectors > Add custom connector, or install the `wejob` plugin from this
repository's marketplace.

Claude Code:

```bash
claude mcp add --transport http wejob https://mcp.wejob.ch/mcp
```

Or install the plugin (adds the `wejob` skill):

```bash
claude plugin marketplace add <WeJob repo URL or local path>
claude plugin install wejob@wejob
```

Full connector documentation: https://wejob.ch/mcp-wejob.

## GitHub Copilot in VS Code

Use VS Code's MCP configuration with the production HTTP endpoint. User-level
configuration is available through `MCP: Open User Configuration`; workspace
configuration can live in `.vscode/mcp.json`.

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

After saving, run `MCP: List Servers`, start `wejob` if needed, and use Copilot
Chat in Agent mode.

## Gemini CLI

Use the production HTTP endpoint in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "wejob": {
      "httpUrl": "https://mcp.wejob.ch/mcp",
      "timeout": 60000,
      "trust": false,
      "includeTools": [
        "search",
        "fetch",
        "wejob_search_jobs",
        "wejob_get_job",
        "wejob_search_formations",
        "wejob_get_formation",
        "wejob_search_companies",
        "wejob_get_company"
      ]
    }
  }
}
```

Restart Gemini CLI after changing settings, then run `/mcp`.

## Grok / xAI

Grok web supports custom MCP connectors. Add a custom connector named `WeJob`
with this server URL:

```text
https://mcp.wejob.ch/mcp
```

xAI Remote MCP Tools can use the same endpoint with `server_url` and a
`server_label` such as `wejob`.

## PowerShell Smoke Tests

Health:

```powershell
Invoke-RestMethod -Uri "https://mcp.wejob.ch/health"
```

List tools:

```powershell
$body = @{
  jsonrpc = "2.0"
  id = 1
  method = "tools/list"
  params = @{}
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Uri "https://mcp.wejob.ch/mcp" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

Search jobs:

```powershell
$body = @{
  jsonrpc = "2.0"
  id = 2
  method = "tools/call"
  params = @{
    name = "wejob_search_jobs"
    arguments = @{
      query = ""
      limit = 50
    }
  }
} | ConvertTo-Json -Depth 10

$response = Invoke-RestMethod `
  -Uri "https://mcp.wejob.ch/mcp" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body

$response.result.structuredContent.results | Select-Object id, title, url
```

## Troubleshooting with logs

Every service writes one JSON line per event to stderr, which systemd stores in
the journal, with the same base fields (`timestamp`, `level`, `service`,
`version`, `request_id`, `event`, `status`, `latency_ms`):

| systemd unit | `service` | `request_id` |
|---|---|---|
| `wejob-mcp` | `wejob-mcp` | from `X-Request-Id`, else generated |
| `wejob-apps-sdk` | `wejob-apps-sdk` | from `X-Request-Id`, else generated |
| `wejob-discord-bot` | `wejob-discord-bot` | `discord-<uuid>` |
| `wejob-alexa-skill` | `wejob-alexa-skill` | `alexa-<uuid>` |

The Discord bot and the Alexa skill send their `request_id` to the MCP as
`X-Request-Id`, so one grep on it returns the bot/skill line **and** the MCP line.

### Who called the MCP

`http_request` and `mcp_request` lines carry a `caller` field, guessed from the
`User-Agent` and from the `clientInfo` sent in `initialize`:
`chatgpt-app` (wejob-apps-sdk), `discord`, `alexa`, `chatgpt`, `claude`,
`codex`, `mistral`, `copilot`, `cursor`, `gemini`, `grok`, `perplexity`,
`uptime-monitor`, else `unknown` (the raw `user_agent` stays in the line). Our
own services are certain; third-party platforms are best effort and can change
their User-Agent at any time.

### MCP and ChatGPT app lines

Each request produces:

- an `http_request` line: method, path, HTTP status, latency, `caller`,
  `user_agent`;
- an `mcp_request` line per JSON-RPC call: `mcp_tool`, `args_keys` (argument
  **names** only), `result_count` / `has_more`, and `upstream`, the WeJob API
  calls it made (path without query string, status, latency).

Both lines share a `request_id` (taken from `X-Request-Id` or generated). It is
also sent to the WeJob API as `X-Request-Id`, to correlate with nginx/Laravel.

On errors, `mcp_request` adds:

| Field | Meaning |
|---|---|
| `error_code` | JSON-RPC code: `-32002` not found, `-32602` invalid input, `-32603` unavailable/internal |
| `error_type` | `not_found`, `invalid_input` or `unavailable` |
| `upstream_status` | HTTP status returned by the WeJob API |
| `error_cause` | network cause when the API could not be reached (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`…) |
| `error_message` | redacted message (backend message or validation error) |

### Discord bot and Alexa skill lines

- Discord: one `http_request` line per interaction or Activity call:
  `interaction_type`, `command` / `subcommand`, `option_keys` (names only),
  `component_action` (`page`, `select`, `company`…), `locale`, `in_guild`, and
  `mcp_calls` (`tool`, `status`, `http_status`, `error_code`, `error_cause`,
  `latency_ms`). A deferred slash command logs `"deferred":true` first, then a
  `deferred_command` line once the result is posted (`error_stage` `command` or
  `edit` on failure).
- Alexa: one `http_request` line per voice request: `request_type`, `intent`,
  `locale`, `new_session`, `session_end_reason`, `alexa_error_type` and
  `mcp_calls`. A rejected request has `error_stage` (`parse`, `verify`,
  `handler`); signature failures keep their fixed message.
- `status` is `mcp_error` when the user got an answer but an MCP call failed.
- Log level: `WEJOB_DISCORD_LOG_LEVEL` / `WEJOB_ALEXA_LOG_LEVEL` (`info`, `warn`,
  `error`, `silent`), like `WEJOB_MCP_LOG_LEVEL`.

Never logged there: option and slot values, utterances, Discord user, guild and
channel ids, interaction tokens, custom_id payloads, Alexa userId, deviceId and
session attributes.

### Common commands on the production server

```bash
# Live traffic of every WeJob conversational service
journalctl -u wejob-mcp -u wejob-apps-sdk -u wejob-discord-bot -u wejob-alexa-skill -f -o cat

# MCP calls by caller today (needs jq)
journalctl -u wejob-mcp --since today -o cat | jq -r 'select(.event=="mcp_request") | .caller' | sort | uniq -c

# Unknown callers, to refine the detection
journalctl -u wejob-mcp --since today -o cat | jq -r 'select(.event=="http_request" and .caller=="unknown") | .user_agent' | sort | uniq -c

# Discord or Alexa answers where the MCP failed
journalctl -u wejob-discord-bot -u wejob-alexa-skill --since today -o cat | grep -E '"status":"(mcp_error|error)"'

# Errors of the last hour
journalctl -u wejob-mcp -u wejob-apps-sdk --since "1 hour ago" -o cat | grep '"level":"error"'

# Everything about one request
journalctl -u wejob-mcp -u wejob-apps-sdk -u wejob-discord-bot -u wejob-alexa-skill --since today -o cat | grep '"request_id":"<id>"'

# API unreachable (network cause)
journalctl -u wejob-mcp -u wejob-apps-sdk --since today -o cat | grep '"error_cause"'

# Slow API calls (needs jq)
journalctl -u wejob-mcp -u wejob-apps-sdk --since today -o cat | jq -c 'select(.upstream) | select(any(.upstream[]; .latency_ms > 1000))'
```

What is never logged: tool argument values (search terms, locations, names),
query strings sent to the API, request bodies (only the error type of an invalid
body), tokens and API keys.

## Security Notes

- The MCP server is read-only.
- It exposes only public WeJob discovery data.
- It emits structured internal logs to stderr: tool argument names are logged,
  never their values, query strings or full user payloads.
- Error messages redact bearer tokens, token values, and API keys before being
  returned or logged.
- It must not expose private candidate or recruiter data.
- Production should enforce HTTPS, monitoring, restart-on-failure, and rate
  limiting at the reverse proxy or application layer.
- If protected WeJob API endpoints are used, set `WEJOB_API_TOKEN` through the
  production environment.

## Tests

```bash
npm test
```

Current MCP result:

```text
65 tests passed.
```

Related backend regression tests:

```bash
php artisan test --filter JobSearchCanonicalSkillsTest
php artisan test --filter PublicJobsCompanyFilterTest
php artisan test --filter PublicJobsLanguageFilterTest
php artisan test --filter PublicFormationsFiltersTest
```
