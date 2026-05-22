import { Hono } from "hono";
import { resolve } from "path";

const RULES_PATH = resolve("C:\\Users\\MyOme\\homeassistant\\custom_components\\noah\\thinking_rules.json");

export const rulesRoutes = new Hono();

rulesRoutes.get("/", async (c) => {
  try {
    const file = Bun.file(RULES_PATH);
    if (!(await file.exists())) {
      return c.json({ error: "thinking_rules.json not found", rules: [] });
    }
    const data = await file.json();
    return c.json(data);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

const ALLOWED_RULE_FIELDS = new Set([
  "id", "name", "description", "prompt_instruction", "enforcement",
  "testable_assertion", "category", "added", "updated",
]);

const ALLOWED_TOP_LEVEL = new Set([
  "version", "updated_at", "updated_by", "categories", "rules",
]);

rulesRoutes.put("/", async (c) => {
  try {
    const body = await c.req.json();

    // Validate structure
    if (!body.rules || !Array.isArray(body.rules)) {
      return c.json({ error: "Invalid rules structure: 'rules' array required" }, 400);
    }

    // Strip unknown fields from each rule
    body.rules = body.rules.map((r: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => ALLOWED_RULE_FIELDS.has(k)))
    );

    // Strip unknown top-level fields
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (ALLOWED_TOP_LEVEL.has(k)) sanitized[k] = v;
    }

    // Update metadata
    sanitized.updated_at = new Date().toISOString().split("T")[0];
    sanitized.updated_by = "dev-ui";
    sanitized.rules = body.rules;

    await Bun.write(RULES_PATH, JSON.stringify(sanitized, null, 2));
    return c.json({ ok: true, updated_at: body.updated_at });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Get proposed amendments from dream thinking_audit results
rulesRoutes.get("/audit", async (c) => {
  try {
    const resp = await fetch("http://127.0.0.1:6789/api/dream/actions", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      return c.json({ amendments: [] });
    }
    const actions = await resp.json() as Array<{
      id: number;
      job_name: string;
      result_data: string;
      action_description: string | null;
    }>;

    const amendments = (Array.isArray(actions) ? actions : [])
      .filter((a) => a.job_name === "thinking_audit" || a.job_name === "thinking_audit_review")
      .map((a) => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(a.result_data) || {}; } catch { /* skip */ }
        return {
          result_id: a.id,
          action_description: a.action_description,
          rule_id: typeof parsed.rule_id === "string" ? parsed.rule_id : undefined,
          amendment_type: typeof parsed.amendment_type === "string" ? parsed.amendment_type : undefined,
          reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
          proposed_changes: parsed.proposed_changes ?? undefined,
        };
      });

    return c.json({ amendments });
  } catch {
    return c.json({ amendments: [] });
  }
});
