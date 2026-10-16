import { describe, expect, it } from "vitest";
import { climbingSourceLinks } from "./climbing-source-links.ts";

const routeUrl = "https://www.mountainproject.com/route/105734732/swiss-cheese";
const uuid = "10000000-0000-4000-8000-000000000001";

describe("climbingSourceLinks", () => {
  it("uses the recorded Mountain Project route and public profile for its tick list", () => {
    expect(
      climbingSourceLinks("mountain-project", { URL: routeUrl, sourceProfileId: "110186720" }),
    ).toEqual([
      { providerId: "mountain-project", kind: "route", url: routeUrl },
      {
        providerId: "mountain-project",
        kind: "ticks",
        url: "https://www.mountainproject.com/user/110186720/ticks/ticks",
      },
    ]);
    expect(climbingSourceLinks("mountain-project", { URL: routeUrl })).toEqual([
      { providerId: "mountain-project", kind: "route", url: routeUrl },
    ]);
  });

  it("links an OpenBeta UUID and the source user's logbook", () => {
    expect(
      climbingSourceLinks("openbeta", {
        climb: { uuid },
        user: { username: "thickles" },
        _id: "tick-id",
      }),
    ).toEqual([
      { providerId: "openbeta", kind: "route", url: `https://openbeta.io/climb/${uuid}` },
      { providerId: "openbeta", kind: "ticks", url: "https://openbeta.io/u/thickles/ticks" },
    ]);
    expect(climbingSourceLinks("openbeta", { climbId: uuid, source: "OB" })).toEqual([
      { providerId: "openbeta", kind: "route", url: `https://openbeta.io/climb/${uuid}` },
    ]);
  });
  it("retains usable OpenBeta references when optional upstream fields are null", () => {
    expect(
      climbingSourceLinks("openbeta", {
        climb: { uuid },
        climbId: null,
        source: null,
        user: { username: null },
      }),
    ).toEqual([
      { providerId: "openbeta", kind: "route", url: `https://openbeta.io/climb/${uuid}` },
    ]);
    expect(
      climbingSourceLinks("openbeta", {
        climb: { uuid: null },
        climbId: uuid,
        source: "OB",
        user: null,
      }),
    ).toEqual([
      { providerId: "openbeta", kind: "route", url: `https://openbeta.io/climb/${uuid}` },
    ]);
  });

  it.each([
    { climb: { id: "1062267", slug: "Cragmont-Crack-5.6-Berkeley-7599113" } },
    { id: "1062267", slug: "Cragmont-Crack-5.6-Berkeley-7599113" },
  ])("uses Kaya's actual route slug for ascents and attempted climbs", (raw) => {
    expect(climbingSourceLinks("kaya", raw)).toEqual([
      {
        providerId: "kaya",
        kind: "route",
        url: "https://kaya-app.kayaclimb.com/climb/Cragmont-Crack-5.6-Berkeley-7599113",
      },
    ]);
  });

  it.each([
    ["mountain-project", { URL: "javascript:alert(1)" }],
    ["mountain-project", { URL: "https://www.mountainproject.com.evil.test/route/123/name" }],
    ["mountain-project", { URL: "https://evil.test/route/123/name" }],
    ["mountain-project", { URL: "https://user:password@www.mountainproject.com/route/123/name" }],
    [
      "mountain-project",
      { URL: "https://www.mountainproject.com/route/not-an-id/name", sourceProfileId: "bad/id" },
    ],
    ["openbeta", { climbId: "105734732", source: "MP" }],
    ["openbeta", { climbId: uuid, source: "MP" }],
    ["openbeta", { climb: { uuid: "../route" }, user: { username: "../someone" } }],
    ["kaya", { climb: { id: "7599113", name: "Cragmont Crack" }, id: "ascent-id" }],
    ["kaya", { slug: ".." }],
    ["kaya", { slug: "\ud800" }],
    ["kaya", { slug: " " }],
    ["kaya", { slug: "route\nname" }],
    ["kaya-export", { slug: "some-slug", URL: routeUrl }],
    ["unknown", { URL: routeUrl }],
    ["mountain-project", null],
    ["openbeta", []],
  ])("omits unverified destinations for %s", (provider, raw) => {
    expect(climbingSourceLinks(provider, raw)).toEqual([]);
  });
});
