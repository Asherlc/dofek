import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { BreathworkRepository } from "./breathwork-repository.ts";

describe("BreathworkRepository outcome reports", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`DELETE FROM fitness.breathwork_session WHERE user_id = ${TEST_USER_ID}`,
    );

    await testContext.db.execute(sql`
      INSERT INTO fitness.breathwork_session (
        user_id,
        technique_id,
        rounds,
        duration_seconds,
        started_at,
        stress_before,
        stress_after,
        dizziness_after,
        perceived_effect
      )
      VALUES
        (${TEST_USER_ID}, 'box-breathing', 4, 64, NOW() - INTERVAL '1 day', 8, 4, FALSE, 'better'),
        (${TEST_USER_ID}, 'box-breathing', 4, 64, NOW() - INTERVAL '2 days', 5, 5, TRUE, 'same'),
        (${TEST_USER_ID}, 'box-breathing', 4, 64, NOW() - INTERVAL '3 days', 2, 6, NULL, 'worse'),
        (${TEST_USER_ID}, 'box-breathing', 4, 64, NOW() - INTERVAL '4 days', NULL, NULL, FALSE, NULL),
        (${TEST_USER_ID}, 'box-breathing', 4, 64, NOW() - INTERVAL '31 days', 9, 1, TRUE, 'better'),
        (${TEST_USER_ID}, '4-7-8', 4, 76, NOW() - INTERVAL '1 day', 7, 3, FALSE, 'better')
    `);
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("stores optional reports and groups rolling 30-day descriptive counts by technique", async () => {
    const repository = new BreathworkRepository(testContext.db, TEST_USER_ID);

    const result = await repository.getOutcomeSummaries();

    expect(result).toEqual({
      windowDays: 30,
      windowKind: "rolling-instant",
      techniques: [
        {
          techniqueId: "4-7-8",
          sessionCount: 1,
          stress: { reportCount: 1, lowerCount: 1, sameCount: 0, higherCount: 0 },
          perceivedEffect: { reportCount: 1, betterCount: 1, sameCount: 0, worseCount: 0 },
          dizziness: { reportCount: 1, yesCount: 0 },
        },
        {
          techniqueId: "box-breathing",
          sessionCount: 4,
          stress: { reportCount: 3, lowerCount: 1, sameCount: 1, higherCount: 1 },
          perceivedEffect: { reportCount: 3, betterCount: 1, sameCount: 1, worseCount: 1 },
          dizziness: { reportCount: 3, yesCount: 1 },
        },
      ],
    });

    const history = await repository.getHistory(30);
    expect(history.map((session) => session.toDetail())).toContainEqual(
      expect.objectContaining({
        techniqueId: "box-breathing",
        stressBefore: 8,
        stressAfter: 4,
        dizzinessAfter: false,
        perceivedEffect: "better",
      }),
    );
  });

  it("enforces stress and perceived-effect constraints in Postgres", async () => {
    await expect(
      testContext.db.execute(sql`
        INSERT INTO fitness.breathwork_session (
          user_id,
          technique_id,
          rounds,
          duration_seconds,
          started_at,
          stress_before
        )
        VALUES (${TEST_USER_ID}, 'box-breathing', 4, 64, NOW(), 11)
      `),
    ).rejects.toThrow();

    await expect(
      testContext.db.execute(sql`
        INSERT INTO fitness.breathwork_session (
          user_id,
          technique_id,
          rounds,
          duration_seconds,
          started_at,
          perceived_effect
        )
        VALUES (${TEST_USER_ID}, 'box-breathing', 4, 64, NOW(), 'amazing')
      `),
    ).rejects.toThrow();
  });
});
