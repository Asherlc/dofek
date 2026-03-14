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
import { ChartLoadingSkeleton } from "../components/LoadingSkeleton.tsx";
import { MuscleGroupVolumeChart } from "../components/MuscleGroupVolumeChart.tsx";
import { PmcChart } from "../components/PmcChart.tsx";
import { PolarizationTrendChart } from "../components/PolarizationTrendChart.tsx";
import { PowerCurveChart } from "../components/PowerCurveChart.tsx";
import { ProgressiveOverloadCards } from "../components/ProgressiveOverloadCards.tsx";
import { RampRateChart } from "../components/RampRateChart.tsx";
import { ReadinessScoreCard } from "../components/ReadinessScoreCard.tsx";
import { SleepAnalyticsChart } from "../components/SleepAnalyticsChart.tsx";
import { SleepConsistencyChart } from "../components/SleepConsistencyChart.tsx";
import { StrengthVolumeChart } from "../components/StrengthVolumeChart.tsx";
import { TimeRangeSelector } from "../components/TimeRangeSelector.tsx";
import { TrainingCalendar } from "../components/TrainingCalendar.tsx";
import { TrainingInsightsPanel } from "../components/TrainingInsightsPanel.tsx";
import { TrainingMonotonyChart } from "../components/TrainingMonotonyChart.tsx";
import { VerticalAscentChart } from "../components/VerticalAscentChart.tsx";
import { WalkingBiomechanicsChart } from "../components/WalkingBiomechanicsChart.tsx";
import { WorkloadRatioChart } from "../components/WorkloadRatioChart.tsx";
import { useInView } from "../hooks/useInView.ts";
import { trpc } from "../lib/trpc.ts";

export function TrainingPage() {
  const [days, setDays] = useState(180);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 overflow-x-hidden">
      <AppHeader>
        <TimeRangeSelector days={days} onChange={setDays} />
      </AppHeader>
      <main className="mx-auto max-w-7xl px-3 sm:px-6 py-4 sm:py-6 space-y-6 sm:space-y-8">
        {/* Above the fold — loads immediately */}
        <RecoverySection days={days} />
        {/* Below the fold — loads on scroll */}
        <PerformanceSection days={days} />
        <PowerSection days={days} />
        <CyclingAdvancedSection days={days} />
        <VolumeAndEfficiencySection days={days} />
        <StrengthSection days={days} />
        <HikingSection days={days} />
        <CalendarSection days={days} />
      </main>
    </div>
  );
}

/** Recovery & Readiness — above the fold, always loads immediately. */
function RecoverySection({ days }: { days: number }) {
  const readiness = trpc.recovery.readinessScore.useQuery({ days });
  const workloadRatio = trpc.recovery.workloadRatio.useQuery({ days });
  const hrvVariability = trpc.recovery.hrvVariability.useQuery({ days });
  const sleepData = trpc.recovery.sleepAnalytics.useQuery({ days });
  const sleepConsistency = trpc.recovery.sleepConsistency.useQuery({ days });

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Readiness Score"
          subtitle="Composite score from HRV, resting HR, sleep, load balance"
        >
          <ReadinessScoreCard data={readiness.data ?? []} loading={readiness.isLoading} />
        </Section>

        <Section
          title="Acute:Chronic Workload Ratio"
          subtitle="7-day vs 28-day training load ratio — stay between 0.8 and 1.3"
        >
          <WorkloadRatioChart data={workloadRatio.data ?? []} loading={workloadRatio.isLoading} />
        </Section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="HRV Coefficient of Variation" subtitle="7-day rolling HRV variability">
          <HrvVariabilityChart
            data={hrvVariability.data ?? []}
            loading={hrvVariability.isLoading}
          />
        </Section>

        <Section
          title="Sleep Analytics"
          subtitle="Nightly sleep stages, efficiency, and sleep debt"
        >
          <SleepAnalyticsChart
            nightly={sleepData.data?.nightly ?? []}
            sleepDebt={sleepData.data?.sleepDebt ?? 0}
            loading={sleepData.isLoading}
          />
        </Section>
      </div>

      <Section
        title="Sleep Schedule Consistency"
        subtitle="14-day rolling bedtime/wake time variability and consistency score"
      >
        <SleepConsistencyChart
          data={sleepConsistency.data ?? []}
          loading={sleepConsistency.isLoading}
        />
      </Section>
    </>
  );
}

