import { describe, expect, it } from "vitest";
import { climbingBestOnsightSchema } from "./climbing-best-onsight.ts";
import { climbingBestOnsightFixture } from "./fixtures/climbing-best-onsight.ts";

describe("climbingBestOnsightSchema", () => {
  it("accepts the representative result with one row per climbing type", () => {
    const fixture = climbingBestOnsightFixture();
    expect(climbingBestOnsightSchema.parse(fixture)).toEqual(fixture);
  });

  it("rejects a result that omits a climbing type", () => {
    const fixture = climbingBestOnsightFixture();
    expect(() =>
      climbingBestOnsightSchema.parse({ ...fixture, rows: fixture.rows.slice(1) }),
    ).toThrow();
  });

  it("rejects a cell with an unsupported grade system", () => {
    const fixture = climbingBestOnsightFixture();
    const [first, ...rest] = fixture.rows;
    expect(() =>
      climbingBestOnsightSchema.parse({
        ...fixture,
        rows: [{ ...first, gym: { ...first?.gym, gradeSystem: "unknown" } }, ...rest],
      }),
    ).toThrow();
  });
});
