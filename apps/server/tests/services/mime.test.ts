import { describe, expect, test } from "bun:test";
import { getMimeType } from "../../src/utils/mime";

describe("getMimeType", () => {
  test("returns content types for common frontend assets", () => {
    expect(getMimeType("index.html")).toBe("text/html; charset=utf-8");
    expect(getMimeType("assets/app.css")).toBe("text/css; charset=utf-8");
    expect(getMimeType("assets/app.js")).toBe("application/javascript; charset=utf-8");
    expect(getMimeType("assets/data.json")).toBe("application/json; charset=utf-8");
    expect(getMimeType("assets/logo.svg")).toBe("image/svg+xml");
    expect(getMimeType("assets/font.woff2")).toBe("font/woff2");
    expect(getMimeType("assets/module.wasm")).toBe("application/wasm");
  });

  test("matches extensions case-insensitively", () => {
    expect(getMimeType("IMAGE.PNG")).toBe("image/png");
    expect(getMimeType("VIDEO.MP4")).toBe("video/mp4");
  });

  test("falls back to application/octet-stream for unknown extensions", () => {
    expect(getMimeType("download.binpack")).toBe("application/octet-stream");
    expect(getMimeType("README")).toBe("application/octet-stream");
  });
});
