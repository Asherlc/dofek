import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";

const cdcHealthStateSchema = z.object({
  consecutiveFailures: z.number().int().nonnegative(),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastSuccessfulAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime(),
  status: z.enum(["starting", "passing", "failing"]),
});

type CdcHealthState = z.infer<typeof cdcHealthStateSchema>;

interface CdcHealthStateFileOptions {
  filePath: string;
  intervalSeconds: number;
  now?: () => Date;
}

const allowedMissedCheckBufferSeconds = 60;
const consecutiveFailureLimit = 2;

export class CdcHealthStateFile {
  readonly #filePath: string;
  readonly #maximumStateAgeSeconds: number;
  readonly #now: () => Date;

  constructor(options: CdcHealthStateFileOptions) {
    if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds <= 0) {
      throw new Error("CDC health interval must be a positive integer");
    }

    this.#filePath = options.filePath;
    this.#maximumStateAgeSeconds = options.intervalSeconds + allowedMissedCheckBufferSeconds;
    this.#now = options.now ?? (() => new Date());
  }

  initialize(): void {
    const startedAt = this.#now().toISOString();
    this.#write({
      consecutiveFailures: 0,
      lastCheckedAt: null,
      lastSuccessfulAt: null,
      startedAt,
      status: "starting",
    });
  }

  recordFailure(): void {
    const state = this.#read();
    this.#write({
      ...state,
      consecutiveFailures: state.consecutiveFailures + 1,
      lastCheckedAt: this.#now().toISOString(),
      status: "failing",
    });
  }

  recordSuccess(): void {
    const state = this.#read();
    const checkedAt = this.#now().toISOString();
    this.#write({
      ...state,
      consecutiveFailures: 0,
      lastCheckedAt: checkedAt,
      lastSuccessfulAt: checkedAt,
      status: "passing",
    });
  }

  assertHealthy(): void {
    const state = this.#read();
    const referenceTime = state.lastCheckedAt ?? state.startedAt;
    const stateAgeSeconds = (this.#now().getTime() - new Date(referenceTime).getTime()) / 1_000;

    if (state.status === "starting") {
      if (stateAgeSeconds > this.#maximumStateAgeSeconds) {
        throw new Error(
          `CDC health monitor has not completed a check within ${this.#maximumStateAgeSeconds} seconds`,
        );
      }
      return;
    }

    if (stateAgeSeconds > this.#maximumStateAgeSeconds) {
      throw new Error(
        `CDC health monitor state is older than ${this.#maximumStateAgeSeconds} seconds`,
      );
    }

    if (state.consecutiveFailures >= consecutiveFailureLimit) {
      throw new Error(
        `CDC health monitor has ${state.consecutiveFailures} consecutive failed checks`,
      );
    }
  }

  #read(): CdcHealthState {
    return cdcHealthStateSchema.parse(JSON.parse(readFileSync(this.#filePath, "utf8")));
  }

  #write(state: CdcHealthState): void {
    const validatedState = cdcHealthStateSchema.parse(state);
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;

    try {
      writeFileSync(temporaryPath, `${JSON.stringify(validatedState)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.#filePath);
    } finally {
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    }
  }
}
