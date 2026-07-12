import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedFitActivity } from "./parser.ts";

interface MockParentPort {
  postMessage: ReturnType<typeof vi.fn>;
}

function parsedFitActivityFixture(): ParsedFitActivity {
  return {
    session: {
      sport: "cycling",
      startTime: new Date("2025-01-01T00:00:00.000Z"),
      totalElapsedTime: 1,
      totalTimerTime: 1,
      totalDistance: 1,
      totalCalories: 1,
      raw: {},
    },
    records: [],
    laps: [],
    events: [],
  };
}

async function importWorkerEntry(
  workerData: unknown,
  parseFitFile: ReturnType<typeof vi.fn> = vi.fn(),
): Promise<MockParentPort> {
  vi.resetModules();
  const parentPort: MockParentPort = { postMessage: vi.fn() };
  vi.doMock("node:worker_threads", () => ({ parentPort, workerData }));
  vi.doMock("./parser.ts", () => ({ parseFitFile }));

  await import("./parser-worker-entry.ts");
  await vi.waitFor(() => expect(parentPort.postMessage).toHaveBeenCalled());

  return parentPort;
}

afterEach(() => {
  vi.doUnmock("node:worker_threads");
  vi.doUnmock("./parser.ts");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("FIT parser worker entrypoint", () => {
  it("posts parsed activity messages", async () => {
    const parseFitFile = vi.fn(() => Promise.resolve(parsedFitActivityFixture()));
    const workerData = Buffer.from("fit");

    const parentPort = await importWorkerEntry(workerData, parseFitFile);

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ok",
        activity: expect.objectContaining({
          session: expect.objectContaining({ sport: "cycling" }),
          records: expect.any(Array),
        }),
      }),
    );
    expect(parseFitFile).toHaveBeenCalledWith(workerData);
  });

  it("posts parser error messages", async () => {
    const parseFitFile = vi.fn(() => Promise.reject(new Error("incorrect header size")));

    const parentPort = await importWorkerEntry(Buffer.from("not a fit file"), parseFitFile);

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
