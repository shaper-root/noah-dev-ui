import { Hono } from "hono";

const NOAH_MEMORY_URL = "http://127.0.0.1:6789";

export const dreamRoutes = new Hono();

// Helper: proxy a GET request to noah-memory
async function proxyGet(path: string) {
  const resp = await fetch(`${NOAH_MEMORY_URL}${path}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`noah-memory ${resp.status} on GET ${path}`);
  return resp.json();
}

// Helper: proxy a POST request to noah-memory
async function proxyPost(path: string, body: unknown) {
  const resp = await fetch(`${NOAH_MEMORY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`noah-memory ${resp.status} on POST ${path}`);
  return resp.json();
}

function errorResponse(err: unknown) {
  return {
    error: "noah-memory unreachable",
    detail: err instanceof Error ? err.message : String(err),
  };
}

// GET proxies
dreamRoutes.get("/status", async (c) => {
  try {
    return c.json(await proxyGet("/api/dream/status"));
  } catch (err) {
    return c.json(errorResponse(err), 502);
  }
});

dreamRoutes.get("/results", async (c) => {
  try {
    return c.json(await proxyGet("/api/dream/results"));
  } catch (err) {
    return c.json(errorResponse(err), 502);
  }
});

dreamRoutes.get("/results/:id", async (c) => {
  try {
    const id = c.req.param("id");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return c.json({ error: "Invalid id" }, 400);
    return c.json(await proxyGet(`/api/dream/results/${id}`));
  } catch (err) {
    return c.json(errorResponse(err), 502);
  }
});

dreamRoutes.get("/history", async (c) => {
  try {
    return c.json(await proxyGet("/api/dream/history"));
  } catch (err) {
    return c.json(errorResponse(err), 502);
  }
});

dreamRoutes.get("/actions", async (c) => {
  try {
    return c.json(await proxyGet("/api/dream/actions"));
  } catch (err) {
    return c.json(errorResponse(err), 502);
  }
});

dreamRoutes.get("/briefing", async (c) => {
  try {
    return c.json(await proxyGet("/api/dream/briefing"));
  } catch (err) {
    return c.json(errorResponse(err), 502);
  }
});

// POST proxies
dreamRoutes.post("/start", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await proxyPost("/api/dream/start", body));
  } catch (err) {
    return c.json(errorResponse(err), 502);
  }
});

dreamRoutes.post("/stop", async (c) => {
  try {
    return c.json(await proxyPost("/api/dream/stop", {}));
  } catch (err) {
    return c.json(errorResponse(err), 502);
  }
});

dreamRoutes.post("/review", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await proxyPost("/api/dream/review", body));
  } catch (err) {
    return c.json(errorResponse(err), 502);
  }
});

// Aggregated health summary (server-side computation)
dreamRoutes.get("/health-summary", async (c) => {
  try {
    const history = await proxyGet("/api/dream/history") as Array<{ id: string }>;
    const recentCycles = (Array.isArray(history) ? history : []).slice(0, 7);

    const rulesScorecard: Record<string, { pass: number; fail: number }> = {};
    let retrievalCoverage: number | null = null;

    for (const cycle of recentCycles) {
      try {
        const cycleData = await proxyGet(`/api/dream/results/${cycle.id}`) as {
          results?: Array<{
            job_name: string;
            status: string;
            result_data: string;
            metrics: string | null;
          }>;
        };
        if (!cycleData.results) continue;

        for (const result of cycleData.results) {
          if (result.job_name === "thinking_audit" && result.result_data) {
            try {
              const data = JSON.parse(result.result_data);
              if (data.rule_results && Array.isArray(data.rule_results)) {
                for (const r of data.rule_results) {
                  if (!rulesScorecard[r.rule_id]) rulesScorecard[r.rule_id] = { pass: 0, fail: 0 };
                  if (r.passed) rulesScorecard[r.rule_id].pass++;
                  else rulesScorecard[r.rule_id].fail++;
                }
              }
            } catch { /* skip unparseable */ }
          }
          if (result.job_name === "retrieval_coverage" && result.metrics) {
            try {
              const metrics = JSON.parse(result.metrics);
              if (typeof metrics.coverage_rate === "number") {
                retrievalCoverage = metrics.coverage_rate;
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip failed cycle fetch */ }
    }

    return c.json({
      rules_scorecard: Object.entries(rulesScorecard).map(([rule_id, counts]) => ({
        rule_id,
        ...counts,
      })),
      retrieval_coverage_rate: retrievalCoverage,
      cycles_analyzed: recentCycles.length,
    });
  } catch (err) {
    return c.json(errorResponse(err), 502);
  }
});
