import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

const SERVER_NAME = "wejob-mcp";
const SERVER_VERSION = "0.1.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_API_BASE_URL = "http://127.0.0.1:8000/api";
const DEFAULT_WEB_BASE_URL = "http://127.0.0.1:3000";
const MAX_HTTP_BODY_BYTES = 1024 * 1024;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const LOG_LEVELS = new Map([
  ["silent", 0],
  ["error", 1],
  ["warn", 2],
  ["info", 3],
]);

// Per-request trace: the request id (forwarded to the API as X-Request-Id) and the
// API calls made while serving the request, summarized in the request log line.
// Only paths, statuses and latencies are kept: never query strings or tool values.
const requestTrace = new AsyncLocalStorage();
const MAX_TRACED_UPSTREAM_CALLS = 10;

const searchResultSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          company: { type: "string" },
          logo: { type: "string" },
          location: { type: "string" },
        },
        required: ["id", "title", "url"],
        additionalProperties: true,
      },
    },
    pagination: {
      type: "object",
      properties: {
        page: { type: "integer" },
        limit: { type: "integer" },
        has_more: { type: "boolean" },
        total: { type: "integer" },
      },
      required: ["page", "limit", "has_more"],
      additionalProperties: false,
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const fetchResultSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    company: { type: "string" },
    logo: { type: "string" },
    location: { type: "string" },
    description: { type: "string" },
    responsibilities: {
      type: "array",
      items: { type: "string" },
    },
    profile: {
      type: "array",
      items: { type: "string" },
    },
    prerequisites: { type: "string" },
    program: { type: "string" },
    learning_outcomes: { type: "string" },
    mission: { type: "string" },
    culture: { type: "string" },
    website: { type: "string" },
    founded_at: { type: "string" },
    contact: {
      type: "object",
      properties: {
        email: { type: "string" },
        phone: { type: "string" },
        social_links: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
      additionalProperties: false,
    },
    contract_types: {
      type: "array",
      items: { type: "string" },
    },
    activity_rate: { type: "string" },
    work_mode: { type: "string" },
    salary: {
      type: "object",
      properties: {
        min: { type: "number" },
        max: { type: "number" },
        currency: { type: "string" },
      },
      additionalProperties: false,
    },
    required_hard_skills: {
      type: "array",
      items: { type: "string" },
    },
    required_soft_skills: {
      type: "array",
      items: { type: "string" },
    },
    nice_to_have_skills: {
      type: "array",
      items: { type: "string" },
    },
    languages: {
      type: "array",
      items: { type: "string" },
    },
    benefits: {
      type: "array",
      items: { type: "string" },
    },
    experience_level: { type: "string" },
    business_sector: { type: "string" },
    expertise_domains: {
      type: "array",
      items: { type: "string" },
    },
    application_deadline: { type: "string" },
    formation_mode: { type: "string" },
    certification_type: { type: "string" },
    price: {
      type: "object",
      properties: {
        amount: { type: "number" },
        currency: { type: "string" },
      },
      required: ["amount", "currency"],
      additionalProperties: false,
    },
    duration: { type: "string" },
    categories: {
      type: "array",
      items: { type: "string" },
    },
    start_date: { type: "string" },
    end_date: { type: "string" },
    industry: { type: "string" },
    company_size: { type: ["string", "number"] },
    locations: {
      type: "array",
      items: { type: "string" },
    },
    tech_stack: {
      type: "array",
      items: { type: "string" },
    },
    values: {
      type: "array",
      items: { type: "string" },
    },
    jobs: {
      type: "array",
      items: searchResultSchema.properties.results.items,
    },
    formations: {
      type: "array",
      items: searchResultSchema.properties.results.items,
    },
    active_jobs: { type: "number" },
    active_formations: { type: "number" },
  },
  required: ["id", "title", "url"],
  additionalProperties: true,
};

const LIMIT_PROPERTY = {
  type: "integer",
  description: "Maximum number of results.",
  minimum: 1,
  maximum: MAX_SEARCH_LIMIT,
  default: DEFAULT_SEARCH_LIMIT,
};

const PAGE_PROPERTY = {
  type: "integer",
  description: "One-based result page number.",
  minimum: 1,
  default: 1,
};

const SORT_PROPERTY = {
  type: "string",
  description: "Optional public result sort order.",
  enum: [
    "newest",
    "oldest",
    "deadline_soon",
    "deadline_later",
    "level_asc",
    "price_asc",
    "price_desc",
    "duration_asc",
    "smallest",
    "largest",
    "founded_newest",
    "founded_oldest",
    "most_jobs",
  ],
};

// What each public API endpoint really reads (wejob-backend JobController::publicIndex,
// FormationController::publicIndex, PublicCompanyController::index). Every search tool
// advertises only its own filters, with the accepted values, so assistants stop guessing.
// Types stay "string" (the ChatGPT widget also sends lists) and the server still accepts
// the other keys: they are just not advertised anymore.
const FILTER_PROPERTIES = {
  location: {
    type: "string",
    description: "City or canton, e.g. Genève, Vaud, Lausanne, Zurich. Comma-separate several places.",
  },
  company: { type: "string", description: "Company name filter, e.g. WeJob Sàrl." },
  skills: {
    type: "string",
    description: "Comma-separated hard skills, e.g. Java, SQL. Only matches skills listed on the offer: prefer query for a broad search.",
  },
  technologies: { type: "string", description: "Comma-separated technologies, e.g. React, AWS." },
  languages: {
    type: "string",
    description: "Comma-separated language filter, for example Anglais, English, en.",
  },
  employment_type: {
    type: "string",
    description: "Comma-separated contract or workload: full_time, part_time, CDI, CDD, contract, internship, apprenticeship, freelance. French terms are accepted (temps plein, temps partiel, stage, alternance).",
  },
  work_mode: {
    type: "string",
    description: "Comma-separated work mode: on_site, hybrid, remote (sur site, hybride, télétravail are accepted).",
  },
  experience_level: {
    type: "string",
    description: "Comma-separated level: junior, intermediate, senior, expert (entry, mid, confirmé, lead are accepted).",
  },
  categories: { type: "string", description: "Comma-separated category names, e.g. Développement & IT." },
  salary_min: { type: "string", description: "Minimum salary as a number, in the offer currency (CHF), e.g. 100000." },
  salary_max: { type: "string", description: "Maximum salary as a number, in the offer currency (CHF), e.g. 140000." },
  formation_mode: {
    type: "string",
    description: "Comma-separated training mode: presentiel, distanciel, hybride (on-site, online, hybrid are accepted).",
  },
  certification_type: {
    type: "string",
    description: "Comma-separated certification: certificat, diplome, attestation, bootcamp, aucun (certificate, diploma, none are accepted).",
  },
  tarif_min: { type: "string", description: "Minimum price as a number, e.g. 500." },
  tarif_max: { type: "string", description: "Maximum price as a number, e.g. 3000." },
  duration_min: { type: "string", description: "Minimum duration in days, e.g. 5." },
  duration_max: { type: "string", description: "Maximum duration in days, e.g. 30." },
  industries: {
    type: "string",
    description: "Comma-separated business sectors, e.g. technologies, finance, sante, education, commerce, marketing, consulting, industrie, telecommunications.",
  },
  sizes: {
    type: "string",
    description: "Comma-separated company sizes (employees): 1-10, 11-50, 51-200, 201-500, 501-1000, 1001-5000, 5000+.",
  },
};

const SEARCH_KIND_FILTERS = {
  job: ["location", "company", "skills", "technologies", "languages", "employment_type", "work_mode", "experience_level", "categories", "salary_min", "salary_max"],
  formation: ["location", "company", "skills", "technologies", "formation_mode", "certification_type", "categories", "tarif_min", "tarif_max", "duration_min", "duration_max"],
  company: ["location", "industries", "sizes", "technologies"],
};

const SEARCH_KIND_SORTS = {
  job: ["newest", "oldest", "deadline_soon", "deadline_later", "level_asc"],
  formation: ["newest", "oldest", "deadline_soon", "deadline_later", "price_asc", "price_desc", "duration_asc"],
  company: ["newest", "oldest", "most_jobs", "largest", "smallest", "founded_newest", "founded_oldest"],
};

const SEARCH_KIND_QUERY = {
  job: "Free-text search over titles, descriptions, skills, companies and places. Words are OR-ed: one or two keywords work best, e.g. Java or data engineer.",
  formation: "Free-text search over titles, descriptions and programs, e.g. cybersécurité.",
  company: "Free-text search over company names and descriptions.",
};

