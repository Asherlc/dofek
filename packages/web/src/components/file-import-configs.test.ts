import { describe, expect, it, vi } from "vitest";
import { fileImportConfigs, getFileImportConfig } from "./file-import-configs.ts";

describe("file import configs", () => {
  it("marks Apple Health imports as full-history syncs", async () => {
    vi.resetModules();
    const freshConfigs = await import("./file-import-configs.ts");

    expect(freshConfigs.appleHealthFileImportConfig).toEqual({
      title: "Apple Health",
      description: ".zip or .xml from Health app export",
      accept: ".zip,.xml",
      importType: "apple-health",
      fullSync: true,
    });
    expect(freshConfigs.getFileImportConfig("apple_health")).toBe(
      freshConfigs.appleHealthFileImportConfig,
    );
  });

  it("returns only explicitly configured import providers", () => {
    expect(getFileImportConfig("strong-csv")).toBe(fileImportConfigs["strong-csv"]);
    expect(getFileImportConfig("toString")).toBeUndefined();
    expect(getFileImportConfig("unknown")).toBeUndefined();
  });
});
