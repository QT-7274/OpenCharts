import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function readEntries(path) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenCharts local state file is invalid");
  }
  return parsed;
}

export function createAtomicFileStorage(path) {
  return {
    getItem(key) {
      const value = readEntries(path)[key];
      return typeof value === "string" ? value : null;
    },
    setItem(key, value) {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const entries = readEntries(path);
      entries[key] = value;
      const temporaryPath = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(temporaryPath, JSON.stringify(entries), { encoding: "utf8", mode: 0o600 });
        renameSync(temporaryPath, path);
      } finally {
        try { unlinkSync(temporaryPath); } catch {}
      }
    },
  };
}
