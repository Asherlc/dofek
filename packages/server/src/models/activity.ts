export interface SourceLink {
  providerId: string;
  label: string;
  url: string;
}

export interface ActivityDetail {
  id: string;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  name: string | null;
  notes: string | null;
  providerId: string;
  subsource: string | null;
  sourceProviders: string[];
  sourceLinks: SourceLink[];
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgSpeed: number | null;
  maxSpeed: number | null;
  avgCadence: number | null;
  totalDistance: number | null;
  elevationGain: number | null;
  elevationLoss: number | null;
  sampleCount: number | null;
}

export interface ActivityRow {
  id: string;
  activity_type: string;
  started_at: string;
  ended_at: string | null;
  name: string | null;
  notes: string | null;
  provider_id: string;
  subsource: string | null;
  source_providers: string[] | null;
  source_external_ids: Array<{ providerId: string; externalId: string }> | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power: number | null;
  max_power: number | null;
  avg_speed: number | null;
  max_speed: number | null;
  avg_cadence: number | null;
  total_distance: number | null;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  sample_count: number | null;
}

export type ProviderLookup = (
  id: string,
) => { activityUrl?(externalId: string): string; name: string } | undefined;

/** Domain model for a single activity with provider-aware source links. */
export class Activity {
  readonly #row: ActivityRow;
  readonly #lookupProvider: ProviderLookup;

  constructor(row: ActivityRow, lookupProvider: ProviderLookup) {
    this.#row = row;
    this.#lookupProvider = lookupProvider;
  }

  get id(): string {
    return String(this.#row.id);
  }

  get activityType(): string {
    return String(this.#row.activity_type);
  }

  get startedAt(): string {
    return String(this.#row.started_at);
  }

  get endedAt(): string | null {
    return this.#row.ended_at ? String(this.#row.ended_at) : null;
  }

  get name(): string | null {
    return this.#row.name ? String(this.#row.name) : null;
  }

  get notes(): string | null {
    return this.#row.notes ? String(this.#row.notes) : null;
  }

  get providerId(): string {
    return String(this.#row.provider_id);
  }

  get subsource(): string | null {
    return this.#row.subsource ? String(this.#row.subsource) : null;
  }

  get sourceProviders(): string[] {
    return this.#row.source_providers ?? [];
  }

  get sourceLinks(): SourceLink[] {
    if (!this.#row.source_external_ids) return [];
    const links: SourceLink[] = [];
    for (const { providerId, externalId } of this.#row.source_external_ids) {
      const provider = this.#lookupProvider(providerId);
      if (provider?.activityUrl) {
        links.push({
          providerId,
          label: provider.name,
          url: provider.activityUrl(externalId),
        });
      }
    }
    return links;
  }

  get avgHr(): number | null {
    return this.#row.avg_hr != null ? Number(this.#row.avg_hr) : null;
  }

  get maxHr(): number | null {
    return this.#row.max_hr != null ? Number(this.#row.max_hr) : null;
  }

  get avgPower(): number | null {
    return this.#row.avg_power != null ? Number(this.#row.avg_power) : null;
  }

  get maxPower(): number | null {
    return this.#row.max_power != null ? Number(this.#row.max_power) : null;
  }

  get avgSpeed(): number | null {
    return this.#row.avg_speed != null ? Number(this.#row.avg_speed) : null;
  }

  get maxSpeed(): number | null {
    return this.#row.max_speed != null ? Number(this.#row.max_speed) : null;
  }

  get avgCadence(): number | null {
    return this.#row.avg_cadence != null ? Number(this.#row.avg_cadence) : null;
  }

  get totalDistance(): number | null {
    return this.#row.total_distance != null ? Number(this.#row.total_distance) : null;
  }

  get elevationGain(): number | null {
    return this.#row.elevation_gain_m != null ? Number(this.#row.elevation_gain_m) : null;
  }

  get elevationLoss(): number | null {
    return this.#row.elevation_loss_m != null ? Number(this.#row.elevation_loss_m) : null;
  }

  get sampleCount(): number | null {
    return this.#row.sample_count != null ? Number(this.#row.sample_count) : null;
  }

  /** Serialize to the ActivityDetail shape consumed by API clients. */
  toDetail(): ActivityDetail {
    return {
      id: this.id,
      activityType: this.activityType,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      name: this.name,
      notes: this.notes,
      providerId: this.providerId,
      subsource: this.subsource,
      sourceProviders: this.sourceProviders,
      sourceLinks: this.sourceLinks,
      avgHr: this.avgHr,
      maxHr: this.maxHr,
      avgPower: this.avgPower,
      maxPower: this.maxPower,
      avgSpeed: this.avgSpeed,
      maxSpeed: this.maxSpeed,
      avgCadence: this.avgCadence,
      totalDistance: this.totalDistance,
      elevationGain: this.elevationGain,
      elevationLoss: this.elevationLoss,
      sampleCount: this.sampleCount,
    };
  }
}
