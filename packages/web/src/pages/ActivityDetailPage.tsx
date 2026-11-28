import { formatRunningFormMeasurements } from "@dofek/format/running-form";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { processingPollInterval } from "@dofek/providers/processing-status";
import { ACTIVITY_IMAGES_QUERY_OPTIONS } from "@dofek/training/activity-images";
import {
  formatActivityTypeLabel,
  isActivityDetailType,
  isCyclingActivity,
} from "@dofek/training/training";
import { Link, useParams } from "@tanstack/react-router";
import { type ComponentProps, useCallback, useRef, useState } from "react";
import { ActivityExportDropdown } from "../components/ActivityExportDropdown.tsx";
import { ActivityMetricSourcePicker } from "../components/ActivityMetricSourcePicker.tsx";
import { ActivityPerceivedExertion } from "../components/ActivityPerceivedExertion.tsx";
import { ActivityRouteMap } from "../components/ActivityRouteMap.tsx";
import { CyclingProgressionEvidence } from "../components/CyclingProgressionEvidence.tsx";
import { CyclingThresholdDetails } from "../components/CyclingThresholdDetails.tsx";
import { GhostSessions } from "../components/GhostSessions.tsx";
import { HangboardingDetail } from "../components/HangboardingDetail.tsx";
import { HrZonesChart, PowerZonesChart } from "../components/HeartRateZonesChart.tsx";
import { ChartLoadingSkeleton } from "../components/LoadingSkeleton.tsx";
import { MapProcessingIndicator } from "../components/MapProcessingIndicator.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { TrainingProgressionStatusCard } from "../components/TrainingProgressionStatusCard.tsx";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ActivityClimbingPanel } from "./activity-detail/components/ActivityClimbingPanel.tsx";
import { MetricsChart } from "./activity-detail/components/ActivityDetailCharts.tsx";
import { ActivityHeader } from "./activity-detail/components/ActivityDetailHeader.tsx";
import { DeleteActivityButton } from "./activity-detail/components/DeleteActivityButton.tsx";
import { ElevationChart } from "./activity-detail/components/ElevationChart.tsx";
import { PlannedIntervalComparison } from "./activity-detail/components/PlannedIntervalComparison.tsx";
import { RecomputeActivityButton } from "./activity-detail/components/RecomputeActivityButton.tsx";
import { StrengthExerciseBreakdown } from "./activity-detail/components/StrengthExerciseBreakdown.tsx";
import { UnattachedClimbingLogEntries } from "./activity-detail/components/UnattachedClimbingLogEntries.tsx";
import { useActivityClimbing } from "./activity-detail/useActivityClimbing.ts";
import { useActivityMetrics } from "./activity-detail/useActivityMetrics.ts";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner.tsx";
import { RecordDetailModal } from "./RecordDetailModal.tsx";

const EMPTY_ROUTE_POINTS: ComponentProps<typeof ActivityRouteMap>["points"] = [];

