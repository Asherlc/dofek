import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { labelGhostRoute } from "./ghost-route-labels.ts";

type Coordinate = [number, number];

const endpoint = /^https:\/\/api(?:-eu)?\.geoapify\.com\/v1\/mapmatching$/;
const server = setupServer();
const requestBody = z.looseObject({
  waypoints: z.array(z.looseObject({ location: z.tuple([z.number(), z.number()]) })),
});
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const degreePerMeter = 180 / (Math.PI * 6_371_000);
const completeTrace: Coordinate[] = [
  [-122.479, 37.766],
  [-122.4785, 37.7662],
  [-122.478, 37.7664],
  [-122.4775, 37.7666],
  [-122.477, 37.7668],
];
const tracePoints = completeTrace.map(([lng, lat], index) => ({
  lat,
  lng,
  timestampMs: index * 5_000 + 0.125,
}));

function point(east: number, north: number, timestampMs: number) {
  return { lat: north * degreePerMeter, lng: east * degreePerMeter, timestampMs };
}

function denseTrace(length: number) {
  return Array.from({ length: Math.floor(length / 3) + 1 }, (_, index) =>
    point(index * 3, 5 * Math.sin(index / 200), index * 1_000 + 0.125),
  );
}

function step(from: number, to: number, name = "Ridge Road", tags: Record<string, string> = {}) {
  return {
    name,
    road_class: "service_other",
    osmtags: { highway: "primary", ...tags },
    from_index: from,
    to_index: to,
    osm_way_id: 8,
    distance: 190,
    time: 98,
    surface: "paved_smooth",
    traversability: "both",
  };
}

function providerResponse(
  coordinates: Coordinate[],
  steps = [step(0, coordinates.length - 1)],
  stepAt = (_index: number) => 0,
) {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "MultiLineString", coordinates: [coordinates] },
        properties: {
          mode: "walk",
          distance: 190,
          time: 98,
          legs: [{ distance: 190, time: 98, steps }],
          waypoints: coordinates.map((location, index) => ({
            original_index: index,
            location,
            original_location: location,
            match_type: "matched",
            match_distance: 0,
            leg_index: 0,
            step_index: stepAt(index),
          })),
        },
      },
    ],
  };
}

function intercept(
  respond: (coordinates: Coordinate[], piece: number) => Response = (coordinates) =>
    HttpResponse.json(providerResponse(coordinates)),
) {
  const calls: { url: URL; body: object; coordinates: Coordinate[] }[] = [];
  server.use(
    http.post(endpoint, async ({ request }) => {
      const url = new URL(request.url);
      const body = requestBody.parse(await request.json());
      const coordinates = body.waypoints.map(({ location }) => location);
      calls.push({ url, body, coordinates });
      return respond(coordinates, calls.length);
    }),
  );
  return calls;
}

const config = { apiKey: "synthetic-key", region: "global" } as const;
const request = { points: tracePoints, sport: "running", enabled: true } as const;
const canDispatch = async () => true;

it("sends only coordinates, mode, and static tags and retains exact raw section bounds", async () => {
  const calls = intercept((coordinates) =>
    HttpResponse.json(
      providerResponse(
        coordinates,
        [step(0, 2, "Example Creek Trail", { highway: "path" }), step(2, 4, "Example Ridge Road")],
        (index) => (index < 2 ? 0 : 1),
      ),
    ),
  );
  const result = await labelGhostRoute({ ...request, canDispatch }, config);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url.href).toBe("https://api.geoapify.com/v1/mapmatching?apiKey=synthetic-key");
  expect(calls[0]?.body).toEqual({
    mode: "walk",
    waypoints: completeTrace.map((location) => ({ location })),
    lookup_step_osmtags: true,
  });
  expect(result).toMatchObject({
    status: "ready",
    coverage: { sampledWaypoints: 5, confirmedWaypoints: 5, bounded: false },
    sections: [
      {
        name: "Example Creek Trail",
        kind: "named-trail",
        start: { originalIndex: 0, ...tracePoints[0], distanceMeters: 0 },
        end: { originalIndex: 1, ...tracePoints[1] },
        attribution: expect.stringContaining("OpenStreetMap"),
      },
      {
        name: "Example Ridge Road",
        kind: "named-road",
        start: { originalIndex: 2, ...tracePoints[2] },
        end: { originalIndex: 4, ...tracePoints[4] },
      },
    ],
  });
});

