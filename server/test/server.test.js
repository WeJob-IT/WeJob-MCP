import test from "node:test";
import assert from "node:assert/strict";
import {
  callTool,
  createHttpMcpServer,
  createLogger,
  createWeJobClient,
  detectCaller,
  handleJsonRpc,
  normalizeFilterValues,
  sanitizeRequestId,
  tools,
} from "../src/server.js";

test("tools list contains read-only generic and WeJob tools", () => {
  const names = tools.map((tool) => tool.name);

  assert.deepEqual(names, [
    "search",
    "fetch",
    "wejob_search_jobs",
    "wejob_get_job",
    "wejob_search_formations",
    "wejob_get_formation",
    "wejob_search_companies",
    "wejob_get_company",
  ]);

  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
  }

  const jobSearch = tools.find((tool) => tool.name === "wejob_search_jobs");
  assert.equal(jobSearch.inputSchema.properties.languages.type, "string");
});

test("job search maps WeJob API data to MCP structured content", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/api/jobs");
      assert.equal(url.searchParams.get("search"), "php");
      assert.equal(url.searchParams.get("near_fallback"), null);
      return jsonResponse({
        data: [
          {
            id: "job_public_1",
            title: "Developpeur PHP",
            location: "Lausanne",
            company: { name: "WeJob" },
            required_skills: ["PHP", "Laravel"],
            description: "<p>Build APIs.</p>",
          },
        ],
      });
    },
  });

  const result = await callTool("wejob_search_jobs", { query: "php", limit: 5 }, client);

  assert.equal(result.structuredContent.results[0].id, "job:job_public_1");
  assert.equal(result.structuredContent.results[0].title, "Developpeur PHP");
  assert.equal(result.structuredContent.results[0].url, "https://wejob.example.test/jobs/job_public_1");
  assert.equal(result.structuredContent.results[0].company, "WeJob");
  assert.equal(Object.hasOwn(result.structuredContent.results[0], "metadata"), false);
  assert.match(result.content[0].text, /Developpeur PHP/);
});

test("job and formation search sort options are forwarded to public APIs", async () => {
  const requested = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      requested.push({
        path: url.pathname,
        sortBy: url.searchParams.get("sort_by"),
        sortDirection: url.searchParams.get("sort_direction"),
      });
      return jsonResponse({ data: [] });
    },
  });

  await callTool("wejob_search_jobs", { sort: "deadline_soon", limit: 5 }, client);
  await callTool("wejob_search_formations", { sort: "oldest", limit: 5 }, client);
  await callTool("wejob_search_formations", { sort: "price_asc", limit: 5 }, client);
  await callTool("wejob_search_formations", { sort: "price_desc", limit: 5 }, client);

  assert.deepEqual(requested, [
    { path: "/api/jobs", sortBy: "application_deadline", sortDirection: "asc" },
    { path: "/api/formations", sortBy: "created_at", sortDirection: "asc" },
    { path: "/api/formations", sortBy: "tarif", sortDirection: "asc" },
    { path: "/api/formations", sortBy: "tarif", sortDirection: "desc" },
  ]);
});

test("formation search maps publishing company to MCP structured content", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/api/formations");
      return jsonResponse({
        data: [
          {
            id: "formation_public_1",
            title: "React avance",
            company: { name: "WeJob Academy" },
          },
        ],
      });
    },
  });

  const result = await callTool("wejob_search_formations", { query: "react", limit: 5 }, client);

  assert.deepEqual(result.structuredContent.results[0], {
    id: "formation:formation_public_1",
    title: "React avance",
    url: "https://wejob.example.test/formations/formation_public_1",
    company: "WeJob Academy",
  });
});

test("catalog search forwards page to the API and returns pagination metadata", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/api/jobs");
      assert.equal(url.searchParams.get("per_page"), "2");
      assert.equal(url.searchParams.get("page"), "3");
      return jsonResponse({
        data: [
          { id: "job_public_5", title: "Five" },
          { id: "job_public_6", title: "Six" },
        ],
        current_page: 3,
        per_page: 2,
        total: 7,
        last_page: 4,
        next_page_url: "https://api.example.test/api/jobs?page=4",
      });
    },
  });

  const result = await callTool("wejob_search_jobs", { query: "dev", limit: 2, page: 3 }, client);

  assert.deepEqual(result.structuredContent.pagination, {
    page: 3,
    limit: 2,
    has_more: true,
    total: 7,
  });
  assert.deepEqual(
    result.structuredContent.results.map((item) => item.id),
    ["job:job_public_5", "job:job_public_6"],
  );
});

test("company search caps results at the requested limit when the API over-delivers", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/api/companies");
      assert.equal(url.searchParams.get("per_page"), "2");
      return jsonResponse({
        data: [
          { id: "company_public_1", name: "Alpha SA" },
          { id: "company_public_2", name: "Beta SA" },
          { id: "company_public_3", name: "Gamma SA" },
        ],
      });
    },
  });

  const result = await callTool("wejob_search_companies", { limit: 2 }, client);

  assert.equal(result.structuredContent.results.length, 2);
  assert.equal(result.structuredContent.results[0].id, "company:company_public_1");
  assert.equal(result.structuredContent.results[1].id, "company:company_public_2");
});

test("company search forwards company-specific sort options", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/api/companies");
      assert.equal(url.searchParams.get("sort"), "founded_oldest");
      return jsonResponse({
        data: [
          {
            id: "company_public_1",
            name: "Alpha SA",
            founded_at: "1994-01-01",
            employee_count: 42,
            active_jobs: 3,
          },
        ],
      });
    },
  });

  const result = await callTool("wejob_search_companies", { sort: "founded_oldest", limit: 5 }, client);

  assert.equal(result.structuredContent.results[0].founded_at, "1994-01-01");
  assert.equal(result.structuredContent.results[0].employee_count, 42);
  assert.equal(result.structuredContent.results[0].active_jobs, 3);
});

test("job and formation searches also cap an over-delivering API at the requested limit", async () => {
  for (const [tool, path, prefix] of [
    ["wejob_search_jobs", "/api/jobs", "job"],
    ["wejob_search_formations", "/api/formations", "formation"],
  ]) {
    const client = createWeJobClient({
      apiBaseUrl: "https://api.example.test/api",
      webBaseUrl: "https://wejob.example.test",
      fetchImpl: async (url) => {
        assert.equal(url.pathname, path);
        assert.equal(url.searchParams.get("per_page"), "1");
        return jsonResponse({
          data: [
            { id: "public_1", title: "One" },
            { id: "public_2", title: "Two" },
            { id: "public_3", title: "Three" },
          ],
        });
      },
    });

    const result = await callTool(tool, { limit: 1 }, client);

    assert.equal(result.structuredContent.results.length, 1);
    assert.equal(result.structuredContent.results[0].id, `${prefix}:public_1`);
  }
});

