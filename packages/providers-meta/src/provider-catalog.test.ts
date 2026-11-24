import { describe, expect, it } from "vitest";
import {
  groupProviderEntries,
  PROVIDER_DATA_SOURCE_TABS,
  providerCatalogEntry,
  providerFamily,
  providerGroupMatchesCategory,
} from "./provider-catalog.ts";

describe("BoardSesh catalog metadata", () => {
  it("uses the email credential form", () => {
    expect(providerCatalogEntry("boardsesh")).toMatchObject({
      label: "BoardSesh",
      credentialIdentifier: "email",
    });
  });
});

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

  it("filters by category after grouping, defaults to All, and keeps unknown IDs only there", () => {
    const providers = [
      { id: "brand-new-source" },
      { id: "concept2" },
      { id: "fatsecret" },
      { id: "strava" },
    ];
    expect(
      groupProviderEntries(providers).map((group) =>
        group.kind === "provider" ? group.provider.id : group.family.id,
      ),
    ).toEqual(["brand-new-source", "concept2", "fatsecret", "strava"]);
    expect(
      groupProviderEntries(providers, "rowing").map(
        (group) => group.kind === "provider" && group.provider.id,
      ),
    ).toEqual(["concept2", "strava"]);
    expect(
      groupProviderEntries(providers, "cycling").map(
        (group) => group.kind === "provider" && group.provider.id,
      ),
    ).toEqual(["concept2", "strava"]);
    expect(
      groupProviderEntries(providers, "running").map(
        (group) => group.kind === "provider" && group.provider.id,
      ),
    ).toEqual(["strava"]);
    expect(groupProviderEntries(providers, "nutrition")).toEqual([
      { kind: "provider", provider: { id: "fatsecret" } },
    ]);
    expect(
      groupProviderEntries([{ id: "brand-new-source" }, { id: "concept2" }], "nutrition"),
    ).toEqual([]);
  });

  it("keeps every available family method when only one member matches", () => {
    // Garmin Dump imports weight FIT body composition; Connect does not.
    expect(
      groupProviderEntries(
        [{ id: "garmin" }, { id: "garmin-dump" }, { id: "ziva" }],
        "body_composition",
      ),
    ).toEqual([
      {
        kind: "family",
        family: { id: "garmin", label: "Garmin" },
        providers: [{ id: "garmin" }, { id: "garmin-dump" }],
      },
    ]);
  });

  it("shows Trailforks under its supported activity filters", () => {
    const providers = [{ id: "trailforks" }];
    const matchingTabs = PROVIDER_DATA_SOURCE_TABS.filter(
      ({ id }) => groupProviderEntries(providers, id).length > 0,
    );
    expect(matchingTabs.map(({ id }) => id)).toEqual(["all", "cycling", "running", "hiking"]);
  });

  it("covers checked-in multi-tab specialists and legacy aliases via groupProviderEntries", () => {
    expect(
      groupProviderEntries(
        [
          { id: "zwift" },
          { id: "crimpd" },
          { id: "intervals.icu" },
          { id: "apple_health" },
          { id: "apple-health" },
          { id: "cycling_analytics" },
          { id: "cycling-analytics" },
          { id: "strong-csv" },
          { id: "cronometer-csv" },
          { id: "whoop_ble" },
        ],
        "running",
      ).map((group) => (group.kind === "provider" ? group.provider.id : group.family.id)),
    ).toEqual(["apple_health", "apple-health", "intervals.icu", "zwift"]);
    expect(
      groupProviderEntries([{ id: "crimpd" }, { id: "zwift" }], "strength").map(
        (group) => group.kind === "provider" && group.provider.id,
      ),
    ).toEqual(["crimpd"]);
    expect(
      groupProviderEntries([{ id: "intervals.icu" }, { id: "zwift" }], "sleep_recovery").map(
        (group) => group.kind === "provider" && group.provider.id,
      ),
    ).toEqual(["intervals.icu"]);
    expect(
      groupProviderEntries(
        [{ id: "cycling_analytics" }, { id: "cycling-analytics" }, { id: "strong-csv" }],
        "cycling",
      ).map((group) => group.kind === "provider" && group.provider.id),
    ).toEqual(["cycling_analytics", "cycling-analytics"]);
    expect(
      groupProviderEntries(
        [{ id: "cronometer-csv" }, { id: "whoop_ble" }, { id: "strong-csv" }],
        "nutrition",
      ),
    ).toEqual([{ kind: "provider", provider: { id: "cronometer-csv" } }]);
    expect(
      providerGroupMatchesCategory(
        { kind: "provider", provider: { id: "fit-file" } },
        "body_composition",
      ),
    ).toBe(true);
  });

  it("exposes the approved static tab labels in order", () => {
    expect(PROVIDER_DATA_SOURCE_TABS.map((tab) => tab.label)).toEqual([
      "All",
      "Cycling",
      "Running",
      "Hiking",
      "Climbing",
      "Strength",
      "Rowing",
      "Sleep & Recovery",
      "Nutrition",
      "Body Composition",
    ]);
  });
});
