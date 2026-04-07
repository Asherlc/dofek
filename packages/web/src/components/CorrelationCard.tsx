import { formatNumber } from "@dofek/format/format";
import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
} from "../lib/chartTheme.ts";
import { CorrelationStrengthBar } from "./CorrelationStrengthBar.tsx";
import { DofekChart } from "./DofekChart.tsx";

export interface Insight {
  id: string;
  type: "conditional" | "correlation" | "discovery";
  confidence: "strong" | "emerging" | "early" | "insufficient";
  metric: string;
  action: string;
  message: string;
  detail: string;
  whenTrue: { mean: number; n: number };
  whenFalse: { mean: number; n: number };
  effectSize: number;
  pValue: number;
  explanation?: string;
  confounders?: string[];
  dataPoints?: Array<{ x: number; y: number; date: string }>;
  distributions?: {
    withAction: number[];
    withoutAction: number[];
  };
}

const confidenceBadge = {
  strong: {
    label: "Strong",
    className: "bg-emerald-900/50 text-emerald-400 border-emerald-800",
  },
  emerging: {
    label: "Emerging",
    className: "bg-amber-900/50 text-amber-400 border-amber-800",
  },
  early: {
    label: "Early signal",
    className: "bg-accent/10 text-muted border-border-strong",
  },
  insufficient: {
    label: "Insufficient",
    className: "bg-accent/10 text-dim border-border-strong",
  },
};

interface CorrelationCardProps {
  insight: Insight;
}

