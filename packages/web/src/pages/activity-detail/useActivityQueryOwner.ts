import { hashKey } from "@tanstack/react-query";
import { useState } from "react";
import type { ActivityMetric } from "../../../../server/src/contracts/activity-metric-sources.ts";

type Family = "stream" | "heartRateContext" | "hrZones" | "powerZones" | "powerWork";

export type SourceBindings = Readonly<
  Partial<
    Record<
      ActivityMetric,
      Readonly<{
        sourceId: string;
        label: string | null;
      }>
    >
  >
>;

export interface DisplayedSources {
  readonly sources: SourceBindings;
  readonly previousInput: boolean;
}

interface Snapshot<T> {
  readonly scopeKey: string;
  readonly inputKey: string;
  readonly data: T;
  readonly sources: SourceBindings;
}

export function useActivityQueryOwner<T>(
  scopeKey: string | null,
  family: Family,
  input: object,
  query: { readonly data: T | undefined; readonly isPlaceholderData: boolean },
  sources: SourceBindings,
): DisplayedSources | null {
  const inputKey = hashKey([family, input]);
  const [snapshot, setSnapshot] = useState<Snapshot<T> | null>(null);
  const data = query.data;
  let next = snapshot?.scopeKey === scopeKey ? snapshot : null;

  if (
    scopeKey !== null &&
    data !== undefined &&
    !query.isPlaceholderData &&
    (!next || next.inputKey !== inputKey || next.data !== data)
  ) {
    next = { scopeKey, inputKey, data, sources: { ...sources } };
  }
  if (next !== snapshot) setSnapshot(next);

  if (scopeKey === null || data === undefined) return null;
  const owner = next?.data === data ? next : null;
  return {
    sources: owner?.sources ?? {},
    previousInput: query.isPlaceholderData && (!owner || owner.inputKey !== inputKey),
  };
}
