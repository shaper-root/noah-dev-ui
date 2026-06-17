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

// ── Pure classification (no fs) — the Stage 1 acceptance criteria ────────────
describe("classifyProvenance — acceptance criteria", () => {
  test("clipper/external-ingest frontmatter → imported, 0.5", () => {
    // external-ingest created_by demotes even inside an authored folder
    let r = classifyProvenance(
      "02-library/x.md",
      "---\ncreated_by: n8n auto-detection\n---\nbody",
    );
    expect(r).toEqual({ provenance: "imported", trust: TRUST_IMPORTED });

    // actual web-clipper signature (url:) — forward-compat (none in this vault yet)
    r = classifyProvenance(
      "05-projects/x.md",
      "---\ntitle: Cool Article\nurl: https://example.com/post\n---\n",
    );
    expect(r.provenance).toBe("imported");

    // generated_by: morning-brief inside the authored 00-dashboard folder demotes
    r = classifyProvenance(
      "00-dashboard/daily/2026-06-11_brief.md",
      "---\ntype: daily-brief\ngenerated_by: morning-brief\n---",
    );
    expect(r.provenance).toBe("imported");
  });

  test("import-folder file → imported, 0.5", () => {
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
  });

  test("plain authored note (incl. bulk-migrated) → authored, 0.9", () => {
    // bulk import is a MIGRATION marker, not an authorship signal → folder wins
    let r = classifyProvenance(
      "02-library/frameworks/okeanos.md",
      "---\ntype: framework\ncreated_by: bulk import\ncreated: 2026-06-01\n---\n# Okeanos",
    );
    expect(r).toEqual({ provenance: "authored", trust: TRUST_AUTHORED });

    // V2 migration likewise neutral
    r = classifyProvenance(
      "05-projects/earthseed/STATUS.md",
      "---\ntype: project-status\nupdated_by: V2 migration\n---",
    );
    expect(r.provenance).toBe("authored");

    // loose top-level note, no frontmatter
    expect(classifyProvenance("Seed 2.0.md", "# Seed\nplain note").provenance).toBe(
      "authored",
    );

    // authored folder, no frontmatter at all (case-insensitive folder match)
    expect(
      classifyProvenance("Short story/1) Opening.md", "Once upon a time").provenance,
    ).toBe("authored");
  });

  test("ambiguous / undeterminable folder → unknown, 0.5 (fail-safe)", () => {
    expect(classifyProvenance("99-mystery/thing.md", "no frontmatter")).toEqual({
      provenance: "unknown",
      trust: TRUST_IMPORTED,
    });
  });

  test("03-outreach mixed folder: imported by default, promoted only by an authored marker", () => {
    // no authorship marker → fail-safe imported
    expect(
      classifyProvenance(
        "03-outreach/cack-wilhelm.md",
        "---\ntype: person\n---\n[bulk import]: Tier 1 source",
      ).provenance,
    ).toBe("imported");

    // explicit human/manual authorship marker → promoted to authored
    expect(
      classifyProvenance(
        "03-outreach/sidechat-ceo.md",
        "---\ntype: person\ncreated_by: manual\n---",
      ).provenance,
    ).toBe("authored");
    expect(
      classifyProvenance("03-outreach/y.md", "---\ncreated_by: root\n---").provenance,
    ).toBe("authored");

    // bulk import in outreach stays imported (neutral marker, folder default imported)
    expect(
      classifyProvenance("03-outreach/x.md", "---\ncreated_by: bulk import\n---").provenance,
    ).toBe("imported");

    // FAIL-SAFE (adversary regression): an ARBITRARY/unrecognized created_by value
    // must NOT promote — a tampered or bulk-imported contact must stay imported/0.5,
    // not reach 0.9. Only the explicit AUTHORED_MARKERS allowlist promotes.
    expect(
      classifyProvenance(
        "03-outreach/contact.md",
        '---\ncreated_by: "alice-contact"\n---\nTier 1 source',
      ),
    ).toEqual({ provenance: "imported", trust: TRUST_IMPORTED });
    expect(
      classifyProvenance("03-outreach/z.md", "---\nauthor: some-crm-export\n---").provenance,
    ).toBe("imported");
  });

  test("classify by path alone (no content) uses folder only", () => {
    expect(classifyProvenance("04-intel/x.md").provenance).toBe("imported");
    expect(classifyProvenance("02-library/x.md").provenance).toBe("authored");
    expect(classifyProvenance("zzz/x.md").provenance).toBe("unknown");
  });

  test("invariant: trust is ALWAYS 0.5 unless provenance is authored", () => {
    const cases = [
      "04-intel/a.md",
      "_noah/b.md",
      "03-outreach/c.md",
      "99-x/d.md",
      "02-library/e.md",
      "Seed.md",
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
    mkdirSync(resolve(FIXTURE, "02-library"), { recursive: true });
    writeFileSync(
      resolve(FIXTURE, "04-intel", "signal.md"),
      "---\ntype: signal\ncreated_by: auto-ingested\n---\nExternal signal body.",
    );
    writeFileSync(
      resolve(FIXTURE, "02-library", "note.md"),
      "---\ncreated_by: bulk import\n---\nRoot's own framework note.",
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
    expect(vaultProvenance("02-library/note.md").provenance).toBe("authored");
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
