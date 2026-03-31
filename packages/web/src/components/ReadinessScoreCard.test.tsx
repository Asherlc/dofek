/** @vitest-environment jsdom */
import { statusColors, textColors } from "@dofek/scoring/colors";
import { render } from "@testing-library/react";
import type { ReadinessRow } from "dofek-server/types";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ReadinessScoreCard } from "./ReadinessScoreCard.tsx";

let capturedOption: Record<string, unknown> | null = null;

vi.mock("echarts-for-react", () => ({
  default: (props: { option: Record<string, unknown> }) => {
    capturedOption = props.option;
    return <div data-testid="echarts" />;
  },
}));

const readinessRows: ReadinessRow[] = [
  {
    date: "2026-03-29",
    readinessScore: 62,
    components: {
      hrvScore: 64,
      restingHrScore: 58,
      sleepScore: 66,
      respiratoryRateScore: 61,
    },
  },
  {
    date: "2026-03-30",
    readinessScore: 78,
    components: {
      hrvScore: 80,
      restingHrScore: 74,
      sleepScore: 79,
      respiratoryRateScore: 76,
    },
  },
];

const readinessSeriesSchema = z.object({
  lineStyle: z.object({ color: z.string() }),
  markArea: z.object({
    data: z.array(
      z.tuple([
        z.object({
          yAxis: z.number(),
          itemStyle: z.object({ color: z.string() }),
        }),
        z.object({ yAxis: z.number() }),
      ]),
    ),
  }),
});

function readCapturedOption(): Record<string, unknown> {
  if (capturedOption == null) {
    throw new Error("Chart option was not captured");
  }
  return capturedOption;
}

describe("ReadinessScoreCard", () => {
  it("uses a neutral readiness sparkline with layered score zones", () => {
    capturedOption = null;
    render(<ReadinessScoreCard data={readinessRows} />);

    const chartOption = readCapturedOption();
    const series = chartOption.series;
    const firstSeries = readinessSeriesSchema.parse(Array.isArray(series) ? series[0] : undefined);

    expect(firstSeries.lineStyle.color).toBe(textColors.secondary);

    const zones = firstSeries.markArea.data;
    expect(zones).toHaveLength(3);

    const dangerZone = zones[0];
    const warningZone = zones[1];
    const positiveZone = zones[2];

    expect(dangerZone?.[0]?.itemStyle).toEqual({ color: `${statusColors.danger}20` });
    expect(warningZone?.[0]?.itemStyle).toEqual({ color: `${statusColors.warning}20` });
    expect(positiveZone?.[0]?.itemStyle).toEqual({ color: `${statusColors.positive}20` });
  });
});
