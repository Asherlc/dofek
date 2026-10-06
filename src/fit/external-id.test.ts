import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fitExternalIdFromFile } from "./external-id.ts";

describe("fitExternalIdFromFile", () => {
  it("extracts Garmin activity IDs from FIT filenames", async () => {
    await expect(
      fitExternalIdFromFile(
        "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345_extra.fit",
        "unused.fit",
      ),
    ).resolves.toBe("12345");
  });

  it("preserves date-shaped digit extraction for Garmin weight FIT filenames", async () => {
    await expect(
      fitExternalIdFromFile(
        "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_20260701_weight.fit",
        "unused.fit",
      ),
    ).resolves.toBe("20260701");
  });

  it("streams file bytes for the stable SHA-256 fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fit-external-id-test-"));
    const filePath = join(directory, "activity.fit");
    try {
      await writeFile(filePath, Buffer.from("fit-bytes"));

      await expect(fitExternalIdFromFile("DI_CONNECT/activity.fit", filePath)).resolves.toBe(
        "fit:627aad277920421ac258595b83c27b69",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
