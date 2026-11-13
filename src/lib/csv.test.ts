import { describe, expect, it } from "vitest";
import { decodeCsv } from "./csv.ts";

describe("shared CSV decoding", () => {
  it("decodes BOM, CRLF, escaped quotes and multiline cells", () => {
    expect(decodeCsv('\uFEFFname,note\r\nA,"A ""quote""\nand comma, here"\r\n')).toEqual({
      ok: true,
      rows: [
        { fields: ["name", "note"], rowNumber: 1 },
        { fields: ["A", 'A "quote"\nand comma, here'], rowNumber: 2 },
      ],
    });
  });
  it("reports an unfinished quote and preserves empty and zero values", () => {
    expect(decodeCsv('a,b\n"unfinished')).toMatchObject({ ok: false, rowNumber: 2 });
    expect(decodeCsv("a,b\n,0")).toMatchObject({
      ok: true,
      rows: [{ fields: ["a", "b"] }, { fields: ["", "0"] }],
    });
  });
});
