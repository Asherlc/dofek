import { isToday, isYesterday } from "@dofek/format/format";
import { statusColors } from "@dofek/scoring/colors";
import {
  StrainScore,
  scoreColor,
  scoreDescription,
  scoreLabel,
  sleepTierColor,
  sleepTierDescription,
  WorkloadRatio,
} from "@dofek/scoring/scoring";
import type {
  ReadinessRow,
  SleepPerformanceInfo,
  StrainTargetResult,
  WorkloadRatioResult,
} from "dofek-server/types";
import { useEffect, useState } from "react";
import { useCountUp } from "../hooks/useCountUp.ts";
import { chartThemeColors } from "../lib/chartTheme.ts";

interface DailyOverviewProps {
  readiness: ReadinessRow[] | undefined;
  workloadRatio: WorkloadRatioResult | undefined;
  sleepPerformance: SleepPerformanceInfo | null | undefined;
  strainTarget?: StrainTargetResult | undefined;
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
  label,
  children,
  onClick,
  expanded,
  targetFraction,
}: {
  value: number;
  maxValue: number;
  color: string;
  size?: number;
  strokeWidth?: number;
  /** Accessible label identifying which ring (e.g. "Recovery", "Strain") */
  label?: string;
  children: React.ReactNode;
  onClick?: () => void;
  expanded?: boolean;
  /** Optional target marker as fraction 0-1 of the ring */
  targetFraction?: number;
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

  const Tag = onClick ? "button" : "div";

  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`relative bg-transparent border-none p-0 ${onClick ? "cursor-pointer" : ""}`}
      style={{ width: size, height: size }}
      onClick={onClick}
      aria-expanded={onClick ? (expanded ?? false) : undefined}
      aria-label={onClick && label ? `${label} score breakdown` : undefined}
    >
      <svg width={size} height={size} aria-hidden="true">
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
        {targetFraction != null &&
          targetFraction > 0 &&
          (() => {
            const angle = -90 + targetFraction * 360;
            const rad = (angle * Math.PI) / 180;
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
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
      {/* Expand indicator */}
      {onClick && (
        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2">
          <svg
            width={12}
            height={8}
            viewBox="0 0 12 8"
            aria-hidden="true"
            className="text-subtle transition-transform duration-200"
            style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
          >
            <path
              d="M1 1.5L6 6.5L11 1.5"
              stroke="currentColor"
              strokeWidth={1.5}
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </div>
      )}
    </Tag>
  );
}

// ── Breakdown panels ──────────────────────────────────────────────

function ComponentBar({ label, value, weight }: { label: string; value: number; weight: number }) {
  const color = scoreColor(value);
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setAnimated(true), 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex items-center gap-3">
      <span className="text-muted text-xs w-[7.5rem] shrink-0">
        {label} <span className="text-dim">({Math.round(weight * 100)}%)</span>
      </span>
      <div className="flex-1 bg-accent/10 rounded-full h-2 overflow-hidden">
        <div
          className="h-full rounded-full progress-bar-animated"
          style={{ width: animated ? `${value}%` : "0%", backgroundColor: color }}
        />
      </div>
      <span className="text-foreground text-xs w-7 text-right font-medium tabular-nums">
        {value}
      </span>
    </div>
  );
}

function RecoveryBreakdown({ readiness }: { readiness: ReadinessRow }) {
  const { components, weights } = readiness;

  return (
    <div className="space-y-2">
      <ComponentBar
        label="Heart Rate Variability"
        value={components.hrvScore}
        weight={weights.hrv}
      />
      <ComponentBar
        label="Resting Heart Rate"
        value={components.restingHrScore}
        weight={weights.restingHr}
      />
      <ComponentBar label="Sleep" value={components.sleepScore} weight={weights.sleep} />
      <ComponentBar
        label="Respiratory Rate"
        value={components.respiratoryRateScore}
        weight={weights.respiratoryRate}
      />
    </div>
  );
}