export const tools = [
  {
    name: "search",
    title: "Search WeJob",
    description:
      "Search public WeJob jobs, formations, and companies. Returns ids usable with fetch.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: LIMIT_PROPERTY,
        page: PAGE_PROPERTY,
        sort: SORT_PROPERTY,
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: searchResultSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: "fetch",
    title: "Fetch WeJob item",
    description:
      "Fetch a public WeJob item by id. Supported id prefixes: job:, formation:, company:.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Result id returned by search." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    outputSchema: fetchResultSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: "wejob_search_jobs",
    title: "Search WeJob jobs",
    description: "Search public active WeJob job offers.",
    inputSchema: searchInputSchema("job"),
    outputSchema: searchResultSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: "wejob_get_job",
    title: "Get WeJob job",
    description: "Fetch one public active WeJob job offer by public id (raw id or the job:<id> returned by search/fetch).",
    inputSchema: idInputSchema("Public job id."),
    outputSchema: fetchResultSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: "wejob_search_formations",
    title: "Search WeJob formations",
    description: "Search public active WeJob formations.",
    inputSchema: searchInputSchema("formation"),
    outputSchema: searchResultSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: "wejob_get_formation",
    title: "Get WeJob formation",
    description: "Fetch one public active WeJob formation by public id (raw id or the formation:<id> returned by search/fetch).",
    inputSchema: idInputSchema("Public formation id."),
    outputSchema: fetchResultSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: "wejob_search_companies",
    title: "Search WeJob companies",
    description: "Search public WeJob company profiles.",
    inputSchema: searchInputSchema("company"),
    outputSchema: searchResultSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
  {
    name: "wejob_get_company",
    title: "Get WeJob company",
    description: "Fetch one public WeJob company profile by public id (raw id or the company:<id> returned by search/fetch).",
    inputSchema: idInputSchema("Public company id."),
    outputSchema: fetchResultSchema,
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  },
];

function searchInputSchema(kind) {
  const properties = {
    query: { type: "string", description: SEARCH_KIND_QUERY[kind], default: "" },
    limit: LIMIT_PROPERTY,
    page: PAGE_PROPERTY,
    sort: { ...SORT_PROPERTY, enum: SEARCH_KIND_SORTS[kind] },
  };
  for (const key of SEARCH_KIND_FILTERS[kind]) {
    properties[key] = { ...FILTER_PROPERTIES[key] };
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

function idInputSchema(description) {
  return {
    type: "object",
    properties: {
      id: { type: "string", description },
    },
    required: ["id"],
    additionalProperties: false,
  };
}

// The Laravel API reads these filters as arrays (`employment_type[]=…`) and some of
// them (employment_type, experience_level) do not split a comma-separated string.
// Several values are sent as repeated `key[]` params; a single value keeps the exact
// same `key=value` query as before.
const MULTI_VALUE_QUERY_PARAMS = new Set([
  "location",
  "employment_type",
  "work_mode",
  "experience_level",
  "formation_mode",
  "certification_type",
  "categories",
  "sizes",
  "industries",
  "technologies",
]);

const FILTER_VALUE_ALIASES = {
  employment_type: {
    full_time: "full_time", fulltime: "full_time", plein_temps: "full_time", temps_plein: "full_time",
    part_time: "part_time", parttime: "part_time", temps_partiel: "part_time", mi_temps: "part_time",
    contract: "contract", contrat: "contract",
    internship: "internship", stage: "internship",
    apprenticeship: "apprenticeship", alternance: "apprenticeship", apprentissage: "apprenticeship",
    freelance: "freelance", cdi: "CDI", cdd: "CDD",
  },
  experience_level: {
    entry: "junior", junior: "junior", debutant: "junior",
    mid: "intermediate", intermediate: "intermediate", intermediaire: "intermediate", confirme: "intermediate",
    senior: "senior",
    lead: "expert", executive: "expert", expert: "expert",
  },
  formation_mode: {
    presentiel: "presentiel", on_site: "presentiel", onsite: "presentiel", in_person: "presentiel", sur_site: "presentiel",
    distanciel: "distanciel", online: "distanciel", remote: "distanciel", en_ligne: "distanciel", a_distance: "distanciel",
    hybride: "hybride", hybrid: "hybride", blended: "hybride",
  },
  certification_type: {
    certificat: "certificat", certificate: "certificat", certification: "certificat",
    diplome: "diplome", diploma: "diplome", degree: "diplome",
    attestation: "attestation", bootcamp: "bootcamp",
    aucun: "aucun", aucune: "aucun", none: "aucun",
  },
};

function filterAliasKey(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[\s-]+/g, "_").replace(/^_+|_+$/g, "");
}

const CASE_INSENSITIVE_FILTERS = new Set(["employment_type", "experience_level"]);

export function normalizeFilterValues(filterName, value) {
  const aliases = FILTER_VALUE_ALIASES[filterName];
  if (!aliases || value === undefined || value === null || value === "") return value;
  const mapped = multiValueList(value).map((item) => {
    const key = filterAliasKey(item);
    const target = aliases[key];
    if (!target) return item;
    // The API lowercases employment_type and experience_level itself: a value that is
    // already right (cdi, Senior) is sent as typed. formation_mode and
    // certification_type are compared exactly, so they always get the stored form.
    return CASE_INSENSITIVE_FILTERS.has(filterName) && filterAliasKey(target) === key ? item : target;
  });
  return Array.isArray(value) ? mapped : mapped.join(",");
}

// The site's canton filter sends the code and the label of each canton (location[]=GE
// &location[]=Genève, from /api/jobs/cantons); sending the label alone matched fewer
// companies. Canton names in French, German, Italian or English, or the code, become
// that same pair. Cities and other places are sent as typed.
const SWISS_CANTONS = [
  ["AG", "Argovie", ["aargau", "argovia"]],
  ["AI", "Appenzell Rhodes-Intérieures", ["appenzell innerrhoden", "appenzello interno"]],
  ["AR", "Appenzell Rhodes-Extérieures", ["appenzell ausserrhoden", "appenzello esterno"]],
  ["BE", "Berne", ["bern", "berna"]],
  ["BL", "Bâle-Campagne", ["basel-landschaft", "basilea campagna"]],
  ["BS", "Bâle-Ville", ["basel-stadt", "basilea citta"]],
  ["FR", "Fribourg", ["freiburg", "friburgo"]],
  ["GE", "Genève", ["geneva", "genf", "ginevra"]],
  ["GL", "Glaris", ["glarus", "glarona"]],
  ["GR", "Grisons", ["graubunden", "grigioni"]],
  ["JU", "Jura", ["giura"]],
  ["LU", "Lucerne", ["luzern", "lucerna"]],
  ["NE", "Neuchâtel", ["neuenburg"]],
  ["NW", "Nidwald", ["nidwalden", "nidvaldo"]],
  ["OW", "Obwald", ["obwalden", "obvaldo"]],
  ["SG", "Saint-Gall", ["st. gallen", "st gallen", "sankt gallen", "san gallo"]],
  ["SH", "Schaffhouse", ["schaffhausen", "sciaffusa"]],
  ["SO", "Soleure", ["solothurn", "soletta"]],
  ["SZ", "Schwytz", ["schwyz", "svitto"]],
  ["TG", "Thurgovie", ["thurgau", "turgovia"]],
  ["TI", "Tessin", ["ticino"]],
  ["UR", "Uri", []],
  ["VD", "Vaud", ["waadt"]],
  ["VS", "Valais", ["wallis", "vallese"]],
  ["ZG", "Zoug", ["zug", "zugo"]],
  ["ZH", "Zurich", ["zürich", "zurigo"]],
];

function placeKey(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[\s-]+/g, " ").trim();
}

const CANTON_BY_NAME = new Map(
  SWISS_CANTONS.flatMap(([code, label, aliases]) => [code, label, ...aliases].map((name) => [placeKey(name), [code, label]])),
);

export function expandCantonLocations(value) {
  if (value === undefined || value === null || value === "") return value;
  const places = [];
  for (const term of multiValueList(value)) {
    const canton = CANTON_BY_NAME.get(placeKey(term));
    for (const place of canton ?? [term]) {
      if (!places.includes(place)) places.push(place);
    }
  }
  return places;
}

function multiValueList(value) {
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return raw.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function termList(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return multiValueList(value);
}

export function createWeJobClient(options = {}) {
  const apiBaseUrl = stripTrailingSlash(
    options.apiBaseUrl ?? process.env.WEJOB_API_BASE_URL ?? DEFAULT_API_BASE_URL
  );
  const webBaseUrl = stripTrailingSlash(
    options.webBaseUrl ?? process.env.WEJOB_WEB_BASE_URL ?? DEFAULT_WEB_BASE_URL
  );
  const token = options.token ?? process.env.WEJOB_API_TOKEN ?? "";
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  async function getJson(path, params = {}) {
    const url = new URL(apiBaseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      if (MULTI_VALUE_QUERY_PARAMS.has(key)) {
        const values = multiValueList(value);
        if (values.length > 1) {
          for (const item of values) {
            url.searchParams.append(`${key}[]`, item);
          }
        } else if (values.length === 1) {
          url.searchParams.set(key, values[0]);
        }
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    const headers = {
      Accept: "application/json",
      "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const trace = requestTrace.getStore();
    if (trace?.requestId) {
      headers["X-Request-Id"] = trace.requestId;
    }

    const upstreamStartedAt = Date.now();
    const recordUpstream = (status) => {
      if (trace && trace.upstream.length < MAX_TRACED_UPSTREAM_CALLS) {
        trace.upstream.push({ path: url.pathname, status, latency_ms: Date.now() - upstreamStartedAt });
      }
    };

    let response;
    try {
      response = await fetchImpl(url, { method: "GET", headers });
    } catch (cause) {
      recordUpstream("network_error");
      const error = jsonRpcError(-32603, "WeJob API is unreachable.");
      error.data = { type: "unavailable" };
      // Logged only (not returned to clients): ECONNREFUSED, ETIMEDOUT, ENOTFOUND…
      error.causeCode = networkCauseCode(cause);
      throw error;
    }
    recordUpstream(response.status);
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const message = typeof body === "object" && body?.message
        ? body.message
        : `WeJob API request failed with HTTP ${response.status}`;
      throw apiError(response.status, message);
    }

    return body ?? {};
  }

  // Shared search pipeline: clamp pagination once, forward it to the API, and
  // slice defensively so an over-delivering API never exceeds the requested cap.
  // getJson drops undefined/null/"" params, so passing the full param set is
  // equivalent to each endpoint's specific subset.
  async function runSearch(path, args, type, extraParams = {}) {
    const limit = clampLimit(args.limit);
    const page = clampPage(args.page);
    // The API casts salaries with (float): "abc" silently became 0 and an inverted
    // range silently returned nothing (WJ-11). Values are validated, not rewritten.
    const salaryMin = nonNegativeNumberArg(args.salary_min, "salary_min");
    const salaryMax = nonNegativeNumberArg(args.salary_max, "salary_max");
    if (salaryMin !== undefined && salaryMax !== undefined && salaryMin > salaryMax) {
      throw jsonRpcError(-32602, "salary_min must be lower than or equal to salary_max.");
    }
    const sortParams = searchSortParams(type, args.sort);
    const defaultOrder = !args.sort || String(args.sort).trim() === "newest";
    const highlightParams = type !== "company" && page === 1 && defaultOrder ? { prioritize_highlight: 1 } : {};
    const advancedFilters = Object.fromEntries(
      [
        "employment_type",
        "work_mode",
        "experience_level",
        "formation_mode",
        "certification_type",
        "categories",
        "sizes",
        "industries",
        "technologies",
        "salary_min",
        "salary_max",
        "tarif_min",
        "tarif_max",
        "duration_min",
        "duration_max",
      ]
        .filter((key) => args[key] !== undefined && args[key] !== null && args[key] !== "")
        .map((key) => [key, normalizeFilterValues(key, args[key])])
    );
    // Only /companies has a real `technologies` filter. /jobs and /formations ignore it
    // but split `skills` on , ; | — fold the technologies into skills there.
    let skills = args.skills;
    if (type !== "company" && "technologies" in advancedFilters) {
      skills = [...termList(args.skills), ...termList(args.technologies)].join(",");
      delete advancedFilters.technologies;
    }
    const data = await getJson(path, {
      search: args.query,
      location: expandCantonLocations(args.location),
      company: args.company,
      skills,
      languages: args.languages,
      per_page: limit,
      page,
      ...sortParams,
      ...highlightParams,
      ...advancedFilters,
      ...extraParams,
    });
    const results = extractItems(data, "data")
      .slice(0, limit)
      .map((item) => toSearchResult(type, item, webBaseUrl));
    return {
      results,
      pagination: paginationFromApiResponse(data, { page, limit, resultCount: results.length }),
    };
  }

  return {
    apiBaseUrl,
    webBaseUrl,
    async searchJobs(args = {}) {
      return runSearch("/jobs", args, "job", { compact: 1 });
    },
    async getJob(id) {
      const data = await getJson(`/jobs/${encodeURIComponent(id)}`);
      return toFetchResult("job", data.job ?? data, webBaseUrl);
    },
    async searchFormations(args = {}) {
      return runSearch("/formations", args, "formation");
    },
    async getFormation(id) {
      const data = await getJson(`/formations/${encodeURIComponent(id)}`);
      return toFetchResult("formation", data.formation ?? data, webBaseUrl);
    },
    async searchCompanies(args = {}) {
      return runSearch("/companies", args, "company");
    },
    async getCompany(id) {
      const data = await getJson(`/companies/${encodeURIComponent(id)}`);
      return toFetchResult("company", data, webBaseUrl);
    },
  };
}

export function createLogger(options = {}) {
  const levelName = String(options.level ?? process.env.WEJOB_MCP_LOG_LEVEL ?? "info").toLowerCase();
  const threshold = LOG_LEVELS.get(levelName) ?? LOG_LEVELS.get("info");
  const writer = options.writer ?? process.stderr;

  const write = (level, event) => {
    if ((LOG_LEVELS.get(level) ?? 0) > threshold || threshold === 0) {
      return;
    }

    const payload = removeEmpty({
      timestamp: new Date().toISOString(),
      level,
      service: options.service ?? SERVER_NAME,
      version: options.version ?? SERVER_VERSION,
      ...event,
    });

    try {
      writer.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Logging must never break MCP responses.
    }
  };

  return {
    info: (event) => write("info", event),
    warn: (event) => write("warn", event),
    error: (event) => write("error", event),
  };
}

export async function callTool(name, args = {}, client = createWeJobClient()) {
  switch (name) {
    case "search": {
      const limit = clampLimit(args.limit);
      const page = clampPage(args.page);
      const searchArgs = { query: args.query, limit, page, sort: args.sort };
      const [jobs, formations, companies] = await Promise.all([
        client.searchJobs(searchArgs),
        client.searchFormations(searchArgs),
        client.searchCompanies(searchArgs),
      ]);
      const results = [
        ...extractSearchResults(jobs),
        ...extractSearchResults(formations),
        ...extractSearchResults(companies),
      ].slice(0, limit);
      return toolJson({
        results,
        pagination: { page, limit, has_more: [jobs, formations, companies].some(hasMoreSearchResults) },
      });
    }
    case "fetch":
      return toolJson(await fetchByCompositeId(String(args.id ?? ""), client));
    case "wejob_search_jobs":
      return toolJson(normalizeSearchPayload(await client.searchJobs(args), args));
    case "wejob_get_job":
      return toolJson(await client.getJob(publicIdArg(args.id, "job")));
    case "wejob_search_formations":
      return toolJson(normalizeSearchPayload(await client.searchFormations(args), args));
    case "wejob_get_formation":
      return toolJson(await client.getFormation(publicIdArg(args.id, "formation")));
    case "wejob_search_companies":
      return toolJson(normalizeSearchPayload(await client.searchCompanies(args), args));
    case "wejob_get_company":
      return toolJson(await client.getCompany(publicIdArg(args.id, "company")));
    default:
      throw jsonRpcError(-32602, `Unknown tool: ${name}`);
  }
}

async function fetchByCompositeId(compositeId, client) {
  const [type, ...rest] = compositeId.split(":");
  const id = rest.join(":");
  if (!type || !id) {
    throw jsonRpcError(-32602, "Expected id format job:<id>, formation:<id>, or company:<id>.");
  }

  if (type === "job") {
    return client.getJob(id);
  }
  if (type === "formation") {
    return client.getFormation(id);
  }
  if (type === "company") {
    return client.getCompany(id);
  }

  throw jsonRpcError(-32602, `Unsupported WeJob id prefix: ${type}`);
}

export async function handleJsonRpc(message, client = createWeJobClient(), context = {}) {
  if (Array.isArray(message)) {
    const responses = [];
    for (const item of message) {
      const response = await handleJsonRpc(item, client, context);
      if (response !== null) {
        responses.push(response);
      }
    }
    return responses.length > 0 ? responses : null;
  }

  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    logMcpEvent(context.logger, "warn", {
      request_id: context.requestId,
      transport: context.transport,
      event: "mcp_request",
      status: "invalid_request",
      error_code: -32600,
    });
    return {
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: { code: -32600, message: "Invalid JSON-RPC request." },
    };
  }

  const isNotification = !Object.prototype.hasOwnProperty.call(message, "id");
  const startedAt = Date.now();
  const requestId = context.requestId ?? createRequestId();
  // initialize carries the client's own name (clientInfo): log it, and use it to
  // name the caller when the User-Agent did not identify it.
  const clientInfo = message.method === "initialize" ? message.params?.clientInfo : undefined;
  const clientName = plainToken(clientInfo?.name, 60);
  const caller = context.caller && context.caller !== "unknown"
    ? context.caller
    : detectCaller(clientName) ?? context.caller;
  const logBase = {
    request_id: requestId,
    transport: context.transport ?? "json-rpc",
    event: "mcp_request",
    caller,
    client_name: clientName || undefined,
    client_version: plainToken(clientInfo?.version, 30) || undefined,
    mcp_method: message.method,
    mcp_tool: message.method === "tools/call" ? cleanText(message.params?.name) : "",
    // Argument names only (which filters were used), never their values.
    args_keys: message.method === "tools/call" ? argumentKeys(message.params?.arguments) : undefined,
    notification: isNotification,
  };
  const trace = { requestId, upstream: [] };

  try {
    const result = await requestTrace.run(trace, () => dispatchMethod(message.method, message.params ?? {}, client));
    logMcpEvent(context.logger, "info", {
      ...logBase,
      status: "ok",
      latency_ms: Date.now() - startedAt,
      ...resultSummary(result),
      upstream: trace.upstream,
    });
    if (isNotification) {
      return null;
    }
    return { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    const code = Number.isInteger(error?.code) ? error.code : -32603;
    logMcpEvent(context.logger, "error", {
      ...logBase,
      status: "error",
      latency_ms: Date.now() - startedAt,
      error_code: code,
      error_message: safeErrorMessage(error, "Internal error."),
      error_type: error?.data?.type,
      upstream_status: error?.data?.http_status,
      error_cause: error?.causeCode,
      upstream: trace.upstream,
    });
    if (isNotification) {
      return null;
    }
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code,
        message: safeErrorMessage(error, "Internal error."),
        ...(error?.data ? { data: error.data } : {}),
      },
    };
  }
}

// Prompts: the three requests users make most, written so the assistant calls the right
// tools and answers from their results only.
const PROMPT_ARGUMENT_MAX_LENGTH = 120;

export const prompts = [
  {
    name: "find_jobs",
    title: "Find WeJob jobs",
    description: "Search public WeJob job offers for a role, optionally in a Swiss city or canton.",
    arguments: [
      { name: "role", description: "Role, skill or keyword, e.g. Java developer, data engineer.", required: true },
      { name: "location", description: "City or canton, e.g. Lausanne, Genève, Zurich.", required: false },
    ],
  },
  {
    name: "company_overview",
    title: "WeJob company overview",
    description: "Present a company's public WeJob profile and its open job offers.",
    arguments: [
      { name: "company", description: "Company name, e.g. IT ADVANCED CONSULTING SA.", required: true },
    ],
  },
  {
    name: "job_summary",
    title: "Summarize a WeJob job",
    description: "Summarize one public WeJob job offer from its id or title.",
    arguments: [
      { name: "job", description: "Job id returned by a search (job:...) or the job title.", required: true },
    ],
  },
];

function promptArgument(args, name, required) {
  const value = String(args?.[name] ?? "").replace(/\s+/g, " ").trim().slice(0, PROMPT_ARGUMENT_MAX_LENGTH);
  if (required && !value) throw jsonRpcError(-32602, `Missing required prompt argument: ${name}`);
  return value;
}

function promptMessage(description, text) {
  return { description, messages: [{ role: "user", content: { type: "text", text } }] };
}

export function getPrompt(name, args = {}) {
  const prompt = prompts.find((item) => item.name === name);
  if (!prompt) throw jsonRpcError(-32602, `Unknown prompt: ${String(name ?? "").slice(0, 60)}`);

  if (name === "find_jobs") {
    const role = promptArgument(args, "role", true);
    const location = promptArgument(args, "location", false);
    return promptMessage(prompt.description, [
      `Find public WeJob job offers for "${role}"${location ? ` in ${location}` : ""}.`,
      `Use wejob_search_jobs with query set to one or two keywords for the role${location ? ` and location "${location}"` : ""}.`,
      "Say how many offers exist (pagination.total), then list up to 10 with title, company, location, application deadline and the WeJob link.",
      "Use only what the results contain, and offer to open an offer or show the next page. Answer in the user's language.",
    ].join("\n"));
  }

  if (name === "company_overview") {
    const company = promptArgument(args, "company", true);
    return promptMessage(prompt.description, [
      `Show the public WeJob profile of "${company}".`,
      "Find it with wejob_search_companies (query), then open the best match with wejob_get_company.",
      "Summarize its description, sector, size, locations and website, then list its open job offers with their WeJob links.",
      "If no company matches, say so and suggest checking the spelling. Answer in the user's language.",
    ].join("\n"));
  }

  const job = promptArgument(args, "job", true);
  return promptMessage(prompt.description, [
    `Summarize the public WeJob job offer "${job}".`,
    "If it is an id (job:...), open it with wejob_get_job; otherwise find it with wejob_search_jobs first, then open it.",
    "Summarize responsibilities, required profile and skills, contract, work mode, location, salary if published and the application deadline, then give the WeJob link to apply.",
    "Write \"not specified\" for any missing field instead of guessing. Answer in the user's language.",
  ].join("\n"));
}

// Resources: reference data an assistant can attach to understand the search tools.
export const resources = [
  {
    uri: "wejob://search-filters",
    name: "search-filters",
    title: "WeJob search filters and sorts",
    description: "Filters, accepted values and sort orders of the job, training and company searches.",
    mimeType: "application/json",
  },
  {
    uri: "wejob://swiss-cantons",
    name: "swiss-cantons",
    title: "Swiss cantons",
    description: "Codes and names of the 26 Swiss cantons accepted in the location filter, in French, German, Italian and English.",
    mimeType: "application/json",
  },
];

function resourceContent(uri) {
  if (uri === "wejob://search-filters") {
    const kinds = { job: "wejob_search_jobs", formation: "wejob_search_formations", company: "wejob_search_companies" };
    return {
      limit: { min: 1, max: MAX_SEARCH_LIMIT, default: DEFAULT_SEARCH_LIMIT },
      results: "Exact matches only; pagination.total gives the number of results.",
      searches: Object.fromEntries(Object.entries(kinds).map(([kind, tool]) => [tool, {
        query: SEARCH_KIND_QUERY[kind],
        filters: Object.fromEntries(SEARCH_KIND_FILTERS[kind].map((key) => [key, FILTER_PROPERTIES[key].description])),
        sorts: SEARCH_KIND_SORTS[kind],
      }])),
    };
  }
  if (uri === "wejob://swiss-cantons") {
    return {
      usage: "Pass a canton name in any of these languages, or its code, as location.",
      cantons: SWISS_CANTONS.map(([code, name, aliases]) => ({ code, name, aliases })),
    };
  }
  return null;
}

export function readResource(uri) {
  const value = resourceContent(String(uri ?? ""));
  if (!value) throw jsonRpcError(-32002, `Resource not found: ${String(uri ?? "").slice(0, 100)}`);
  const resource = resources.find((item) => item.uri === uri);
  return { contents: [{ uri, mimeType: resource.mimeType, text: JSON.stringify(value, null, 2) }] };
}

async function dispatchMethod(method, params, client) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: params.protocolVersion ?? MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
        instructions:
          "Use WeJob tools only for public read-only discovery of jobs, formations, and companies. Do not infer private candidate or recruiter data.",
      };
    case "notifications/initialized":
      return {};
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call":
      return callTool(requireString(params.name, "name"), params.arguments ?? {}, client);
    case "resources/list":
      return { resources };
    case "resources/read":
      return readResource(params.uri);
    case "prompts/list":
      return { prompts };
    case "prompts/get":
      return getPrompt(params.name, params.arguments ?? {});
    default:
      throw jsonRpcError(-32601, `Method not found: ${method}`);
  }
}

