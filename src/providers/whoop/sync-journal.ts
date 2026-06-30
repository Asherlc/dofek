import { journalEntry, journalQuestion } from "../../db/schema/events.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { logger } from "../../logger.ts";
import { parseJournalResponse } from "./journal-parsing.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

export async function syncWhoopJournal(context: WhoopSyncContext): Promise<number> {
  const { db, client, providerId, since, options } = context;

  try {
    return await withSyncLog(
      db,
      providerId,
      "journal",
      async () => {
        const raw = await client.getJournal(since.toISOString(), new Date().toISOString());
        logger.info(`[whoop] Journal response shape: ${JSON.stringify(raw).slice(0, 500)}`);

        const entries = parseJournalResponse(raw);
        const userId = options?.userId ?? getTokenUserId();
        if (!userId) {
          throw new Error("WHOOP journal sync requires user context");
        }

        let count = 0;
        for (const entry of entries) {
          await db
            .insert(journalQuestion)
            .values({
              slug: entry.question,
              displayName: entry.question
                .replace(/_/g, " ")
                .replace(/\b\w/g, (letter) => letter.toUpperCase()),
              category: "custom",
              dataType: "numeric",
            })
            .onConflictDoNothing();

          await db
            .insert(journalEntry)
            .values({
              date: entry.date.toISOString().split("T")[0] ?? "",
              providerId,
              userId,
              questionSlug: entry.question,
              answerText: entry.answerText,
              answerNumeric: entry.answerNumeric,
              impactScore: entry.impactScore,
            })
            .onConflictDoUpdate({
              target: [
                journalEntry.userId,
                journalEntry.date,
                journalEntry.questionSlug,
                journalEntry.providerId,
              ],
              set: {
                answerText: entry.answerText,
                answerNumeric: entry.answerNumeric,
                impactScore: entry.impactScore,
              },
            });
          count++;
        }
        return { recordCount: count, result: count };
      },
      options?.userId,
    );
  } catch (err) {
    context.errors.push({
      message: `journal: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}