function StrainBreakdown({
  workloadRatio,
  strainTarget,
}: {
  workloadRatio: WorkloadRatioResult;
  strainTarget?: StrainTargetResult;
}) {
  const today = workloadRatio.timeSeries[workloadRatio.timeSeries.length - 1];
  const acuteLoad = today?.acuteLoad ?? 0;
  const chronicLoad = today?.chronicLoad ?? 0;
  const ratio = today?.workloadRatio;

  return (
    <div className="space-y-3">
      {/* Strain target */}
      {strainTarget && (
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-muted">
              Daily target:{" "}
              <span className="text-foreground font-semibold">{strainTarget.targetStrain}</span>
            </span>
            <span
              className="font-semibold px-1.5 py-0.5 rounded text-[10px] uppercase"
              style={{
                backgroundColor:
                  strainTarget.zone === "Push"
                    ? `${statusColors.positive}20`
                    : strainTarget.zone === "Recovery"
                      ? `${statusColors.danger}20`
                      : `${statusColors.warning}20`,
                color:
                  strainTarget.zone === "Push"
                    ? statusColors.positive
                    : strainTarget.zone === "Recovery"
                      ? statusColors.danger
                      : statusColors.warning,
              }}
            >
              {strainTarget.zone}
            </span>
          </div>
          <div className="w-full bg-accent/10 rounded-full h-2 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${Math.min(strainTarget.progressPercent, 100)}%`,
                backgroundColor: new StrainScore(strainTarget.currentStrain).color,
              }}
            />
          </div>
          <p className="text-dim text-[11px] mt-1">{strainTarget.explanation}</p>
        </div>
      )}

      {/* Load stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-sm font-bold text-foreground tabular-nums">{acuteLoad.toFixed(0)}</p>
          <p className="text-[10px] text-subtle">Acute (7d)</p>
        </div>
        <div>
          <p className="text-sm font-bold text-foreground tabular-nums">{chronicLoad.toFixed(0)}</p>
          <p className="text-[10px] text-subtle">Chronic (28d)</p>
        </div>
        <div>
          <p
            className="text-sm font-bold tabular-nums"
            style={{ color: new WorkloadRatio(ratio ?? null).color }}
          >
            {ratio != null ? ratio.toFixed(2) : "--"}
          </p>
          <p className="text-[10px] text-subtle">Workload Ratio</p>
        </div>
      </div>
    </div>
  );
}

function SleepBreakdown({ performance }: { performance: SleepPerformanceInfo }) {
  const { actualMinutes, neededMinutes, efficiency } = performance;
  const actualHours = Math.floor(actualMinutes / 60);
  const actualMins = Math.round(actualMinutes % 60);
  const neededHours = Math.floor(neededMinutes / 60);
  const neededMins = Math.round(neededMinutes % 60);
  const sufficiency = neededMinutes > 0 ? Math.min(actualMinutes / neededMinutes, 1) * 100 : 100;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-muted text-xs w-[7.5rem] shrink-0">
          Sufficiency <span className="text-dim">(70%)</span>
        </span>
        <div className="flex-1 bg-accent/10 rounded-full h-2 overflow-hidden">
          <div className="h-full rounded-full bg-blue-400" style={{ width: `${sufficiency}%` }} />
        </div>
        <span className="text-foreground text-xs w-12 text-right font-medium tabular-nums">
          {actualHours}h {actualMins}m
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-muted text-xs w-[7.5rem] shrink-0">
          Efficiency <span className="text-dim">(30%)</span>
        </span>
        <div className="flex-1 bg-accent/10 rounded-full h-2 overflow-hidden">
          <div
            className="h-full rounded-full bg-blue-400"
            style={{ width: `${Math.round(efficiency)}%` }}
          />
        </div>
        <span className="text-foreground text-xs w-12 text-right font-medium tabular-nums">
          {Math.round(efficiency)}%
        </span>
      </div>
      <p className="text-dim text-[11px]">
        Need: {neededHours}h {neededMins}m &middot; Bedtime: {performance.recommendedBedtime}
      </p>
    </div>
  );
}

function EmptyBreakdown({ message }: { message: string }) {
  return <p className="text-subtle text-xs leading-relaxed">{message}</p>;
}

// ── Expandable wrapper ────────────────────────────────────────────

function ExpandableBreakdown({
  expanded,
  children,
}: {
  expanded: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="overflow-hidden transition-all duration-300 ease-out"
      style={{
        maxHeight: expanded ? 300 : 0,
        opacity: expanded ? 1 : 0,
        marginTop: expanded ? 16 : 0,
      }}
    >
      <div className="border-t border-border pt-3 px-1">{children}</div>
    </div>
  );
}

// ── Ring sub-components ───────────────────────────────────────────

function ReadinessRing({
  score,
  onClick,
  expanded,
}: {
  score: number;
  onClick: () => void;
  expanded: boolean;
}) {
  const color = scoreColor(score);
  const ringLabel = scoreLabel(score);
  const displayScore = useCountUp(score, 800);

  return (
    <div className="flex flex-col items-center gap-2 max-w-[180px]">
      <ScoreRing
        value={score}
        maxValue={100}
        color={color}
        onClick={onClick}
        expanded={expanded}
        label="Recovery"
      >
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
        {ringLabel}
      </span>
      <p className="text-[11px] text-subtle text-center leading-tight">{scoreDescription(score)}</p>
    </div>
  );
}

function StrainRing({
  strain,
  targetFraction,
  onClick,
  expanded,
}: {
  strain: number;
  targetFraction?: number;
  onClick: () => void;
  expanded: boolean;
}) {
  const strainScore = new StrainScore(strain);
  const color = strainScore.color;
  const ringLabel = strainScore.label;
  const displayValue = useCountUp(strain, 1200, 1);

  return (
    <div className="flex flex-col items-center gap-2 max-w-[180px]">
      <ScoreRing
        value={strain}
        maxValue={21}
        color={color}
        onClick={onClick}
        expanded={expanded}
        targetFraction={targetFraction}
        label="Strain"
      >
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
        {ringLabel}
      </span>
      <p className="text-[11px] text-subtle text-center leading-tight">{strainScore.description}</p>
    </div>
  );
}

function SleepRing({
  performance,
  onClick,
  expanded,
}: {
  performance: SleepPerformanceInfo;
  onClick: () => void;
  expanded: boolean;
}) {
  const { score, tier, actualMinutes } = performance;
  const clampedScore = Math.min(score, 100);

  const color = sleepTierColor(tier);

  const actualHours = Math.floor(actualMinutes / 60);
  const actualMins = Math.round(actualMinutes % 60);
  const displayScore = useCountUp(clampedScore, 800);

  return (
    <div className="flex flex-col items-center gap-2 max-w-[180px]">
      <ScoreRing
        value={clampedScore}
        maxValue={100}
        color={color}
        onClick={onClick}
        expanded={expanded}
        label="Sleep"
      >
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
      <p className="text-[11px] text-subtle text-center leading-tight">
        {sleepTierDescription(tier)}
      </p>
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

// ── Main component ────────────────────────────────────────────────

type ExpandedRing = "recovery" | "strain" | "sleep" | null;

export function DailyOverview({
  readiness,
  workloadRatio,
  sleepPerformance,
  strainTarget,
  readinessLoading,
  workloadLoading,
  sleepLoading,
}: DailyOverviewProps) {
  const [expandedRing, setExpandedRing] = useState<ExpandedRing>(null);

  const toggle = (ring: ExpandedRing) => setExpandedRing((prev) => (prev === ring ? null : ring));

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

  const targetFraction = strainTarget ? Math.min(strainTarget.targetStrain / 21, 1) : undefined;

  return (
    <div className="card p-6">
      <div className="flex items-center justify-center gap-6 sm:gap-10 lg:gap-14 flex-wrap">
        {readinessLoading ? (
          <RingSkeleton />
        ) : recoveryScore != null ? (
          <ReadinessRing
            score={recoveryScore}
            onClick={() => toggle("recovery")}
            expanded={expandedRing === "recovery"}
          />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <ScoreRing
              value={0}
              maxValue={100}
              color={chartThemeColors.gridLine}
              onClick={() => toggle("recovery")}
              expanded={expandedRing === "recovery"}
              label="Recovery"
            >
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
          <StrainRing
            strain={strain}
            targetFraction={targetFraction}
            onClick={() => toggle("strain")}
            expanded={expandedRing === "strain"}
          />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <ScoreRing
              value={0}
              maxValue={21}
              color={chartThemeColors.gridLine}
              onClick={() => toggle("strain")}
              expanded={expandedRing === "strain"}
              label="Strain"
            >
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
          <SleepRing
            performance={freshSleepPerformance}
            onClick={() => toggle("sleep")}
            expanded={expandedRing === "sleep"}
          />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <ScoreRing
              value={0}
              maxValue={100}
              color={chartThemeColors.gridLine}
              onClick={() => toggle("sleep")}
              expanded={expandedRing === "sleep"}
              label="Sleep"
            >
              <span className="text-2xl font-bold text-subtle">--</span>
              <span className="text-[10px] font-semibold uppercase tracking-widest text-subtle">
                Sleep
              </span>
            </ScoreRing>
            <span className="text-xs text-dim">No data</span>
          </div>
        )}
      </div>

      {/* Expandable breakdown panels — kept mounted for open/close animation */}
      <ExpandableBreakdown expanded={expandedRing === "recovery"}>
        {latestReadiness && readinessIsFresh ? (
          <RecoveryBreakdown readiness={latestReadiness} />
        ) : (
          <EmptyBreakdown message="Recovery score needs HRV, resting heart rate, and sleep data from a connected wearable." />
        )}
      </ExpandableBreakdown>

      <ExpandableBreakdown expanded={expandedRing === "strain"}>
        {workloadRatio && workloadRatio.timeSeries.length > 0 ? (
          <StrainBreakdown workloadRatio={workloadRatio} strainTarget={strainTarget} />
        ) : (
          <EmptyBreakdown message="Strain is calculated from workout duration and heart rate. Log an activity with a heart rate monitor to see your strain." />
        )}
      </ExpandableBreakdown>

      <ExpandableBreakdown expanded={expandedRing === "sleep"}>
        {freshSleepPerformance ? (
          <SleepBreakdown performance={freshSleepPerformance} />
        ) : (
          <EmptyBreakdown message="Sleep score combines how long you slept vs. how much you need (70%) and sleep efficiency (30%). Connect a sleep tracker to see your breakdown." />
        )}
      </ExpandableBreakdown>
    </div>
  );
}
