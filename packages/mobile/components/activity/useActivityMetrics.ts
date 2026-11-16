import { activityQueryPlaceholder } from "@dofek/training/activity-query-placeholder";
import { hashKey } from "@tanstack/react-query";
import type { AppRouterInputs } from "dofek-server/router";
import { useState } from "react";
import type {
  ActivityMetric,
  ActivityMetricSourceSelection,
} from "../../../server/src/contracts/activity-metric-sources.ts";
import { useAuth } from "../../lib/auth-context";
import { trpc } from "../../lib/trpc";
import { type SourceBindings, useActivityQueryOwner } from "./useActivityQueryOwner";

type ActivityInputs = AppRouterInputs["activity"];
type StreamInput = ActivityInputs["stream"];
type ContextInput = ActivityInputs["heartRateContext"];
type HrZonesInput = ActivityInputs["hrZones"];
type PowerZonesInput = ActivityInputs["powerZones"];
type PowerWorkInput = ActivityInputs["powerWork"];

function sourceBindings(
  selection: ActivityMetricSourceSelection,
  metrics:
    | readonly {
        key: ActivityMetric;
        sources: readonly { id: string; label: string }[];
      }[]
    | undefined,
): SourceBindings {
  const result: Partial<Record<ActivityMetric, { sourceId: string; label: string | null }>> = {};
  for (const metric of metrics ?? []) {
    const sourceId = selection[metric.key];
    if (!sourceId) continue;
    result[metric.key] = {
      sourceId,
      label: metric.sources.find((source) => source.id === sourceId)?.label ?? null,
    };
  }
  return result;
}

export function useActivityMetrics(
  id: string | undefined,
  { isCycling, isClimbing }: { isCycling: boolean; isClimbing: boolean },
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
  const sources: ActivityMetricSourceSelection = {};
  for (const metric of metricSources.data ?? []) {
    const selected = selection?.scopeKey === scopeKey ? selection.sources[metric.key] : undefined;
    sources[metric.key] = metric.sources.some((source) => source.id === selected)
      ? selected
      : metric.defaultSourceId;
  }
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
    enabled: !!id,
    placeholderData: activityQueryPlaceholder(id),
  });
  const hrInput: HrZonesInput = { id: activityId, ...heartRateSourceInput };
  const hrZones = trpc.activity.hrZones.useQuery(hrInput, {
    enabled: !!id,
    placeholderData: activityQueryPlaceholder(id),
  });
  const points = stream.data ?? [];
  const hasPower = points.some((point) => point.power != null);
  const powerWorkInput: PowerWorkInput = { id: activityId, powerSourceId: sources.power };
  const powerZonesInput: PowerZonesInput = { id: activityId, powerSourceId: sources.power };
  const contextInput: ContextInput = { id: activityId, maxPoints: 200, ...heartRateSourceInput };
  const powerWork = trpc.activity.powerWork.useQuery(powerWorkInput, {
    enabled: !!id && isCycling,
    placeholderData: activityQueryPlaceholder(id),
  });
  const powerZones = trpc.activity.powerZones.useQuery(powerZonesInput, {
    enabled: !!id && isCycling && hasPower,
    placeholderData: activityQueryPlaceholder(id),
  });
  const heartRateContext = trpc.activity.heartRateContext.useQuery(contextInput, {
    enabled: !!id && isClimbing,
    placeholderData: activityQueryPlaceholder(id),
  });
  const streamSources = sourceBindings(streamInput.sources ?? {}, metricSources.data);
  const hrSources = sourceBindings(
    heartRateSourceInput.heartRateSourceId
      ? { heartRate: heartRateSourceInput.heartRateSourceId }
      : {},
    metricSources.data,
  );
  const powerSources = sourceBindings(
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
  const sourceHint = (
    owner: typeof streamOwner,
    metric: ActivityMetric,
    requestedId: string | undefined,
  ) => {
    if (!owner?.previousInput || owner.sources[metric]?.sourceId === requestedId) return undefined;
    const label = owner.sources[metric]?.label;
    return label
      ? `Showing previous readings from ${label}`
      : "Showing previous readings; source unavailable";
  };
  const streamAttributionHints: Partial<Record<ActivityMetric, string>> = {};
  for (const metric of metricSources.data ?? []) {
    const hint = sourceHint(streamOwner, metric.key, sources[metric.key]);
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
    owners: {
      stream: streamOwner,
      heartRateContext: contextOwner,
      hrZones: hrZonesOwner,
      powerZones: powerZonesOwner,
      powerWork: powerWorkOwner,
    },
    attributionHints: {
      stream: streamAttributionHints,
      heartRateContext: sourceHint(contextOwner, "heartRate", sources.heartRate),
      hrZones: sourceHint(hrZonesOwner, "heartRate", sources.heartRate),
      powerZones: sourceHint(powerZonesOwner, "power", sources.power),
      powerWork: sourceHint(powerWorkOwner, "power", sources.power),
    },
  };
}