it("uses the explicit EU endpoint and leg-local inclusive indices for cycling", async () => {
  const calls = intercept((coordinates) => {
    const response = providerResponse(coordinates, [step(0, 2)]);
    const feature = response.features[0];
    if (!feature) throw new Error("Missing feature");
    feature.geometry.coordinates = [coordinates.slice(0, 3), coordinates.slice(2)];
    feature.properties.legs.push({ distance: 90, time: 50, steps: [step(0, 2, "Creek Road")] });
    for (const waypoint of feature.properties.waypoints) {
      if (waypoint.original_index >= 2) waypoint.leg_index = 1;
    }
    return HttpResponse.json(response);
  });
  const result = await labelGhostRoute(
    { ...request, sport: "cycling", canDispatch },
    { ...config, region: "eu" },
  );
  expect(calls[0]?.url.host).toBe("api-eu.geoapify.com");
  expect(calls[0]?.body).toHaveProperty("mode", "bicycle");
  expect(result).toMatchObject({
    sections: [
      { name: "Ridge Road", start: { originalIndex: 0 }, end: { originalIndex: 1 } },
      { name: "Creek Road", start: { originalIndex: 2 }, end: { originalIndex: 4 } },
    ],
  });
});

it("covers a dense 5 km recording, deduplicating request overlaps", async () => {
  const calls = intercept();
  const result = await labelGhostRoute(
    { ...request, points: denseTrace(5_000), canDispatch },
    config,
  );
  expect(calls.map(({ coordinates }) => coordinates.length)).toEqual([100, 100, 41]);
  expect(calls[1]?.coordinates[0]).toEqual(calls[0]?.coordinates.at(-1));
  expect(calls[2]?.coordinates[0]).toEqual(calls[1]?.coordinates.at(-1));
  expect(result).toMatchObject({
    status: "ready",
    coverage: { sampledWaypoints: 239, confirmedWaypoints: 239, bounded: false },
    sections: [
      {
        start: { originalIndex: 0, timestampMs: 0.125 },
        end: { originalIndex: 1_666, timestampMs: 1_666_000.125 },
      },
    ],
  });
});

it("keeps both raw corners of a tight turn and the elapsed time of an interior stop", async () => {
  const calls = intercept();
  const cornerStart = point(33, 0, 11_000.125);
  const cornerEnd = point(33, 9, 14_000.125);
  const points = [
    ...Array.from({ length: 11 }, (_, index) => point(3 * index, 0, 1_000 * index + 0.125)),
    cornerStart,
    point(33, 3, 12_000.125),
    point(33, 6, 13_000.125),
    cornerEnd,
    { ...cornerEnd, timestampMs: 24_000.125 },
    ...Array.from({ length: 11 }, (_, index) =>
      point(30 - index * 3, 9, 25_000.125 + index * 1_000),
    ),
  ];
  const result = await labelGhostRoute({ ...request, points, canDispatch }, config);
  const sent = calls[0]?.coordinates ?? [];
  expect(sent).toContainEqual([cornerStart.lng, cornerStart.lat]);
  expect(sent).toContainEqual([cornerEnd.lng, cornerEnd.lat]);
  expect(
    sent.findIndex(([lng, lat]) => lng === cornerStart.lng && lat === cornerStart.lat),
  ).toBeLessThan(sent.findIndex(([lng, lat]) => lng === cornerEnd.lng && lat === cornerEnd.lat));
  expect(result).toMatchObject({
    sections: [{ start: { timestampMs: 0.125 }, end: { timestampMs: 35_000.125 } }],
  });
});

