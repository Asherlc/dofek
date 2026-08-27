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

  it("groups Zepp and Kaya connection methods under their user-facing providers", () => {
    expect(providerFamily("amazfit-zepp")).toEqual({
      id: "zepp",
      label: "Zepp",
      methodLabel: "Zepp cloud",
    });
    expect(providerFamily("zos-app")).toEqual({
      id: "zepp",
      label: "Zepp",
      methodLabel: "Zepp app (Zepp OS)",
    });
    expect(providerFamily("kaya")).toEqual({ id: "kaya", label: "Kaya", methodLabel: "Web" });
    expect(providerFamily("kaya-export")).toEqual({
      id: "kaya",
      label: "Kaya",
      methodLabel: "Data export (CSV file)",
    });
  });

  it("does not group providers without an explicit family", () => {
    expect(providerFamily("fit-file")).toBeNull();
  });

  it("creates Zepp and Kaya families when both connection methods are available", () => {
    expect(
      groupProviderEntries([
        { id: "amazfit-zepp" },
        { id: "zos-app" },
        { id: "kaya" },
        { id: "kaya-export" },
      ]),
    ).toEqual([
      {
        kind: "family",
        family: { id: "zepp", label: "Zepp" },
        providers: [{ id: "amazfit-zepp" }, { id: "zos-app" }],
      },
      {
        kind: "family",
        family: { id: "kaya", label: "Kaya" },
        providers: [{ id: "kaya" }, { id: "kaya-export" }],
      },
    ]);
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
