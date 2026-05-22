import { Hono } from "hono";
import { DB } from "../db";

export const analyticsRoutes = new Hono();

analyticsRoutes.get("/stats", (c) => {
  const stats = DB.getAnalyticsStats();
  return c.json(stats);
});

analyticsRoutes.get("/conversation/:id", (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "Invalid id" }, 400);
  const avgMs = DB.getConversationAvgResponseTime(id);
  return c.json({ conversation_id: id, avg_response_time_ms: avgMs });
});
