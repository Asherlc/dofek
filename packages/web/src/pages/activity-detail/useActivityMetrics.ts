import { activityQueryPlaceholder } from "@dofek/training/activity-query-placeholder";
import { hashKey } from "@tanstack/react-query";
import type { AppRouterInputs } from "dofek-server/router";
import { useState } from "react";
import type {
  ActivityMetric,
  ActivityMetricSourceSelection,
} from "../../../../server/src/contracts/activity-metric-sources.ts";
import {
  activityMetricSourceBindings,
  formatActivityMetricSourceHint,
  offeredActivityMetricSources,
} from "../../../../server/src/contracts/activity-metric-sources.ts";
import { useAuth } from "../../lib/auth-context.tsx";
import { trpc } from "../../lib/trpc.ts";
import { useActivityQueryOwner } from "./useActivityQueryOwner.ts";

type ActivityInputs = AppRouterInputs["activity"];
type StreamInput = ActivityInputs["stream"];
type ContextInput = ActivityInputs["heartRateContext"];
type HrZonesInput = ActivityInputs["hrZones"];
type PowerZonesInput = ActivityInputs["powerZones"];
type PowerWorkInput = ActivityInputs["powerWork"];

export function useActivityMetrics(
  id: string,
  {
    isCycling,
    isClimbing,
    hasRecordedPower,
  }: { isCycling: boolean; isClimbing: boolean; hasRecordedPower: boolean },
) {
  const { user, accountSessionOwnerNonce } = useAuth();
  const scopeKey = user && id ? hashKey([user.id, accountSessionOwnerNonce, id]) : null;
  const metricSources = trpc.activity.metricSources.useQuery({ id, responseVersion: 2 });
  const [selection, setSelection] = useState<{
    scopeKey: string | null;
    sources: ActivityMetricSourceSelection;
  } | null>(null);
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
  const streamInput: StreamInput = { id, maxPoints: 500, sources };
  const stream = trpc.activity.stream.useQuery(streamInput, {
    placeholderData: activityQueryPlaceholder(id),
  });
  const hrInput: HrZonesInput = { id, ...heartRateSourceInput };
  const hrZones = trpc.activity.hrZones.useQuery(hrInput, {
    placeholderData: activityQueryPlaceholder(id),
  });
  const points = stream.data ?? [];
  const hasPower = points.some((point) => point.power != null);
  const powerWorkInput: PowerWorkInput = { id, powerSourceId: sources.power };
  const powerZonesInput: PowerZonesInput = { id, powerSourceId: sources.power };
  const contextInput: ContextInput = { id, maxPoints: 500, ...heartRateSourceInput };
  const powerWork = trpc.activity.powerWork.useQuery(powerWorkInput, {
    enabled: isCycling,
    placeholderData: activityQueryPlaceholder(id),
  });
  const powerZones = trpc.activity.powerZones.useQuery(powerZonesInput, {
    enabled: isCycling && (hasRecordedPower || hasPower),
    placeholderData: activityQueryPlaceholder(id),
  });
  const heartRateContext = trpc.activity.heartRateContext.useQuery(contextInput, {
    enabled: isClimbing,
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

  return {
    metricSources,
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
