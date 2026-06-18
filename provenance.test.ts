import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { config } from "./config";
import {
  classifyProvenance,
  parseFrontmatterKeys,
  topLevelFolder,
  TRUST_AUTHORED,
  TRUST_IMPORTED,
} from "./provenance";
import { vaultProvenance } from "./vault";

// ── DEFAULT-LOW flip (Sprint 2 hardening, audit-okeanos-fullstack-2026-06-17) ──
// Authored/0.9 is reachable ONLY via AUTHORED_ALLOWLIST (a narrow, location-based,
// unforgeable set). Everything else — loose root, unmarked folders, ingested,
// ambiguous — defaults to 0.5. These tests pin both live holes closed and the
// forgery path closed. Run this file ALONE (`bun test provenance.test.ts`) —
// the wider suite has known mock.module leakage.
describe("classifyProvenance — default-low acceptance criteria", () => {
  test("external-ingest frontmatter → imported, 0.5 (demotion overrides allowlist)", () => {
    // external-ingest created_by demotes even inside an (otherwise) authored folder
    let r = classifyProvenance(
      "short story/x.md",
      "---\ncreated_by: readwise\n---\nbody",
    );
    expect(r).toEqual({ provenance: "imported", trust: TRUST_IMPORTED });

    // actual web-clipper signature (url:) — forward-compat (none in this vault yet)
    r = classifyProvenance(
      "short story/x.md",
      "---\ntitle: Cool Article\nurl: https://example.com/post\n---\n",
    );
    expect(r.provenance).toBe("imported");

    // generated_by: morning-brief demotes a daily brief
    r = classifyProvenance(
      "00-dashboard/daily/2026-06-11_brief.md",
      "---\ntype: daily-brief\ngenerated_by: morning-brief\n---",
    );
    expect(r.provenance).toBe("imported");

    // audit-added markers also demote (belt-and-suspenders)
    expect(
      classifyProvenance("short story/x.md", "---\ncreated_by: agent-brief\n---")
        .provenance,
    ).toBe("imported");
    expect(
      classifyProvenance(
        "short story/x.md",
        "---\ncreated_by: bulk-import-scaffold\n---",
      ).provenance,
    ).toBe("imported");
  });

  test("import-folder file → imported, 0.5 (honest label)", () => {
    expect(
      classifyProvenance(
        "04-intel/inbox/signal.md",
        "---\ntype: signal\ncreated_by: auto-ingested\n---",
      ),
    ).toEqual({ provenance: "imported", trust: TRUST_IMPORTED });
    // _noah holds Noah's own machine-written logs → imported, by path alone
    expect(classifyProvenance("_noah/sessions/2026-06-16_mac_6.md").provenance).toBe(
      "imported",
    );
    // 03-outreach is mixed → imported (was already correct; no per-file promotion)
    expect(classifyProvenance("03-outreach/cack-wilhelm.md").provenance).toBe(
      "imported",
    );
  });

  test("HOLE #1 — loose-root self-injection closed: root files → 0.5 (were 0.9)", () => {
    // THE headline fix: Noah-Self-Knowledge.md is Noah's OWN per-session writing.
    // It must never reach authored-trust (self-injection into its own detector).
    for (const path of [
      "Noah-Self-Knowledge.md",
      "Welcome.md",
      "Seed 2.0.md",
      "Fable Notes.md",
    ]) {
      const r = classifyProvenance(path, "# Heading\nplain note");
      expect(r).toEqual({ provenance: "unknown", trust: TRUST_IMPORTED });
    }
  });

  test("HOLE #2 — bulk-import blanket closed: 02-library → 0.5 (was 0.9)", () => {
    // 02-library is no longer folder-authored. `bulk import` is NOT an authorship
    // signal (and not an external-ingest marker), so a library file defaults low.
    let r = classifyProvenance(
      "02-library/frameworks/okeanos.md",
      "---\ntype: framework\ncreated_by: bulk import\ncreated: 2026-06-01\n---\n# Okeanos",
    );
    expect(r).toEqual({ provenance: "unknown", trust: TRUST_IMPORTED });

    // a library file with an external marker is likewise low (via demotion)
    r = classifyProvenance(
      "02-library/feeds/scrape.md",
      "---\ncreated_by: n8n auto-detection\n---",
    );
    expect(r.provenance).toBe("imported");
    expect(r.trust).toBe(TRUST_IMPORTED);

    // 05-projects is a CANDIDATE left OFF the allowlist pending confirmation → 0.5
    expect(
      classifyProvenance(
        "05-projects/earthseed/STATUS.md",
        "---\ntype: project-status\nupdated_by: V2 migration\n---",
      ).trust,
    ).toBe(TRUST_IMPORTED);
  });

  test("FORGERY closed: created_by/author in own frontmatter does NOT reach 0.9", () => {
    // A file asserting its own authorship (`created_by: root`/`manual`) must not
    // self-promote — provenance is read from LOCATION, never content (SEC-1 class).
    expect(
      classifyProvenance("03-outreach/y.md", "---\ncreated_by: root\n---").trust,
    ).toBe(TRUST_IMPORTED);
    expect(
      classifyProvenance(
        "03-outreach/sidechat-ceo.md",
        "---\ntype: person\ncreated_by: manual\n---",
      ).provenance,
    ).not.toBe("authored");
    // loose-root file claiming root authorship → still 0.5
    expect(
      classifyProvenance("x.md", "---\ncreated_by: root\n---\nclaiming authority")
        .trust,
    ).toBe(TRUST_IMPORTED);
    // an arbitrary/CRM-export value also stays low
    expect(
      classifyProvenance(
        "03-outreach/contact.md",
        '---\nauthor: "alice-contact"\n---\nTier 1 source',
      ).provenance,
    ).toBe("imported");
  });

  test("ALLOWLISTED location → authored, 0.9 (the only path up)", () => {
    // Root's creative writing — genuinely authored, no import pipeline.
    expect(
      classifyProvenance("Short story/1) Opening.md", "Once upon a time"),
    ).toEqual({ provenance: "authored", trust: TRUST_AUTHORED });
    // case-insensitive folder match, by path alone (no content)
    expect(classifyProvenance("short story/ch2.md").provenance).toBe("authored");
  });

  test("undeterminable folder → unknown, 0.5 (fail-safe)", () => {
    expect(classifyProvenance("99-mystery/thing.md", "no frontmatter")).toEqual({
      provenance: "unknown",
      trust: TRUST_IMPORTED,
    });
    // 06-sensitive / _raw style paths classify low (excluded at the vault layer)
    expect(classifyProvenance("06-sensitive/secret.md").trust).toBe(TRUST_IMPORTED);
  });

  test("classify by path alone (no content) uses folder only", () => {
    expect(classifyProvenance("04-intel/x.md").provenance).toBe("imported");
    expect(classifyProvenance("03-outreach/x.md").provenance).toBe("imported");
    expect(classifyProvenance("short story/x.md").provenance).toBe("authored");
    expect(classifyProvenance("02-library/x.md").provenance).toBe("unknown");
    expect(classifyProvenance("zzz/x.md").provenance).toBe("unknown");
  });

  test("invariant: trust is ALWAYS 0.5 unless provenance is authored", () => {
    const cases = [
      "04-intel/a.md",
      "_noah/b.md",
      "03-outreach/c.md",
      "99-x/d.md",
      "02-library/e.md",
      "00-dashboard/f.md",
      "_archive/g.md",
      "Seed.md",
      "short story/h.md", // the only authored one
    ];
    for (const p of cases) {
      const r = classifyProvenance(p);
      if (r.provenance === "authored") expect(r.trust).toBe(0.9);
      else expect(r.trust).toBe(0.5);
    }
  });
});

