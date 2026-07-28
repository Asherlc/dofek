export type SyncWindowBounds = {
  since: Date;
  until: Date;
};

export class SyncWindow {
  readonly #since: Date;
  readonly #until: Date;

  constructor({ since, until }: SyncWindowBounds) {
    SyncWindow.#validate(since, until);
    this.#since = new Date(since.getTime());
    this.#until = new Date(until.getTime());
  }

  get since(): Date {
    return new Date(this.#since.getTime());
  }

  get until(): Date {
    return new Date(this.#until.getTime());
  }

  get sinceIso(): string {
    return this.#since.toISOString();
  }

  get untilIso(): string {
    return this.#until.toISOString();
  }

  /** Widen the start bound so reconciliation covers at least `days` lookback. */
  withMinimumLookback(days: number): SyncWindow {
    const untilYmd = this.#until.toISOString().slice(0, 10);
    const minimumStart = SyncWindow.#parseYmdUtcStart(
      SyncWindow.#dateWindowStartString(untilYmd, days),
    );
    const since = this.#since.getTime() < minimumStart.getTime() ? this.#since : minimumStart;
    return new SyncWindow({ since, until: this.#until });
  }

  static now(): Date {
    return new Date(Date.now());
  }

  static full(now = SyncWindow.now()): SyncWindow {
    return new SyncWindow({ since: new Date(0), until: now });
  }

  static lastDays(days: number, options?: { untilDate?: string; now?: Date }): SyncWindow {
    const now = options?.now ?? SyncWindow.now();
    const untilDate = options?.untilDate ?? SyncWindow.#todayYmd(now);
    const until = SyncWindow.#parseYmdUtcEnd(untilDate);
    const since = SyncWindow.#parseYmdUtcStart(SyncWindow.#dateWindowStartString(untilDate, days));
    return new SyncWindow({ since, until });
  }

  static fromDateRange({
    sinceDate,
    untilDate,
  }: {
    sinceDate: string;
    untilDate: string;
  }): SyncWindow {
    return new SyncWindow({
      since: SyncWindow.#parseYmdUtcStart(sinceDate),
      until: SyncWindow.#parseYmdUtcEnd(untilDate),
    });
  }

  static fromIsoRange({ sinceIso, untilIso }: { sinceIso: string; untilIso: string }): SyncWindow {
    const since = SyncWindow.#parseIso(sinceIso, "sinceIso");
    const until = SyncWindow.#parseIso(untilIso, "untilIso");
    return new SyncWindow({ since, until });
  }

  /** Open-ended window from a start bound; end defaults to now. */
  static fromSince({ since, until = SyncWindow.now() }: { since: Date; until?: Date }): SyncWindow {
    return new SyncWindow({ since, until });
  }

  static #todayYmd(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  static #parseYmdUtcStart(ymd: string): Date {
    return SyncWindow.#parseYmd(ymd, "T00:00:00.000Z");
  }

  static #parseYmdUtcEnd(ymd: string): Date {
    return SyncWindow.#parseYmd(ymd, "T23:59:59.999Z");
  }

  static #dateWindowStartString(endDate: string, days: number): string {
    const windowStart = SyncWindow.#parseYmdUtcStart(endDate);
    windowStart.setUTCDate(windowStart.getUTCDate() - days);
    return windowStart.toISOString().slice(0, 10);
  }

  static #parseYmd(ymd: string, timeSuffix: string): Date {
    const parsed = new Date(`${ymd}${timeSuffix}`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== ymd) {
      throw new Error(`Invalid sync window date: ${ymd}`);
    }
    return parsed;
  }

  static #parseIso(iso: string, fieldName: string): Date {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid sync window ${fieldName}: ${iso}`);
    }
    return parsed;
  }

  static #validate(since: Date, until: Date): void {
    const sinceTime = since.getTime();
    const untilTime = until.getTime();
    if (!Number.isFinite(sinceTime)) {
      throw new Error("Invalid sync window since");
    }
    if (!Number.isFinite(untilTime)) {
      throw new Error("Invalid sync window until");
    }
    if (sinceTime > untilTime) {
      throw new Error("Sync window start must be before end");
    }
  }
}
