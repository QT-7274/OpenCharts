import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileDailyLimitStore } from "./ai-explanation.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("crypto-ai-analysis.AI_EXPLANATION.10 file-backed daily limit", () => {
  it("persists only a UTC date and non-negative call count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencharts-ai-limit-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "usage.json");
    const store = createFileDailyLimitStore(file);

    await store.write({ day: "2026-10-08", count: 7 });

    expect(await store.read()).toEqual({ day: "2026-10-08", count: 7 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ day: "2026-10-08", count: 7 });
  });
});
