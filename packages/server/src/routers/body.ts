import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const bodyMeasurementRowSchema = z.object({
  id: z.string(),
  recorded_at: z.string(),
  provider_id: z.string(),
  user_id: z.string(),
  external_id: z.string().nullable(),
  weight_kg: z.coerce.number().nullable(),
  body_fat_pct: z.coerce.number().nullable(),
  muscle_mass_kg: z.coerce.number().nullable(),
  bone_mass_kg: z.coerce.number().nullable(),
  water_pct: z.coerce.number().nullable(),
  bmi: z.coerce.number().nullable(),
  height_cm: z.coerce.number().nullable(),
  waist_circumference_cm: z.coerce.number().nullable(),
  systolic_bp: z.coerce.number().nullable(),
  diastolic_bp: z.coerce.number().nullable(),
  heart_pulse: z.coerce.number().nullable(),
  temperature_c: z.coerce.number().nullable(),
  source_name: z.string().nullable(),
  created_at: z.string(),
});

export const bodyRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(90),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        bodyMeasurementRowSchema,
        sql`SELECT * FROM fitness.v_body_measurement
            WHERE user_id = ${ctx.userId}
              AND recorded_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY recorded_at DESC`,
      );
      return rows;
    }),
});
