import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parsePublicAscent,
  parsePublicFeed,
  publicFeedUrl,
  publicProfileAccount,
  publicProfileUsername,
} from "./public-parsing.ts";
import { gradeCases, publicAscent, publicFeed } from "./test-helpers.ts";

const mocks = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("../../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));
afterEach(() => vi.clearAllMocks());

const reference = { id: "1001", accountId: "123", routeId: "2001" };
const parse = (html: string) => parsePublicAscent(html, reference, "sampleclimber");
const field = (html: string, label: string, value: string | null) =>
  html.replace(
    new RegExp(`<dt><label>${label}</label></dt><dd>[\\s\\S]*?</dd>`),
    value === null ? "" : `<dt><label>${label}</label></dt><dd>${value}</dd>`,
  );

describe("public profile identity", () => {
  it.each(["a", "a_B-12", "123", " sampleclimber \n"])("accepts username %j", (input) => {
    expect(publicProfileUsername(input)).toBe(input.trim());
  });
  it.each([
    "https://www.thecrag.com/climber/a_B-12",
    "https://www.thecrag.com/en/climber/a_B-12/",
    "https://www.thecrag.com/ascents/by/a_B-12/",
  ])("accepts profile URL %s", (input) => {
    expect(publicProfileUsername(input)).toBe("a_B-12");
  });
  it.each([
    "",
    "?sampleclimber",
    "sampleclimber?",
    "sample climber",
    "/climber/sampleclimber",
    "https://example.test/climber/sampleclimber",
    "http://www.thecrag.com/climber/sampleclimber",
    "https://user@www.thecrag.com/climber/sampleclimber",
    "https://:password@www.thecrag.com/climber/sampleclimber",
    "https://www.thecrag.com/climber/sampleclimber?foo=1",
    "https://www.thecrag.com/climber/sampleclimber#logbook",
    "https://www.thecrag.com/prefix/climber/sampleclimber",
    "https://www.thecrag.com/climber/sampleclimber/extra",
    "https://www.thecrag.com/climber/a.b",
  ])("rejects ambiguous or untrusted identity %j", (input) => {
    expect(() => publicProfileUsername(input)).toThrow(/Enter your public theCrag username/);
  });
  it.each(["1", "12", "12345"])("verifies exact lookup account %s", (id) => {
    expect(
      publicProfileAccount(
        {
          data: [
            { id, login: "sampleclimber" },
            { id: "42", login: "other" },
          ],
        },
        "sampleclimber",
      ),
    ).toBe(id);
  });
  it.each([
    undefined,
    {},
    { data: [] },
    { data: [{ id: "123", login: "SampleClimber" }] },
    {
      data: [
        { id: "123", login: "sampleclimber" },
        { id: "124", login: "sampleclimber" },
      ],
    },
    ...["0", "01", "-1", "x12", "12x", "1x", ""].map((id) => ({
      data: [{ id, login: "sampleclimber" }],
    })),
  ])("rejects unverifiable account lookup %j", (body) => {
    expect(() => publicProfileAccount(body, "sampleclimber")).toThrow(
      /could not verify this public profile account/,
    );
  });
  it("builds the account feed URL", () => {
    expect(publicFeedUrl("123")).toBe("https://www.thecrag.com/feed/ascents/climber/123");
  });
  it.each([
    "https://www.thecrag.com/ascents/by/sampleclimber",
    "https://www.thecrag.com/en/ascents/by/sampleclimber",
  ])("extracts the username from the public logbook URL %s", (url) => {
    expect(publicProfileUsername(url)).toBe("sampleclimber");
  });
});

describe("public ascent HTML", () => {
  it("retains rock discipline when only the route identifies rock protection", () => {
    expect(
      parse(
        publicAscent({
          routeStyle: "Sport",
          climbedStyle: "Lead",
          tick: "Redpoint: Lead",
          attempts: "1",
        }),
      ).discipline,
    ).toBe("rock_climbing");
  });
  it("does not derive solo status from an unrecognized result containing the word", () => {
    expect(
      parse(publicAscent({ tick: "Assisted solo: Lead", climbedStyle: "Lead", attempts: "1" }))
        .attempts,
    ).toEqual([{ scope: "climb", sourceResult: "Assisted solo", ropeMethod: "lead" }]);
  });
  it("does not publish an inherited route grade as literal grade text", () => {
    expect(parse(publicAscent({ routeGrade: "-- Inherits from route --" })).climb).toEqual({
      externalId: "2001",
      name: "Sample route",
      kind: "route",
    });
  });
  it("normalizes surrounding label, legend, style, and tick whitespace", () => {
    const html = publicAscent({
      routeStyle: " Trad ",
      climbedStyle: " Trad ",
      tick: "  Redpoint  : LEAD  ",
      attempts: "1",
    })
      .replace("<legend>Ascent details</legend>", "<legend>  Ascent details  </legend>")
      .replace("<label>Attempts</label>", "<label>  Attempts  </label>");
    expect(parse(html)).toMatchObject({
      climb: { routeProtection: ["trad"] },
      attempts: [
        {
          sourceResult: "Redpoint",
          protectionUsed: ["trad"],
          ropeMethod: "lead",
          qualifier: "free-send",
        },
      ],
      raw: { tick: "Redpoint  : LEAD" },
      reportedAttemptCounts: [{ scope: "climb", count: 1 }],
    });
  });
  it("retains canonical identity, route name, and trimmed source fields", () => {
    const record = parse(
      publicAscent({ routeName: "  A route  ", comment: "  A note  ", attempts: " 1 " }),
    );
    expect(record).toMatchObject({
      externalId: "thecrag:1001",
      climbedOn: "2026-10-10",
      sourceName: "theCrag",
      discipline: "rock_climbing",
      notes: "A note",
      climb: { externalId: "2001", name: "A route", kind: "route" },
      raw: { accountId: "123", ascentId: "1001", routeId: "2001", publicFields: { Attempts: "1" } },
    });
    expect(record.attempts).toEqual([
      { scope: "climb", sourceResult: "Attempt", ropeMethod: "top_rope" },
    ]);
  });
  it.each(["<p>First paragraph</p><p>Second paragraph</p>", "First paragraph<br>Second paragraph"])(
    "preserves note structure %s",
    (comment) => {
      expect(parse(publicAscent({ comment })).notes).toBe("First paragraph\nSecond paragraph");
    },
  );
  it("accepts absent optional fields without inventing values", () => {
    let html = publicAscent({ routeGrade: "", routeName: "", attempts: "" });
    for (const label of ["Comment", "Ascent grade", "Route grade", "Attempts", "Route gear style"])
      html = field(html, label, null);
    const record = parse(html);
    expect(record.attempts).toEqual([
      { scope: "climb", sourceResult: "Attempt", ropeMethod: "top_rope" },
    ]);
    expect(record.climb).toEqual({ externalId: "2001", kind: "route" });
    expect(record).not.toHaveProperty("notes");
    expect(record).not.toHaveProperty("reportedAttemptCounts");
  });
  it.each([
    ["2026-10-10T23:59:59Z", "2026-10-10"],
    ["2026-10-10T23:59:59", "2026-10-10"],
    [
      '<time datetime="2026-10-09T23:00:00-07:00" data-date="2026-10-08">October</time>',
      "2026-10-09",
    ],
    ['<span data-date="2026-10-08">October</span>', "2026-10-08"],
    [" 2026-10-10 ", "2026-10-10"],
  ])("preserves exact source climb day %s", (date, day) => {
    expect(parse(publicAscent({ date })).climbedOn).toBe(day);
  });
  it.each(["", "2026-10", "2026-02-30", "0000-10-10", "2026-10-10garbage", "2026-10-10T99:00:00Z"])(
    "rejects incomplete or invalid climb date %j",
    (date) => {
      expect(() => parse(publicAscent({ date }))).toThrow(
        /ascent 1001 has an incomplete or invalid climb date/,
      );
    },
  );
  it("requires the climb date field", () => {
    expect(() => parse(field(publicAscent(), "Ascent date", null))).toThrow(/invalid climb date/);
  });
  it.each([
    [
      "fieldset missing",
      (html: string) => html.replaceAll("fieldset", "section"),
      /blocked or unavailable/,
    ],
    [
      "wrong legend",
      (html: string) => html.replace("Ascent details", "Log details"),
      /blocked or unavailable/,
    ],
    [
      "duplicate details",
      (html: string) =>
        html.replace("</form>", "<fieldset><legend>Ascent details</legend></fieldset></form>"),
      /blocked or unavailable/,
    ],
    [
      "duplicate field",
      (html: string) => html.replace("</dl>", "<dt><label>Attempts</label></dt><dd>1</dd></dl>"),
      /duplicate public ascent fields/,
    ],
    [
      "missing field value",
      (html: string) =>
        html.replace(
          "<dt><label>Attempts</label></dt><dd>4</dd>",
          "<dt><label>Attempts</label></dt>",
        ),
      /invalid public ascent field/,
    ],
    [
      "missing owner",
      (html: string) => field(html, "Account", null),
      /different public ascent account/,
    ],
    [
      "wrong owner",
      (html: string) => html.replace("/climber/sampleclimber", "/climber/other"),
      /different public ascent account/,
    ],
    [
      "wrong ascent",
      (html: string) => html.replace("/ascent/1001", "/ascent/1002"),
      /different public ascent identity/,
    ],
    [
      "external ascent",
      (html: string) =>
        html.replace("https://www.thecrag.com/en/ascent", "https://example.test/en/ascent"),
      /different public ascent identity/,
    ],
    [
      "conflicting form id",
      (html: string) => html.replace("</form>", '<input id="msgf_ref" value="1002"></form>'),
      /different public ascent identity/,
    ],
    [
      "missing route",
      (html: string) => field(html, "Route", null),
      /different public route identity/,
    ],
    [
      "duplicate routes",
      (html: string) =>
        field(
          html,
          "Route",
          '<span class="route"><a href="/route/2001">One</a><a href="/route/2001">Two</a></span>',
        ),
      /different public route identity/,
    ],
    [
      "missing route href",
      (html: string) => field(html, "Route", '<span class="route"><a>One</a></span>'),
      /different public route identity/,
    ],
    [
      "wrong route",
      (html: string) => html.replace("/route/2001", "/route/2002"),
      /different public route identity/,
    ],
    ["missing tick", (html: string) => field(html, "Tick", null), /no public tick result/],
  ])("rejects %s", (_name, transform, error) => {
    expect(() => parse(transform(publicAscent()))).toThrow(error);
  });
  it.each(["/ascent/1001/", "/en/ascent/1001/"])("accepts verified canonical path %s", (url) => {
    expect(
      parse(publicAscent().replace("https://www.thecrag.com/en/ascent/1001", url)).externalId,
    ).toBe("thecrag:1001");
  });
  it("accepts a verified form identity when canonical metadata is unavailable", () => {
    expect(
      parse(
        publicAscent().replace(/<link rel="canonical"[^>]*>/, '<input id="msgf_ref" value="1001">'),
      ).externalId,
    ).toBe("thecrag:1001");
  });
  it("uses visible tick text when a title is unavailable", () => {
    expect(
      parse(field(publicAscent({ attempts: "1" }), "Tick", "  Redpoint: Top rope  ")).attempts[0],
    ).toEqual({
      scope: "climb",
      sourceResult: "Redpoint",
      ropeMethod: "top_rope",
      qualifier: "free-send",
    });
  });
  it.each(["0", "01", "-1", "1.5", "1e2", "x12", "12x", "9007199254740992"])(
    "rejects invalid attempt count %s",
    (attempts) => {
      expect(() => parse(publicAscent({ attempts }))).toThrow(/invalid reported attempt count/);
    },
  );
  it.each(["1", "2", "12"])(
    "expands route attempt count %s without assigning outcomes to placeholders",
    (attempts) => {
      const record = parse(publicAscent({ attempts }));
      expect(record.attempts).toEqual([
        { scope: "climb", sourceResult: "Attempt", ropeMethod: "top_rope" },
        ...Array.from({ length: Number(attempts) - 1 }, () => ({
          scope: "climb",
          ropeMethod: "top_rope",
        })),
      ]);
      expect(record.reportedAttemptCounts).toEqual([{ scope: "climb", count: Number(attempts) }]);
    },
  );
  it("keeps boulder attempt totals separate from the described tick", () => {
    const record = parse(
      publicAscent({
        routeStyle: "Boulder",
        climbedStyle: "Boulder",
        routeGrade: "V4",
        tick: "Send",
        attempts: "4",
      }),
    );
    expect(record).toMatchObject({
      discipline: "rock_climbing",
      climb: { kind: "boulder" },
      attempts: [{ scope: "climb", sourceResult: "Send", qualifier: "free-send" }],
      reportedAttemptCounts: [{ scope: "climb", count: 4 }],
    });
  });
  it.each(["Top-rope", "Lead", "Unroped", "Solo", "Second", "Top-rope solo"])(
    "recognizes exact recorded method %s",
    (method) => {
      const ropeMethod = method.startsWith("Top-")
        ? "top_rope"
        : method === "Lead"
          ? "lead"
          : method === "Second"
            ? "follow"
            : "unroped";
      expect(
        parse(publicAscent({ tick: method, climbedStyle: "", routeStyle: "", attempts: "1" }))
          .attempts[0],
      ).toEqual({
        scope: "climb",
        sourceResult: method,
        ropeMethod,
        ...(method.toLowerCase().includes("solo") ? { solo: true } : {}),
      });
    },
  );
  it.each([
    "Must lead",
    "Must top rope",
    "Must free solo",
    "Must follow",
    "Lead again",
    "Top roped",
    "Top rope again",
    "Soloist",
    "Free soloist",
    "Following",
  ])("does not mistake %s for a recorded method", (tick) => {
    expect(() =>
      parse(publicAscent({ tick, climbedStyle: "", routeStyle: "", attempts: "1" })),
    ).toThrow(/no recorded climbing method/);
  });
  it.each(["Sport", "Trad"])("retains %s protection without deriving its method", (style) => {
    const record = parse(
      publicAscent({
        routeStyle: style,
        climbedStyle: style,
        tick: "Redpoint: Lead",
        attempts: "1",
      }),
    );
    expect(record.climb?.routeProtection).toEqual([style.toLowerCase()]);
    expect(record.attempts[0]).toMatchObject({
      protectionUsed: [style.toLowerCase()],
      ropeMethod: "lead",
    });
  });
  it.each([
    ["Onsight", "free-onsight", {}],
    ["On sight", "free-onsight", {}],
    ["Flash", "free-flash", {}],
    ["Clean", "free-send", {}],
    ["Send", "free-send", {}],
    ["Greenpoint", "free-send", {}],
    ["Repeat", "free-send", { hadCompletedBefore: true }],
    ["Ground-up redpoint", "free-send", { priorFailedAttemptsGroundUp: true }],
    ["Pinkpoint", "free-send", { usedPreplacedProtection: true }],
    ["Fell/hung", "fell-hung", {}],
    ["Dab", "dab", {}],
    ["Dog", undefined, { fellOrHung: true }],
    ["Hang dog", undefined, { fellOrHung: true }],
    ["French free", undefined, { usedAid: true }],
    ["Frenchfree", undefined, { usedAid: true }],
    ["Aid onsight", "aid-onsight", { usedAid: true }],
    ["Aid flash", "aid-flash", { usedAid: true }],
  ])("preserves tick semantics for %s", (result, qualifier, facts) => {
    expect(
      parse(publicAscent({ tick: `${result}: Lead`, climbedStyle: "Lead", attempts: "1" }))
        .attempts,
    ).toEqual([
      {
        scope: "climb",
        sourceResult: result,
        ropeMethod: "lead",
        ...(qualifier ? { qualifier } : {}),
        ...facts,
      },
    ]);
  });
  it.each([
    ["Onsight", "aid-onsight"],
    ["On sight", "aid-onsight"],
    ["Flash", "aid-flash"],
    ["Redpoint", undefined],
    ["Attempt", undefined],
  ])("uses aid semantics for %s when aid is explicitly recorded", (result, qualifier) => {
    expect(
      parse(
        publicAscent({
          tick: `${result}: Lead`,
          climbedStyle: "Aid",
          routeStyle: "Aid",
          attempts: "1",
        }),
      ).attempts,
    ).toEqual([
      {
        scope: "climb",
        sourceResult: result,
        ropeMethod: "lead",
        usedAid: true,
        ...(qualifier ? { qualifier } : {}),
      },
    ]);
  });
  it.each(gradeCases)("retains grade scale %s", (grade, style, climbedStyle, system, value) => {
    const tick = style === "Boulder" ? "Send" : "Redpoint: Lead";
    expect(
      parse(
        publicAscent({ routeGrade: grade, routeStyle: style, climbedStyle, tick, attempts: "1" }),
      ).climb?.publishedGrades,
    ).toEqual([{ system, value }]);
  });
  it.each([
    [
      "5.10a FR 6a",
      [
        { system: "yds", value: "5.10a" },
        { system: "french", value: "6a" },
      ],
    ],
    [
      "FR:6a   AU:19",
      [
        { system: "french", value: "6a" },
        { system: "ewbank", value: "19" },
      ],
    ],
    [
      "FR : 6a AU : 19",
      [
        { system: "french", value: "6a" },
        { system: "ewbank", value: "19" },
      ],
    ],
    [
      "FR\t6a AU\t19",
      [
        { system: "french", value: "6a" },
        { system: "ewbank", value: "19" },
      ],
    ],
    [
      "fr:6a uk:E3 ukt:5c",
      [
        { system: "french", value: "6a" },
        { system: "british_adjectival", value: "E3" },
        { system: "british_technical", value: "5c" },
      ],
    ],
  ])("retains each explicitly published grade in %s", (routeGrade, expected) => {
    expect(parse(publicAscent({ routeGrade })).climb?.publishedGrades).toEqual(expected);
  });
  it.each(["V4 FB:6B", "VB FB 6B"])("retains multiple boulder scales in %s", (routeGrade) => {
    const [v, font] = routeGrade === "V4 FB:6B" ? ["V4", "6B"] : ["VB", "6B"];
    expect(
      parse(
        publicAscent({ routeGrade, routeStyle: "Boulder", climbedStyle: "Boulder", tick: "Send" }),
      ).climb?.publishedGrades,
    ).toEqual([
      { system: "v_scale", value: v },
      { system: "font", value: font },
    ]);
  });
  it.each([
    "mystery FR 6a AU 19",
    "prefixFR:6a",
    "FRinvalid:6a",
    "FRinvalid:6a AU:19",
    "5.10a AUinvalid:19",
    "V4extra",
    "FR:6a\ntrailing",
  ])("keeps ambiguous grade text intact: %s", (routeGrade) => {
    expect(parse(publicAscent({ routeGrade })).climb?.publishedGrades).toEqual([
      { system: null, value: routeGrade },
    ]);
  });
  it("retains a separately reported ascent grade", () => {
    expect(
      parse(publicAscent({ ascentGrade: " FR:6b ", routeGrade: "5.10a" })).reportedGrades,
    ).toEqual([{ system: "french", value: "6b" }]);
  });
  it.each(["5.10a", "FR 6a"])("rejects route grade %s on a boulder", (routeGrade) => {
    expect(() =>
      parse(
        publicAscent({ routeGrade, routeStyle: "Boulder", climbedStyle: "Boulder", tick: "Send" }),
      ),
    ).toThrow(/unsupported or ambiguous grade/);
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
    ["Lead solo", "Sport", "lead", "Lead solo"],
    ["Top rope solo", "Trad", "top_rope", "Top rope solo"],
    ["Lead solo: Sport", "Sport", "lead", "Lead solo"],
    ["Top rope solo: Trad", "Trad", "top_rope", "Top rope solo"],
    ["Redpoint: Lead solo", "Sport", "lead", "Redpoint"],
    ["Lead solo: Lead", "Sport", "lead", "Lead solo"],
  ])(
    "retains explicit solo evidence from tick %s",
    (tick, climbedStyle, ropeMethod, sourceResult) => {
      const record = parse(
        publicAscent({ tick, climbedStyle, routeStyle: climbedStyle, attempts: "1" }),
      );
      expect(record.attempts[0]).toMatchObject({ sourceResult, ropeMethod, solo: true });
      expect(record.climb?.kind).toBe("route");
    },
  );
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
    expect(record.attempts).toEqual([expect.objectContaining({ sourceResult: "Onsight" })]);
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
      sourceResult: "Redpoint",
      qualifier: "free-send",
      ropeMethod: "top_rope",
    });
    expect(record.attempts.slice(1)).toEqual(
      Array.from({ length: 3 }, () => ({ scope: "climb", ropeMethod: "top_rope" })),
    );
    expect(record.reportedAttemptCounts).toEqual([{ scope: "climb", count: 4 }]);
  });
  it.each([
    ["Redpoint: Top rope", "Redpoint"],
    ["Attempt: Top rope", "Attempt"],
    ["rEdPoInT  : Top rope", "rEdPoInT"],
  ])(
    "retains the original result constituent and full provenance for tick %s",
    (tick, sourceResult) => {
      const record = parse(publicAscent({ tick }));
      expect(record.attempts[0]).toMatchObject({ sourceResult, ropeMethod: "top_rope" });
      expect(record.attempts.slice(1)).toEqual(
        Array.from({ length: 3 }, () => ({ scope: "climb", ropeMethod: "top_rope" })),
      );
      expect(record.raw).toMatchObject({
        tick,
        publicFields: { Tick: "", "Climbed gear style": "Top rope" },
      });
    },
  );
  it("does not assume one described tick's method covers the reported total", () => {
    expect(() =>
      parse(publicAscent({ tick: "Redpoint: Lead", climbedStyle: "Sport", routeStyle: "Sport" })),
    ).toThrow(/method/i);
  });
});

