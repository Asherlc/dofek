export interface RampRateWeekRow {
  week: string;
  ctlStart: number;
  ctlEnd: number;
  rampRate: number;
}

/** A single week in the ramp rate timeline. */
export class RampRateWeekModel {
  readonly #row: RampRateWeekRow;

  constructor(row: RampRateWeekRow) {
    this.#row = row;
  }

  get week(): string {
    return this.#row.week;
  }

  get ctlStart(): number {
    return this.#row.ctlStart;
  }

  get ctlEnd(): number {
    return this.#row.ctlEnd;
  }

  get rampRate(): number {
    return this.#row.rampRate;
  }

  toDetail() {
    return {
      week: this.#row.week,
      ctlStart: this.#row.ctlStart,
      ctlEnd: this.#row.ctlEnd,
      rampRate: this.#row.rampRate,
    };
  }
}

export interface RampRateResultData {
  weeks: RampRateWeekModel[];
  currentRampRate: number;
  recommendation: string;
}

export interface TrainingMonotonyWeekRow {
  week: string;
  monotony: number;
  strain: number;
  weeklyLoad: number;
  dailyMeanLoad: number;
  dailyLoadStandardDeviation: number;
}

function createTrainingMonotonyMethod() {
  return {
    formula:
      "Monotony = 7-day mean daily cycling load ÷ population standard deviation of daily cycling load. Strain = weekly cycling load × monotony.",
    calendar: "Monday–Sunday calendar weeks include zero-load days.",
    activityScope: "Cycling activities with computed endurance training load.",
    interpretation:
      "These are descriptive workload-variability summaries, not an overtraining diagnosis.",
    source: {
      title: "Foster (1998), Monitoring training in athletes",
      url: "https://pubmed.ncbi.nlm.nih.gov/9662690/",
    },
  };
}

/** Weekly training monotony and strain. */
export class TrainingMonotonyWeekModel {
  readonly #row: TrainingMonotonyWeekRow;

  constructor(row: TrainingMonotonyWeekRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      week: this.#row.week,
      monotony: this.#row.monotony,
      strain: this.#row.strain,
      weeklyLoad: this.#row.weeklyLoad,
      dailyMeanLoad: this.#row.dailyMeanLoad,
      dailyLoadStandardDeviation: this.#row.dailyLoadStandardDeviation,
      method: createTrainingMonotonyMethod(),
    };
  }
}

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
  readonly #ftp: number;

  constructor(row: ActivityVariabilityRowData, ftp: number) {
    this.#row = row;
    this.#ftp = ftp;
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
    return Math.round((this.#row.normalizedPower / this.#ftp) * 1000) / 1000;
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
  date: string;
  activityName: string;
  activityType: string;
  modality: string | null;
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

  get modality(): string | null {
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
