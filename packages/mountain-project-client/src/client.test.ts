import { describe, expect, it, vi } from "vitest";
import { MountainProjectClient, parseMountainProjectProfileId } from "./client.ts";

describe("parseMountainProjectProfileId", () => {
  it.each([
    ["110186720", "110186720"],
    [" 110186720 ", "110186720"],
    ["https://www.mountainproject.com/user/110186720", "110186720"],
    ["https://www.mountainproject.com/user/110186720/evan-davis", "110186720"],
    ["https://www.mountainproject.com/user/110186720/evan-davis/tick-export?view=all", "110186720"],
  ])("extracts %s", (input, expected) => {
    expect(parseMountainProjectProfileId(input)).toBe(expected);
  });

  it.each([
    "",
    "110abc",
    "x110186720",
    "http://www.mountainproject.com/user/110186720/name",
    "https://example.com/user/110186720/name",
    "https://www.mountainproject.com/route/110186720/name",
    "https://www.mountainproject.com/area/user/110186720/name",
  ])("rejects invalid input %s", (input) => {
    expect(() => parseMountainProjectProfileId(input)).toThrow(
      "Paste your Mountain Project profile URL or numeric profile ID.",
    );
  });
});

describe("MountainProjectClient", () => {
  it.each(["Route", "Area"] as const)(
    "reads and validates public %s JSON without credentials",
    async (kind) => {
      const requests: { url: string; init: RequestInit | undefined }[] = [];
      const client = new MountainProjectClient(async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({
          id: 123,
          title: "Source name",
          parent: { id: 0, name: "" },
          coordinates: [-122, 37],
          extra: "retained",
        });
      });
      const result = await (kind === "Route" ? client.getRoute("123") : client.getArea("123"));
      expect(result).toMatchObject({
        id: 123,
        title: "Source name",
        parent: { id: 0 },
        raw: { extra: "retained" },
      });
      expect(requests).toEqual([
        {
          url: `https://www.mountainproject.com/api/v2/${kind.toLowerCase()}s/123`,
          init: { headers: { Accept: "application/json" } },
        },
      ]);
    },
  );

  it.each([
    { id: 999, title: "Wrong entity", parent: { id: 0, name: "" } },
    { id: 123, title: "Bad parent", parent: { id: "2", name: "Area" } },
    { id: 123, title: "Bad GPS", parent: { id: 0, name: "" }, coordinates: [37, -122] },
    { id: 123, title: "Short GPS", parent: { id: 0, name: "" }, coordinates: [37] },
  ])("rejects malformed area identities and native coordinates: $title", async (payload) => {
    const client = new MountainProjectClient(async () => Response.json(payload));
    await expect(client.getArea("123")).rejects.toThrow(
      "Mountain Project area 123 returned invalid data",
    );
  });

  it.each(["route", "area"] as const)(
    "rejects nonfinite values in %s JSON provenance before returning it",
    async (kind) => {
      const client = new MountainProjectClient(
        async () =>
          new Response(
            '{"id":123,"title":"Source name","parent":{"id":0,"name":""},"extra":{"rating":1e400}}',
            { headers: { "Content-Type": "application/json" } },
          ),
      );
      await expect(
        kind === "route" ? client.getRoute("123") : client.getArea("123"),
      ).rejects.toThrow(`Mountain Project ${kind} 123 returned invalid data`);
    },
  );

  it.each([null, undefined])("retains unavailable native Area GPS as %s", async (coordinates) => {
    const client = new MountainProjectClient(async () =>
      Response.json({
        id: 123,
        title: "Root",
        parent: { id: 0, name: "" },
        ...(coordinates === undefined ? {} : { coordinates }),
      }),
    );
    const area = await client.getArea("123");
    expect(area.parent.id).toBe(0);
    expect(area.coordinates).toBe(coordinates);
    expect(area.raw).toEqual({
      id: 123,
      title: "Root",
      parent: { id: 0, name: "" },
      ...(coordinates === undefined ? {} : { coordinates }),
    });
  });

  it("reports endpoint failures and rejects nonnumeric entity IDs before fetching", async () => {
    const client = new MountainProjectClient(
      async () => new Response("unavailable", { status: 503 }),
    );
    await expect(client.getRoute("123")).rejects.toThrow("Mountain Project route 123 failed (503)");
    await expect(client.getArea("../123")).rejects.toThrow(
      "Mountain Project area ID must be a positive integer",
    );
  });

  it.each(["0123", "123 ", "9007199254740992"])(
    "rejects a non-canonical or unsafe entity ID %s before a request",
    async (id) => {
      let requests = 0;
      const client = new MountainProjectClient(async () => {
        requests += 1;
        return Response.json({ id: Number(id), title: "Area", parent: { id: 0, name: "" } });
      });
      await expect(client.getArea(id)).rejects.toThrow(
        "Mountain Project area ID must be a positive integer",
      );
      expect(requests).toBe(0);
    },
  );

  it("fetches the public tick export without credentials", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Date,Route", { status: 200 }));
    const client = new MountainProjectClient(fetchFn);

    await expect(client.getTickExport("110186720")).resolves.toBe("Date,Route");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://www.mountainproject.com/user/110186720/ticks/tick-export",
      expect.objectContaining({ headers: { Accept: "text/csv" } }),
    );
  });

  it("reports a private-or-missing profile with actionable guidance", async () => {
    const client = new MountainProjectClient(async () => new Response("missing", { status: 404 }));

    await expect(client.getTickExport("110186720")).rejects.toThrow(
      "Mountain Project: we couldn't read your ticks — check that your Mountain Project profile ID is correct and that your ticks aren't set to private.",
    );
  });

  it("reports unexpected export responses without treating them as private profiles", async () => {
    const client = new MountainProjectClient(
      async () => new Response("unavailable", { status: 503 }),
    );

    await expect(client.getTickExport("110186720")).rejects.toThrow(
      "Mountain Project tick export failed (503). Please try again.",
    );
  });
});
