import { climbingStrengthsGradePanel } from "@dofek/training/climbing-strengths";
import { init } from "echarts";
import { expect, it } from "vitest";
import { z } from "zod";
import { chartThemeColors } from "../lib/chartTheme.ts";
import { climbingStrengthsChartOption } from "./climbing-strengths-chart-options.ts";
import {
  climbingStrengthsUnknownResultsFixture,
  climbingStrengthsFixture as fixture,
} from "./climbing-strengths-fixtures.ts";

const panel = fixture.panels[0];
if (!panel) throw new Error("Missing fixture");
it("labels per-grade curve differences against their grade baseline after selecting All grades", () => {
  const option = climbingStrengthsChartOption(panel, "curves", "All grades", null);
  expect(option.series[0]?.data[1]).toMatchObject({
    tooltipText: expect.stringContaining("vs same-grade baseline"),
  });
});
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
    xAxis: { data: ["2026-08", "2026-09", "2026-10"], show: true },
    yAxis: { min: 0, max: 100 },
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
it("numbers progress markers and legend entries beyond a palette cycle", () => {
  const template = panel.rows[0];
  if (!template) throw new Error("Missing style fixture");
  const dense = {
    ...panel,
    rows: Array.from({ length: 12 }, (_, index) => ({
      ...template,
      key: `style-${index}`,
      label: `Style ${index}`,
    })),
  };
  const option = climbingStrengthsChartOption(dense, "progress", "V4", null);
  expect(option.legend).toMatchObject({ show: true, type: "scroll" });
  option.series.forEach((series, index) => {
    expect(series).toMatchObject({ label: { show: true, formatter: String(index + 1) } });
  });
  const legend = z
    .object({
      formatter: z.custom<(name: string) => string>((value) => typeof value === "function"),
    })
    .parse(option.legend);
  expect(legend.formatter("Style 10")).toBe("11. Style 10");
});
it.each([320, 900])("keeps progress legend clear of axis labels at %ipx", (width) => {
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width, height: 610 });
  try {
    chart.setOption({
      ...climbingStrengthsChartOption(panel, "progress", "V4", null),
      animation: false,
    });
    const labels = renderedText(chart);
    for (const [index, row] of panel.rows.entries()) {
      const heading = labels.find((label) => label.text === `${index + 1}. ${row.label}`);
      expect(heading).toBeDefined();
      if (!heading) throw new Error(`Missing heading: ${row.label}`);
      for (const label of labels.filter((label) => /^(\d+%|2026-|Send rate)/.test(label.text))) {
        expect(heading.bounds.intersect(label.bounds), `${row.label} overlaps ${label.text}`).toBe(
          false,
        );
      }
    }
    expect(labels.filter((label) => label.text === "100%")).toHaveLength(1);
  } finally {
    chart.dispose();
  }
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
});

const outcomePoint = z.object({
  name: z.string(),
  rowKey: z.string(),
  grade: z.string(),
  value: z.unknown(),
  displayValue: z.string(),
  tooltipText: z.string(),
  symbol: z.string(),
  itemStyle: z.object({
    color: z.string(),
    borderColor: z.string(),
    borderWidth: z.number(),
    opacity: z.number(),
  }),
});

it("highlights only the selected style and visually distinguishes limited samples", () => {
  const option = climbingStrengthsChartOption(panel, "curves", "V4", "vertical");
  const vertical = outcomePoint.array().parse(option.series[0]?.data);
  const overhang = outcomePoint.array().parse(option.series[1]?.data);
  const selected = vertical[1];
  const available = overhang[0];
  const limited = overhang[1];
  if (!selected || !available || !limited) throw new Error("Missing fixture points");
  expect(selected.itemStyle.borderWidth).toBeGreaterThan(available.itemStyle.borderWidth);
  expect(selected.itemStyle.borderColor).not.toBe(selected.itemStyle.color);
  expect(available.itemStyle).toMatchObject({
    borderWidth: 0,
    borderColor: available.itemStyle.color,
    opacity: 1,
  });
  expect(limited.itemStyle.opacity).toBeLessThan(available.itemStyle.opacity);
  expect(selected.symbol).toBe("circle");
  expect(limited.symbol).toBe("emptyCircle");
  expect(limited.displayValue).toBe("0% · 0 sends / 2 climbs");
  expect(selected.tooltipText).toBe(
    "Vertical · V4\n50% · 3 sends / 6 climbs\n12.5 percentage points vs same-grade baseline",
  );
});