it("bounds requests on long recordings and reports the last processed boundary", async () => {
  const calls = intercept();
  const result = await labelGhostRoute(
    { ...request, points: denseTrace(10_000), canDispatch },
    config,
  );
  expect(calls.map(({ coordinates }) => coordinates.length)).toEqual([100, 100, 100, 100]);
  expect(result).toMatchObject({
    coverage: { sampledWaypoints: 397, confirmedWaypoints: 397, bounded: true },
    sections: [{ start: { originalIndex: 0 }, end: { originalIndex: 2_772 } }],
  });
});

it("derives separate recorded pieces at cadence gaps without sending a connector", async () => {
  const calls = intercept();
  const points = [
    ...Array.from({ length: 31 }, (_, index) => point(index * 3, 0, index * 1_000)),
    ...Array.from({ length: 31 }, (_, index) => point(150 + index * 3, 0, 50_000 + index * 1_000)),
  ];
  const result = await labelGhostRoute({ ...request, points, canDispatch }, config);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.coordinates.at(-1)).toEqual([90 * degreePerMeter, 0]);
  expect(calls[1]?.coordinates[0]).toEqual([150 * degreePerMeter, 0]);
  expect(result).toMatchObject({
    sections: [
      { start: { timestampMs: 0 }, end: { timestampMs: 30_000 } },
      { start: { timestampMs: 50_000 }, end: { timestampMs: 80_000 } },
    ],
  });
});

it.each([
  [{ highway: "trunk" }, "named-road"],
  [{ highway: "secondary" }, "named-road"],
  [{ highway: "tertiary" }, "named-road"],
  [{ highway: "residential", sidewalk: "both" }, "named-road"],
  [{ highway: "unclassified" }, "named-road"],
  [{ highway: "footway" }, "named-trail"],
  [{ highway: "cycleway" }, "named-trail"],
  [{ highway: "bridleway" }, "named-trail"],
] as const)("classifies a supported OSM way from %j", async (tags, kind) => {
  intercept((coordinates) =>
    HttpResponse.json(providerResponse(coordinates, [step(0, 4, "Example", tags)])),
  );
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toMatchObject({
    status: "ready",
    sections: [{ kind, name: "Example" }],
  });
});

const withheldTags: Record<string, string>[] = [
  { highway: "footway", footway: "sidewalk" },
  { highway: "footway", footway: "crossing" },
  { highway: "cycleway", cycleway: "crossing" },
  { highway: "path", path: "crossing" },
  { highway: "path", crossing: "marked" },
  { highway: "service" },
  { highway: "track" },
  { highway: "unknown" },
];
it.each(withheldTags)("withholds a name when OSM tags are %j", async (tags) => {
  const calls = intercept((coordinates) =>
    HttpResponse.json(providerResponse(coordinates, [step(0, 4, "Example Trail", tags)])),
  );
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toMatchObject({
    status: "unavailable",
    sections: [],
    coverage: { sampledWaypoints: 5, confirmedWaypoints: 5 },
  });
  expect(calls).toHaveLength(1);
});

it("keeps a provider step with another name or blank name out of an otherwise shared stretch", async () => {
  intercept((coordinates) =>
    HttpResponse.json(
      providerResponse(coordinates, [step(0, 2), step(2, 3, " "), step(3, 4)], (index) =>
        index < 3 ? 0 : 2,
      ),
    ),
  );
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toMatchObject({
    sections: [
      { start: { originalIndex: 0 }, end: { originalIndex: 2 } },
      { start: { originalIndex: 3 }, end: { originalIndex: 4 } },
    ],
  });
});