test("generic search tool exposes limit and forwards it to every entity", async () => {
  const search = tools.find((tool) => tool.name === "search");
  assert.equal(search.inputSchema.properties.limit.maximum, 50);

  const perPageByPath = {};
  const pageByPath = {};
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      perPageByPath[url.pathname] = url.searchParams.get("per_page");
      pageByPath[url.pathname] = url.searchParams.get("page");
      return jsonResponse({ data: [] });
    },
  });

  const result = await callTool("search", { query: "data", limit: 3, page: 2 }, client);

  assert.equal(perPageByPath["/api/jobs"], "3");
  assert.equal(perPageByPath["/api/formations"], "3");
  assert.equal(perPageByPath["/api/companies"], "3");
  assert.equal(pageByPath["/api/jobs"], "2");
  assert.equal(pageByPath["/api/formations"], "2");
  assert.equal(pageByPath["/api/companies"], "2");
  assert.deepEqual(result.structuredContent.pagination, { page: 2, limit: 3, has_more: false });
});

test("location searches keep strict geographic results", async () => {
  const requestedUrls = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return jsonResponse({ data: [] });
    },
  });

  await callTool("wejob_search_jobs", { location: "Vaud", limit: 10 }, client);
  await callTool("wejob_search_formations", { location: "Vaud", limit: 10 }, client);

  assert.equal(requestedUrls[0].pathname, "/api/jobs");
  // A canton is sent like the site does: its code and its label.
  assert.deepEqual(requestedUrls[0].searchParams.getAll("location[]"), ["VD", "Vaud"]);
  assert.equal(requestedUrls[0].searchParams.get("near_fallback"), null);
  assert.equal(requestedUrls[1].pathname, "/api/formations");
  assert.deepEqual(requestedUrls[1].searchParams.getAll("location[]"), ["VD", "Vaud"]);
  assert.equal(requestedUrls[1].searchParams.get("near_fallback"), null);
});

test("job search sends explicit language filters to the WeJob API", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/api/jobs");
      assert.equal(url.searchParams.get("languages"), "English");
      return jsonResponse({ data: [] });
    },
  });

  await callTool("wejob_search_jobs", { languages: "English", limit: 5 }, client);
});

test("search limit is aligned with the public jobs API maximum", async () => {
  const jobSearch = tools.find((tool) => tool.name === "wejob_search_jobs");
  assert.equal(jobSearch.inputSchema.properties.limit.maximum, 50);

  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/api/jobs");
      assert.equal(url.searchParams.get("per_page"), "50");
      return jsonResponse({ data: [] });
    },
  });

  await callTool("wejob_search_jobs", { query: "dev", limit: 80 }, client);
});

test("job detail exposes flattened structured fields", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/api/jobs/job_public_1");
      return jsonResponse({
        job: {
          id: "job_public_1",
          title: "Data Scientist",
          description: "<p>Construire des modeles predictifs.</p>",
          responsibilities: JSON.stringify([
            "Industrialiser les pipelines data.",
            "Creer des dashboards.",
          ]),
          who_you_are: JSON.stringify([
            "Profil analytique avec experience Spark.",
            "Aisance avec les metiers.",
          ]),
          location: "Lausanne, Suisse",
          company: { name: "IBM Suisse" },
          employment_types: ["CDI", "full_time"],
          required_skill_entries: [
            { name: "SQL", skill_type: "hard" },
            { name: "Spark", skill_type: "hard" },
            { name: "Communication", skill_type: "soft" },
            { name: "Autonomie", skill_type: "soft" },
          ],
          required_skills: ["legacy should be ignored"],
          nice_to_have_skills: ["Python"],
          benefits: ["Teletravail", "Formation continue"],
          languages_required: ["Francais", "Anglais"],
          languages_data: [
            { name: "Francais", level_label: "B2" },
            { name: "Espanol", level_label: "Langue maternelle" },
          ],
          salary_min: 110000,
          salary_max: 130000,
          show_salary: true,
          experience_level: "senior",
          business_sector: "technology",
          categories_details: [
            { name: "Data Science", parent: { name: "IT" } },
          ],
          application_deadline: "2026-08-08T06:32:24.000000Z",
        },
      });
    },
  });

  const result = await callTool("wejob_get_job", { id: "job_public_1" }, client);
  const detail = result.structuredContent;

  assert.deepEqual(Object.keys(detail), [
    "id",
    "title",
    "url",
    "company",
    "location",
    "description",
    "responsibilities",
    "profile",
    "contract_types",
    "activity_rate",
    "salary",
    "required_hard_skills",
    "required_soft_skills",
    "nice_to_have_skills",
    "languages",
    "benefits",
    "experience_level",
    "business_sector",
    "expertise_domains",
    "application_deadline",
  ]);
  assert.equal(detail.title, "Data Scientist");
  assert.equal(detail.company, "IBM Suisse");
  assert.deepEqual(detail.contract_types, ["CDI"]);
  assert.equal(detail.activity_rate, "full_time");
  assert.deepEqual(detail.required_hard_skills, ["SQL", "Spark"]);
  assert.deepEqual(detail.required_soft_skills, ["Communication", "Autonomie"]);
  assert.deepEqual(detail.languages, [
    "Francais (B2)",
    "Espanol (Langue maternelle)",
    "Anglais",
  ]);
  assert.deepEqual(detail.expertise_domains, ["IT", "Data Science"]);
  assert.deepEqual(detail.salary, {
    min: 110000,
    max: 130000,
  });
  assert.equal(detail.application_deadline, "2026-08-08");
  assert.equal(detail.description, "Construire des modeles predictifs.");
  assert.deepEqual(detail.responsibilities, [
    "Industrialiser les pipelines data.",
    "Creer des dashboards.",
  ]);
  assert.deepEqual(detail.profile, [
    "Profil analytique avec experience Spark.",
    "Aisance avec les metiers.",
  ]);
  assert.equal(Object.hasOwn(detail, "text"), false);
  assert.equal(Object.hasOwn(detail, "metadata"), false);
  assert.equal(Object.hasOwn(detail, "details"), false);
  assert.equal(Object.hasOwn(detail, "employment_types"), false);
  assert.equal(Object.hasOwn(detail, "required_skills"), false);
  assert.equal(Object.hasOwn(detail, "positions_available"), false);
  assert.equal(Object.hasOwn(detail, "applications_count"), false);
  assert.equal(Object.hasOwn(detail, "salary_min"), false);
  assert.equal(Object.hasOwn(detail, "salary_max"), false);
  assert.equal(Object.hasOwn(detail, "show_salary"), false);
  assert.equal(Object.hasOwn(detail, "business_sector_id"), false);
  assert.equal(Object.hasOwn(detail, "sector_id"), false);
  assert.match(result.content[0].text, /## Description/);
  assert.match(result.content[0].text, /## Responsabilites/);
  assert.match(result.content[0].text, /## Profil recherche/);
  assert.doesNotMatch(result.content[0].text, /\["Industrialiser/);
  assert.doesNotMatch(detail.title, /IBM Suisse/);
});

test("job detail salary supports partial or absent ranges", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("/min-only")) {
        return jsonResponse({
          job: {
            id: "min-only",
            title: "Backend Engineer",
            salary_min: 90000,
            salary_max: null,
            show_salary: true,
          },
        });
      }

      return jsonResponse({
        job: {
          id: "no-salary",
          title: "Frontend Engineer",
          salary_min: null,
          salary_max: null,
          show_salary: true,
        },
      });
    },
  });

  const minOnly = await callTool("wejob_get_job", { id: "min-only" }, client);
  assert.deepEqual(minOnly.structuredContent.salary, { min: 90000 });

  const noSalary = await callTool("wejob_get_job", { id: "no-salary" }, client);
  assert.equal(Object.hasOwn(noSalary.structuredContent, "salary"), false);
});

