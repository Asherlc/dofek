import type { ActivityDataState } from "@dofek/format/activity-data-state";
import type { RecordLocalTimeContext } from "@dofek/format/record-local-time";
import { activityMeasurementState } from "../services/activity-data-state.ts";
import type { ActivitySource } from "./activity-source.ts";
import {
  ActivitySourceAttribution,
  type ProviderLookup,
  type SourceExternalIdEntry,
  type SourceLink,
} from "./activity-source-attribution.ts";
import {
  type ActivitySourceDecisionDetail,
  buildActivitySourceDecision,
} from "./activity-source-decision.ts";

export type {
  ActivitySource,
  ActivitySourceDecisionDetail,
  ProviderLookup,
  SourceExternalIdEntry,
  SourceLink,
};

export interface ActivityDetail {
  id: string;
  activityType: string;
  startedAt: string;
  endedAt: string | null;
  name: string | null;
  notes: string | null;
  providerId: string;
  localTimeContext: RecordLocalTimeContext;
  subsource: string | null;
  sourceProviders: string[];
  sourceLinks: SourceLink[];
  sourceDecision: ActivitySourceDecisionDetail | null;
  avgHr: number | null;
  avgHrState: ActivityDataState;
  maxHr: number | null;
  maxHrState: ActivityDataState;
  avgPower: number | null;
  avgPowerState: ActivityDataState;
  maxPower: number | null;
  maxPowerState: ActivityDataState;
  avgSpeed: number | null;
  avgSpeedState: ActivityDataState;
  maxSpeed: number | null;
  maxSpeedState: ActivityDataState;
  avgCadence: number | null;
  avgCadenceState: ActivityDataState;
  totalDistance: number | null;
  totalDistanceState: ActivityDataState;
  elevationGain: number | null;
  elevationGainState: ActivityDataState;
  elevationLoss: number | null;
  elevationLossState: ActivityDataState;
  sampleCount: number | null;
  sampleCountState: ActivityDataState;
  providerAbsentAt: string | null;
}

export interface ActivityRow {
  id: string;
  activity_type: string;
  started_at: string;
  ended_at: string | null;
  name: string | null;
  notes: string | null;
  provider_id: string;
  timezone: string | null;
  start_utc_offset_minutes: number | null;
  end_utc_offset_minutes: number | null;
  local_time_source: RecordLocalTimeContext["source"];
  subsource: string | null;
  source_providers: string[] | null;
  source_external_ids: Array<SourceExternalIdEntry> | null;
  absent_source_external_ids?: Array<SourceExternalIdEntry> | null;
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
  provider_absent_at: string | null;
}

/** Domain model for a single activity with provider-aware source links. */
export class Activity {
  readonly #row: ActivityRow;
  readonly #lookupProvider: ProviderLookup;
  readonly #sourceAttribution: ActivitySourceAttribution;

  constructor(row: ActivityRow, lookupProvider: ProviderLookup) {
    this.#row = row;
    this.#lookupProvider = lookupProvider;
    this.#sourceAttribution = ActivitySourceAttribution.fromEntries(
      row.source_external_ids,
      row.absent_source_external_ids,
    );
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

  get localTimeContext(): RecordLocalTimeContext {
    return {
      timezone: this.#row.timezone,
      startUtcOffsetMinutes: this.#row.start_utc_offset_minutes,
      endUtcOffsetMinutes: this.#row.end_utc_offset_minutes,
      source: this.#row.local_time_source,
    };
  }

  get subsource(): string | null {
    return this.#row.subsource ? String(this.#row.subsource) : null;
  }

  get sourceProviders(): string[] {
    const providers = new Set([
      ...(this.#row.source_providers ?? []),
      ...this.#sourceAttribution.providerIds(),
    ]);
    return [...providers].sort();
  }

  get sourceLinks(): SourceLink[] {
    return this.#sourceAttribution.toSourceLinks(this.#lookupProvider);
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

  get providerAbsentAt(): string | null {
    return this.#row.provider_absent_at ? String(this.#row.provider_absent_at) : null;
  }

  /** Serialize to the ActivityDetail shape consumed by API clients. */
  toDetail(): ActivityDetail {
    const sourceLinks = this.sourceLinks;
    return {
      id: this.id,
      activityType: this.activityType,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      name: this.name,
      notes: this.notes,
      providerId: this.providerId,
      localTimeContext: this.localTimeContext,
      subsource: this.subsource,
      sourceProviders: this.sourceProviders,
      sourceLinks,
      sourceDecision: buildActivitySourceDecision(
        this.providerId,
        this.subsource,
        sourceLinks,
        this.#lookupProvider,
      ),
      avgHr: this.avgHr,
      avgHrState: activityMeasurementState("Average heart rate", this.avgHr),
      maxHr: this.maxHr,
      maxHrState: activityMeasurementState("Maximum heart rate", this.maxHr),
      avgPower: this.avgPower,
      avgPowerState: activityMeasurementState("Average power", this.avgPower),
      maxPower: this.maxPower,
      maxPowerState: activityMeasurementState("Maximum power", this.maxPower),
      avgSpeed: this.avgSpeed,
      avgSpeedState: activityMeasurementState("Average speed", this.avgSpeed),
      maxSpeed: this.maxSpeed,
      maxSpeedState: activityMeasurementState("Maximum speed", this.maxSpeed),
      avgCadence: this.avgCadence,
      avgCadenceState: activityMeasurementState("Average cadence", this.avgCadence),
      totalDistance: this.totalDistance,
      totalDistanceState: activityMeasurementState("Distance", this.totalDistance),
      elevationGain: this.elevationGain,
      elevationGainState: activityMeasurementState("Elevation gain", this.elevationGain),
      elevationLoss: this.elevationLoss,
      elevationLossState: activityMeasurementState("Elevation loss", this.elevationLoss),
      sampleCount: this.sampleCount,
      sampleCountState: activityMeasurementState("Sample count", this.sampleCount),
      providerAbsentAt: this.providerAbsentAt,
    };
  }
}
