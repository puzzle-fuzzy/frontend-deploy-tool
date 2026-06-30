import { join } from "node:path";
import { createApp } from "./src/app";

const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.DATA_FILE ?? join(import.meta.dir, "data.json");
const storageDir = process.env.STORAGE_DIR ?? join(import.meta.dir, ".voasx", "storage");
const publicDir = process.env.PUBLIC_DIR ?? join(import.meta.dir, "public");

Bun.serve({
  port,
  fetch: createApp({ dataFile, storageDir, publicDir }).fetch,
});

console.log(`DeployKit server is running at http://localhost:${port}`);
