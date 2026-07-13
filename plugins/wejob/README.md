# wejob — Claude plugin

Read-only access to public **WeJob** discovery data (jobs, formations,
companies) from Claude.

- MCP endpoint: `https://mcp.wejob.ch/mcp`
- Auth: none (public read-only)
- Skill: `skills/wejob/SKILL.md` — instructs Claude when and how to call the
  WeJob MCP tools

## Install

From the marketplace root of this repository:

```sh
claude plugin marketplace add https://github.com/WeJob-IT/WeJob-MCP
claude plugin install wejob@wejob
```

Verify:

```sh
claude mcp list
# → plugin:wejob:wejob   https://mcp.wejob.ch/mcp (HTTP)   ✓ Connected
```

## Point the plugin at a local MCP server (development)

Override the MCP URL with an environment variable before starting Claude Code:

```sh
WEJOB_MCP_URL=http://127.0.0.1:8787/mcp
```

The manifest reads `${WEJOB_MCP_URL:-https://mcp.wejob.ch/mcp}`, so setting the
variable swaps the endpoint without editing files.

Open a **new session** after (re)installing the plugin — existing sessions
don't pick up new plugin skills or MCP tools.

## Structure

```
plugins/wejob/
├── .claude-plugin/plugin.json    # manifest (Claude host)
├── skills/wejob/SKILL.md          # skill loaded into Claude's context
├── assets/{icon,logo}.png         # visual assets
└── README.md                      # this file
```

See the [root README](../../README.md) for install instructions on Cowork and
for the full documentation link (`wejob.ch/mcp-wejob`).
