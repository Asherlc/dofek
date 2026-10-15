import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClimbingLogSyncInput } from "../db/climbing-log-sync.ts";
import type { SyncDatabase } from "../db/index.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { makeTransactionalTestDatabase } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({
  ensureProvider: vi.fn().mockResolvedValue(undefined),
  loadTokens: vi.fn().mockResolvedValue({
    accessToken: "110186720",
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00Z"),
    scopes: "ticks",
  }),
  withSyncLog: vi.fn(async (_db, _provider, _type, callback) => (await callback()).result),
  persist: vi.fn(async (_db: SyncDatabase, input: ClimbingLogSyncInput) => ({
    logEntryIds: input.entries.map((entry) => entry.externalId),
    recordsSynced: input.entries.length,
  })),
  captureException: vi.fn(),
}));
vi.mock("../db/tokens.ts", () => ({
  ensureProvider: mocks.ensureProvider,
  loadTokens: mocks.loadTokens,
}));
vi.mock("../db/sync-log.ts", () => ({ withSyncLog: mocks.withSyncLog }));
vi.mock("../db/climbing-log-sync.ts", () => ({ persistClimbingLogEntries: mocks.persist }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));

import { MountainProjectProvider } from "./mountain-project.ts";

function provider(fetchFn: typeof fetch) {
  return new MountainProjectProvider(async (input, init) => {
    const match = /\/api\/v2\/routes\/(\d+)$/.exec(String(input));
    if (match)
      return Response.json({
        id: Number(match[1]),
        title: "Source route",
        parent: { id: 0, name: "" },
      });
    return fetchFn(input, init);
  });
}

const header =
  'Date,Route,Rating,Notes,URL,Pitches,Location,"Avg Stars","Your Stars",Style,"Lead Style","Route Type","Your Rating",Length,"Rating Code"';
function csv(rows: string[]) {
  return [header, ...rows].join("\n");
}
function row(
  style = "Lead",
  qualifier = "Onsight",
  type = "Trad",
  grade = "5.7",
  date = "2026-08-10",
) {
  return `${date},West Overhang,${grade},Source note,https://www.mountainproject.com/route/105751342/west-overhang,1,"Colorado > Boulder > Eldorado Canyon",2.4,-1,${style},${qualifier},${type},,,1800`;
}
function database() {
  return makeTransactionalTestDatabase({
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
  });
}
function run(provider: MountainProjectProvider, db = database()) {
  return provider.sync(
    new SyncRun({
      db,
      userId: "00000000-0000-0000-0000-000000000001",
      window: SyncWindow.full(new Date("2026-08-11T00:00:00Z")),
    }),
  );
}
function entries() {
  const input = mocks.persist.mock.calls[0]?.[1];
  if (!input) throw new Error("Expected source batch");
  return input.entries;
}
afterEach(() => {
  vi.clearAllMocks();
  mocks.loadTokens.mockResolvedValue({
    accessToken: "110186720",
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00Z"),
    scopes: "ticks",
  });
});

