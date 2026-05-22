import { Hono } from "hono";

const WATCHDOG_URL = "http://127.0.0.1:6790";
const NOAH_MEMORY_URL = "http://127.0.0.1:6789";

export const dashboardRoutes = new Hono();

dashboardRoutes.get("/status", async (c) => {
  try {
    const resp = await fetch(`${WATCHDOG_URL}/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      return c.json({ healthy: false, error: `Watchdog returned ${resp.status}` });
    }
    const data = await resp.json();
    return c.json(data);
  } catch (err) {
    return c.json({
      healthy: false,
      error: "Watchdog unreachable",
      services: {
        ollama: { status: "unknown", since: null },
        noah_memory: { status: "unknown", since: null },
        home_assistant: { status: "unknown", since: null },
        shannon_encoder: { status: "unknown", since: null },
      },
      canary: { status: "unknown" },
    });
  }
});

dashboardRoutes.get("/shannon", async (c) => {
  try {
    const resp = await fetch(`${NOAH_MEMORY_URL}/api/shannon/metrics`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      return c.json({ error: "Shannon metrics unavailable" });
    }
    return c.json(await resp.json());
  } catch {
    return c.json({ error: "Shannon metrics unavailable" });
  }
});
