import { describe, expect, it, vi } from "vitest";
import type { CatalogueSeed } from "./contracts.ts";
import { KayaCatalogueAdapter } from "./kaya.ts";

const seed: CatalogueSeed = {
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
  it("retains a declared parent when the corresponding higher-level slot is absent", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        {
          ...climb,
          destination: null,
          area: {
            ...climb.area,
            slug: "Cragmont-Park",
            description: null,
            is_closed: null,
            parent_location: { id: "1720", name: "Berkeley", slug: "Berkeley-999" },
          },
        },
      ]),
    );
    const result = await new KayaCatalogueAdapter(fetchFn, async () => null).search(seed);
    expect(result.candidates[0]?.locations).toMatchObject([
      {
        externalId: "1720",
        name: "Berkeley",
        coordinates: null,
        context: {
          url: "https://kaya-app.kayaclimb.com/location/Berkeley-999",
          type: null,
          sections: [],
          tags: [],
          statistics: [],
        },
      },
      { externalId: "46806", context: { sections: [] } },
    ]);
  });
  it("retains source-owned context at every outdoor ancestor without inferring route traits", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        {
          ...climb,
          destination: {
            ...climb.destination,
            slug: "Berkeley-999",
            location_type: { id: "2", name: "Destination" },
            description: "<p>Granite &amp; steep bouldering.</p><script>bad()</script>",
            access_description_bouldering: "Park at the trailhead.",
            is_closed: false,
            is_access_sensitive: null,
            closed_date: null,
          },
          area: {
            ...climb.area,
            slug: "Cragmont-Park-777",
            location_type: { id: "3", name: "Area" },
            description_routes: "Routes overview.",
            access_issues_description_routes: "Seasonal access.",
            parent_location: { id: "1720", name: "Berkeley", slug: "Berkeley-999" },
          },
          subarea: {
            id: "12",
            name: "East Wall",
            slug: "East-Wall-88",
            latitude: null,
            longitude: null,
            location_type: { id: "4", name: "Subarea" },
            description_short_routes: "Local summary.",
            is_closed: true,
            closed_date: "2026-10-31",
            is_access_sensitive: true,
          },
        },
      ]),
    );
    const result = await new KayaCatalogueAdapter(fetchFn, async () => null).search(seed);
    const locations = result.candidates[0]?.locations;
    expect(locations?.map((place) => place.externalId)).toEqual(["1720", "46806", "12"]);
    expect(locations?.[0]?.context).toEqual({
      url: "https://kaya-app.kayaclimb.com/location/Berkeley-999",
      type: "Destination",
      sections: [
        {
          sourceKey: "description",
          label: "Description",
          text: "Granite & steep bouldering.",
          inheritedFrom: null,
        },
        {
          sourceKey: "access_description_bouldering",
          label: "Bouldering access",
          text: "Park at the trailhead.",
          inheritedFrom: null,
        },
        { sourceKey: "is_closed", label: "Closed", text: "false", inheritedFrom: null },
      ],
      tags: [],
      statistics: [],
    });
    expect(locations?.[1]?.context).toMatchObject({
      type: "Area",
      sections: [
        { sourceKey: "description_routes", text: "Routes overview." },
        { sourceKey: "access_issues_description_routes", text: "Seasonal access." },
      ],
    });
    expect(locations?.[2]?.context).toMatchObject({
      type: "Subarea",
      sections: expect.arrayContaining([
        { sourceKey: "closed_date", label: "Closed date", text: "2026-10-31", inheritedFrom: null },
        {
          sourceKey: "is_access_sensitive",
          label: "Access sensitive",
          text: "true",
          inheritedFrom: null,
        },
      ]),
    });
    expect(result.candidates[0]?.tags).toEqual([
      expect.objectContaining({ kind: "climb_type" }),
      expect.objectContaining({ kind: "steepness" }),
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).query).toContain(
      "access_issues_description_routes",
    );
  });

  it("retains gym identity, coordinates and source-labelled profile fields", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        {
          ...climb,
          destination: null,
          area: null,
          gym: {
            id: "209",
            slug: "movementcolumbia",
            name: "Movement Columbia",
            latitude: "39.17770160",
            longitude: "-76.81064450",
            address: "7125 Columbia Gateway Drive #110",
            city: "Columbia",
            postal_code: "21046",
            region: "Maryland",
            country: "United States",
            website: "https://movementgyms.com/columbia/ ",
            is_official: true,
          },
        },
      ]),
    );
    const result = await new KayaCatalogueAdapter(fetchFn, async () => null).search(seed);
    expect(result.candidates[0]?.locations).toMatchObject([
      {
        externalId: "209",
        coordinates: { latitude: 39.1777016, longitude: -76.8106445 },
        context: {
          url: "https://kaya-app.kayaclimb.com/gym/movementcolumbia",
          type: "Gym",
          tags: [],
          statistics: [],
          sections: expect.arrayContaining([
            { sourceKey: "postal_code", label: "Postal code", text: "21046", inheritedFrom: null },
            {
              sourceKey: "website",
              label: "Website",
              text: "https://movementgyms.com/columbia/",
              inheritedFrom: null,
            },
            { sourceKey: "is_official", label: "Official", text: "true", inheritedFrom: null },
          ]),
        },
      },
    ]);
  });

  it("retains public parent context when authenticated details refresh climb traits", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([
          {
            ...climb,
            area: { ...climb.area, slug: "Cragmont-Park", description: "Area description." },
          },
        ]),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { climb: { ...climb, lead: true, is_trad: false } } }),
      );
    const result = await new KayaCatalogueAdapter(fetchFn, async () => "token").search(seed);
    expect(result.candidates[0]?.locations[1]?.context?.sections).toContainEqual({
      sourceKey: "description",
      label: "Description",
      text: "Area description.",
      inheritedFrom: null,
    });
    expect(result.candidates[0]?.tags).toContainEqual(expect.objectContaining({ label: "Sport" }));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([null, "", "  "])(
    "loads an unnamed indoor climb by its recorded KAYA identity: %j",
    async (name) => {
      // Exercise schema construction for each upstream name shape.
      vi.resetModules();
      const { KayaCatalogueAdapter: Adapter } = await import("./kaya.ts");
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: {
            climb: {
              ...climb,
              name,
              gym: { id: "gym", name: "Pacific Pipe" },
              destination: null,
              angle: null,
              lead: true,
              is_trad: false,
            },
          },
        }),
      );
      const result = await new Adapter(fetchFn, async () => "token").search({
        ...seed,
        providerId: "kaya",
        externalId: "1062267",
        name: null,
        setting: "indoor",
      });
      expect(result).toMatchObject({
        complete: true,
        candidates: [
          {
            externalId: "1062267",
            name: null,
            grade: "5.6",
            setting: "indoor",
            tags: expect.arrayContaining([
              {
                kind: "climb_type",
                sourceKey: "is_trad",
                label: "Sport",
                category: null,
                scope: "direct",
                inheritedFrom: null,
              },
            ]),
          },
        ],
      });
    },
  );
  it("does not claim complete coverage when a fourth name remains after three empty queries", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) =>
        response(
          JSON.parse(String(init?.body)).variables.name === "Left start"
            ? [{ ...climb, name: "Left start" }]
            : [],
        ),
      );
    expect(
      await new KayaCatalogueAdapter(fetchFn, async () => null).search({
        ...seed,
        aliases: ["Up", "Down", "Left start"],
      }),
    ).toEqual({ candidates: [], complete: false });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])(
    "discovers historical names with request-sensitive results (overlap=%s)",
    async (overlap) => {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const { variables } = JSON.parse(String(init?.body));
        return response(variables.name === "Up" || overlap ? [{ ...climb, name: "Up" }] : []);
      });
      const result = await new KayaCatalogueAdapter(fetchFn, async () => null).search({
        ...seed,
        aliases: ["", "  CRAGMONT   crack ", "Up", " up "],
      });
      expect(result.candidates.map((candidate) => candidate.name)).toEqual(["Up"]);
      expect(result.complete).toBe(true);
      expect(
        fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).variables.name),
      ).toEqual(["Cragmont Crack", "Up"]);
    },
  );
  it("shares three pages across aliases before paginating and reports uncovered names", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const { variables } = JSON.parse(String(init?.body));
      return response(
        variables.name === seed.name
          ? Array.from({ length: 20 }, (_, i) => ({ ...climb, id: String(i + 1) }))
          : [],
      );
    });
    const result = await new KayaCatalogueAdapter(fetchFn, async () => null).search({
      ...seed,
      aliases: ["Up", "Down", "Left start"],
    });
    expect(result.complete).toBe(false);
    expect(
      fetchFn.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).variables.name),
    ).toEqual(["Cragmont Crack", "Up", "Down"]);
  });
  it("resumes each query at its own offset after giving aliases an initial page", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const { variables } = JSON.parse(String(init?.body));
      return response(
        variables.name === seed.name && variables.offset === 0
          ? Array.from({ length: 20 }, (_, i) => ({ ...climb, id: String(i + 1) }))
          : [],
      );
    });
    expect(
      (
        await new KayaCatalogueAdapter(fetchFn, async () => null).search({
          ...seed,
          aliases: ["Up"],
        })
      ).complete,
    ).toBe(true);
    expect(
      fetchFn.mock.calls.map(([, init]) => {
        const { variables } = JSON.parse(String(init?.body));
        return [variables.name, variables.offset];
      }),
    ).toEqual([
      ["Cragmont Crack", 0],
      ["Up", 0],
      ["Cragmont Crack", 20],
    ]);
  });
  it.each(["Great Roof, The", "The Great Roofs", "The Great Roof extension"])(
    "retains name-related result %s without removing qualifiers",
    async (name) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response([{ ...climb, name }]));
      const result = await new KayaCatalogueAdapter(fetchFn, async () => null).search({
        ...seed,
        name: "The Great Roof",
      });
      expect(result.candidates[0]?.name).toBe(name);
    },
  );
  it("uses source-declared seed aliases for discovery", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_input, init) =>
        response(
          JSON.parse(String(init?.body)).variables.name === "Up" ? [{ ...climb, name: "Up" }] : [],
        ),
      );
    expect(
      (
        await new KayaCatalogueAdapter(fetchFn, async () => null).search({
          ...seed,
          aliases: ["Up"],
        })
      ).candidates[0]?.name,
    ).toBe("Up");
  });
  it("preserves Goat Rock native IDs separately from unrelated URL slug suffixes", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        {
          ...climb,
          id: "887401",
          slug: "Swiss-Cheese-56-Castle-Rock-State-Park-6084576",
          name: "Swiss Cheese",
          destination: {
            id: "2204",
            name: "Castle Rock State Park",
            latitude: "37.22846981",
            longitude: "-122.09959639",
          },
          area: {
            id: "46774",
            name: "Goat Rock",
            latitude: "37.228451",
            longitude: "-122.107888",
          },
        },
      ]),
    );
    expect(
      (
        await new KayaCatalogueAdapter(fetchFn, async () => null).search({
          ...seed,
          name: "Swiss Cheese",
        })
      ).candidates[0],
    ).toMatchObject({
      externalId: "887401",
      url: "https://kaya-app.kayaclimb.com/climb/Swiss-Cheese-56-Castle-Rock-State-Park-6084576",
      locations: expect.arrayContaining([
        {
          externalId: "46774",
          name: "Goat Rock",
          scope: "area",
          coordinates: { latitude: 37.228451, longitude: -122.107888 },
        },
      ]),
    });
  });
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
  it.each(["destination", "gym"] as const)(
    "requests verified native %s context for an unnamed recorded climb",
    async (parentKey) => {
      const parent =
        parentKey === "gym"
          ? {
              id: "209",
              slug: "movementcolumbia",
              name: "Movement Columbia",
              latitude: "39.17770160",
              longitude: "-76.81064450",
              address: "7125 Columbia Gateway Drive #110",
              city: "Columbia",
              postal_code: "21046",
              region: "Maryland",
              country: "United States",
              website: "https://movementgyms.com/columbia/",
              is_official: true,
            }
          : {
              id: "1812",
              slug: "Horse-Flats-317843",
              name: "Horse Flats",
              latitude: "34.34296000",
              longitude: "-118.01584000",
              description_bouldering: "<p>Granite bouldering.</p>",
              access_description_routes: "Follow the path.",
              location_type: { id: "2", name: "Destination" },
              parent_location: null,
              is_closed: false,
              is_access_sensitive: true,
            };
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        const query = JSON.parse(String(init?.body)).query;
        const selectedParent = query.includes(`${parentKey} { id slug name`)
          ? parent
          : { id: parent.id, name: parent.name };
        return Response.json({
          data: {
            climb: {
              ...climb,
              name: null,
              destination: null,
              gym: null,
              area: null,
              [parentKey]: selectedParent,
              lead: true,
              is_trad: false,
            },
          },
        });
      });
      const result = await new KayaCatalogueAdapter(fetchFn, async () => "token").search({
        ...seed,
        providerId: "kaya",
        externalId: climb.id,
        name: null,
      });
      expect(result.candidates[0]?.name).toBeNull();
      expect(result.candidates[0]?.locations[0]?.context).toMatchObject({
        url:
          parentKey === "gym"
            ? "https://kaya-app.kayaclimb.com/gym/movementcolumbia"
            : "https://kaya-app.kayaclimb.com/location/Horse-Flats-317843",
        type: parentKey === "gym" ? "Gym" : "Destination",
        sections: expect.arrayContaining(
          parentKey === "gym"
            ? [
                {
                  sourceKey: "address",
                  label: "Address",
                  text: "7125 Columbia Gateway Drive #110",
                  inheritedFrom: null,
                },
                { sourceKey: "is_official", label: "Official", text: "true", inheritedFrom: null },
              ]
            : [
                {
                  sourceKey: "description_bouldering",
                  label: "Bouldering description",
                  text: "Granite bouldering.",
                  inheritedFrom: null,
                },
                {
                  sourceKey: "access_description_routes",
                  label: "Routes access",
                  text: "Follow the path.",
                  inheritedFrom: null,
                },
                { sourceKey: "is_closed", label: "Closed", text: "false", inheritedFrom: null },
              ],
        ),
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const request = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
      expect(request.query).toContain('climb(id:"1062267")');
      expect(request.query).toContain("parent_location { id slug name }");
    },
  );

  it.each(["  Literal STYLE!  ", "\tSource label\n"])(
    "preserves the exact native tag label %j",
    async (name) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: {
            climb: {
              ...climb,
              lead: true,
              is_trad: false,
              tags: [{ id: "literal", name, tag_type_id: "6" }],
            },
          },
        }),
      );
      const result = await new KayaCatalogueAdapter(fetchFn, async () => "token").search({
        ...seed,
        providerId: "kaya",
        externalId: climb.id,
      });
      expect(result.candidates[0]?.tags).toContainEqual({
        kind: "other",
        sourceKey: "literal",
        label: name,
        category: "Style",
        scope: "direct",
        inheritedFrom: null,
      });
    },
  );

  it.each(["", "  ", "\t\n"])("rejects an empty native tag label %j", async (name) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          climb: {
            ...climb,
            lead: true,
            is_trad: false,
            tags: [{ id: "empty", name, tag_type_id: "6" }],
          },
        },
      }),
    );
    await expect(
      new KayaCatalogueAdapter(fetchFn, async () => "token").search({
        ...seed,
        providerId: "kaya",
        externalId: climb.id,
      }),
    ).rejects.toThrow(
      "Kaya authenticated catalogue lookup returned invalid or rejected climb details; sync or reconnect Kaya and retry.",
    );
  });

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