export function createHttpMcpServer(options = {}) {
  const client = options.client ?? createWeJobClient(options);
  const logger = options.logger ?? createLogger(options);
  const openaiAppsChallengeToken = options.openaiAppsChallengeToken ?? process.env.OPENAI_APPS_CHALLENGE_TOKEN ?? "";
  const server = http.createServer(async (request, response) => {
    const requestId = sanitizeRequestId(request.headers["x-request-id"]) || createRequestId();
    const startedAt = Date.now();
    const logBase = {
      request_id: requestId,
      transport: "http",
      event: "http_request",
      http_method: request.method,
      path: new URL(request.url ?? "/", "http://localhost").pathname,
      // Which platform calls us (ChatGPT, Claude, Discord bot, Alexa skill…).
      caller: detectCaller(request.headers["user-agent"]),
      user_agent: String(request.headers["user-agent"] ?? "").slice(0, 120) || undefined,
    };

    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          name: SERVER_NAME,
          version: SERVER_VERSION,
        });
        logMcpEvent(logger, "info", {
          ...logBase,
          status: "ok",
          http_status: 200,
          latency_ms: Date.now() - startedAt,
        });
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
        sendJson(response, 200, {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          endpoint: "/mcp",
          transport: "http-json-rpc",
        });
        logMcpEvent(logger, "info", {
          ...logBase,
          status: "ok",
          http_status: 200,
          latency_ms: Date.now() - startedAt,
        });
        return;
      }

      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === OPENAI_APPS_CHALLENGE_PATH) {
        if (!openaiAppsChallengeToken) {
          sendJson(response, 404, { error: "Not found." });
          logMcpEvent(logger, "warn", {
            ...logBase,
            status: "not_found",
            http_status: 404,
            latency_ms: Date.now() - startedAt,
          });
          return;
        }

        sendText(response, 200, openaiAppsChallengeToken);
        logMcpEvent(logger, "info", {
          ...logBase,
          status: "ok",
          http_status: 200,
          latency_ms: Date.now() - startedAt,
        });
        return;
      }

      if (url.pathname === "/mcp" && request.method !== "POST") {
        // Streamable HTTP: this endpoint offers no server->client SSE stream,
        // so any non-POST verb (GET, OPTIONS, ...) is Method Not Allowed.
        sendJson(response, 405, { error: "Method not allowed." }, { Allow: "POST" });
        logMcpEvent(logger, "warn", {
          ...logBase,
          status: "method_not_allowed",
          http_status: 405,
          latency_ms: Date.now() - startedAt,
        });
        return;
      }

      if (request.method !== "POST" || url.pathname !== "/mcp") {
        sendJson(response, 404, { error: "Not found." });
        logMcpEvent(logger, "warn", {
          ...logBase,
          status: "not_found",
          http_status: 404,
          latency_ms: Date.now() - startedAt,
        });
        return;
      }

      const body = await readRequestBody(request);
      const message = JSON.parse(body);
      const rpcResponse = await handleJsonRpc(message, client, {
        logger,
        requestId,
        transport: "http",
        caller: logBase.caller,
      });
      if (rpcResponse === null) {
        response.writeHead(202).end();
        logMcpEvent(logger, "info", {
          ...logBase,
          status: "accepted",
          http_status: 202,
          latency_ms: Date.now() - startedAt,
        });
        return;
      }

      sendJson(response, 200, rpcResponse);
      logMcpEvent(logger, "info", {
        ...logBase,
        status: "ok",
        http_status: 200,
        latency_ms: Date.now() - startedAt,
      });
    } catch (error) {
      sendJson(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: safeErrorMessage(error, "Invalid request."),
        },
      });
      logMcpEvent(logger, "error", {
        ...logBase,
        status: "error",
        http_status: 400,
        latency_ms: Date.now() - startedAt,
        error_code: -32700,
        // Only the error type: a JSON.parse message quotes the request body (user input).
        error_name: String(error?.name ?? "Error").slice(0, 40),
      });
    }
  });

  return server;
}