it("keeps missing comparisons out of tooltip text and includes full monthly scope", () => {
  const gaps = climbingStrengthsChartOption(panel, "gaps", "V4", null);
  const formatter = gaps.tooltip.formatter;
  if (typeof formatter !== "function") throw new Error("Missing formatter");
  const missing = formatter({ data: gaps.series[0]?.data[2] });
  expect(missing).toBe("Slab · V4<br/>No data · 0 sends / 0 climbs");
  const progress = climbingStrengthsChartOption(panel, "progress", "V4", null);
  expect(formatter({ data: progress.series[0]?.data[0] })).toBe(
    "Vertical · V4 · 2026-08-15 – 2026-08-31<br/>0% · 0 sends / 1 climb",
  );
});

it.each([undefined, null, false, 0, "text", {}, { tooltipText: 42 }])(
  "ignores tooltip payloads that are not chart points (%j)",
  (data) => {
    const option = climbingStrengthsChartOption(panel, "gaps", "V4", null);
    const formatter = option.tooltip.formatter;
    if (typeof formatter !== "function") throw new Error("Missing formatter");
    expect(formatter({ data })).toBe("");
  },
);

it("keeps signed gap and exposure axes comparable and includes the zero-gap reference", () => {
  expect(climbingStrengthsChartOption(panel, "gaps", "V4", null)).toMatchObject({
    xAxis: {
      min: -100,
      max: 100,
      name: "Percentage points vs same-grade baseline",
      nameLocation: "middle",
    },
    yAxis: {
      show: true,
      inverse: true,
      data: ["Vertical", "Overhang", "Slab"],
      axisLabel: { interval: 0, overflow: "truncate" },
    },
    legend: { show: true, type: "scroll" },
    aria: { label: { description: expect.stringContaining("Bouldering. V4.") } },
  });
  const exposure = climbingStrengthsChartOption(panel, "exposure", "V4", null);
  expect(exposure).toMatchObject({
    xAxis: { name: "Distinct climbs", min: 0, nameLocation: "middle" },
    yAxis: { name: "Gap (percentage points)", min: -100, max: 100 },
    series: [
      {
        markLine: {
          silent: true,
          symbol: "none",
          data: [{ yAxis: 0 }],
          lineStyle: { type: "dashed" },
        },
      },
    ],
  });
  const points = z
    .array(
      outcomePoint.extend({ label: z.object({ show: z.literal(true), formatter: z.string() }) }),
    )
    .parse(exposure.series[0]?.data);
  expect(points.map((point) => [point.name, point.label.formatter])).toEqual([
    ["Vertical · V4", "Vertical"],
    ["Overhang · V4", "Overhang"],
  ]);
});

it("shows individual ordered-grade observations and an explicit baseline without smoothing", () => {
  const curves = climbingStrengthsChartOption(panel, "curves", "V4", null);
  expect(curves).toMatchObject({
    xAxis: { show: true, data: ["V3", "V4", "V5", "V6"] },
    yAxis: { name: "Success (%)", min: 0, max: 100 },
  });
  expect(curves.series[0]).toMatchObject({ smooth: false, symbol: "circle" });
  expect(curves.series.at(-1)).toMatchObject({
    smooth: false,
    symbol: "diamond",
    lineStyle: { type: "dashed" },
  });
});

it("filters missing radar axes while retaining zero outcomes and the server's baseline", () => {
  const radar = climbingStrengthsChartOption(panel, "radar", "V4", null);
  expect(radar).toMatchObject({
    radar: {
      indicator: [
        { name: "Vertical", min: 0, max: 100 },
        { name: "Overhang", min: 0, max: 100 },
      ],
      axisName: { overflow: "break" },
    },
  });
  expect(radar.series[0]?.data).toEqual([
    expect.objectContaining({
      name: "Observed success",
      value: [50, 0],
      tooltipText:
        "Vertical · V4\n50% · 3 sends / 6 climbs\nOverhang · V4\n0% · 0 sends / 2 climbs",
      areaStyle: { opacity: expect.any(Number) },
    }),
    expect.objectContaining({
      name: "Same-grade baseline",
      value: [37.5, 37.5],
      tooltipText: "Same-grade baseline · V4\n37.5% · 3 sends / 8 climbs",
      lineStyle: expect.objectContaining({ type: "dashed" }),
    }),
  ]);
});

