import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

const { start, capture } = vi.hoisted(() => ({ start: vi.fn(), capture: vi.fn() }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: capture }));
vi.mock("testcontainers", () => ({
  GenericContainer: class {
    start() {
      return start.call(this);
    }
  },
}));

import { DiagnosticContainer } from "./diagnostic-container.ts";

describe("DiagnosticContainer", () => {
  it("emits public lifecycle boundaries in order", async () => {
    start.mockImplementationOnce(async function (this: {
      beforeContainerCreated(): Promise<void>;
      containerCreated(): Promise<void>;
      containerStarting(): Promise<void>;
      containerStarted(): Promise<void>;
    }) {
      await this.beforeContainerCreated();
      await this.containerCreated();
      await this.containerStarting();
      await this.containerStarted();
      return {};
    });
    const write = vi.spyOn(fs, "writeSync").mockImplementation(() => 1);
    const now = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(110)
      .mockReturnValueOnce(90)
      .mockReturnValue(125);
    try {
      await new DiagnosticContainer("image").start();
      const events = write.mock.calls.map(([, line]) => JSON.parse(String(line)));
      expect(events.map((event) => event.elapsedMs)).toEqual([10, 0, 25, 25, 25]);
      expect(events.map((event) => event.operationId)).toEqual(
        Array(5).fill(events[0].operationId),
      );
      expect(events.map((event) => event.event)).toEqual([
        "startup.begin",
        "startup.image_ready",
        "startup.created",
        "startup.start_inspect_complete",
        "startup.ready",
      ]);
    } finally {
      write.mockRestore();
      now.mockRestore();
    }
  });
  it("preserves the startup error when failure diagnostics cannot be written", async () => {
    capture.mockClear();
    const error = new Error("startup secret");
    start.mockRejectedValueOnce(error);
    const write = vi
      .spyOn(fs, "writeSync")
      .mockImplementationOnce(() => 1)
      .mockImplementationOnce(() => {
        throw new Error("private path");
      });
    try {
      await expect(new DiagnosticContainer("image").start()).rejects.toBe(error);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0]?.[0]).toEqual(
        new Error("Test container startup diagnostics failed"),
      );
      expect(JSON.stringify(capture.mock.calls)).not.toMatch(/private path|startup secret/);
    } finally {
      write.mockRestore();
    }
  });
  it("emits startup before awaiting and rethrows the original error", async () => {
    capture.mockClear();
    const error = Object.assign(new Error("secret"), { code: "EPIPE", syscall: "write" });
    start.mockRejectedValueOnce(error);
    const write = vi.spyOn(fs, "writeSync").mockImplementation(() => 1);
    try {
      const result = new DiagnosticContainer("image").start();
      expect(JSON.parse(String(write.mock.calls[0]?.[1]))).toMatchObject({
        event: "startup.begin",
      });
      await expect(result).rejects.toBe(error);
      expect(JSON.stringify(write.mock.calls)).not.toContain("secret");
      const failure = JSON.parse(String(write.mock.calls.at(-1)?.[1]));
      expect(failure).toMatchObject({
        event: "startup.failed",
        lastStage: "startup.begin",
        diagnostic: {
          errors: [{ name: "Error", code: "EPIPE", syscall: "write", aborted: false }],
          truncated: false,
        },
      });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0]?.[0]).toEqual(new Error("Test container startup failed"));
      expect(capture.mock.calls[0]?.[1]).toEqual({ extra: { diagnostic: failure.diagnostic } });
      expect(JSON.stringify(capture.mock.calls)).not.toContain("secret");
    } finally {
      write.mockRestore();
    }
  });
});
