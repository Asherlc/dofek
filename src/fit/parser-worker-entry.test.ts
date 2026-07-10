import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixturesPath = resolve(import.meta.dirname, "fixtures");

interface MockParentPort {
  postMessage: ReturnType<typeof vi.fn>;
}

function loadFixture(name: string): Buffer {
  return readFileSync(resolve(fixturesPath, name));
}

async function importWorkerEntry(workerData: unknown): Promise<MockParentPort> {
  vi.resetModules();
  const parentPort: MockParentPort = { postMessage: vi.fn() };
  vi.doMock("node:worker_threads", () => ({ parentPort, workerData }));

  await import("./parser-worker-entry.ts");
  await vi.waitFor(() => expect(parentPort.postMessage).toHaveBeenCalled());

  return parentPort;
}

afterEach(() => {
  vi.doUnmock("node:worker_threads");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("FIT parser worker entrypoint", () => {
  it("posts parsed activity messages", async () => {
    const parentPort = await importWorkerEntry(loadFixture("test.fit"));

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        activity: expect.objectContaining({
          session: expect.objectContaining({ sport: "cycling" }),
          records: expect.any(Array),
        }),
      }),
    );
  });

  it("posts parser error messages", async () => {
    const parentPort = await importWorkerEntry(Buffer.from("not a fit file"));

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: expect.stringMatching(/incorrect header size/i),
        stack: expect.any(String),
      }),
    );
  });

  it.each([
    { label: "plain object", workerData: {} },
    { label: "null", workerData: null },
    { label: "string", workerData: "not binary" },
  ])("posts binary worker data errors for $label", async ({ workerData }) => {
    const parentPort = await importWorkerEntry(workerData);

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        message: "FIT parser worker requires binary worker data",
        stack: expect.any(String),
      }),
    );
  });
});
