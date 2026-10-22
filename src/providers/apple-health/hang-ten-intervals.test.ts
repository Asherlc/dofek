import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import { makeTransactionalTestDatabase } from "../test-helpers.ts";
import {
  buildHangTenIntervals,
  hangTenIntervalLabel,
  replaceHangTenIntervals,
} from "./hang-ten-intervals.ts";
import { hangTenActivitySegments, hangTenContactMetadata, hangTenWorkout } from "./test-helpers.ts";
import { applyWorkoutMetadata } from "./workouts.ts";

describe("hangTenIntervalLabel", () => {
  it("labels the recorded contact requirement with its exact depth", () => {
    const workout = applyWorkoutMetadata(hangTenWorkout(), hangTenContactMetadata());

    expect(buildHangTenIntervals("act-1", workout)[0]?.label).toBe("Step 1: 25 mm edge");
  });

  it.each([
    { depth: undefined, label: "Step 1: edge" },
    { depth: { range: { minimum: 20, maximum: 25 } }, label: "Step 1: edge" },
  ])("keeps a contact label without inventing an exact depth: $label", ({ depth, label }) => {
    expect(
      hangTenIntervalLabel({
        stepID: "contact-step",
        stepNumber: 1,
        kind: "work",
        target: {
          kind: "resolvedContacts",
          resolution: {
            boardID: "board",
            revisionID: "revision",
            contactIDs: ["edge-left", "edge-right"],
            requirement: { kind: "edge", depth },
          },
        },
      }),
    ).toBe(label);
  });

  it("labels self-selected hangs without a contact type", () => {
    expect(
      hangTenIntervalLabel({
        stepID: "free-hang",
        stepNumber: 1,
        kind: "work",
        target: { kind: "selfSelected" },
      }),
    ).toBe("Step 1: Work");
  });

  it("uses a generic label when the recorded contact requirement omits its kind", () => {
    expect(
      hangTenIntervalLabel({
        stepID: "contact-hang",
        stepNumber: 1,
        kind: "work",
        target: {
          kind: "resolvedContacts",
          resolution: {
            boardID: "board",
            revisionID: "revision",
            contactIDs: ["edge-left"],
            requirement: { contactID: "edge-left", selection: "single" },
          },
        },
      }),
    ).toBe("Step 1: Work");
  });

  it("labels work intervals with hold size and type", () => {
    expect(
      hangTenIntervalLabel({
        stepID: "step-1",
        stepNumber: 1,
        kind: "work",
        holdIDs: ["edge-19"],
        holdType: "edge",
        sizeMillimeters: 19,
      }),
    ).toBe("Step 1: 19 mm edge");
  });

  it("labels rest intervals by step", () => {
    expect(
      hangTenIntervalLabel({
        stepID: "step-1-rest",
        stepNumber: 1,
        kind: "rest",
        holdIDs: [],
      }),
    ).toBe("Step 1: Rest");
  });
});
describe("buildHangTenIntervals", () => {
  it("maps work and rest segments to their execution semantics", () => {
    const intervals = buildHangTenIntervals("act-1", hangTenWorkout());

    expect(
      intervals.map(({ segmentType, workRecoveryKind }) => ({
        segmentType,
        workRecoveryKind,
      })),
    ).toEqual([
      { segmentType: "work", workRecoveryKind: "work" },
      { segmentType: "rest", workRecoveryKind: "recovery" },
    ]);
  });

  it("keeps later intervals at the last known time after a missing duration", () => {
    const start = new Date("2026-08-07T14:00:00Z");
    const workout = hangTenWorkout({
      startDate: start,
      endDate: new Date("2026-08-07T14:01:00Z"),
      hangTen: {
        planName: "Repeaters",
        activitySegments: [
          ...hangTenActivitySegments(),
          {
            stepID: "step-2",
            stepNumber: 2,
            kind: "work",
            holdIDs: ["jug"],
          },
          {
            stepID: "step-2-rest",
            stepNumber: 2,
            kind: "rest",
            holdIDs: [],
            durationSeconds: 5,
          },
        ],
      },
    });

    expect(buildHangTenIntervals("act-1", workout)).toEqual([
      expect.objectContaining({
        activityId: "act-1",
        intervalIndex: 0,
        label: "Step 1: 19 mm edge",
        intervalType: "work",
        startedAt: start,
        endedAt: new Date("2026-08-07T14:00:07Z"),
      }),
      expect.objectContaining({
        activityId: "act-1",
        intervalIndex: 1,
        label: "Step 1: Rest",
        intervalType: "rest",
        startedAt: new Date("2026-08-07T14:00:07Z"),
        endedAt: new Date("2026-08-07T14:00:10Z"),
      }),
      expect.objectContaining({
        activityId: "act-1",
        intervalIndex: 2,
        label: "Step 2: Work",
        intervalType: "work",
        startedAt: new Date("2026-08-07T14:00:10Z"),
        endedAt: undefined,
      }),
      expect.objectContaining({
        activityId: "act-1",
        intervalIndex: 3,
        label: "Step 2: Rest",
        intervalType: "rest",
        startedAt: new Date("2026-08-07T14:00:10Z"),
        endedAt: undefined,
      }),
    ]);
  });
});

describe("replaceHangTenIntervals", () => {
  it("persists interval end times and execution semantics", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const db: SyncDatabase = makeTransactionalTestDatabase({
      delete: vi.fn(),
      execute,
      insert: vi.fn(),
      select: vi.fn(),
    });

    await replaceHangTenIntervals(db, "act-1", hangTenWorkout());

    const query = execute.mock.calls[0]?.[0];
    if (query === undefined || typeof query === "string") {
      throw new Error("Expected a Drizzle SQL query");
    }
    const { params } = new PgDialect().sqlToQuery(query.getSQL());
    expect([params[6], params[10], params[11], params[18], params[22], params[23]]).toEqual([
      new Date("2026-08-07T14:00:07Z"),
      "work",
      "work",
      new Date("2026-08-07T14:00:10Z"),
      "rest",
      "recovery",
    ]);
  });
});