export function startHttpServer(options = {}) {
  const host = options.host ?? process.env.WEJOB_MCP_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.WEJOB_MCP_PORT ?? 8787);
  const server = createHttpMcpServer(options);
  server.listen(port, host, () => {
    console.error(`${SERVER_NAME} listening on http://${host}:${port}/mcp`);
  });
  return server;
}

export function startStdioServer(options = {}) {
  const client = options.client ?? createWeJobClient(options);
  const logger = options.logger ?? createLogger(options);
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      void handleStdioLine(trimmed, client, logger);
    }
  });
}

async function handleStdioLine(line, client, logger) {
  const requestId = createRequestId();
  try {
    const message = JSON.parse(line);
    const response = await handleJsonRpc(message, client, {
      logger,
      requestId,
      transport: "stdio",
    });
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: safeErrorMessage(error, "Parse error."),
      },
    })}\n`);
    logMcpEvent(logger, "error", {
      request_id: requestId,
      transport: "stdio",
      event: "mcp_request",
      status: "error",
      error_code: -32700,
      error_message: safeErrorMessage(error, "Parse error."),
    });
  }
}

function toolJson(structuredContent) {
  return {
    structuredContent,
    content: [
      {
        type: "text",
        text: buildToolContentText(structuredContent),
      },
    ],
  };
}

function toSearchResult(type, item, webBaseUrl) {
  const id = normalizeId(item?.id ?? item?.public_id ?? item?.legacy_id);
  const title = buildTitle(type, item);
  const result = {
    id: `${type}:${id}`,
    title,
    url: buildPublicUrl(type, id, webBaseUrl),
    company: type === "job" || type === "formation"
      ? cleanText(item?.company?.name ?? item?.company_name ?? item?.organization_name)
      : "",
    logo: buildLogoUrl(type, item),
    // Lets assistants say where an offer is and the ChatGPT widget show it.
    location: type === "company"
      ? displayLocation(normalizeList(item?.locations ?? item?.location).join(", "))
      : displayLocation(item?.location),
  };

  if (type === "job") {
    return removeEmpty({
      ...result,
      published_at: formatDateOnly(item?.published_at ?? item?.created_at),
      created_at: formatDateOnly(item?.created_at),
      application_deadline: formatDateOnly(item?.application_deadline),
    });
  }

  if (type === "formation") {
    return removeEmpty({
      ...result,
      published_at: formatDateOnly(item?.published_at ?? item?.created_at),
      created_at: formatDateOnly(item?.created_at),
      application_deadline: formatDateOnly(item?.application_deadline),
      start_date: formatDateOnly(item?.start_date),
      end_date: formatDateOnly(item?.end_date),
    });
  }

  return removeEmpty({
    ...result,
    founded_at: formatDateOnly(item?.founded_at),
    company_size: item?.company_size ?? item?.size ?? item?.employee_count,
    employee_count: item?.employee_count ?? item?.total_employees,
    active_jobs: item?.active_jobs ?? item?.active_jobs_count ?? item?.jobs_count,
  });
}

function buildLogoUrl(type, item) {
  const candidates = type === "company"
    ? [item?.logo_url, item?.logo]
    : [item?.company?.logo_url, item?.company?.logo];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return "";
}

function toFetchResult(type, item, webBaseUrl) {
  const id = normalizeId(item?.id ?? item?.public_id ?? item?.legacy_id);
  const title = buildTitle(type, item);
  const details = buildDetails(type, item, webBaseUrl);
  const narrative = buildNarrativeFields(type, item);

  return removeEmpty({
    id: `${type}:${id}`,
    title,
    url: buildPublicUrl(type, id, webBaseUrl),
    company: details.company,
    logo: details.logo,
    location: details.location,
    description: narrative.description,
    responsibilities: narrative.responsibilities,
    profile: narrative.profile,
    prerequisites: narrative.prerequisites,
    program: narrative.program,
    learning_outcomes: narrative.learning_outcomes,
    mission: narrative.mission,
    culture: narrative.culture,
    website: details.website,
    founded_at: details.founded_at,
    contact: details.contact,
    contract_types: details.contract_types,
    activity_rate: details.activity_rate,
    work_mode: details.work_mode,
    salary: details.salary,
    required_hard_skills: details.required_hard_skills,
    required_soft_skills: details.required_soft_skills,
    nice_to_have_skills: details.nice_to_have_skills,
    languages: details.languages,
    benefits: details.benefits,
    experience_level: details.experience_level,
    business_sector: details.business_sector,
    expertise_domains: details.expertise_domains,
    application_deadline: details.application_deadline,
    formation_mode: details.formation_mode,
    certification_type: details.certification_type,
    price: details.price,
    duration: details.duration,
    categories: details.categories,
    start_date: details.start_date,
    end_date: details.end_date,
    industry: details.industry,
    company_size: details.company_size,
    locations: details.locations,
    tech_stack: details.tech_stack,
    values: details.values,
    jobs: details.jobs,
    formations: details.formations,
    active_jobs: details.active_jobs,
    active_formations: details.active_formations,
  });
}

function buildTitle(type, item) {
  return item?.title ?? item?.name ?? item?.company?.name ?? "Untitled";
}

function buildNarrativeFields(type, item) {
  if (type === "job") {
    return removeEmpty({
      description: cleanText(item?.description),
      responsibilities: narrativeList(item?.responsibilities),
      profile: narrativeList(item?.who_you_are ?? item?.requirements),
    });
  }

  if (type === "company") {
    return removeEmpty({
      description: cleanText(item?.description ?? item?.long_description ?? item?.short_description),
      mission: cleanText(item?.mission),
      culture: cleanText(item?.culture),
    });
  }

  return removeEmpty({
    description: cleanText(item?.description ?? item?.long_description),
    prerequisites: cleanText(item?.prerequisites),
    program: cleanText(item?.program),
    learning_outcomes: cleanText(item?.outcomes ?? item?.learning_outcomes),
  });
}

function buildDetails(type, item, webBaseUrl) {
  if (type === "job") {
    const employmentTypes = normalizeList(item?.employment_types);
    const categories = normalizeCategoryNames(item?.categories_details ?? item?.categories);
    const requiredSkills = splitRequiredSkills(item);

    return removeEmpty({
      company: item?.company?.name,
      logo: buildLogoUrl("job", item),
      location: displayLocation(item?.location),
      contract_types: normalizeList(item?.contract_type ?? inferContractTypes(employmentTypes)),
      activity_rate: item?.activity_rate ?? inferActivityRate(employmentTypes),
      work_mode: item?.work_mode,
      required_hard_skills: requiredSkills.hard,
      required_soft_skills: requiredSkills.soft,
      nice_to_have_skills: normalizeList(item?.nice_to_have_skills),
      benefits: normalizeList(item?.benefits),
      languages: normalizeLanguages(item),
      salary: formatSalary(item),
      experience_level: item?.experience_level,
      business_sector: item?.business_sector ?? item?.industry,
      expertise_domains: categories,
      application_deadline: formatDateOnly(item?.application_deadline),
    });
  }

  if (type === "formation") {
    const requiredSkills = splitRequiredSkills(item);

    return removeEmpty({
      company: item?.company?.name,
      logo: buildLogoUrl("formation", item),
      location: displayLocation(item?.location),
      formation_mode: item?.formation_mode,
      certification_type: item?.certification_type,
      price: formatPrice(item?.tarif),
      duration: formatDuration(item),
      required_hard_skills: requiredSkills.hard,
      required_soft_skills: requiredSkills.soft,
      languages: normalizeLanguages(item),
      experience_level: item?.experience_level,
      categories: normalizeList(item?.categories),
      application_deadline: formatDateOnly(item?.application_deadline),
      start_date: formatDateOnly(item?.start_date),
      end_date: formatDateOnly(item?.end_date),
    });
  }

  return removeEmpty({
    logo: buildLogoUrl("company", item),
    website: cleanText(item?.website),
    founded_at: formatDateOnly(item?.founded_at),
    contact: buildCompanyContact(item),
    industry: item?.industry ?? item?.business_sector,
    company_size: item?.company_size ?? item?.size ?? item?.employee_count,
    locations: normalizeList(item?.locations ?? item?.location),
    tech_stack: normalizeList(item?.tech_stack ?? item?.hard_skills),
    values: normalizeList(item?.values),
    benefits: normalizeList(item?.benefits),
    jobs: mapCompanyOpportunities("job", item?.jobs, webBaseUrl),
    formations: mapCompanyOpportunities("formation", item?.formations, webBaseUrl),
    // jobs/formations are a preview (12 max): expose the real totals so clients
    // can say so instead of presenting the preview as the full list.
    active_jobs: numericValue(item?.active_jobs ?? item?.active_jobs_count ?? item?.jobs_count),
    active_formations: numericValue(item?.active_formations ?? item?.active_formations_count),
  });
}

function buildPublicUrl(type, id, webBaseUrl) {
  const path = type === "job" ? "jobs" : type === "formation" ? "formations" : "companies";
  return `${webBaseUrl}/${path}/${encodeURIComponent(id)}`;
}

function extractItems(data, preferredKey) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[preferredKey])) return data[preferredKey];
  if (Array.isArray(data?.data)) return data.data;
  for (const value of Object.values(data ?? {})) {
    if (Array.isArray(value?.data)) return value.data;
    if (Array.isArray(value)) return value;
  }
  return [];
}

function extractSearchResults(payload) {
  return Array.isArray(payload) ? payload : extractItems(payload, "results");
}

function hasMoreSearchResults(payload) {
  return Boolean(payload && !Array.isArray(payload) && payload.pagination?.has_more);
}

function normalizeSearchPayload(payload, args = {}) {
  if (payload && !Array.isArray(payload) && Array.isArray(payload.results)) {
    return {
      results: payload.results,
      pagination: payload.pagination ?? {
        page: clampPage(args.page),
        limit: clampLimit(args.limit),
        has_more: false,
      },
    };
  }
  return {
    results: extractSearchResults(payload),
    pagination: {
      page: clampPage(args.page),
      limit: clampLimit(args.limit),
      has_more: false,
    },
  };
}

function paginationFromApiResponse(data, fallback) {
  // The public API nests its counters in "pagination" ({ total, per_page,
  // current_page, last_page }); Laravel paginators put them at the root or in "meta".
  const source = data?.pagination && typeof data.pagination === "object" ? data.pagination : data?.meta ?? data;
  const page = positiveInteger(source?.current_page ?? data?.current_page ?? data?.page, fallback.page);
  const limit = positiveInteger(source?.per_page ?? data?.per_page ?? data?.limit, fallback.limit);
  const total = optionalNonNegativeInteger(source?.total ?? data?.total);
  const lastPage = optionalPositiveInteger(source?.last_page ?? source?.total_pages ?? data?.last_page);
  const hasMore = data?.next_page_url !== undefined
    ? Boolean(data.next_page_url)
    : lastPage !== undefined
      ? page < lastPage
      : fallback.resultCount >= limit;
  return removeEmpty({ page, limit, has_more: hasMore, total });
}

function stripHtml(value) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function listSection(title, values) {
  const list = normalizeList(values);
  if (list.length === 0) {
    return "";
  }

  return `## ${title}\n${list.map((value) => `- ${value}`).join("\n")}`;
}

