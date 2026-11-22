import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { z } from "zod";
import { ClimbingForecastRepository } from "../packages/server/src/repositories/climbing-forecast-observations.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";

const [userId, timezone, startDate, endDate] = z
  .tuple([z.uuid(), z.string().min(1), z.iso.date(), z.iso.date()])
  .parse(process.argv.slice(2));
if (startDate > endDate) throw new Error("The start date must precede or equal the end date");
const capturedOn = formatDateYmdInTimeZone(new Date(), timezone);
const database = createDatabaseFromEnv();
try {
  const observations = await database.transaction(
    (transaction) =>
      new ClimbingForecastRepository(transaction, userId, timezone).listClimbDays({
        startDate,
        endDate,
      }),
    { accessMode: "read only" },
  );
  process.stdout.write(`${JSON.stringify({ userId, timezone, capturedOn, observations })}\n`);
} finally {
  await database.$client.end();
}
