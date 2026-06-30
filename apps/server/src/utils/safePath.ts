import { isAbsolute, relative, resolve } from "node:path";

export function safeJoin(root: string, relativePath: string): string | null {
  const requestedPath = relativePath.trim();
  if (!requestedPath || requestedPath.includes("\0")) return null;
  if (isAbsolute(requestedPath)) return null;

  const rootPath = resolve(root);
  const targetPath = resolve(rootPath, requestedPath);
  const pathFromRoot = relative(rootPath, targetPath);

  if (pathFromRoot === "") return null;
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return null;

  return targetPath;
}
