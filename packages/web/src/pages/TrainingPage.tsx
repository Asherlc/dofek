import { useState } from "react";
import { ActivityComparisonChart } from "../components/ActivityComparisonChart.tsx";
import { ActivityVariabilityTable } from "../components/ActivityVariabilityTable.tsx";
import { AerobicEfficiencyChart } from "../components/AerobicEfficiencyChart.tsx";
import { AppHeader } from "../components/AppHeader.tsx";
import { EftpTrendChart } from "../components/EftpTrendChart.tsx";
import { ElevationGainChart } from "../components/ElevationGainChart.tsx";
import { EstimatedMaxChart } from "../components/EstimatedMaxChart.tsx";
import { GradeAdjustedPaceTable } from "../components/GradeAdjustedPaceTable.tsx";
import { HrvVariabilityChart } from "../components/HrvVariabilityChart.tsx";
import { MuscleGroupVolumeChart } from "../components/MuscleGroupVolumeChart.tsx";
import { PmcChart } from "../components/PmcChart.tsx";
import { PolarizationTrendChart } from "../components/PolarizationTrendChart.tsx";
import { PowerCurveChart } from "../components/PowerCurveChart.tsx";
import { ProgressiveOverloadCards } from "../components/ProgressiveOverloadCards.tsx";
import { RampRateChart } from "../components/RampRateChart.tsx";
import { ReadinessScoreCard } from "../components/ReadinessScoreCard.tsx";
import { SleepAnalyticsChart } from "../components/SleepAnalyticsChart.tsx";
import { StrengthVolumeChart } from "../components/StrengthVolumeChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TrainingCalendar } from "../components/TrainingCalendar.tsx";
import { TrainingInsightsPanel } from "../components/TrainingInsightsPanel.tsx";
import { TrainingMonotonyChart } from "../components/TrainingMonotonyChart.tsx";
import { VerticalAscentChart } from "../components/VerticalAscentChart.tsx";
import { WalkingBiomechanicsChart } from "../components/WalkingBiomechanicsChart.tsx";
import { WorkloadRatioChart } from "../components/WorkloadRatioChart.tsx";
import { trpc } from "../lib/trpc.ts";

