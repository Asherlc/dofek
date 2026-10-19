import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissingRouteMethodError } from "../db/source-attempt-facts.ts";
import { createMockDatabase } from "./test-helpers.ts";
import { writeClimbingRecords } from "./thecrag-persistence.ts";

const mocks = vi.hoisted(() => ({ persist: vi.fn(), captureException: vi.fn() }));
vi.mock("../db/climbing-log-sync.ts", () => ({ persistClimbingLogEntries: mocks.persist }));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: mocks.captureException }));

afterEach(() => vi.resetAllMocks());

const record = {
  externalId: "thecrag:42",
  attempts: [{ scope: "climb" as const, ropeMethod: "lead" as const }],
};

describe("theCrag log persistence", () => {
  it("retains the count and source scope returned by the canonical writer", async () => {
    const { db } = createMockDatabase();
    mocks.persist.mockResolvedValueOnce({ recordsSynced: 1, logEntryIds: ["log-42"] });
    await expect(writeClimbingRecords(db, "user-42", "thecrag", [record])).resolves.toBe(1);
    expect(mocks.persist).toHaveBeenCalledWith(db, {
      userId: "user-42",
      providerId: "thecrag",
      entries: [record],
    });
  });

  it("preserves actionable missing-method errors for provider imports", async () => {
    const failure = new MissingRouteMethodError("thecrag:42");
    mocks.persist.mockRejectedValueOnce(failure);
    await expect(
      writeClimbingRecords(createMockDatabase().db, "user-42", "thecrag", [record]),
    ).rejects.toBe(failure);
    expect(mocks.captureException).toHaveBeenCalledWith(failure, {
      tags: { provider: "thecrag", phase: "logbook_save" },
    });
  });

  it("reports save failures without exposing private bound ascent data", async () => {
    const privateNotes = "secret-notes-do-not-report";
    mocks.persist.mockRejectedValueOnce(
      new DrizzleQueryError(
        "INSERT INTO fitness.climbing_log_entry SELECT private parameters",
        [JSON.stringify([{ raw: { ascent: { markdown: privateNotes } } }])],
        Object.assign(new Error("Check constraint failed"), { code: "23514" }),
      ),
    );
    const errors: unknown[] = [];
    await expect(
      writeClimbingRecords(createMockDatabase().db, "user-42", "thecrag", [record]).catch(
        (error: unknown) => {
          errors.push(error);
          throw error;
        },
      ),
    ).rejects.toThrow(/could not save.*try again/i);
    const exposed = inspect(
      { errors, telemetry: mocks.captureException.mock.calls },
      { depth: null },
    );
    expect(exposed).not.toContain(privateNotes);
    expect(exposed).not.toContain("private parameters");
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/could not save.*try again/i) }),
      expect.objectContaining({ tags: expect.objectContaining({ postgresCode: "23514" }) }),
    );
    for (const [error] of mocks.captureException.mock.calls) {
      expect(error).toBeInstanceOf(Error);
      expect(error.cause).toBeUndefined();
    }
  });

  it.each(["23514 private-note", "private-note23514"])(
    "omits invalid PostgreSQL code %j from telemetry while reporting the save failure",
    async (code) => {
      mocks.persist.mockRejectedValueOnce(
        new DrizzleQueryError(
          "INSERT private bound query",
          ["private ascent notes"],
          Object.assign(new Error("private driver details"), { code }),
        ),
      );
      await expect(
        writeClimbingRecords(createMockDatabase().db, "user-42", "thecrag", [record]),
      ).rejects.toThrow(/could not save.*try again/i);
      expect(mocks.captureException).toHaveBeenCalled();
      const exposed = inspect(mocks.captureException.mock.calls, { depth: null });
      for (const privateDetail of [
        code,
        "private driver details",
        "private ascent notes",
        "private bound query",
      ])
        expect(exposed).not.toContain(privateDetail);
      for (const [error, metadata] of mocks.captureException.mock.calls) {
        expect(error.cause).toBeUndefined();
        expect(metadata.tags.postgresCode).toBeUndefined();
      }
    },
  );
});
