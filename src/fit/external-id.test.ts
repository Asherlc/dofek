import { describe, expect, it } from "vitest";
import { fitExternalId } from "./external-id.ts";

describe("fitExternalId", () => {
  it("extracts Garmin activity IDs from FIT filenames", () => {
    expect(
      fitExternalId(
        "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345_extra.fit",
        Buffer.from("fit-bytes"),
      ),
    ).toBe("12345");
  });

  it("uses a stable SHA-256 fallback when the filename has no activity ID", () => {
    expect(fitExternalId("DI_CONNECT/activity.fit", Buffer.from("fit-bytes"))).toBe(
      "fit:627aad277920421ac258595b83c27b69",
    );
  });
});
