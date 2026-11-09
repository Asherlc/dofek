import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.ts";
import { listAccountErasurePostgresIdentifierPages } from "./postgres-identifier-capture.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const id = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

describe("listAccountErasurePostgresIdentifierPages", () => {
  it("keeps full-page continuation and each identifier family separate", async () => {
    const full = Array.from({ length: 500 }, (_, index) => ({ id: id(index) }));
    const execute = vi
      .fn<Database["execute"]>()
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: id(500) }])
      .mockResolvedValueOnce([{ id: id(0) }])
      .mockResolvedValueOnce([{ id: id(0) }]);
    const pages = await Array.fromAsync(
      listAccountErasurePostgresIdentifierPages({ execute }, userId),
    );
    expect(pages).toEqual([
      { family: "activity", identifiers: full.map((row) => row.id) },
      { family: "activity", identifiers: [id(500)] },
      { family: "sleep", identifiers: [id(0)] },
      { family: "operation", identifiers: [id(0)] },
    ]);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("finishes empty families without yielding empty encryption pages", async () => {
    const execute = vi.fn<Database["execute"]>().mockResolvedValue([]);
    expect(
      await Array.fromAsync(listAccountErasurePostgresIdentifierPages({ execute }, userId)),
    ).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("finishes an exact full page only after checking its empty continuation", async () => {
    const full = Array.from({ length: 500 }, (_, index) => ({ id: id(index) }));
    const execute = vi.fn<Database["execute"]>().mockResolvedValue([]).mockResolvedValueOnce(full);
    expect(
      await Array.fromAsync(listAccountErasurePostgresIdentifierPages({ execute }, userId)),
    ).toEqual([{ family: "activity", identifiers: full.map((row) => row.id) }]);
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
