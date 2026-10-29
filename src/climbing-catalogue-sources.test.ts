import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClimbingCatalogueAdapters } from "./climbing-catalogue-sources.ts";

const mocks = vi.hoisted(() => ({ tokens: vi.fn(), rateLimit: vi.fn() }));
vi.mock("./db/tokens.ts", () => ({ loadTokens: mocks.tokens }));
vi.mock("./lib/provider-rate-limit-fetch.ts", () => ({
  createProviderRateLimitFetch: mocks.rateLimit,
}));
vi.mock("./providers/thecrag/public-transport.ts", () => ({
  createTheCragPublicFetch: () => fetch,
}));
const seed: CatalogueSeed = {
  userId: "owner",
  logEntryId: "entry",
  providerId: "mountain-project",
  externalId: "105734660",
  sourceUrl: null,
  name: "Cragmont Crack",
  kind: "route",
  setting: "outdoor",
  locations: [],
};
const source = {
  id: "1062267",
  slug: "cragmont",
  name: seed.name,
  climb_type: { name: "Routes" },
  grade: { name: "5.6" },
  gym: null,
  board: null,
  destination: null,
  area: null,
  subarea: null,
  angle: null,
};
describe("catalogue source composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockImplementation((_id: string, fetchFn: typeof fetch) => fetchFn);
    mocks.tokens.mockResolvedValue({ accessToken: "owner-token" });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("includes every climbing catalogue provider", () => {
    expect(
      createClimbingCatalogueAdapters("owner", Object.create(null)).map(
        (adapter) => adapter.providerId,
      ),
    ).toEqual(["kaya", "mountain-project", "thecrag", "openbeta"]);
    expect(mocks.rateLimit.mock.calls).toEqual(
      ["kaya", "mountain-project", "thecrag", "openbeta"].map((providerId) => [
        providerId,
        globalThis.fetch,
        { userId: "owner" },
      ]),
    );
  });
  it("uses public KAYA catalogue metadata when the owner has no KAYA connection", async () => {
    mocks.tokens.mockResolvedValue(null);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: { webSearchForClimb: [source] } }));
    vi.stubGlobal("fetch", fetchFn);
    const adapter = createClimbingCatalogueAdapters("owner", Object.create(null))[0];
    if (!adapter) throw new Error("Expected KAYA adapter");
    const result = await adapter.search(seed);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.name).toBe(seed.name);
    expect(mocks.tokens).toHaveBeenCalledWith(expect.anything(), "kaya", "owner");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("uses the current owner's KAYA connection for live Sport classification of a cross-provider match", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: { webSearchForClimb: [source] } }))
      .mockResolvedValueOnce(
        Response.json({ data: { climb: { ...source, lead: true, is_trad: false, tags: [] } } }),
      );
    vi.stubGlobal("fetch", fetchFn);
    const adapter = createClimbingCatalogueAdapters("owner", Object.create(null)).find(
      (adapter) => adapter.providerId === "kaya",
    );
    if (!adapter) throw new Error("Expected KAYA adapter");
    const result = await adapter.search(seed);
    expect(result.candidates[0]?.tags).toContainEqual(
      expect.objectContaining({ kind: "climb_type", label: "Sport" }),
    );
    expect(mocks.tokens).toHaveBeenCalledWith(expect.anything(), "kaya", "owner");
    expect(fetchFn.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer owner-token",
    });
  });
});
