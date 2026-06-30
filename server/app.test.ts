import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testClient } from "hono/testing";
import { createApp } from "./src/app";

let tempDir: string;
type TestClient = ReturnType<typeof testClient> & {
  api: Record<string, any>;
};

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "deploykit-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createTestClient() {
  return testClient(
    createApp({
      dataFile: join(tempDir, "data.json"),
      storageDir: join(tempDir, "storage"),
      publicDir: join(tempDir, "public"),
    }),
  ) as TestClient;
}

async function createProject(client: ReturnType<typeof createTestClient>) {
  const res = await client.api.projects.$post({
    json: {
      name: "Demo App",
      slug: "demo-app",
      description: "Demo deployment",
    },
  });

  expect(res.status).toBe(201);
  return res.json();
}

test("updates project settings through the settings endpoint", async () => {
  const client = createTestClient();
  const project = await createProject(client);

  const res = await client.api.projects[":id"].settings.$patch({
    param: { id: project.id },
    json: { spaMode: true, routingType: "hash" },
  });

  expect(res.status).toBe(200);
  const updated = await res.json();
  expect(updated.settings).toEqual({ spaMode: true, routingType: "hash" });
});

test("rejects activating an unknown version without changing the active version", async () => {
  const client = createTestClient();
  const project = await createProject(client);
  const version = await client.api.projects[":id"].versions.$post({
    param: { id: project.id },
    form: {
      folderFiles: new File(["<html></html>"], "index.html"),
      versionDesc: "first build",
    },
  });

  expect(version.status).toBe(201);
  const createdVersion = await version.json();

  const failed = await client.api.projects[":id"].versions[":versionId"].activate.$put({
    param: { id: project.id, versionId: "missing-version" },
  });

  expect(failed.status).toBe(404);

  const list = await client.api.projects[":id"].versions.$get({
    param: { id: project.id },
  });
  const currentProject = await list.json();
  expect(currentProject.versions).toContainEqual(
    expect.objectContaining({ id: createdVersion.id, active: true }),
  );
});