test("job detail exposes application deadline as a local calendar date", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async () => jsonResponse({
      job: {
        id: "job-date",
        title: "Backend Engineer",
        application_deadline: "2026-07-10T22:00:00.000000Z",
      },
    }),
  });

  const result = await callTool("wejob_get_job", { id: "job-date" }, client);

  assert.equal(result.structuredContent.application_deadline, "2026-07-11");
});

test("job detail strips html from narrative list fields", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async () => jsonResponse({
      job: {
        id: "html-narrative",
        title: "Office Manager",
        responsibilities: "<p>fdaflaf</p>",
        who_you_are: "<p>fdskead</p>",
      },
    }),
  });

  const result = await callTool("wejob_get_job", { id: "html-narrative" }, client);

  assert.deepEqual(result.structuredContent.responsibilities, ["fdaflaf"]);
  assert.deepEqual(result.structuredContent.profile, ["fdskead"]);
  assert.doesNotMatch(result.content[0].text, /<p>/);
});

test("formation detail exposes narrative fields and local calendar dates", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/api/formations/formation_public_1");
      return jsonResponse({
        formation: {
          id: "formation_public_1",
          title: "React avance",
          description: "<p>Approfondir React.</p>",
          prerequisites: "<p>Bases JavaScript.</p>",
          program: "<p>Hooks avances</p><p>Performance</p>",
          outcomes: "<p>Construire une application React maintenable.</p>",
          company: { name: "WeJob Academy" },
          location: "Geneve",
          formation_mode: "online",
          certification_type: "certificate",
          tarif: 1200,
          duration_days: 5,
          application_deadline: "2026-07-10T22:00:00.000000Z",
          start_date: "2026-09-01T22:00:00.000000Z",
          end_date: "2026-09-04T22:00:00.000000Z",
        },
      });
    },
  });

  const result = await callTool("wejob_get_formation", { id: "formation_public_1" }, client);
  const detail = result.structuredContent;

  assert.equal(detail.description, "Approfondir React.");
  assert.equal(detail.prerequisites, "Bases JavaScript.");
  assert.equal(detail.program, "Hooks avances Performance");
  assert.equal(detail.learning_outcomes, "Construire une application React maintenable.");
  assert.deepEqual(detail.price, {
    amount: 1200,
    currency: "CHF",
  });
  assert.equal(detail.application_deadline, "2026-07-11");
  assert.equal(detail.start_date, "2026-09-02");
  assert.equal(detail.end_date, "2026-09-05");
  assert.match(result.content[0].text, /## Prerequis/);
  assert.match(result.content[0].text, /## Programme/);
  assert.match(result.content[0].text, /## Acquis vises/);
});

test("company detail exposes profile, contact, and compact opportunities", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, "/api/companies/company_public_1");
      return jsonResponse({
        id: "company_public_1",
        name: "Infomaniak SA",
        description: "<p>Cloud responsable suisse.</p>",
        mission: "<p>Construire un cloud souverain et durable.</p>",
        culture: "<p>Transparence, autonomie et excellence technique.</p>",
        website: "https://www.infomaniak.com",
        founded_at: "1994-01-01T00:00:00.000000Z",
        industry: "Technologie",
        business_sector: "technology",
        company_size: "200-500",
        locations: ["Rue Eugene-Marziano 25, Geneve"],
        benefits: ["Horaires flexibles"],
        values: ["Ecologie", "Innovation"],
        social_links: {
          linkedin: "https://www.linkedin.com/company/infomaniak",
          twitter: "",
        },
        jobs: [
          {
            id: "job_public_1",
            title: "DevOps Engineer",
            description: "<p>Automatiser l'infrastructure cloud.</p>",
            location: "Geneve",
            // Forme d'API actuelle : le mode de travail est un champ dédié (work_mode),
            // plus une valeur d'employment_types.
            employment_types: ["CDI", "full_time"],
            work_mode: "hybrid",
            experience_level: "senior",
            categories: ["Cloud", "Infrastructure"],
            required_skill_entries: [
              { name: "Docker", skill_type: "hard" },
              { name: "Kubernetes", skill_type: "hard" },
              { name: "Communication", skill_type: "soft" },
            ],
            application_deadline: "2026-07-10T22:00:00.000000Z",
          },
        ],
        formations: [
          {
            id: "formation_public_1",
            title: "Cloud responsable",
            description: "<p>Construire des services cloud responsables.</p>",
            location: "Remote",
            formation_mode: "presentiel",
            certification_type: "certificat",
            experience_level: "senior",
            categories: ["Cloud", "Durabilite"],
            required_skills: ["Python", "React", "PHP"],
            application_deadline: "2026-08-01",
          },
        ],
      });
    },
  });

  const result = await callTool("wejob_get_company", { id: "company_public_1" }, client);
  const detail = result.structuredContent;

  assert.equal(detail.title, "Infomaniak SA");
  assert.equal(Object.hasOwn(detail, "company"), false);
  assert.equal(Object.hasOwn(detail, "business_sector"), false);
  assert.equal(detail.industry, "Technologie");
  assert.equal(detail.description, "Cloud responsable suisse.");
  assert.equal(detail.mission, "Construire un cloud souverain et durable.");
  assert.equal(detail.culture, "Transparence, autonomie et excellence technique.");
  assert.equal(detail.website, "https://www.infomaniak.com");
  assert.equal(detail.founded_at, "1994-01-01");
  assert.deepEqual(detail.contact, {
    social_links: {
      linkedin: "https://www.linkedin.com/company/infomaniak",
    },
  });
  assert.deepEqual(detail.jobs, [
    {
      id: "job:job_public_1",
      title: "DevOps Engineer",
      url: "https://wejob.example.test/jobs/job_public_1",
      location: "Geneve",
      application_deadline: "2026-07-11",
      description: "Automatiser l'infrastructure cloud.",
      experience_level: "senior",
      required_hard_skills: ["Docker", "Kubernetes"],
      required_soft_skills: ["Communication"],
      contract_types: ["CDI"],
      activity_rate: "full_time",
      work_mode: "hybrid",
      expertise_domains: ["Cloud", "Infrastructure"],
    },
  ]);
  assert.deepEqual(detail.formations, [
    {
      id: "formation:formation_public_1",
      title: "Cloud responsable",
      url: "https://wejob.example.test/formations/formation_public_1",
      location: "Remote",
      application_deadline: "2026-08-01",
      description: "Construire des services cloud responsables.",
      experience_level: "senior",
      required_skills: ["Python", "React", "PHP"],
      formation_mode: "presentiel",
      certification_type: "certificat",
      categories: ["Cloud", "Durabilite"],
    },
  ]);
  assert.match(result.content[0].text, /## Mission/);
  assert.match(result.content[0].text, /## Culture/);
});

