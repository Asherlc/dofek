import { afterEach, describe, expect, it, vi } from "vitest";

const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Import after mock
const { startWorker } = await import("./start-worker.ts");

function getCallback(callIndex = 0): (err: Error | null, stdout: string, stderr: string) => void {
  const call = mockExecFile.mock.calls[callIndex];
  if (!call) throw new Error("execFile was not called");
  return call[2];
}

describe("startWorker", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls docker start dofek-worker", () => {
    startWorker();

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["start", "dofek-worker"],
      expect.any(Function),
    );
  });

  it("resolves only after docker confirms the worker started", async () => {
    const startPromise = startWorker();
    let resolved = false;
    void startPromise.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    getCallback()(null, "dofek-worker", "");

    await expect(startPromise).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("rejects when the worker container does not exist", async () => {
    const startPromise = startWorker();
    getCallback()(new Error("failed"), "", "No such container: dofek-worker");

    await expect(startPromise).rejects.toThrow("No such container: dofek-worker");
  });

  it("resolves when the worker container is already started", async () => {
    const startPromise = startWorker();
    getCallback()(new Error("failed"), "", "container is already started");

    await expect(startPromise).resolves.toBeUndefined();
  });

  it("rejects other docker errors", async () => {
    const startPromise = startWorker();
    getCallback()(new Error("permission denied"), "", "permission denied");

    await expect(startPromise).rejects.toThrow("permission denied");
  });

  it("falls back to err.message when stderr is empty", async () => {
    const startPromise = startWorker();
    getCallback()(new Error("connection refused"), "", "");

    await expect(startPromise).rejects.toThrow("connection refused");
  });

  it("prefers stderr over err.message", async () => {
    const startPromise = startWorker();
    getCallback()(new Error("generic error"), "", "specific stderr output");

    await expect(startPromise).rejects.toThrow("specific stderr output");
  });

  it("resolves when no error occurs", async () => {
    const startPromise = startWorker();
    getCallback()(null, "started", "");

    await expect(startPromise).resolves.toBeUndefined();
  });
});
