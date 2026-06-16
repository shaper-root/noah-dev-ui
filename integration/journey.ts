/**
 * Full-journey integration test — the conversational reliability regression gate.
 *
 * Drives the LIVE Noah agent (:3333) end-to-end over SSE. Runs a varied 10-step
 * user journey on BOTH local and cloud, asserting that EVERY turn produces a
 * complete response (terminal `done` with non-empty text) or a clear `error`
 * event — never a silent drop, crash, or metadata-only truncation.
 *
 * Usage:
 *   bun run integration/journey.ts                 # local + cloud, 1 round
 *   bun run integration/journey.ts --rounds 20     # 20 rounds (reliability soak)
 *   bun run integration/journey.ts --modes local   # single mode
 *   NOAH_URL=http://127.0.0.1:3333 bun run integration/journey.ts
 *
 * Requires the stack to be running. Exits 0 if all turns pass, 1 otherwise.
 */

const BASE = process.env.NOAH_URL || "http://127.0.0.1:3333";

interface TurnResult {
  ok: boolean;
  reason: string;
  ms: number;
  events: string[];
  tokenText: string;
  errorMsg: string | null;
}

interface Msg {
  role: string;
  content: string;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** A valid answer is prose, not a raw tool-call JSON blob leaking to the user. */
function looksLikeToolJson(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  return /"name"\s*:\s*"(memory_remember|memory_recall|memory_forget|memory_inspect|web_research)"/.test(t);
}

async function setMode(mode: "local" | "cloud"): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** POST one message and parse the SSE stream into a structured result. */
async function runTurn(message: string, history: Msg[]): Promise<TurnResult> {
  const t0 = Date.now();
  const events: string[] = [];
  let tokenText = "";
  let errorMsg: string | null = null;
  let sawDone = false;
  let sawError = false;

  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
      signal: AbortSignal.timeout(150_000),
    });

    if (!res.ok || !res.body) {
      return { ok: false, reason: `HTTP ${res.status}`, ms: Date.now() - t0, events, tokenText, errorMsg };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let ev = "message";
        const dataLines: string[] = [];
        for (const rawLine of frame.split("\n")) {
          const line = rawLine.replace(/\r$/, "");
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (!dataLines.length) continue;
        const dataStr = dataLines.join("\n");
        events.push(ev);
        if (ev === "token") {
          try { tokenText += JSON.parse(dataStr); } catch { tokenText += dataStr; }
        } else if (ev === "done") {
          sawDone = true;
        } else if (ev === "error") {
          sawError = true;
          try { errorMsg = JSON.parse(dataStr); } catch { errorMsg = dataStr; }
        }
      }
    }
  } catch (err) {
    return {
      ok: false,
      reason: `exception: ${err instanceof Error ? err.message : String(err)}`,
      ms: Date.now() - t0,
      events,
      tokenText,
      errorMsg,
    };
  }

  const ms = Date.now() - t0;

  // Acceptance: a clean completion (done + non-empty answer) OR a clear error
  // (error event with a non-empty message). Anything else is a reliability failure.
  if (sawDone && tokenText.trim().length > 0) {
    if (looksLikeToolJson(tokenText)) {
      return { ok: false, reason: "answer is raw tool-call JSON, not prose", ms, events, tokenText, errorMsg };
    }
    return { ok: true, reason: "done", ms, events, tokenText, errorMsg };
  }
  if (sawError && errorMsg && errorMsg.trim().length > 0) {
    return { ok: true, reason: `clean-error: ${errorMsg.slice(0, 60)}`, ms, events, tokenText, errorMsg };
  }
  if (sawDone && !tokenText.trim()) {
    return { ok: false, reason: "done but EMPTY answer", ms, events, tokenText, errorMsg };
  }
  return { ok: false, reason: `no terminal event (events: ${events.join(",") || "none"})`, ms, events, tokenText, errorMsg };
}

const LONG_MESSAGE =
  "I want to give you a lot of background at once so you have the full picture. " +
  "Over the years I have worked across many industries and roles, moving between commercial, product, and operations functions. " +
  "I tend to enter a company in a go-to-market capacity and gradually migrate toward building and running the systems behind the product. " +
  "I care a great deal about doing things properly rather than quickly, about understanding the why behind a decision, and about leaving systems better than I found them. " +
  "I am self-taught technically and I value resourcefulness and follow-through. ".repeat(6) +
  "Given all of that, what patterns do you notice, and how would you summarize who I am in two sentences?";

