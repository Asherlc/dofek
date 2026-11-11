import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  type LogRecordExporter,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { describe, expect, it, vi } from "vitest";
import { AxiomLogExporter } from "./axiom-log-exporter.ts";

describe("AxiomLogExporter", () => {
  it.each([
    { attributes: { provider: "garmin", count: 4 }, expected: { provider: "garmin", count: 4 } },
    {
      attributes: { custom: { provider: "garmin", count: 4 } },
      expected: { provider: "garmin", count: 4 },
    },
    {
      attributes: { custom: { provider: "garmin" }, count: 4 },
      expected: { provider: "garmin", count: 4 },
    },
    {
      attributes: { custom: { provider: "garmin" }, provider: "outer-value" },
      expected: { provider: "garmin" },
    },
    { attributes: { custom: "recorded-value" }, expected: { custom: "recorded-value" } },
    { attributes: { custom: null }, expected: { custom: null } },
    {
      attributes: { custom: new Uint8Array([1, 2]) },
      expected: { custom: new Uint8Array([1, 2]) },
    },
    { attributes: {}, expected: {} },
  ])(
    "keeps one map across repeated export mapping: $attributes",
    async ({ attributes, expected }) => {
      const destination = new InMemoryLogRecordExporter();
      const provider = new LoggerProvider({
        processors: [
          new SimpleLogRecordProcessor({
            exporter: new AxiomLogExporter(new AxiomLogExporter(destination)),
          }),
        ],
      });
      const originalAttributes = structuredClone(attributes);
      provider.getLogger("mapping-test").emit({ body: "Recorded event", attributes });
      await provider.forceFlush();

      expect(destination.getFinishedLogRecords()[0]?.attributes).toEqual({ custom: expected });
      expect(destination.getFinishedLogRecords()[0]?.body).toBe("Recorded event");
      expect(attributes).toEqual(originalAttributes);
      await provider.shutdown();
    },
  );

  it("forwards exporter completion, flush, and shutdown", async () => {
    const error = new Error("export rejected");
    const destination: LogRecordExporter = {
      export: vi.fn((_records, callback) => callback({ code: 1, error })),
      forceFlush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const exporter = new AxiomLogExporter(destination);
    const callback = vi.fn();

    exporter.export([], callback);
    await exporter.forceFlush();
    await exporter.shutdown();

    expect(callback).toHaveBeenCalledWith({ code: 1, error });
    expect(destination.forceFlush).toHaveBeenCalledOnce();
    expect(destination.shutdown).toHaveBeenCalledOnce();
  });
});
