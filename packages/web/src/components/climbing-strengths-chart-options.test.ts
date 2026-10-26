import { init } from "echarts";
import { expect, it } from "vitest";
import { z } from "zod";
import { climbingStrengthsChartOption } from "./climbing-strengths-chart-options.ts";
import { climbingStrengthsFixture as fixture } from "./climbing-strengths-fixtures.ts";

const panel = fixture.panels[0];
if (!panel) throw new Error("Missing fixture");
it("renders supplied same-grade gaps, including zero and missing observations", () => {
  const option = climbingStrengthsChartOption(panel, "gaps", "V4", "vertical");
  expect(option.series).toEqual([
    expect.objectContaining({
      type: "bar",
      data: [
        expect.objectContaining({ value: 12.5 }),
        expect.objectContaining({ value: -37.5 }),
        expect.objectContaining({ value: null }),
      ],
    }),
  ]);
  expect(option).toMatchObject({ yAxis: { show: true }, xAxis: { nameLocation: "middle" } });
});
it("uses supplied rates and gaps even when they differ from count-derived values", () => {
  const supplied = {
    ...panel,
    rows: panel.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) =>
        cell.grade === "V4"
          ? { ...cell, successRate: 41.7, differencePercentagePoints: 9.3 }
          : cell,
      ),
    })),
  };
  const curves = climbingStrengthsChartOption(supplied, "curves", "V4", null);
  expect(curves.series[0]).toMatchObject({
    data: [
      expect.anything(),
      expect.objectContaining({ value: 41.7 }),
      expect.anything(),
      expect.anything(),
    ],
  });
  const gaps = climbingStrengthsChartOption(supplied, "gaps", "V4", null);
  expect(gaps.series[0]).toMatchObject({
    data: [
      expect.objectContaining({ value: 9.3 }),
      expect.objectContaining({ value: 9.3 }),
      expect.objectContaining({ value: 9.3 }),
    ],
  });
});
it("retains ordered grades, real zero and null gaps in curves with a supplied baseline", () => {
  const option = climbingStrengthsChartOption(panel, "curves", "V4", null);
  expect(option).toMatchObject({ xAxis: { data: ["V3", "V4", "V5", "V6"] } });
  expect(option.series).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Vertical",
        connectNulls: false,
        data: [
          expect.objectContaining({ value: 80 }),
          expect.objectContaining({ value: 50 }),
          expect.objectContaining({ value: 40 }),
          expect.objectContaining({ value: null }),
        ],
      }),
      expect.objectContaining({
        name: "Same-grade baseline",
        data: [
          expect.objectContaining({ value: 80 }),
          expect.objectContaining({ value: 37.5 }),
          expect.objectContaining({ value: 30 }),
          expect.objectContaining({ value: 20 }),
        ],
      }),
    ]),
  );
});
it("uses server counts and differences for exposure and overlays sends on total tracks", () => {
  const exposure = climbingStrengthsChartOption(panel, "exposure", "V4", null);
  expect(exposure.series).toEqual([
    expect.objectContaining({
      data: [
        expect.objectContaining({ value: [6, 12.5] }),
        expect.objectContaining({ value: [2, -37.5] }),
      ],
    }),
  ]);
  const pyramid = climbingStrengthsChartOption(panel, "pyramids", "V4", null);
  expect(pyramid.series).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Total climbs",
        xAxisIndex: 0,
        data: expect.arrayContaining([expect.objectContaining({ value: 6 })]),
      }),
      expect.objectContaining({
        name: "Sends",
        xAxisIndex: 0,
        data: expect.arrayContaining([expect.objectContaining({ value: 3 })]),
      }),
      expect.objectContaining({
        name: "Total climbs",
        xAxisIndex: 1,
        data: expect.arrayContaining([expect.objectContaining({ value: 2 })]),
      }),
      expect.objectContaining({
        name: "Sends",
        xAxisIndex: 1,
        data: expect.arrayContaining([expect.objectContaining({ value: 0 })]),
      }),
    ]),
  );
  expect(pyramid).toMatchObject({
    yAxis: [
      expect.objectContaining({ data: ["V6", "V5", "V4", "V3"], show: true }),
      expect.anything(),
      expect.anything(),
    ],
  });
});
it("preserves calendar bucket dates and missing-month gaps without smoothing", () => {
  const option = climbingStrengthsChartOption(panel, "progress", "V4", null);
  expect(option).toMatchObject({
    xAxis: [
      expect.objectContaining({
        data: ["2026-08-15 – 2026-08-31", "2026-09-01 – 2026-09-30", "2026-10-01 – 2026-10-26"],
      }),
      expect.anything(),
      expect.anything(),
    ],
    yAxis: [
      expect.objectContaining({ min: 0, max: 100 }),
      expect.objectContaining({ min: 0, max: 100 }),
      expect.objectContaining({ min: 0, max: 100 }),
    ],
  });
  expect(option.series).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "Vertical",
        connectNulls: false,
        smooth: false,
        data: [
          expect.objectContaining({ value: 0, rowKey: "vertical", grade: "V4" }),
          expect.objectContaining({ value: null }),
          expect.objectContaining({ value: 50 }),
        ],
      }),
    ]),
  );
});
it("centers unequal pyramid tracks and sends on the same rendered midpoint", () => {
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 900, height: 700 });
  try {
    chart.setOption({
      ...climbingStrengthsChartOption(panel, "pyramids", "V4", null),
      animation: false,
    });
    const rectangle = z.object({ x: z.number(), width: z.number(), height: z.number() });
    const tracks = chart
      .getZr()
      .storage.getDisplayList()
      .filter((element) => element.type === "rect")
      .flatMap((element) => {
        const parsed = rectangle.safeParse(Reflect.get(element, "shape"));
        return parsed.success && parsed.data.height === 18 && parsed.data.width > 0
          ? [parsed.data]
          : [];
      });
    expect(tracks.length).toBeGreaterThan(8);
    expect(new Set(tracks.map((track) => Math.round(track.width))).size).toBeGreaterThan(2);
    const first = tracks[0];
    if (!first) throw new Error("Missing pyramid tracks");
    for (const track of tracks)
      expect(track.x + track.width / 2).toBeCloseTo(first.x + first.width / 2, 5);
  } finally {
    chart.dispose();
  }
});
it("provides escaped baseline hover values with supplied rates and counts", () => {
  const supplied = {
    ...panel,
    grades: panel.grades.map((item) => ({
      ...item,
      grade: `${item.grade}<script>unsafe</script>`,
    })),
  };
  const option = climbingStrengthsChartOption(supplied, "curves", "V4", null);
  const baseline = option.series.find(
    (series) => "name" in series && series.name === "Same-grade baseline",
  );
  const formatter = option.tooltip.formatter;
  if (typeof formatter !== "function") throw new Error("Missing tooltip formatter");
  const html = formatter({ data: baseline?.data[1] });
  expect(html).toContain("Same-grade baseline");
  expect(html).toContain("37.5% · 3 sends / 8 climbs");
  expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});