export function TrainingPage() {
  const [days, setDays] = useState(180);

  // Existing queries
  const pmcData = trpc.pmc.chart.useQuery({ days });
  const powerCurve = trpc.power.powerCurve.useQuery({ days });
  const eftpTrend = trpc.power.eftpTrend.useQuery({ days });
  const calendarData = trpc.calendar.calendarData.useQuery({ days });
  const efficiency = trpc.efficiency.aerobicEfficiency.useQuery({ days });
  const polarization = trpc.efficiency.polarizationTrend.useQuery({ days });

  // Cycling advanced queries
  const rampRate = trpc.cyclingAdvanced.rampRate.useQuery({ days });
  const monotony = trpc.cyclingAdvanced.trainingMonotony.useQuery({ days });
  const variability = trpc.cyclingAdvanced.activityVariability.useQuery({ days });
  const verticalAscent = trpc.cyclingAdvanced.verticalAscentRate.useQuery({ days });

  // Strength queries
  const strengthVolume = trpc.strength.volumeOverTime.useQuery({ days });
  const estimatedMax = trpc.strength.estimatedOneRepMax.useQuery({ days });
  const muscleVolume = trpc.strength.muscleGroupVolume.useQuery({ days });
  const overload = trpc.strength.progressiveOverload.useQuery({ days });

  // Hiking queries
  const gradeAdjustedPace = trpc.hiking.gradeAdjustedPace.useQuery({ days });
  const elevation = trpc.hiking.elevationProfile.useQuery({ days: Math.max(days, 365) });
  const biomechanics = trpc.hiking.walkingBiomechanics.useQuery({ days });
  const routeComparison = trpc.hiking.activityComparison.useQuery({ days: Math.max(days, 365) });

  // Recovery queries
  const hrvVariability = trpc.recovery.hrvVariability.useQuery({ days });
  const workloadRatio = trpc.recovery.workloadRatio.useQuery({ days });
  const sleepData = trpc.recovery.sleepAnalytics.useQuery({ days });
  const readiness = trpc.recovery.readinessScore.useQuery({ days });

  const effData = efficiency.data as
    | {
        maxHr: number | null;
        activities: Array<{
          date: string;
          activityType: string;
          name: string;
          avgPowerZ2: number;
          avgHrZ2: number;
          efficiencyFactor: number;
          z2Samples: number;
        }>;
      }
    | undefined;
  const polData = polarization.data as
    | {
        maxHr: number | null;
        weeks: Array<{
          week: string;
          z1Seconds: number;
          z2Seconds: number;
          z3Seconds: number;
          polarizationIndex: number | null;
        }>;
      }
    | undefined;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppHeader>
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl p-6 space-y-8">
        {/* ── Recovery & Readiness ────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section
            title="Readiness Score"
            subtitle="Composite score from HRV, resting HR, sleep, load balance"
          >
            <ReadinessScoreCard
              data={(readiness.data ?? []) as never[]}
              loading={readiness.isLoading}
            />
          </Section>

          <Section
            title="Acute:Chronic Workload Ratio"
            subtitle="TRIMP-based training load balance"
          >
            <WorkloadRatioChart
              data={(workloadRatio.data ?? []) as never[]}
              loading={workloadRatio.isLoading}
            />
          </Section>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section title="HRV Coefficient of Variation" subtitle="7-day rolling HRV variability">
            <HrvVariabilityChart
              data={(hrvVariability.data ?? []) as never[]}
              loading={hrvVariability.isLoading}
            />
          </Section>

          <Section
            title="Sleep Analytics"
            subtitle="Nightly sleep stages, efficiency, and sleep debt"
          >
            <SleepAnalyticsChart
              nightly={
                ((sleepData.data as Record<string, unknown> | undefined)?.nightly ?? []) as never[]
              }
              sleepDebt={
                ((sleepData.data as Record<string, unknown> | undefined)?.sleepDebt as number) ?? 0
              }
              loading={sleepData.isLoading}
            />
          </Section>
        </div>

        {/* ── Performance Management ─────────────────────────── */}
        <Section
          title="Fitness / Fatigue / Form"
          subtitle="Performance Management Chart (CTL/ATL/TSB)"
        >
          <PmcChart
            data={pmcData.data?.data ?? []}
            model={pmcData.data?.model ?? null}
            loading={pmcData.isLoading}
          />
        </Section>

        <Section title="Ramp Rate" subtitle="Weekly CTL ramp rate with training recommendations">
          <RampRateChart
            data={((rampRate.data as Record<string, unknown> | undefined)?.weeks ?? []) as never[]}
            currentRampRate={
              ((rampRate.data as Record<string, unknown> | undefined)?.currentRampRate as number) ??
              0
            }
            recommendation={
              ((rampRate.data as Record<string, unknown> | undefined)?.recommendation as string) ??
              ""
            }
            loading={rampRate.isLoading}
          />
        </Section>

        {/* ── eFTP + Power Curve side by side ─────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section title="eFTP Trend" subtitle="Estimated FTP via Critical Power model">
            <EftpTrendChart
              data={eftpTrend.data?.trend ?? []}
              currentEftp={eftpTrend.data?.currentEftp ?? null}
              loading={eftpTrend.isLoading}
            />
          </Section>

          <Section title="Power Duration Curve" subtitle="Best power at each duration">
            <PowerCurveChart
              data={powerCurve.data?.points ?? []}
              model={powerCurve.data?.model ?? null}
              loading={powerCurve.isLoading}
            />
          </Section>
        </div>

        {/* ── Cycling Advanced ───────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section title="Training Monotony & Strain" subtitle="Weekly training load variability">
            <TrainingMonotonyChart
              data={(monotony.data ?? []) as never[]}
              loading={monotony.isLoading}
            />
          </Section>

          <Section title="Vertical Ascent Rate" subtitle="Climbing speed on grade >3% segments">
            <VerticalAscentChart
              data={(verticalAscent.data ?? []) as never[]}
              loading={verticalAscent.isLoading}
            />
          </Section>
        </div>

        <Section
          title="Activity Variability Index"
          subtitle="Normalized power vs average power ratio per activity"
        >
          <ActivityVariabilityTable
            data={(variability.data ?? []) as never[]}
            loading={variability.isLoading}
          />
        </Section>

        {/* ── Volume + Zones + Intensity ─────────────────────── */}
        <Section
          title="Volume & Zones"
          subtitle="Weekly volume, HR zone distribution, intensity split"
        >
          <TrainingInsightsPanel days={days} />
        </Section>

        {/* ── Aerobic Efficiency + Polarization ──────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section title="Aerobic Efficiency" subtitle="Power/HR ratio in Z2 over time">
            <AerobicEfficiencyChart
              activities={effData?.activities ?? []}
              maxHr={effData?.maxHr ?? null}
              loading={efficiency.isLoading}
            />
          </Section>

          <Section
            title="Polarization Index"
            subtitle="Weekly PI trend (>2.0 = polarized training)"
          >
            <PolarizationTrendChart
              weeks={polData?.weeks ?? []}
              maxHr={polData?.maxHr ?? null}
              loading={polarization.isLoading}
            />
          </Section>
        </div>

        {/* ── Strength Training ──────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section title="Strength Volume" subtitle="Weekly volume load over time">
            <StrengthVolumeChart
              data={(strengthVolume.data ?? []) as never[]}
              loading={strengthVolume.isLoading}
            />
          </Section>

          <Section title="Estimated 1-Rep Max" subtitle="Epley-formula e1RM trends per exercise">
            <EstimatedMaxChart
              exercises={(estimatedMax.data ?? []) as never[]}
              loading={estimatedMax.isLoading}
            />
          </Section>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section title="Muscle Group Volume" subtitle="Volume distribution by muscle group">
            <MuscleGroupVolumeChart
              data={(muscleVolume.data ?? []) as never[]}
              loading={muscleVolume.isLoading}
            />
          </Section>

          <Section title="Progressive Overload" subtitle="Exercise-level overload trends">
            <ProgressiveOverloadCards
              exercises={(overload.data ?? []) as never[]}
              loading={overload.isLoading}
            />
          </Section>
        </div>

        {/* ── Hiking & Walking ───────────────────────────────── */}
        <Section
          title="Grade-Adjusted Pace"
          subtitle="Minetti-model normalized pace for walks and hikes"
        >
          <GradeAdjustedPaceTable
            data={(gradeAdjustedPace.data ?? []) as never[]}
            loading={gradeAdjustedPace.isLoading}
          />
        </Section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Section
            title="Elevation Gain"
            subtitle="Weekly cumulative elevation from hiking and walking"
          >
            <ElevationGainChart
              data={(elevation.data ?? []) as never[]}
              loading={elevation.isLoading}
            />
          </Section>

          <Section
            title="Walking Biomechanics"
            subtitle="Step length, gait symmetry, double support"
          >
            <WalkingBiomechanicsChart
              data={(biomechanics.data ?? []) as never[]}
              loading={biomechanics.isLoading}
            />
          </Section>
        </div>

        <Section title="Route Comparison" subtitle="Repeated routes compared over time">
          <ActivityComparisonChart
            data={(routeComparison.data ?? []) as never[]}
            loading={routeComparison.isLoading}
          />
        </Section>

        {/* ── Calendar Heatmap ───────────────────────────────── */}
        <Section title="Training Calendar" subtitle="Daily training activity heatmap">
          {calendarData.isLoading ? (
            <div className="flex items-center justify-center h-[180px]">
              <span className="text-zinc-600 text-sm">Loading...</span>
            </div>
          ) : (
            <TrainingCalendar
              data={
                (calendarData.data ?? []) as unknown as Array<{
                  date: string;
                  activityCount: number;
                  totalMinutes: number;
                  activityTypes: string[];
                }>
              }
            />
          )}
        </Section>
      </main>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wider mb-1">{title}</h2>
      {subtitle && <p className="text-xs text-zinc-600 mb-4">{subtitle}</p>}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">{children}</div>
    </section>
  );
}
