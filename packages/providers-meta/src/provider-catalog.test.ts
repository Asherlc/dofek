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

  it("groups WHOOP, Zepp, and Kaya connection methods under their user-facing providers", () => {
    expect(providerFamily("whoop")).toEqual({
      id: "whoop",
      label: "WHOOP",
      methodLabel: "Cloud",
    });
    expect(providerFamily("whoop_ble")).toEqual({
      id: "whoop",
      label: "WHOOP",
      methodLabel: "Bluetooth",
    });
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
        family: { id: "kaya", label: "Kaya" },
        providers: [{ id: "kaya" }, { id: "kaya-export" }],
      },
      {
        kind: "family",
        family: { id: "zepp", label: "Zepp" },
        providers: [{ id: "amazfit-zepp" }, { id: "zos-app" }],
      },
    ]);
  });
});

describe("groupProviderEntries", () => {
  it("sorts cards by display label, including family labels, without changing the input", () => {
    const providers = [
      { id: "amazfit-zepp" },
      { id: "wahoo" },
      { id: "zos-app" },
      { id: "fatsecret" },
      { id: "apple_health" },
      { id: "eight-a" },
      { id: "custom", label: "Body tracker" },
    ];
    const original = [...providers];
    expect(
      groupProviderEntries(providers).map((group) =>
        group.kind === "family" ? group.family.id : group.provider.id,
      ),
    ).toEqual(["eight-a", "apple_health", "custom", "fatsecret", "wahoo", "zepp"]);
    expect(providers).toEqual(original);
  });

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
      { kind: "provider", provider: { id: "kaya-export" } },
      { kind: "provider", provider: { id: "wahoo" } },
    ]);
  });
});
