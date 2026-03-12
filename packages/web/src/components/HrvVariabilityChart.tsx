import ReactECharts from "echarts-for-react";

export interface HrvVariabilityDataPoint {
  date: string;
  hrv: number | null;
  rollingCoefficientOfVariation: number | null;
}

interface HrvVariabilityChartProps {
  data: HrvVariabilityDataPoint[];
  loading?: boolean;
}

export function HrvVariabilityChart({ data, loading }: HrvVariabilityChartProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">Loading...</span>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px]">
        <span className="text-zinc-600 text-sm">No HRV variability data</span>
      </div>
    );
  }

  const dates = data.map((d) => d.date);
  const hrvValues = data.map((d) => (d.hrv != null ? [d.date, d.hrv] : [d.date, null]));
  const cvValues = data.map((d) =>
    d.rollingCoefficientOfVariation != null
      ? [d.date, d.rollingCoefficientOfVariation]
      : [d.date, null],
  );

  // Find max CV for y-axis scaling
  const maxCv = Math.max(
    15,
    ...data
      .filter((d) => d.rollingCoefficientOfVariation != null)
      .map((d) => d.rollingCoefficientOfVariation as number),
  );

  const option = {
    backgroundColor: "transparent",
    grid: { top: 40, right: 60, bottom: 30, left: 50 },
    tooltip: {
      trigger: "axis" as const,
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#e4e4e7", fontSize: 12 },
      formatter: (
        params: { seriesName: string; data: [string, number | null]; color: string }[],
      ) => {
        if (!params || params.length === 0) return "";
        const firstParam = params[0];
        if (!firstParam) return "";
        const date = new Date(firstParam.data[0]).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        let html = `<div style="font-weight:600;margin-bottom:4px">${date}</div>`;
        for (const p of params) {
          if (p.data[1] == null) continue;
          const unit = p.seriesName === "Rolling CV" ? "%" : " ms";
          html += `<div style="display:flex;align-items:center;gap:6px">`;
          html += `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>`;
          html += `<span>${p.seriesName}: <b>${p.data[1].toFixed(1)}${unit}</b></span>`;
          html += `</div>`;
        }
        return html;
      },
    },
    legend: {
      data: ["HRV", "Rolling CV"],
      textStyle: { color: "#a1a1aa", fontSize: 11 },
      top: 0,
    },
    xAxis: {
      type: "time" as const,
      axisLabel: { color: "#71717a", fontSize: 11 },
      axisLine: { lineStyle: { color: "#3f3f46" } },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: "value" as const,
        name: "HRV (ms)",
        splitLine: { lineStyle: { color: "#27272a" } },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
        position: "left" as const,
      },
      {
        type: "value" as const,
        name: "CV (%)",
        min: 0,
        max: Math.ceil(maxCv),
        splitLine: { show: false },
        axisLabel: { color: "#71717a", fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: "#3f3f46" } },
        nameTextStyle: { color: "#71717a", fontSize: 11 },
        position: "right" as const,
      },
    ],
    visualMap: [
      {
        show: false,
        seriesIndex: 1,
        dimension: 1,
        pieces: [
          { lt: 5, color: "#22c55e" },
          { gte: 5, lt: 10, color: "#eab308" },
          { gte: 10, color: "#ef4444" },
        ],
      },
    ],
    series: [
      // Shaded zone: green <5%
      {
        name: "_zoneGreen",
        type: "line",
        data: [
          [dates[0], 5],
          [dates[dates.length - 1], 5],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#22c55e", opacity: 0.06, origin: "start" },
        yAxisIndex: 1,
        z: 0,
        silent: true,
      },
      // Shaded zone: yellow 5-10%
      {
        name: "_zoneYellow",
        type: "line",
        data: [
          [dates[0], 10],
          [dates[dates.length - 1], 10],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#eab308", opacity: 0.06, origin: "start" },
        yAxisIndex: 1,
        z: 0,
        silent: true,
      },
      // Shaded zone: red >10%
      {
        name: "_zoneRed",
        type: "line",
        data: [
          [dates[0], Math.ceil(maxCv)],
          [dates[dates.length - 1], Math.ceil(maxCv)],
        ],
        symbol: "none",
        lineStyle: { width: 0 },
        areaStyle: { color: "#ef4444", opacity: 0.06, origin: "start" },
        yAxisIndex: 1,
        z: 0,
        silent: true,
      },
      // Daily HRV dots
      {
        name: "HRV",
        type: "scatter",
        data: hrvValues,
        symbolSize: 5,
        itemStyle: { color: "#22c55e", opacity: 0.7 },
        yAxisIndex: 0,
        z: 3,
      },
      // Rolling CV line
      {
        name: "Rolling CV",
        type: "line",
        data: cvValues,
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2.5 },
        yAxisIndex: 1,
        z: 4,
      },
    ],
  };

  return <ReactECharts option={option} style={{ height: 300 }} notMerge={true} />;
}
