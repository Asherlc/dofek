import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import type { createMockDatabase } from "../test-helpers.ts";

export function publicFeed(
  items: { id?: string; accountId?: string; routeId?: string }[] = [{}],
  options: { accountId?: string; next?: string } = {},
): string {
  const base = `https://www.thecrag.com/feed/ascents/climber/${options.accountId ?? "123"}`;
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <id>${base}</id><link rel="self" href="${base}"/>
  ${options.next ? `<link rel="next" href="${options.next.replaceAll("&", "&amp;")}"/>` : ""}
  ${items
    .map(
      (
        item,
        index,
      ) => `<entry><id>thecrag.com:${9000 + index}</id><updated>2026-10-11T00:00:00Z</updated><content type="html"><![CDATA[
  <div class="event-item" data-ascent-id="${item.id ?? "1001"}" data-ascent-uid="${item.accountId ?? "123"}" data-node-id="${item.routeId ?? "2001"}" data-route-url="/en/climbing/test/route/${item.routeId ?? "2001"}">Public event</div>
  ]]></content></entry>`,
    )
    .join("")}</feed>`;
}

export function publicAscent(
  overrides: {
    id?: string;
    username?: string;
    routeId?: string;
    routeName?: string;
    date?: string;
    tick?: string;
    climbedStyle?: string;
    routeStyle?: string;
    routeGrade?: string;
    ascentGrade?: string;
    attempts?: string;
    comment?: string;
  } = {},
): string {
  const value = {
    id: "1001",
    username: "sampleclimber",
    routeId: "2001",
    routeName: "Sample route",
    date: "2026-10-10",
    tick: "Attempt: Top rope",
    climbedStyle: "Top rope",
    routeStyle: "Top rope",
    routeGrade: "5.10b",
    ascentGrade: "-- Inherits from route --",
    attempts: "4",
    comment: "",
    ...overrides,
  };
  return `<!doctype html><html><head><link rel="canonical" href="https://www.thecrag.com/en/ascent/${value.id}"></head><body><form><fieldset><legend>Ascent details</legend><dl>
  <dt><label>Account</label></dt><dd><span class="climber"><a href="/climber/${value.username}">Sample climber</a></span></dd>
  <dt><label>Route</label></dt><dd><span class="route"><a href="/en/climbing/test/route/${value.routeId}"><span class="star">★</span> ${value.routeName}</a></span></dd>
  <dt><label>Route gear style</label></dt><dd><span class="tags">${value.routeStyle}</span><span class="attr">15m</span></dd>
  <dt><label>Climbed gear style</label></dt><dd><span class="tags">${value.climbedStyle}</span></dd>
  <dt><label>Tick</label></dt><dd><span class="tick_attempt" title="${value.tick}"></span></dd>
  <dt><label>Ascent date</label></dt><dd>${value.date}</dd>
  <dt><label>Log date</label></dt><dd>2026-10-11</dd>
  <dt><label>Route grade</label></dt><dd><span>${value.routeGrade}</span></dd>
  <dt><label>Ascent grade</label></dt><dd>${value.ascentGrade}</dd>
  <dt><label>Attempts</label></dt><dd>${value.attempts}</dd>
  <dt><label>Comment</label></dt><dd><div class="markdown">${value.comment}</div></dd>
  </dl></fieldset></form></body></html>`;
}

export function lookupResponse(username = "sampleclimber", accountId = "123"): Response {
  return Response.json({ data: [{ id: accountId, login: username }] });
}

export function tokens(accountId = "123") {
  return {
    accessToken: "sampleclimber",
    refreshToken: null,
    expiresAt: new Date("2099-12-31T00:00:00.000Z"),
    scopes: "thecrag:public-profile",
    providerAccountId: accountId,
  };
}

export function makeRun(
  database: ReturnType<typeof createMockDatabase>["db"],
  options: { full?: boolean; origin?: "scheduled" | "manual"; userId?: string | null } = {},
): SyncRun {
  return new SyncRun({
    db: database,
    window:
      options.full === false
        ? SyncWindow.fromDateRange({ sinceDate: "2026-10-01", untilDate: "2026-10-11" })
        : SyncWindow.full(new Date("2026-10-11T23:59:59.999Z")),
    userId:
      options.userId === null
        ? undefined
        : (options.userId ?? "00000000-0000-0000-0000-000000000001"),
    origin: options.origin,
  });
}

export const gradeCases = [
  ["V4", "Boulder", "boulder", "v_scale", "V4"],
  [" V10 ", "Boulder", "boulder", "v_scale", "V10"],
  ["VB+", "Boulder", "boulder", "v_scale", "VB+"],
  ["5.10a", "Sport", "sport", "yds", "5.10a"],
  ["FR 6a", "Sport", "sport", "french", "6a"],
  ["FB 6A", "Boulder", "boulder", "font", "6A"],
  ["AU 19", "Trad", "trad", "ewbank", "19"],
  ["UIAA 7", "Trad", "trad", "uiaa", "7"],
  ["FR:6a", "Sport", "sport", "french", "6a"],
  ["FB:6A", "Boulder", "boulder", "font", "6A"],
  ["AU:19", "Trad", "trad", "ewbank", "19"],
  ["UIAA:7", "Trad", "trad", "uiaa", "7"],
  ["YDS:5.10a", "Sport", "sport", "yds", "5.10a"],
  ["BLDV:V3", "Boulder", "boulder", "v_scale", "V3"],
  ["FR:  6a", "Sport", "sport", "french", "6a"],
  ["FR \n6a", "Sport", "sport", "french", "6a"],
  ["AID A2", "Aid", "aid", "aid", "A2"],
  ["AIDC C2+", "Aid", "aid", "aid", "C2+"],
  ["WICE WI4+", "Ice", "ice", "water_ice", "WI4+"],
  ["AICE AI3", "Ice", "ice", "alpine_ice", "AI3"],
  ["MIXED M6+", "Mixed", "mixed", "mixed", "M6+"],
  ["IFAS AD+", "Alpine", "alpine", "ifas", "AD+"],
  ["NCCS VI", "Alpine", "alpine", "nccs", "VI"],
  ["UK E3", "Trad", "trad", "british_adjectival", "E3"],
  ["UKT 5c", "Trad", "trad", "british_technical", "5c"],
];
