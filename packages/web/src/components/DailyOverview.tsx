import { StrainScore, scoreColor, scoreLabel } from "@dofek/scoring/scoring";
import type { ReadinessRow, SleepNeedResult, WorkloadRatioResult } from "dofek-server/types";
import { useEffect, useState } from "react";
import { useCountUp } from "../hooks/useCountUp.ts";
import { chartThemeColors } from "../lib/chartTheme.ts";

interface DailyOverviewProps {
  readiness: ReadinessRow[] | undefined;
  workloadRatio: WorkloadRatioResult | undefined;
  sleepNeed: SleepNeedResult | undefined;
  loading?: boolean;
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

function SleepRing({ sleepNeed }: { sleepNeed: SleepNeedResult }) {
  const lastNight = sleepNeed.recentNights[sleepNeed.recentNights.length - 1];
  const actualMinutes = lastNight?.actualMinutes ?? 0;
  const neededMinutes = sleepNeed.totalNeedMinutes;
  const performance = neededMinutes > 0 ? Math.round((actualMinutes / neededMinutes) * 100) : 0;
  const clampedPerformance = Math.min(performance, 100);

  const color = performance >= 90 ? "#22c55e" : performance >= 70 ? "#eab308" : "#ef4444";

  const tier =
    performance >= 90
      ? "Peak"
      : performance >= 70
        ? "Perform"
        : performance >= 50
          ? "Get By"
          : "Low";

  const actualHours = Math.floor(actualMinutes / 60);
  const actualMins = Math.round(actualMinutes % 60);
  const displayPerformance = useCountUp(clampedPerformance, 800);

  return (
    <div className="flex flex-col items-center gap-2">
      <ScoreRing value={clampedPerformance} maxValue={100} color={color}>
        <span className="text-3xl font-bold font-mono tabular-nums" style={{ color }}>
          {displayPerformance}
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
      <div className="w-[140px] h-[140px] rounded-full bg-skeleton animate-pulse" />
      <div className="w-16 h-5 rounded-full bg-skeleton animate-pulse" />
    </div>
  );
}

export function DailyOverview({
  readiness,
  workloadRatio,
  sleepNeed,
  loading,
}: DailyOverviewProps) {
  const latestReadiness = readiness?.length ? readiness[readiness.length - 1] : undefined;
  const recoveryScore = latestReadiness?.readinessScore ?? null;
  const strain = workloadRatio?.displayedStrain ?? 0;
  const hasAnyData =
    recoveryScore != null || (workloadRatio?.timeSeries?.length ?? 0) > 0 || sleepNeed != null;

  if (loading) {
    return (
      <div className="card p-6">
        <div className="flex items-center justify-center gap-8 sm:gap-12">
          <RingSkeleton />
          <RingSkeleton />
          <RingSkeleton />
        </div>
      </div>
    );
  }

  if (!hasAnyData) {
    return null;
  }

  return (
    <div className="card p-6">
      <div className="flex items-center justify-center gap-6 sm:gap-10 lg:gap-14 flex-wrap">
        {recoveryScore != null ? (
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

        {(workloadRatio?.timeSeries?.length ?? 0) > 0 ? (
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

        {sleepNeed != null && sleepNeed.recentNights.length > 0 ? (
          <SleepRing sleepNeed={sleepNeed} />
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
