import { formatDateTime } from "@dofek/format/format";
import { providerSourceLabel, type ProviderAbsentSource } from "@dofek/providers/providers";

export interface SourceExternalIdEntry {
  providerId: string;
  externalId: string;
  memberActivityId?: string;
  providerAbsentAt?: string | null;
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
    const linksByProvider = new Map<string, SourceLink>();

    for (const { providerId, externalId } of this.#activeEntries) {
      const provider = lookup(providerId);
      if (!provider?.activityUrl) continue;
      linksByProvider.set(providerId, {
        providerId,
        label: provider.name,
        url: provider.activityUrl(externalId),
        providerAbsentAt: null,
      });
    }

    for (const entry of this.#absentEntries) {
      if (linksByProvider.has(entry.providerId)) continue;
      const provider = lookup(entry.providerId);
      const label = provider?.name ?? entry.providerId;
      const url =
        provider?.activityUrl && entry.externalId ? provider.activityUrl(entry.externalId) : null;
      linksByProvider.set(entry.providerId, {
        providerId: entry.providerId,
        label,
        url,
        providerAbsentAt: entry.providerAbsentAt ?? null,
        memberActivityId: entry.memberActivityId,
      });
    }

    return [...linksByProvider.values()].sort((left, right) =>
      left.providerId.localeCompare(right.providerId),
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