function joinSections(sections) {
  return sections.filter(Boolean).join("\n\n");
}

// The API joins city and canton ("Genève, Genève" when both are the same):
// keep each place once, in order.
function displayLocation(value) {
  if (typeof value !== "string") return value;
  const seen = new Set();
  const parts = value.split(",").map((part) => part.trim()).filter((part) => {
    const key = part.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return parts.join(", ") || undefined;
}

function cleanText(value) {
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return normalizeList(value).join(", ");
  }
  if (typeof value === "object") {
    return "";
  }
  const raw = String(value).trim();
  if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
    try {
      const decoded = JSON.parse(raw);
      if (Array.isArray(decoded)) {
        return normalizeList(decoded).join(", ");
      }
    } catch {
      // Keep non-JSON legacy strings readable.
    }
  }
  return stripHtml(raw);
}

function normalizeList(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .flatMap((item) => normalizeListItem(item))
      .map((item) => cleanText(item))
      .filter(Boolean);
  }

  if (typeof value === "object") {
    return normalizeListItem(value).map((item) => cleanText(item)).filter(Boolean);
  }

  const raw = String(value).trim();
  if (!raw) {
    return [];
  }

  if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
    try {
      return normalizeList(JSON.parse(raw));
    } catch {
      // Keep the original value when legacy JSON-like strings are malformed.
    }
  }

  return raw.split(",").map((item) => cleanText(item)).filter(Boolean);
}

