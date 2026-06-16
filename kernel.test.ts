import { describe, test, expect, afterEach } from "bun:test";
import { resolve } from "path";
import { config } from "./config";
import { loadKernel, resetKernelCache } from "./kernel";

const REAL_KERNEL = resolve(
  import.meta.dir,
  "../../skillforge/deploy/bundles/reasoning-kernel.md",
);

// Snapshot + restore the (mutable) config.kernel block around each test so cases
// don't leak into each other or into other test files.
const original = { ...config.kernel };
afterEach(() => {
  Object.assign(config.kernel, original);
  resetKernelCache();
});

describe("loadKernel", () => {
  test("loads the full kernel and parses version + token estimate", () => {
    config.kernel.enabled = true;
    config.kernel.tier = "full";
    config.kernel.path = REAL_KERNEL;
    resetKernelCache();

    const k = loadKernel();
    expect(k.active).toBe(true);
    expect(k.tier).toBe("full");
    expect(k.version).toMatch(/^v\d+\.\d+\.\d+/);
    expect(k.tokenEstimate).toBeGreaterThan(0);
    expect(k.text.length).toBeGreaterThan(0);
    expect(k.source).toBe(REAL_KERNEL);
  });

  test("disabled → passthrough", () => {
    config.kernel.enabled = false;
    config.kernel.tier = "full";
    resetKernelCache();

    const k = loadKernel();
    expect(k.active).toBe(false);
    expect(k.text).toBe("");
    expect(k.version).toBe("none");
    expect(k.source).toBe("passthrough");
  });

  test("tier=none → passthrough even when enabled", () => {
    config.kernel.enabled = true;
    config.kernel.tier = "none";
    resetKernelCache();

    const k = loadKernel();
    expect(k.active).toBe(false);
    expect(k.source).toBe("passthrough");
  });

  test("missing file → graceful passthrough (never throws)", () => {
    config.kernel.enabled = true;
    config.kernel.tier = "full";
    config.kernel.path = resolve(import.meta.dir, "does-not-exist-kernel.md");
    resetKernelCache();

    const k = loadKernel();
    expect(k.active).toBe(false);
    expect(k.source).toBe("passthrough");
  });

  test("tier=lite with missing lite file → graceful passthrough", () => {
    config.kernel.enabled = true;
    config.kernel.tier = "lite";
    config.kernel.litePath = resolve(import.meta.dir, "no-lite-kernel.md");
    resetKernelCache();

    const k = loadKernel();
    expect(k.active).toBe(false);
    expect(k.source).toBe("passthrough");
  });

  test("result is cached until reset", () => {
    config.kernel.enabled = true;
    config.kernel.tier = "full";
    config.kernel.path = REAL_KERNEL;
    resetKernelCache();

    const a = loadKernel();
    // Mutating config without resetting must NOT change the cached result.
    config.kernel.enabled = false;
    const b = loadKernel();
    expect(b).toBe(a);
  });
});
