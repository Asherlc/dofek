import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { describe, expect, it, vi } from "vitest";
import { KayaCatalogueAdapter } from "./catalogue.ts";

const seed: CatalogueSeed = {
  userId: "u",
  logEntryId: "l",
  providerId: "manual",
  externalId: null,
  sourceUrl: null,
  name: "Cragmont Crack",
  kind: "route",
  setting: "outdoor",
  locations: [],
};
const climb = {
  id: "1062267",
  slug: "Cragmont-Crack",
  name: "Cragmont Crack",
  climb_type: { name: "Routes" },
  grade: { name: "5.6" },
  gym: null,
  board: null,
  destination: { id: "1720", name: "Berkeley", latitude: "37.89", longitude: "-122.27" },
  area: { id: "46806", name: "Cragmont Park" },
  subarea: null,
  angle: -20,
  description: "crimps",
  tags: [],
};
const response = (rows: unknown[]) => Response.json({ data: { webSearchForClimb: rows } });

describe("KayaCatalogueAdapter", () => {
  it("reads explicit outdoor traits and retains area coordinate attribution", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([climb]));
    const result = await new KayaCatalogueAdapter(fetchFn, async () => null).search(seed);
    expect(result).toMatchObject({
      complete: true,
      candidates: [
        {
          providerId: "kaya",
          externalId: "1062267",
          url: "https://kaya-app.kayaclimb.com/climb/Cragmont-Crack",
          name: seed.name,
          grade: "5.6",
          kind: "route",
          setting: "outdoor",
          angle: null,
          tags: [
            { kind: "climb_type", label: "Routes" },
            { kind: "steepness", category: "slab", scope: "direct" },
          ],
          locations: [
            {
              name: "Berkeley",
              scope: "area",
              coordinates: { latitude: 37.89, longitude: -122.27 },
            },
            { name: "Cragmont Park", scope: "area", coordinates: null },
          ],
        },
      ],
    });
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: {
        origin: "https://kaya-app.kayaclimb.com",
        referer: "https://kaya-app.kayaclimb.com/",
      },
    });
  });
  it("does not interpret board angle codes or descriptions as hold traits", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ ...climb, board: { id: "b", name: "Board" }, angle: 20 }]));
    const result = await new KayaCatalogueAdapter(fetchFn, async () => null).search(seed);
    expect(result.candidates[0]).toMatchObject({
      setting: "indoor",
      angle: { value: 20, unit: null },
      tags: [{ kind: "climb_type", label: "Routes" }],
    });
  });
  it("preserves original source identity even when the name changed", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        { ...climb, name: "Renamed" },
        { ...climb, id: "99", name: "Other" },
      ]),
    );
    expect(
      (
        await new KayaCatalogueAdapter(fetchFn, async () => null).search({
          ...seed,
          providerId: "kaya",
          externalId: climb.id,
        })
      ).candidates,
    ).toHaveLength(1);
  });
  it("stops repeated full pages without declaring search complete", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...climb, id: String(i) }));
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => response(rows));
    expect(await new KayaCatalogueAdapter(fetchFn, async () => null).search(seed)).toMatchObject({
      complete: false,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("caps unique search pages", async () => {
    let page = 0;
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
      const value = response(
        Array.from({ length: 20 }, (_, i) => ({ ...climb, id: String(page * 20 + i) })),
      );
      page++;
      return value;
    });
    const result = await new KayaCatalogueAdapter(fetchFn, async () => null).search(seed);
    expect(result.complete).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it.each([
    Response.json({ data: null, errors: [{ message: "blocked" }] }),
    new Response("blocked", { status: 403 }),
    Response.json({ data: { webSearchForClimb: [{}] } }),
  ])("fails loudly on blocked or invalid catalogue responses", async (value) => {
    await expect(
      new KayaCatalogueAdapter(
        vi.fn<typeof fetch>().mockResolvedValue(value),
        async () => null,
      ).search(seed),
    ).rejects.toThrow(/Kaya/);
  });
  it("rejects source URLs on unexpected origins before requesting", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      new KayaCatalogueAdapter(fetchFn, async () => null).search({
        ...seed,
        providerId: "kaya",
        externalId: "1",
        sourceUrl: "https://evil.example/climb/a",
      }),
    ).rejects.toThrow(/Kaya/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports malformed JSON with source context", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("not json"));
    await expect(new KayaCatalogueAdapter(fetchFn, async () => null).search(seed)).rejects.toThrow(
      /Kaya/,
    );
  });
  it("rejects an unexpected response origin", async () => {
    const value = Response.json({});
    Object.defineProperty(value, "url", { value: "https://evil.example" });
    await expect(
      new KayaCatalogueAdapter(
        vi.fn<typeof fetch>().mockResolvedValue(value),
        async () => null,
      ).search(seed),
    ).rejects.toThrow(/unexpected redirect/);
  });

  it("rejects invalid source coordinates with provider context", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response([{ ...climb, destination: { ...climb.destination, latitude: "1000" } }]),
      );
    await expect(new KayaCatalogueAdapter(fetchFn, async () => null).search(seed)).rejects.toThrow(
      /Kaya/,
    );
  });

  it("preserves the public climb-type name separately from wall traits", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ ...climb, climb_type: { name: "Routes" } }]));
    const result = await new KayaCatalogueAdapter(fetchFn, async () => null).search(seed);
    expect(result.candidates[0]?.tags).toContainEqual({
      kind: "climb_type",
      label: "Routes",
      sourceKey: "climb_type.name",
      category: null,
      scope: "direct",
      inheritedFrom: null,
    });
  });
});