export function ActivityDetailPage() {
  const { id } = useParams({ from: "/activity/$id" });

  const units = useUnitConverter();
  const detail = trpc.activity.byId.useQuery({ id });
  const hardware = trpc.activity.hardware.useQuery({ id });
  const images = trpc.activity.images.useQuery({ id }, ACTIVITY_IMAGES_QUERY_OPTIONS);
  const isCycling = detail.data != null && isCyclingActivity(detail.data.activityType);
  const isClimbingActivity =
    detail.data != null && isActivityDetailType(detail.data.activityType, "climbing");
  const hasRecordedPower =
    detail.data != null && (detail.data.avgPower != null || detail.data.maxPower != null);
  const metrics = useActivityMetrics(id, {
    isCycling,
    isClimbing: isClimbingActivity,
    hasRecordedPower,
  });
  const {
    metricSources,
    sources,
    sourceControls,
    stream,
    hrZones,
    points,
    hasPower,
    powerWork,
    powerZones,
    heartRateContext,
    initialChartPending,
  } = metrics;
  const metricsUpdating =
    stream.isFetching ||
    heartRateContext.isFetching ||
    hrZones.isFetching ||
    powerZones.isFetching ||
    powerWork.isFetching;
  const plannedIntervals = trpc.intervals.plannedByActivity.useQuery(
    { activityId: id },
    { enabled: isCycling },
  );
  const cyclingProgression = trpc.trainingProgression.cycling.useQuery(
    { activityId: id },
    { enabled: isCycling && !!id },
  );
  const route = trpc.activity.route.useQuery(
    { id, maxPoints: 500 },
    {
      refetchInterval: (query) =>
        query.state.data?.status === "processing" ? processingPollInterval("active") : false,
    },
  );
  const powerZonesData = powerZones.data;
  const powerZonesError = powerZones.error;
  const powerZonesLoading = powerZones.isLoading;
  const powerZonesFetching = powerZones.isFetching;
  const isStrengthActivity =
    detail.data != null && isActivityDetailType(detail.data.activityType, "strength");
  const strengthExercises = trpc.activity.strengthExercises.useQuery(
    { id },
    { enabled: isStrengthActivity },
  );
  const climbing = useActivityClimbing(id, isClimbingActivity);
  const climbingEntries = climbing.entries;
  const entrySuggestions = climbing.suggestions;
  const climbingEntriesLoading = climbing.loading;
  const selectedClimbingEntryId = climbing.selectedEntryId;
  const setSelectedClimbingEntryId = climbing.setSelectedEntryId;
  const [highlightedClimbId, setHighlightedClimbId] = useState<string | null>(null);
  const [activeClimbId, setActiveClimbId] = useState<string | null>(null);
  const selectedClimbingEntry = climbing.selectedEntry;
  const climbingLocations = climbing.locations;
  const climbMarkers = climbing.markers;
  const entryAttachState = climbing.attachmentStates;
  const handleAttachEntry = climbing.attachEntry;
  const isHangboardingActivity =
    detail.data != null && isActivityDetailType(detail.data.activityType, "hangboard");
  const hangboardDetails = trpc.activity.hangboardDetails.useQuery(
    { id },
    { enabled: isHangboardingActivity },
  );

  // Ref-based hover callback avoids re-rendering the entire page on every mouse move.
  // RouteMap registers its marker-update function here; charts call it directly.
  const mapHoverRef = useRef<(position: { lat: number; lng: number } | null) => void>(() => {});
  const handleChartHover = useCallback((position: { lat: number; lng: number } | null) => {
    mapHoverRef.current(position);
  }, []);

  if (detail.isLoading) {
    return (
      <PageLayout>
        <ChartLoadingSkeleton height={400} />
      </PageLayout>
    );
  }

  if (detail.error && !detail.data && detail.error.data?.code === "NOT_FOUND") {
    return (
      <PageLayout>
        <div className="py-8 text-center">
          <p className="text-muted mb-4">Activity not found</p>
          <Link to="/dashboard" className="text-accent hover:text-accent-secondary text-sm">
            Back to dashboard
          </Link>
        </div>
      </PageLayout>
    );
  }

  if (!detail.data) {
    return (
      <PageLayout>
        <QueryStatePanel
          error={
            detail.error ??
            new Error("Activity details are unavailable. Return to Activities and try again.")
          }
          height={400}
        />
      </PageLayout>
    );
  }

  const activity = detail.data;
  const runningFormReadings = activity.runningForm
    ? formatRunningFormMeasurements(activity.runningForm)
    : [];
  const zones = hrZones.data ?? [];
  const exercises = strengthExercises.data ?? [];
  const routePoints = route.data?.status === "ready" ? route.data.points : EMPTY_ROUTE_POINTS;
  const hasGps = routePoints.length > 0;
  const routeProcessing = route.isLoading || route.data?.status === "processing";
  const hasHr =
    points.some((p) => p.heartRate != null) ||
    (isClimbingActivity && (heartRateContext.data?.points.length ?? 0) > 0);
  const hasSpeed = points.some((p) => p.speed != null);
  const hasCadence = points.some((p) => p.cadence != null);
  const hasAltitude = points.some((p) => p.altitude != null);
  const hasPerformanceChart =
    hasHr ||
    hasPower ||
    hasSpeed ||
    hasCadence ||
    sourceControls.some((metric) => metric.key !== "altitude");
  const showPerformance =
    hasPerformanceChart || runningFormReadings.length > 0 || initialChartPending;
  const showHrZones = hrZones.error != null || hasHr || zones.length > 0;
  const hrZonesHaveCachedData = zones.length > 0;
  const strengthExercisesHaveCachedData = exercises.length > 0;

  return (
    <PageLayout>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-subtle">
          <Link to="/dashboard" className="hover:text-foreground">
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground">
            {activity.name ??
              formatActivityTypeLabel(activity.primaryActivityType ?? activity.activityType)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <RecomputeActivityButton key={id} activityId={id} />
          <ActivityExportDropdown activityId={id} hasGps={hasGps} />
          <DeleteActivityButton activityId={id} />
        </div>
      </div>

      <ProviderAbsentBanner key={`restore-${activity.id}`} activity={activity} />

      <ActivityHeader
        key={id}
        activity={activity}
        photos={{
          images: images.data?.images ?? [],
          loading: images.isLoading,
          error: images.error,
          retrying: images.isFetching,
          onRetry: () => void images.refetch(),
        }}
        powerWork={isCycling ? powerWork.data : undefined}
        powerWorkSourceHint={metrics.attributionHints.powerWork}
        trainingStressScore={isCycling ? powerZones.data?.trainingStressScore : undefined}
        units={units}
        hardware={hardware.data}
        hardwareLoading={hardware.isLoading}
        hardwareError={hardware.error}
        onRetryHardware={() => void hardware.refetch()}
      />
      {isCycling && powerWork.error ? (
        <QueryStatePanel error={powerWork.error} height={72} />
      ) : null}
      {isCycling && !hasPower && powerZonesError ? (
        <QueryStatePanel error={powerZonesError} height={72} />
      ) : null}
      <ActivityPerceivedExertion value={activity.perceivedExertion} />
      {isCycling && cyclingProgression.error ? (
        <QueryStatePanel error={cyclingProgression.error} height={72} />
      ) : null}
      {isCycling && cyclingProgression.isLoading && !cyclingProgression.data ? (
        <QueryStatePanel variant="loading" height={72} contextLabel="Cycling progression" />
      ) : null}
      {isCycling && cyclingProgression.data ? (
        <TrainingProgressionStatusCard
          status={cyclingProgression.data.status}
          headline="Cycling progression"
          summary="Two rides had similar interval duration and power at moderate whole-ride effort."
          details={<CyclingProgressionEvidence result={cyclingProgression.data} />}
        />
      ) : null}

      {detail.error ? <QueryStatePanel error={detail.error} height={72} /> : null}

      {!(
        isClimbingActivity &&
        ((climbingEntries.data?.length ?? 0) > 0 || (entrySuggestions.data?.length ?? 0) > 0)
      ) &&
        (route.error || routeProcessing || hasGps || climbMarkers.length > 0) && (
          <Section title={!hasGps && climbMarkers.length > 0 ? undefined : "Route Map"}>
            {route.error ? (
              <QueryStatePanel error={route.error} height={160} />
            ) : routeProcessing ? (
              hasGps || climbMarkers.length > 0 ? (
                <p role="status" className="text-sm text-muted">
                  {route.isLoading ? "Loading route map…" : "Processing route map…"}
                </p>
              ) : (
                <div className="relative isolate h-[400px] rounded-lg">
                  <MapProcessingIndicator
                    label={route.isLoading ? "Loading route map…" : "Processing route map…"}
                  />
                </div>
              )
            ) : null}
            {(hasGps || climbMarkers.length > 0) && (
              <ActivityRouteMap
                points={routePoints}
                climbMarkers={climbMarkers}
                onSelectEntry={setSelectedClimbingEntryId}
                onRegisterHoverCallback={mapHoverRef}
              />
            )}
          </Section>
        )}

      {showPerformance && (
        <Section title="Performance">
          {initialChartPending ? (
            <QueryStatePanel variant="loading" contextLabel="Performance chart" height={380} />
          ) : hasPerformanceChart ? (
            <MetricsChart
              heartRateContext={isClimbingActivity ? heartRateContext.data : undefined}
              activityWindow={activity}
              highlightedClimbId={highlightedClimbId ?? activeClimbId}
              selectedClimbId={activeClimbId}
              onSelectClimb={setActiveClimbId}
              climbAnnotations={
                isClimbingActivity
                  ? climbingEntries.data?.flatMap((entry) => entry.chartAnnotations ?? [])
                  : undefined
              }
              points={points}
              activityType={activity.activityType}
              hasHr={hasHr}
              hasPower={hasPower}
              hasSpeed={hasSpeed}
              hasCadence={hasCadence}
              loading={stream.isLoading}
              error={stream.error}
              metricSources={sourceControls.filter((metric) => metric.key !== "altitude")}
              sourceAttribution={{
                ...metrics.attributionHints.stream,
                heartRate:
                  isClimbingActivity && heartRateContext.data !== undefined
                    ? metrics.attributionHints.heartRateContext
                    : metrics.attributionHints.stream.heartRate,
              }}
              units={units}
              onHoverPosition={hasGps ? handleChartHover : undefined}
            />
          ) : null}
          {hasPerformanceChart &&
            sourceControls.length > 0 &&
            metricsUpdating &&
            !initialChartPending && (
              <p role="status" className="mt-2 text-xs text-muted">
                Updating metrics…
              </p>
            )}
          {runningFormReadings.length > 0 && (
            <div
              className={hasPerformanceChart ? "mt-4 border-t border-border/60 pt-4" : undefined}
            >
              <h3 className="mb-2 text-xs font-medium text-muted uppercase tracking-wider">
                Running Form
              </h3>
              <div className="flex flex-wrap gap-x-8 gap-y-4">
                {runningFormReadings.map(({ label, value, qualifier }) => (
                  <div key={label}>
                    <div className="text-xs text-subtle">{label}</div>
                    <div className="text-xl font-semibold tracking-tight tabular-nums">{value}</div>
                    {qualifier ? <div className="text-xs text-subtle">{qualifier}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {metricSources.error && <QueryStatePanel error={metricSources.error} height={72} />}
      {isClimbingActivity && heartRateContext.error && (
        <QueryStatePanel error={heartRateContext.error} height={72} />
      )}
      {stream.error ? (
        <Section title="Sensor Data">
          <QueryStatePanel error={stream.error} height={72} />
        </Section>
      ) : null}

      {isCycling && plannedIntervals.error && !plannedIntervals.data ? (
        <QueryStatePanel error={plannedIntervals.error} height={72} />
      ) : null}
      {isCycling ? <PlannedIntervalComparison rows={plannedIntervals.data ?? []} /> : null}

      {isStrengthActivity &&
        (strengthExercises.isLoading || strengthExercises.error || exercises.length > 0) && (
          <Section title="Exercises">
            {strengthExercises.error && !strengthExercisesHaveCachedData ? (
              <QueryStatePanel error={strengthExercises.error} height={160} />
            ) : strengthExercises.isLoading && !strengthExercisesHaveCachedData ? (
              <QueryStatePanel variant="loading" height={160} />
            ) : (
              <>
                <StrengthExerciseBreakdown exercises={exercises} units={units} />
                {strengthExercises.error ? (
                  <QueryStatePanel error={strengthExercises.error} height={72} />
                ) : null}
              </>
            )}
          </Section>
        )}

      {isClimbingActivity && (
        <Section title="Climbs">
          {((climbingEntries.data?.length ?? 0) > 0 || (entrySuggestions.data?.length ?? 0) > 0) &&
            route.error && <QueryStatePanel error={route.error} height={72} />}
          {((climbingEntries.data?.length ?? 0) > 0 || (entrySuggestions.data?.length ?? 0) > 0) &&
            routeProcessing && (
              <p role="status" className="text-sm text-muted">
                {route.isLoading ? "Loading route map…" : "Processing route map…"}
              </p>
            )}
          {climbingEntries.error && (
            <p className="text-sm text-red-400">{userFacingErrorMessage(climbingEntries.error)}</p>
          )}
          {climbingEntriesLoading && (
            <QueryStatePanel variant="loading" contextLabel="Climbs" height={72} />
          )}
          {((climbingEntries.data?.length ?? 0) > 0 ||
            (entrySuggestions.data?.length ?? 0) > 0) && (
            <ActivityClimbingPanel
              selectedEntryId={activeClimbId}
              onSelectEntry={setActiveClimbId}
              onHighlightEntry={setHighlightedClimbId}
              points={routePoints}
              onRegisterHoverCallback={mapHoverRef}
              onOpenEntry={setSelectedClimbingEntryId}
              suggestions={entrySuggestions.data}
              attachmentStates={entryAttachState}
              onAttach={handleAttachEntry}
              entries={climbingEntries.data ?? []}
              locations={climbingLocations}
            />
          )}
          {(entrySuggestions.error ||
            (!climbingEntriesLoading &&
              entrySuggestions.isLoading &&
              entrySuggestions.data === undefined) ||
            (climbingEntries.data !== undefined &&
              climbingEntries.data.length === 0 &&
              entrySuggestions.data?.length === 0)) && (
            <div
              className={
                climbingEntries.error ||
                climbingEntriesLoading ||
                (climbingEntries.data?.length ?? 0) > 0
                  ? "mt-3 border-t border-border pt-3"
                  : undefined
              }
            >
              <UnattachedClimbingLogEntries
                showEntries={false}
                suggestions={entrySuggestions.data}
                locations={climbingLocations}
                selectedEntryId={selectedClimbingEntryId}
                error={entrySuggestions.error}
                isLoading={entrySuggestions.isLoading}
                state={entryAttachState}
                onAttach={handleAttachEntry}
              />
            </div>
          )}
          {selectedClimbingEntry && (
            <RecordDetailModal
              dataType="climbingLogEntries"
              state={{ data: selectedClimbingEntry, error: null, isLoading: false }}
              onClose={() => setSelectedClimbingEntryId(null)}
            />
          )}
        </Section>
      )}

      {isHangboardingActivity && (
        <Section title={formatActivityTypeLabel(activity.activityType)}>
          <HangboardingDetail
            data={hangboardDetails.data}
            loading={hangboardDetails.isLoading}
            error={hangboardDetails.error ?? null}
          />
        </Section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {(hasAltitude || sources.altitude) && (
          <Section title="Elevation Profile">
            {sourceControls
              .filter((metric) => metric.key === "altitude")
              .map((metric) => (
                <div key={metric.key}>
                  <ActivityMetricSourcePicker
                    label="Elevation"
                    className="mb-2 rounded-lg border border-border px-3"
                    sources={metric.sources}
                    selectedId={metric.selectedId}
                    onChange={metric.onChange}
                  />
                  {hasAltitude && metrics.attributionHints.stream.altitude && (
                    <p role="status" className="mb-2 text-xs text-muted">
                      {metrics.attributionHints.stream.altitude}
                    </p>
                  )}
                </div>
              ))}
            <ElevationChart
              points={points}
              loading={stream.isLoading}
              units={units}
              onHoverPosition={hasGps ? handleChartHover : undefined}
            />
          </Section>
        )}

        {showHrZones && (
          <Section title="Heart Rate Zones">
            {zones.length > 0 && metrics.attributionHints.hrZones && (
              <p role="status" className="mb-2 text-xs text-muted">
                {metrics.attributionHints.hrZones}
              </p>
            )}
            {hrZones.error && !hrZonesHaveCachedData ? (
              <QueryStatePanel error={hrZones.error} height={250} />
            ) : (
              <>
                <HrZonesChart zones={zones} loading={hrZones.isLoading} />
                {hrZones.error ? <QueryStatePanel error={hrZones.error} height={72} /> : null}
              </>
            )}
          </Section>
        )}

        {isCycling && hasPower && (powerZonesError || powerZonesData != null) && (
          <Section title="Power Zones">
            {metrics.attributionHints.powerZones &&
              powerZonesData?.ftp != null &&
              powerZonesData.zones.length > 0 && (
                <p role="status" className="mb-2 text-xs text-muted">
                  {metrics.attributionHints.powerZones}
                </p>
              )}
            {powerZonesError && !powerZonesData ? (
              <QueryStatePanel error={powerZonesError} height={250} />
            ) : null}
            {powerZonesLoading && !powerZonesData ? (
              <p role="status" aria-busy="true">
                Loading power zones…
              </p>
            ) : null}
            {powerZonesData ? (
              <>
                {(powerZonesData.ftp != null || (!powerZonesError && !powerZonesFetching)) && (
                  <CyclingThresholdDetails evidence={powerZonesData.thresholdEvidence} />
                )}
                {powerZonesData.ftp != null && (
                  <PowerZonesChart
                    zones={powerZonesData.zones}
                    ftp={powerZonesData.ftp}
                    loading={powerZonesLoading}
                  />
                )}
                {powerZonesData.ftp == null && !powerZonesError && !powerZonesFetching ? (
                  <Link
                    to="/settings"
                    search={{
                      tab: "models-units" as const,
                      section: "cycling-ftp",
                      date: powerZonesData.activityDate,
                    }}
                    className="inline-flex rounded border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-surface-hover"
                  >
                    Set FTP
                  </Link>
                ) : null}
                {powerZonesError ? <QueryStatePanel error={powerZonesError} height={72} /> : null}
              </>
            ) : null}
          </Section>
        )}
      </div>
      <GhostSessions key={`ghost-${activity.id}`} activityId={activity.id} />
    </PageLayout>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section>
      {title && (
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium text-muted uppercase tracking-wider">{title}</h2>
        </div>
      )}
      <div className="card p-4">{children}</div>
    </section>
  );
}
