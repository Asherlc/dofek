import { StrainScore, WorkloadRatio } from "@dofek/scoring/scoring";
import type { StrainTargetResult, WorkloadRatioResult } from "dofek-server/types";
import { useEffect, useState } from "react";
import { useCountUp } from "../hooks/useCountUp.ts";
import { chartThemeColors } from "../lib/chartTheme.ts";
import { ChartLoadingSkeleton } from "./LoadingSkeleton.tsx";

interface StrainCardProps {
  data: WorkloadRatioResult | undefined;
  strainTarget?: StrainTargetResult | undefined;
  loading?: boolean;
}

function StrainRing({
  strain,
  targetStrain,
  size = 120,
}: {
  strain: number;
  targetStrain?: number;
  size?: number;
}) {
  const maxStrain = 21;
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.min(strain / maxStrain, 1);
  const targetOffset = circumference * (1 - fraction);
  const color = new StrainScore(strain).color;
  const center = size / 2;
  const displayValue = useCountUp(strain, 1200, 1);

  // Animate ring draw-in
  const [animatedOffset, setAnimatedOffset] = useState(circumference);
  useEffect(() => {
    // Small delay so the transition is visible on mount
    const timer = setTimeout(() => setAnimatedOffset(targetOffset), 50);
    return () => clearTimeout(timer);
  }, [targetOffset]);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        role="img"
        aria-label={`Strain gauge showing ${strain.toFixed(1)} out of ${maxStrain}`}
      >
        <title>Strain: {strain.toFixed(1)}</title>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={chartThemeColors.gridLine}
          strokeWidth={strokeWidth}
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={animatedOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
          style={{ transition: "stroke-dashoffset 1.2s cubic-bezier(0.16, 1, 0.3, 1)" }}
        />
        {/* Target marker */}
        {targetStrain != null &&
          targetStrain > 0 &&
          (() => {
            const targetFraction = Math.min(targetStrain / maxStrain, 1);
            const targetAngle = -90 + targetFraction * 360;
            const rad = (targetAngle * Math.PI) / 180;
            const markerX = center + radius * Math.cos(rad);
            const markerY = center + radius * Math.sin(rad);
            return (
              <circle
                cx={markerX}
                cy={markerY}
                r={4}
                fill="white"
                stroke={chartThemeColors.gridLine}
                strokeWidth={1.5}
              />
            );
          })()}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold font-mono tabular-nums" style={{ color }}>
          {displayValue}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-subtle">
          Strain
        </span>
      </div>
    </div>
  );
}

export function StrainCard({ data, strainTarget, loading }: StrainCardProps) {
  if (loading) {
    return <ChartLoadingSkeleton height={200} />;
  }

  if (!data || data.timeSeries.length === 0) {
    return (
      <div className="card p-6 flex items-center justify-center h-[200px]">
        <span className="text-dim text-sm">No strain data yet</span>
      </div>
    );
  }

  const today = data.timeSeries[data.timeSeries.length - 1];
  const strain = data.displayedStrain;
  const strainScore = new StrainScore(strain);
  const label = strainScore.label;
  const color = strainScore.color;
  const workloadRatio = today?.workloadRatio;

  const dateLabel =
    data.displayedDate == null
      ? ""
      : data.displayedDate === today?.date
        ? "Today"
        : `Last training: ${new Date(data.displayedDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;

  return (
    <div className="card p-6">
      <div className="flex items-center gap-6">
        <StrainRing strain={strain} targetStrain={strainTarget?.targetStrain} size={120} />

        <div className="flex-1 space-y-3">
          <div>
            <span
              className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold"
              style={{ backgroundColor: `${color}20`, color }}
            >
              {label}
            </span>
            {dateLabel && <p className="text-xs text-subtle mt-1">{dateLabel}</p>}
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <p className="text-lg font-bold text-foreground tabular-nums">
                {today?.acuteLoad.toFixed(0) ?? "--"}
              </p>
              <p className="text-[10px] text-subtle">Acute (7d)</p>
            </div>
            <div>
              <p className="text-lg font-bold text-foreground tabular-nums">
                {today?.chronicLoad.toFixed(0) ?? "--"}
              </p>
              <p className="text-[10px] text-subtle">Chronic (28d)</p>
            </div>
            <div>
              <p
                className="text-lg font-bold tabular-nums"
                style={{ color: new WorkloadRatio(workloadRatio ?? null).color }}
              >
                {workloadRatio != null ? workloadRatio.toFixed(2) : "--"}
              </p>
              <p className="text-[10px] text-subtle">Workload Ratio</p>
            </div>
          </div>

          {strainTarget && (
            <div className="mt-1 pt-2 border-t border-border">
              <div className="flex items-center justify-between text-xs">
                <span className="text-subtle">
                  Target:{" "}
                  <span className="text-foreground font-medium">{strainTarget.targetStrain}</span> (
                  {strainTarget.zone})
                </span>
                <span className="text-subtle">{strainTarget.progressPercent}% reached</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
