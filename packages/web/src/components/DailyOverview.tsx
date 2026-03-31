import { StrainScore, scoreColor, scoreLabel } from "@dofek/scoring/scoring";
import type { ReadinessRow, SleepPerformanceInfo, WorkloadRatioResult } from "dofek-server/types";
import { useEffect, useState } from "react";
import { useCountUp } from "../hooks/useCountUp.ts";
import { chartThemeColors } from "../lib/chartTheme.ts";
import { isToday, isYesterday } from "../lib/dates.ts";

interface DailyOverviewProps {
  readiness: ReadinessRow[] | undefined;
  workloadRatio: WorkloadRatioResult | undefined;
  sleepPerformance: SleepPerformanceInfo | null | undefined;
  readinessLoading?: boolean;
  workloadLoading?: boolean;
  sleepLoading?: boolean;
}

function ScoreRing({
  value,
  maxValue,
  color,
  size = 140,
  strokeWidth = 10,
  children,
}: {
  value: number;
  maxValue: number;
  color: string;
  size?: number;
  strokeWidth?: number;
  children: React.ReactNode;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.min(value / maxValue, 1);
  const targetOffset = circumference * (1 - fraction);
  const center = size / 2;

  const [animatedOffset, setAnimatedOffset] = useState(circumference);
  useEffect(() => {
    const timer = setTimeout(() => setAnimatedOffset(targetOffset), 50);
    return () => clearTimeout(timer);
  }, [targetOffset]);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} role="img" aria-label="Score ring">
        <title>Score ring</title>
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
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

function ReadinessRing({ score }: { score: number }) {
  const color = scoreColor(score);
  const label = scoreLabel(score);
  const displayScore = useCountUp(score, 800);

  return (
    <div className="flex flex-col items-center gap-2">
      <ScoreRing value={score} maxValue={100} color={color}>
        <span className="text-3xl font-bold font-mono tabular-nums" style={{ color }}>
          {displayScore}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-subtle">
          Recovery
        </span>
      </ScoreRing>
      <span
        className="text-xs font-semibold px-2 py-0.5 rounded-full"
        style={{ backgroundColor: `${color}20`, color }}
      >
        {label}
      </span>
    </div>
  );
}

function StrainRing({ strain }: { strain: number }) {
  const strainScore = new StrainScore(strain);
  const color = strainScore.color;
  const label = strainScore.label;
  const displayValue = useCountUp(strain, 1200, 1);

  return (
    <div className="flex flex-col items-center gap-2">
      <ScoreRing value={strain} maxValue={21} color={color}>
        <span className="text-3xl font-bold font-mono tabular-nums" style={{ color }}>
          {displayValue}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-subtle">
          Strain
        </span>
      </ScoreRing>
      <span
        className="text-xs font-semibold px-2 py-0.5 rounded-full"
        style={{ backgroundColor: `${color}20`, color }}
      >
        {label}
      </span>
    </div>
  );
}

function SleepRing({ performance }: { performance: SleepPerformanceInfo }) {
  const { score, tier, actualMinutes } = performance;
  const clampedScore = Math.min(score, 100);

  // Map tier to color (rendering logic)
  const color = tier === "Excellent" ? "#22c55e" : tier === "Good" ? "#eab308" : "#ef4444";

  const actualHours = Math.floor(actualMinutes / 60);
  const actualMins = Math.round(actualMinutes % 60);
  const displayScore = useCountUp(clampedScore, 800);

  return (
    <div className="flex flex-col items-center gap-2">
      <ScoreRing value={clampedScore} maxValue={100} color={color}>
        <span className="text-3xl font-bold font-mono tabular-nums" style={{ color }}>
          {displayScore}
          <span className="text-lg">%</span>
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-widest text-subtle">
          Sleep
        </span>
      </ScoreRing>
      <span
        className="text-xs font-semibold px-2 py-0.5 rounded-full"
        style={{ backgroundColor: `${color}20`, color }}
      >
        {tier} &middot; {actualHours}h {actualMins}m
      </span>
    </div>
  );
}

function RingSkeleton() {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="w-[140px] h-[140px] rounded-full shimmer" />
      <div className="w-16 h-5 rounded-full shimmer" />
    </div>
  );
}

export function DailyOverview({
  readiness,
  workloadRatio,
  sleepPerformance,
  readinessLoading,
  workloadLoading,
  sleepLoading,
}: DailyOverviewProps) {
  const latestReadiness = readiness?.length ? readiness[readiness.length - 1] : undefined;
  const readinessIsFresh = (() => {
    if (!latestReadiness) return false;
    const readinessDate = new Date(`${latestReadiness.date}T00:00:00`);
    return isToday(readinessDate) || isYesterday(readinessDate);
  })();
  const recoveryScore = readinessIsFresh ? (latestReadiness?.readinessScore ?? null) : null;
  const strainIsToday = workloadRatio?.displayedDate
    ? isToday(new Date(`${workloadRatio.displayedDate}T00:00:00`))
    : false;
  const strain = strainIsToday ? (workloadRatio?.displayedStrain ?? 0) : 0;
  const sleepIsFresh = (() => {
    if (!sleepPerformance?.sleepDate) return false;
    const sleepDate = new Date(`${sleepPerformance.sleepDate}T00:00:00`);
    return isToday(sleepDate) || isYesterday(sleepDate);
  })();
  const freshSleepPerformance = sleepIsFresh ? sleepPerformance : null;

  const allLoaded = !readinessLoading && !workloadLoading && !sleepLoading;
  const hasAnyData =
    recoveryScore != null ||
    (workloadRatio?.timeSeries?.length ?? 0) > 0 ||
    freshSleepPerformance != null;

  // Hide the entire section only once all queries have resolved and none have data
  if (allLoaded && !hasAnyData) {
    return null;
  }

  return (
    <div className="card p-6">
      <div className="flex items-center justify-center gap-6 sm:gap-10 lg:gap-14 flex-wrap">
        {readinessLoading ? (
          <RingSkeleton />
        ) : recoveryScore != null ? (
          <ReadinessRing score={recoveryScore} />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <ScoreRing value={0} maxValue={100} color={chartThemeColors.gridLine}>
              <span className="text-2xl font-bold text-subtle">--</span>
              <span className="text-[10px] font-semibold uppercase tracking-widest text-subtle">
                Recovery
              </span>
            </ScoreRing>
            <span className="text-xs text-dim">No data</span>
          </div>
        )}

        {workloadLoading ? (
          <RingSkeleton />
        ) : (workloadRatio?.timeSeries?.length ?? 0) > 0 ? (
          <StrainRing strain={strain} />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <ScoreRing value={0} maxValue={21} color={chartThemeColors.gridLine}>
              <span className="text-2xl font-bold text-subtle">--</span>
              <span className="text-[10px] font-semibold uppercase tracking-widest text-subtle">
                Strain
              </span>
            </ScoreRing>
            <span className="text-xs text-dim">No data</span>
          </div>
        )}

        {sleepLoading ? (
          <RingSkeleton />
        ) : freshSleepPerformance != null ? (
          <SleepRing performance={freshSleepPerformance} />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <ScoreRing value={0} maxValue={100} color={chartThemeColors.gridLine}>
              <span className="text-2xl font-bold text-subtle">--</span>
              <span className="text-[10px] font-semibold uppercase tracking-widest text-subtle">
                Sleep
              </span>
            </ScoreRing>
            <span className="text-xs text-dim">No data</span>
          </div>
        )}
      </div>
    </div>
  );
}
