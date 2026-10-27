import { describe, expect, it } from "vitest";
import { parsePublicAscent, parsePublicFeed, publicProfileUsername } from "./public-parsing.ts";
import { gradeCases, publicAscent, publicFeed } from "./test-helpers.ts";

const reference = { id: "1001", accountId: "123", routeId: "2001" };
const parse = (html: string) => parsePublicAscent(html, reference, "sampleclimber");

describe("public profile identity", () => {
  it.each([
    "https://www.thecrag.com/ascents/by/sampleclimber",
    "https://www.thecrag.com/en/ascents/by/sampleclimber",
  ])("extracts the username from the public logbook URL %s", (url) => {
    expect(publicProfileUsername(url)).toBe("sampleclimber");
  });
});

describe("public ascent HTML", () => {
  it.each(gradeCases)("retains grade scale %s", (grade, style, climbedStyle, system, value) => {
    const tick = style === "Boulder" ? "Send" : "Redpoint: Lead";
    expect(
      parse(
        publicAscent({ routeGrade: grade, routeStyle: style, climbedStyle, tick, attempts: "1" }),
      ).climb?.publishedGrades,
    ).toEqual([{ system, value }]);
  });
  it.each([
    ["Ice", "WICE WI4+", "water_ice", "WI4+"],
    ["Alpine", "IFAS AD+", "ifas", "AD+"],
  ])(
    "preserves %s grade and route method without asserting rock discipline",
    (routeStyle, routeGrade, system, value) => {
      const record = parse(
        publicAscent({
          routeStyle,
          routeGrade,
          climbedStyle: "Lead",
          tick: "Redpoint: Lead",
          attempts: "1",
        }),
      );
      expect(record.climb).toMatchObject({ kind: "route", publishedGrades: [{ system, value }] });
      expect(record.attempts[0]?.ropeMethod).toBe("lead");
      expect(record).not.toHaveProperty("discipline");
    },
  );
  it.each(["19", "6a", "5.99", "FR nonsense"])(
    "preserves unknown grade %s as raw text",
    (grade) => {
      expect(parse(publicAscent({ routeGrade: grade })).climb?.publishedGrades).toEqual([
        { system: null, value: grade },
      ]);
    },
  );
  it.each([
    ["Free solo", "unroped"],
    ["Follow", "follow"],
  ])("retains explicit method %s", (method, ropeMethod) => {
    expect(
      parse(publicAscent({ tick: `Send: ${method}`, climbedStyle: method, attempts: "1" }))
        .attempts[0],
    ).toMatchObject({
      ropeMethod,
    });
  });
  it.each([
    ["Lead solo", "Sport", "lead"],
    ["Top rope solo", "Trad", "top_rope"],
    ["Lead solo: Sport", "Sport", "lead"],
    ["Top rope solo: Trad", "Trad", "top_rope"],
    ["Redpoint: Lead solo", "Sport", "lead"],
    ["Lead solo: Lead", "Sport", "lead"],
  ])("retains explicit solo evidence from tick %s", (tick, climbedStyle, ropeMethod) => {
    const record = parse(
      publicAscent({ tick, climbedStyle, routeStyle: climbedStyle, attempts: "1" }),
    );
    expect(record.attempts[0]).toMatchObject({ sourceResult: tick, ropeMethod, solo: true });
    expect(record.climb?.kind).toBe("route");
  });
  it("identifies a route from its explicit tick method when gear style is unavailable", () => {
    const record = parse(
      publicAscent({ tick: "Lead solo", climbedStyle: "", routeStyle: "", attempts: "1" }),
    );
    expect(record.climb?.kind).toBe("route");
    expect(record.attempts[0]).toMatchObject({ ropeMethod: "lead", solo: true });
  });
  it.each([
    { tick: "Lead solo: Top rope", climbedStyle: "Sport" },
    { tick: "Lead solo: Sport", climbedStyle: "Top rope" },
  ])("rejects conflicting explicit methods %j", (overrides) => {
    expect(() => parse(publicAscent({ ...overrides, attempts: "1" }))).toThrow(
      /conflicting.*methods/i,
    );
  });
  it("does not spread an individual solo tick's method across its reported count", () => {
    expect(() =>
      parse(publicAscent({ tick: "Lead solo: Sport", climbedStyle: "Sport", routeStyle: "Sport" })),
    ).toThrow(/method.*reported attempt total/i);
  });
  it("clears the reported-grade override when the ascent explicitly inherits its route grade", () => {
    expect(parse(publicAscent()).reportedGrades).toEqual([]);
  });
  it.each([
    publicAscent({ ascentGrade: "" }),
    publicAscent().replace(
      "<dt><label>Ascent grade</label></dt><dd>-- Inherits from route --</dd>",
      "",
    ),
  ])("preserves a reported-grade override when its public field is unavailable", (html) => {
    expect(parse(html)).not.toHaveProperty("reportedGrades");
  });
  it("does not infer a reported result's per-attempt qualifier from a total count", () => {
    const record = parse(
      publicAscent({ tick: "Onsight: Lead", climbedStyle: "Lead", attempts: "1" }),
    );
    expect(record.attempts).toEqual([expect.objectContaining({ sourceResult: "Onsight: Lead" })]);
    expect(record.attempts[0]).not.toHaveProperty("attemptIndex");
  });
  it("preserves public source line breaks", () => {
    expect(parse(publicAscent({ comment: "First line<br>Second line" })).notes).toBe(
      "First line\nSecond line",
    );
  });
  it("requires a verified ascent identity on the detail page", () => {
    expect(() => parse(publicAscent().replace(/<link rel="canonical"[^>]*>/, ""))).toThrow(
      /identity/i,
    );
  });
  it("rejects contradictory gear styles and grade scales", () => {
    expect(() => parse(publicAscent({ routeStyle: "Boulder" }))).toThrow(/discipline/i);
    expect(() => parse(publicAscent({ routeGrade: "V4" }))).toThrow(/grade/i);
  });
  it.each(["Sport", "Trad"])("requires direct rope-method evidence for %s protection", (style) => {
    expect(() =>
      parse(publicAscent({ tick: "Attempt", climbedStyle: style, routeStyle: style })),
    ).toThrow(/method/i);
    expect(() =>
      parse(publicAscent({ tick: `Attempt: ${style}`, climbedStyle: style, routeStyle: style })),
    ).toThrow(/method/i);
  });
  it("rejects disagreement between tick method and ascent-wide climbed method", () => {
    expect(() => parse(publicAscent({ tick: "Redpoint: Lead", climbedStyle: "Top rope" }))).toThrow(
      /method/i,
    );
  });
  it("retains reported-count placeholders with only the ascent-wide method", () => {
    const record = parse(publicAscent({ tick: "Redpoint: Top rope" }));
    expect(record.attempts).toHaveLength(4);
    expect(record.attempts[0]).toMatchObject({
      sourceResult: "Redpoint: Top rope",
      qualifier: "free-send",
      ropeMethod: "top_rope",
    });
    expect(record.attempts.slice(1)).toEqual(
      Array.from({ length: 3 }, () => ({ scope: "climb", ropeMethod: "top_rope" })),
    );
    expect(record.reportedAttemptCounts).toEqual([{ scope: "climb", count: 4 }]);
  });
  it("does not assume one described tick's method covers the reported total", () => {
    expect(() =>
      parse(publicAscent({ tick: "Redpoint: Lead", climbedStyle: "Sport", routeStyle: "Sport" })),
    ).toThrow(/method/i);
  });
});

describe("public Atom feed", () => {
  it("rejects DTDs without expanding external resources", () => {
    expect(() =>
      parsePublicFeed(
        `<!DOCTYPE feed SYSTEM "https://example.test/private">${publicFeed()}`,
        "123",
      ),
    ).toThrow(/malformed/i);
  });
  it("requires usable pagination href and event IDs", () => {
    expect(() =>
      parsePublicFeed(publicFeed().replace("<id>https", '<link rel="next"/><id>https'), "123"),
    ).toThrow(/pagination/i);
    expect(() => parsePublicFeed(publicFeed().replace('data-ascent-id="1001"', ""), "123")).toThrow(
      /identifiers/i,
    );
  });
});