// Sequential conversation (builds shared history) + a rapid-fire burst.
const SCENARIOS: Array<{ name: string; message: string; followsHistory: boolean }> = [
  { name: "short greeting", message: "Hi.", followsHistory: false },
  { name: "broad personal", message: "Tell me about yourself.", followsHistory: true },
  { name: "specific factual", message: "Where did I go to college?", followsHistory: true },
  { name: "tool-triggering", message: "Search your memory for my career history.", followsHistory: true },
  { name: "follow-up", message: "What stands out most about that?", followsHistory: true },
  { name: "correction-to-store", message: "Please remember that I prefer concise, direct answers.", followsHistory: true },
  { name: "recall-correction", message: "What did I just ask you to remember about how I like answers?", followsHistory: true },
  { name: "very-long message", message: LONG_MESSAGE, followsHistory: true },
];

async function runJourney(mode: "local" | "cloud"): Promise<{ pass: number; fail: number; failures: string[] }> {
  console.log(`\n══════════ MODE: ${mode} ══════════`);
  const switched = await setMode(mode);
  if (!switched) {
    // The mode was explicitly requested — a switch failure means it was NOT
    // tested. Count it as a hard failure so CI can't report green with zero
    // coverage of a requested mode (e.g. a missing cloud key).
    const msg = `[${mode}] MODE SWITCH FAILED — mode NOT tested (key missing or Noah down)`;
    console.log(`  ✗✗ ${msg}`);
    return { pass: 0, fail: 1, failures: [msg] };
  }

  const history: Msg[] = [];
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const sc of SCENARIOS) {
    const r = await runTurn(sc.message, sc.followsHistory ? history : []);
    const tag = r.ok ? "✓" : "✗";
    console.log(
      `  ${tag} ${sc.name.padEnd(22)} ${String(r.ms).padStart(6)}ms  ${r.reason}` +
        (r.ok && r.reason === "done" ? `  »${r.tokenText.slice(0, 50).replace(/\s+/g, " ")}…` : ""),
    );
    if (r.ok) {
      pass++;
      // Build conversation context for subsequent follow-ups.
      history.push({ role: "user", content: sc.message });
      history.push({ role: "assistant", content: r.tokenText || "(no answer)" });
    } else {
      fail++;
      failures.push(`[${mode}] ${sc.name}: ${r.reason}`);
    }
  }

  // Rapid-fire: 3 concurrent requests on the same history — exercises the
  // shared-state / reentrancy paths (regex, MCP client, mode singleton).
  const burst = await Promise.all([
    runTurn("Quick one: what's my name?", history),
    runTurn("Quick one: where am I based?", history),
    runTurn("Quick one: what do I do?", history),
  ]);
  burst.forEach((r, i) => {
    const tag = r.ok ? "✓" : "✗";
    console.log(`  ${tag} rapid-fire[${i}]          ${String(r.ms).padStart(6)}ms  ${r.reason}`);
    if (r.ok) pass++;
    else { fail++; failures.push(`[${mode}] rapid-fire[${i}]: ${r.reason}`); }
  });

  return { pass, fail, failures };
}

async function main() {
  const rounds = parseInt(arg("rounds", "1"), 10);
  const modes = arg("modes", "local,cloud").split(",") as Array<"local" | "cloud">;

  console.log(`Noah journey integration test → ${BASE}`);
  console.log(`Rounds: ${rounds} | Modes: ${modes.join(", ")}`);

  let totalPass = 0;
  let totalFail = 0;
  const allFailures: string[] = [];

  for (let round = 1; round <= rounds; round++) {
    if (rounds > 1) console.log(`\n############ ROUND ${round}/${rounds} ############`);
    for (const mode of modes) {
      const { pass, fail, failures } = await runJourney(mode);
      totalPass += pass;
      totalFail += fail;
      allFailures.push(...failures);
    }
  }

  console.log(`\n══════════ SUMMARY ══════════`);
  console.log(`PASS: ${totalPass}   FAIL: ${totalFail}`);
  if (allFailures.length) {
    console.log("Failures:");
    for (const f of allFailures) console.log(`  - ${f}`);
  }
  // Reset to local for a known good resting state.
  await setMode("local");
  process.exit(totalFail === 0 ? 0 : 1);
}

main();