describe("Kaya authenticated catalogue classification", () => {
  it("retains every native source tag and its category without requesting tags on public search", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([climb]))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            climb: {
              ...climb,
              lead: true,
              is_trad: false,
              tags: [
                { id: "11", name: "Crimp", tag_type_id: "3" },
                { id: "12", name: "Source movement", tag_type_id: "2" },
                { id: "13", name: "Custom label", tag_type_id: "1" },
                { id: "14", name: "Unfamiliar label", tag_type_id: "99" },
              ],
            },
          },
        }),
      );
    const result = await new KayaCatalogueAdapter(fetchFn, async () => "token").search(seed);
    expect(result.candidates[0]?.tags).toEqual(
      expect.arrayContaining([
        {
          kind: "hold",
          sourceKey: "11",
          label: "Crimp",
          category: "Grip",
          scope: "direct",
          inheritedFrom: null,
        },
        {
          kind: "other",
          sourceKey: "12",
          label: "Source movement",
          category: "Movement",
          scope: "direct",
          inheritedFrom: null,
        },
        {
          kind: "other",
          sourceKey: "13",
          label: "Custom label",
          category: "Custom",
          scope: "direct",
          inheritedFrom: null,
        },
        {
          kind: "other",
          sourceKey: "14",
          label: "Unfamiliar label",
          category: "99",
          scope: "direct",
          inheritedFrom: null,
        },
      ]),
    );
    const publicRequest = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    const nativeRequest = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
    expect(publicRequest.query).not.toContain("tags");
    expect(nativeRequest.query).toContain("tags { id name tag_type_id }");
  });

  it.each([
    { lead: true, is_trad: false, expected: "Sport" },
    { lead: false, is_trad: true, expected: "Trad" },
  ])(
    "reads fresh $expected classification by native climb ID",
    async ({ lead, is_trad, expected }) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response([climb, { ...climb, id: "42", name: "Unrelated" }]))
        .mockResolvedValueOnce(
          Response.json({ data: { climb: { ...climb, lead, is_trad, grade: { name: "5.7" } } } }),
        );
      const access = vi.fn(async () => "test-access-token");
      const result = await new KayaCatalogueAdapter(fetchFn, access).search(seed);
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.grade).toBe("5.7");
      expect(result.candidates[0]?.tags).toContainEqual(
        expect.objectContaining({ kind: "climb_type", label: expected }),
      );
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(access).toHaveBeenCalledTimes(1);
      expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({
        headers: { authorization: "Bearer test-access-token" },
        redirect: "error",
      });
    },
  );
  it.each([
    { lead: true, is_trad: null, labels: ["Routes"] },
    { lead: false, is_trad: false, labels: ["Routes"] },
    { lead: null, is_trad: false, labels: ["Routes"] },
    { lead: true, is_trad: true, labels: ["Routes", "Trad"] },
    { lead: null, is_trad: true, labels: ["Routes", "Trad"] },
  ])(
    "preserves only supported native classifications for lead=$lead and is_trad=$is_trad",
    async ({ lead, is_trad, labels }) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ data: { climb: { ...climb, lead, is_trad } } }));
      const result = await new KayaCatalogueAdapter(fetchFn, async () => "token").search({
        ...seed,
        providerId: "kaya",
        externalId: climb.id,
      });
      expect(
        result.candidates[0]?.tags
          .filter((tag) => tag.kind === "climb_type")
          .map((tag) => tag.label),
      ).toEqual(labels);
    },
  );
  it("loads known source IDs directly when authenticated even after a rename", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: { climb: { ...climb, name: "New name", lead: true, is_trad: false } },
      }),
    );
    const result = await new KayaCatalogueAdapter(fetchFn, async () => "token").search({
      ...seed,
      providerId: "kaya",
      externalId: climb.id,
    });
    expect(result).toMatchObject({
      complete: true,
      candidates: [{ externalId: climb.id, name: "New name" }],
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(request.query).toContain(`climb(id:"${climb.id}")`);
  });
  it("retains public search without authenticated detail reads when no token exists", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([climb]));
    const access = vi.fn(async () => null);
    const result = await new KayaCatalogueAdapter(fetchFn, access).search(seed);
    expect(
      result.candidates[0]?.tags.filter((tag) => tag.kind === "climb_type").map((tag) => tag.label),
    ).toEqual(["Routes"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...climb, id: "42", lead: true, is_trad: false },
    { ...climb, lead: true, is_trad: "false" },
    { ...climb, lead: "true", is_trad: false },
    { ...climb, lead: true },
  ])("rejects malformed native classifications or mismatched IDs", async (native) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: { climb: native } }));
    await expect(
      new KayaCatalogueAdapter(fetchFn, async () => "token").search({
        ...seed,
        providerId: "kaya",
        externalId: climb.id,
      }),
    ).rejects.toThrow(/Kaya/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each([
    new Response("unauthorized", { status: 401 }),
    Response.json({ errors: [{ message: "denied" }], data: { climb: null } }),
  ])("surfaces authenticated failures without falling back to public data", async (value) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(value);
    await expect(
      new KayaCatalogueAdapter(fetchFn, async () => "token").search({
        ...seed,
        providerId: "kaya",
        externalId: climb.id,
      }),
    ).rejects.toThrow(/Kaya.*(?:401|reconnect)/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
