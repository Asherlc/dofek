import { z } from "zod";
import { timestampStringSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";

export const activitySourceSchema = z.object({
  providerId: z.string(),
  externalId: z.string(),
  memberActivityId: z.string().optional(),
  providerAbsentAt: timestampStringSchema.nullable().optional(),
  subsource: z.string().nullable().optional(),
});

export type ActivitySource = z.infer<typeof activitySourceSchema>;

export function parseClickHouseActivitySourceMaps(
  maps: Array<Record<string, string | null>>,
): ActivitySource[] {
  return maps.flatMap((map) => {
    const providerId = map.providerId;
    const externalId = map.externalId;
    if (!providerId || !externalId) return [];
    const result = activitySourceSchema.safeParse({
      providerId,
      externalId,
      memberActivityId: map.memberActivityId ?? undefined,
      providerAbsentAt: map.providerAbsentAt ?? null,
      subsource: map.subsource || null,
    });
    if (!result.success) {
      logger.warn(
        `Invalid activity source map entry dropped: ${JSON.stringify(result.error.format())}`,
        { map },
      );
      return [];
    }
    return [result.data];
  });
}