export function CorrelationCard({ insight }: CorrelationCardProps) {
  const badge = confidenceBadge[insight.confidence];

  return (
    <div className="card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-foreground font-medium leading-tight">{insight.message}</p>
        <span className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full border ${badge.className}`}>
          {badge.label}
        </span>
      </div>

      {/* Visualization */}
      {insight.type === "conditional" ? (
        <ConditionalChart insight={insight} />
      ) : (
        <CorrelationViz insight={insight} />
      )}

      {/* Explanation */}
      {insight.explanation && <p className="text-xs text-muted italic">{insight.explanation}</p>}

      {/* Confounders */}
      {insight.confounders && insight.confounders.length > 0 && (
        <div className="text-[11px] text-amber-700 bg-amber-950/30 border border-amber-900/30 rounded px-2 py-1.5">
          <p className="font-medium text-amber-600 mb-0.5">Possible confounders:</p>
          <ul className="list-disc list-inside space-y-0.5">
            {insight.confounders.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Stats footer */}
      <p className="text-[11px] text-dim">{insight.detail}</p>
    </div>
  );
}

function ConditionalChart({ insight }: { insight: Insight }) {
  const { whenTrue, whenFalse, action } = insight;
  const diff = whenTrue.mean - whenFalse.mean;
  const baselineNearZero = Math.abs(whenFalse.mean) < 1;
  const pctDiff =
    !baselineNearZero && whenFalse.mean !== 0 ? (diff / Math.abs(whenFalse.mean)) * 100 : null;
  const sign = diff > 0 ? "+" : "";

  const maxVal = Math.max(Math.abs(whenTrue.mean), Math.abs(whenFalse.mean));

  const option = {
    grid: dofekGrid("single", { left: 8, right: 60, top: 4, bottom: 4, containLabel: true }),
    xAxis: {
      ...dofekAxis.value(),
      show: false,
      max: maxVal * 1.15,
    },
    yAxis: {
      ...dofekAxis.category({ data: ["Without", `With ${action}`] }),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: chartThemeColors.legendText,
        fontSize: 11,
        width: 120,
        overflow: "truncate",
      },
    },
    series: [
      {
        ...dofekSeries.bar(
          "",
          [
            {
              value: Math.abs(whenFalse.mean),
              itemStyle: { color: chartThemeColors.axisLabel },
              label: {
                show: true,
                position: "right",
                formatter: `${formatValue(whenFalse.mean)} (n=${whenFalse.n})`,
                color: chartThemeColors.legendText,
                fontSize: 10,
              },
            },
            {
              value: Math.abs(whenTrue.mean),
              itemStyle: { color: chartColors.emerald },
              label: {
                show: true,
                position: "right",
                formatter: `${formatValue(whenTrue.mean)} (n=${whenTrue.n})`,
                color: "#6ee7b7",
                fontSize: 10,
              },
            },
          ],
          { barWidth: 14, barGap: "30%" },
        ),
      },
    ],
  };

  return (
    <div>
      <DofekChart option={option} height={64} opts={{ renderer: "svg" }} />
      <p className="text-center text-xs text-subtle mt-1">
        <span className={diff > 0 ? "text-emerald-400" : "text-rose-400"}>
          {sign}
          {pctDiff != null ? `${formatNumber(pctDiff, 0)}%` : formatValue(diff)}
        </span>{" "}
        difference
      </p>
    </div>
  );
}

function CorrelationViz({ insight }: { insight: Insight }) {
  const rho = insight.effectSize;

  if (insight.dataPoints && insight.dataPoints.length > 0) {
    return <ScatterPlot insight={insight} />;
  }

  return (
    <div className="space-y-1">
      <CorrelationStrengthBar rho={rho} />
      <p className="text-[11px] text-dim text-center">Spearman rho | n={insight.whenTrue.n}</p>
    </div>
  );
}

function ScatterPlot({ insight }: { insight: Insight }) {
  const points = insight.dataPoints ?? [];
  const rho = insight.effectSize;

  // Compute simple linear regression for trend line
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += ((xs[i] ?? 0) - xMean) * ((ys[i] ?? 0) - yMean);
    den += ((xs[i] ?? 0) - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;

  const trendColor = rho >= 0 ? chartColors.emerald : "#fb7185";

  const option = {
    grid: dofekGrid("single", { left: 8, right: 16, top: 16, bottom: 24, containLabel: true }),
    xAxis: {
      ...dofekAxis.value({
        name: insight.action,
        showSplitLine: true,
      }),
      nameLocation: "middle",
      nameGap: 20,
      nameTextStyle: { color: chartThemeColors.axisLabel, fontSize: 10 },
      axisLabel: { color: chartThemeColors.axisLabel, fontSize: 9 },
      splitLine: { lineStyle: { color: chartThemeColors.gridLine } },
    },
    yAxis: {
      ...dofekAxis.value({ name: insight.metric }),
      nameTextStyle: { color: chartThemeColors.axisLabel, fontSize: 10 },
      axisLabel: { color: chartThemeColors.axisLabel, fontSize: 9 },
      splitLine: { lineStyle: { color: chartThemeColors.gridLine } },
    },
    series: [
      dofekSeries.scatter(
        "",
        points.map((p) => [p.x, p.y]),
        { color: chartThemeColors.legendText, symbolSize: 4, itemStyle: { opacity: 0.5 } },
      ),
      {
        ...dofekSeries.line(
          "",
          [
            [xMin, slope * xMin + intercept],
            [xMax, slope * xMax + intercept],
          ],
          { color: trendColor, smooth: false, lineStyle: { type: "dashed" } },
        ),
        silent: true,
      },
    ],
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: unknown) => {
        if (!params || typeof params !== "object" || !("value" in params)) return "";
        const rawValue = Array.isArray(params.value) ? params.value : [0, 0];
        const v0 = Number(rawValue[0] ?? 0);
        const v1 = Number(rawValue[1] ?? 0);
        return `${insight.action}: ${formatValue(v0)}<br/>${insight.metric}: ${formatValue(v1)}`;
      },
    }),
  };

  return (
    <div>
      <DofekChart option={option} height={180} opts={{ renderer: "svg" }} />
      <div className="mt-1">
        <CorrelationStrengthBar rho={rho} />
      </div>
    </div>
  );
}

export function CorrelationCardSkeleton() {
  return <div className="h-48 rounded-lg shimmer" />;
}

function formatValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return formatNumber(v);
}
