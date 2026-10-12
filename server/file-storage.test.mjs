import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createAtomicFileStorage } from "./file-storage.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("crypto-ai-analysis.FORWARD_SIMULATION.4 atomically persists multiple storage keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencharts-forward-"));
  directories.push(directory);
  const path = join(directory, "state.json");
  const first = createAtomicFileStorage(path);
  first.setItem("ledger", "{\"orders\":[]}");
  first.setItem("history", "[]");

  const restored = createAtomicFileStorage(path);
  assert.equal(restored.getItem("ledger"), "{\"orders\":[]}");
  assert.equal(restored.getItem("history"), "[]");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort(), ["history", "ledger"]);
});
