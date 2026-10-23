// index.ts and scripts/dev-mock.ts start the same background jobs, so dev:mock behaves like the real server.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
/** The background jobs a startup file runs: each `startX(...)` call, and the one-off pocket settle pass. */
const jobsIn = (source: string) => [...new Set([...source.matchAll(/\b(start[A-Z]\w*|settleStaleMovements)\(/g)].map((m) => m[1]!))].sort();

describe("startup jobs", () => {
  test("the server settles half-done pocket movements at startup", () => {
    expect(jobsIn(read("index.ts"))).toContain("settleStaleMovements");
  });

  test("dev:mock starts every job the server starts", () => {
    const devMock = jobsIn(read("scripts/dev-mock.ts"));
    for (const job of jobsIn(read("index.ts"))) expect(devMock).toContain(job);
  });
});