describe("public Atom feed", () => {
  it("rejects multiple feeds within one document even when only one has an identity", () => {
    const xml = publicFeed([]).replace('<?xml version="1.0"?>', "");
    expect(() =>
      parsePublicFeed(
        `<wrapper>${xml}<feed xmlns="http://www.w3.org/2005/Atom"/></wrapper>`,
        "123",
      ),
    ).toThrow(/invalid public Atom feed/);
  });
  it("rejects XML with an unbound namespace prefix", () => {
    expect(() =>
      parsePublicFeed(publicFeed([]).replace("</feed>", "<other:element/></feed>"), "123"),
    ).toThrow(/malformed public Atom feed/);
  });
  it("accepts surrounding whitespace on a verified feed identity", () => {
    expect(
      parsePublicFeed(
        publicFeed([]).replace("<id>https", "<id>  https").replace("123</id>", "123  </id>"),
        "123",
      ),
    ).toEqual({ items: [], next: null });
  });
  it("reports malformed feeds with safe provider and phase context", () => {
    expect(() => parsePublicFeed("<feed><private-upstream-body></feed>", "123")).toThrow(
      "theCrag returned a malformed public Atom feed. Try again or contact support.",
    );
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "theCrag returned a malformed public Atom feed. Try again or contact support.",
      }),
      { tags: { provider: "thecrag", phase: "public_feed" } },
    );
  });
  it("reads an empty feed", () => {
    expect(parsePublicFeed(publicFeed([]), "123")).toEqual({ items: [], next: null });
  });
  it("retains every ascent reference and resolves a verified relative next page", () => {
    expect(
      parsePublicFeed(
        publicFeed(
          [
            { id: "1", routeId: "2" },
            { id: "345", routeId: "678" },
          ],
          { next: "/feed/ascents/climber/123?paginateAt=9" },
        ),
        "123",
      ),
    ).toEqual({
      items: [
        { id: "1", accountId: "123", routeId: "2" },
        { id: "345", accountId: "123", routeId: "678" },
      ],
      next: "https://www.thecrag.com/feed/ascents/climber/123?paginateAt=9",
    });
  });
  it("reads multiple ascent events within one feed entry", () => {
    const html = publicFeed().replace(
      "Public event</div>",
      'Public event</div><div class="event-item" data-ascent-id="1002" data-ascent-uid="123" data-node-id="2002"></div>',
    );
    expect(parsePublicFeed(html, "123").items).toEqual([
      reference,
      { id: "1002", accountId: "123", routeId: "2002" },
    ]);
  });
  it.each([
    "http://[",
    "https://example.test/feed/ascents/climber/123?paginateAt=1",
    "/feed/ascents/climber/124?paginateAt=1",
    "/feed/ascents/climber/123#next",
    "https://user@www.thecrag.com/feed/ascents/climber/123?paginateAt=1",
    "https://:secret@www.thecrag.com/feed/ascents/climber/123?paginateAt=1",
    "/feed/ascents/climber/123?other=1",
    "/feed/ascents/climber/123?paginateAt=1&other=2",
    "/feed/ascents/climber/123?paginateAt=1&paginateAt=2",
    ...["", "0", "01", "x12", "12x"].map((id) => `/feed/ascents/climber/123?paginateAt=${id}`),
  ])("rejects untrusted or invalid pagination %s", (next) => {
    expect(() => parsePublicFeed(publicFeed([], { next }), "123")).toThrow(
      /invalid public feed pagination URL/,
    );
  });
  it.each([
    ["wrong root", (xml: string) => xml.replaceAll("feed", "log"), /invalid public Atom feed/],
    [
      "wrong namespace",
      (xml: string) => xml.replace("http://www.w3.org/2005/Atom", "https://example.test"),
      /invalid public Atom feed/,
    ],
    ["multiple roots", (xml: string) => `${xml}<other/>`, /invalid public Atom feed/],
    [
      "missing feed identity",
      (xml: string) => xml.replace(/<id>[^<]*<\/id>/, ""),
      /invalid public Atom feed/,
    ],
    [
      "duplicate feed identity",
      (xml: string) => xml.replace("</feed>", "<id>other</id></feed>"),
      /invalid public Atom feed/,
    ],
    [
      "paginated identity",
      (xml: string) => xml.replace("123</id>", "123?paginateAt=9</id>"),
      /invalid public feed identity/,
    ],
    [
      "duplicate next links",
      (xml: string) =>
        xml.replace(
          "</feed>",
          '<link rel="next" href="/feed/ascents/climber/123?paginateAt=1"/><link rel="next" href="/feed/ascents/climber/123?paginateAt=2"/></feed>',
        ),
      /conflicting public feed pagination links/,
    ],
    [
      "unsupported content",
      (xml: string) => xml.replace('type="html"', 'type="text"'),
      /unsupported public ascent event/,
    ],
    [
      "missing content",
      (xml: string) => xml.replace(/<content[\s\S]*?<\/content>/, ""),
      /unsupported public ascent event/,
    ],
    [
      "duplicate content",
      (xml: string) => xml.replace("</entry>", '<content type="html">other</content></entry>'),
      /unsupported public ascent event/,
    ],
    [
      "missing ascent event",
      (xml: string) => xml.replace('class="event-item"', 'class="other"'),
      /without public ascent identities/,
    ],
    [
      "wrong event owner",
      (xml: string) => xml.replace('data-ascent-uid="123"', 'data-ascent-uid="124"'),
      /mismatched public ascent account or identifiers/,
    ],
    [
      "missing route id",
      (xml: string) => xml.replace('data-node-id="2001"', ""),
      /mismatched public ascent account or identifiers/,
    ],
    [
      "malformed XML",
      (xml: string) => xml.replace("</feed>", "</other>"),
      /malformed public Atom feed/,
    ],
    [
      "unclosed XML root",
      (xml: string) => xml.replace("</feed>", ""),
      /malformed public Atom feed/,
    ],
  ])("rejects %s", (_name, transform, error) => {
    expect(() => parsePublicFeed(transform(publicFeed()), "123")).toThrow(error);
  });
  it.each(["id", "routeId"] as const)("validates the complete numeric %s", (key) => {
    for (const id of ["0", "01", "-1", "x12", "12x", "1x", ""]) {
      expect(() => parsePublicFeed(publicFeed([{ [key]: id }]), "123")).toThrow(
        /mismatched public ascent account or identifiers/,
      );
    }
  });
  it.each(["/en/climbing/test/route/2001/", "https://www.thecrag.com/route/2001"])(
    "accepts matching public route URL %s",
    (url) => {
      expect(
        parsePublicFeed(publicFeed().replace("/en/climbing/test/route/2001", url), "123").items,
      ).toEqual([reference]);
    },
  );
  it.each([
    "http://[",
    "https://example.test/route/2001",
    "https://user@www.thecrag.com/route/2001",
    "https://:secret@www.thecrag.com/route/2001",
    "/route/2002",
    "/route/02001",
    "/route/2001/extra",
    "/route/x2001",
  ])("rejects unverified public route URL %s", (url) => {
    expect(() =>
      parsePublicFeed(publicFeed().replace("/en/climbing/test/route/2001", url), "123"),
    ).toThrow(/mismatched public route identifiers/);
  });
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
