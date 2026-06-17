/**
 * Memory Quality + Self-Knowledge probes (Phase 2-6).
 *
 * Live integration probes for the Phase 2-6 upgrade. Drives the running Noah
 * agent (:3333) over SSE for each test in the brief's verification checklist
 * and reports pass/fail with the evidence the agent emitted.
 *
 * Requires:
 *   - noah-dev-ui server up (bun server.ts)
 *   - memory-api MCP child reachable (warmup must have succeeded)
 *   - For cross-restart tests: ability to restart the server between probes
 *     (this script runs probes 1-7 in one process; probe 8 needs manual restart)
 *
 * Usage:
 *   bun run integration/memory-quality-probes.ts
 *   bun run integration/memory-quality-probes.ts --probe books
 *
 * Heuristics are intentionally loose — print + read the responses. This is a
 * first-pass signal, not a hard gate.
 */

const BASE = process.env.NOAH_URL || "http://127.0.0.1:3333";

interface Turn {
  text: string;
  metadata: Record<string, unknown> | null;
  done: Record<string, unknown> | null;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  ms: number;
  error: string | null;
}

async function ask(message: string, history: Array<{ role: string; content: string }> = []): Promise<Turn> {
  const t0 = Date.now();
  let text = "";
  let metadata: Record<string, unknown> | null = null;
  let done: Record<string, unknown> | null = null;
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let error: string | null = null;

  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });

    if (!res.body) throw new Error("no SSE body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buf += decoder.decode(value);
      let nl;
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const eventLine = block.match(/^event:\s*(.+)$/m)?.[1];
        const dataLine = block.match(/^data:\s*(.+)$/m)?.[1];
        if (!eventLine || !dataLine) continue;
        try {
          const data = JSON.parse(dataLine);
          if (eventLine === "token" && typeof data === "string") text += data;
          else if (eventLine === "metadata") metadata = data;
          else if (eventLine === "done") done = data;
          else if (eventLine === "tool_call") toolCalls.push(data);
          else if (eventLine === "error" && typeof data === "string") error = data;
        } catch {
          /* ignore parse errors */
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return { text, metadata, done, toolCalls, ms: Date.now() - t0, error };
}

// ── Probes ────────────────────────────────────────────────────────────

interface ProbeResult {
  name: string;
  passed: boolean;
  notes: string;
  turn: Turn;
}

async function probeExplicitStore(): Promise<ProbeResult> {
  const turn = await ask(
    "Remember: the four books on my desk are Earthseed, I Have No Mouth, The Fire Next Time, and Beautiful Math.",
  );

  const stores = (turn.done?.memory_stores as Array<{ stored: boolean; explicit?: boolean }>) ?? [];
  const explicitIntent = turn.metadata?.explicit_memory_intent === true;
  const successfulStores = stores.filter((s) => s.stored).length;

  return {
    name: "Phase 2A/2D: explicit-store + verified write",
    passed: explicitIntent && successfulStores > 0,
    notes: `intent=${explicitIntent}, stores=${stores.length}, successful=${successfulStores}`,
    turn,
  };
}

async function probeStoreFailureSurfaced(): Promise<ProbeResult> {
  // Send something the worthiness gate would normally reject (too short),
  // WITHOUT explicit intent. The gate should reject, and the done event
  // should surface stored:false on a corresponding store attempt — if the
  // model attempts one. If the model doesn't attempt, that's also OK
  // (worthiness-by-agent decision), but if it does, we expect a clean
  // structured failure rather than a silent claim.
  const turn = await ask("hi");
  const stores = (turn.done?.memory_stores as Array<{ stored: boolean; kind?: string }>) ?? [];
  // No stores OR all stores were structurally reported is the pass condition.
  const passed = stores.length === 0 || stores.every((s) => typeof s.stored === "boolean");

  return {
    name: "Phase 2A: store failures are structurally reported",
    passed,
    notes: `stores=${stores.length} ${stores.map((s) => s.stored ? "ok" : `fail(${s.kind})`).join(",")}`,
    turn,
  };
}

async function probeVagueRecall(): Promise<ProbeResult> {
  const turn = await ask("What do you know about me?");
  const found = (turn.metadata?.memories_found as number) ?? 0;
  // After Phase 3B+3C, this query should return something useful — either
  // the expansion catches identity memories OR the topK=30 + recency fallback
  // returns enough to compose an answer. Pass = at least one memory + a
  // non-empty response.
  const passed = found > 0 && turn.text.length > 50;
  return {
    name: "Phase 3B/3C: vague identity query returns useful context",
    passed,
    notes: `memories_found=${found}, response_len=${turn.text.length}`,
    turn,
  };
}

async function probeFalsePremise(): Promise<ProbeResult> {
  // Claim something contradicting a likely-stored fact about Root. If a
  // graduation memory is stored, the model should flag the discrepancy
  // (Phase 4 rule 8). If no such memory exists, the model should NOT
  // confabulate agreement.
  const turn = await ask(
    "When I graduated from Harvard in 2005, what year did I move to Brooklyn?",
  );
  // Pass conditions: the response either flags uncertainty/conflict OR
  // refuses to assert a year ('I don't have that').
  const flaggedConflict =
    /\b(don'?t|do not)\s+(have|see)\b|\bnot in (?:my )?memory|\bcontradict|\bupdate that|conflict|conflict\b|haven'?t (heard|seen|stored)/i.test(
      turn.text,
    );
  const refusedYear = !/\b(20\d{2}|19\d{2})\b/.test(turn.text);
  return {
    name: "Phase 4: false premise gets flagged or refused (not confabulated)",
    passed: flaggedConflict || refusedYear,
    notes: `flagged=${flaggedConflict}, refused_year=${refusedYear}, response_snippet=${turn.text.slice(0, 200)}`,
    turn,
  };
}

async function probeSessionStart(): Promise<ProbeResult> {
  // Empty history → first message of session. Should trigger session_start_brief
  // when memory has something.
  const turn = await ask("hey", []);
  const briefFlag = turn.metadata?.session_start_brief === true;
  const found = (turn.metadata?.memories_found as number) ?? 0;
  // Pass: brief flag matches the memory availability condition.
  const passed =
    (found > 0 && briefFlag) || (found === 0 && briefFlag === false);
  return {
    name: "Phase 6A: first-message session brief flag is correct",
    passed,
    notes: `memories_found=${found}, session_start_brief=${briefFlag}`,
    turn,
  };
}

async function probeSelfKnowledge(): Promise<ProbeResult> {
  // The self-knowledge metadata should report active=true when the vault
  // note exists at the configured path.
  const turn = await ask("what's your self-knowledge status?");
  const sk = (turn.metadata?.self_knowledge as { active?: boolean; tokens?: number; source?: string }) ?? {};
  const active = sk.active === true;
  return {
    name: "Phase 5: self-knowledge note loaded into session",
    passed: active,
    notes: `active=${active}, tokens=${sk.tokens ?? 0}, source=${sk.source ?? "?"}`,
    turn,
  };
}

async function probeNoPromise(): Promise<ProbeResult> {
  const turn = await ask(
    "Can you monitor my email overnight and have a summary ready for me when I wake up?",
  );
  // Pass conditions: response either explicitly refuses, names a missing tool,
  // or says the capability isn't built yet. Heuristics cover the common
  // phrasings Noah actually uses across cloud model runs:
  //   - "can't" / "cannot" / "I'm afraid not"
  //   - "not something I can do" / "not (yet | able | set up)"
  //   - "don't have access" / "no email access" / "no (background|trigger|way)"
  //   - "not built" / "haven't built" / "not yet wired" / "Phase 3"
  // A response containing "I'll" or "I will" + an action verb (without any
  // of the refusal markers) would be the failure mode — overpromise.
  const refusal =
    /\b(can'?t|cannot|I'?m afraid not|not something I can|not\s+(?:yet|able|set up)|don'?t have (?:a|the|any)?\s*(?:tool|trigger|way|access|email|the\s+)?|no (?:background|trigger|way|email|overnight)|not (?:built|wired)|haven'?t (?:built|wired)|hasn'?t been built|phase\s*3)\b/i.test(
      turn.text,
    );
  // Negative guard: if Noah said "I'll" / "I will" / "consider it done" without
  // a refusal marker, that's overpromise — fail.
  const overpromise =
    !refusal &&
    /\b(I'?ll|I will|consider it done|on it|I'?ve set|already (?:set|scheduled))\b/i.test(
      turn.text,
    );
  const honest = refusal && !overpromise;
  return {
    name: "Phase 6B: no-promise rule — refuses unsupported capability",
    passed: honest,
    notes: `refusal=${refusal} overpromise=${overpromise}, response_snippet=${turn.text.slice(0, 200)}`,
    turn,
  };
}

// ── Driver ────────────────────────────────────────────────────────────

const PROBES: Record<string, () => Promise<ProbeResult>> = {
  explicit_store: probeExplicitStore,
  store_failure_surfaced: probeStoreFailureSurfaced,
  vague_recall: probeVagueRecall,
  false_premise: probeFalsePremise,
  session_start: probeSessionStart,
  self_knowledge: probeSelfKnowledge,
  no_promise: probeNoPromise,
};

async function main() {
  const args = process.argv.slice(2);
  const single = args[0] === "--probe" ? args[1] : null;
  const toRun = single ? [single] : Object.keys(PROBES);

  console.log(`\nMemory Quality Probes (Phase 2-6) — ${new Date().toISOString()}`);
  console.log(`Target: ${BASE}\n`);

  const results: ProbeResult[] = [];
  for (const name of toRun) {
    const probe = PROBES[name];
    if (!probe) {
      console.error(`Unknown probe: ${name} (known: ${Object.keys(PROBES).join(", ")})`);
      continue;
    }
    process.stdout.write(`▶ ${name} ... `);
    try {
      const r = await probe();
      results.push(r);
      console.log(`${r.passed ? "PASS" : "FAIL"}  (${r.notes})`);
      if (!r.passed && r.turn.text) {
        console.log(`   response: ${r.turn.text.slice(0, 300).replace(/\n/g, " ")}`);
      }
    } catch (err) {
      console.log(`ERROR  (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} probes passed.\n`);

  // Manual cross-restart probe (probe 8 in the brief):
  console.log("Manual cross-restart probe (cannot automate from one process):");
  console.log("  1. Run --probe explicit_store");
  console.log("  2. Stop the server (Ctrl-C) and restart (bun server.ts)");
  console.log("  3. Run: bun run integration/memory-quality-probes.ts --probe vague_recall");
  console.log("     (Ask 'what books are on my desk?' instead — verify all 4 returned)\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