test("job detail falls back legacy required_skills to hard skills", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async () => jsonResponse({
      job: {
        id: "legacy-skills",
        title: "Data Engineer",
        required_skills: ["SQL", "Spark"],
      },
    }),
  });

  const result = await callTool("wejob_get_job", { id: "legacy-skills" }, client);

  assert.deepEqual(result.structuredContent.required_hard_skills, ["SQL", "Spark"]);
  assert.equal(Object.hasOwn(result.structuredContent, "required_soft_skills"), false);
  assert.equal(Object.hasOwn(result.structuredContent, "required_skills"), false);
});

test("generic search aggregates job, formation, and company ids", async () => {
  const client = {
    searchJobs: async () => [{ id: "job:j1", title: "Backend", url: "https://w/jobs/j1" }],
    searchFormations: async () => [{ id: "formation:f1", title: "API", url: "https://w/formations/f1" }],
    searchCompanies: async () => [{ id: "company:c1", title: "Acme", url: "https://w/companies/c1" }],
  };

  const result = await callTool("search", { query: "api", limit: 10 }, client);

  assert.deepEqual(
    result.structuredContent.results.map((item) => item.id),
    ["job:j1", "formation:f1", "company:c1"]
  );
});

test("fetch rejects unsupported id prefixes", async () => {
  const result = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "fetch",
      arguments: { id: "user:1" },
    },
  }, {});

  assert.equal(result.error.code, -32602);
  assert.match(result.error.message, /Unsupported WeJob id prefix/);
});

test("unknown JSON-RPC methods return method-not-found", async () => {
  const result = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 2,
    method: "unknown/method",
    params: {},
  }, {});

  assert.equal(result.error.code, -32601);
});

test("JSON-RPC calls emit structured logs without user arguments", async () => {
  const logs = [];
  const logger = createLogger({
    writer: {
      write(line) {
        logs.push(JSON.parse(line));
      },
    },
  });
  const client = {
    searchJobs: async () => [],
  };

  const result = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "wejob_search_jobs",
      arguments: {
        query: "Sensitive candidate name",
        location: "Vaud",
        limit: 10,
      },
    },
  }, client, {
    logger,
    requestId: "req-test-1",
    transport: "test",
  });

  assert.equal(result.result.structuredContent.results.length, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "mcp_request");
  assert.equal(logs[0].request_id, "req-test-1");
  assert.equal(logs[0].transport, "test");
  assert.equal(logs[0].mcp_method, "tools/call");
  assert.equal(logs[0].mcp_tool, "wejob_search_jobs");
  assert.equal(logs[0].status, "ok");
  assert.equal(typeof logs[0].latency_ms, "number");
  assert.equal(JSON.stringify(logs).includes("Sensitive candidate name"), false);
  assert.equal(JSON.stringify(logs).includes("Vaud"), false);
});

test("JSON-RPC error logs and responses redact secrets", async () => {
  const logs = [];
  const logger = createLogger({
    writer: {
      write(line) {
        logs.push(JSON.parse(line));
      },
    },
  });
  const client = {
    searchJobs: async () => {
      throw new Error("Upstream failed with Bearer abc123 token=secret api_key=hidden");
    },
  };

  const result = await handleJsonRpc({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "wejob_search_jobs",
      arguments: { query: "dev" },
    },
  }, client, {
    logger,
    requestId: "req-test-2",
    transport: "test",
  });

  assert.equal(result.error.code, -32603);
  assert.match(result.error.message, /Bearer \[redacted\]/);
  assert.match(result.error.message, /token=\[redacted\]/);
  assert.match(result.error.message, /api_key=\[redacted\]/);
  assert.equal(result.error.message.includes("abc123"), false);
  assert.equal(result.error.message.includes("secret"), false);
  assert.equal(result.error.message.includes("hidden"), false);
  assert.equal(logs[0].status, "error");
  assert.equal(logs[0].error_code, -32603);
  assert.equal(JSON.stringify(logs).includes("abc123"), false);
  assert.equal(JSON.stringify(logs).includes("secret"), false);
  assert.equal(JSON.stringify(logs).includes("hidden"), false);
});

