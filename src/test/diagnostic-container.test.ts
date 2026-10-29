import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";

const { start } = vi.hoisted(() => ({ start: vi.fn() }));
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
    try {
      await new DiagnosticContainer("image").start();
      const events = write.mock.calls.map(([, line]) => JSON.parse(String(line)));
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
    }
  });
  it("preserves the startup error when failure diagnostics cannot be written", async () => {
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
    } finally {
      write.mockRestore();
    }
  });
  it("emits startup before awaiting and rethrows the original error", async () => {
    const error = Object.assign(new Error("secret"), { code: "EPIPE" });
    start.mockRejectedValueOnce(error);
    const write = vi.spyOn(fs, "writeSync").mockImplementation(() => 1);
    try {
      const result = new DiagnosticContainer("image").start();
      expect(JSON.parse(String(write.mock.calls[0]?.[1]))).toMatchObject({
        event: "startup.begin",
      });
      await expect(result).rejects.toBe(error);
      expect(JSON.stringify(write.mock.calls)).not.toContain("secret");
      expect(JSON.parse(String(write.mock.calls.at(-1)?.[1]))).toMatchObject({
        event: "startup.failed",
      });
    } finally {
      write.mockRestore();
    }
  });
});