it("uses selected-grade monthly cells from each style's own observations", () => {
  const progress = climbingStrengthsChartOption(panel, "progress", "V3", null);
  expect(
    progress.series.map((series) =>
      series.data.map((point) => outcomePoint.nullable().parse(point)?.value ?? null),
    ),
  ).toEqual([
    [66.7, null, 80],
    [50, null, 60],
    [100, null, 100],
  ]);
  expect(progress).toMatchObject({
    legend: { show: true },
    xAxis: { show: true, axisLabel: expect.objectContaining({ hideOverlap: true }) },
    yAxis: { min: 0, max: 100 },
  });
  for (const series of progress.series)
    expect(series).toMatchObject({ smooth: false, connectNulls: false, symbol: "circle" });
});

function withRenderedChart(
  option: Record<string, unknown>,
  verify: (chart: ReturnType<typeof init>) => void,
  height = 900,
) {
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 900, height });
  try {
    chart.setOption({ ...option, animation: false });
    verify(chart);
  } finally {
    chart.dispose();
  }
}

function renderedText(chart: ReturnType<typeof init>) {
  return chart
    .getZr()
    .storage.getDisplayList()
    .flatMap((element) => {
      const style = z
        .object({ text: z.union([z.string(), z.number()]) })
        .safeParse(Reflect.get(element, "style"));
      if (element.type !== "tspan" || !style.success) return [];
      const bounds = element.getBoundingRect().clone();
      const transform = element.getComputedTransform();
      if (transform) bounds.applyTransform(transform);
      return [{ text: String(style.data.text), bounds }];
    });
}

it("renders readable gap style labels and the full quantity label inside the chart", () => {
  withRenderedChart(
    climbingStrengthsChartOption(panel, "gaps", "V4", null),
    (chart) => {
      const text = renderedText(chart);
      for (const label of [
        "Vertical",
        "Overhang",
        "Slab",
        "Success gap",
        "Percentage points vs same-grade baseline",
      ]) {
        const item = text.find((item) => item.text === label);
        expect(item, `Rendered label: ${label}`).toBeDefined();
        if (!item) throw new Error("Missing readable label");
        expect(item.bounds.x).toBeGreaterThanOrEqual(0);
        expect(item.bounds.x + item.bounds.width).toBeLessThanOrEqual(900);
      }
      const labelY = ["Vertical", "Overhang", "Slab"].map(
        (label) => text.find((item) => item.text === label)?.bounds.y ?? Number.NaN,
      );
      expect(labelY[1]).toBeGreaterThan(labelY[0] ?? 0);
      expect(labelY[2]).toBeGreaterThan(labelY[1] ?? 0);
    },
    350,
  );
});

it("renders separate pyramid facets with a common count scale and count-proportional widths", () => {
  const option = climbingStrengthsChartOption(panel, "pyramids", "V4", "vertical");
  expect(option).toMatchObject({
    xAxis: [
      expect.objectContaining({ min: 0, max: 10, gridIndex: 0 }),
      expect.objectContaining({ min: 0, max: 10, gridIndex: 1 }),
      expect.objectContaining({ min: 0, max: 10, gridIndex: 2 }),
    ],
  });
  withRenderedChart(
    option,
    (chart) => {
      const rectangle = z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      });
      const tracks = chart
        .getZr()
        .storage.getDisplayList()
        .filter((element) => element.type === "rect")
        .flatMap((element) => {
          const shape = rectangle.safeParse(Reflect.get(element, "shape"));
          const style = z.object({ fill: z.string() }).safeParse(Reflect.get(element, "style"));
          return shape.success &&
            style.success &&
            style.data.fill === chartThemeColors.axisLine &&
            shape.data.height === 18 &&
            shape.data.width > 0
            ? [shape.data]
            : [];
        });
      const counts = panel.rows.flatMap((row) =>
        [...row.cells].reverse().flatMap((cell) => (cell.climbs > 0 ? [cell.climbs] : [])),
      );
      expect(tracks).toHaveLength(counts.length);
      const first = tracks[0];
      const firstCount = counts[0];
      if (!first || !firstCount) throw new Error("Missing count tracks");
      for (const [index, track] of tracks.entries())
        expect(track.width / (counts[index] ?? 1)).toBeCloseTo(first.width / firstCount, 5);
      const text = renderedText(chart);
      const headings = panel.rows.map((row) => text.find((item) => item.text === row.label));
      for (const [index, heading] of headings.entries()) {
        if (!heading) throw new Error("Missing style heading");
        const next = headings[index + 1];
        const own = tracks.filter(
          (track) => track.y > heading.bounds.y && (!next || track.y < next.bounds.y),
        );
        expect(own.length).toBeGreaterThan(0);
        if (next)
          expect(Math.max(...own.map((track) => track.y + track.height))).toBeLessThan(
            next.bounds.y,
          );
        const grades = text
          .filter(
            (item) =>
              panel.grades.some((grade) => grade.grade === item.text) &&
              item.bounds.y > heading.bounds.y &&
              (!next || item.bounds.y < next.bounds.y),
          )
          .sort((firstLabel, secondLabel) => firstLabel.bounds.y - secondLabel.bounds.y);
        expect(grades.map((grade) => grade.text)).toEqual(["V6", "V5", "V4", "V3"]);
      }
    },
    800,
  );
});

