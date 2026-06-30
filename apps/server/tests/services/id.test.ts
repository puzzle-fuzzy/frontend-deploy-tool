import { describe, expect, test } from "bun:test";
import { createId } from "../../src/utils/id";

describe("createId", () => {
  test("returns a default nanoid-compatible identifier", () => {
    const id = createId();

    expect(id).toHaveLength(21);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("returns unique values across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => createId()));

    expect(ids.size).toBe(100);
  });
});
