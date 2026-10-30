import {
  type ActivityMetric,
  activityDataStateLabel,
  formatActivityMetric,
} from "@dofek/format/activity-data-state";
import { formatDateLong, formatDurationSeconds, formatNumber } from "@dofek/format/format";
import { formatRecordLocalTime } from "@dofek/format/record-local-time";
import type { UnitConverter } from "@dofek/format/units";
import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import { processingPollInterval } from "@dofek/providers/processing-status";
import { ACTIVITY_IMAGES_QUERY_OPTIONS } from "@dofek/training/activity-images";
import { buildClimbingMapLocations, buildClimbingMapMarkers } from "@dofek/training/climbing-map";
import { isIndoorCyclingModality } from "@dofek/training/endurance-types";
import {
  computeIntensities,
  expandMuscleGroup,
  INTENSITY_COLORS,
  intensityToBucket,
  muscleGroupFillColor,
  muscleGroupLabel,
} from "@dofek/training/muscle-groups";
import {
  cadenceUnit,
  formatActivityTypeLabel,
  isActivityDetailType,
  isCyclingActivity,
} from "@dofek/training/training";
import { Link, useParams } from "@tanstack/react-router";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityMetricSourceSelection,
  ActivityPowerWork,
  ActivityMetric as SourceMetric,
} from "../../../server/src/contracts/activity-metric-sources.ts";
import { decodeClimbingLogEntriesResponse } from "../../../server/src/contracts/climbing-log-contracts.ts";
import type { ActivityDetail } from "../../../server/src/models/activity.ts";
import type { StrengthExerciseDetail } from "../../../server/src/routers/activity.ts";
import { ActivityExportDropdown } from "../components/ActivityExportDropdown.tsx";
import { ActivityMetricSourcePicker } from "../components/ActivityMetricSourcePicker.tsx";
import { ActivityPerceivedExertion } from "../components/ActivityPerceivedExertion.tsx";
import { ActivityPhotos } from "../components/ActivityPhotos.tsx";
import { ActivityRouteMap } from "../components/ActivityRouteMap.tsx";
import { ActivitySourceDisclosure } from "../components/ActivitySourceDisclosure.tsx";
import { HangboardingDetail } from "../components/HangboardingDetail.tsx";
import { HrZonesChart, PowerZonesChart } from "../components/HeartRateZonesChart.tsx";
import { ChartLoadingSkeleton } from "../components/LoadingSkeleton.tsx";
import { MapProcessingIndicator } from "../components/MapProcessingIndicator.tsx";
import { PageLayout } from "../components/PageLayout.tsx";
import { QueryStatePanel } from "../components/QueryStatePanel.tsx";
import { trpc } from "../lib/trpc.ts";
import { useUnitConverter } from "../lib/unitContext.ts";
import { ActivityClimbingPanel } from "./activity-detail/components/ActivityClimbingPanel.tsx";
import {
  ElevationChart,
  MetricsChart,
} from "./activity-detail/components/ActivityDetailCharts.tsx";
import { DeleteActivityButton } from "./activity-detail/components/DeleteActivityButton.tsx";
import { RecomputeActivityButton } from "./activity-detail/components/RecomputeActivityButton.tsx";
import { UnattachedClimbingLogEntries } from "./activity-detail/components/UnattachedClimbingLogEntries.tsx";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner.tsx";
import { RecordDetailModal } from "./RecordDetailModal.tsx";

const EMPTY_ROUTE_POINTS: ComponentProps<typeof ActivityRouteMap>["points"] = [];