it("does not join disagreeing name evidence at the exact overlap", async () => {
  const calls = intercept((coordinates, piece) =>
    HttpResponse.json(
      providerResponse(coordinates, [step(0, coordinates.length - 1, `Road number ${piece}`)]),
    ),
  );
  expect(
    await labelGhostRoute({ ...request, points: denseTrace(2_500), canDispatch }, config),
  ).toMatchObject({
    coverage: { sampledWaypoints: 120, confirmedWaypoints: 119 },
    sections: [
      { name: "Road number 1", end: { originalIndex: 686 } },
      { name: "Road number 2", start: { originalIndex: 700 } },
    ],
  });
  expect(calls).toHaveLength(2);
});

type Waypoint = ReturnType<
  typeof providerResponse
>["features"][number]["properties"]["waypoints"][number];

it.each([
  [
    "unmatched",
    (waypoint: Waypoint) => {
      waypoint.match_type = "unmatched";
    },
  ],
  [
    "out-of-range leg",
    (waypoint: Waypoint) => {
      waypoint.leg_index = 5;
    },
  ],
  [
    "out-of-range step",
    (waypoint: Waypoint) => {
      waypoint.step_index = 5;
    },
  ],
  [
    "wrong echo",
    (waypoint: Waypoint) => {
      waypoint.original_location = [-1, 30];
    },
  ],
  [
    "too far",
    (waypoint: Waypoint) => {
      waypoint.match_distance = 30;
    },
  ],
  [
    "snap unrelated to the named step",
    (waypoint: Waypoint) => {
      const [lng, lat] = waypoint.location;
      waypoint.location = [lng, lat + 0.0001];
    },
  ],
] as const)("breaks a named run at one %s waypoint", async (_case, alter) => {
  intercept((coordinates) => {
    const response = providerResponse(coordinates);
    const middle = response.features[0]?.properties.waypoints[2];
    if (!middle) throw new Error("Missing middle waypoint");
    alter(middle);
    return HttpResponse.json(response);
  });
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toMatchObject({
    coverage: { sampledWaypoints: 5, confirmedWaypoints: 4 },
    sections: [
      { start: { originalIndex: 0 }, end: { originalIndex: 1 } },
      { start: { originalIndex: 3 }, end: { originalIndex: 4 } },
    ],
  });
});

it("withholds named spans below 80 percent confirmed evidence", async () => {
  intercept((coordinates) => {
    const response = providerResponse(coordinates);
    const waypoints = response.features[0]?.properties.waypoints;
    waypoints?.splice(3);
    return HttpResponse.json(response);
  });
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toMatchObject({
    status: "unavailable",
    sections: [],
    coverage: { sampledWaypoints: 5, confirmedWaypoints: 3, bounded: false },
  });
});

it("drops a snap that reverses the recorded order within a step", async () => {
  intercept((coordinates) => {
    const response = providerResponse(coordinates);
    const waypoints = response.features[0]?.properties.waypoints;
    const prior = waypoints?.[2];
    const current = waypoints?.[3];
    if (!prior || !current) throw new Error("Missing nearby waypoints");
    prior.location = [54 * degreePerMeter, 0];
    current.location = [51 * degreePerMeter, 0];
    return HttpResponse.json(response);
  });
  expect(
    await labelGhostRoute({ ...request, points: denseTrace(105), canDispatch }, config),
  ).toMatchObject({
    coverage: { sampledWaypoints: 6, confirmedWaypoints: 5 },
    sections: [{ start: { originalIndex: 0 }, end: { originalIndex: 14 } }],
  });
});

it("withholds a waypoint with two far-apart positions on its referenced step", async () => {
  intercept((coordinates) => {
    const response = providerResponse(coordinates);
    const feature = response.features[0];
    const middle = coordinates[2];
    const last = coordinates[4];
    if (!feature || !middle || !last) throw new Error("Missing route geometry");
    feature.geometry.coordinates = [[...coordinates, middle, last]];
    feature.properties.legs = [{ distance: 190, time: 98, steps: [step(0, 6)] }];
    return HttpResponse.json(response);
  });
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toMatchObject({
    status: "unavailable",
    sections: [],
  });
});

