import fs from "node:fs";
import path from "node:path";

export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function readTextFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function readJsonFileSafe<T>(filePath: string): T | null {
  const raw = readTextFileSafe(filePath);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJsonFile(filePath: string, value: unknown): void {
  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function appendJsonLine(filePath: string, value: unknown): void {
  ensureDirectory(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

export function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function listFilesRecursive(
  root: string,
  predicate: (absolutePath: string) => boolean,
  maxDepth = 8
): string[] {
  if (!fileExists(root)) {
    return [];
  }

  const results: string[] = [];

  function visit(current: string, depth: number): void {
    if (depth > maxDepth) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, depth + 1);
        continue;
      }

      if (predicate(absolutePath)) {
        results.push(absolutePath);
      }
    }
  }

  visit(root, 0);
  return results.sort();
}

export function walkUpDirectories(startDir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(startDir);

  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return dirs;
}

export function uniqueByPath(paths: string[]): string[] {
  return Array.from(new Set(paths.map((item) => path.resolve(item))));
}

export function dedupeByKey<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const results: T[] = [];

  for (const item of items) {
    const itemKey = key(item);
    if (seen.has(itemKey)) {
      continue;
    }

    seen.add(itemKey);
    results.push(item);
  }

  return results;
}