test("HTTP MCP server handles tools/list", async () => {
  const server = createHttpMcpServer({
    client: {},
    logger: createLogger({ level: "silent" }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result.tools[0].name, "search");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTP MCP server returns 405 with Allow: POST on GET /mcp", async () => {
  const server = createHttpMcpServer({
    client: {},
    logger: createLogger({ level: "silent" }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "GET",
    });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/*
 * Additional coverage: MCP protocol conformance + HTTP transport safety.
 * These tests verify the plumbing that the business-logic tests above rely on:
 * the initialize handshake, notification handling, batching, malformed input,
 * body size limits, and static endpoints (/health, /). They are deliberately
 * offline — every case uses a stub client so no upstream API is required.
 */

async function startEphemeralMcp(clientOverrides = {}, serverOptions = {}) {
  const server = createHttpMcpServer({
    client: clientOverrides,
    logger: createLogger({ level: "silent" }),
    ...serverOptions,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("initialize returns protocolVersion, tools capability, serverInfo, and instructions", async () => {
  const response = await handleJsonRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "probe", version: "0" },
      },
    },
    {},
    { logger: createLogger({ level: "silent" }), transport: "test" },
  );
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.ok(response.result.capabilities.tools, "tools capability must be advertised");
  assert.equal(response.result.serverInfo.name, "wejob-mcp");
  assert.equal(response.result.serverInfo.version, "0.1.0");
  assert.match(response.result.instructions, /public read-only discovery/i);
});

test("ping returns an empty result", async () => {
  const response = await handleJsonRpc(
    { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
    {},
    { logger: createLogger({ level: "silent" }) },
  );
  assert.deepEqual(response.result, {});
});

test("resources/list returns an empty array (base MCP ships no widgets)", async () => {
  const response = await handleJsonRpc(
    { jsonrpc: "2.0", id: 3, method: "resources/list", params: {} },
    {},
    { logger: createLogger({ level: "silent" }) },
  );
  assert.deepEqual(response.result, { resources: [] });
});

test("batch JSON-RPC returns an array of responses in the same order", async () => {
  const response = await handleJsonRpc(
    [
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
    ],
    {},
    { logger: createLogger({ level: "silent" }) },
  );
  assert.ok(Array.isArray(response));
  assert.equal(response.length, 2);
  assert.equal(response[0].id, "a");
  assert.equal(response[1].id, "b");
  assert.ok(response[1].result.tools.length > 0);
});

test("HTTP: HEAD /health returns 200 (uptime monitors use HEAD)", async () => {
  const { base, close } = await startEphemeralMcp();
  try {
    const res = await fetch(`${base}/health`, { method: "HEAD" });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test("HTTP: HEAD / returns 200 (uptime monitors use HEAD)", async () => {
  const { base, close } = await startEphemeralMcp();
  try {
    const res = await fetch(`${base}/`, { method: "HEAD" });
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test("HTTP: /health returns ok with server name and version", async () => {
  const { base, close } = await startEphemeralMcp();
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.name, "wejob-mcp");
    assert.equal(body.version, "0.1.0");
  } finally {
    await close();
  }
});

test("HTTP: GET / returns a service info payload", async () => {
  const { base, close } = await startEphemeralMcp();
  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, "wejob-mcp");
    assert.equal(body.endpoint, "/mcp");
    assert.match(body.transport, /json-rpc/i);
  } finally {
    await close();
  }
});

test("HTTP: OpenAI apps challenge returns 404 until a token is configured", async () => {
  const { base, close } = await startEphemeralMcp();
  try {
    const res = await fetch(`${base}/.well-known/openai-apps-challenge`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("HTTP: OpenAI apps challenge returns the configured token", async () => {
  const token = "openai-challenge-token";
  const { base, close } = await startEphemeralMcp({}, { openaiAppsChallengeToken: token });
  try {
    const res = await fetch(`${base}/.well-known/openai-apps-challenge`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/plain\b/);
    assert.equal(await res.text(), token);
  } finally {
    await close();
  }
});

test("HTTP: OPTIONS /mcp returns 405 with Allow: POST (parity with GET)", async () => {
  const { base, close } = await startEphemeralMcp();
  try {
    const res = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  } finally {
    await close();
  }
});

test("HTTP: unknown path stays 404 (405 only fires on /mcp)", async () => {
  const { base, close } = await startEphemeralMcp();
  try {
    const res = await fetch(`${base}/does-not-exist`, { method: "GET" });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("HTTP: notifications/initialized (no id) returns 202 Accepted", async () => {
  const { base, close } = await startEphemeralMcp();
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(res.status, 202);
  } finally {
    await close();
  }
});

test("HTTP: malformed JSON body returns 400 with a -32700 parse error", async () => {
  const { base, close } = await startEphemeralMcp();
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, -32700);
  } finally {
    await close();
  }
});

test("HTTP: tools/call wejob_search_jobs happy path returns structured results", async () => {
  // Stub client — no upstream API, deterministic output.
  const stubClient = {
    async searchJobs() {
      return [
        { id: "job:1", title: "Dev Fullstack", url: "https://wejob.ch/jobs/1", company: "ACME" },
      ];
    },
  };
  const { base, close } = await startEphemeralMcp(stubClient);
  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "wejob_search_jobs", arguments: { query: "", limit: 1 } },
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.result.structuredContent, "structuredContent must be populated");
    assert.equal(body.result.structuredContent.results.length, 1);
    assert.equal(body.result.structuredContent.results[0].id, "job:1");
  } finally {
    await close();
  }
});

test("multi-value filters are sent as repeated key[] params (WJ-03)", async () => {
  const seen = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResponse({ data: [] });
    },
  });

  await callTool("wejob_search_jobs", { skills: ".NET", employment_type: "cdi,full_time" }, client);
  await callTool("wejob_search_jobs", { employment_type: ["cdi", " full_time "], experience_level: "senior,lead" }, client);

  for (const url of seen) {
    assert.equal(url.searchParams.get("employment_type"), null);
    assert.deepEqual(url.searchParams.getAll("employment_type[]"), ["cdi", "full_time"]);
  }
  assert.equal(seen[0].searchParams.get("skills"), ".NET");
  // "lead" is not a stored level: it becomes "expert", as in the backend ExperienceLevelCatalog.
  assert.deepEqual(seen[1].searchParams.getAll("experience_level[]"), ["senior", "expert"]);
});

test("a single multi-value filter keeps the plain key=value query", async () => {
  const seen = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResponse({ data: [] });
    },
  });

  await callTool("wejob_search_jobs", { employment_type: "cdi", work_mode: ["on_site"] }, client);
  await callTool("wejob_search_companies", { sizes: "51-200" }, client);

  assert.equal(seen[0].searchParams.get("employment_type"), "cdi");
  assert.equal(seen[0].searchParams.get("work_mode"), "on_site");
  assert.deepEqual(seen[0].searchParams.getAll("employment_type[]"), []);
  assert.equal(seen[1].searchParams.get("sizes"), "51-200");
});

test("technologies is folded into skills for jobs and formations, kept for companies (WJ-02)", async () => {
  const seen = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResponse({ data: [] });
    },
  });

  await callTool("wejob_search_jobs", { technologies: ".NET" }, client);
  await callTool("wejob_search_jobs", { skills: "C#", technologies: [".NET", "Azure"] }, client);
  await callTool("wejob_search_formations", { technologies: "Python" }, client);
  await callTool("wejob_search_companies", { technologies: "Java" }, client);
  await callTool("wejob_search_jobs", { skills: "PHP" }, client);

  assert.equal(seen[0].searchParams.get("skills"), ".NET");
  assert.equal(seen[0].searchParams.get("technologies"), null);
  assert.equal(seen[1].searchParams.get("skills"), "C#,.NET,Azure");
  assert.deepEqual(seen[1].searchParams.getAll("technologies[]"), []);
  assert.equal(seen[2].searchParams.get("skills"), "Python");
  assert.equal(seen[3].searchParams.get("technologies"), "Java");
  assert.equal(seen[3].searchParams.get("skills"), null);
  assert.equal(seen[4].searchParams.get("skills"), "PHP");
});

test("responsibilities and profile keep commas inside items (WJ-04)", async () => {
  const lines = `Concevoir et développer des composants robustes.
Garantir la qualité (tests, revues de code, CI/CD).
Participer aux choix d'architecture.`;
  const html = "<ul><li>Concevoir, développer et faire évoluer des applications Java, Spring Boot et Angular.</li><li>Participer à l&#39;analyse des besoins.</li></ul>";
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => jsonResponse({
      job: {
        id: url.pathname.endsWith("html_job") ? "html_job" : "lines_job",
        title: "Dev",
        responsibilities: url.pathname.endsWith("html_job") ? html : lines,
        who_you_are: url.pathname.endsWith("html_job") ? "<p>Rigueur, autonomie.</p><p>Anglais courant.</p>" : `Français courant, anglais technique.`,
      },
    }),
  });

  const linesJob = (await callTool("wejob_get_job", { id: "lines_job" }, client)).structuredContent;
  const htmlJob = (await callTool("wejob_get_job", { id: "html_job" }, client)).structuredContent;

  assert.deepEqual(linesJob.responsibilities, [
    "Concevoir et développer des composants robustes.",
    "Garantir la qualité (tests, revues de code, CI/CD).",
    "Participer aux choix d'architecture.",
  ]);
  assert.deepEqual(linesJob.profile, ["Français courant, anglais technique."]);
  assert.deepEqual(htmlJob.responsibilities, [
    "Concevoir, développer et faire évoluer des applications Java, Spring Boot et Angular.",
    "Participer à l'analyse des besoins.",
  ]);
  assert.deepEqual(htmlJob.profile, ["Rigueur, autonomie.", "Anglais courant."]);
});

test("get tools accept the composite id returned by search and fetch (WJ-12)", async () => {
  const paths = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      paths.push(url.pathname);
      const item = { id: "x1", title: "X", name: "X" };
      return jsonResponse({ ...item, job: item, formation: item });
    },
  });

  await callTool("wejob_get_job", { id: "job:01M4AMM96QB8S7PQW1BGK3PCEX" }, client);
  await callTool("wejob_get_job", { id: "01M4AMM96QB8S7PQW1BGK3PCEX" }, client);
  await callTool("wejob_get_company", { id: "company:01KXZJFTY2Z02QT5R71VQ2H1K7" }, client);
  await callTool("wejob_get_formation", { id: "formation:F1" }, client);
  await callTool("wejob_get_job", { id: "company:C1" }, client);

  assert.deepEqual(paths, [
    "/api/jobs/01M4AMM96QB8S7PQW1BGK3PCEX",
    "/api/jobs/01M4AMM96QB8S7PQW1BGK3PCEX",
    "/api/companies/01KXZJFTY2Z02QT5R71VQ2H1K7",
    "/api/formations/F1",
    "/api/jobs/company%3AC1",
  ]);
});