it("uses a 0–100 radar scale with explicit supplied same-grade baseline", () => {
  const option = climbingStrengthsChartOption(panel, "radar", "V3", null);
  expect(option).toMatchObject({
    radar: {
      indicator: [
        { name: "Vertical", min: 0, max: 100 },
        { name: "Overhang", min: 0, max: 100 },
        { name: "Slab", min: 0, max: 100 },
      ],
    },
  });
  expect(option.series).toEqual([
    expect.objectContaining({
      data: [
        expect.objectContaining({ name: "Observed success", value: [80, 60, 100] }),
        expect.objectContaining({ name: "Same-grade baseline", value: [80, 80, 80] }),
      ],
    }),
  ]);
});
it("escapes source labels in tooltip HTML while retaining exact values and limited qualifiers", () => {
  const unsafe = {
    ...panel,
    rows: panel.rows.map((row) => ({ ...row, label: '<img src=x onerror="alert(1)">' })),
  };
  const option = climbingStrengthsChartOption(unsafe, "gaps", "V4", null);
  const formatter = option.tooltip.formatter;
  if (typeof formatter !== "function") throw new Error("Missing tooltip formatter");
  const series = option.series[0];
  const html = formatter({ data: series?.data[1] });
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).toContain("0 sends / 2 climbs");
  expect(html).toContain("Limited data");
});
