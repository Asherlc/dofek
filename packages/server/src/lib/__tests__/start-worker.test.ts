import { afterEach, describe, expect, it, vi } from "vitest";

const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Import after mock
const { startWorker } = await import("../start-worker.ts");

function getCallback(): (err: Error | null, stdout: string, stderr: string) => void {
  const call = mockExecFile.mock.calls[0];
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

  it("suppresses 'No such container' errors silently", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    startWorker();
    getCallback()(new Error("failed"), "", "No such container: dofek-worker");

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("suppresses 'is already started' errors silently", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    startWorker();
    getCallback()(new Error("failed"), "", "container is already started");

    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("logs other errors to console.error", () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    startWorker();
    getCallback()(new Error("permission denied"), "", "permission denied");

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("permission denied"));
    consoleErrorSpy.mockRestore();
  });
});
