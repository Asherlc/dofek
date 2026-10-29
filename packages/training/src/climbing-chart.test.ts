import { describe, expect, it } from "vitest";
import {
  type ClimbingChartAnnotation,
  climbingChartAnnotationSchema,
  climbingChartPositions,
} from "./climbing-chart.ts";

const start = Date.parse("2026-10-01T10:00:00Z");
const annotation = (
  id: string,
  from: number,
  to: number | null = null,
): ClimbingChartAnnotation => ({
  id,
  label: id,
  startedAt: new Date(start + from * 1000).toISOString(),
  endedAt: to === null ? null : new Date(start + to * 1000).toISOString(),
});

describe("climbing chart positions", () => {
  it("clips ranges and retains instants at both boundaries without stretching the chart", () => {
    const result = climbingChartPositions(
      [
        annotation("before", -1),
        annotation("first", 0),
        annotation("middle", 30),
        annotation("last", 60),
        annotation("after", 61),
        annotation("range", -20, 20),
        annotation("outside", 61, 80),
      ],
      start,
      start + 60000,
    );
    expect(
      result.map(({ annotation: item, startPosition, endPosition }) => [
        item.id,
        startPosition,
        endPosition,
      ]),
    ).toEqual([
      ["first", 0, 0],
      ["middle", 0.5, 0.5],
      ["last", 1, 1],
      ["range", 0, 1 / 3],
    ]);
  });
  it("centers a single-timestamp chart", () => {
    expect(climbingChartPositions([annotation("only", 0)], start, start)[0]).toMatchObject({
      startPosition: 0.5,
      endPosition: 0.5,
    });
  });
  it("rejects reversed ranges", () => {
    expect(climbingChartAnnotationSchema.safeParse(annotation("reverse", 20, 10)).success).toBe(
      false,
    );
  });
});