it("renders monthly style series together on shared success bounds", () => {
  withRenderedChart(climbingStrengthsChartOption(panel, "progress", "V3", null), (chart) => {
    const text = renderedText(chart).map((item) => item.text);
    expect(text).toEqual(
      expect.arrayContaining([
        "1. Vertical",
        "2. Overhang",
        "3. Slab",
        "0%",
        "100%",
        "2026-08",
        "2026-09",
        "2026-10",
      ]),
    );
  });
});
it("renders an isolated observation with a marker and retains every dense style", () => {
  const grade = panel.grades[1];
  if (!grade) throw new Error("Missing grade");
  const dense = {
    ...panel,
    grades: [grade],
    rows: Array.from({ length: 12 }, (_, index) => ({
      key: `row-${index}`,
      label: `Distinct style ${index}`,
      cells: panel.rows[index % 2]?.cells.filter((cell) => cell.grade === grade.grade) ?? [],
    })),
  };
  const option = climbingStrengthsChartOption(dense, "curves", "V4", null);
  expect(option.series).toHaveLength(13);
  for (const series of option.series) expect(series.data).toHaveLength(1);
  withRenderedChart(
    option,
    (chart) => {
      const svg = chart.renderToSVGString();
      expect(svg).toContain("Distinct style 11");
      expect(svg).toContain("Same-grade baseline");
    },
    350,
  );
  withRenderedChart(
    { ...option, legend: { show: false } },
    (chart) => {
      const markers = chart
        .getZr()
        .storage.getDisplayList()
        .filter((element) => {
          const shape = z
            .object({ symbolType: z.enum(["circle", "diamond"]) })
            .safeParse(Reflect.get(element, "shape"));
          return element.type === "path" && shape.success;
        });
      expect(markers).toHaveLength(13);
      for (const marker of markers) {
        const bounds = marker.getBoundingRect().clone();
        const transform = marker.getComputedTransform();
        if (transform) bounds.applyTransform(transform);
        expect(bounds.width).toBeGreaterThan(0);
        expect(bounds.height).toBeGreaterThan(0);
      }
    },
    350,
  );
});

it("retains unknown-result logged climbs in pyramids and total mixed exposure counts", () => {
  const unknownPanel = climbingStrengthsUnknownResultsFixture.panels[0];
  if (!unknownPanel) throw new Error("Missing unknown results fixture");
  const pyramid = climbingStrengthsChartOption(unknownPanel, "pyramids", "V3", null);
  expect(pyramid.series[0]?.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        grade: "V3",
        value: 4,
        displayValue: "Result unknown · 0 sends / 4 climbs · 4 results unknown",
      }),
    ]),
  );
  const exposure = climbingStrengthsChartOption(unknownPanel, "exposure", "V4", null);
  expect(exposure.series[0]?.data).toEqual([
    expect.objectContaining({
      value: [5, 0],
      displayValue: "67% · 2 sends / 5 climbs · 2 results unknown",
    }),
  ]);
  const curve = climbingStrengthsChartOption(unknownPanel, "curves", "V3", null);
  expect(curve.series[0]?.data[0]).toMatchObject({
    value: null,
    displayValue: "Result unknown · 0 sends / 4 climbs · 4 results unknown",
  });
});

