import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFitFileInWorkerThread } from "./parser-worker.ts";

const fixturesPath = resolve(import.meta.dirname, "fixtures");

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(fixturesPath, name));
}

describe("parseFitFileInWorkerThread", () => {
  it("parses a FIT file in a worker thread", async () => {
    const result = await parseFitFileInWorkerThread(loadFixture("test.fit"));

    expect(result.session.sport).toBe("cycling");
    expect(result.records.length).toBe(3229);
  });

  it("propagates parser errors from the worker thread", async () => {
    await expect(parseFitFileInWorkerThread(Buffer.from("not a fit file"))).rejects.toThrow(
      /incorrect header size/i,
    );
  });
});
