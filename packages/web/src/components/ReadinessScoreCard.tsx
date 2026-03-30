import { scoreColor } from "@dofek/scoring/scoring";
import type { ReadinessRow } from "dofek-server/types";
import { useEffect, useState } from "react";
import { useCountUp } from "../hooks/useCountUp.ts";
import { dofekAxis, dofekGrid, dofekSeries, dofekTooltip } from "../lib/chartTheme.ts";
import { DofekChart } from "./DofekChart.tsx";

interface ReadinessScoreCardProps {
  data: ReadinessRow[];
  loading?: boolean;
}

function ComponentBar({
  label,
  value,
  delay = 0,
}: {
  label: string;
  value: number;
  delay?: number;
}) {
  const color = scoreColor(value);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setAnimated(true), 100 + delay);
    return () => clearTimeout(timer);
  }, [delay]);

  return (
    <div className="flex items-center gap-3">
      <span className="text-muted text-xs w-24 shrink-0">{label}</span>
      <div className="flex-1 bg-accent/10 rounded-full h-2.5 overflow-hidden">
        <div
          className="h-full rounded-full progress-bar-animated"
          style={{ width: animated ? `${value}%` : "0%", backgroundColor: color }}
        />
      </div>
      <span className="text-foreground text-xs w-8 text-right font-medium">{value}</span>
    </div>
  );
}

export function ReadinessScoreCard({ data, loading }: ReadinessScoreCardProps) {
  const latest = data.length > 0 ? data[data.length - 1] : undefined;
  const score = latest?.readinessScore ?? null;
  const color = score != null ? scoreColor(score) : undefined;
  const displayScore = useCountUp(score, 800);

  if (loading || !latest || color == null) {
    return (
      <DofekChart
        option={{}}
        loading={loading}
        empty={!latest || color == null}
        height={280}
        emptyMessage="No readiness data"
      />
    );
  }

  // Sparkline data for the mini chart
  const sparklineOption = {
    grid: dofekGrid("single", { top: 5, right: 0, bottom: 5, left: 0 }),
    xAxis: dofekAxis.category({ data: data.map((d) => d.date), show: false }),
    yAxis: { type: "value" as const, show: false, min: 0, max: 100 },
    series: [
      {
        ...dofekSeries.line(
          "Readiness",
          data.map((d) => d.readinessScore),
          {
            color,
          },
        ),
        areaStyle: {
          color: {
            type: "linear" as const,
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: `${color}40` },
              { offset: 1, color: `${color}05` },
            ],
          },
        },
      },
    ],
    tooltip: dofekTooltip({ trigger: "none" }),
  };

  return (
    <div className="card p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-muted text-sm font-medium mb-1">Readiness Score</h3>
          <div className="flex items-baseline gap-2">
            <span className="text-5xl font-bold font-mono" style={{ color }}>
              {displayScore}
            </span>
            <span className="text-subtle text-sm">/100</span>
          </div>
          <span className="text-dim text-xs">
            {new Date(latest.date).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </span>
        </div>
        <div className="w-32 h-16">
          <DofekChart option={sparklineOption} height={64} />
        </div>
      </div>

      <div className="space-y-2.5 mt-4">
        <ComponentBar label="Heart Rate Variability" value={latest.components.hrvScore} delay={0} />
        <ComponentBar
          label="Resting Heart Rate"
          value={latest.components.restingHrScore}
          delay={100}
        />
        <ComponentBar label="Sleep" value={latest.components.sleepScore} delay={200} />
        <ComponentBar
          label="Respiratory Rate"
          value={latest.components.respiratoryRateScore}
          delay={300}
        />
      </div>
    </div>
  );
}
