import { describe, expect, it } from "vitest";
import { FIT_FILE_PROVIDER_ID, FitFileProvider } from "./fit-file.ts";

describe("FitFileProvider", () => {
  it("is always available as an import-only provider", () => {
    const provider = new FitFileProvider();

    expect(provider.id).toBe(FIT_FILE_PROVIDER_ID);
    expect(provider.name).toBe("FIT File");
    expect(provider.importOnly).toBe(true);
    expect(provider.validate()).toBeNull();
  });
});
