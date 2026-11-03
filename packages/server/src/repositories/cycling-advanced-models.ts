import type { ActivityModality } from "@dofek/training/activity-types";

export interface ActivityVariabilityRowData {
  activityId: string;
  date: string;
  activityName: string;
  normalizedPower: number;
  averagePower: number;
}

/** A single activity with variability and intensity factor metrics. */
export class ActivityVariabilityModel {
  readonly #row: ActivityVariabilityRowData;
  readonly #intensityFactor: number;

  constructor(row: ActivityVariabilityRowData, intensityFactor: number) {
    this.#row = row;
    this.#intensityFactor = intensityFactor;
  }

  get date(): string {
    return this.#row.date;
  }

  get activityId(): string {
    return this.#row.activityId;
  }

  get activityName(): string {
    return this.#row.activityName;
  }

  get normalizedPower(): number {
    return this.#row.normalizedPower;
  }

  get averagePower(): number {
    return this.#row.averagePower;
  }

  get variabilityIndex(): number {
    return Math.round((this.#row.normalizedPower / this.#row.averagePower) * 1000) / 1000;
  }

  get intensityFactor(): number {
    return Math.round(this.#intensityFactor * 1000) / 1000;
  }

  toDetail() {
    return {
      activityId: this.activityId,
      date: this.date,
      activityName: this.activityName,
      normalizedPower: this.normalizedPower,
      averagePower: this.averagePower,
      variabilityIndex: this.variabilityIndex,
      intensityFactor: this.intensityFactor,
    };
  }
}

export interface VerticalAscentRowData {
  activityId: string;
  date: string;
  activityName: string;
  activityType: string;
  modality: ActivityModality | null;
  elevationGainMeters: number;
  elapsedSeconds: number;
}

/** An activity with whole-activity vertical ascent rate (VAM). */
export class VerticalAscentModel {
  readonly #row: VerticalAscentRowData;

  constructor(row: VerticalAscentRowData) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get activityName(): string {
    return this.#row.activityName;
  }

  get activityType(): string {
    return this.#row.activityType;
  }

  get modality(): ActivityModality | null {
    return this.#row.modality;
  }

  get elevationGainMeters(): number {
    return this.#row.elevationGainMeters;
  }

  get elapsedMinutes(): number {
    return Math.round((this.#row.elapsedSeconds / 60) * 10) / 10;
  }

  get verticalAscentRate(): number {
    return this.#row.elapsedSeconds > 0
      ? Math.round((this.#row.elevationGainMeters / (this.#row.elapsedSeconds / 3600)) * 10) / 10
      : 0;
  }

  toDetail() {
    return {
      date: this.date,
      activityName: this.activityName,
      activityType: this.activityType,
      modality: this.modality,
      activityId: this.#row.activityId,
      verticalAscentRate: this.verticalAscentRate,
      elevationGainMeters: this.elevationGainMeters,
      elapsedMinutes: this.elapsedMinutes,
    };
  }
}

export interface PedalDynamicsRowData {
  date: string;
  activityName: string;
  leftRightBalance: number;
  avgTorqueEffectiveness: number;
  avgPedalSmoothness: number;
}

/** An activity with pedal dynamics metrics. */
export class PedalDynamicsModel {
  readonly #row: PedalDynamicsRowData;

  constructor(row: PedalDynamicsRowData) {
    this.#row = row;
  }

  toDetail() {
    return {
      date: this.#row.date,
      activityName: this.#row.activityName,
      leftRightBalance: this.#row.leftRightBalance,
      avgTorqueEffectiveness: this.#row.avgTorqueEffectiveness,
      avgPedalSmoothness: this.#row.avgPedalSmoothness,
    };
  }
}
