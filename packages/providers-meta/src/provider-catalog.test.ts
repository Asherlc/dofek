import { describe, expect, it } from "vitest";
import { groupProviderEntries, providerFamily } from "./provider-catalog.ts";

describe("providerFamily", () => {
  it("groups Garmin connection methods under one user-facing provider", () => {
    expect(providerFamily("garmin")).toEqual({
      id: "garmin",
      label: "Garmin",
      methodLabel: "Garmin Connect",
    });
    expect(providerFamily("garmin-dump")).toEqual({
      id: "garmin",
      label: "Garmin",
      methodLabel: "Data export",
    });
  });

  it("does not group providers without an explicit family", () => {
    expect(providerFamily("fit-file")).toBeNull();
  });
});

describe("groupProviderEntries", () => {
  it("creates one Garmin family and leaves a single Kaya method alone", () => {
    expect(
      groupProviderEntries([
        { id: "garmin" },
        { id: "wahoo" },
        { id: "garmin-dump" },
        { id: "kaya-export" },
      ]),
    ).toEqual([
      {
        kind: "family",
        family: { id: "garmin", label: "Garmin" },
        providers: [{ id: "garmin" }, { id: "garmin-dump" }],
      },
      { kind: "provider", provider: { id: "wahoo" } },
      { kind: "provider", provider: { id: "kaya-export" } },
    ]);
  });
});