// Narrative fields (responsibilities, profile) are free text written one item per
// line, per <li> or per paragraph. Their sentences contain commas, so they are never
// split on "," (WJ-04). Every block boundary splits, so text outside a list (intro,
// trailing paragraph) and lists with omitted </li> keep all their content. JSON
// arrays and non-string values keep the normalizeList behaviour.
const NARRATIVE_BLOCK_BOUNDARY = /<\/?(?:li|ul|ol|p|div|h[1-6]|tr|td|blockquote)\b[^>]*>|<br\s*\/?>|\r?\n/i;
const NARRATIVE_BULLET_MARKER = /^(?:[-*•·]|\d{1,2}[.)])\s+/;

function narrativeList(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  if (typeof value !== "string") {
    return normalizeList(value);
  }
  const raw = value.trim();
  if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
    return normalizeList(raw);
  }
  return raw
    .split(NARRATIVE_BLOCK_BOUNDARY)
    .map((item) => stripHtml(item).replace(NARRATIVE_BULLET_MARKER, "").trim())
    .filter(Boolean);
}

function normalizeListItem(item) {
  if (item === undefined || item === null || item === "") {
    return [];
  }
  if (Array.isArray(item)) {
    return normalizeList(item);
  }
  if (typeof item === "object") {
    const label = item.name ?? item.label ?? item.title ?? item.value ?? item.skill_name ?? item.language;
    return label ? [label] : [];
  }
  return [item];
}