it("announces all-grade coverage after selecting an individual curve point", () => {
  const option = climbingStrengthsChartOption(panel, "curves", "V4", "vertical");
  expect(option.aria.label.description).toContain("All grades");
});

it("renders the server grade-adjusted radar scores around a zero baseline", () => {
  const option = climbingStrengthsChartOption(
    climbingStrengthsGradePanel(panel, "All grades"),
    "radar",
    "All grades",
    null,
  );
  expect(option).toMatchObject({
    aria: {
      label: {
        description:
          "Bouldering. All grades. Grade-adjusted differences in percentage points; zero is the same-grade baseline; limited samples are marked. Exact values are available below.",
      },
    },
    radar: {
      triggerEvent: true,
      indicator: [
        { name: "Vertical", min: -100, max: 100 },
        { name: "Overhang", min: -100, max: 100 },
        { name: "Slab", min: -100, max: 100 },
      ],
      axisName: { color: chartThemeColors.axisLabel, width: 110, overflow: "break" },
      splitLine: { lineStyle: { color: chartThemeColors.gridLine } },
    },
    series: [
      {
        type: "radar",
        data: [
          {
            name: "Grade-adjusted strengths",
            value: [6, 1.8, -7],
            lineStyle: { color: expect.any(String) },
            itemStyle: { color: expect.any(String) },
            areaStyle: { opacity: 0.12 },
          },
          {
            name: "Same-grade baseline",
            value: [0, 0, 0],
            tooltipText: "Same-grade baseline · 0 percentage points",
            lineStyle: { type: "dashed", color: chartThemeColors.axisLabel },
            itemStyle: { color: chartThemeColors.axisLabel },
          },
        ],
      },
    ],
  });
});

it.each(["curves", "pyramids", "radar"] as const)(
  "describes the displayed grade scope for %s",
  (view) => {
    const option = climbingStrengthsChartOption(panel, view, "V4", null);
    expect(option.aria.label.description).toBe(
      `Bouldering. ${view === "radar" ? "V4" : "All grades"}. Success per distinct climb; limited samples are marked. Exact values are available below.`,
    );
    if (view !== "radar") {
      expect(
        climbingStrengthsChartOption(panel, view, "All grades", null).aria.label.description,
      ).toBe(
        "Bouldering. All grades. Success per distinct climb; limited samples are marked. Exact values are available below.",
      );
    }
  },
);

it("omits unscored radar axes and keeps zero scores with explicit sample qualifiers", () => {
  const supplied = climbingStrengthsGradePanel(panel, "All grades");
  const option = climbingStrengthsChartOption(
    {
      ...supplied,
      gradeAdjustedStrengths: [
        {
          key: "vertical",
          differencePercentagePoints: 0,
          expectedSuccessRate: 50,
          sampleStatus: "available",
        },
        {
          key: "overhang",
          differencePercentagePoints: -12,
          expectedSuccessRate: 50,
          sampleStatus: "limited",
        },
        {
          key: "slab",
          differencePercentagePoints: null,
          expectedSuccessRate: null,
          sampleStatus: "no_data",
        },
      ],
    },
    "radar",
    "All grades",
    null,
  );
  expect(option).toMatchObject({
    radar: {
      indicator: [
        { name: "Vertical", min: -100, max: 100 },
        { name: "Overhang", min: -100, max: 100 },
      ],
    },
  });
  const points = z
    .array(z.object({ value: z.array(z.number()), tooltipText: z.string() }))
    .parse(option.series[0]?.data);
  expect(points[0]?.value).toEqual([0, -12]);
  expect(points[0]?.tooltipText).toBe(
    `Vertical · 0 percentage points vs same-grade baseline\n${supplied.rows[0]?.cells[0]?.sends} sends / ${supplied.rows[0]?.cells[0]?.climbs} climbs\nOverhang · -12 percentage points vs same-grade baseline\n${supplied.rows[1]?.cells[0]?.sends} sends / ${supplied.rows[1]?.cells[0]?.climbs} climbs · Limited sample`,
  );
  expect(points[1]?.value).toEqual([0, 0]);
  const missing = climbingStrengthsChartOption(
    { ...supplied, gradeAdjustedStrengths: [] },
    "radar",
    "All grades",
    null,
  );
  expect(missing).toMatchObject({ radar: { indicator: [] } });
});