describe("MountainProjectProvider", () => {
  it("reads each verified route and ancestor once and keeps native GPS on Areas", async () => {
    const requests: string[] = [];
    const enriched = new MountainProjectProvider(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("tick-export"))
        return new Response(csv([row(), row(), row().replaceAll("105751342", "999")]));
      if (url.includes("/routes/"))
        return Response.json({
          id: Number(url.split("/").at(-1)),
          title: "Route",
          parent: { id: 2, name: "Crag", coordinates: [-120, 35] },
          pitches: 3,
        });
      const id = Number(url.split("/").at(-1));
      return Response.json({
        id,
        title: id === 2 ? "Crag" : "Region",
        parent: { id: id === 2 ? 1 : 0, name: "Region" },
        coordinates: id === 2 ? [-122, 37] : null,
      });
    });
    await expect(run(enriched)).resolves.toMatchObject({ recordsSynced: 3, errors: [] });
    expect(requests.filter((url) => url.includes("/routes/"))).toHaveLength(2);
    expect(requests.filter((url) => url.includes("/areas/"))).toHaveLength(2);
    expect(entries()[0]?.climb).toMatchObject({
      externalId: "105751342",
      areas: [
        { externalId: "1", name: "Region", parentExternalId: null, coordinates: null },
        {
          externalId: "2",
          name: "Crag",
          parentExternalId: "1",
          coordinates: { latitude: 37, longitude: -122 },
        },
      ],
    });
    expect(entries()[0]?.climb?.coordinates).toBeUndefined();
    expect(entries()[0]?.climb?.pitches).toBeUndefined();
    expect(entries()[0]?.raw).toMatchObject({
      Route: "West Overhang",
      sourceProfileId: "110186720",
      sourceEnrichment: { route: { pitches: 3 }, areas: [{ id: 1 }, { id: 2 }] },
    });
  });

  it.each(["failure", "cycle"])(
    "fails before writing any ticks or reconciling on enrichment %s",
    async (mode) => {
      const db = database();
      const result = await run(
        new MountainProjectProvider(async (input) => {
          const url = String(input);
          if (url.includes("tick-export")) return new Response(csv([row()]));
          if (url.includes("/routes/"))
            return Response.json({
              id: 105751342,
              title: "Route",
              parent: { id: 2, name: "Crag" },
            });
          return mode === "failure"
            ? new Response("unavailable", { status: 503 })
            : Response.json({ id: 2, title: "Cycle", parent: { id: 2, name: "Cycle" } });
        }),
        db,
      );
      expect(result).toMatchObject({ recordsSynced: 0, errors: [expect.any(Object)] });
      expect(mocks.persist).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
      expect(mocks.captureException).toHaveBeenCalled();
    },
  );

  it.each([
    { rows: [row()], reconciles: true, synced: 1 },
    { rows: [], reconciles: false, synced: 0 },
    {
      rows: [row(), row("Lead", "Redpoint", "Trad", "5.9", "2026-02-30")],
      reconciles: false,
      synced: 1,
    },
    { rows: [row("Lead", "Redpoint", "Trad", "5.9", "2026-02-30")], reconciles: false, synced: 0 },
  ])(
    "reconciles only complete valid nonempty discovery $reconciles/$synced",
    async ({ rows, reconciles, synced }) => {
      const db = database();
      const result = await run(
        provider(async () => new Response(csv(rows))),
        db,
      );
      expect(result.recordsSynced).toBe(synced);
      expect(db.execute).toHaveBeenCalledTimes(reconciles ? 1 : 0);
    },
  );
  it.each([
    ["https://www.mountainproject.com/route/123/name", "123"],
    ["https://mountainproject.com/route/123", "123"],
    ["http://mountainproject.com/route/123", null],
    ["https://other.example/route/123", null],
    ["https://mountainproject.com/area/123", null],
    ["https://mountainproject.com/prefix/route/123", null],
    ["https://mountainproject.com/route/0", null],
    ["https://mountainproject.com/route/123suffix", null],
    ["malformed", null],
  ])("verifies the route URL %s before assigning a shared target", async (url, target) => {
    const source = row().replace(
      "https://www.mountainproject.com/route/105751342/west-overhang",
      url,
    );
    await run(provider(async () => new Response(csv([source]))));
    expect(entries()[0]?.climb?.externalId).toBe(target);
  });
  it("classifies mixed rock route types and graded boulders while retaining source provenance", async () => {
    await run(
      provider(
        async () =>
          new Response(csv([row("Lead", "", '"Ice, Trad"'), row("Lead", "", "Boulder", "V4")])),
      ),
    );
    expect(entries().map((entry) => [entry.discipline, entry.climb?.kind])).toEqual([
      ["rock_climbing", "route"],
      ["rock_climbing", "boulder"],
    ]);
    expect(entries()[1]?.attempts).toStrictEqual([{ scope: "climb", ropeMethod: null }]);
    expect(entries()[0]?.raw).toMatchObject({
      "Route Type": "Ice, Trad",
      sourceProfileId: "110186720",
    });
  });
  it("connects a public profile through the existing form", async () => {
    const setup = provider(async () => new Response(csv([]))).authSetup();
    expect(setup.manualToken?.kind).toBe("public-profile");
    await expect(
      setup.manualToken?.exchangeToken("https://www.mountainproject.com/user/110186720/example"),
    ).resolves.toMatchObject({ accessToken: "110186720", scopes: "ticks" });
  });
  it("rejects a profile response without a valid tick export", async () => {
    const setup = provider(async () => new Response("<html>Private</html>")).authSetup();
    await expect(setup.manualToken?.exchangeToken("110186720")).rejects.toThrow(
      "Paste your public Mountain Project profile URL",
    );
  });
  it.each([
    ["Lead", { ropeMethod: "lead" }],
    ["TR", { ropeMethod: "top_rope" }],
    ["Follow", { ropeMethod: "follow" }],
    ["Solo", { ropeMethod: null, solo: true }],
    ["Aid", { ropeMethod: null, usedAid: true }],
  ])("maps source method %s independently of result", async (style, facts) => {
    await run(provider(async () => new Response(csv([row(style, "Fell/Hung")]))));
    expect(entries()[0]).toMatchObject({
      attempts: [{ scope: "climb", ...facts, qualifier: "fell-hung" }],
      notes: "Source note",
      discipline: "rock_climbing",
      climb: {
        externalId: "105751342",
        kind: "route",
        name: "West Overhang",
        publishedGrades: [{ value: "5.7", system: "yds" }],
        areas: [
          { name: "Colorado", externalId: null },
          { name: "Boulder", externalId: null },
          { name: "Eldorado Canyon", externalId: null },
        ],
      },
    });
    expect(entries()[0]?.attempts).toStrictEqual([
      { scope: "climb", ...facts, qualifier: "fell-hung" },
    ]);
  });
  it.each([
    ["Sport", ["sport"]],
    ["Trad", ["trad"]],
    ['" sport , TRAD , TR "', ["sport", "trad"]],
    ["Top Rope", []],
    ["", null],
  ])("preserves supplied protection %s", async (type, protection) => {
    await run(provider(async () => new Response(csv([row("Lead", "Redpoint", type)]))));
    expect(entries()[0]?.climb?.routeProtection).toEqual(protection);
  });
  it.each([
    ["Onsight", "free-onsight"],
    ["Flash", "free-flash"],
    ["Redpoint", "free-send"],
    ["Pinkpoint", "free-send"],
    ["Fell/Hung", "fell-hung"],
  ])("maps source qualifier %s to attempt facts", async (source, qualifier) => {
    await run(provider(async () => new Response(csv([row("Lead", source)]))));
    expect(entries()[0]?.attempts[0]?.qualifier).toBe(qualifier);
  });
  it("uses a boulder's source result while leaving rope method unknown", async () => {
    await run(provider(async () => new Response(csv([row("Flash", "", "Boulder", "V4")]))));
    expect(entries()[0]).toMatchObject({
      attempts: [{ scope: "climb", ropeMethod: null, qualifier: "free-flash" }],
      climb: { kind: "boulder", publishedGrades: [{ system: "v_scale", value: "V4" }] },
    });
  });
  it("keeps repeated occurrences separate on one verified climb", async () => {
    const source = row();
    await run(provider(async () => new Response(csv([source, source]))));
    expect(entries()).toHaveLength(2);
    expect(new Set(entries().map((entry) => entry.externalId)).size).toBe(2);
    expect(entries().map((entry) => entry.climb?.externalId)).toEqual(["105751342", "105751342"]);
  });
  it("retains ungraded undated and unknown-system source logs", async () => {
    const result = await run(
      provider(
        async () => new Response(csv([row("", "", "", "", ""), row("Lead", "", "Ice", "WI4")])),
      ),
    );
    expect(result).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(entries()).toEqual([
      expect.objectContaining({
        climbedOn: null,
        climb: expect.objectContaining({ publishedGrades: [] }),
      }),
      expect.objectContaining({
        discipline: null,
        climb: expect.objectContaining({
          publishedGrades: [{ value: "WI4", system: "water_ice" }],
        }),
      }),
    ]);
  });
  it("keeps published compound grades and a separately supplied rating independent", async () => {
    const source = row("Aid", "Flash", "Trad", "5.10 A2").replace(
      "Trad,,,1800",
      "Trad,5.9,100,1800",
    );
    await run(provider(async () => new Response(csv([source]))));
    expect(entries()[0]).toMatchObject({
      reportedGrades: [{ value: "5.9", system: "yds" }],
      climb: {
        publishedGrades: [
          { value: "5.10", system: "yds" },
          { value: "A2", system: "aid" },
        ],
      },
      attempts: [{ scope: "climb", usedAid: true, qualifier: "aid-flash" }],
    });
  });
  it("records Pinkpoint's preplaced protection separately from the route's protection", async () => {
    await run(provider(async () => new Response(csv([row("Lead", "Pinkpoint", "Sport")]))));
    expect(entries()[0]).toMatchObject({
      climb: { routeProtection: ["sport"] },
      attempts: [{ usedPreplacedProtection: true, qualifier: "free-send" }],
    });
  });
  it("rejects malformed supplied dates while preserving the valid records", async () => {
    const result = await run(
      provider(
        async () =>
          new Response(csv([row(), row("Lead", "Redpoint", "Trad", "5.9", "2026-02-30")])),
      ),
    );
    expect(result).toMatchObject({
      recordsSynced: 1,
      errors: [expect.objectContaining({ message: expect.stringContaining("invalid date") })],
    });
    expect(entries()).toHaveLength(1);
  });
  it.each([503, 404])("returns an actionable export failure for HTTP %s", async (status) => {
    const result = await run(provider(async () => new Response("unavailable", { status })));
    expect(result.errors).toHaveLength(1);
    expect(mocks.persist).not.toHaveBeenCalled();
    if (status === 503) expect(mocks.captureException).toHaveBeenCalled();
  });
  it("reports persistence errors with provider context", async () => {
    mocks.persist.mockRejectedValueOnce(new Error("database offline"));
    const result = await run(provider(async () => new Response(csv([row()]))));
    expect(result).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: "database offline" })],
    });
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "database offline" }),
      { tags: { provider: "mountain-project", phase: "climbing_activity" } },
    );
  });
});