it("does not project a remote antimeridian segment through the recording", async () => {
  intercept((coordinates) => {
    const response = providerResponse(coordinates, [step(0, 1)]);
    const feature = response.features[0];
    if (!feature) throw new Error("Missing route geometry");
    feature.geometry.coordinates = [
      [
        [-179, 0],
        [179, 0],
      ],
    ];
    return HttpResponse.json(response);
  });
  expect(
    await labelGhostRoute({ ...request, points: denseTrace(105), canDispatch }, config),
  ).toMatchObject({
    status: "unavailable",
    sections: [],
    coverage: { sampledWaypoints: 6, confirmedWaypoints: 0 },
  });
});

it("recognizes a named recording that actually crosses the antimeridian", async () => {
  intercept();
  const points = [179.9994, 179.9997, 180, -179.9997, -179.9994].map((lng, index) => ({
    lng,
    lat: 0,
    timestampMs: 5_000 * index,
  }));
  expect(await labelGhostRoute({ ...request, points, canDispatch }, config)).toMatchObject({
    status: "ready",
    sections: [{ start: { lng: 179.9994 }, end: { lng: -179.9994 } }],
  });
});

it.each(["duplicate", "reordered", "outside", "range", "reversed steps"] as const)(
  "rejects %s structural mapping",
  async (kind) => {
    intercept((coordinates) => {
      const steps =
        kind === "reversed steps"
          ? [step(2, 4), step(0, 2)]
          : [step(0, kind === "range" ? coordinates.length : coordinates.length - 1)];
      const response = providerResponse(coordinates, steps);
      const waypoints = response.features[0]?.properties.waypoints;
      const first = waypoints?.[0];
      if (!first || !waypoints) throw new Error("Missing waypoint list");
      if (kind === "reordered") waypoints.reverse();
      if (kind === "duplicate") waypoints.splice(1, 0, first);
      if (kind === "outside") first.original_index = -1;
      return HttpResponse.json(response);
    });
    expect(await labelGhostRoute({ ...request, canDispatch }, config)).toEqual({
      status: "error",
      reason: "invalid-response",
    });
  },
);

it.each([
  [() => HttpResponse.json({ error: "provider payload" }), "invalid-response"],
  [() => new HttpResponse("{", { status: 200 }), "invalid-response"],
  [() => new HttpResponse(" ".repeat(1_048_577), { status: 200 }), "invalid-response"],
  [() => new HttpResponse("vendor failure", { status: 503 }), "request-failed"],
] as const)("sanitizes an invalid or failed provider response", async (respond, reason) => {
  intercept(respond);
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toEqual({
    status: "error",
    reason,
  });
});

it("reports Retry-After without retrying a rate-limited response", async () => {
  const calls = intercept(
    () => new HttpResponse(null, { status: 429, headers: { "Retry-After": "7" } }),
  );
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toEqual({
    status: "error",
    reason: "rate-limited",
    retryAfterSeconds: 7,
  });
  expect(calls).toHaveLength(1);
});