test("upstream failures map to distinct JSON-RPC codes (WJ-13)", async () => {
  const statusFor = { "/api/jobs/missing": 404, "/api/companies/bad": 422, "/api/formations/down": 503 };
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      if (url.pathname === "/api/jobs/offline") {
        throw new TypeError("fetch failed");
      }
      return jsonResponse({ message: "Ressource introuvable" }, statusFor[url.pathname] ?? 500);
    },
  });
  const call = (name, id) => handleJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { id } } },
    client,
  );

  const missing = await call("wejob_get_job", "missing");
  assert.equal(missing.error.code, -32002);
  assert.deepEqual(missing.error.data, { type: "not_found", http_status: 404 });
  assert.equal(missing.error.message, "Ressource introuvable");

  const fetched = await call("fetch", "job:missing");
  assert.equal(fetched.error.code, -32002);

  const invalid = await call("wejob_get_company", "bad");
  assert.equal(invalid.error.code, -32602);
  assert.equal(invalid.error.data.type, "invalid_input");

  const down = await call("wejob_get_formation", "down");
  assert.equal(down.error.code, -32603);
  assert.deepEqual(down.error.data, { type: "unavailable", http_status: 503 });

  const offline = await call("wejob_get_job", "offline");
  assert.equal(offline.error.code, -32603);
  assert.equal(offline.error.data.type, "unavailable");
  assert.equal(offline.error.message, "WeJob API is unreachable.");
});

test("salary filters are validated before reaching the API (WJ-11)", async () => {
  const seen = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResponse({ data: [] });
    },
  });
  const call = (args) => handleJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wejob_search_jobs", arguments: args } },
    client,
  );

  const notNumber = await call({ salary_min: "abc" });
  assert.equal(notNumber.error.code, -32602);
  assert.match(notNumber.error.message, /salary_min must be a non-negative number/);

  assert.equal((await call({ salary_max: "-5" })).error.code, -32602);

  const inverted = await call({ salary_min: "200000", salary_max: "10000" });
  assert.equal(inverted.error.code, -32602);
  assert.match(inverted.error.message, /lower than or equal/);

  assert.equal(seen.length, 0, "invalid salaries must not reach the API");

  const valid = await call({ salary_min: "100000", salary_max: 150000 });
  assert.ok(valid.result);
  assert.equal(seen[0].searchParams.get("salary_min"), "100000");
  assert.equal(seen[0].searchParams.get("salary_max"), "150000");
  assert.ok((await call({ salary_min: "0" })).result);
});

test("salary exposes its currency when the API provides one", async () => {
  const jobs = {
    chf: { id: "chf", title: "A", show_salary: true, salary_min: 110000, salary_max: 135000, salary_currency: "chf" },
    hidden: { id: "hidden", title: "B", show_salary: false, salary_min: 1, salary_max: 2, salary_currency: "CHF" },
    nominal: { id: "nominal", title: "C", salary_currency: "CHF" },
  };
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => jsonResponse({ job: jobs[url.pathname.split("/").pop()] }),
  });
  const salaryOf = async (id) => (await callTool("wejob_get_job", { id }, client)).structuredContent.salary;

  assert.deepEqual(await salaryOf("chf"), { min: 110000, max: 135000, currency: "CHF" });
  assert.equal(await salaryOf("hidden"), undefined);
  assert.equal(await salaryOf("nominal"), undefined);
});

test("company detail exposes the real active job and formation totals", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async () => jsonResponse({
      id: "c1",
      name: "WeJob Sàrl",
      active_jobs: 73,
      active_formations: 0,
      jobs: [{ id: "j1", title: "Ingénieur IAM" }],
    }),
  });

  const company = (await callTool("wejob_get_company", { id: "c1" }, client)).structuredContent;
  assert.equal(company.active_jobs, 73);
  assert.equal(company.jobs.length, 1);
});

test("narrative fields keep text around lists and tolerate omitted </li>", async () => {
  const bodies = {
    mixed: "<p>Vos missions :</p><ul><li>Concevoir, tester</li><li>Déployer</li></ul><p>Bonus : astreintes</p>",
    unclosedLast: "<ul><li>A, a</li><li>B</ul>",
    unclosedAll: "<ul><li>A<li>B</ul>",
    markdown: `- puce 1, détail
- puce 2
1. étape`,
    nested: "<ul><li>A<ul><li>A1</li></ul></li><li>B</li></ul>",
  };
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      const key = url.pathname.split("/").pop();
      return jsonResponse({ job: { id: key, title: "Dev", responsibilities: bodies[key] } });
    },
  });
  const items = async (key) => (await callTool("wejob_get_job", { id: key }, client)).structuredContent.responsibilities;

  assert.deepEqual(await items("mixed"), ["Vos missions :", "Concevoir, tester", "Déployer", "Bonus : astreintes"]);
  assert.deepEqual(await items("unclosedLast"), ["A, a", "B"]);
  assert.deepEqual(await items("unclosedAll"), ["A", "B"]);
  assert.deepEqual(await items("markdown"), ["puce 1, détail", "puce 2", "étape"]);
  assert.deepEqual(await items("nested"), ["A", "A1", "B"]);
});

test("a bare id prefix is rejected instead of calling the list endpoint", async () => {
  const paths = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      paths.push(url.pathname);
      return jsonResponse({ data: [] });
    },
  });
  for (const [name, id] of [["wejob_get_job", "job:"], ["wejob_get_company", "company:  "], ["wejob_get_formation", "formation:"]]) {
    const response = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { id } } }, client);
    assert.equal(response.error.code, -32602, name);
  }
  assert.deepEqual(paths, []);
});

test("request logs trace API calls and forward the request id, without tool values", async () => {
  const logs = [];
  const logger = createLogger({ writer: { write(line) { logs.push(JSON.parse(line)); } } });
  const seenHeaders = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url, init) => {
      seenHeaders.push(init.headers);
      return jsonResponse({ data: [{ id: "j1", title: "Dev" }], current_page: 1, last_page: 2 });
    },
  });

  await handleJsonRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "wejob_search_jobs", arguments: { query: "Jean Dupont Lausanne", employment_type: ["cdi"], "free text key": 1 } },
  }, client, { logger, requestId: "req-trace-1", transport: "test" });

  assert.equal(seenHeaders[0]["X-Request-Id"], "req-trace-1");
  assert.equal(logs.length, 1);
  const line = logs[0];
  assert.deepEqual(line.args_keys, ["employment_type", "query"]);
  assert.equal(line.result_count, 1);
  assert.equal(line.upstream.length, 1);
  assert.equal(line.upstream[0].path, "/api/jobs");
  assert.equal(line.upstream[0].status, 200);
  assert.equal(typeof line.upstream[0].latency_ms, "number");
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("Jean Dupont"), false);
  assert.equal(serialized.includes("Lausanne"), false);
  assert.equal(serialized.includes("free text key"), false);
});

