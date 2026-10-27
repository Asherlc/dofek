import { describe, expect, it } from "vitest";
import { decodeMountainProjectTickExport } from "./ticks.ts";

const header =
  'Date,Route,Rating,Notes,URL,Pitches,Location,"Avg Stars","Your Stars",Style,"Lead Style","Route Type","Your Rating",Length,"Rating Code"';

describe("decodeMountainProjectTickExport", () => {
  it("decodes BOM-prefixed CRLF CSV with quoted commas and escaped quotes", () => {
    const csv = `\uFEFF${header}\r\n2026-08-10,"West, Overhang",5.7,"said ""nice""",https://www.mountainproject.com/route/105751342/west-overhang,1,"Colorado > Boulder, CO",2.4,-1,Lead,,Trad,,,1800\r\n\r\n`;

    expect(decodeMountainProjectTickExport(csv)).toEqual({
      ok: true,
      ticks: [
        expect.objectContaining({
          date: "2026-08-10",
          route: "West, Overhang",
          notes: 'said "nice"',
          location: "Colorado > Boulder, CO",
          yourStars: -1,
        }),
      ],
    });
  });

  it("rejects a non-Mountain-Project header", () => {
    expect(decodeMountainProjectTickExport("Date,Route\n2026-08-10,West Overhang")).toEqual({
      ok: false,
      message: "header does not match Mountain Project tick export format",
    });
  });

  it("rejects an unterminated quoted CSV field", () => {
    expect(decodeMountainProjectTickExport(`${header}\n2026-08-10,"West Overhang`)).toEqual({
      ok: false,
      message: "row 2: malformed CSV row",
    });
  });
});