it.each([
  [undefined, undefined],
  ["+7", undefined],
  ["7.5", undefined],
  ["3601", undefined],
  ["3600", 3_600],
] as const)("bounds provider retry delay %s", async (header, retryAfterSeconds) => {
  const calls = intercept(
    () =>
      new HttpResponse(null, {
        status: 429,
        headers: header === undefined ? {} : { "Retry-After": header },
      }),
  );
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toStrictEqual({
    status: "error",
    reason: "rate-limited",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
  expect(calls).toHaveLength(1);
});

it("trims provider names and withholds names beyond the display limit", async () => {
  const maximumName = "a".repeat(256);
  const names = [`  ${maximumName}  `, "b".repeat(257)];
  for (const name of names) {
    intercept((coordinates) =>
      HttpResponse.json(providerResponse(coordinates, [step(0, coordinates.length - 1, name)])),
    );
    if (name.trim() === maximumName) {
      expect(await labelGhostRoute({ ...request, canDispatch }, config)).toMatchObject({
        status: "ready",
        sections: [{ kind: "named-road", name: maximumName }],
      });
    } else {
      expect(await labelGhostRoute({ ...request, canDispatch }, config)).toMatchObject({
        status: "unavailable",
        sections: [],
      });
    }
    server.resetHandlers();
  }
});

it("reports an empty collection as unavailable after dispatch", async () => {
  const calls = intercept(() => HttpResponse.json({ type: "FeatureCollection", features: [] }));
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toMatchObject({
    status: "unavailable",
    sections: [],
    coverage: { sampledWaypoints: 5, confirmedWaypoints: 0, bounded: false },
  });
  expect(calls).toHaveLength(1);
});

it("skips a short loop when sampling leaves only one distinct location", async () => {
  const calls = intercept();
  const points = [point(0, 0, 0), point(6, 0, 1_000), point(0, 0, 2_000)];
  expect(await labelGhostRoute({ ...request, points, canDispatch }, config)).toEqual({
    status: "unavailable",
    sections: [],
    coverage: { sampledWaypoints: 0, confirmedWaypoints: 0, bounded: false },
  });
  expect(calls).toHaveLength(0);
});

it("skips all provider work when disabled, obsolete or aborted", async () => {
  const calls = intercept();
  const allowed = vi.fn(canDispatch);
  expect(
    await labelGhostRoute({ ...request, enabled: false, canDispatch: allowed }, config),
  ).toEqual({ status: "disabled" });
  expect(allowed).not.toHaveBeenCalled();
  expect(await labelGhostRoute({ ...request, canDispatch: async () => false }, config)).toEqual({
    status: "cancelled",
  });
  expect(
    await labelGhostRoute(
      { ...request, canDispatch: allowed, signal: AbortSignal.abort() },
      config,
    ),
  ).toEqual({ status: "cancelled" });
  expect(calls).toHaveLength(0);
});

it("discards earlier results when eligibility changes before a second request", async () => {
  const calls = intercept();
  const revalidate = vi.fn(canDispatch).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(
    await labelGhostRoute(
      { ...request, points: denseTrace(2_500), canDispatch: revalidate },
      config,
    ),
  ).toEqual({ status: "cancelled" });
  expect(calls).toHaveLength(1);
  expect(revalidate).toHaveBeenCalledTimes(2);
});

it("aborts the provider request and withholds its response if cancellation happens in flight", async () => {
  const controller = new AbortController();
  const requestAborted = vi.fn();
  server.use(
    http.post(endpoint, async ({ request: pending }) => {
      const body = requestBody.parse(await pending.json());
      const coordinates = body.waypoints.map(({ location }) => location);
      pending.signal.addEventListener("abort", requestAborted, { once: true });
      controller.abort();
      return HttpResponse.json(providerResponse(coordinates));
    }),
  );
  expect(
    await labelGhostRoute({ ...request, canDispatch, signal: controller.signal }, config),
  ).toEqual({ status: "cancelled" });
  expect(requestAborted).toHaveBeenCalledTimes(1);
});

it("blocks a provider redirect before forwarding the request body", async () => {
  const calls = intercept(() => HttpResponse.redirect("https://unexpected.example/redirect", 307));
  const redirected = vi.fn(() => HttpResponse.json({}));
  server.use(http.post("https://unexpected.example/redirect", redirected));
  expect(await labelGhostRoute({ ...request, canDispatch }, config)).toEqual({
    status: "error",
    reason: "request-failed",
  });
  expect(calls).toHaveLength(1);
  expect(redirected).not.toHaveBeenCalled();
});
