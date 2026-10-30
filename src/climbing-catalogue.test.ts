import type { CatalogueCandidate, CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClimbingCatalogueService } from "./climbing-catalogue.ts";
import { MemoryCacheStore } from "./lib/cache.ts";
import { captureException } from "./lib/error-reporting.ts";

vi.mock("./lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

const seed: CatalogueSeed = {
  userId: "user-a",
  logEntryId: "log-a",
  providerId: "kaya",
  externalId: "kaya-climb",
  sourceUrl: null,
  name: "Cragmont Crack",
  kind: "route",
  setting: "outdoor",
  locations: [
    {
      externalId: "area",
      name: "Cragmont Park",
      scope: "area",
      coordinates: { latitude: 37.8921, longitude: -122.2637 },
    },
  ],
};
const candidate: CatalogueCandidate = {
  providerId: "thecrag",
  externalId: "18589309",
  name: "Cragmont Crack",
  url: "https://www.thecrag.com/route/18589309",
  kind: "route",
  setting: "outdoor",
  locations: [
    {
      externalId: "park",
      name: "Cragmont Park",
      scope: "area",
      coordinates: { latitude: 37.8921, longitude: -122.2637 },
    },
  ],
  grade: "5.6",
  angle: null,
  tags: [
    {
      kind: "steepness",
      sourceKey: "Ramp",
      label: "Slab",
      category: "slab",
      scope: "inherited",
      inheritedFrom: "Cragmont Park",
    },
  ],
};

describe("ClimbingCatalogueService", () => {
  it.each([
    { reference: false, candidateGeography: true },
    { reference: true, candidateGeography: true },
    { reference: true, candidateGeography: false },
  ])(
    "preserves logged/native geography conflicts while using native context for discovery: %j",
    async ({ reference, candidateGeography }) => {
      const nativeLocations = [
        {
          externalId: "chew-tooth",
          name: "Chew Tooth",
          scope: "area" as const,
          coordinates: { latitude: 37.24, longitude: -122.096 },
        },
      ];
      const native = {
        ...candidate,
        name: "Current Name",
        locations: nativeLocations,
        ...(reference
          ? { references: [{ providerId: "openbeta" as const, externalId: "linked" }] }
          : {}),
      };
      const linked = {
        ...candidate,
        name: "Current Name",
        providerId: "openbeta" as const,
        externalId: "linked",
        url: "https://openbeta.io/climb/linked",
        locations: candidateGeography ? nativeLocations : [],
      };
      const service = new ClimbingCatalogueService(new MemoryCacheStore(), [
        { providerId: "thecrag", search: async () => ({ candidates: [native], complete: true }) },
        {
          providerId: "openbeta",
          search: async (discovery) => {
            expect(discovery.locations).toEqual(nativeLocations);
            return { candidates: [linked], complete: true };
          },
        },
      ]);
      const result = await service.refresh({
        ...seed,
        providerId: "thecrag",
        externalId: candidate.externalId,
      });
      expect(result.sources[0]?.matches[0]).toMatchObject({
        confidence: "source",
        evidence: expect.arrayContaining([
          expect.stringMatching(/conflict.*Cragmont Park.*Chew Tooth/i),
        ]),
      });
      expect(result.sources[1]?.matches[0]).toMatchObject({
        confidence: "possible",
        evidence: expect.arrayContaining([
          expect.stringMatching(/conflict.*Cragmont Park.*Chew Tooth/i),
        ]),
      });
    },
  );
  it.each(["no area", "no area coordinates"])(
    "supplements missing logged geography from native context: %s",
    async (missing) => {
      const linked = {
        ...candidate,
        providerId: "openbeta" as const,
        externalId: "linked",
        url: "https://openbeta.io/climb/linked",
      };
      const service = new ClimbingCatalogueService(new MemoryCacheStore(), [
        {
          providerId: "thecrag",
          search: async () => ({ candidates: [candidate], complete: true }),
        },
        { providerId: "openbeta", search: async () => ({ candidates: [linked], complete: true }) },
      ]);
      const result = await service.refresh({
        ...seed,
        providerId: "thecrag",
        externalId: candidate.externalId,
        locations:
          missing === "no area"
            ? []
            : seed.locations.map((location) => ({ ...location, coordinates: null })),
      });
      expect(result.sources[0]?.matches[0]?.confidence).toBe("source");
      expect(result.sources[1]?.matches[0]).toMatchObject({
        confidence: "corroborated",
        evidence: expect.arrayContaining([expect.stringMatching(/Cragmont Park/)]),
      });
    },
  );
  it("uses the same final native observation for discovery and returned source context", async () => {
    const observed: string[] = [];
    const service = new ClimbingCatalogueService(new MemoryCacheStore(), [
      {
        providerId: "thecrag",
        search: async () => ({
          candidates: [candidate, { ...candidate, name: "Current Name" }],
          complete: true,
        }),
      },
      {
        providerId: "openbeta",
        search: async (enriched) => {
          observed.push(enriched.name);
          return { candidates: [], complete: true };
        },
      },
    ]);
    const result = await service.refresh({
      ...seed,
      providerId: "thecrag",
      externalId: candidate.externalId,
    });
    expect(observed).toEqual(["Current Name"]);
    expect(result.sources[0]?.matches[0]?.candidate.name).toBe("Current Name");
  });
  it("discovers native source context first and keeps enrichment out of the cache fingerprint", async () => {
    const cache = new MemoryCacheStore();
    const original = { ...seed, providerId: "thecrag", externalId: candidate.externalId };
    const linked = {
      ...candidate,
      providerId: "openbeta" as const,
      externalId: "linked",
      url: "https://openbeta.io/climb/linked",
      name: "Corner Route",
    };
    const native = {
      ...candidate,
      name: "Current Name",
      aliases: [seed.name],
      references: [{ providerId: "openbeta" as const, externalId: "linked" }],
    };
    const discovery = vi.fn(async (enriched: CatalogueSeed) => {
      expect(enriched).toMatchObject({
        name: "Current Name",
        references: native.references,
        aliases: expect.arrayContaining([seed.name]),
      });
      return { candidates: [linked], complete: true, searchArea: candidate.locations[0] };
    });
    const service = new ClimbingCatalogueService(cache, [
      { providerId: "openbeta", search: discovery },
      { providerId: "thecrag", search: async () => ({ candidates: [native], complete: true }) },
    ]);
    const result = await service.refresh(original);
    expect(result.sources[0]).toMatchObject({
      searchArea: candidate.locations[0],
      matches: [{ confidence: "reference", evidence: expect.any(Array) }],
    });
    expect(result.sources[1]?.matches[0]?.confidence).toBe("source");
    expect(await service.read(original)).toEqual(result);
    expect((await service.read({ ...original, name: "Current Name" })).status).toBe("missing");
    expect(original.name).toBe("Cragmont Crack");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  const setup = (results = [candidate], complete = true) => {
    const search = vi.fn().mockResolvedValue({ candidates: results, complete });
    const cache = new MemoryCacheStore();
    const service = new ClimbingCatalogueService(cache, [{ providerId: "thecrag", search }]);
    return { service, search, cache };
  };

  it("reads a missing cache without making an upstream request", async () => {
    const { service, search } = setup();
    expect(await service.read(seed)).toEqual({
      status: "missing",
      fetchedAt: null,
      expiresAt: null,
      error: null,
      sources: [],
    });
    expect(search).not.toHaveBeenCalled();
  });
  it("reports a rejected refresh request without leaving the cache pending", async () => {
    const { service } = setup();
    await service.markFailed(seed, new Error("Catalogue refresh could not be queued."));
    expect((await service.read(seed)).status).toBe("error");
    expect((await service.read(seed)).error).toBe("Catalogue refresh could not be queued.");
  });
  it("discards an obsolete source fingerprint after an in-flight refresh", async () => {
    const { service } = setup();
    await service.refresh(seed);
    await service.invalidate(seed);
    expect((await service.read(seed)).status).toBe("missing");
  });
  it("corroborates a unique complete name/kind/location match and preserves all source facts", async () => {
    const { service } = setup();
    const result = await service.refresh(seed);
    expect(result.sources[0]?.matches).toEqual([
      { confidence: "corroborated", candidate, evidence: expect.any(Array) },
    ]);
    expect(result.expiresAt).toBe("2026-11-03T12:00:00.000Z");
    expect(await service.read(seed)).toEqual(result);
  });
  it("retains the exact recorded source identity when its catalogue name changes", async () => {
    const renamed = { ...candidate, name: "Renamed Crack" };
    const { service } = setup([renamed]);
    const result = await service.refresh({
      ...seed,
      providerId: "thecrag",
      externalId: candidate.externalId,
    });
    expect(result.sources[0]?.matches).toEqual([
      { confidence: "source", candidate: renamed, evidence: expect.any(Array) },
    ]);
  });
  it.each([false, true])(
    "does not establish identity from incomplete results or conflicting locations: complete=%s",
    async (complete) => {
      const distant = {
        ...candidate,
        locations: [
          {
            externalId: "other",
            name: "Cragmont Park",
            scope: "area" as const,
            coordinates: { latitude: 10, longitude: 10 },
          },
        ],
      };
      const { service } = setup([complete ? distant : candidate], complete);
      expect((await service.refresh(seed)).sources[0]?.matches[0]?.confidence).toBe("possible");
    },
  );
  it("keeps duplicate candidates and indoor resets as possible matches", async () => {
    const { service } = setup([candidate, { ...candidate, externalId: "duplicate" }]);
    expect(
      (await service.refresh(seed)).sources[0]?.matches.map((match) => match.confidence),
    ).toEqual(["possible", "possible"]);
    const indoor = setup([{ ...candidate, setting: "indoor" }]);
    expect(
      (await indoor.service.refresh({ ...seed, setting: "indoor" })).sources[0]?.matches[0]
        ?.confidence,
    ).toBe("possible");
  });
  it("isolates users and invalidates changed matching input", async () => {
    const { service } = setup();
    await service.refresh(seed);
    expect((await service.read({ ...seed, userId: "user-b" })).status).toBe("missing");
    expect((await service.read({ ...seed, name: "Another climb" })).status).toBe("missing");
  });
  it("expires positives after seven days and verified negatives after one day", async () => {
    const { service } = setup();
    await service.refresh(seed);
    vi.advanceTimersByTime(7 * 86400000);
    expect((await service.read(seed)).status).toBe("missing");
    const negative = setup([]);
    expect((await negative.service.refresh(seed)).expiresAt).toBe("2026-11-04T12:00:00.000Z");
    vi.advanceTimersByTime(86400000);
    expect((await negative.service.read(seed)).status).toBe("missing");
  });
  it("replaces tags on successful refresh and retains unexpired context after failure", async () => {
    const { service, search } = setup();
    await service.refresh(seed);
    search.mockResolvedValueOnce({ candidates: [{ ...candidate, tags: [] }], complete: true });
    expect((await service.refresh(seed)).sources[0]?.matches[0]?.candidate.tags).toEqual([]);
    search.mockRejectedValueOnce(
      new Error("theCrag catalogue request failed (403). Try again later."),
    );
    await expect(service.refresh(seed)).rejects.toThrow("403");
    const retained = await service.read(seed);
    expect(retained.status).toBe("error");
    expect(retained.error).toContain("403");
    expect(retained.sources[0]?.matches[0]?.candidate.tags).toEqual([]);
  });

  it("matches names and locations ignoring case and surrounding or repeated whitespace", async () => {
    const { service } = setup([
      {
        ...candidate,
        name: "CRAGMONT\t  CRACK",
        locations: candidate.locations.map((location) => ({
          ...location,
          name: "  CRAGMONT\t  PARK  ",
        })),
      },
    ]);
    expect((await service.refresh(seed)).sources[0]?.matches[0]?.confidence).toBe("corroborated");
  });

  it.each([
    ["Another Route", "Cragmont Crack"],
    ["Masse", "Maße"],
  ])("does not match distinct catalogue names %s and %s", async (name, recordedName) => {
    const { service } = setup([{ ...candidate, name }]);
    expect((await service.refresh({ ...seed, name: recordedName })).sources[0]?.matches).toEqual(
      [],
    );
  });

  it.each([
    { seedSetting: "indoor", candidateSetting: "outdoor", confidence: "possible" },
    { seedSetting: "outdoor", candidateSetting: "indoor", confidence: "possible" },
    { seedSetting: null, candidateSetting: "outdoor", confidence: "corroborated" },
    { seedSetting: "outdoor", candidateSetting: null, confidence: "corroborated" },
  ] as const)(
    "distinguishes unknown from incompatible setting $seedSetting against $candidateSetting",
    async ({ seedSetting, candidateSetting, confidence }) => {
      const { service } = setup([{ ...candidate, setting: candidateSetting }]);
      expect(
        (await service.refresh({ ...seed, setting: seedSetting })).sources[0]?.matches[0]
          ?.confidence,
      ).toBe(confidence);
    },
  );

  it.each([
    { recordedKind: "route", catalogueKind: "boulder" },
    { recordedKind: "route", catalogueKind: null },
    { recordedKind: null, catalogueKind: null },
    { recordedKind: null, catalogueKind: "route" },
  ] as const)(
    "requires known matching kinds: $recordedKind against $catalogueKind",
    async ({ recordedKind, catalogueKind }) => {
      const { service } = setup([{ ...candidate, kind: catalogueKind }]);
      expect(
        (await service.refresh({ ...seed, kind: recordedKind })).sources[0]?.matches[0]?.confidence,
      ).toBe("possible");
    },
  );

  it.each([
    { name: "different area", location: { name: "Another Park" } },
    { name: "different scope", location: { scope: "climb" } },
    { name: "missing coordinates", location: { coordinates: null } },
  ] as const)("requires location evidence with $name", async ({ location }) => {
    const { service } = setup([
      {
        ...candidate,
        locations: candidate.locations.map((original) => ({ ...original, ...location })),
      },
    ]);
    expect((await service.refresh(seed)).sources[0]?.matches[0]?.confidence).toBe("possible");
  });

  it("does not corroborate when the recorded location has no coordinates", async () => {
    const { service } = setup();
    const result = await service.refresh({
      ...seed,
      locations: seed.locations.map((location) => ({ ...location, coordinates: null })),
    });
    expect(result.sources[0]?.matches[0]?.confidence).toBe("possible");
  });

  it("uses any corroborating area in either ancestry without requiring every ancestor to match", async () => {
    const unrelated = {
      externalId: "unrelated",
      name: "World",
      scope: "area" as const,
      coordinates: null,
    };
    const { service } = setup([{ ...candidate, locations: [unrelated, ...candidate.locations] }]);
    const result = await service.refresh({ ...seed, locations: [unrelated, ...seed.locations] });
    expect(result.sources[0]?.matches[0]?.confidence).toBe("corroborated");
  });

  it.each(["recorded", "catalogue"])("does not corroborate missing %s locations", async (side) => {
    const { service } = setup([
      { ...candidate, locations: side === "catalogue" ? [] : candidate.locations },
    ]);
    const result = await service.refresh({
      ...seed,
      locations: side === "recorded" ? [] : seed.locations,
    });
    expect(result.sources[0]?.matches[0]?.confidence).toBe("possible");
  });

  it.each([
    { latitude: 0.000899, longitude: 0, confidence: "corroborated" },
    { latitude: -0.000899, longitude: 0, confidence: "corroborated" },
    { latitude: 0, longitude: 0.000899, confidence: "corroborated" },
    { latitude: 0, longitude: -0.000899, confidence: "corroborated" },
    { latitude: 0.0009, longitude: 0, confidence: "possible" },
    { latitude: -0.0009, longitude: 0, confidence: "possible" },
    { latitude: 0, longitude: 0.0009, confidence: "possible" },
    { latitude: 0, longitude: -0.0009, confidence: "possible" },
  ])(
    "checks each coordinate boundary: $latitude, $longitude",
    async ({ latitude, longitude, confidence }) => {
      const { service } = setup([
        {
          ...candidate,
          locations: candidate.locations.map((location) => ({
            ...location,
            coordinates: { latitude, longitude },
          })),
        },
      ]);
      const result = await service.refresh({
        ...seed,
        locations: seed.locations.map((location) => ({
          ...location,
          coordinates: { latitude: 0, longitude: 0 },
        })),
      });
      expect(result.sources[0]?.matches[0]?.confidence).toBe(confidence);
    },
  );

  it.each([
    { providerId: "thecrag", externalId: "another-id", confidence: "possible" },
    { providerId: "kaya", externalId: candidate.externalId, confidence: "corroborated" },
  ])(
    "does not treat a partial source identity as recorded: $providerId/$externalId",
    async ({ providerId, externalId, confidence }) => {
      const identity = { providerId, externalId };
      const { service } = setup();
      const result = await service.refresh({ ...seed, ...identity });
      expect(result.sources[0]?.matches[0]?.confidence).toBe(confidence);
      const renamed = setup([{ ...candidate, name: "An unrelated name" }]);
      const renamedMatches = (await renamed.service.refresh({ ...seed, ...identity })).sources[0]
        ?.matches;
      if (confidence === "possible")
        expect(renamedMatches).toMatchObject([
          {
            confidence: "possible",
            evidence: expect.arrayContaining([expect.stringMatching(/conflict.*id/i)]),
          },
        ]);
      else expect(renamedMatches).toEqual([]);
    },
  );

  it("deduplicates repeated source IDs without turning them into ambiguous matches", async () => {
    const { service } = setup([candidate, { ...candidate, grade: "5.7" }]);
    expect((await service.refresh(seed)).sources[0]?.matches).toEqual([
      {
        confidence: "corroborated",
        candidate: { ...candidate, grade: "5.7" },
        evidence: expect.any(Array),
      },
    ]);
  });

  it("rejects mixed-provider adapter results and reports the failure", async () => {
    const { service, search } = setup();
    search.mockResolvedValue({
      candidates: [
        candidate,
        { ...candidate, providerId: "kaya", url: "https://kaya-app.kayaclimb.com/climb/123" },
      ],
      complete: true,
    });
    await expect(service.refresh(seed)).rejects.toThrow(
      "Unexpected provider in thecrag catalogue response.",
    );
    expect(await service.read(seed)).toMatchObject({ status: "error", sources: [] });
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { phase: "climbing-catalogue-refresh" },
    });
  });

  it("retains a positive result for seven days even when another provider has no matches", async () => {
    const service = new ClimbingCatalogueService(new MemoryCacheStore(), [
      { providerId: "thecrag", search: async () => ({ candidates: [candidate], complete: false }) },
      { providerId: "kaya", search: async () => ({ candidates: [], complete: true }) },
    ]);
    const result = await service.refresh(seed);
    expect(result.expiresAt).toBe("2026-11-03T12:00:00.000Z");
    expect(result.sources.map((source) => source.searchComplete)).toEqual([false, true]);
    vi.advanceTimersByTime(86400000);
    expect(await service.read(seed)).toEqual(result);
  });

  it("rejects an expired payload even if the cache backend still returns it", async () => {
    const { service, cache } = setup();
    const cached = await service.refresh(seed);
    vi.spyOn(cache, "get").mockResolvedValue(cached);
    vi.setSystemTime(new Date("2026-11-03T11:59:59.999Z"));
    expect(await service.read(seed)).toEqual(cached);
    vi.advanceTimersByTime(1);
    expect(await service.read(seed)).toEqual({
      status: "missing",
      fetchedAt: null,
      expiresAt: null,
      error: null,
      sources: [],
    });
  });

  it("invalidates only the requested fingerprint", async () => {
    const { service } = setup();
    const otherSeed = { ...seed, logEntryId: "log-b" };
    const otherResult = await service.refresh(otherSeed);
    await service.refresh(seed);
    await service.invalidate(seed);
    expect((await service.read(seed)).status).toBe("missing");
    expect(await service.read(otherSeed)).toEqual(otherResult);
  });

  it("expires initial errors after one day and renews repeated errors without inventing a fetch time", async () => {
    const { service, cache } = setup();
    const set = vi.spyOn(cache, "set");
    await service.markFailed(seed, "upstream unavailable");
    expect(await service.read(seed)).toEqual({
      status: "error",
      fetchedAt: null,
      expiresAt: "2026-10-28T12:00:00.000Z",
      sources: [],
      error: "Catalogue lookup failed. Try refreshing again.",
    });
    expect(set).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), 86400000);
    vi.advanceTimersByTime(3600000);
    await service.markFailed(seed, new Error("Retry later."));
    expect((await service.read(seed)).expiresAt).toBe("2026-10-28T13:00:00.000Z");
    vi.advanceTimersByTime(86400000);
    expect((await service.read(seed)).status).toBe("missing");
  });

  it("keeps the original successful expiry and remaining TTL when a later refresh fails", async () => {
    const { service, cache, search } = setup();
    const successful = await service.refresh(seed);
    const set = vi.spyOn(cache, "set");
    vi.advanceTimersByTime(2 * 86400000);
    const error = new Error("theCrag is unavailable. Retry later.");
    search.mockRejectedValue(error);
    await expect(service.refresh(seed)).rejects.toBe(error);
    const retained = { ...successful, status: "error", error: error.message };
    expect(await service.read(seed)).toEqual(retained);
    expect(set).toHaveBeenLastCalledWith(expect.any(String), retained, 5 * 86400000);
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { phase: "climbing-catalogue-refresh" },
    });
    vi.advanceTimersByTime(5 * 86400000);
    expect((await service.read(seed)).status).toBe("missing");
  });
});
