import { vi } from "vitest";
import { z } from "zod";

export const activityMetricWindow = {
  providerType: null,
  activityId: "22222222-2222-2222-2222-222222222222",
  userId: "11111111-1111-1111-1111-111111111111",
  startedAt: "2026-10-20T12:00:00.000Z",
  endedAt: "2026-10-20T13:00:00.000Z",
  memberActivityIds: ["22222222-2222-2222-2222-222222222222"],
};

export function storeWithRows(rows: unknown[]) {
  return {
    query: vi.fn(
      async <TSchema extends z.ZodType>(
        schema: TSchema,
        _query: string,
        _params?: Record<string, unknown>,
      ): Promise<z.infer<TSchema>[]> =>
        rows.map((row) =>
          schema.parse({
            activity_ids: activityMetricWindow.memberActivityIds,
            sample_count: 1,
            ...z.record(z.string(), z.unknown()).parse(row),
          }),
        ),
    ),
  };
}