describe("parseFrontmatterKeys", () => {
  test("extracts scalar keys, lowercased, bracket/quote-stripped", () => {
    const fm = parseFrontmatterKeys(
      '---\ntype: Person\ncreated_by: "[Bulk Import]"\n---\nbody',
    );
    expect(fm.type).toBe("person");
    expect(fm.created_by).toBe("bulk import");
  });
  test("no frontmatter → empty object", () => {
    expect(parseFrontmatterKeys("# Just a heading")).toEqual({});
    expect(parseFrontmatterKeys("")).toEqual({});
  });
});

describe("topLevelFolder", () => {
  test("folder vs loose note, case-insensitive", () => {
    expect(topLevelFolder("04-intel/inbox/x.md")).toBe("04-intel");
    expect(topLevelFolder("Seed 2.0.md")).toBe("");
    expect(topLevelFolder("02-Library/X.md")).toBe("02-library");
  });
});

// ── fs glue is READ-ONLY (the no-mutation invariant) ─────────────────────────
describe("vaultProvenance — fs glue classifies and never mutates the file", () => {
  const FIXTURE = resolve(import.meta.dir, ".test-provenance-fixture");
  const saved = { ...config.vault };

  beforeAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(resolve(FIXTURE, "04-intel"), { recursive: true });
    mkdirSync(resolve(FIXTURE, "short story"), { recursive: true });
    mkdirSync(resolve(FIXTURE, "02-library"), { recursive: true });
    writeFileSync(
      resolve(FIXTURE, "04-intel", "signal.md"),
      "---\ntype: signal\ncreated_by: auto-ingested\n---\nExternal signal body.",
    );
    writeFileSync(
      resolve(FIXTURE, "short story", "opening.md"),
      "Once upon a time — Root's own prose.",
    );
    writeFileSync(
      resolve(FIXTURE, "02-library", "note.md"),
      "---\ncreated_by: bulk import\n---\nBulk-migrated library note.",
    );
    config.vault.enabled = true;
    config.vault.path = FIXTURE;
    config.vault.exclude = [".obsidian", "06-sensitive"];
    config.vault.maxFileBytes = 200_000;
  });

  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
    Object.assign(config.vault, saved);
  });

  test("classifies via file head when no content is passed", () => {
    expect(vaultProvenance("04-intel/signal.md").provenance).toBe("imported");
    expect(vaultProvenance("short story/opening.md").provenance).toBe("authored");
    // 02-library bulk-import file is no longer authored → 0.5
    expect(vaultProvenance("02-library/note.md").trust).toBe(TRUST_IMPORTED);
    expect(vaultProvenance("02-library/note.md").provenance).toBe("unknown");
  });

  test("passing content avoids the head read but agrees with it", () => {
    const withContent = vaultProvenance(
      "04-intel/signal.md",
      "---\ncreated_by: auto-ingested\n---\nx",
    );
    const withRead = vaultProvenance("04-intel/signal.md");
    expect(withContent).toEqual(withRead);
  });

  test("vault file bytes + mtime are unchanged after repeated classification", () => {
    const targets = [
      resolve(FIXTURE, "02-library", "note.md"),
      resolve(FIXTURE, "04-intel", "signal.md"),
      resolve(FIXTURE, "short story", "opening.md"),
    ];
    const before = targets.map((p) => ({
      bytes: readFileSync(p),
      stat: statSync(p),
    }));
    // Hammer both code paths: head-read and content-passed.
    for (let i = 0; i < 50; i++) {
      vaultProvenance("02-library/note.md");
      vaultProvenance("02-library/note.md", before[0].bytes.toString("utf-8"));
      vaultProvenance("04-intel/signal.md");
      vaultProvenance("short story/opening.md");
    }
    targets.forEach((p, i) => {
      const after = readFileSync(p);
      const afterStat = statSync(p);
      expect(after.equals(before[i].bytes)).toBe(true);
      expect(afterStat.size).toBe(before[i].stat.size);
      expect(afterStat.mtimeMs).toBe(before[i].stat.mtimeMs);
    });
  });

  test("inaccessible path fails safe (path-only classification, no throw)", () => {
    // excluded / nonexistent → head read returns "", classify by path
    expect(vaultProvenance("06-sensitive/secret.md").provenance).toBe("unknown");
    expect(vaultProvenance("nope/missing.md").provenance).toBe("unknown");
  });
});