test("error logs say what failed upstream and why", async () => {
  const logs = [];
  const logger = createLogger({ writer: { write(line) { logs.push(JSON.parse(line)); } } });
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("/offline")) {
        const error = new TypeError("fetch failed");
        error.cause = { code: "ECONNREFUSED" };
        throw error;
      }
      return jsonResponse({ message: "Offre introuvable" }, 404);
    },
  });
  const call = (id) => handleJsonRpc(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wejob_get_job", arguments: { id } } },
    client,
    { logger, requestId: "req-err", transport: "test" },
  );

  await call("missing");
  await call("offline");

  assert.equal(logs[0].error_type, "not_found");
  assert.equal(logs[0].upstream_status, 404);
  assert.deepEqual(logs[0].upstream.map((u) => [u.path, u.status]), [["/api/jobs/missing", 404]]);
  assert.equal(logs[1].error_type, "unavailable");
  assert.equal(logs[1].error_cause, "ECONNREFUSED");
  assert.equal(logs[1].upstream[0].status, "network_error");
});

test("createLogger can name the service it logs for", () => {
  const lines = [];
  createLogger({ service: "wejob-apps-sdk", writer: { write(line) { lines.push(JSON.parse(line)); } } }).info({ event: "x" });
  assert.equal(lines[0].service, "wejob-apps-sdk");
});

test("HTTP: a malformed body is never quoted in the logs", async () => {
  const lines = [];
  const server = createHttpMcpServer({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    logger: createLogger({ writer: { write(line) { lines.push(JSON.parse(line)); } } }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: "POST", body: "nom=Marie Curie&lieu=Geneve" });
    assert.equal(res.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(lines[0].error_code, -32700);
  assert.equal(lines[0].error_name, "SyntaxError");
  assert.equal(JSON.stringify(lines).includes("Marie"), false);
});

test("only plain request ids are reused and forwarded", async () => {
  assert.equal(sanitizeRequestId("req-abc_1.2:3"), "req-abc_1.2:3");
  assert.equal(sanitizeRequestId("Jean Dupont"), "");
  assert.equal(sanitizeRequestId("x".repeat(129)), "");
  assert.equal(sanitizeRequestId(undefined), "");

  const lines = [];
  const forwarded = [];
  const server = createHttpMcpServer({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url, init) => {
      forwarded.push(init.headers["X-Request-Id"]);
      return jsonResponse({ data: [] });
    },
    logger: createLogger({ writer: { write(line) { lines.push(JSON.parse(line)); } } }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-Id": "Jean Dupont" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wejob_search_jobs", arguments: {} } }),
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.match(forwarded[0], /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(lines).includes("Jean Dupont"), false);
});

test("detectCaller names the platform behind a request", () => {
  assert.equal(detectCaller("wejob-discord-bot/0.1.0"), "discord");
  assert.equal(detectCaller("wejob-alexa-skill/0.1.0"), "alexa");
  assert.equal(detectCaller("openai-mcp/1.0.0"), "chatgpt");
  assert.equal(detectCaller("claude-ai"), "claude");
  assert.equal(detectCaller("codex_cli_rs/0.40.0"), "codex");
  assert.equal(detectCaller("Mistral-LeChat/1.0"), "mistral");
  assert.equal(detectCaller("Visual Studio Code"), "copilot");
  assert.equal(detectCaller("UptimeRobot/2.0"), "uptime-monitor");
  assert.equal(detectCaller("python-httpx/0.27.0"), "unknown");
  assert.equal(detectCaller(""), undefined);
});

test("logs name the caller, from the User-Agent or the initialize clientInfo", async () => {
  const lines = [];
  const server = createHttpMcpServer({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async () => jsonResponse({ data: [] }),
    logger: createLogger({ writer: { write(line) { lines.push(JSON.parse(line)); } } }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const post = (body, userAgent) => fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
    body: JSON.stringify(body),
  });
  try {
    await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wejob_search_jobs", arguments: {} } }, "wejob-discord-bot/0.1.0");
    await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { clientInfo: { name: "claude-ai", version: "0.1.0" } } }, "python-httpx/0.27.0");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const mcp = lines.filter((l) => l.event === "mcp_request");
  const http = lines.filter((l) => l.event === "http_request");
  assert.equal(mcp[0].caller, "discord");
  assert.equal(http[0].caller, "discord");
  assert.equal(mcp[1].caller, "claude");
  assert.equal(mcp[1].client_name, "claude-ai");
  assert.equal(mcp[1].client_version, "0.1.0");
  assert.equal(http[1].caller, "unknown");
  assert.equal(http[1].user_agent, "python-httpx/0.27.0");
});

test("job locations list each place once when city and canton are the same", async () => {
  const detailFor = async (location) => {
    const client = createWeJobClient({
      apiBaseUrl: "https://api.example.test/api",
      webBaseUrl: "https://wejob.example.test",
      fetchImpl: async () => jsonResponse({ job: { id: "job_1", title: "Dev", location, company: { name: "ACME" } } }),
    });
    return (await callTool("wejob_get_job", { id: "job_1" }, client)).structuredContent;
  };

  assert.equal((await detailFor("Genève, Genève")).location, "Genève");
  assert.equal((await detailFor("Lausanne, Vaud, lausanne")).location, "Lausanne, Vaud");
  assert.equal((await detailFor("Zurich")).location, "Zurich");
  assert.equal((await detailFor("Geneve, Genève")).location, "Geneve");
});

test("search results carry the location so assistants and widgets can show it", async () => {
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("/companies")) {
        return jsonResponse({ data: [{ id: "c1", name: "ACME", locations: ["Vaud", "Genève"] }] });
      }
      return jsonResponse({ data: [
        { id: "j1", title: "Dev", location: "Genève, Genève", company: { name: "ACME" } },
        { id: "j2", title: "Ops", company: { name: "ACME" } },
      ] });
    },
  });

  const jobs = (await callTool("wejob_search_jobs", { query: "dev" }, client)).structuredContent.results;
  assert.equal(jobs[0].location, "Genève");
  assert.equal("location" in jobs[1], false);
  const companies = (await callTool("wejob_search_companies", { query: "acme" }, client)).structuredContent.results;
  assert.equal(companies[0].location, "Vaud, Genève");
});

test("search pagination reads the API counters: total and real next page", async () => {
  const searchWith = async (pagination, count) => {
    const client = createWeJobClient({
      apiBaseUrl: "https://api.example.test/api",
      webBaseUrl: "https://wejob.example.test",
      fetchImpl: async () => jsonResponse({
        data: Array.from({ length: count }, (_, index) => ({ id: `j${index}`, title: `Job ${index}`, company: { name: "ACME" } })),
        pagination,
      }),
    });
    return (await callTool("wejob_search_jobs", { location: "Vaud" }, client)).structuredContent.pagination;
  };

  assert.deepEqual(await searchWith({ total: 22, per_page: 10, current_page: 1, last_page: 3 }, 10), { page: 1, limit: 10, has_more: true, total: 22 });
  assert.deepEqual(await searchWith({ total: 22, per_page: 10, current_page: 3, last_page: 3 }, 2), { page: 3, limit: 10, has_more: false, total: 22 });
  // Exactly one full page: no phantom "next page" anymore.
  assert.deepEqual(await searchWith({ total: 10, per_page: 10, current_page: 1, last_page: 1 }, 10), { page: 1, limit: 10, has_more: false, total: 10 });
  assert.deepEqual(await searchWith({ total: 0, per_page: 10, current_page: 1, last_page: 1 }, 0), { page: 1, limit: 10, has_more: false, total: 0 });
});

