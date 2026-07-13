---
name: wejob
description: Use WeJob to search public jobs, formations, and company profiles. Trigger when the user asks for WeJob data, jobs/offres, formations, companies/entreprises, or career discovery on WeJob.
---

# WeJob

Use the WeJob MCP tools for all WeJob data requests.

## Required Tool Flow

1. Use the MCP tool exposed by this plugin whenever the user asks for WeJob data.
2. If the tool is not already visible, discover it with tool search using:
   `wejob_search_jobs wejob_search_formations wejob_search_companies wejob_get_job wejob_get_formation wejob_get_company`.
3. Do not inspect the local repository, backend routes, frontend code, local databases, or source files to answer WeJob data requests.
4. Do not use generic web search for WeJob data requests unless the WeJob MCP tool is unavailable and the user explicitly accepts a fallback.

## Tool Selection

- Jobs/offres d'emploi: use `wejob_search_jobs`.
- Job detail/detail d'une offre: use `wejob_get_job`.
- Formations: use `wejob_search_formations`.
- Formation detail/detail d'une formation: use `wejob_get_formation`.
- Companies/entreprises: use `wejob_search_companies`.
- Company detail/profil entreprise: use `wejob_get_company`.
- Broad search across all public WeJob entities: use `search`.
- Fetch a known composite id such as `job:<id>`, `formation:<id>`, or `company:<id>`: use `fetch`.

## Parameters

- Use `location` for city, canton, or region filters such as `Vaud`, `Lausanne`, or `Geneve`.
- Use `query` for role, keyword, company name, or topic.
- Use `skills` for comma-separated skill filters.
- Use `limit` between 1 and 50. Default to 10 when the user does not specify a count.

## Response Style

Return concise, useful results with title and URL. Add key fields such as company,
location, deadline, skills, salary, certification, or formation mode when the
user asks for details.
