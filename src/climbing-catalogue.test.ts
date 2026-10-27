import type { CatalogueCandidate, CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClimbingCatalogueService } from "./climbing-catalogue.ts";
import { MemoryCacheStore } from "./lib/cache.ts";

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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  const setup = (results = [candidate], complete = true) => {
    const search = vi.fn().mockResolvedValue({ candidates: results, complete });
    const service = new ClimbingCatalogueService(new MemoryCacheStore(), [
      { providerId: "thecrag", search },
    ]);
    return { service, search };
  };

  it("reads a missing cache without making an upstream request", async () => {
    const { service, search } = setup();
    expect((await service.read(seed)).status).toBe("missing");
    expect(search).not.toHaveBeenCalled();
  });
  it("corroborates a unique complete name/kind/location match and preserves all source facts", async () => {
    const { service } = setup();
    const result = await service.refresh(seed);
    expect(result.sources[0]?.matches).toEqual([{ confidence: "corroborated", candidate }]);
    expect(result.expiresAt).toBe("2026-11-03T12:00:00.000Z");
    expect(await service.read(seed)).toEqual(result);
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
});
