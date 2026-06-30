import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { safeJoin } from "../../src/utils/safePath";

describe("safeJoin", () => {
  const root = resolve("tmp", "artifact-root");

  test("resolves a normal relative path inside root", () => {
    expect(safeJoin(root, "assets/index.js")).toBe(join(root, "assets", "index.js"));
  });

  test("rejects parent directory traversal", () => {
    expect(safeJoin(root, "../outside.txt")).toBeNull();
    expect(safeJoin(root, "assets/../../outside.txt")).toBeNull();
  });

  test("rejects absolute paths", () => {
    expect(safeJoin(root, resolve("tmp", "artifact-root-sibling", "index.html"))).toBeNull();
  });

  test("rejects sibling-prefix paths outside root", () => {
    const siblingRoot = resolve("tmp", "artifact-root-sibling");
    expect(safeJoin(root, siblingRoot)).toBeNull();
  });

  test("rejects empty paths", () => {
    expect(safeJoin(root, "")).toBeNull();
    expect(safeJoin(root, "   ")).toBeNull();
  });
});
