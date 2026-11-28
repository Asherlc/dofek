import { activityQueryPlaceholder } from "@dofek/training/activity-query-placeholder";
import { hashKey } from "@tanstack/react-query";
import type { AppRouterInputs } from "dofek-server/router";
import { useState } from "react";
import type {
  ActivityMetric,
  ActivityMetricSourceSelection,
} from "../../../server/src/contracts/activity-metric-sources.ts";
import {
  activityMetricSourceBindings,
  formatActivityMetricSourceHint,
  offeredActivityMetricSources,
} from "../../../server/src/contracts/activity-metric-sources.ts";
import { useAuth } from "../../lib/auth-context";
import { trpc } from "../../lib/trpc";
import { useActivityQueryOwner } from "./useActivityQueryOwner";

type ActivityInputs = AppRouterInputs["activity"];
type StreamInput = ActivityInputs["stream"];
type ContextInput = ActivityInputs["heartRateContext"];
type HrZonesInput = ActivityInputs["hrZones"];
type PowerZonesInput = ActivityInputs["powerZones"];
type PowerWorkInput = ActivityInputs["powerWork"];

export function useActivityMetrics(
  id: string | undefined,
  {
    isCycling,
    isClimbing,
    hasRecordedPower,
  }: { isCycling: boolean; isClimbing: boolean; hasRecordedPower: boolean },
) {
  const { user, accountSessionOwnerNonce } = useAuth();
  const scopeKey = user && id ? hashKey([user.id, accountSessionOwnerNonce, id]) : null;
  const activityId = id ?? "";
  const metricSources = trpc.activity.metricSources.useQuery(
    { id: activityId, responseVersion: 2 },
    { enabled: !!id },
  );
  const [selection, setSelection] = useState<{
    scopeKey: string | null;
    sources: ActivityMetricSourceSelection;
  } | null>(null);
  // Wait for the server's default source IDs before requesting source-dependent data.
  // Without this, an implicit stream request is replaced by one keyed to explicit
  // defaults, staging the controls separately from the readings they describe.
  // TanStack keeps cached catalogue data on background errors, so a settled error
  // with cached data still resolves the choices.
  const sourcesResolved = metricSources.data != null || metricSources.error != null;
  const sources = offeredActivityMetricSources(
    selection?.scopeKey === scopeKey ? selection.sources : undefined,
    metricSources.data,
  );
  const sourceControls = (metricSources.data ?? []).map((metric) => ({
    ...metric,
    selectedId: sources[metric.key] ?? metric.defaultSourceId,
    onChange: (sourceId: string) =>
      setSelection((previous) => ({
        scopeKey,
        sources: {
          ...(previous?.scopeKey === scopeKey ? previous.sources : {}),
          [metric.key]: sourceId,
        },
      })),
  }));
  const heartRateSourceInput = sources.heartRate ? { heartRateSourceId: sources.heartRate } : {};
  const streamInput: StreamInput = { id: activityId, maxPoints: 200, sources };
  const stream = trpc.activity.stream.useQuery(streamInput, {
    enabled: sourcesResolved && !!id,
    placeholderData: activityQueryPlaceholder(id),
  });
  const hrInput: HrZonesInput = { id: activityId, ...heartRateSourceInput };
  const hrZones = trpc.activity.hrZones.useQuery(hrInput, {
    enabled: sourcesResolved && !!id,
    placeholderData: activityQueryPlaceholder(id),
  });
  const points = stream.data ?? [];
  const hasPower = points.some((point) => point.power != null);
  const powerWorkInput: PowerWorkInput = { id: activityId, powerSourceId: sources.power };
  const powerZonesInput: PowerZonesInput = { id: activityId, powerSourceId: sources.power };
  const contextInput: ContextInput = { id: activityId, maxPoints: 200, ...heartRateSourceInput };
  const powerWork = trpc.activity.powerWork.useQuery(powerWorkInput, {
    enabled: sourcesResolved && !!id && isCycling,
    placeholderData: activityQueryPlaceholder(id),
  });
  const powerZones = trpc.activity.powerZones.useQuery(powerZonesInput, {
    enabled: sourcesResolved && !!id && isCycling && (hasRecordedPower || hasPower),
    placeholderData: activityQueryPlaceholder(id),
  });
  const heartRateContext = trpc.activity.heartRateContext.useQuery(contextInput, {
    enabled: sourcesResolved && !!id && isClimbing,
    placeholderData: activityQueryPlaceholder(id),
  });
  const streamSources = activityMetricSourceBindings(streamInput.sources ?? {}, metricSources.data);
  const hrSources = activityMetricSourceBindings(
    heartRateSourceInput.heartRateSourceId
      ? { heartRate: heartRateSourceInput.heartRateSourceId }
      : {},
    metricSources.data,
  );
  const powerSources = activityMetricSourceBindings(
    sources.power ? { power: sources.power } : {},
    metricSources.data,
  );
  const streamOwner = useActivityQueryOwner(scopeKey, "stream", streamInput, stream, streamSources);
  const hrZonesOwner = useActivityQueryOwner(scopeKey, "hrZones", hrInput, hrZones, hrSources);
  const powerZonesOwner = useActivityQueryOwner(
    scopeKey,
    "powerZones",
    powerZonesInput,
    powerZones,
    powerSources,
  );
  const powerWorkOwner = useActivityQueryOwner(
    scopeKey,
    "powerWork",
    powerWorkInput,
    powerWork,
    powerSources,
  );
  const contextOwner = useActivityQueryOwner(
    scopeKey,
    "heartRateContext",
    contextInput,
    heartRateContext,
    hrSources,
  );
  const streamAttributionHints: Partial<Record<ActivityMetric, string>> = {};
  for (const metric of metricSources.data ?? []) {
    const hint = formatActivityMetricSourceHint(
      streamOwner?.previousInput ?? false,
      streamOwner?.sources,
      metric.key,
      sources[metric.key],
    );
    if (hint) streamAttributionHints[metric.key] = hint;
  }

  const streamMissing = stream.data === undefined && !stream.isError && stream.error == null;
  const contextMissing =
    !!id &&
    isClimbing &&
    heartRateContext.data === undefined &&
    !heartRateContext.isError &&
    heartRateContext.error == null;
  const initialChartPending = !sourcesResolved || streamMissing || contextMissing;

  return {
    metricSources,
    initialChartPending,
    sources,
    sourceControls,
    stream,
    hrZones,
    powerWork,
    powerZones,
    heartRateContext,
    points,
    hasPower,
    attributionHints: {
      stream: streamAttributionHints,
      heartRateContext: formatActivityMetricSourceHint(
        contextOwner?.previousInput ?? false,
        contextOwner?.sources,
        "heartRate",
        sources.heartRate,
      ),
      hrZones: formatActivityMetricSourceHint(
        hrZonesOwner?.previousInput ?? false,
        hrZonesOwner?.sources,
        "heartRate",
        sources.heartRate,
      ),
      powerZones: formatActivityMetricSourceHint(
        powerZonesOwner?.previousInput ?? false,
        powerZonesOwner?.sources,
        "power",
        sources.power,
        "power zone readings",
      ),
      powerWork: formatActivityMetricSourceHint(
        powerWorkOwner?.previousInput ?? false,
        powerWorkOwner?.sources,
        "power",
        sources.power,
      ),
    },
  };
}