function normalizeLanguages(item) {
  const detailed = Array.isArray(item?.languages_data)
    ? item.languages_data
        .map((language) => {
          const name = cleanText(language?.name);
          if (!name) return "";
          const level = cleanText(language?.level_label ?? language?.level_value);
          return level ? `${name} (${level})` : name;
        })
        .filter(Boolean)
    : [];
  const detailedNames = new Set(detailed.map((language) => normalizeLanguageKey(language)));
  const explicit = normalizeList(item?.languages_required)
    .filter((language) => !detailedNames.has(normalizeLanguageKey(language)));

  return uniqueStrings([...detailed, ...explicit]);
}

function normalizeLanguageKey(value) {
  return cleanText(value)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hasTypedSkillEntries(item) {
  return normalizeSkillEntries(item?.required_skill_entries).length > 0;
}

function splitRequiredSkills(item) {
  const entries = normalizeSkillEntries(item?.required_skill_entries);
  if (entries.length > 0) {
    return {
      hard: uniqueStrings(entries.filter((entry) => entry.skill_type !== "soft").map((entry) => entry.name)),
      soft: uniqueStrings(entries.filter((entry) => entry.skill_type === "soft").map((entry) => entry.name)),
    };
  }

  return {
    hard: uniqueStrings(normalizeList(item?.required_skills)),
    soft: [],
  };
}

function normalizeSkillEntries(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  let entries = value;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) {
      return [];
    }
    try {
      entries = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map((entry) => {
      if (typeof entry === "string") {
        return { name: cleanText(entry), skill_type: "hard" };
      }

      if (!entry || typeof entry !== "object") {
        return null;
      }

      const name = cleanText(entry.name ?? entry.label ?? entry.title ?? entry.value ?? entry.skill_name);
      if (!name) {
        return null;
      }

      const rawType = cleanText(entry.skill_type ?? entry.type ?? entry.kind).toLowerCase();
      const skillType = rawType === "soft" ? "soft" : "hard";

      return { name, skill_type: skillType };
    })
    .filter(Boolean);
}

function normalizeCategoryNames(categories) {
  if (!Array.isArray(categories)) {
    return normalizeList(categories);
  }

  const names = [];
  for (const category of categories) {
    const parentName = category?.parent?.name;
    const name = category?.name ?? category?.slug ?? category;
    if (parentName) {
      names.push(parentName);
    }
    if (name) {
      names.push(name);
    }
  }

  return uniqueStrings(names.map((value) => cleanText(value)).filter(Boolean));
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = String(value).trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(String(value).trim());
  }
  return result;
}

function inferContractTypes(employmentTypes) {
  const contractKeywords = new Set([
    "cdi",
    "cdd",
    "contract",
    "internship",
    "stage",
    "freelance",
    "temporary",
    "permanent",
  ]);
  return employmentTypes.filter((type) => contractKeywords.has(type.toLowerCase()));
}

function inferActivityRate(employmentTypes) {
  const normalized = employmentTypes.map((type) => type.toLowerCase());
  if (normalized.includes("full_time") || normalized.includes("full-time")) {
    return "full_time";
  }
  if (normalized.includes("part_time") || normalized.includes("part-time")) {
    return "part_time";
  }
  return "";
}

function formatSalary(item) {
  if (item?.show_salary === false) {
    return undefined;
  }

  const minValue = numericValue(item?.salary_min);
  const maxValue = numericValue(item?.salary_max);
  const hasAmount = minValue !== undefined || maxValue !== undefined;

  return removeEmpty({
    min: minValue,
    max: maxValue,
    // The API exposes the currency but no period: only the currency is added.
    currency: hasAmount ? cleanText(item?.salary_currency).toUpperCase() || undefined : undefined,
  });
}

function numericValue(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function formatPrice(value, currency = "CHF") {
  const amount = numericValue(value);
  if (amount === undefined) {
    return undefined;
  }

  return { amount, currency };
}

function buildCompanyContact(item) {
  return removeEmpty({
    email: cleanText(item?.email ?? item?.contact_email ?? item?.public_email),
    phone: cleanText(item?.phone ?? item?.contact_phone),
    social_links: normalizeSocialLinks(item?.social_links ?? item?.social_media),
  });
}

function normalizeSocialLinks(value) {
  if (value === undefined || value === null || value === "") {
    return {};
  }

  if (Array.isArray(value)) {
    return removeEmpty(Object.fromEntries(value.flatMap((entry) => {
      if (typeof entry === "string") {
        return [];
      }
      const platform = cleanText(entry?.platform ?? entry?.type ?? entry?.name ?? entry?.key);
      const url = cleanText(entry?.url ?? entry?.link ?? entry?.value);
      return platform && url ? [[platform, url]] : [];
    })));
  }

  if (typeof value === "object") {
    return removeEmpty(Object.fromEntries(Object.entries(value).flatMap(([platform, link]) => {
      const url = typeof link === "object"
        ? cleanText(link?.url ?? link?.link ?? link?.value)
        : cleanText(link);
      return url ? [[platform, url]] : [];
    })));
  }

  return {};
}

function mapCompanyOpportunities(type, items, webBaseUrl) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((item) => {
    const rawId = item?.id ?? item?.public_id ?? item?.legacy_id;
    if (rawId === undefined || rawId === null || rawId === "") {
      return [];
    }

    const id = normalizeId(rawId);
    const requiredSkills = splitRequiredSkills(item);
    const employmentTypes = normalizeList(item?.employment_types);
    const categories = normalizeCategoryNames(item?.categories_details ?? item?.categories);

    const common = {
      id: `${type}:${id}`,
      title: buildTitle(type, item),
      url: buildPublicUrl(type, id, webBaseUrl),
      location: displayLocation(item?.location),
      application_deadline: formatDateOnly(item?.application_deadline),
      description: cleanText(item?.description),
      experience_level: item?.experience_level,
      // The company API embeds offers with one untyped skill list (hard and soft mixed):
      // label it neutrally instead of calling every entry a technical skill.
      ...(hasTypedSkillEntries(item)
        ? { required_hard_skills: requiredSkills.hard, required_soft_skills: requiredSkills.soft }
        : { required_skills: requiredSkills.hard }),
    };

    if (type === "job") {
      return [removeEmpty({
        ...common,
        contract_types: normalizeList(item?.contract_type ?? inferContractTypes(employmentTypes)),
        activity_rate: item?.activity_rate ?? inferActivityRate(employmentTypes),
        work_mode: item?.work_mode,
        industry: item?.industry ?? item?.business_sector,
        expertise_domains: categories,
      })];
    }

    return [removeEmpty({
      ...common,
      formation_mode: item?.formation_mode,
      certification_type: item?.certification_type,
      categories,
    })];
  });
}

