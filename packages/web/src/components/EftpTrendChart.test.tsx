/** @vitest-environment jsdom */

import { isValidElement } from "react";
import { describe, expect, it } from "vitest";
import { EftpTrendChart } from "./EftpTrendChart.tsx";

interface TooltipParam {
  data: [string, number];
  axisValueLabel: string;
}

interface ChartElementProps {
  option: {
    tooltip?: {
      formatter?: (params: TooltipParam[]) => unknown;
    };
  };
}

describe("EftpTrendChart", () => {
  it("escapes provider-controlled activity names and axis labels in HTML tooltips", () => {
    const maliciousName = '<a href="javascript:alert(1)" onclick="alert(1)">ride</a>';
    const maliciousAxisLabel = "<svg onload=alert('x')>";
    const element = EftpTrendChart({
      data: [{ date: "2026-04-01", eftp: 250, activityName: maliciousName }],
      currentEftp: 250,
    });
    if (!isValidElement<ChartElementProps>(element)) {
      throw new Error("Expected EftpTrendChart to return a chart element");
    }
    const formatter = element.props.option.tooltip?.formatter;
    if (!formatter) throw new Error("Expected tooltip formatter");

    const html = String(
      formatter([
        {
          data: ["2026-04-01", 250],
          axisValueLabel: maliciousAxisLabel,
        },
      ]),
    );

    expect(html).toContain(
      "&lt;a href=&quot;javascript:alert(1)&quot; onclick=&quot;alert(1)&quot;&gt;ride&lt;/a&gt;",
    );
    expect(html).toContain("&lt;svg onload=alert(&#39;x&#39;)&gt;");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<svg ");
  });
});