export function ActivityDetailPage() {
  const { id } = useParams({ from: "/activity/$id" });

  const units = useUnitConverter();
  const detail = trpc.activity.byId.useQuery({ id });
  const hardware = trpc.activity.hardware.useQuery({ id });
  const images = trpc.activity.images.useQuery({ id }, ACTIVITY_IMAGES_QUERY_OPTIONS);
  const metricSources = trpc.activity.metricSources.useQuery({ id: id ?? "" });
  const [sourceSelection, setSourceSelection] = useState<{
    activityId: string;
    sources: ActivityMetricSourceSelection;
  } | null>(null);
  const sources: ActivityMetricSourceSelection = {};
  for (const metric of metricSources.data ?? []) {
    const selected =
      sourceSelection?.activityId === id ? sourceSelection.sources[metric.key] : undefined;
    sources[metric.key] = metric.sources.some((source) => source.id === selected)
      ? selected
      : metric.defaultSourceId;
  }
  const selectSource = (metric: SourceMetric, sourceId: string) =>
    setSourceSelection((previous) => ({
      activityId: id ?? "",
      sources: { ...(previous?.activityId === id ? previous.sources : {}), [metric]: sourceId },
    }));
  const sourceControls = (metricSources.data ?? []).map((metric) => ({
    ...metric,
    selectedId: sources[metric.key] ?? metric.defaultSourceId,
    onChange: (sourceId: string) => selectSource(metric.key, sourceId),
  }));
  const heartRateSourceInput = sources.heartRate ? { heartRateSourceId: sources.heartRate } : {};
  const stream = trpc.activity.stream.useQuery(
    { id, maxPoints: 500, sources },
    { placeholderData: (previousData) => previousData },
  );
  const route = trpc.activity.route.useQuery(
    { id, maxPoints: 500 },
    {
      refetchInterval: (query) =>
        query.state.data?.status === "processing" ? processingPollInterval("active") : false,
    },
  );
  const hrZones = trpc.activity.hrZones.useQuery(
    { id, ...heartRateSourceInput },
    { placeholderData: (previousData) => previousData },
  );
  const points = stream.data ?? [];
  const hasPower = points.some((p) => p.power != null);
  const isCycling = detail.data != null && isCyclingActivity(detail.data.activityType);
  const powerWork = trpc.activity.powerWork.useQuery(
    { id, powerSourceId: sources.power },
    {
      enabled: isCycling,
      placeholderData: (previousData, previousQuery) => {
        const previousInput = previousQuery?.queryKey[1]?.input;
        return previousInput &&
          typeof previousInput === "object" &&
          "id" in previousInput &&
          previousInput.id === id
          ? previousData
          : undefined;
      },
    },
  );
  const powerZones = trpc.activity.powerZones.useQuery(
    { id, powerSourceId: sources.power },
    { enabled: isCycling && hasPower, placeholderData: (previousData) => previousData },
  );
  const isStrengthActivity =
    detail.data != null && isActivityDetailType(detail.data.activityType, "strength");
  const strengthExercises = trpc.activity.strengthExercises.useQuery(
    { id },
    { enabled: isStrengthActivity },
  );
  const isClimbingActivity =
    detail.data != null && isActivityDetailType(detail.data.activityType, "climbing");
  const climbingEntries = trpc.climbing.activityLogEntries.useQuery(
    { activityId: id, responseVersion: 3 },
    { enabled: isClimbingActivity, select: decodeClimbingLogEntriesResponse },
  );
  const entrySuggestions = trpc.climbing.unattachedClimbingLogEntries.useQuery(
    { activityId: id, responseVersion: 3 },
    { enabled: isClimbingActivity, select: decodeClimbingLogEntriesResponse },
  );
  const climbingEntriesLoading = climbingEntries.isLoading && !climbingEntries.data;
  const [selectedClimbingEntryId, setSelectedClimbingEntryId] = useState<string | null>(null);
  const selectedClimbingEntry = [
    ...(climbingEntries.data ?? []),
    ...(entrySuggestions.data ?? []),
  ].find((entry) => entry.id === selectedClimbingEntryId);
  const climbingLocations = useMemo(
    () =>
      buildClimbingMapLocations([
        ...(climbingEntries.data ?? []),
        ...(entrySuggestions.data ?? []),
      ]),
    [climbingEntries.data, entrySuggestions.data],
  );
  const climbMarkers = useMemo(
    () =>
      isClimbingActivity
        ? buildClimbingMapMarkers([
            ...(climbingEntries.data ?? []),
            ...(entrySuggestions.data ?? []),
          ])
        : [],
    [isClimbingActivity, climbingEntries.data, entrySuggestions.data],
  );
  const trpcUtils = trpc.useUtils();
  const [entryAttachState, setEntryAttachState] = useState<
    Record<string, { pending: boolean; error: string | null }>
  >({});
  const attachEntry = trpc.climbing.attachClimbingLogEntry.useMutation({
    onSuccess: async (_result, input) => {
      await Promise.all([
        trpcUtils.activity.images.invalidate({ id: input.activityId }),
        trpcUtils.climbing.activityLogEntries.invalidate({
          activityId: input.activityId,
          responseVersion: 3,
        }),
        trpcUtils.climbing.sessionSummary.invalidate(),
        trpcUtils.climbing.gradeProgressionV2.invalidate(),
        trpcUtils.climbing.volumeByGrade.invalidate(),
        trpcUtils.climbing.strengths.invalidate(),
        trpcUtils.climbing.unattachedClimbingLogEntries.invalidate({
          activityId: input.activityId,
          responseVersion: 3,
        }),
      ]);
    },
  });
  const handleAttachEntry = (entryId: string) => {
    setEntryAttachState((current) => ({ ...current, [entryId]: { pending: true, error: null } }));
    attachEntry.mutate(
      { activityId: id, climbingLogEntryId: entryId },
      {
        onSuccess: () =>
          setEntryAttachState((current) => ({
            ...current,
            [entryId]: { pending: false, error: null },
          })),
        onError: (error) =>
          setEntryAttachState((current) => ({
            ...current,
            [entryId]: { pending: false, error: userFacingErrorMessage(error) },
          })),
      },
    );
  };
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
  const zones = hrZones.data ?? [];
  const exercises = strengthExercises.data ?? [];
  const routePoints = route.data?.status === "ready" ? route.data.points : EMPTY_ROUTE_POINTS;
  const hasGps = routePoints.length > 0;
  const routeProcessing = route.isLoading || route.data?.status === "processing";
  const hasHr = points.some((p) => p.heartRate != null);
  const hasSpeed = points.some((p) => p.speed != null);
  const hasCadence = points.some((p) => p.cadence != null);
  const hasAltitude = points.some((p) => p.altitude != null);
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

      {activity.providerAbsentAt ? <ProviderAbsentBanner activity={activity} /> : null}

      <ActivityHeader
        activity={activity}
        powerWork={isCycling ? powerWork.data : undefined}
        units={units}
        hardware={hardware.data}
        hardwareLoading={hardware.isLoading}
        hardwareError={hardware.error}
        onRetryHardware={() => void hardware.refetch()}
      />
      {isCycling && powerWork.error ? (
        <QueryStatePanel error={powerWork.error} height={72} />
      ) : null}
      <ActivityPerceivedExertion value={activity.perceivedExertion} />

      <ActivityPhotos
        key={id}
        images={images.data?.images ?? []}
        loading={images.isLoading}
        error={images.error}
        retrying={images.isFetching}
        onRetry={() => {
          void images.refetch();
        }}
      />

      {detail.error ? <QueryStatePanel error={detail.error} height={72} /> : null}

      {metricSources.error && <QueryStatePanel error={metricSources.error} height={72} />}
      {stream.error ? (
        <Section title="Sensor Data">
          <QueryStatePanel error={stream.error} height={72} />
        </Section>
      ) : null}

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

      {(hasHr ||
        hasPower ||
        hasSpeed ||
        hasCadence ||
        sourceControls.some((metric) => metric.key !== "altitude")) && (
        <Section title="Performance">
          {sourceControls.length > 0 &&
            (stream.isFetching ||
              hrZones.isFetching ||
              powerZones.isFetching ||
              powerWork.isFetching) && (
              <p role="status" className="mb-2 text-xs text-muted">
                Updating metrics…
              </p>
            )}
          <MetricsChart
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
            units={units}
            onHoverPosition={hasGps ? handleChartHover : undefined}
          />
        </Section>
      )}

      {isStrengthActivity &&
        (strengthExercises.isLoading || strengthExercises.error || exercises.length > 0) && (
          <Section title="Exercises">
            {strengthExercises.error && !strengthExercisesHaveCachedData ? (
              <QueryStatePanel error={strengthExercises.error} height={160} />
            ) : strengthExercises.isLoading && !strengthExercisesHaveCachedData ? (
              <QueryStatePanel variant="loading" height={160} />
            ) : (
              <>
                <WorkoutMuscleMap exercises={exercises} />
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
                <ActivityMetricSourcePicker
                  key={metric.key}
                  label="Elevation"
                  className="mb-2 rounded-lg border border-border px-3"
                  sources={metric.sources}
                  selectedId={metric.selectedId}
                  onChange={metric.onChange}
                />
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

        {isCycling && hasPower && (powerZones.error || powerZones.data != null) && (
          <Section title="Power Zones">
            {powerZones.error && powerZones.data == null ? (
              <QueryStatePanel error={powerZones.error} height={250} />
            ) : powerZones.data ? (
              <>
                <PowerZonesChart
                  zones={powerZones.data.zones}
                  ftp={powerZones.data.ftp}
                  loading={powerZones.isLoading}
                />
                {powerZones.error ? <QueryStatePanel error={powerZones.error} height={72} /> : null}
              </>
            ) : null}
          </Section>
        )}
      </div>
    </PageLayout>
  );
}

export function ActivityHeader({
  activity,
  powerWork,
  units,
  ...sourceDetails
}: {
  activity: ActivityDetail;
  powerWork?: ActivityPowerWork;
  units: UnitConverter;
} & Omit<ComponentProps<typeof ActivitySourceDisclosure>, "tree">) {
  const durationMin =
    activity.startedAt && activity.endedAt
      ? Math.round(
          (new Date(activity.endedAt).getTime() - new Date(activity.startedAt).getTime()) / 60000,
        )
      : null;
  const localStartTime = formatRecordLocalTime(
    activity.startedAt,
    activity.localTimeContext,
    "start",
    undefined,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  const formatDuration = (mins: number) => {
    const hours = Math.floor(mins / 60);
    const remainingMinutes = mins % 60;
    return hours > 0 ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;
  };

  const stats: Array<ActivityMetric | { label: string; value: string; description?: string }> = [];

  if (durationMin != null) stats.push({ label: "Duration", value: formatDuration(durationMin) });
  if (!(isCyclingActivity(activity.activityType) && isIndoorCyclingModality(activity.modality))) {
    stats.push(
      formatActivityMetric(
        "Distance",
        activity.totalDistance,
        activity.totalDistanceState,
        (distanceMeters) =>
          `${formatNumber(units.convertDistance(distanceMeters / 1000))} ${units.distanceLabel}`,
      ),
    );
  }
  stats.push(
    formatActivityMetric(
      "Elevation Gain",
      activity.elevationGain,
      activity.elevationGainState,
      (elevationMeters) =>
        `${Math.round(units.convertElevation(elevationMeters))} ${units.elevationLabel}`,
    ),
    formatActivityMetric(
      "Avg Heart Rate",
      activity.avgHr,
      activity.avgHrState,
      (value) => `${Math.round(value)} bpm`,
    ),
    formatActivityMetric(
      "Max Heart Rate",
      activity.maxHr,
      activity.maxHrState,
      (value) => `${Math.round(value)} bpm`,
    ),
    formatActivityMetric(
      "Avg Power",
      activity.avgPower,
      activity.avgPowerState,
      (value) => `${Math.round(value)} W`,
    ),
    formatActivityMetric(
      "Max Power",
      activity.maxPower,
      activity.maxPowerState,
      (value) => `${Math.round(value)} W`,
    ),
    ...(isCyclingActivity(activity.activityType) && powerWork?.workKilojoules != null
      ? [
          {
            label: "Energy Output",
            value: `${formatNumber(powerWork.workKilojoules, 0)} kJ`,
            description: powerWork.coverage.coveragePct < 99 ? "Partial power data" : undefined,
          },
        ]
      : []),
    formatActivityMetric(
      "Avg Speed",
      activity.avgSpeed,
      activity.avgSpeedState,
      (value) => `${formatNumber(units.convertSpeed(value * 3.6))} ${units.speedLabel}`,
    ),
    formatActivityMetric(
      "Avg Cadence",
      activity.avgCadence,
      activity.avgCadenceState,
      (value) => `${Math.round(value)} ${cadenceUnit(activity.activityType)}`,
    ),
  );

  return (
    <div>
      <ActivitySourceDisclosure
        tree={activity.sourceTree}
        {...sourceDetails}
        heading={
          <div className="min-w-0 pb-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1">
              <h1 className="text-xl font-semibold text-foreground">
                {activity.name ??
                  formatActivityTypeLabel(activity.primaryActivityType ?? activity.activityType)}
              </h1>
              <span className="text-xs text-subtle">
                {formatActivityTypeLabel(activity.activityType)}
              </span>
            </div>
            <p className="text-sm text-subtle">
              {formatDateLong(activity.displayedDate, { timeZone: "UTC" })} at{" "}
              {localStartTime === "--" ? "Local time unavailable" : localStartTime}
            </p>
          </div>
        }
      />

      {stats.length > 0 && (
        <div className="flex flex-wrap gap-4">
          {stats
            .filter((stat) => !("status" in stat) || stat.status !== "missing")
            .map((s) => {
              const metric = "status" in s ? s : null;
              const unavailableMetric = metric?.status !== "available" ? metric : null;
              const displayedValue =
                "status" in s ? (s.status === "available" ? s.value : s.reason) : s.value;
              return (
                <section
                  key={s.label}
                  className="card px-4 py-3"
                  data-state={metric?.status}
                  aria-label={
                    unavailableMetric
                      ? `${unavailableMetric.label} ${activityDataStateLabel(unavailableMetric.status)}: ${unavailableMetric.reason}`
                      : undefined
                  }
                >
                  <div className="text-xs text-subtle mb-0.5">
                    {unavailableMetric
                      ? `${unavailableMetric.label} ${activityDataStateLabel(unavailableMetric.status)}`
                      : s.label}
                  </div>
                  <div className="text-lg font-medium tabular-nums">{displayedValue}</div>
                  {"description" in s && s.description ? (
                    <div className="text-xs text-subtle">{s.description}</div>
                  ) : null}
                </section>
              );
            })}
        </div>
      )}
    </div>
  );
}

function WorkoutMuscleMap({ exercises }: { exercises: StrengthExerciseDetail[] }) {
  // Lazy-load react-body-highlighter
  const [Model, setModel] = useState<typeof import("react-body-highlighter").default | null>(null);
  const [MuscleType, setMuscleType] = useState<
    typeof import("react-body-highlighter").MuscleType | null
  >(null);

  useEffect(() => {
    import("react-body-highlighter").then((mod) => {
      setModel(() => mod.default);
      setMuscleType(() => mod.MuscleType);
    });
  }, []);

  // Count sets per muscle group from this workout's exercises
  const slugTotals = new Map<string, number>();
  for (const exercise of exercises) {
    if (!exercise.muscleGroups) continue;
    for (const group of exercise.muscleGroups) {
      const slugs = expandMuscleGroup(group);
      const setsPerSlug = exercise.sets.length / slugs.length;
      for (const slug of slugs) {
        slugTotals.set(slug, (slugTotals.get(slug) ?? 0) + setsPerSlug);
      }
    }
  }

  const intensities = computeIntensities(slugTotals);
  if (intensities.size === 0 || !Model || !MuscleType) return null;

  type IExerciseData = import("react-body-highlighter").IExerciseData;
  type Muscle = import("react-body-highlighter").Muscle;
  const VALID_MUSCLES = new Set<string>(Object.values(MuscleType));
  const DELTOID_MUSCLES: Muscle[] = [MuscleType.FRONT_DELTOIDS, MuscleType.BACK_DELTOIDS];

  function isMuscle(value: string): value is Muscle {
    return VALID_MUSCLES.has(value);
  }

  const exerciseData: IExerciseData[] = [...intensities.entries()].flatMap(
    ([slug, intensity]): IExerciseData[] => {
      const bucket = intensityToBucket(intensity);
      if (bucket === 0) return [];
      if (slug === "deltoids") {
        return DELTOID_MUSCLES.map((muscle) => ({
          name: slug,
          muscles: [muscle],
          frequency: bucket,
        }));
      }
      if (!isMuscle(slug)) return [];
      return [{ name: slug, muscles: [slug], frequency: bucket }];
    },
  );

  // Build label list sorted by set count
  const labelList = [...slugTotals.entries()]
    .sort(([, countA], [, countB]) => countB - countA)
    .map(([slug, count]) => ({
      label: muscleGroupLabel(slug),
      sets: Math.round(count),
      intensity: intensities.get(slug) ?? 0,
    }));

  return (
    <div className="flex flex-col sm:flex-row items-center gap-4 mb-4">
      <div className="flex gap-4">
        <div className="flex flex-col items-center">
          <span className="text-xs text-dim mb-1">Front</span>
          <Model
            data={exerciseData}
            style={{ width: "120px" }}
            type="anterior"
            highlightedColors={INTENSITY_COLORS}
            bodyColor="#e8ede7"
          />
        </div>
        <div className="flex flex-col items-center">
          <span className="text-xs text-dim mb-1">Back</span>
          <Model
            data={exerciseData}
            style={{ width: "120px" }}
            type="posterior"
            highlightedColors={INTENSITY_COLORS}
            bodyColor="#e8ede7"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {labelList.map(({ label, sets, intensity }) => (
          <span
            key={label}
            className="text-xs px-2 py-1 rounded"
            style={{
              backgroundColor: muscleGroupFillColor(intensity),
              color: intensity > 0.5 ? "#fff" : "#1a1a1a",
            }}
          >
            {label} ({sets})
          </span>
        ))}
      </div>
    </div>
  );
}

function StrengthExerciseBreakdown({
  exercises,
  units,
}: {
  exercises: StrengthExerciseDetail[];
  units: UnitConverter;
}) {
  return (
    <div className="space-y-4">
      {exercises.map((exercise) => {
        const hasWeight = exercise.sets.some((set) => set.weightKg != null);
        const hasReps = exercise.sets.some((set) => set.reps != null);
        const hasDuration = exercise.sets.some((set) => set.durationSeconds != null);
        const hasRpe = exercise.sets.some((set) => set.rpe != null);

        return (
          <div key={`${exercise.activityId}:${exercise.exerciseIndex}`}>
            <div className="flex items-baseline gap-2 mb-2">
              <h3 className="text-sm font-medium text-foreground">{exercise.exerciseName}</h3>
              {exercise.equipment && (
                <span className="text-xs text-subtle bg-accent/10 px-1.5 py-0.5 rounded">
                  {exercise.equipment.toLowerCase().replace(/_/g, " ")}
                </span>
              )}
              {exercise.muscleGroups?.map((group) => (
                <span
                  key={group}
                  className="text-xs text-subtle bg-surface-hover px-1.5 py-0.5 rounded"
                >
                  {group.toLowerCase()}
                </span>
              ))}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-subtle border-b border-surface-hover">
                  <th className="text-left py-1 pr-4 font-medium">Set</th>
                  {hasWeight && (
                    <th className="text-right py-1 px-4 font-medium">
                      Weight ({units.weightLabel})
                    </th>
                  )}
                  {hasReps && <th className="text-right py-1 px-4 font-medium">Reps</th>}
                  {hasDuration && <th className="text-right py-1 px-4 font-medium">Duration</th>}
                  {hasRpe && (
                    <th className="text-right py-1 pl-4 font-medium">Perceived Exertion (RPE)</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {exercise.sets.map((set) => (
                  <tr key={set.setIndex} className="border-b border-surface-hover/50">
                    <td className="py-1.5 pr-4 tabular-nums text-muted">{set.setIndex + 1}</td>
                    {hasWeight && (
                      <td className="text-right py-1.5 px-4 tabular-nums">
                        {set.weightKg != null
                          ? formatNumber(units.convertWeight(set.weightKg))
                          : "—"}
                      </td>
                    )}
                    {hasReps && (
                      <td className="text-right py-1.5 px-4 tabular-nums">{set.reps ?? "—"}</td>
                    )}
                    {hasDuration && (
                      <td className="text-right py-1.5 px-4 tabular-nums">
                        {set.durationSeconds != null
                          ? formatDurationSeconds(set.durationSeconds)
                          : "—"}
                      </td>
                    )}
                    {hasRpe && (
                      <td className="text-right py-1.5 pl-4 tabular-nums">{set.rpe ?? "—"}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
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