function PerformanceSection({ days }: { days: number }) {
  const { ref, hasBeenVisible } = useInView();
  const pmcData = trpc.pmc.chart.useQuery({ days }, { enabled: hasBeenVisible });
  const rampRate = trpc.cyclingAdvanced.rampRate.useQuery({ days }, { enabled: hasBeenVisible });

  return (
    <div ref={ref}>
      <Section
        title="Fitness / Fatigue / Form"
        subtitle="Long-term fitness, short-term fatigue, and training form over time"
      >
        <PmcChart
          data={pmcData.data?.data ?? []}
          model={pmcData.data?.model ?? null}
          loading={!hasBeenVisible || pmcData.isLoading}
        />
      </Section>

      <div className="mt-6 sm:mt-8">
        <Section
          title="Ramp Rate"
          subtitle="How quickly your fitness load is building week over week"
        >
          <RampRateChart
            data={rampRate.data?.weeks ?? []}
            currentRampRate={rampRate.data?.currentRampRate ?? 0}
            recommendation={rampRate.data?.recommendation ?? ""}
            loading={!hasBeenVisible || rampRate.isLoading}
          />
        </Section>
      </div>
    </div>
  );
}

function PowerSection({ days }: { days: number }) {
  const { ref, hasBeenVisible } = useInView();
  const eftpTrend = trpc.power.eftpTrend.useQuery({ days }, { enabled: hasBeenVisible });
  const powerCurve = trpc.power.powerCurve.useQuery({ days }, { enabled: hasBeenVisible });

  return (
    <div ref={ref} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Section title="eFTP Trend" subtitle="Estimated FTP via Critical Power model">
        <EftpTrendChart
          data={eftpTrend.data?.trend ?? []}
          currentEftp={eftpTrend.data?.currentEftp ?? null}
          loading={!hasBeenVisible || eftpTrend.isLoading}
        />
      </Section>

      <Section title="Power Duration Curve" subtitle="Best power at each duration">
        <PowerCurveChart
          data={powerCurve.data?.points ?? []}
          model={powerCurve.data?.model ?? null}
          loading={!hasBeenVisible || powerCurve.isLoading}
        />
      </Section>
    </div>
  );
}

function CyclingAdvancedSection({ days }: { days: number }) {
  const { ref, hasBeenVisible } = useInView();
  const monotony = trpc.cyclingAdvanced.trainingMonotony.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );
  const verticalAscent = trpc.cyclingAdvanced.verticalAscentRate.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );
  const variability = trpc.cyclingAdvanced.activityVariability.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );

  return (
    <div ref={ref}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Training Monotony & Strain" subtitle="Weekly training load variability">
          <TrainingMonotonyChart
            data={monotony.data ?? []}
            loading={!hasBeenVisible || monotony.isLoading}
          />
        </Section>

        <Section title="Vertical Ascent Rate" subtitle="Climbing speed on grade >3% segments">
          <VerticalAscentChart
            data={verticalAscent.data ?? []}
            loading={!hasBeenVisible || verticalAscent.isLoading}
          />
        </Section>
      </div>

      <div className="mt-6 sm:mt-8">
        <Section
          title="Activity Variability Index"
          subtitle="Normalized power vs average power ratio per activity"
        >
          <ActivityVariabilityTable
            data={variability.data ?? []}
            loading={!hasBeenVisible || variability.isLoading}
          />
        </Section>
      </div>
    </div>
  );
}

function VolumeAndEfficiencySection({ days }: { days: number }) {
  const { ref, hasBeenVisible } = useInView();
  const efficiency = trpc.efficiency.aerobicEfficiency.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );
  const polarization = trpc.efficiency.polarizationTrend.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );

  return (
    <div ref={ref}>
      <Section
        title="Volume & Zones"
        subtitle="Weekly volume, HR zone distribution, intensity split"
      >
        {hasBeenVisible ? <TrainingInsightsPanel days={days} /> : <ChartLoadingSkeleton />}
      </Section>

      <div className="mt-6 sm:mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Aerobic Efficiency"
          subtitle="Power output per heartbeat at easy effort — higher means fitter"
        >
          <AerobicEfficiencyChart
            activities={efficiency.data?.activities ?? []}
            maxHr={efficiency.data?.maxHr ?? null}
            loading={!hasBeenVisible || efficiency.isLoading}
          />
        </Section>

        <Section
          title="Polarization Index"
          subtitle="Weekly training distribution — above 2.0 means mostly easy and hard, little moderate"
        >
          <PolarizationTrendChart
            weeks={polarization.data?.weeks ?? []}
            maxHr={polarization.data?.maxHr ?? null}
            loading={!hasBeenVisible || polarization.isLoading}
          />
        </Section>
      </div>
    </div>
  );
}