function formatDuration(item) {
  const days = Number(item?.duration_days);
  const weeks = Number(item?.duration_weeks);
  if (Number.isFinite(days) && days > 0) {
    return `${days} jour${days > 1 ? "s" : ""}`;
  }
  if (Number.isFinite(weeks) && weeks > 0) {
    return `${weeks} semaine${weeks > 1 ? "s" : ""}`;
  }
  return "";
}

function formatDateOnly(value, timeZone = "Europe/Zurich") {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  const normalized = raw.replace(/\.(\d{3})\d+(Z|[+-]\d{2}:?\d{2})$/, ".$1$2");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return cleanText(value);
  }

  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function buildToolContentText(structuredContent) {
  const sections = joinSections([
    structuredContent?.description ? `## Description\n${structuredContent.description}` : "",
    structuredContent?.mission ? `## Mission\n${structuredContent.mission}` : "",
    structuredContent?.culture ? `## Culture\n${structuredContent.culture}` : "",
    listSection("Responsabilites", structuredContent?.responsibilities),
    listSection("Profil recherche", structuredContent?.profile),
    structuredContent?.prerequisites ? `## Prerequis\n${structuredContent.prerequisites}` : "",
    structuredContent?.program ? `## Programme\n${structuredContent.program}` : "",
    structuredContent?.learning_outcomes ? `## Acquis vises\n${structuredContent.learning_outcomes}` : "",
  ]);
  if (sections !== "") {
    return sections;
  }

  if (Array.isArray(structuredContent?.results)) {
    return structuredContent.results
      .map((result) => `${result.id} - ${result.title} - ${result.url}`)
      .join("\n");
  }

  return JSON.stringify(structuredContent);
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function normalizeId(value) {
  const id = String(value ?? "").trim();
  if (!id) {
    throw new Error("WeJob API item is missing a public id.");
  }
  return id;
}

// Same orders as the website catalogs (wejob-frontend Jobs.js, Formations.js,
// Companies.js), so one search gives the same results on the site and through the MCP.
function searchSortParams(type, sort) {
  const value = String(sort ?? "").trim();
  if (!value) {
    // The site sorts formations and companies by "newest" by default. For jobs the API
    // default is already the site's order.
    if (type === "formation") return { sort_by: "created_at", sort_direction: "desc" };
    if (type === "company") return { sort: "newest" };
    return {};
  }

  if (type === "job" || type === "formation") {
    if (value === "oldest") return { sort_by: "created_at", sort_direction: "asc" };
    if (value === "deadline_soon") return { sort_by: "application_deadline", sort_direction: "asc" };
    if (value === "deadline_later") return { sort_by: "application_deadline", sort_direction: "desc" };
    if (type === "job" && value === "level_asc") return { sort_by: "experience_level", sort_direction: "asc" };
    if (type === "formation" && value === "price_asc") return { sort_by: "tarif", sort_direction: "asc" };
    if (type === "formation" && value === "price_desc") return { sort_by: "tarif", sort_direction: "desc" };
    if (type === "formation" && value === "duration_asc") return { sort_by: "duration_days", sort_direction: "asc" };
    return { sort_by: "created_at", sort_direction: "desc" };
  }

  if (type === "company") {
    if ([
      "smallest",
      "largest",
      "founded_newest",
      "founded_oldest",
      "most_jobs",
      "newest",
      "oldest",
    ].includes(value)) {
      return { sort: value };
    }
  }

  return {};
}

function clampLimit(value) {
  const parsed = Number.parseInt(value ?? String(DEFAULT_SEARCH_LIMIT), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.min(MAX_SEARCH_LIMIT, parsed));
}

function clampPage(value) {
  return positiveInteger(value, 1);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

// 0 is a valid total ("no result"), unlike a page number.
function optionalNonNegativeInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalPositiveInteger(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw jsonRpcError(-32602, `Missing required string field: ${field}`);
  }
  return value.trim();
}

// get_* tools take a public id, but the model naturally reuses the composite id
// ("job:<id>") returned by search/fetch: accept both forms (WJ-12).
function publicIdArg(value, type) {
  const id = requireString(value, "id");
  const prefix = `${type}:`;
  // A bare prefix ("job:") must not become GET /jobs/ (the list endpoint).
  return id.toLowerCase().startsWith(prefix) ? requireString(id.slice(prefix.length), "id") : id;
}

function removeEmpty(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value) && value.length === 0) return false;
      if (
        typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).length === 0
      ) return false;
      return true;
    })
  );
}

function jsonRpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonNegativeNumberArg(value, field) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || number < 0) {
    throw jsonRpcError(-32602, `${field} must be a non-negative number.`);
  }
  return number;
}

// Distinguish a missing item, an invalid input and an unavailable API instead of
// reporting every upstream failure as an internal error (WJ-13). Errors stay in the
// JSON-RPC `error` envelope that the Discord and Alexa clients already read.
function apiError(status, message) {
  if (status === 404) {
    const error = jsonRpcError(-32002, message);
    error.data = { type: "not_found", http_status: status };
    return error;
  }
  if (status === 400 || status === 422) {
    const error = jsonRpcError(-32602, message);
    error.data = { type: "invalid_input", http_status: status };
    return error;
  }
  const error = jsonRpcError(-32603, message);
  error.data = { type: "unavailable", http_status: status };
  return error;
}

function createRequestId() {
  return randomUUID();
}

// Argument names as sent by the client, kept only when they look like schema keys
// so that a client cannot smuggle free text into the logs through key names.
function argumentKeys(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  return Object.keys(args).filter((key) => /^[a-z][a-z0-9_]{0,39}$/.test(key)).sort();
}

// Best-effort name of the platform behind a request, from its User-Agent or its
// MCP clientInfo name. Our own clients identify themselves explicitly; the
// assistant patterns are a starting point to refine with real production logs
// (the raw user_agent is always logged next to it).
const CALLER_PATTERNS = [
  ["chatgpt-app", /wejob-apps-sdk/i],
  ["discord", /wejob-discord-bot/i],
  ["alexa", /wejob-alexa-skill/i],
  ["chatgpt", /openai|chatgpt/i],
  ["claude", /claude|anthropic/i],
  ["codex", /codex/i],
  ["mistral", /mistral|le[-_ ]?chat/i],
  ["copilot", /copilot|vscode|visual studio code/i],
  ["cursor", /cursor/i],
  ["gemini", /gemini/i],
  ["grok", /grok|xai/i],
  ["perplexity", /perplexity/i],
  ["uptime-monitor", /uptimerobot|uptime-kuma|pingdom|statuscake|betteruptime/i],
];

export function detectCaller(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return undefined;
  }
  const match = CALLER_PATTERNS.find(([, pattern]) => pattern.test(text));
  return match ? match[0] : "unknown";
}

// Short identifier-like strings only (client names, versions): never free text.
function plainToken(value, maxLength) {
  const text = String(value ?? "").trim();
  return /^[A-Za-z0-9 ._:/@()+-]+$/.test(text) ? text.slice(0, maxLength) : "";
}

// A client-supplied request id is logged and forwarded to the API as a header:
// keep it only when it is a plain token, so it can neither break the upstream
// call nor carry free text into the logs.
export function sanitizeRequestId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : "";
}

function resultSummary(result) {
  const content = result?.structuredContent;
  if (!content || !Array.isArray(content.results)) {
    return {};
  }
  return { result_count: content.results.length, has_more: content.pagination?.has_more };
}

function networkCauseCode(cause) {
  const code = cause?.cause?.code ?? cause?.code ?? cause?.name;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : undefined;
}

function logMcpEvent(logger, level, event) {
  if (!logger || typeof logger[level] !== "function") {
    return;
  }

  logger[level](event);
}

function safeErrorMessage(error, fallback) {
  const message = cleanText(error?.message ?? fallback);
  if (!message) {
    return fallback;
  }

  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/token[=:]\s*[A-Za-z0-9._~+/=-]+/gi, "token=[redacted]")
    .replace(/api[_-]?key[=:]\s*[A-Za-z0-9._~+/=-]+/gi, "api_key=[redacted]");
}

function sendJson(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  response.end(String(text));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_HTTP_BODY_BYTES) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv.includes("--http") ? "http" : "stdio";
  if (mode === "http") {
    startHttpServer();
  } else {
    startStdioServer();
  }
}
