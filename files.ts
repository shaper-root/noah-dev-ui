/**
 * File processing module — text extraction, Ollama classification, file placement.
 */

import { resolve, extname, basename, dirname } from "path";
import { mkdirSync, existsSync, renameSync, unlinkSync, readdirSync, rmdirSync } from "fs";

const OLLAMA_URL = "http://127.0.0.1:11434";
const CLASSIFY_MODEL = "qwen3.5:4b";
const UPLOADS_DIR = resolve(import.meta.dir, "uploads");

// Ensure uploads root exists
mkdirSync(UPLOADS_DIR, { recursive: true });

export { UPLOADS_DIR };

// --- Text Extraction ---

export async function extractText(
  filePath: string,
  mimeType: string
): Promise<string | null> {
  try {
    const ext = extname(filePath).toLowerCase();

    if (ext === ".pdf") {
      const pdfParse = (await import("pdf-parse")).default;
      const buffer = await Bun.file(filePath).arrayBuffer();
      const data = await pdfParse(Buffer.from(buffer));
      return data.text || null;
    }

    if ([".md", ".txt", ".csv"].includes(ext)) {
      return await Bun.file(filePath).text();
    }

    if (ext === ".json") {
      const raw = await Bun.file(filePath).text();
      try {
        const parsed = JSON.parse(raw);
        return JSON.stringify(parsed, null, 2);
      } catch {
        return raw;
      }
    }

    // Unsupported — no text extraction
    return null;
  } catch (err) {
    console.error(`[files] Text extraction failed for ${filePath}:`, err);
    return null;
  }
}

// --- Ollama Classification ---

interface ClassificationResult {
  category: string;
  subcategory: string | null;
  tags: string[];
}

const DEFAULT_CLASSIFICATION: ClassificationResult = {
  category: "Reference",
  subcategory: null,
  tags: [],
};

/**
 * Extract the first JSON object from a string using balanced-brace matching.
 * Handles markdown fences, leading text, trailing commentary, and nested objects.
 */
function extractJsonFromResponse(text: string): Record<string, unknown> | null {
  // Strip markdown fences
  const stripped = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

  // Find first { and extract balanced JSON object
  const start = stripped.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < stripped.length; i++) {
    const c = stripped[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

const VALID_CATEGORIES = new Set([
  "Projects",
  "Personal",
  "Reference",
  "Values-Philosophy",
  "Technical",
  "Household",
]);

export async function classifyFile(
  filename: string,
  contentPreview: string
): Promise<ClassificationResult> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CLASSIFY_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Classify this document into EXACTLY one category and optionally one subcategory. Also suggest 3-5 tags.\n\n" +
              "Categories: Projects, Personal, Reference, Values-Philosophy, Technical, Household\n\n" +
              "If the document clearly belongs to a specific project, use that project name as the subcategory under Projects " +
              '(e.g., Projects/Noah, Projects/ShapeR).\n\n' +
              'Respond ONLY with JSON: {"category": "...", "subcategory": "..." or null, "tags": ["..."]}',
          },
          {
            role: "user",
            content: `Filename: ${filename}\n\nContent (first 2000 chars):\n${contentPreview.slice(0, 2000)}`,
          },
        ],
        stream: false,
        think: false,
        options: { num_ctx: 4096 },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      console.warn(`[files] Ollama classification failed: ${resp.status}`);
      return DEFAULT_CLASSIFICATION;
    }

    const data = await resp.json();
    const content = data.message?.content || "";
    const parsed = extractJsonFromResponse(content);

    if (!parsed) {
      console.warn("[files] Failed to parse classification JSON:", content.slice(0, 200));
      return DEFAULT_CLASSIFICATION;
    }

    const category = typeof parsed.category === "string" && VALID_CATEGORIES.has(parsed.category)
      ? parsed.category
      : "Reference";

    const subcategory = typeof parsed.subcategory === "string" && parsed.subcategory.length > 0
      ? sanitizePath(parsed.subcategory)
      : null;

    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string").slice(0, 10)
      : [];

    return { category, subcategory, tags };
  } catch (err) {
    console.warn("[files] Classification error (Ollama may be down):", err);
    return DEFAULT_CLASSIFICATION;
  }
}

// --- File Placement ---

/** Remove characters unsafe for directory/file names */
function sanitizePath(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim();
}

/** Find a unique filename by appending -2, -3, etc. */
function deduplicateFilename(dir: string, name: string): string {
  const ext = extname(name);
  const base = basename(name, ext);
  let candidate = name;
  let n = 2;

  while (existsSync(resolve(dir, candidate))) {
    candidate = `${base}-${n}${ext}`;
    n++;
  }

  return candidate;
}

export interface PlacementResult {
  /** Relative path from uploads/ root, e.g., "Projects/Noah/spec.md" */
  relativePath: string;
  /** Absolute path on disk */
  absolutePath: string;
  /** Final filename (may differ from original if deduplicated) */
  filename: string;
}

export function placeFile(
  category: string,
  subcategory: string | null,
  originalFilename: string
): PlacementResult {
  const safeFilename = sanitizePath(originalFilename);
  const dirParts = [category];
  if (subcategory) dirParts.push(subcategory);

  const dir = resolve(UPLOADS_DIR, ...dirParts);
  mkdirSync(dir, { recursive: true });

  const filename = deduplicateFilename(dir, safeFilename);
  const absolutePath = resolve(dir, filename);
  const relativePath = dirParts.concat(filename).join("/");

  return { relativePath, absolutePath, filename };
}

/** Move a file to a new category/subcategory. Returns the new relative path. */
export function moveFile(
  currentAbsolutePath: string,
  newCategory: string,
  newSubcategory: string | null,
  originalFilename: string
): PlacementResult {
  const placement = placeFile(newCategory, newSubcategory, originalFilename);
  renameSync(currentAbsolutePath, placement.absolutePath);

  // Clean up empty parent directory
  try {
    const oldDir = dirname(currentAbsolutePath);
    if (readdirSync(oldDir).length === 0) {
      rmdirSync(oldDir);
    }
  } catch {
    // Ignore cleanup errors
  }

  return placement;
}

/** Delete a file from disk */
export function deleteFileFromDisk(absolutePath: string): void {
  try {
    unlinkSync(absolutePath);
    // Clean up empty parent directory
    const dir = dirname(absolutePath);
    if (readdirSync(dir).length === 0) {
      rmdirSync(dir);
    }
  } catch {
    // File may already be gone
  }
}

// --- MIME Type Detection ---

const MIME_MAP: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
};

export function detectMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

export const SUPPORTED_EXTENSIONS = new Set(Object.keys(MIME_MAP));