test("each search tool advertises only its own documented filters", () => {
  const schema = (name) => tools.find((tool) => tool.name === name).inputSchema.properties;
  const jobs = schema("wejob_search_jobs");
  const formations = schema("wejob_search_formations");
  const companies = schema("wejob_search_companies");

  for (const properties of [jobs, formations, companies]) {
    for (const [key, property] of Object.entries(properties)) {
      assert.ok(property.description, `${key} needs a description`);
      // Single types only: Gemini and other clients reject union types.
      assert.equal(typeof property.type, "string", key);
    }
  }
  assert.ok(["employment_type", "work_mode", "experience_level", "salary_min", "languages"].every((key) => key in jobs));
  assert.ok(["tarif_min", "formation_mode", "sizes", "duration_min", "certification_type"].every((key) => !(key in jobs)));
  assert.ok(["formation_mode", "certification_type", "tarif_max", "duration_max"].every((key) => key in formations));
  assert.ok(!("salary_min" in formations) && !("work_mode" in formations));
  assert.deepEqual(Object.keys(companies).sort(), ["industries", "limit", "location", "page", "query", "sizes", "sort", "technologies"]);
  assert.deepEqual(jobs.sort.enum, ["newest", "oldest", "deadline_soon", "deadline_later", "level_asc"]);
  assert.ok(formations.sort.enum.includes("duration_asc"));
  assert.ok(companies.sort.enum.includes("most_jobs") && !companies.sort.enum.includes("price_asc"));
  assert.match(jobs.employment_type.description, /full_time/);
  assert.match(formations.duration_min.description, /days/);
});

test("filter aliases become the values the API stores, other values are sent as typed", () => {
  assert.equal(normalizeFilterValues("employment_type", "temps plein"), "full_time");
  assert.equal(normalizeFilterValues("employment_type", "Temps-Partiel, stage"), "part_time,internship");
  assert.deepEqual(normalizeFilterValues("employment_type", ["cdi", "alternance"]), ["cdi", "apprenticeship"]);
  assert.equal(normalizeFilterValues("experience_level", "confirmé,lead,Senior"), "intermediate,expert,Senior");
  assert.equal(normalizeFilterValues("formation_mode", "online"), "distanciel");
  assert.equal(normalizeFilterValues("certification_type", "Diplôme"), "diplome");
  assert.equal(normalizeFilterValues("employment_type", "inconnu"), "inconnu");
  assert.equal(normalizeFilterValues("work_mode", "télétravail"), "télétravail");
  assert.equal(normalizeFilterValues("location", "Genève"), "Genève");
});

test("aliased filters reach the API normalized, formation filters can carry several values", async () => {
  const seen = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResponse({ data: [] });
    },
  });
  await callTool("wejob_search_jobs", { employment_type: "temps plein", experience_level: "confirmé" }, client);
  await callTool("wejob_search_formations", { formation_mode: "presentiel,online", certification_type: "certificat" }, client);
  // Keys that are no longer advertised are still accepted and forwarded.
  await callTool("wejob_search_jobs", { industries: "finance" }, client);

  assert.equal(seen[0].searchParams.get("employment_type"), "full_time");
  assert.equal(seen[0].searchParams.get("experience_level"), "intermediate");
  assert.deepEqual(seen[1].searchParams.getAll("formation_mode[]"), ["presentiel", "distanciel"]);
  assert.equal(seen[1].searchParams.get("certification_type"), "certificat");
  assert.equal(seen[2].searchParams.get("industries"), "finance");
});

test("search parameters match the website catalogs (same order, same highlight)", async () => {
  const seen = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResponse({ data: [] });
    },
  });
  const params = async (tool, args) => {
    seen.length = 0;
    await callTool(tool, args, client);
    return Object.fromEntries(seen[0].searchParams);
  };

  // Companies: the site sorts by newest when no order is chosen (the API alone sorts by name).
  assert.equal((await params("wejob_search_companies", {})).sort, "newest");
  assert.equal((await params("wejob_search_companies", { sort: "most_jobs" })).sort, "most_jobs");
  // Formations: the site always sends created_at desc by default.
  const formations = await params("wejob_search_formations", {});
  assert.equal(formations.sort_by, "created_at");
  assert.equal(formations.sort_direction, "desc");
  // Orders offered by the site.
  const level = await params("wejob_search_jobs", { sort: "level_asc" });
  assert.deepEqual([level.sort_by, level.sort_direction], ["experience_level", "asc"]);
  const duration = await params("wejob_search_formations", { sort: "duration_asc" });
  assert.deepEqual([duration.sort_by, duration.sort_direction], ["duration_days", "asc"]);
  // Highlighted offers first on the first page of the default order only, as on the site.
  assert.equal((await params("wejob_search_jobs", {})).prioritize_highlight, "1");
  assert.equal((await params("wejob_search_jobs", { sort: "newest" })).prioritize_highlight, "1");
  assert.equal((await params("wejob_search_jobs", { page: 2 })).prioritize_highlight, undefined);
  assert.equal((await params("wejob_search_jobs", { sort: "deadline_soon" })).prioritize_highlight, undefined);
  assert.equal((await params("wejob_search_formations", {})).prioritize_highlight, "1");
  assert.equal((await params("wejob_search_companies", {})).prioritize_highlight, undefined);
});

test("cantons are sent as code and label in any language, other places as typed", async () => {
  const { expandCantonLocations } = await import("../src/server.js");
  assert.deepEqual(expandCantonLocations("Genève"), ["GE", "Genève"]);
  assert.deepEqual(expandCantonLocations("genf"), ["GE", "Genève"]);
  assert.deepEqual(expandCantonLocations("Geneva, Wallis"), ["GE", "Genève", "VS", "Valais"]);
  assert.deepEqual(expandCantonLocations("VD"), ["VD", "Vaud"]);
  assert.deepEqual(expandCantonLocations("Zürich"), ["ZH", "Zurich"]);
  assert.deepEqual(expandCantonLocations("Lausanne"), ["Lausanne"]);
  assert.deepEqual(expandCantonLocations("Lausanne, Vaud"), ["Lausanne", "VD", "Vaud"]);
  assert.equal(expandCantonLocations(""), "");

  const seen = [];
  const client = createWeJobClient({
    apiBaseUrl: "https://api.example.test/api",
    webBaseUrl: "https://wejob.example.test",
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResponse({ data: [] });
    },
  });
  await callTool("wejob_search_companies", { location: "Genève" }, client);
  await callTool("wejob_search_jobs", { location: "Lausanne" }, client);
  assert.deepEqual(seen[0].searchParams.getAll("location[]"), ["GE", "Genève"]);
  assert.equal(seen[1].searchParams.get("location"), "Lausanne");
});
