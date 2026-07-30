/** @vitest-environment jsdom */

import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { SleepChart } from "./SleepChart.tsx";

interface TooltipParam {
  seriesName: string;
  value: [string, number | null];
  color: string;
}

interface ChartElementProps {
  option: {
    tooltip?: {
      formatter?: (params: TooltipParam[]) => unknown;
    };
  };
}

describe("SleepChart", () => {
  it("escapes provider and series names in HTML tooltips", () => {
    const startedAt = "2026-04-01T22:00:00.000Z";
    const element = SleepChart({
      data: [
        {
          started_at: startedAt,
          ended_at: "2026-04-02T06:00:00.000Z",
          timezone: null,
          start_utc_offset_minutes: -420,
          end_utc_offset_minutes: -420,
          local_time_source: "provider_offset",
          duration_minutes: 480,
          deep_minutes: 90,
          rem_minutes: 100,
          light_minutes: 270,
          awake_minutes: 20,
          provider_id: "oura",
          source_name: '<a href="javascript:alert(1)" onclick="alert(1)">ring</a>',
          source_providers: ["oura", '<img src=x onerror="alert(1)">'],
          staging_available: true,
        },
      ],
    });
    if (!isValidElement<ChartElementProps>(element)) {
      throw new Error("Expected SleepChart to return a chart element");
    }
    const formatter = element.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");

    const html = String(
      formatter([
        {
          seriesName: "Deep<script>alert(1)</script>",
          value: [startedAt, 90],
          color: "#123456",
        },
      ]),
    );

    expect(html).toContain("Deep&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(
      "&lt;a href=&quot;javascript:alert(1)&quot; onclick=&quot;alert(1)&quot;&gt;ring&lt;/a&gt;",
    );
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("3:00 PM – 11:00 PM");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img ");
  });

  it("identifies a night without a complete stage breakdown", () => {
    const startedAt = "2026-04-02T22:00:00.000Z";
    const element = SleepChart({
      data: [
        {
          started_at: startedAt,
          ended_at: null,
          timezone: null,
          start_utc_offset_minutes: null,
          end_utc_offset_minutes: null,
          local_time_source: "unknown",
          duration_minutes: 480,
          deep_minutes: null,
          rem_minutes: null,
          light_minutes: null,
          awake_minutes: null,
          staging_available: false,
        },
      ],
    });
    if (!isValidElement<ChartElementProps>(element)) {
      throw new Error("Expected SleepChart to return a chart element");
    }
    const formatter = element.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");

    const html = String(
      formatter([
        {
          seriesName: "Deep",
          value: [startedAt, null],
          color: "#123456",
        },
      ]),
    );

    expect(html).toContain("Partial record: sleep stages were not reported");
    expect(html).toContain("(8h 0m)");
    expect(html).not.toContain("Deep: 0m");
  });
});
