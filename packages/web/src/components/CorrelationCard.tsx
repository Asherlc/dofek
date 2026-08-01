import { formatNumber } from "@dofek/format/format";
import type { InsightEvidence } from "dofek-server/types";
import {
  chartColors,
  chartThemeColors,
  dofekAxis,
  dofekGrid,
  dofekSeries,
  dofekTooltip,
  escapeTooltipHtml,
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
  evidence?: InsightEvidence;
  explanation?: string;
  confounders?: string[];
  dataPoints?: Array<{ x: number; y: number; date: string }>;
  distributions?: {
    withAction: number[];
    withoutAction: number[];
  };
}

interface CorrelationCardProps {
  insight: Insight;
}

export function CorrelationCard({ insight }: CorrelationCardProps) {
  return (
    <div className="card p-4 space-y-3">
      {/* Header */}
      <div className="space-y-1">
        <p className="text-sm text-foreground font-medium leading-tight">{insight.message}</p>
        {insight.evidence && (
          <p className="text-xs text-muted font-medium">{insight.evidence.label}</p>
        )}
      </div>

      {/* Visualization */}
      {insight.type === "conditional" ? (
        <ConditionalChart insight={insight} />
      ) : (
        <CorrelationViz insight={insight} />
      )}

      {/* Server-authored evidence */}
      {insight.evidence ? (
        <InsightEvidenceDetails evidence={insight.evidence} />
      ) : (
        insight.explanation && <p className="text-xs text-muted italic">{insight.explanation}</p>
      )}

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

function InsightEvidenceDetails({ evidence }: { evidence: InsightEvidence }) {
  return (
    <div className="space-y-1 text-xs text-muted">
      <p>{evidence.method}</p>
      <p>{evidence.interpretation}</p>
      <p>{evidence.limitations}</p>
      <p>{evidence.recommendation}</p>
    </div>
  );
}

function ConditionalChart({ insight }: { insight: Insight }) {
  const { whenTrue, whenFalse, action } = insight;

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
              itemStyle: { color: chartColors.blue },
              label: {
                show: true,
                position: "right",
                formatter: `${formatValue(whenTrue.mean)} (n=${whenTrue.n})`,
                color: chartThemeColors.legendText,
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
        <span className="text-muted">
          {insight.evidence?.estimateLabel ?? "Observed group comparison"}
        </span>
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

  const option = {
    grid: dofekGrid("single", { left: 8, right: 16, top: 16, bottom: 24, containLabel: true }),
    xAxis: {
      ...dofekAxis.value({
        name: insight.action,
        showSplitLine: true,
      }),
      scale: true,
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
    ],
    tooltip: dofekTooltip({
      trigger: "item",
      formatter: (params: unknown) => {
        if (!params || typeof params !== "object" || !("value" in params)) return "";
        const rawValue = Array.isArray(params.value) ? params.value : [0, 0];
        const v0 = Number(rawValue[0] ?? 0);
        const v1 = Number(rawValue[1] ?? 0);
        return `${escapeTooltipHtml(insight.action)}: ${formatValue(v0)}<br/>${escapeTooltipHtml(insight.metric)}: ${formatValue(v1)}`;
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