function StrengthSection({ days }: { days: number }) {
  const { ref, hasBeenVisible } = useInView();
  const strengthVolume = trpc.strength.volumeOverTime.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );
  const estimatedMax = trpc.strength.estimatedOneRepMax.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );
  const muscleVolume = trpc.strength.muscleGroupVolume.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );
  const overload = trpc.strength.progressiveOverload.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );

  return (
    <div ref={ref}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Strength Volume" subtitle="Weekly volume load over time">
          <StrengthVolumeChart
            data={strengthVolume.data ?? []}
            loading={!hasBeenVisible || strengthVolume.isLoading}
          />
        </Section>

        <Section
          title="Estimated 1-Rep Max"
          subtitle="Estimated max single-rep strength per exercise over time"
        >
          <EstimatedMaxChart
            exercises={estimatedMax.data ?? []}
            loading={!hasBeenVisible || estimatedMax.isLoading}
          />
        </Section>
      </div>

      <div className="mt-6 sm:mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Muscle Group Volume" subtitle="Volume distribution by muscle group">
          <MuscleGroupVolumeChart
            data={muscleVolume.data ?? []}
            loading={!hasBeenVisible || muscleVolume.isLoading}
          />
        </Section>

        <Section title="Progressive Overload" subtitle="Exercise-level overload trends">
          <ProgressiveOverloadCards
            exercises={overload.data ?? []}
            loading={!hasBeenVisible || overload.isLoading}
          />
        </Section>
      </div>
    </div>
  );
}

function HikingSection({ days }: { days: number }) {
  const { ref, hasBeenVisible } = useInView();
  const gradeAdjustedPace = trpc.hiking.gradeAdjustedPace.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );
  const elevation = trpc.hiking.elevationProfile.useQuery(
    { days: Math.max(days, 365) },
    { enabled: hasBeenVisible },
  );
  const biomechanics = trpc.hiking.walkingBiomechanics.useQuery(
    { days },
    { enabled: hasBeenVisible },
  );
  const routeComparison = trpc.hiking.activityComparison.useQuery(
    { days: Math.max(days, 365) },
    { enabled: hasBeenVisible },
  );

  return (
    <div ref={ref}>
      <Section
        title="Grade-Adjusted Pace"
        subtitle="Minetti-model normalized pace for walks and hikes"
      >
        <GradeAdjustedPaceTable
          data={gradeAdjustedPace.data ?? []}
          loading={!hasBeenVisible || gradeAdjustedPace.isLoading}
        />
      </Section>

      <div className="mt-6 sm:mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Elevation Gain"
          subtitle="Weekly cumulative elevation from hiking and walking"
        >
          <ElevationGainChart
            data={elevation.data ?? []}
            loading={!hasBeenVisible || elevation.isLoading}
          />
        </Section>

        <Section title="Walking Biomechanics" subtitle="Step length, gait symmetry, double support">
          <WalkingBiomechanicsChart
            data={biomechanics.data ?? []}
            loading={!hasBeenVisible || biomechanics.isLoading}
          />
        </Section>
      </div>

      <div className="mt-6 sm:mt-8">
        <Section title="Route Comparison" subtitle="Repeated routes compared over time">
          <ActivityComparisonChart
            data={routeComparison.data ?? []}
            loading={!hasBeenVisible || routeComparison.isLoading}
          />
        </Section>
      </div>
    </div>
  );
}

function CalendarSection({ days }: { days: number }) {
  const { ref, hasBeenVisible } = useInView();
  const calendarData = trpc.calendar.calendarData.useQuery({ days }, { enabled: hasBeenVisible });

  return (
    <div ref={ref}>
      <Section title="Training Calendar" subtitle="Daily training activity heatmap">
        {!hasBeenVisible || calendarData.isLoading ? (
          <ChartLoadingSkeleton height={180} />
        ) : (
          <TrainingCalendar data={calendarData.data ?? []} />
        )}
      </Section>
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
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 sm:p-4">{children}</div>
    </section>
  );
}
