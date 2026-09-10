import { daysBefore, type SeedRandom, type Sql, USER_ID } from "./helpers.ts";

export async function seedReviewSurfaces(sql: Sql, random: SeedRandom): Promise<void> {
  const today = new Date();
  await seedJournalEntries(sql, random, today);
  await seedLifeEvents(sql, today);
  console.log("Seeded: journal entries and life events");
}

async function seedJournalEntries(sql: Sql, random: SeedRandom, today: Date): Promise<void> {
  const numericQuestions = ["hydration", "sleep_quality", "energy", "mood", "recovery"] as const;
  for (let daysAgo = 0; daysAgo < 45; daysAgo++) {
    const date = daysBefore(today, daysAgo);
    const badSleepWeek = daysAgo >= 9 && daysAgo <= 15;
    const hardBlock = daysAgo >= 24 && daysAgo <= 38;

    for (const [questionIndex, questionSlug] of numericQuestions.entries()) {
      const base = questionSlug === "hydration" ? 7 : questionSlug === "recovery" ? 6 : 5;
      const answerNumeric = Math.max(
        1,
        Math.min(10, base + random.int(-1, 2) - (badSleepWeek ? 2 : 0) + (hardBlock ? 1 : 0)),
      );
      await sql`
        INSERT INTO fitness.journal_entry (
          date, provider_id, user_id, question_slug, answer_numeric, impact_score
        ) VALUES (
          ${date}, 'manual_review', ${USER_ID}, ${questionSlug}, ${answerNumeric},
          ${questionIndex === 0 ? 0.2 : answerNumeric / 10}
        )
        ON CONFLICT (user_id, date, question_slug, provider_id) DO UPDATE
          SET answer_numeric = EXCLUDED.answer_numeric,
              impact_score = EXCLUDED.impact_score
      `;
    }

    const booleanEntries = [
      ["caffeine", daysAgo % 3 !== 0],
      ["alcohol", daysAgo % 11 === 0],
      ["meditation", daysAgo % 4 === 0],
      ["morning_stretch", daysAgo % 5 === 0],
    ] as const;

    for (const [questionSlug, enabled] of booleanEntries) {
      await sql`
        INSERT INTO fitness.journal_entry (
          date, provider_id, user_id, question_slug, answer_text, answer_numeric, impact_score
        ) VALUES (
          ${date}, 'manual_review', ${USER_ID}, ${questionSlug},
          ${enabled ? "yes" : "no"}, ${enabled ? 1 : 0}, ${enabled ? 0.4 : 0}
        )
        ON CONFLICT (user_id, date, question_slug, provider_id) DO UPDATE
          SET answer_text = EXCLUDED.answer_text,
              answer_numeric = EXCLUDED.answer_numeric,
              impact_score = EXCLUDED.impact_score
      `;
    }
  }
}

async function seedLifeEvents(sql: Sql, today: Date): Promise<void> {
  const events = [
    ["Training Camp", 42, 34, "training", "High-volume training block"],
    ["Travel Week", 18, 14, "travel", "Cross-country travel and disrupted sleep"],
    ["New Sleep Routine", 10, null, "habit", "Earlier bedtime and reduced evening screens"],
  ] as const;

  for (const [label, startDaysAgo, endDaysAgo, category, notes] of events) {
    await sql`
      INSERT INTO fitness.life_events (
        label, user_id, started_at, ended_at, category, ongoing, notes
      ) VALUES (
        ${label}, ${USER_ID}, ${daysBefore(today, startDaysAgo)},
        ${endDaysAgo == null ? null : daysBefore(today, endDaysAgo)}, ${category},
        ${endDaysAgo == null}, ${notes}
      )
    `;
  }
}
