import { formatDateTime } from "@dofek/format/format";
import { type ProviderAbsentSource, providerSourceLabel } from "@dofek/providers/providers";

export interface SourceExternalIdEntry {
  providerId: string;
  externalId: string;
  memberActivityId?: string;
  providerAbsentAt?: string | null;
  subsource?: string | null;
}

/** Resolved provider source shown on activity detail and list cards. */
export interface SourceLink {
  providerId: string;
  label: string;
  url: string | null;
  providerAbsentAt?: string | null;
  memberActivityId?: string;
}

export type ProviderLookup = (
  id: string,
) => { activityUrl?(externalId: string): string; name: string } | undefined;

/** Merges active and tombstoned member sources for a deduped activity. */
export class ActivitySourceAttribution {
  readonly #activeEntries: SourceExternalIdEntry[];
  readonly #absentEntries: SourceExternalIdEntry[];

  constructor(activeEntries: SourceExternalIdEntry[], absentEntries: SourceExternalIdEntry[]) {
    this.#activeEntries = activeEntries;
    this.#absentEntries = absentEntries;
  }

  static fromEntries(
    activeEntries: SourceExternalIdEntry[] | null | undefined,
    absentEntries: SourceExternalIdEntry[] | null | undefined,
  ): ActivitySourceAttribution {
    return new ActivitySourceAttribution(activeEntries ?? [], absentEntries ?? []);
  }

  static fromClickHouseAbsentMaps(
    maps: Array<Record<string, string | null>>,
  ): ActivitySourceAttribution {
    return new ActivitySourceAttribution([], ActivitySourceAttribution.#parseClickHouseMaps(maps));
  }

  static fromClickHouseRow(
    activeMaps: Array<Record<string, string | null>> | null | undefined,
    absentMaps: Array<Record<string, string | null>> | null | undefined,
  ): ActivitySourceAttribution {
    return new ActivitySourceAttribution(
      ActivitySourceAttribution.#parseClickHouseMaps(activeMaps ?? []),
      ActivitySourceAttribution.#parseClickHouseMaps(absentMaps ?? []),
    );
  }

  static #parseClickHouseMaps(maps: Array<Record<string, string | null>>): SourceExternalIdEntry[] {
    return maps.flatMap((map) => {
      const providerId = map.providerId;
      const externalId = map.externalId;
      if (!providerId || !externalId) return [];
      return [
        {
          providerId,
          externalId,
          memberActivityId: map.memberActivityId ?? undefined,
          providerAbsentAt: map.providerAbsentAt ?? null,
          subsource: map.subsource ?? null,
        },
      ];
    });
  }

  get hasPartialAbsence(): boolean {
    return this.#activeEntries.length > 0 && this.#absentEntries.length > 0;
  }

  get hasFullAbsence(): boolean {
    return this.#activeEntries.length === 0 && this.#absentEntries.length > 0;
  }

  providerIds(): string[] {
    const providers = new Set([
      ...this.#activeEntries.map((entry) => entry.providerId),
      ...this.#absentEntries.map((entry) => entry.providerId),
    ]);
    return [...providers].sort();
  }

  toSourceLinks(lookup: ProviderLookup): SourceLink[] {
    const activeLinks = this.#activeEntries.map((entry) =>
      ActivitySourceAttribution.#toSourceLink(entry, lookup),
    );
    const activeProviderIds = new Set(this.#activeEntries.map((entry) => entry.providerId));
    const absentLinks = this.#absentEntries
      .filter((entry) => !activeProviderIds.has(entry.providerId))
      .map((entry) => ActivitySourceAttribution.#toSourceLink(entry, lookup));

    return [...activeLinks, ...absentLinks].sort(ActivitySourceAttribution.#compareSourceLinks);
  }

  static #toSourceLink(entry: SourceExternalIdEntry, lookup: ProviderLookup): SourceLink {
    const provider = lookup(entry.providerId);
    const label = entry.subsource
      ? providerSourceLabel(entry.providerId, entry.subsource)
      : (provider?.name ?? providerSourceLabel(entry.providerId));
    const url = provider?.activityUrl ? provider.activityUrl(entry.externalId) : null;

    return {
      providerId: entry.providerId,
      label,
      url,
      providerAbsentAt: entry.providerAbsentAt ?? null,
      ...(entry.memberActivityId ? { memberActivityId: entry.memberActivityId } : {}),
    };
  }

  static #compareSourceLinks(left: SourceLink, right: SourceLink): number {
    return (
      left.providerId.localeCompare(right.providerId) ||
      left.label.localeCompare(right.label) ||
      (left.memberActivityId ?? "").localeCompare(right.memberActivityId ?? "")
    );
  }

  partialAbsentSources(): ProviderAbsentSource[] {
    return this.#absentEntries.map((entry) => ({
      providerId: entry.providerId,
      providerAbsentAt: entry.providerAbsentAt ?? null,
    }));
  }

  partialAbsenceSummary(lookup: ProviderLookup): string | null {
    if (!this.hasPartialAbsence) return null;
    return this.#formatRemovedSources(this.#absentEntries, lookup);
  }

  tombstoneSummary(
    subsource: string | null,
    providerId: string,
    providerAbsentAt: string | null,
  ): string | null {
    if (!providerAbsentAt) return null;
    const providerLabel = providerSourceLabel(providerId, subsource);
    return `Removed from ${providerLabel} · ${formatDateTime(providerAbsentAt)}`;
  }

  static hiddenActivityTombstoneSummary(
    providerId: string,
    providerAbsentAt: string | null,
  ): string | null {
    return new ActivitySourceAttribution([], []).tombstoneSummary(
      null,
      providerId,
      providerAbsentAt,
    );
  }

  #formatRemovedSources(entries: SourceExternalIdEntry[], lookup: ProviderLookup): string | null {
    if (entries.length === 0) return null;
    return entries
      .map((entry) => {
        const providerLabel = lookup(entry.providerId)?.name ?? entry.providerId;
        const removedAt = entry.providerAbsentAt
          ? ` · ${formatDateTime(entry.providerAbsentAt)}`
          : "";
        return `${providerLabel} removed${removedAt}`;
      })
      .join(", ");
  }
}
